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
 * In our case, gaps come from RF packet loss, ESP-NOW congestion,
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
  startTimeMs: number;
  endTimeMs: number;
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
  firstTimeMs: number;
  lastTimeMs: number;
  estimatedSamplePeriodMs: number;
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
  sessionStartTimeMs: number;
  sessionEndTimeMs: number;
  expectedFrameSpan: number; // lastFrame - firstFrame + 1
  globalMissingFrames: number; // Frame numbers with zero sensors reporting
  globalCoveragePercent: number;
  timelineCoveragePercent: number;

  // Timing
  estimatedSampleRateHz: number;
  framePeriodMs: number;
  totalDurationMs: number;

  // Per-sensor breakdown
  sensorReports: SensorReport[];
  sensorCount: number;

  // Cross-sensor sync
  transportCompleteFrames: number; // Frames that satisfied their packet-local expected count
  fullyPopulatedFrames: number; // Frames where ALL sensors reported
  partiallyPopulatedFrames: number; // Frames where SOME sensors reported
  emptyFrames: number; // Frame numbers with no data at all
  syncCoveragePercent: number; // % of frames with all sensors present
  strictEpochCoveragePercent: number; // % of transport groups with all session sensors present
  transportCoveragePercent: number; // % of transport groups that were packet-locally complete
  packetLocalMode: boolean;
  packetExpectedCountMin: number;
  packetExpectedCountMax: number;

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
  // 1. Build transport-group index and per-sensor frame sets
  // -------------------------------------------------------------------------
  const frameIndex = new Map<
    number,
    {
      sensors: Set<number>;
      expectedCount: number;
      authoritativeExpectedCount: number;
    }
  >();
  /** Per-sensor: set of gateway frame numbers where this sensor reported */
  const sensorFrameSets = new Map<number, Set<number>>();
  const sensorMeta = new Map<number, { segment?: string; name?: string }>();

  for (const f of frames) {
    const timeMs = getFrameTimeMs(f);
    const fn =
      typeof f.frameNumber === "number" && Number.isFinite(f.frameNumber)
        ? f.frameNumber
        : Math.round(timeMs);
    const sid = f.sensorId ?? 0;

    if (!frameIndex.has(fn)) {
      frameIndex.set(fn, {
        sensors: new Set<number>(),
        expectedCount: 0,
        authoritativeExpectedCount: 0,
      });
    }
    const frameEntry = frameIndex.get(fn)!;
    frameEntry.sensors.add(sid);
    frameEntry.expectedCount = Math.max(
      frameEntry.expectedCount,
      Number(f.frameCompleteness?.expectedCount ?? 0),
    );
    frameEntry.authoritativeExpectedCount = Math.max(
      frameEntry.authoritativeExpectedCount,
      Number(f.frameCompleteness?.authoritativeExpectedCount ?? 0),
    );

    if (!sensorFrameSets.has(sid)) sensorFrameSets.set(sid, new Set());
    sensorFrameSets.get(sid)!.add(fn);

    if (!sensorMeta.has(sid)) {
      sensorMeta.set(sid, { segment: f.segment, name: f.sensorName });
    }
  }

  const allFrameNumbers = Array.from(frameIndex.keys()).sort((a, b) => a - b);
  const firstFrame = allFrameNumbers[0];
  const lastFrame = allFrameNumbers[allFrameNumbers.length - 1];
  const expectedFrameSpan = lastFrame - firstFrame + 1;
  const sensorIds = Array.from(sensorFrameSets.keys()).sort((a, b) => a - b);
  const sensorCount = sensorIds.length;
  const packetExpectedCounts = Array.from(frameIndex.values()).map((entry) =>
    entry.expectedCount > 0 ? entry.expectedCount : entry.sensors.size,
  );
  const packetExpectedCountMin =
    packetExpectedCounts.length > 0 ? Math.min(...packetExpectedCounts) : 0;
  const packetExpectedCountMax =
    packetExpectedCounts.length > 0 ? Math.max(...packetExpectedCounts) : 0;
  const packetLocalMode = packetExpectedCounts.some(
    (count) => count > 0 && count < sensorCount,
  );

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

  // Session timeline anchored to the gateway's frame clock, not arrival timestamps
  const sessionStartTimeMs = 0;
  const sessionEndTimeMs = totalDurationMs;

  // -------------------------------------------------------------------------
  // 3. Global frame analysis
  // -------------------------------------------------------------------------
  const globalMissingFrames = expectedFrameSpan - allFrameNumbers.length;
  const globalCoveragePercent =
    expectedFrameSpan > 0
      ? Math.round((allFrameNumbers.length / expectedFrameSpan) * 1000) / 10
      : 100;
  const timelineCoveragePercent = globalCoveragePercent;

  // Cross-sensor sync analysis
  let transportCompleteFrames = 0;
  let fullyPopulatedFrames = 0;
  let partiallyPopulatedFrames = 0;

  for (const [, entry] of frameIndex) {
    const observedCount = entry.sensors.size;
    const packetExpected =
      entry.expectedCount > 0 ? entry.expectedCount : observedCount;
    const authoritativeExpected =
      entry.authoritativeExpectedCount > 0
        ? entry.authoritativeExpectedCount
        : sensorCount;

    if (observedCount >= packetExpected) {
      transportCompleteFrames++;
    }

    if (observedCount >= authoritativeExpected) {
      fullyPopulatedFrames++;
    } else {
      partiallyPopulatedFrames++;
    }
  }

  // Count truly empty frames (frame numbers that exist in the span but have no data)
  const emptyFrames = globalMissingFrames;

  const strictEpochCoveragePercent =
    allFrameNumbers.length > 0
      ? Math.round((fullyPopulatedFrames / allFrameNumbers.length) * 1000) / 10
      : 100;
  const transportCoveragePercent =
    allFrameNumbers.length > 0
      ? Math.round((transportCompleteFrames / allFrameNumbers.length) * 1000) /
        10
      : 100;
  const syncCoveragePercent = strictEpochCoveragePercent;

  // -------------------------------------------------------------------------
  // 4. Per-sensor gap analysis (frame-number based, gateway 200Hz clock)
  // -------------------------------------------------------------------------
  // Gaps are ONLY detected when a sensor is missing from a gateway frame number
  // in the contiguous sequence. Timestamp jitter is irrelevant — the gateway's
  // frame counter is the single source of truth for synchronisation.
  //
  // In packet-local mode sensors alternate TDMA slots (e.g. sensor 1 gets
  // even frames, sensor 2 gets odd). We detect each sensor's natural stride
  // and only flag deviations from that cadence as gaps.
  // -------------------------------------------------------------------------
  const sensorReports: SensorReport[] = [];

  for (const sid of sensorIds) {
    const frameSet = sensorFrameSets.get(sid)!;
    const meta = sensorMeta.get(sid);
    const sensorFramesSorted = Array.from(frameSet).sort((a, b) => a - b);
    const sensorFirst = sensorFramesSorted[0];
    const sensorLast = sensorFramesSorted[sensorFramesSorted.length - 1];

    // All timing derived from gateway frame numbers
    const sensorFirstTimeMs = (sensorFirst - firstFrame) * framePeriodMs;
    const sensorLastTimeMs = (sensorLast - firstFrame) * framePeriodMs;

    // Compute this sensor's natural stride (median inter-frame delta).
    // In full-network mode stride = 1; in packet-local it may be 2+ if
    // sensors alternate TDMA slots.
    let stride = 1;
    if (sensorFramesSorted.length >= 3) {
      const deltas: number[] = [];
      for (let i = 1; i < sensorFramesSorted.length; i++) {
        deltas.push(sensorFramesSorted[i] - sensorFramesSorted[i - 1]);
      }
      deltas.sort((a, b) => a - b);
      stride = Math.max(1, deltas[Math.floor(deltas.length / 2)]);
    }

    const expectedSamples =
      stride > 0
        ? Math.floor((sensorLast - sensorFirst) / stride) + 1
        : sensorFramesSorted.length;

    // Find gaps: consecutive frame delta exceeds the sensor's expected stride
    const gaps: DataGap[] = [];
    for (let i = 0; i < sensorFramesSorted.length - 1; i++) {
      const currentFrame = sensorFramesSorted[i];
      const nextFrame = sensorFramesSorted[i + 1];
      if (nextFrame - currentFrame > stride) {
        // Number of missed sensor slots (not raw frame numbers)
        const missedSlots = Math.round((nextFrame - currentFrame) / stride) - 1;
        const gapDurationMs =
          (nextFrame - currentFrame - stride) * framePeriodMs;

        let severity: DataGap["severity"] = "minor";
        if (gapDurationMs > 100) severity = "critical";
        else if (gapDurationMs >= 30) severity = "moderate";

        gaps.push({
          sensorId: sid,
          segment: meta?.segment,
          startFrame: currentFrame,
          endFrame: nextFrame,
          startTimeMs: (currentFrame - firstFrame) * framePeriodMs,
          endTimeMs: (nextFrame - firstFrame) * framePeriodMs,
          gapLength: missedSlots,
          gapDurationMs,
          severity,
        });
      }
    }

    const missingFrames = Math.max(
      0,
      expectedSamples - sensorFramesSorted.length,
    );
    const coveragePercent =
      expectedSamples > 0
        ? Math.round((sensorFramesSorted.length / expectedSamples) * 1000) / 10
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
      totalSamples: sensorFramesSorted.length,
      expectedSamples,
      missingFrames,
      coveragePercent,
      gaps,
      longestGapFrames: longestGap?.gapLength ?? 0,
      longestGapMs: longestGap?.gapDurationMs ?? 0,
      meanGapFrames,
      firstFrame: sensorFirst,
      lastFrame: sensorLast,
      firstTimeMs: sensorFirstTimeMs,
      lastTimeMs: sensorLastTimeMs,
      estimatedSamplePeriodMs: framePeriodMs,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Overall quality scoring
  // -------------------------------------------------------------------------
  // Weighted score adapts to the transport contract.
  // Packet-local sessions should not be failed just because strict full-body
  // epochs are rare or absent on the wire.
  const worstSensorCoverage =
    sensorReports.length > 0
      ? Math.min(...sensorReports.map((s) => s.coveragePercent))
      : 100;

  const overallScore = Math.round(
    timelineCoveragePercent * 0.35 +
      (packetLocalMode
        ? transportCoveragePercent
        : strictEpochCoveragePercent) *
        0.35 +
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

  if (packetLocalMode) {
    notes.push(
      `Multi-node session (${packetExpectedCountMin}-${packetExpectedCountMax} sensors per node frame). Per-node transport integrity reported.`,
    );
  }

  if (globalMissingFrames > 0) {
    notes.push(
      `${globalMissingFrames.toLocaleString()} timeline gaps detected (${(100 - timelineCoveragePercent).toFixed(1)}% loss)`,
    );
  } else {
    notes.push("No timeline gaps — continuous transport sequence");
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
    notes.push(`${moderateGaps} moderate gap(s) (30-100ms)`);
  if (minorGaps > 0) notes.push(`${minorGaps} minor gap(s) (<30ms)`);

  if (transportCoveragePercent < 99) {
    notes.push(
      `Packet-local transport completeness: ${transportCoveragePercent}% of transport groups satisfied their advertised packet size`,
    );
  }

  if (strictEpochCoveragePercent < 90) {
    notes.push(
      `Full-array sync: ${strictEpochCoveragePercent}% of frame groups contained all ${sensorCount} session sensors`,
    );
  }

  return {
    sessionId,
    analyzedAt,
    totalFrames: frames.length,
    uniqueFrameNumbers: allFrameNumbers.length,
    firstFrame,
    lastFrame,
    sessionStartTimeMs,
    sessionEndTimeMs,
    expectedFrameSpan,
    globalMissingFrames,
    globalCoveragePercent,
    timelineCoveragePercent,
    estimatedSampleRateHz: estimatedRate,
    framePeriodMs,
    totalDurationMs,
    sensorReports,
    sensorCount,
    transportCompleteFrames,
    fullyPopulatedFrames,
    partiallyPopulatedFrames,
    emptyFrames,
    syncCoveragePercent,
    strictEpochCoveragePercent,
    transportCoveragePercent,
    packetLocalMode,
    packetExpectedCountMin,
    packetExpectedCountMax,
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
    sessionStartTimeMs: 0,
    sessionEndTimeMs: 0,
    expectedFrameSpan: 0,
    globalMissingFrames: 0,
    globalCoveragePercent: 0,
    timelineCoveragePercent: 0,
    estimatedSampleRateHz: 0,
    framePeriodMs: 0,
    totalDurationMs: 0,
    sensorReports: [],
    sensorCount: 0,
    transportCompleteFrames: 0,
    fullyPopulatedFrames: 0,
    partiallyPopulatedFrames: 0,
    emptyFrames: 0,
    syncCoveragePercent: 0,
    strictEpochCoveragePercent: 0,
    transportCoveragePercent: 0,
    packetLocalMode: false,
    packetExpectedCountMin: 0,
    packetExpectedCountMax: 0,
    overallGrade: "F",
    overallScore: 0,
    summaryNotes: ["No frames in session"],
  };
}

function getFrameTimeMs(frame: RecordedFrame): number {
  // Playback integrity should follow the gateway-aligned sync timeline that was
  // persisted into `timestamp` during recording. `systemTime` reflects recorder
  // arrival/persist jitter and will create false gaps for healthy packet-local
  // sessions if used as the primary analysis clock.
  if (typeof frame.timestamp === "number" && Number.isFinite(frame.timestamp)) {
    return frame.timestamp;
  }

  if (
    typeof frame.systemTime === "number" &&
    Number.isFinite(frame.systemTime)
  ) {
    return frame.systemTime;
  }

  if (
    typeof frame.timestampUs === "number" &&
    Number.isFinite(frame.timestampUs)
  ) {
    return frame.timestampUs / 1000;
  }

  return typeof frame.frameNumber === "number" &&
    Number.isFinite(frame.frameNumber)
    ? frame.frameNumber * 5
    : 0;
}

function estimateMedianSamplePeriodMs(
  timesMs: number[],
  fallbackMs: number,
): number {
  const deltas: number[] = [];
  for (let i = 1; i < timesMs.length; i++) {
    const delta = timesMs[i] - timesMs[i - 1];
    if (delta > 0) {
      deltas.push(delta);
    }
  }

  if (deltas.length === 0) {
    return fallbackMs;
  }

  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? fallbackMs;
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
