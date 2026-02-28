/**
 * DebugRecorder - Comprehensive diagnostic data recording for trend analysis
 *
 * Records all pipeline health metrics over time:
 * - Sample rates (per-sensor Hz, packet Hz)
 * - CRC/corruption statistics
 * - V3 compression ratios
 * - Visualization performance
 * - Network topology events
 * - Sync quality metrics
 *
 * Data can be exported as JSON for offline analysis.
 */

import {
  getSyncedSampleRate,
  getPacketRate,
  getSampleStats,
  getExpectedSensorCount,
  getExpectedSensorIds,
  getPerSensorHzArray,
  isAchieving200Hz,
  getCRCWindowStats,
  getCRCTotals,
} from "../connection/SyncedSampleStats";
import { visualizationThrottler } from "../visualization/VisualizationThrottler";

// ============================================================================
// TYPES
// ============================================================================

export interface DebugSnapshot {
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Relative time from recording start (seconds) */
  relativeTime: number;

  // Sample Rate Metrics
  sampleRate: {
    syncedHz: number;
    packetHz: number;
    sensorCount: number;
    sensorIds: number[];
    perSensorHz: { sensorId: number; hz: number }[];
    is200HzAchieved: boolean;
    incompletePackets: number;
  };

  // CRC/Integrity Metrics
  integrity: {
    windowPassed: number;
    windowFailed: number;
    windowFailRate: number;
    totalPassed: number;
    totalFailed: number;
    totalFailRate: number;
  };

  // V3 Compression Stats
  compression: {
    keyframeCount: number;
    deltaCount: number;
    compressionRatio: number;
  };

  // Visualization Performance
  visualization: {
    targetFPS: number;
    actualFPS: number;
    avgFrameTime: number;
    frameBudget: number;
    budgetUsage: number;
    displayRefreshRate: number | null;
    totalFrames: number;
    totalDataFrames: number;
  };

  // Memory (if available)
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

export interface DebugRecording {
  /** Recording ID */
  id: string;
  /** Recording start time (ISO string) */
  startTime: string;
  /** Recording end time (ISO string) */
  endTime?: string;
  /** Duration in seconds */
  duration: number;
  /** Sample interval (ms) */
  sampleIntervalMs: number;
  /** All snapshots */
  snapshots: DebugSnapshot[];
  /** Summary statistics */
  summary?: DebugRecordingSummary;
  /** User-provided notes */
  notes?: string;
  /** System info */
  systemInfo: {
    userAgent: string;
    screenWidth: number;
    screenHeight: number;
    devicePixelRatio: number;
  };
}

export interface DebugRecordingSummary {
  // Sample Rate Summary
  avgSampleRate: number;
  minSampleRate: number;
  maxSampleRate: number;
  sampleRateStdDev: number;
  percentTimeAt200Hz: number;

  // CRC Summary
  totalCRCPassed: number;
  totalCRCFailed: number;
  overallCRCFailRate: number;
  maxCRCFailRate: number;

  // Compression Summary
  avgCompressionRatio: number;
  totalKeyframes: number;
  totalDeltas: number;

  // Visualization Summary
  avgActualFPS: number;
  minActualFPS: number;
  avgBudgetUsage: number;
  maxBudgetUsage: number;

  // Data Volume
  totalSnapshots: number;
  totalSensorsObserved: number[];
}

// ============================================================================
// DEBUG RECORDER CLASS
// ============================================================================

class DebugRecorder {
  private isRecording: boolean = false;
  private snapshots: DebugSnapshot[] = [];
  private startTime: number = 0;
  private sampleIntervalMs: number = 1000; // Default 1 Hz
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private recordingId: string = "";
  private onSnapshotCallback: ((snapshot: DebugSnapshot) => void) | null = null;

  // Track all unique sensors observed
  private allSensorsObserved: Set<number> = new Set();

