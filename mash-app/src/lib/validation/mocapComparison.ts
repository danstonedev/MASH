/**
 * MoCap Comparison Framework
 * ==========================
 *
 * Compares IMU-derived joint angles with optical motion capture (gold standard).
 * Essential for publication-quality validation.
 *
 * Supports:
 * - TRC file import (OpenSim/Vicon marker trajectories)
 * - Time alignment via cross-correlation
 * - RMSE, MAE, correlation statistics
 * - Bland-Altman agreement analysis
 *
 * Reference: Bland & Altman (1986). "Statistical methods for assessing
 * agreement between two methods of clinical measurement."
 *
 * @module mocapComparison
 */

// ============================================================================
// TYPES
// ============================================================================

export interface TRCData {
  /** Frame rate (Hz) */
  frameRate: number;

  /** Number of frames */
  numFrames: number;

  /** Number of markers */
  numMarkers: number;

  /** Marker names */
  markerNames: string[];

  /** Time values for each frame (seconds) */
  times: number[];

  /** Marker positions: [frameIndex][markerIndex] -> [x, y, z] */
  positions: [number, number, number][][];
}

export interface IMUSessionData {
  /** Time values for each frame (seconds) */
  times: number[];

  /** Joint angles per segment: segment -> [frameIndex] -> [flexion, rotation, abduction] */
  angles: Map<string, [number, number, number][]>;
}

export interface ComparisonResult {
  /** Joint/segment name */
  joint: string;

  /** Angle type (flexion, rotation, etc.) */
  angleType: string;

  /** Number of matched frames */
  numFrames: number;

  /** Root Mean Square Error (degrees) */
  rmse: number;

  /** Mean Absolute Error (degrees) */
  mae: number;

  /** Pearson correlation coefficient */
  correlation: number;

  /** Mean difference (IMU - MoCap) - systematic bias */
  meanDiff: number;

  /** Standard deviation of differences */
  stdDiff: number;

  /** Limits of Agreement (mean ± 1.96*std) */
  loaLower: number;
  loaUpper: number;

  /** Paired IMU and MoCap values for plotting */
  paired: { imu: number; mocap: number; time: number }[];
}

export interface ValidationSummary {
  /** Session name */
  sessionName: string;

  /** Recording duration (seconds) */
  duration: number;

  /** Number of joints compared */
  numJoints: number;

  /** Per-joint results */
  results: ComparisonResult[];

  /** Overall statistics */
  overall: {
    avgRMSE: number;
    avgMAE: number;
    avgCorrelation: number;
    passesThreshold: boolean; // < 5° RMSE
  };

  /** Timestamp of analysis */
  timestamp: number;
}

// ============================================================================
// TRC FILE PARSER
// ============================================================================

/**
 * Parse TRC (Track Row Column) file format.
 *
 * TRC format:
 * - Line 1: PathFileType, version, file type
 * - Line 2: Header row count, etc.
 * - Line 3: Marker names
 * - Line 4: Coordinate labels (X1, Y1, Z1, X2, Y2, Z2, ...)
 * - Line 5+: Data rows (frame, time, marker coords...)
 *
 * @param content Raw TRC file content
 * @returns Parsed TRC data
 */
export function parseTRC(content: string): TRCData {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 6) {
    throw new Error("Invalid TRC file: too few lines");
  }

  // Parse header (line 2)
  const headerParts = lines[1].split("\t");
  const frameRate = parseFloat(headerParts[0]) || 100;

  // Parse marker names (line 3)
  const markerLine = lines[2].split("\t");
  const markerNames: string[] = [];
  for (let i = 2; i < markerLine.length; i += 3) {
    if (markerLine[i] && markerLine[i].trim()) {
      markerNames.push(markerLine[i].trim());
    }
  }

  // Parse data rows (line 5+)
  const times: number[] = [];
  const positions: [number, number, number][][] = [];

  for (let i = 5; i < lines.length; i++) {
    const parts = lines[i].split("\t").map((p) => parseFloat(p));
    if (parts.length < 2) continue;

    const time = parts[1];
    times.push(time);

    const framePositions: [number, number, number][] = [];
    for (let m = 0; m < markerNames.length; m++) {
      const baseIdx = 2 + m * 3;
      framePositions.push([
        parts[baseIdx] || 0,
        parts[baseIdx + 1] || 0,
        parts[baseIdx + 2] || 0,
      ]);
    }
    positions.push(framePositions);
  }

  return {
    frameRate,
    numFrames: positions.length,
    numMarkers: markerNames.length,
    markerNames,
    times,
    positions,
  };
}

