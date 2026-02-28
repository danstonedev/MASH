/**
 * StreamAnalyzer - High-speed diagnostic recording and analysis engine
 *
 * Unlike the DebugRecorder (which snapshots aggregate stats at 1Hz),
 * this analyzer records every frame at the packet level with microsecond
 * precision and produces detailed statistical and diagnostic analysis.
 *
 * What it captures per frame:
 * - Frame number, arrival time (performance.now), firmware timestamp
 * - Per-sensor presence (which sensors reported in each frame)
 * - Inter-frame timing deltas (jitter, gaps, bursts)
 * - Quaternion rate-of-change (detects frozen/stuck sensors)
 * - CRC pass/fail at the frame level
 *
 * Analysis outputs:
 * - Per-sensor timing histograms (dt distribution)
 * - Gap detection (frames where sensors dropped out)
 * - Burst detection (BLE batching patterns)
 * - Sensor reliability ranking
 * - Timing jitter spectral analysis
 * - Anomaly timeline with auto-classifications
 */

import {
  getPerSensorHzArray,
  getPacketRate,
  getSyncedFrameRate,
  getPartialFrameRate,
  getSyncedSampleRate,
  getCRCWindowStats,
  getCRCTotals,
  subscribeSyncedSamples,
} from "../connection/SyncedSampleStats";

// ============================================================================
// TYPES
// ============================================================================

/** A single high-speed frame capture */
export interface StreamFrame {
  /** Monotonic capture index */
  index: number;
  /** performance.now() at capture */
  captureTime: number;
  /** Relative time from recording start (ms) */
  relativeMs: number;
  /** Delta since previous frame (ms) — browser arrival time */
  dtMs: number;
  /** Delta since previous frame (ms) — firmware timestamps (excludes epoch jumps) */
  firmwareDtMs?: number;
  /** Sensors present in this snapshot */
  sensorIds: number[];
  /** Per-sensor Hz at this instant */
  perSensorHz: Array<{ sensorId: number; hz: number }>;
  /** Global rates */
  packetHz: number;
  syncedHz: number;
  partialHz: number;
  throughputHz: number;
  /** CRC window stats at capture */
  crcPassed: number;
  crcFailed: number;
  crcFailRate: number;
}

/** Detected anomaly in the stream */
export interface StreamAnomaly {
  /** When it occurred (relative ms) */
  timeMs: number;
  /** Frame index */
  frameIndex: number;
  /** Severity */
  severity: "info" | "warning" | "critical";
  /** Classification */
  type:
    | "sensor_dropout"
    | "sensor_recovery"
    | "timing_gap"
    | "burst_detected"
    | "rate_drop"
    | "rate_recovery"
    | "crc_spike"
    | "all_sensors_lost"
    | "jitter_spike";
  /** Human-readable description */
  message: string;
  /** Related sensor ID (if applicable) */
  sensorId?: number;
  /** Numeric detail (gap size, rate, etc.) */
  value?: number;
}

/** Per-sensor detailed analysis */
export interface SensorAnalysis {
  sensorId: number;
  /** Total frames where this sensor was present */
  framesPresent: number;
  /** Total frames in the capture */
  totalFrames: number;
  /** Uptime percentage */
  uptimePercent: number;
  /** Hz statistics */
  meanHz: number;
  minHz: number;
  maxHz: number;
  stdDevHz: number;
  /** Timing from SampleRateMonitor (if available) */
  firmwareHz?: number;
  arrivalHz?: number;
  firmwareJitter?: number;
  arrivalJitter?: number;
  maxGap?: number;
  droppedSamples?: number;
  /** Number of dropout events */
  dropoutCount: number;
  /** Longest continuous dropout (ms) */
  longestDropoutMs: number;
  /** Reliability score 0-100 */
  reliabilityScore: number;
}

/** Timing distribution bucket */
export interface TimingBucket {
  rangeLabel: string;
  minMs: number;
  maxMs: number;
  count: number;
  percent: number;
}

/** Complete analysis result */
export interface StreamAnalysisResult {
  /** Recording metadata */
  startTime: string;
  duration: number;
  totalFrames: number;
  captureRateHz: number;