  /**
   * Start recording debug data
   */
  start(sampleIntervalMs: number = 1000): void {
    if (this.isRecording) {
      console.warn("[DebugRecorder] Already recording");
      return;
    }

    this.isRecording = true;
    this.snapshots = [];
    this.startTime = Date.now();
    this.sampleIntervalMs = sampleIntervalMs;
    this.recordingId = `debug_${Date.now()}`;
    this.allSensorsObserved = new Set();

    console.log(
      `[DebugRecorder] Started recording at ${this.sampleIntervalMs}ms interval`,
    );

    // Take initial snapshot
    this.takeSnapshot();

    // Start periodic sampling
    this.intervalId = setInterval(() => {
      this.takeSnapshot();
    }, this.sampleIntervalMs);
  }

  /**
   * Stop recording and return the complete recording
   */
  stop(): DebugRecording {
    if (!this.isRecording) {
      console.warn("[DebugRecorder] Not recording");
      return this.getEmptyRecording();
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRecording = false;
    const endTime = Date.now();
    const duration = (endTime - this.startTime) / 1000;

    const recording: DebugRecording = {
      id: this.recordingId,
      startTime: new Date(this.startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      duration,
      sampleIntervalMs: this.sampleIntervalMs,
      snapshots: [...this.snapshots],
      summary: this.calculateSummary(),
      systemInfo: {
        userAgent: navigator.userAgent,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        devicePixelRatio: window.devicePixelRatio,
      },
    };

    console.log(
      `[DebugRecorder] Stopped. ${this.snapshots.length} snapshots over ${duration.toFixed(1)}s`,
    );

    return recording;
  }

  /**
   * Check if currently recording
   */
  getIsRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Get current snapshot count
   */
  getSnapshotCount(): number {
    return this.snapshots.length;
  }

  /**
   * Get recording duration so far (seconds)
   */
  getCurrentDuration(): number {
    if (!this.isRecording) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * Clear all recorded data (reset for a fresh recording)
   */
  clear(): void {
    if (this.isRecording) {
      console.warn("[DebugRecorder] Cannot clear while recording");
      return;
    }
    this.snapshots = [];
    this.allSensorsObserved = new Set();
    this.startTime = 0;
    this.recordingId = "";
    console.log("[DebugRecorder] Cleared all recorded data");
  }

  /**
   * Get the current/last recording data without stopping.
   * Returns a DebugRecording object representing the current state.
   */
  getRecording(): DebugRecording {
    if (this.snapshots.length === 0) {
      return this.getEmptyRecording();
    }

    const now = Date.now();
    const duration = this.startTime > 0 ? (now - this.startTime) / 1000 : 0;

    return {
      id: this.recordingId || `debug_${this.startTime}`,
      startTime: this.startTime > 0 ? new Date(this.startTime).toISOString() : new Date().toISOString(),
      endTime: this.isRecording ? undefined : new Date(now).toISOString(),
      duration,
      sampleIntervalMs: this.sampleIntervalMs,
      snapshots: [...this.snapshots],
      summary: this.calculateSummary(),
      systemInfo: {
        userAgent: navigator.userAgent,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        devicePixelRatio: window.devicePixelRatio,
      },
    };
  }

  /**
   * Get recording duration so far (seconds) - alias for getCurrentDuration
   */
  getDurationSeconds(): number {
    return this.getCurrentDuration();
  }

  /**
   * Set callback for new snapshots (for live UI updates)
   */
  onSnapshot(callback: (snapshot: DebugSnapshot) => void): void {
    this.onSnapshotCallback = callback;
  }

  /**
   * Take a single snapshot of all debug metrics
   */
  private takeSnapshot(): void {
    const now = Date.now();
    const relativeTime = (now - this.startTime) / 1000;

    // Collect sample rate metrics
    const sampleStats = getSampleStats();
    const sensorIds = getExpectedSensorIds();
    const perSensorHz = getPerSensorHzArray();

    // Track observed sensors
    sensorIds.forEach((id) => this.allSensorsObserved.add(id));

    // Collect CRC metrics
    const crcWindow = getCRCWindowStats();
    const crcTotals = getCRCTotals();
    const totalCRCChecks = crcTotals.passed + crcTotals.failed;

    // Collect visualization metrics
    const vizStats = visualizationThrottler.getStats();

    // Collect memory if available
    let memory: DebugSnapshot["memory"] | undefined;
    if ((performance as any).memory) {
      const mem = (performance as any).memory;
      memory = {
        usedJSHeapSize: mem.usedJSHeapSize,
        totalJSHeapSize: mem.totalJSHeapSize,
        jsHeapSizeLimit: mem.jsHeapSizeLimit,
      };
    }

    const snapshot: DebugSnapshot = {
      timestamp: now,
      relativeTime,
      sampleRate: {
        syncedHz: getSyncedSampleRate(),
        packetHz: getPacketRate(),
        sensorCount: getExpectedSensorCount(),
        sensorIds: [...sensorIds],
        perSensorHz: perSensorHz.map(({ sensorId, hz }) => ({ sensorId, hz })),
        is200HzAchieved: isAchieving200Hz(),
        incompletePackets: sampleStats.incompletePackets,
      },
      integrity: {
        windowPassed: crcWindow.passed,
        windowFailed: crcWindow.failed,
        windowFailRate: crcWindow.rate,
        totalPassed: crcTotals.passed,
        totalFailed: crcTotals.failed,
        totalFailRate:
          totalCRCChecks > 0 ? (crcTotals.failed / totalCRCChecks) * 100 : 0,
      },
      compression: {
        keyframeCount: sampleStats.v3KeyframeCount,
        deltaCount: sampleStats.v3DeltaCount,
        compressionRatio: sampleStats.v3CompressionRatio,
      },
      visualization: {
        targetFPS: vizStats.targetFPS,
        actualFPS: vizStats.actualFPS,
        avgFrameTime: vizStats.avgFrameTime,
        frameBudget: vizStats.frameBudget,
        budgetUsage: vizStats.budgetUsage,
        displayRefreshRate: vizStats.displayRefreshRate,
        totalFrames: vizStats.totalFrames,
        totalDataFrames: vizStats.totalDataFrames,
      },
      memory,
    };

    this.snapshots.push(snapshot);

    // Call callback if registered
    if (this.onSnapshotCallback) {
      this.onSnapshotCallback(snapshot);
    }
  }

  /**
   * Calculate summary statistics from recorded snapshots
   */
  private calculateSummary(): DebugRecordingSummary {
    if (this.snapshots.length === 0) {
      return this.getEmptySummary();
    }

    const rates = this.snapshots.map((s) => s.sampleRate.syncedHz);
    const crcRates = this.snapshots.map((s) => s.integrity.windowFailRate);
    const compressionRatios = this.snapshots.map(
      (s) => s.compression.compressionRatio,
    );
    const actualFPS = this.snapshots.map((s) => s.visualization.actualFPS);
    const budgetUsage = this.snapshots.map((s) => s.visualization.budgetUsage);

    // Sample rate statistics
    const avgSampleRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    const minSampleRate = Math.min(...rates);
    const maxSampleRate = Math.max(...rates);
    const variance =
      rates.reduce((sum, r) => sum + Math.pow(r - avgSampleRate, 2), 0) /
      rates.length;
    const sampleRateStdDev = Math.sqrt(variance);
    const at200HzCount = this.snapshots.filter(
      (s) => s.sampleRate.is200HzAchieved,
    ).length;
    const percentTimeAt200Hz = (at200HzCount / this.snapshots.length) * 100;

    // CRC totals from last snapshot
    const lastSnapshot = this.snapshots[this.snapshots.length - 1];

    // Compression totals
    const totalKeyframes = this.snapshots.reduce(
      (sum, s) => sum + s.compression.keyframeCount,
      0,
    );
    const totalDeltas = this.snapshots.reduce(
      (sum, s) => sum + s.compression.deltaCount,
      0,
    );

    return {
      avgSampleRate,
      minSampleRate,
      maxSampleRate,
      sampleRateStdDev,
      percentTimeAt200Hz,
      totalCRCPassed: lastSnapshot.integrity.totalPassed,
      totalCRCFailed: lastSnapshot.integrity.totalFailed,
      overallCRCFailRate: lastSnapshot.integrity.totalFailRate,
      maxCRCFailRate: Math.max(...crcRates),
      avgCompressionRatio:
        compressionRatios.reduce((a, b) => a + b, 0) / compressionRatios.length,
      totalKeyframes,
      totalDeltas,
      avgActualFPS: actualFPS.reduce((a, b) => a + b, 0) / actualFPS.length,
      minActualFPS: Math.min(...actualFPS.filter((f) => f > 0)),
      avgBudgetUsage:
        budgetUsage.reduce((a, b) => a + b, 0) / budgetUsage.length,
      maxBudgetUsage: Math.max(...budgetUsage),
      totalSnapshots: this.snapshots.length,
      totalSensorsObserved: Array.from(this.allSensorsObserved).sort(
        (a, b) => a - b,
      ),
    };
  }

  private getEmptyRecording(): DebugRecording {
    return {
      id: "",
      startTime: new Date().toISOString(),
      duration: 0,
      sampleIntervalMs: this.sampleIntervalMs,
      snapshots: [],
      systemInfo: {
        userAgent: navigator.userAgent,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        devicePixelRatio: window.devicePixelRatio,
      },
    };
  }

  private getEmptySummary(): DebugRecordingSummary {
    return {
      avgSampleRate: 0,
      minSampleRate: 0,
      maxSampleRate: 0,
      sampleRateStdDev: 0,
      percentTimeAt200Hz: 0,
      totalCRCPassed: 0,
      totalCRCFailed: 0,
      overallCRCFailRate: 0,
      maxCRCFailRate: 0,
      avgCompressionRatio: 0,
      totalKeyframes: 0,
      totalDeltas: 0,
      avgActualFPS: 0,
      minActualFPS: 0,
      avgBudgetUsage: 0,
      maxBudgetUsage: 0,
      totalSnapshots: 0,
      totalSensorsObserved: [],
    };
  }
}

// ============================================================================
// EXPORT UTILITIES
// ============================================================================

/**
 * Export recording to JSON file (triggers download)
 */
export function exportRecordingToJSON(
  recording: DebugRecording,
  filename?: string,
): void {
  const json = JSON.stringify(recording, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `${recording.id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log(
    `[DebugRecorder] Exported ${recording.snapshots.length} snapshots to ${a.download}`,
  );
}

/**
 * Export recording to CSV for spreadsheet analysis
 */
export function exportRecordingToCSV(
  recording: DebugRecording,
  filename?: string,
): void {
  const headers = [
    "timestamp",
    "relativeTime",
    "syncedHz",
    "packetHz",
    "sensorCount",
    "is200HzAchieved",
    "incompletePackets",
    "crcWindowPassed",
    "crcWindowFailed",
    "crcWindowFailRate",
    "crcTotalPassed",
    "crcTotalFailed",
    "compressionRatio",
    "keyframeCount",
    "deltaCount",
    "targetFPS",
    "actualFPS",
    "avgFrameTime",
    "budgetUsage",
    "memoryUsedMB",
  ];

  const rows = recording.snapshots.map((s) => [
    s.timestamp,
    s.relativeTime.toFixed(2),
    s.sampleRate.syncedHz.toFixed(1),
    s.sampleRate.packetHz.toFixed(1),
    s.sampleRate.sensorCount,
    s.sampleRate.is200HzAchieved ? 1 : 0,
    s.sampleRate.incompletePackets,
    s.integrity.windowPassed,
    s.integrity.windowFailed,
    s.integrity.windowFailRate.toFixed(3),
    s.integrity.totalPassed,
    s.integrity.totalFailed,
    s.compression.compressionRatio.toFixed(3),
    s.compression.keyframeCount,
    s.compression.deltaCount,
    s.visualization.targetFPS,
    s.visualization.actualFPS.toFixed(1),
    s.visualization.avgFrameTime.toFixed(2),
    s.visualization.budgetUsage.toFixed(1),
    s.memory ? (s.memory.usedJSHeapSize / 1024 / 1024).toFixed(1) : "",
  ]);

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `${recording.id}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log(`[DebugRecorder] Exported CSV to ${a.download}`);
}

/**
 * Generate a text report from recording
 */
export function generateTextReport(recording: DebugRecording): string {
  const s = recording.summary;
  if (!s) return "No summary available";

  return formatTextReport(recording, s);
}

/**
 * Export recording to text report file (triggers download)
 */
export function exportRecordingToText(
  recording: DebugRecording,
  filename?: string,
): void {
  const report = generateTextReport(recording);
  const blob = new Blob([report], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `${recording.id}_report.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log(`[DebugRecorder] Exported report to ${a.download}`);
}

function formatTextReport(
  recording: DebugRecording,
  s: DebugRecordingSummary,
): string {
  return `
═══════════════════════════════════════════════════════════════════
                    DEBUG RECORDING REPORT
═══════════════════════════════════════════════════════════════════

Recording ID: ${recording.id}
Start Time:   ${recording.startTime}
End Time:     ${recording.endTime || "N/A"}
Duration:     ${recording.duration.toFixed(1)} seconds
Snapshots:    ${s.totalSnapshots} (${(recording.sampleIntervalMs / 1000).toFixed(1)}s interval)
Sensors:      ${s.totalSensorsObserved.join(", ") || "None"}

───────────────────────────────────────────────────────────────────
                      SAMPLE RATE ANALYSIS
───────────────────────────────────────────────────────────────────

Target:         200 Hz
Average:        ${s.avgSampleRate.toFixed(1)} Hz
Min:            ${s.minSampleRate.toFixed(1)} Hz
Max:            ${s.maxSampleRate.toFixed(1)} Hz
Std Dev:        ${s.sampleRateStdDev.toFixed(1)} Hz
Time at 200Hz:  ${s.percentTimeAt200Hz.toFixed(1)}%

${
  s.percentTimeAt200Hz >= 95
    ? "✅ EXCELLENT - Stable 200Hz achieved"
    : s.percentTimeAt200Hz >= 80
      ? "⚠️ GOOD - Occasional drops"
      : s.percentTimeAt200Hz >= 50
        ? "⚠️ FAIR - Significant instability"
        : "❌ POOR - Major issues detected"
}

───────────────────────────────────────────────────────────────────
                      DATA INTEGRITY (CRC)
───────────────────────────────────────────────────────────────────

Total Passed:   ${s.totalCRCPassed.toLocaleString()}
Total Failed:   ${s.totalCRCFailed.toLocaleString()}
Fail Rate:      ${s.overallCRCFailRate.toFixed(3)}%
Max Fail Rate:  ${s.maxCRCFailRate.toFixed(3)}%

${
  s.overallCRCFailRate < 0.1
    ? "✅ EXCELLENT - Minimal corruption"
    : s.overallCRCFailRate < 1.0
      ? "⚠️ GOOD - Some corruption detected"
      : s.overallCRCFailRate < 5.0
        ? "⚠️ FAIR - Notable corruption"
        : "❌ POOR - High corruption rate"
}

───────────────────────────────────────────────────────────────────
                      V3 COMPRESSION
───────────────────────────────────────────────────────────────────

Keyframes:      ${s.totalKeyframes.toLocaleString()}
Deltas:         ${s.totalDeltas.toLocaleString()}
Avg Ratio:      ${((1 - s.avgCompressionRatio) * 100).toFixed(0)}% savings

───────────────────────────────────────────────────────────────────
                   VISUALIZATION PERFORMANCE
───────────────────────────────────────────────────────────────────

Avg FPS:        ${s.avgActualFPS.toFixed(1)}
Min FPS:        ${s.minActualFPS.toFixed(1)}
Avg Budget:     ${s.avgBudgetUsage.toFixed(0)}%
Max Budget:     ${s.maxBudgetUsage.toFixed(0)}%

${
  s.avgBudgetUsage < 80
    ? "✅ EXCELLENT - Smooth rendering"
    : s.avgBudgetUsage < 100
      ? "⚠️ GOOD - Near budget limit"
      : "❌ POOR - Frame drops likely"
}

═══════════════════════════════════════════════════════════════════
                         END OF REPORT
═══════════════════════════════════════════════════════════════════
`;
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const debugRecorder = new DebugRecorder();

// Debug: Expose to window for console access
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__debugRecorder =
    debugRecorder;
  (window as unknown as Record<string, unknown>).__exportDebugJSON =
    exportRecordingToJSON;
  (window as unknown as Record<string, unknown>).__exportDebugCSV =
    exportRecordingToCSV;
}