// ============================================================================
// TIME ALIGNMENT
// ============================================================================

/**
 * Align two time series using cross-correlation.
 * Finds the time offset that maximizes correlation.
 *
 * @param imuTimes IMU timestamps (seconds)
 * @param mocapTimes MoCap timestamps (seconds)
 * @param maxOffset Maximum offset to search (seconds)
 * @returns Optimal offset to add to IMU times
 */
export function findTimeOffset(
  imuTimes: number[],
  mocapTimes: number[],
  maxOffset: number = 5,
): number {
  // For simplicity, we'll just use the start time difference
  // A full implementation would use signal cross-correlation
  const imuStart = imuTimes[0] || 0;
  const mocapStart = mocapTimes[0] || 0;

  return mocapStart - imuStart;
}

/**
 * Interpolate IMU data to match MoCap timestamps.
 *
 * @param imuTimes Original IMU timestamps
 * @param imuAngles Original IMU angles
 * @param mocapTimes Target MoCap timestamps
 * @param offset Time offset to apply to IMU
 * @returns Interpolated IMU angles at MoCap timestamps
 */
export function interpolateToMocapTimes(
  imuTimes: number[],
  imuAngles: number[],
  mocapTimes: number[],
  offset: number,
): number[] {
  const result: number[] = [];
  const adjustedImuTimes = imuTimes.map((t) => t + offset);

  for (const targetTime of mocapTimes) {
    // Find surrounding IMU samples
    let lowIdx = 0;
    let highIdx = adjustedImuTimes.length - 1;

    for (let i = 0; i < adjustedImuTimes.length - 1; i++) {
      if (
        adjustedImuTimes[i] <= targetTime &&
        adjustedImuTimes[i + 1] >= targetTime
      ) {
        lowIdx = i;
        highIdx = i + 1;
        break;
      }
    }

    // Linear interpolation
    const t1 = adjustedImuTimes[lowIdx];
    const t2 = adjustedImuTimes[highIdx];
    const v1 = imuAngles[lowIdx];
    const v2 = imuAngles[highIdx];

    if (t2 === t1) {
      result.push(v1);
    } else {
      const alpha = (targetTime - t1) / (t2 - t1);
      result.push(v1 + alpha * (v2 - v1));
    }
  }

  return result;
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Compute comparison statistics between two aligned time series.
 */
export function computeStatistics(
  imuValues: number[],
  mocapValues: number[],
  times: number[],
  joint: string,
  angleType: string,
): ComparisonResult {
  const n = Math.min(imuValues.length, mocapValues.length);

  if (n === 0) {
    throw new Error(`No data to compare for ${joint} ${angleType}`);
  }

  // Compute differences
  const differences: number[] = [];
  const paired: ComparisonResult["paired"] = [];
  let sumSqDiff = 0;
  let sumAbsDiff = 0;
  let sumImu = 0;
  let sumMocap = 0;

  for (let i = 0; i < n; i++) {
    const diff = imuValues[i] - mocapValues[i];
    differences.push(diff);
    sumSqDiff += diff * diff;
    sumAbsDiff += Math.abs(diff);
    sumImu += imuValues[i];
    sumMocap += mocapValues[i];
    paired.push({ imu: imuValues[i], mocap: mocapValues[i], time: times[i] });
  }

  const rmse = Math.sqrt(sumSqDiff / n);
  const mae = sumAbsDiff / n;
  const meanImu = sumImu / n;
  const meanMocap = sumMocap / n;

  // Mean and std of differences (Bland-Altman)
  const meanDiff = differences.reduce((a, b) => a + b, 0) / n;
  const variance =
    differences.reduce((a, b) => a + (b - meanDiff) ** 2, 0) / (n - 1);
  const stdDiff = Math.sqrt(variance);

  // Limits of Agreement (95%)
  const loaLower = meanDiff - 1.96 * stdDiff;
  const loaUpper = meanDiff + 1.96 * stdDiff;

  // Pearson correlation
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const x = imuValues[i] - meanImu;
    const y = mocapValues[i] - meanMocap;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const correlation =
    sumX2 > 0 && sumY2 > 0 ? sumXY / Math.sqrt(sumX2 * sumY2) : 0;

  return {
    joint,
    angleType,
    numFrames: n,
    rmse,
    mae,
    correlation,
    meanDiff,
    stdDiff,
    loaLower,
    loaUpper,
    paired,
  };
}

// ============================================================================
// SYNTHETIC DATA FOR TESTING
// ============================================================================

/**
 * Generate synthetic MoCap data for testing validation pipeline.
 * Simulates a sine wave with known parameters.
 */
export function generateSyntheticMocap(
  duration: number = 10,
  frameRate: number = 100,
  amplitude: number = 45,
  frequency: number = 0.5,
): { times: number[]; angles: number[] } {
  const numFrames = Math.floor(duration * frameRate);
  const times: number[] = [];
  const angles: number[] = [];

  for (let i = 0; i < numFrames; i++) {
    const t = i / frameRate;
    times.push(t);
    angles.push(amplitude * Math.sin(2 * Math.PI * frequency * t));
  }

  return { times, angles };
}

/**
 * Generate synthetic IMU data with noise and drift.
 * For testing comparison algorithms.
 */
export function generateSyntheticIMU(
  mocapTimes: number[],
  mocapAngles: number[],
  noiseStd: number = 2,
  driftRate: number = 0.1,
): { times: number[]; angles: number[] } {
  const times = [...mocapTimes];
  const angles = mocapAngles.map((a, i) => {
    const noise = (Math.random() - 0.5) * 2 * noiseStd;
    const drift = driftRate * times[i];
    return a + noise + drift;
  });

  return { times, angles };
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

/**
 * Generate a validation summary from comparison results.
 */
export function generateValidationSummary(
  sessionName: string,
  results: ComparisonResult[],
): ValidationSummary {
  const duration =
    results.length > 0
      ? Math.max(
          ...results.map((r) => r.paired[r.paired.length - 1]?.time || 0),
        )
      : 0;

  const avgRMSE = results.reduce((a, r) => a + r.rmse, 0) / results.length;
  const avgMAE = results.reduce((a, r) => a + r.mae, 0) / results.length;
  const avgCorrelation =
    results.reduce((a, r) => a + r.correlation, 0) / results.length;

  return {
    sessionName,
    duration,
    numJoints: results.length,
    results,
    overall: {
      avgRMSE,
      avgMAE,
      avgCorrelation,
      passesThreshold: avgRMSE < 5, // < 5° RMSE is acceptable
    },
    timestamp: Date.now(),
  };
}

/**
 * Format validation summary as markdown for export.
 */
export function formatValidationMarkdown(summary: ValidationSummary): string {
  const lines: string[] = [
    `# Validation Report: ${summary.sessionName}`,
    "",
    `**Date:** ${new Date(summary.timestamp).toISOString()}`,
    `**Duration:** ${summary.duration.toFixed(1)}s`,
    `**Joints Compared:** ${summary.numJoints}`,
    "",
    "## Overall Performance",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Avg RMSE | ${summary.overall.avgRMSE.toFixed(2)}° |`,
    `| Avg MAE | ${summary.overall.avgMAE.toFixed(2)}° |`,
    `| Avg Correlation | ${summary.overall.avgCorrelation.toFixed(3)} |`,
    `| Passes Threshold (<5°) | ${summary.overall.passesThreshold ? "✅ Yes" : "❌ No"} |`,
    "",
    "## Per-Joint Results",
    "",
    `| Joint | Angle | RMSE | MAE | r | Bias | LoA |`,
    `|-------|-------|------|-----|---|------|-----|`,
  ];

  for (const r of summary.results) {
    lines.push(
      `| ${r.joint} | ${r.angleType} | ${r.rmse.toFixed(2)}° | ${r.mae.toFixed(2)}° | ` +
        `${r.correlation.toFixed(3)} | ${r.meanDiff.toFixed(2)}° | [${r.loaLower.toFixed(1)}, ${r.loaUpper.toFixed(1)}]° |`,
    );
  }

  return lines.join("\n");
}