  /** Per-sensor breakdown */
  sensors: SensorAnalysis[];
  /** Best to worst sensor ranking */
  sensorRanking: Array<{ sensorId: number; score: number; grade: string }>;

  /** Global timing statistics */
  timing: {
    meanDtMs: number;
    minDtMs: number;
    maxDtMs: number;
    stdDevDtMs: number;
    /** Distribution of inter-frame times */
    histogram: TimingBucket[];
    /** Firmware-based timing stats (gateway-synchronized clock, excludes epoch jumps) */
    firmwareMeanDtMs?: number;
    firmwareStdDevDtMs?: number;
    firmwareMinDtMs?: number;
    firmwareMaxDtMs?: number;
  };

  /** Anomaly log */
  anomalies: StreamAnomaly[];
  anomalySummary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
    byType: Record<string, number>;
  };

  /** Overall health grades */
  grades: {
    overall: string;
    timing: string;
    reliability: string;
    integrity: string;
  };

  /** Actionable recommendations */
  recommendations: string[];
}

// ============================================================================
// STREAM ANALYZER CLASS
// ============================================================================

// NOTE: Capture is packet-driven (subscribed to reportSyncedSamples).
// MAX_FRAMES is a safety cap to avoid unbounded memory use.
const MAX_FRAMES = 30000; // ~10 minutes at 50Hz TDMA frames

class StreamAnalyzerImpl {
  private isCapturing = false;
  private frames: StreamFrame[] = [];
  private anomalies: StreamAnomaly[] = [];
  private startTime = 0;
  private unsubscribe: (() => void) | null = null;
  private expectedIntervalMs = 20; // Initialize to 50Hz; refined dynamically
  private frameIndex = 0;
  private lastCaptureTime = 0;
  private lastSensorSet = new Set<number>();
  private lastPacketHz = 0;
  private lastFirmwareTimestampUs = 0; // Track firmware timestamps for dt computation

  // Rate history for detecting drops (last 10 values)
  private packetHzHistory: number[] = [];

  /**
   * Start packet-driven capture
   */
  start(): void {
    if (this.isCapturing) {
      console.warn("[StreamAnalyzer] Already capturing");
      return;
    }

    this.isCapturing = true;
    this.frames = [];
    this.anomalies = [];
    this.startTime = performance.now();
    this.expectedIntervalMs = 20;
    this.frameIndex = 0;
    this.lastCaptureTime = this.startTime;
    this.lastSensorSet = new Set();
    this.lastPacketHz = 0;
    this.lastFirmwareTimestampUs = 0;
    this.packetHzHistory = [];

    console.debug("[StreamAnalyzer] Started packet-driven capture");

    // Subscribe to real packet events (including firmware timestamps)
    this.unsubscribe = subscribeSyncedSamples((evt) => {
      this.captureFrame(evt.now, evt.sensorIds, evt.firmwareTimestampUs);
    });
  }

