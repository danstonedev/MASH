/**
 * GapAnalysis.ts - Vicon-Style Data Integrity & Gap Analysis
 *
 * Analyzes recorded IMU session data for:
 * - Missing frame numbers (gaps in the TDMA sequence)
 * - Per-sensor data coverage and dropout detection
 * - Cross-sensor synchronization quality
 * - Overall data integrity scoring
 *
 * Inspired by Vicon Nexus gap-fill workflow where optical marker
 * occlusions create gaps that must be identified and filled.
 * In our case, gaps come from RF packet loss, BLE congestion,
 * or TDMA slot misses.
 */

import type { RecordedFrame } from "../lib/db/types";

// ============================================================================
// Types
// ============================================================================

/** A contiguous gap in a sensor's data stream */
export interface DataGap {
  sensorId: number;
  segment?: string;
  startFrame: number;
  endFrame: number;
  gapLength: number; // Number of missing frames
  gapDurationMs: number; // Estimated duration based on sample rate
  severity: "minor" | "moderate" | "critical"; // <3 frames, 3-20, >20
}

/** Per-sensor data quality summary */
export interface SensorReport {
  sensorId: number;
  segment?: string;
  sensorName?: string;
  totalSamples: number;
  expectedSamples: number;
  missingFrames: number;
  coveragePercent: number; // 0-100
  gaps: DataGap[];
  longestGapFrames: number;
  longestGapMs: number;
  meanGapFrames: number;
  /** Frame numbers where this sensor first and last appears */
  firstFrame: number;
  lastFrame: number;
}

/** Overall session data integrity report */
export interface GapAnalysisReport {
  // Metadata
  sessionId: string;
  analyzedAt: number;

  // Global frame analysis
  totalFrames: number;
  uniqueFrameNumbers: number;
  firstFrame: number;
  lastFrame: number;
  expectedFrameSpan: number; // lastFrame - firstFrame + 1
  globalMissingFrames: number; // Frame numbers with zero sensors reporting
  globalCoveragePercent: number;

  // Timing
  estimatedSampleRateHz: number;
  framePeriodMs: number;
  totalDurationMs: number;

  // Per-sensor breakdown
  sensorReports: SensorReport[];
  sensorCount: number;

  // Cross-sensor sync
  fullyPopulatedFrames: number; // Frames where ALL sensors reported
  partiallyPopulatedFrames: number; // Frames where SOME sensors reported
  emptyFrames: number; // Frame numbers with no data at all
  syncCoveragePercent: number; // % of frames with all sensors present

  // Overall quality grade
  overallGrade: "A" | "B" | "C" | "D" | "F";
  overallScore: number; // 0-100

  // Summary text
  summaryNotes: string[];
}

// ============================================================================
// Analysis Engine
// ============================================================================

/**
 * Perform comprehensive gap analysis on a recorded session's frames.
 *
 * @param frames - All recorded frames for a session, any order
 * @param sessionId - Session identifier
 * @param targetRateHz - Expected sample rate (default: auto-detect)
 * @param wallClockDurationMs - Wall-clock duration from session metadata (optional, takes priority for timing)
 * @returns Complete gap analysis report
 */
