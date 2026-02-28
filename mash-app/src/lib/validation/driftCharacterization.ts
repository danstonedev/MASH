/**
 * Drift Characterization Module
 * =============================
 *
 * Implements automated drift characterization protocol.
 * Quantifies yaw drift performance for 6-axis IMU systems.
 *
 * Protocol:
 * 1. Place sensor stationary
 * 2. Record for 5 minutes
 * 3. Compute drift rate with confidence interval
 * 4. Classify drift quality
 *
 * @module driftCharacterization
 */

import { getDriftMonitor } from "../../calibration/DriftMonitor";

// ============================================================================
// TYPES
// ============================================================================

export interface DriftTestConfig {
  /** Test duration in seconds (default 300 = 5 min) */
  durationSeconds: number;

  /** Sample rate in Hz (default 10) */
  sampleRateHz: number;

  /** Device ID to test */
  deviceId: string;
}

export interface DriftTestResult {
  /** Test configuration */
  config: DriftTestConfig;

  /** Test start timestamp */
  startTime: number;

  /** Test end timestamp */
  endTime: number;

  /** Yaw values over time */
  yawSamples: { time: number; yaw: number }[];

  /** Computed drift rate (deg/min) */
  driftRateDegPerMin: number;

  /** 95% confidence interval for drift rate */
  driftRateCI95: [number, number];

  /** Total yaw drift over test (degrees) */
  totalDrift: number;

  /** Quality classification */
  quality: "excellent" | "good" | "acceptable" | "poor";

  /** Quality message */
  qualityMessage: string;

  /** Did ZUPT engage during test? */
  zuptEngaged: boolean;

  /** Number of ZUPT events */
  zuptCount: number;
}

export type DriftTestPhase =
  | "idle"
  | "preparing"
  | "recording"
  | "processing"
  | "complete"
  | "error";

export interface DriftTestState {
  phase: DriftTestPhase;
  progress: number; // 0-100
  elapsedSeconds: number;
  currentYaw: number;
  currentDriftRate: number;
  result: DriftTestResult | null;
  error: string | null;
}

// ============================================================================
// DRIFT TEST ENGINE
// ============================================================================

export class DriftTestEngine {
  private config: DriftTestConfig;
  private state: DriftTestState;
  private samples: { time: number; yaw: number }[];
  private startTime: number = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: ((state: DriftTestState) => void)[] = [];

  constructor(config: Partial<DriftTestConfig> & { deviceId: string }) {
    this.config = {
      durationSeconds: config.durationSeconds || 300,
      sampleRateHz: config.sampleRateHz || 10,
      deviceId: config.deviceId,
    };

    this.samples = [];
    this.state = {
      phase: "idle",
      progress: 0,
      elapsedSeconds: 0,
      currentYaw: 0,
      currentDriftRate: 0,
      result: null,
      error: null,
    };
  }

  /**
   * Start the drift test.
   */
  start(): void {
    if (this.state.phase !== "idle") {
      throw new Error("Test already in progress");
    }

    this.samples = [];
    this.state = {
      ...this.state,
      phase: "preparing",
      progress: 0,
      error: null,
    };
    this.notify();

    // Short preparation delay
    setTimeout(() => {
      this.startTime = Date.now();
      this.state = { ...this.state, phase: "recording" };
      this.notify();

      const intervalMs = 1000 / this.config.sampleRateHz;
      this.timer = setInterval(() => this.collectSample(), intervalMs);
    }, 1000);
  }