  /**
   * Stop capture and return results
   */
  stop(): StreamAnalysisResult {
    if (!this.isCapturing) {
      console.warn("[StreamAnalyzer] Not capturing");
      return this.emptyResult();
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.isCapturing = false;
    const duration = (performance.now() - this.startTime) / 1000;

    console.debug(
      `[StreamAnalyzer] Stopped. ${this.frames.length} frames over ${duration.toFixed(1)}s`,
    );

    return this.analyze();
  }

  getIsCapturing(): boolean {
    return this.isCapturing;
  }

  getFrameCount(): number {
    return this.frames.length;
  }

  getAnomalyCount(): number {
    return this.anomalies.length;
  }

  getDurationSeconds(): number {
    if (!this.isCapturing) return 0;
    return (performance.now() - this.startTime) / 1000;
  }

  /** Get live anomalies for UI */
  getRecentAnomalies(count: number = 5): StreamAnomaly[] {
    return this.anomalies.slice(-count);
  }

  /**
   * Capture a single frame (invoked on each incoming packet)
   */
  private captureFrame(
    now: number,
    sensorIdsFromPacket: number[],
    firmwareTimestampUs?: number,
  ): void {
    const relativeMs = now - this.startTime;
    const dtMs = now - this.lastCaptureTime;

    // Compute firmware-based dt (excludes epoch jumps for clean jitter measurement)
    let firmwareDtMs: number | undefined;
    if (firmwareTimestampUs !== undefined && this.lastFirmwareTimestampUs > 0) {
      const rawDtUs = firmwareTimestampUs - this.lastFirmwareTimestampUs;
      const rawDtMs = rawDtUs / 1000;
      // Filter out epoch jumps: normal dt at 200Hz individual samples is ~5ms.
      // Allow up to ~12ms (2.4× expected) for jitter, but reject larger gaps
      // which indicate real packet drops or epoch resets, not timing noise.
      if (rawDtMs > 0 && rawDtMs < 12) {
        firmwareDtMs = rawDtMs;
      }
    }
    if (firmwareTimestampUs !== undefined) {
      this.lastFirmwareTimestampUs = firmwareTimestampUs;
    }

    const perSensorHz = getPerSensorHzArray();
    const sensorIds = sensorIdsFromPacket;
    const packetHz = getPacketRate();
    const syncedHz = getSyncedFrameRate();
    const partialHz = getPartialFrameRate();
    const throughputHz = getSyncedSampleRate();
    const crc = getCRCWindowStats();

    const frame: StreamFrame = {
      index: this.frameIndex++,
      captureTime: now,
      relativeMs,
      dtMs,
      firmwareDtMs,
      sensorIds,
      perSensorHz: perSensorHz.map(({ sensorId, hz }) => ({ sensorId, hz })),
      packetHz,
      syncedHz,
      partialHz,
      throughputHz,
      crcPassed: crc.passed,
      crcFailed: crc.failed,
      crcFailRate: crc.rate,
    };

    this.frames.push(frame);

    // Enforce max frames (FIFO)
    if (this.frames.length > MAX_FRAMES) {
      this.frames.shift();
    }

    // ---- ANOMALY DETECTION (real-time) ----

    const currentSensorSet = new Set(sensorIds);

    // Sensor dropout detection
    if (this.lastSensorSet.size > 0) {
      for (const id of this.lastSensorSet) {
        if (!currentSensorSet.has(id)) {
          this.anomalies.push({
            timeMs: relativeMs,
            frameIndex: frame.index,
            severity: "warning",
            type: "sensor_dropout",
            message: `Sensor #${id} disappeared from stream`,
            sensorId: id,
          });
        }
      }
      for (const id of currentSensorSet) {
        if (!this.lastSensorSet.has(id)) {
          this.anomalies.push({
            timeMs: relativeMs,
            frameIndex: frame.index,
            severity: "info",
            type: "sensor_recovery",
            message: `Sensor #${id} reappeared in stream`,
            sensorId: id,
          });
        }
      }
    }

    // All sensors lost
    if (this.lastSensorSet.size > 0 && currentSensorSet.size === 0) {
      this.anomalies.push({
        timeMs: relativeMs,
        frameIndex: frame.index,
        severity: "critical",
        type: "all_sensors_lost",
        message: "All sensors disappeared from stream",
      });
    }

    // Refine expected interval dynamically from packetHz (if available)
    if (packetHz > 0) {
      const inferred = 1000 / packetHz;
      if (Number.isFinite(inferred) && inferred > 1 && inferred < 2000) {
        this.expectedIntervalMs = inferred;
      }
    }

    // Timing gap detection (>3× expected interval)
    if (dtMs > this.expectedIntervalMs * 3 && this.frameIndex > 1) {
      this.anomalies.push({
        timeMs: relativeMs,
        frameIndex: frame.index,
        severity: "warning",
        type: "timing_gap",
        message: `Frame gap: ${dtMs.toFixed(0)}ms (expected ~${this.expectedIntervalMs.toFixed(0)}ms)`,
        value: dtMs,
      });
    }

    // Rate drop detection
    this.packetHzHistory.push(packetHz);
    if (this.packetHzHistory.length > 10) this.packetHzHistory.shift();
    if (this.packetHzHistory.length >= 5) {
      const recentAvg =
        this.packetHzHistory.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const olderAvg =
        this.packetHzHistory.slice(0, 3).reduce((a, b) => a + b, 0) / 3;

      if (olderAvg > 20 && recentAvg < olderAvg * 0.5) {
        this.anomalies.push({
          timeMs: relativeMs,
          frameIndex: frame.index,
          severity: "critical",
          type: "rate_drop",
          message: `Packet rate dropped ${olderAvg.toFixed(0)} → ${recentAvg.toFixed(0)} Hz`,
          value: recentAvg,
        });
      }
    }

    // CRC spike detection
    if (crc.rate > 5 && this.frameIndex > 20) {
      this.anomalies.push({
        timeMs: relativeMs,
        frameIndex: frame.index,
        severity: "warning",
        type: "crc_spike",
        message: `CRC failure rate: ${crc.rate.toFixed(1)}%`,
        value: crc.rate,
      });
    }

    // Per-sensor Hz jitter spike
    for (const s of perSensorHz) {
      if (s.hz > 0 && s.hz < 10) {
        this.anomalies.push({
          timeMs: relativeMs,
          frameIndex: frame.index,
          severity: "critical",
          type: "jitter_spike",
          message: `Sensor #${s.sensorId} rate critically low: ${s.hz.toFixed(0)}Hz`,
          sensorId: s.sensorId,
          value: s.hz,
        });
      }
    }

    this.lastSensorSet = currentSensorSet;
    this.lastPacketHz = packetHz;
    this.lastCaptureTime = now;
  }

  // ============================================================================
  // ANALYSIS ENGINE
  // ============================================================================

  private analyze(): StreamAnalysisResult {
    if (this.frames.length < 2) return this.emptyResult();

    const duration =
      (this.frames[this.frames.length - 1].relativeMs -
        this.frames[0].relativeMs) /
      1000;
    const captureRateHz = this.frames.length / Math.max(duration, 0.1);

    // ---- Timing Analysis ----
    const dts = this.frames.slice(1).map((f) => f.dtMs);
    const timing = this.computeTimingStats(dts);

    // ---- Firmware Timing Analysis (gateway-synchronized clock) ----
    const firmwareDts = this.frames
      .map((f) => f.firmwareDtMs)
      .filter((d): d is number => d !== undefined);
    if (firmwareDts.length > 0) {
      const fwMean =
        firmwareDts.reduce((a, b) => a + b, 0) / firmwareDts.length;
      const fwMin = Math.min(...firmwareDts);
      const fwMax = Math.max(...firmwareDts);
      const fwVariance =
        firmwareDts.reduce((s, d) => s + (d - fwMean) ** 2, 0) /
        firmwareDts.length;
      timing.firmwareMeanDtMs = fwMean;
      timing.firmwareStdDevDtMs = Math.sqrt(fwVariance);
      timing.firmwareMinDtMs = fwMin;
      timing.firmwareMaxDtMs = fwMax;
    }

    // ---- Per-Sensor Analysis ----
    const allSensorIds = new Set<number>();
    for (const f of this.frames) {
      for (const id of f.sensorIds) allSensorIds.add(id);
    }

    const sensors: SensorAnalysis[] = [];
    for (const sensorId of allSensorIds) {
      sensors.push(this.analyzeSensor(sensorId));
    }
    sensors.sort((a, b) => b.reliabilityScore - a.reliabilityScore);

    // ---- Sensor Ranking ----
    const sensorRanking = sensors.map((s) => ({
      sensorId: s.sensorId,
      score: s.reliabilityScore,
      grade: this.scoreToGrade(s.reliabilityScore),
    }));

    // ---- Anomaly Summary ----
    const anomalySummary = this.summarizeAnomalies();

    // ---- Grades ----
    const grades = this.computeGrades(sensors, timing, anomalySummary);

    // ---- Recommendations ----
    const recommendations = this.generateRecommendations(
      sensors,
      timing,
      anomalySummary,
      grades,
    );

    // Deduplicate consecutive identical anomalies
    const dedupedAnomalies = this.deduplicateAnomalies(this.anomalies);

    return {
      startTime: new Date(
        performance.timeOrigin + this.startTime,
      ).toISOString(),
      duration,
      totalFrames: this.frames.length,
      captureRateHz,
      sensors,
      sensorRanking,
      timing,
      anomalies: dedupedAnomalies,
      anomalySummary,
      grades,
      recommendations,
    };
  }

  private computeTimingStats(dts: number[]): StreamAnalysisResult["timing"] {
    if (dts.length === 0) {
      return {
        meanDtMs: 0,
        minDtMs: 0,
        maxDtMs: 0,
        stdDevDtMs: 0,
        histogram: [],
      };
    }

    const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
    const min = Math.min(...dts);
    const max = Math.max(...dts);
    const variance =
      dts.reduce((sum, d) => sum + (d - mean) ** 2, 0) / dts.length;
    const stdDev = Math.sqrt(variance);

    // Build histogram
    const buckets: TimingBucket[] = [
      { rangeLabel: "< 10ms", minMs: 0, maxMs: 10, count: 0, percent: 0 },
      { rangeLabel: "10-25ms", minMs: 10, maxMs: 25, count: 0, percent: 0 },
      { rangeLabel: "25-60ms", minMs: 25, maxMs: 60, count: 0, percent: 0 },
      { rangeLabel: "60-100ms", minMs: 60, maxMs: 100, count: 0, percent: 0 },
      { rangeLabel: "100-250ms", minMs: 100, maxMs: 250, count: 0, percent: 0 },
      { rangeLabel: "250-500ms", minMs: 250, maxMs: 500, count: 0, percent: 0 },
      {
        rangeLabel: "> 500ms",
        minMs: 500,
        maxMs: Infinity,
        count: 0,
        percent: 0,
      },
    ];

    for (const dt of dts) {
      for (const bucket of buckets) {
        if (dt >= bucket.minMs && dt < bucket.maxMs) {
          bucket.count++;
          break;
        }
      }
    }

    for (const bucket of buckets) {
      bucket.percent = (bucket.count / dts.length) * 100;
    }

    return {
      meanDtMs: mean,
      minDtMs: min,
      maxDtMs: max,
      stdDevDtMs: stdDev,
      histogram: buckets,
    };
  }

  private analyzeSensor(sensorId: number): SensorAnalysis {
    const totalFrames = this.frames.length;
    const framesPresent = this.frames.filter((f) =>
      f.sensorIds.includes(sensorId),
    ).length;
    const uptimePercent = (framesPresent / totalFrames) * 100;

    // Hz statistics from perSensorHz snapshots
    const hzValues = this.frames
      .map((f) => f.perSensorHz.find((s) => s.sensorId === sensorId)?.hz ?? 0)
      .filter((h) => h > 0);

    let meanHz = 0,
      minHz = 0,
      maxHz = 0,
      stdDevHz = 0;
    if (hzValues.length > 0) {
      meanHz = hzValues.reduce((a, b) => a + b, 0) / hzValues.length;
      minHz = Math.min(...hzValues);
      maxHz = Math.max(...hzValues);
      const variance =
        hzValues.reduce((s, h) => s + (h - meanHz) ** 2, 0) / hzValues.length;
      stdDevHz = Math.sqrt(variance);
    }

    // Get firmware Hz from canonical source (SyncedSampleStats.perSensorHz)
    // PIPELINE FIX: Replaced SampleRateMonitor (duplicate tracker with different window)
    const perSensorHz = getPerSensorHzArray();
    const sensorHzEntry = perSensorHz.find((s) => s.sensorId === sensorId);
    const firmwareHz = sensorHzEntry?.hz;

    // Dropout analysis
    let dropoutCount = 0;
    let currentDropoutStart = -1;
    let longestDropoutMs = 0;

    for (let i = 0; i < this.frames.length; i++) {
      const present = this.frames[i].sensorIds.includes(sensorId);
      if (!present && currentDropoutStart < 0) {
        currentDropoutStart = i;
        dropoutCount++;
      } else if (present && currentDropoutStart >= 0) {
        const dropoutDuration =
          this.frames[i].relativeMs -
          this.frames[currentDropoutStart].relativeMs;
        longestDropoutMs = Math.max(longestDropoutMs, dropoutDuration);
        currentDropoutStart = -1;
      }
    }
    // Handle dropout still active at end
    if (currentDropoutStart >= 0) {
      const dropoutDuration =
        this.frames[this.frames.length - 1].relativeMs -
        this.frames[currentDropoutStart].relativeMs;
      longestDropoutMs = Math.max(longestDropoutMs, dropoutDuration);
    }

    // Reliability score (0-100)
    let score = 100;
    score -= (100 - uptimePercent) * 2; // Uptime weight
    if (stdDevHz > 5) score -= Math.min(20, stdDevHz); // Hz stability
    if (dropoutCount > 0) score -= Math.min(30, dropoutCount * 3); // Dropout penalty
    score = Math.max(0, Math.min(100, score));

    return {
      sensorId,
      framesPresent,
      totalFrames,
      uptimePercent,
      meanHz,
      minHz,
      maxHz,
      stdDevHz,
      firmwareHz,
      arrivalHz: undefined, // Was from SampleRateMonitor — removed (duplicate tracker)
      firmwareJitter: undefined,
      arrivalJitter: undefined,
      maxGap: undefined,
      droppedSamples: undefined,
      dropoutCount,
      longestDropoutMs,
      reliabilityScore: score,
    };
  }

  private summarizeAnomalies(): StreamAnalysisResult["anomalySummary"] {
    const byType: Record<string, number> = {};
    let critical = 0,
      warning = 0,
      info = 0;

    for (const a of this.anomalies) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      if (a.severity === "critical") critical++;
      else if (a.severity === "warning") warning++;
      else info++;
    }

    return { total: this.anomalies.length, critical, warning, info, byType };
  }