export function analyzeGaps(
  frames: RecordedFrame[],
  sessionId: string,
  targetRateHz?: number,
  wallClockDurationMs?: number,
): GapAnalysisReport {
  const analyzedAt = Date.now();
  const notes: string[] = [];

  if (frames.length === 0) {
    return emptyReport(sessionId, analyzedAt);
  }

  // -------------------------------------------------------------------------
  // 1. Build frame index: Map<frameNumber, Set<sensorId>>
  // -------------------------------------------------------------------------
  const frameIndex = new Map<number, Set<number>>();
  const sensorFrames = new Map<number, number[]>(); // sensorId -> sorted frame numbers
  const sensorMeta = new Map<number, { segment?: string; name?: string }>();

  for (const f of frames) {
    const fn = f.frameNumber ?? f.timestamp; // fallback to timestamp if no frameNumber
    const sid = f.sensorId ?? 0;

    if (!frameIndex.has(fn)) frameIndex.set(fn, new Set());
    frameIndex.get(fn)!.add(sid);

    if (!sensorFrames.has(sid)) sensorFrames.set(sid, []);
    sensorFrames.get(sid)!.push(fn);

    if (!sensorMeta.has(sid)) {
      sensorMeta.set(sid, { segment: f.segment, name: f.sensorName });
    }
  }

  // Sort each sensor's frames
  for (const [, arr] of sensorFrames) {
    arr.sort((a, b) => a - b);
  }

  const allFrameNumbers = Array.from(frameIndex.keys()).sort((a, b) => a - b);
  const firstFrame = allFrameNumbers[0];
  const lastFrame = allFrameNumbers[allFrameNumbers.length - 1];
  const expectedFrameSpan = lastFrame - firstFrame + 1;
  const sensorIds = Array.from(sensorFrames.keys()).sort((a, b) => a - b);
  const sensorCount = sensorIds.length;

  // -------------------------------------------------------------------------
  // 2. Estimate sample rate and duration
  // -------------------------------------------------------------------------
  // Wall-clock duration is the ground truth when available (from session
  // metadata startTime/endTime). Frame-number-derived timing is a fallback
  // that can be inaccurate if the firmware's outputFrameNumber increments
  // at a rate different from 200Hz (observed ~388Hz in multi-node setups).
  // -------------------------------------------------------------------------
  let estimatedRate = targetRateHz ?? 0;
  let framePeriodMs = 5; // default 200Hz = 5ms
  let totalDurationMs: number;

  if (wallClockDurationMs && wallClockDurationMs > 0 && expectedFrameSpan > 1) {
    // Wall-clock duration available — compute actual frame period from it
    framePeriodMs = wallClockDurationMs / (expectedFrameSpan - 1);
    estimatedRate = Math.round(1000 / framePeriodMs);
    totalDurationMs = wallClockDurationMs;
  } else if (!estimatedRate && allFrameNumbers.length >= 10) {
    // Use median inter-frame delta for robustness
    const deltas: number[] = [];
    for (let i = 1; i < Math.min(allFrameNumbers.length, 200); i++) {
      deltas.push(allFrameNumbers[i] - allFrameNumbers[i - 1]);
    }
    deltas.sort((a, b) => a - b);
    const medianDelta = deltas[Math.floor(deltas.length / 2)];

    // frameNumber increments at the sample rate
    // If median delta = 1, each frame is one sample period
    // Frame period depends on convention. Our firmware uses 5ms per frame (200Hz)
    framePeriodMs = medianDelta <= 1 ? 5 : medianDelta * 5;
    estimatedRate = Math.round(1000 / framePeriodMs);
    totalDurationMs = expectedFrameSpan * framePeriodMs;
  } else if (estimatedRate) {
    framePeriodMs = 1000 / estimatedRate;
    totalDurationMs = expectedFrameSpan * framePeriodMs;
  } else {
    totalDurationMs = expectedFrameSpan * framePeriodMs;
  }

  // -------------------------------------------------------------------------
  // 3. Global frame analysis
  // -------------------------------------------------------------------------
  const globalMissingFrames = expectedFrameSpan - allFrameNumbers.length;
  const globalCoveragePercent =
    expectedFrameSpan > 0
      ? Math.round((allFrameNumbers.length / expectedFrameSpan) * 1000) / 10
      : 100;

  // Cross-sensor sync analysis
  let fullyPopulatedFrames = 0;
  let partiallyPopulatedFrames = 0;

  for (const [, sensors] of frameIndex) {
    if (sensors.size === sensorCount) {
      fullyPopulatedFrames++;
    } else {
      partiallyPopulatedFrames++;
    }
  }

  // Count truly empty frames (frame numbers that exist in the span but have no data)
  const emptyFrames = globalMissingFrames;

  const syncCoveragePercent =
    expectedFrameSpan > 0
      ? Math.round((fullyPopulatedFrames / expectedFrameSpan) * 1000) / 10
      : 100;

  // -------------------------------------------------------------------------
  // 4. Per-sensor gap analysis
  // -------------------------------------------------------------------------
  const sensorReports: SensorReport[] = [];

  for (const sid of sensorIds) {
    const sortedFrames = sensorFrames.get(sid)!;
    const meta = sensorMeta.get(sid);
    const sensorFirst = sortedFrames[0];
    const sensorLast = sortedFrames[sortedFrames.length - 1];
    const expectedSamples = sensorLast - sensorFirst + 1;

    // Find gaps
    const gaps: DataGap[] = [];
    for (let i = 1; i < sortedFrames.length; i++) {
      const delta = sortedFrames[i] - sortedFrames[i - 1];
      if (delta > 1) {
        const gapLength = delta - 1;
        const gapDurationMs = gapLength * framePeriodMs;

        // Severity based on duration (industry-style): <15ms minor, 15-100ms moderate, >100ms critical
        let severity: DataGap["severity"] = "minor";
        if (gapDurationMs > 100) severity = "critical";
        else if (gapDurationMs >= 15) severity = "moderate";

        gaps.push({
          sensorId: sid,
          segment: meta?.segment,
          startFrame: sortedFrames[i - 1] + 1,
          endFrame: sortedFrames[i] - 1,
          gapLength,
          gapDurationMs,
          severity,
        });
      }
    }

    const missingFrames = expectedSamples - sortedFrames.length;
    const coveragePercent =
      expectedSamples > 0
        ? Math.round((sortedFrames.length / expectedSamples) * 1000) / 10
        : 100;

    const longestGap =
      gaps.length > 0
        ? gaps.reduce(
            (max, g) => (g.gapLength > max.gapLength ? g : max),
            gaps[0],
          )
        : null;

    const meanGapFrames =
      gaps.length > 0
        ? Math.round(
            (gaps.reduce((sum, g) => sum + g.gapLength, 0) / gaps.length) * 10,
          ) / 10
        : 0;

    sensorReports.push({
      sensorId: sid,
      segment: meta?.segment,
      sensorName: meta?.name,
      totalSamples: sortedFrames.length,
      expectedSamples,
      missingFrames,
      coveragePercent,
      gaps,
      longestGapFrames: longestGap?.gapLength ?? 0,
      longestGapMs: longestGap?.gapDurationMs ?? 0,
      meanGapFrames,
      firstFrame: sensorFirst,
      lastFrame: sensorLast,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Overall quality scoring
  // -------------------------------------------------------------------------
  // Weighted: 40% global coverage, 30% sync coverage, 30% worst sensor
  const worstSensorCoverage =
    sensorReports.length > 0
      ? Math.min(...sensorReports.map((s) => s.coveragePercent))
      : 100;

  const overallScore = Math.round(
    globalCoveragePercent * 0.4 +
      syncCoveragePercent * 0.3 +
      worstSensorCoverage * 0.3,
  );

  let overallGrade: GapAnalysisReport["overallGrade"];
  if (overallScore >= 95) overallGrade = "A";
  else if (overallScore >= 85) overallGrade = "B";
  else if (overallScore >= 70) overallGrade = "C";
  else if (overallScore >= 50) overallGrade = "D";
  else overallGrade = "F";

  // -------------------------------------------------------------------------
  // 6. Summary notes
  // -------------------------------------------------------------------------
  notes.push(
    `${sensorCount} sensor(s) across ${allFrameNumbers.length.toLocaleString()} unique frames`,
  );

  if (globalMissingFrames > 0) {
    notes.push(
      `${globalMissingFrames.toLocaleString()} global frame gaps detected (${(100 - globalCoveragePercent).toFixed(1)}% loss)`,
    );
  } else {
    notes.push("No global frame gaps — continuous sequence");
  }

  const criticalGaps = sensorReports.reduce(
    (sum, s) => sum + s.gaps.filter((g) => g.severity === "critical").length,
    0,
  );
  const moderateGaps = sensorReports.reduce(
    (sum, s) => sum + s.gaps.filter((g) => g.severity === "moderate").length,
    0,
  );
  const minorGaps = sensorReports.reduce(
    (sum, s) => sum + s.gaps.filter((g) => g.severity === "minor").length,
    0,
  );

  if (criticalGaps > 0)
    notes.push(
      `⚠ ${criticalGaps} critical gap(s) (>100ms) — may affect analysis quality`,
    );
  if (moderateGaps > 0)
    notes.push(`${moderateGaps} moderate gap(s) (15-100ms)`);
  if (minorGaps > 0) notes.push(`${minorGaps} minor gap(s) (<15ms)`);

  if (syncCoveragePercent < 90) {
    notes.push(
      `Cross-sensor sync: only ${syncCoveragePercent}% of frames have all sensors — check node connectivity`,
    );
  }

  return {
    sessionId,
    analyzedAt,
    totalFrames: frames.length,
    uniqueFrameNumbers: allFrameNumbers.length,
    firstFrame,
    lastFrame,
    expectedFrameSpan,
    globalMissingFrames,
    globalCoveragePercent,
    estimatedSampleRateHz: estimatedRate,
    framePeriodMs,
    totalDurationMs,
    sensorReports,
    sensorCount,
    fullyPopulatedFrames,
    partiallyPopulatedFrames,
    emptyFrames,
    syncCoveragePercent,
    overallGrade,
    overallScore,
    summaryNotes: notes,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function emptyReport(sessionId: string, analyzedAt: number): GapAnalysisReport {
  return {
    sessionId,
    analyzedAt,
    totalFrames: 0,
    uniqueFrameNumbers: 0,
    firstFrame: 0,
    lastFrame: 0,
    expectedFrameSpan: 0,
    globalMissingFrames: 0,
    globalCoveragePercent: 0,
    estimatedSampleRateHz: 0,
    framePeriodMs: 0,
    totalDurationMs: 0,
    sensorReports: [],
    sensorCount: 0,
    fullyPopulatedFrames: 0,
    partiallyPopulatedFrames: 0,
    emptyFrames: 0,
    syncCoveragePercent: 0,
    overallGrade: "F",
    overallScore: 0,
    summaryNotes: ["No frames in session"],
  };
}

/**
 * Get a color class for a coverage percentage
 */
export function coverageColor(pct: number): string {
  if (pct >= 99) return "text-green-400";
  if (pct >= 95) return "text-green-300";
  if (pct >= 90) return "text-yellow-400";
  if (pct >= 80) return "text-orange-400";
  return "text-red-400";
}

/**
 * Get a color class for a grade
 */
export function gradeColor(grade: GapAnalysisReport["overallGrade"]): string {
  switch (grade) {
    case "A":
      return "text-green-400";
    case "B":
      return "text-green-300";
    case "C":
      return "text-yellow-400";
    case "D":
      return "text-orange-400";
    case "F":
      return "text-red-400";
  }
}

/**
 * Get background color class for gap severity
 */
export function severityBg(severity: DataGap["severity"]): string {
  switch (severity) {
    case "minor":
      return "bg-yellow-500/20 border-yellow-500/30";
    case "moderate":
      return "bg-orange-500/20 border-orange-500/30";
    case "critical":
      return "bg-red-500/20 border-red-500/30";
  }
}

export function severityText(severity: DataGap["severity"]): string {
  switch (severity) {
    case "minor":
      return "text-yellow-400";
    case "moderate":
      return "text-orange-400";
    case "critical":
      return "text-red-400";
  }
}