  /**
   * Stop the test early.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.samples.length >= 10) {
      this.processResults();
    } else {
      this.state = {
        ...this.state,
        phase: "idle",
        error: "Test cancelled - insufficient samples",
      };
      this.notify();
    }
  }

  /**
   * Collect a yaw sample.
   */
  private collectSample(): void {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;

    // Get current drift state
    const monitor = getDriftMonitor(this.config.deviceId);
    const driftState = monitor.processFrame();

    // Extract yaw from history (last sample)
    const yaw =
      driftState.yawHistory.length > 0
        ? driftState.yawHistory[driftState.yawHistory.length - 1].yaw
        : 0;

    this.samples.push({ time: elapsed, yaw });

    // Update state
    this.state = {
      ...this.state,
      progress: Math.min(100, (elapsed / this.config.durationSeconds) * 100),
      elapsedSeconds: elapsed,
      currentYaw: yaw,
      currentDriftRate: driftState.driftRateDegPerMin,
    };
    this.notify();

    // Check if test is complete
    if (elapsed >= this.config.durationSeconds) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.processResults();
    }
  }

  /**
   * Process results after test completion.
   */
  private processResults(): void {
    this.state = { ...this.state, phase: "processing" };
    this.notify();

    try {
      const result = this.computeDriftStatistics();
      this.state = {
        ...this.state,
        phase: "complete",
        progress: 100,
        result,
      };
    } catch (e) {
      this.state = {
        ...this.state,
        phase: "error",
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }
    this.notify();
  }

  /**
   * Compute drift statistics from samples.
   */
  private computeDriftStatistics(): DriftTestResult {
    if (this.samples.length < 10) {
      throw new Error("Insufficient samples for analysis");
    }

    // Linear regression to find drift rate
    const n = this.samples.length;
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0;

    for (const s of this.samples) {
      sumX += s.time;
      sumY += s.yaw;
      sumXY += s.time * s.yaw;
      sumX2 += s.time * s.time;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // Convert slope to deg/min
    const driftRateDegPerMin = slope * 60;

    // Compute residuals for confidence interval
    let sumResidualsSq = 0;
    for (const s of this.samples) {
      const predicted = intercept + slope * s.time;
      sumResidualsSq += (s.yaw - predicted) ** 2;
    }

    const residualStdDev = Math.sqrt(sumResidualsSq / (n - 2));
    const slopeStdError = residualStdDev / Math.sqrt(sumX2 - (sumX * sumX) / n);
    const t95 = 1.96; // Approximate for large n

    const slopeCI95 = [
      (slope - t95 * slopeStdError) * 60,
      (slope + t95 * slopeStdError) * 60,
    ] as [number, number];

    // Total drift
    const firstYaw = this.samples[0].yaw;
    const lastYaw = this.samples[n - 1].yaw;
    const totalDrift = Math.abs(lastYaw - firstYaw);

    // Quality classification
    const absRate = Math.abs(driftRateDegPerMin);
    let quality: DriftTestResult["quality"];
    let qualityMessage: string;

    if (absRate < 1) {
      quality = "excellent";
      qualityMessage = "Excellent drift performance (<1°/min)";
    } else if (absRate < 3) {
      quality = "good";
      qualityMessage = "Good drift performance (1-3°/min)";
    } else if (absRate < 5) {
      quality = "acceptable";
      qualityMessage =
        "Acceptable drift (3-5°/min) - use ZUPT for best results";
    } else {
      quality = "poor";
      qualityMessage =
        "High drift (>5°/min) - check sensor mounting and calibration";
    }

    return {
      config: this.config,
      startTime: this.startTime,
      endTime: Date.now(),
      yawSamples: this.samples,
      driftRateDegPerMin,
      driftRateCI95: slopeCI95,
      totalDrift,
      quality,
      qualityMessage,
      zuptEngaged: false, // Would need to track from DriftMonitor
      zuptCount: 0,
    };
  }

  /**
   * Get current state.
   */
  getState(): DriftTestState {
    return { ...this.state };
  }

  /**
   * Subscribe to state updates.
   */
  onStateChange(callback: (state: DriftTestState) => void): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Notify subscribers.
   */
  private notify(): void {
    this.callbacks.forEach((cb) => cb(this.getState()));
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.callbacks = [];
  }
}

// ============================================================================
// EXPORT FUNCTIONS
// ============================================================================

/**
 * Export drift test result as JSON.
 */
export function exportDriftResultJSON(result: DriftTestResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Export drift test result as markdown report.
 */
export function exportDriftResultMarkdown(result: DriftTestResult): string {
  const duration = (result.endTime - result.startTime) / 1000;

  return [
    "# Drift Characterization Report",
    "",
    `**Date:** ${new Date(result.startTime).toISOString()}`,
    `**Device:** ${result.config.deviceId}`,
    `**Duration:** ${duration.toFixed(0)}s`,
    "",
    "## Results",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Drift Rate | ${result.driftRateDegPerMin.toFixed(2)}°/min |`,
    `| 95% CI | [${result.driftRateCI95[0].toFixed(2)}, ${result.driftRateCI95[1].toFixed(2)}]°/min |`,
    `| Total Drift | ${result.totalDrift.toFixed(2)}° |`,
    `| Quality | ${result.quality.toUpperCase()} |`,
    "",
    `> ${result.qualityMessage}`,
    "",
    "## Samples",
    "",
    `Total samples: ${result.yawSamples.length}`,
  ].join("\n");
}