  private computeGrades(
    sensors: SensorAnalysis[],
    timing: StreamAnalysisResult["timing"],
    anomalies: StreamAnalysisResult["anomalySummary"],
  ): StreamAnalysisResult["grades"] {
    // Timing grade — use firmware timestamps when available (ground truth from
    // gateway-synchronized clock), fall back to browser arrival time if not.
    const timingStdDev = timing.firmwareStdDevDtMs ?? timing.stdDevDtMs;
    const timingScore =
      timingStdDev < 5
        ? 100
        : timingStdDev < 15
          ? 80
          : timingStdDev < 30
            ? 60
            : 40;

    // Reliability grade
    const avgReliability =
      sensors.length > 0
        ? sensors.reduce((s, se) => s + se.reliabilityScore, 0) / sensors.length
        : 0;

    // Integrity grade
    const crcTotals = getCRCTotals();
    const totalCRC = crcTotals.passed + crcTotals.failed;
    const crcFailRate = totalCRC > 0 ? (crcTotals.failed / totalCRC) * 100 : 0;
    const integrityScore =
      crcFailRate < 0.1
        ? 100
        : crcFailRate < 1
          ? 80
          : crcFailRate < 5
            ? 60
            : 30;

    // Overall
    const overall =
      timingScore * 0.3 + avgReliability * 0.4 + integrityScore * 0.3;

    return {
      overall: this.scoreToGrade(overall),
      timing: this.scoreToGrade(timingScore),
      reliability: this.scoreToGrade(avgReliability),
      integrity: this.scoreToGrade(integrityScore),
    };
  }

  private scoreToGrade(score: number): string {
    if (score >= 95) return "A+";
    if (score >= 90) return "A";
    if (score >= 85) return "A-";
    if (score >= 80) return "B+";
    if (score >= 75) return "B";
    if (score >= 70) return "B-";
    if (score >= 65) return "C+";
    if (score >= 60) return "C";
    if (score >= 50) return "D";
    return "F";
  }

  private generateRecommendations(
    sensors: SensorAnalysis[],
    timing: StreamAnalysisResult["timing"],
    anomalies: StreamAnalysisResult["anomalySummary"],
    _grades: StreamAnalysisResult["grades"],
  ): string[] {
    const recs: string[] = [];

    // Sensor-specific
    for (const s of sensors) {
      if (s.uptimePercent < 90) {
        recs.push(
          `Sensor #${s.sensorId} has ${s.uptimePercent.toFixed(0)}% uptime — check RF signal strength, distance to gateway, and battery level.`,
        );
      }
      if (s.dropoutCount > 3) {
        recs.push(
          `Sensor #${s.sensorId} had ${s.dropoutCount} dropout events (longest: ${s.longestDropoutMs.toFixed(0)}ms). This may indicate intermittent connection issues.`,
        );
      }
      if (s.firmwareJitter && s.firmwareJitter > 20) {
        recs.push(
          `Sensor #${s.sensorId} firmware jitter is ${s.firmwareJitter.toFixed(1)}ms — may indicate firmware timing instability.`,
        );
      }
    }

    // Timing
    if (timing.stdDevDtMs > 20) {
      if (
        timing.firmwareStdDevDtMs !== undefined &&
        timing.firmwareStdDevDtMs < 5
      ) {
        recs.push(
          `Browser arrival jitter is ${timing.stdDevDtMs.toFixed(1)}ms but firmware timing is stable (σ=${timing.firmwareStdDevDtMs.toFixed(1)}ms). This is normal USB/BLE batching — data integrity is not affected.`,
        );
      } else {
        recs.push(
          `High capture timing jitter (${timing.stdDevDtMs.toFixed(1)}ms std dev). Browser may be under load — close unnecessary tabs.`,
        );
      }
    }

    // Anomalies
    if (anomalies.critical > 0) {
      recs.push(
        `${anomalies.critical} critical anomalies detected. Review the anomaly log for rate drops and sensor losses.`,
      );
    }
    if ((anomalies.byType["crc_spike"] || 0) > 5) {
      recs.push(
        `Repeated CRC failures suggest wireless interference. Try moving the gateway or reducing distance to sensors.`,
      );
    }

    if (recs.length === 0) {
      recs.push("No issues detected — stream quality looks healthy.");
    }

    return recs;
  }

  private deduplicateAnomalies(anomalies: StreamAnomaly[]): StreamAnomaly[] {
    if (anomalies.length === 0) return [];

    const result: StreamAnomaly[] = [anomalies[0]];
    for (let i = 1; i < anomalies.length; i++) {
      const prev = anomalies[i - 1];
      const curr = anomalies[i];
      // Skip if same type+sensor within 500ms
      if (
        curr.type === prev.type &&
        curr.sensorId === prev.sensorId &&
        curr.timeMs - prev.timeMs < 500
      ) {
        continue;
      }
      result.push(curr);
    }
    return result;
  }

  private emptyResult(): StreamAnalysisResult {
    return {
      startTime: new Date().toISOString(),
      duration: 0,
      totalFrames: 0,
      captureRateHz: 0,
      sensors: [],
      sensorRanking: [],
      timing: {
        meanDtMs: 0,
        minDtMs: 0,
        maxDtMs: 0,
        stdDevDtMs: 0,
        histogram: [],
      },
      anomalies: [],
      anomalySummary: {
        total: 0,
        critical: 0,
        warning: 0,
        info: 0,
        byType: {},
      },
      grades: { overall: "-", timing: "-", reliability: "-", integrity: "-" },
      recommendations: [],
    };
  }
}

// ============================================================================
// EXPORT UTILITIES
// ============================================================================

export function exportAnalysisToJSON(
  result: StreamAnalysisResult,
  filename?: string,
): void {
  const json = JSON.stringify(result, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `stream-analysis-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function generateAnalysisReport(r: StreamAnalysisResult): string {
  const sep = "═".repeat(65);
  const line = "─".repeat(65);

  let report = `
${sep}
              HIGH-SPEED STREAM ANALYSIS REPORT
${sep}

Captured:     ${r.startTime}
Duration:     ${r.duration.toFixed(1)}s
Frames:       ${r.totalFrames.toLocaleString()} (${r.captureRateHz.toFixed(0)}Hz capture)

${line}
                    OVERALL GRADES
${line}

  Overall:      ${r.grades.overall}
  Timing:       ${r.grades.timing}
  Reliability:  ${r.grades.reliability}
  Integrity:    ${r.grades.integrity}

${line}
                 SENSOR RELIABILITY RANKING
${line}
`;

  for (const s of r.sensorRanking) {
    const bar =
      "█".repeat(Math.round(s.score / 5)) +
      "░".repeat(20 - Math.round(s.score / 5));
    report += `  Sensor #${s.sensorId}  [${bar}] ${s.score.toFixed(0)}  ${s.grade}\n`;
  }

  report += `\n${line}\n                 PER-SENSOR DETAIL\n${line}\n`;

  for (const s of r.sensors) {
    report += `
  ── Sensor #${s.sensorId} ──
    Uptime:         ${s.uptimePercent.toFixed(1)}% (${s.framesPresent}/${s.totalFrames} frames)
    Mean Hz:        ${s.meanHz.toFixed(1)} (min: ${s.minHz.toFixed(1)}, max: ${s.maxHz.toFixed(1)}, σ: ${s.stdDevHz.toFixed(2)})
    Dropouts:       ${s.dropoutCount} events (longest: ${s.longestDropoutMs.toFixed(0)}ms)
    Reliability:    ${s.reliabilityScore.toFixed(0)}/100`;
    if (s.firmwareHz != null) {
      report += `
    Firmware Hz:    ${s.firmwareHz.toFixed(1)} (jitter: ${s.firmwareJitter?.toFixed(1) ?? "?"}ms)
    Arrival Hz:     ${s.arrivalHz?.toFixed(1) ?? "?"} (jitter: ${s.arrivalJitter?.toFixed(1) ?? "?"}ms)
    Max Gap:        ${s.maxGap?.toFixed(1) ?? "?"}ms
    Dropped:        ${s.droppedSamples ?? "?"}`;
    }
    report += "\n";
  }

  report += `\n${line}\n              TIMING DISTRIBUTION\n${line}\n`;
  for (const b of r.timing.histogram) {
    if (b.count > 0) {
      const bar = "█".repeat(Math.round(b.percent / 2));
      report += `  ${b.rangeLabel.padEnd(12)} ${bar} ${b.count} (${b.percent.toFixed(1)}%)\n`;
    }
  }
  report += `\n  Browser dt:  Mean ${r.timing.meanDtMs.toFixed(1)}ms  σ ${r.timing.stdDevDtMs.toFixed(1)}ms  Range: ${r.timing.minDtMs.toFixed(0)}-${r.timing.maxDtMs.toFixed(0)}ms\n`;
  if (
    r.timing.firmwareMeanDtMs != null &&
    r.timing.firmwareStdDevDtMs != null
  ) {
    report += `  Firmware dt: Mean ${r.timing.firmwareMeanDtMs.toFixed(1)}ms  σ ${r.timing.firmwareStdDevDtMs.toFixed(1)}ms  Range: ${r.timing.firmwareMinDtMs?.toFixed(0) ?? "?"}-${r.timing.firmwareMaxDtMs?.toFixed(0) ?? "?"}ms  ← used for grade\n`;
  }

  report += `\n${line}\n              ANOMALY SUMMARY\n${line}\n`;
  report += `  Total: ${r.anomalySummary.total}  (Critical: ${r.anomalySummary.critical}, Warning: ${r.anomalySummary.warning}, Info: ${r.anomalySummary.info})\n\n`;

  const typeNames: Record<string, string> = {
    sensor_dropout: "Sensor Dropouts",
    sensor_recovery: "Sensor Recoveries",
    timing_gap: "Timing Gaps",
    rate_drop: "Rate Drops",
    crc_spike: "CRC Failures",
    all_sensors_lost: "Total Stream Loss",
    jitter_spike: "Jitter Spikes",
  };

  for (const [type, count] of Object.entries(r.anomalySummary.byType)) {
    report += `  ${(typeNames[type] || type).padEnd(22)} ${count}\n`;
  }

  if (r.anomalies.length > 0) {
    report += `\n${line}\n              ANOMALY LOG (first 50)\n${line}\n`;
    for (const a of r.anomalies.slice(0, 50)) {
      const icon =
        a.severity === "critical"
          ? "!!!"
          : a.severity === "warning"
            ? " ! "
            : " i ";
      report += `  [${icon}] ${(a.timeMs / 1000).toFixed(2)}s  ${a.message}\n`;
    }
  }

  report += `\n${line}\n              RECOMMENDATIONS\n${line}\n`;
  for (const rec of r.recommendations) {
    report += `  • ${rec}\n`;
  }

  report += `\n${sep}\n                    END OF REPORT\n${sep}\n`;

  return report;
}

export function exportAnalysisReport(
  result: StreamAnalysisResult,
  filename?: string,
): void {
  const report = generateAnalysisReport(result);
  const blob = new Blob([report], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `stream-analysis-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// SINGLETON
// ============================================================================

export const streamAnalyzer = new StreamAnalyzerImpl();

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__streamAnalyzer =
    streamAnalyzer;
}
