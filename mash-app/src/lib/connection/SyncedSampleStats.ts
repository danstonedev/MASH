/**
 * SyncedSampleStats - Track synchronized sample rate and CRC statistics
 *
 * This module tracks:
 * 1. ACTUAL sample rate - Based on individual samples with timestamps inside
 *    TDMA packets, not just packet arrival rate
 * 2. Sample completeness - Are all 4 samples arriving per packet?
 * 3. CRC failure statistics - Track packet corruption over time
 * 4. V3 delta compression statistics - Track keyframe vs delta ratio
 *
 * 200Hz ARCHITECTURE (v3.0):
 * - Nodes sample at 200Hz internally (ICM-20649 at 375Hz with 119Hz DLPF)
 * - Nodes batch 4 samples per TDMA packet (50Hz beacon rate)
 * - Gateway passes through all samples (no decimation)
 * - Each sample has its own microsecond timestamp from the firmware
 * - Max 20 sensors supported (72 KB/s << 100 KB/s ESP-NOW limit)
 *
 * WHAT WE MEASURE:
 * - Actual samples received per second (should be ~200 per sensor)
 * - Missing samples within packets (sampleCount < 4)
 * - Synced frames where ALL sensors have data
 * - V3 packet format stats (keyframe vs delta counts)
 * - Per-sensor Hz breakdown
 */

// ============================================================================
// SAMPLE TRACKING (Individual timestamps within packets)
// ============================================================================

/** Per-sensor Hz tracking for 200Hz verification
 *  Uses firmware timestamps (µs) for accurate Hz — immune to JS event loop jitter.
 */
interface PerSensorStats {
  /** Firmware timestamps (µs) collected in the current window */
  fwTimestamps: number[];
  /** Start of the current measurement window (performance.now) */
  windowStartJs: number;
  /** Calculated Hz from firmware timestamps */
  hz: number;
  /** Last time we received any data (performance.now, for staleness detection) */
  lastSeenJs: number;
}

interface SampleStats {
  // Count of individual samples received in current window
  sampleCount: number;
  // Count of TDMA packets received
  packetCount: number;
  // Track incomplete packets (fewer than expected samples)
  incompletePackets: number;
  // Window start time
  windowStart: number;
  // Calculated rates
  sampleHz: number;
  packetHz: number;
  // Last packet's sample count (for diagnostics)
  lastSampleCountInPacket: number;
  // Expected sensors (auto-detected)
  expectedSensorIds: Set<number>;
  lastSensorDetection: number;
  // Complete synced frames (all sensors present)
  syncedFrameCount: number;
  syncedHz: number;
  // Partial frames (some sensors present, some missing)
  partialFrameCount: number;
  partialHz: number;

  lastUpdate: number;
  // V3 Delta Stats (Phase 3)
  v3KeyframeCount: number;
  v3DeltaCount: number;
  v3PacketCount: number;
  // Per-sensor Hz tracking (200Hz verification)
  perSensorStats: Map<number, PerSensorStats>;
}

const stats: SampleStats = {
  sampleCount: 0,
  packetCount: 0,
  incompletePackets: 0,
  windowStart: performance.now(),
  sampleHz: 0,
  packetHz: 0,
  lastSampleCountInPacket: 0,
  expectedSensorIds: new Set(),
  lastSensorDetection: 0,
  syncedFrameCount: 0,
  syncedHz: 0,
  partialFrameCount: 0,
  partialHz: 0,
  lastUpdate: 0,
  v3KeyframeCount: 0,
  v3DeltaCount: 0,
  v3PacketCount: 0,
  perSensorStats: new Map(),
};

// Sliding window for Hz calculation (2 seconds)
const WINDOW_MS = 2000;
// Smoothing factor for exponential moving average (0.1 = smooth, 0.5 = responsive)
const EMA_ALPHA = 0.15;

// ============================================================================
// PIPELINE THRESHOLDS — single source of truth for staleness detection.
// Used by: getSensorHealthSnapshot(), useNetworkStore, any health UI.
// ============================================================================

/** No data for this long → sensor is "stale" / "warning" */
export const STALE_THRESHOLD_MS = 1500;

/** No data for this long → sensor is "offline" */
export const OFFLINE_THRESHOLD_MS = 5000;

/** No data for this long → prune node from topology entirely */
export const PRUNE_THRESHOLD_MS = 10000;
// Auto-detect sensor set from traffic every 5 seconds
const SENSOR_DETECTION_INTERVAL_MS = 5000;
// Track which sensors we've seen in current detection window
const recentSensorIds = new Set<number>();

// Per-packet timing for real-time Hz calculation
let lastPacketTime = 0;
let instantHz = 0;

// Per-packet EMA timing for synced/partial frame rates
let lastSyncedFrameTime = 0;
let lastPartialFrameTime = 0;

// Timing baseline for relative latency tracking
let firmwareBaselineUs: number | null = null;
let performanceBaselineMs: number | null = null;

// ============================================================================
// FRAME SEQUENCE GAP DETECTION (#1)
// ============================================================================
// Tracks consecutive frameNumber from 0x25 SyncFrames to detect silent drops.
// A gap of N means N frames were lost (USB overflow, flow control, etc.)
// ============================================================================
let _lastFrameNumber: number | null = null;
let _droppedFrameCount = 0;
let _droppedFrameGaps: Array<{ at: number; gap: number; time: number }> = [];
const MAX_GAP_HISTORY = 100;

// ============================================================================
// PIPELINE LOSS ACCOUNTING (#3)
// ============================================================================
// Aggregates all drop sources into a single "pipeline loss" metric.
// External modules call reportPipelineDrop() to contribute.
// ============================================================================
interface PipelineLossStats {
  /** Frames dropped due to sequence gaps (frame gap detection) */
  frameGapDrops: number;
  /** Bytes lost to ring-buffer overflow in serial layer */
  serialOverflowBytes: number;
  /** Frames skipped during serial resync (framing errors) */
  serialResyncEvents: number;
  /** Frames rejected by CRC check */
  crcRejectCount: number;
  /** Sensors rejected by parser (quatMag + invalid + untrusted + corruptFrame) */
  parserRejectCount: number;
  /** Total successfully delivered frames */
  deliveredFrames: number;
}

const pipelineLoss: PipelineLossStats = {
  frameGapDrops: 0,
  serialOverflowBytes: 0,
  serialResyncEvents: 0,
  crcRejectCount: 0,
  parserRejectCount: 0,
  deliveredFrames: 0,
};

/**
 * Report serial-layer loss events (called from SerialConnection).
 */
export function reportSerialLoss(
  overflowBytes: number,
  resyncEvents: number,
): void {
  pipelineLoss.serialOverflowBytes += overflowBytes;
  pipelineLoss.serialResyncEvents += resyncEvents;
}

/**
 * Report parser-level rejections (called from IMUParser).
 */
export function reportParserRejects(count: number): void {
  pipelineLoss.parserRejectCount += count;
}

/**
 * Get pipeline loss summary for diagnostic display.
 */
export function getPipelineLoss(): PipelineLossStats & {
  /** Estimated loss percentage (frame-level) */
  lossPercent: number;
  /** Frame gap details (last N gaps) */
  recentGaps: Array<{ at: number; gap: number; time: number }>;
} {
  const totalAttempted =
    pipelineLoss.deliveredFrames +
    pipelineLoss.frameGapDrops +
    pipelineLoss.crcRejectCount;
  const lossPercent =
    totalAttempted > 0
      ? ((totalAttempted - pipelineLoss.deliveredFrames) / totalAttempted) * 100
      : 0;

  return {
    ...pipelineLoss,
    lossPercent,
    recentGaps: [..._droppedFrameGaps],
  };
}

/**
 * Reset pipeline loss counters.
 */
function resetPipelineLoss(): void {
  pipelineLoss.frameGapDrops = 0;
  pipelineLoss.serialOverflowBytes = 0;
  pipelineLoss.serialResyncEvents = 0;
  pipelineLoss.crcRejectCount = 0;
  pipelineLoss.parserRejectCount = 0;
  pipelineLoss.deliveredFrames = 0;
  _lastFrameNumber = null;
  _droppedFrameCount = 0;
  _droppedFrameGaps = [];
}

// ============================================================================
// EVENT SUBSCRIPTIONS (Diagnostics)
// ============================================================================

export interface SyncedSamplesEvent {
  now: number; // performance.now()
  sensorIds: number[];
  sampleCountInPacket: number;
  /** Sequence frame number from the gateway. Used for gap detection. */
  frameNumber?: number;
  /** Firmware timestamp (µs) from the gateway-synchronized clock. Used by
   *  StreamAnalyzer for jitter analysis based on true source timing. */
  firmwareTimestampUs?: number;
  /** Estimated relative system latency in milliseconds.
   *  Calculated as the drift between firmware clock and performance.now()
   *  relative to the first received packet. */
  latencyMs?: number;
}

type SyncedSamplesListener = (evt: SyncedSamplesEvent) => void;

const syncedSamplesListeners = new Set<SyncedSamplesListener>();

/**
 * Subscribe to per-packet synced sample reports.
 * Used by diagnostic tooling (e.g., StreamAnalyzer) to capture real packet timing.
 */
export function subscribeSyncedSamples(
  listener: SyncedSamplesListener,
): () => void {
  syncedSamplesListeners.add(listener);
  return () => syncedSamplesListeners.delete(listener);
}

/**
 * Report samples received from a TDMA packet.
 * Called from IMUParser AFTER parsing all samples in a 0x23, 0x24 or 0x25 packet.
 *
 * @param sensorIds - Array of sensor IDs that had data in this packet
 * @param sampleCountInPacket - Number of samples per sensor in this packet
 * @param frameNumber - Sequence frame number from the gateway (0x25 frames only)
 * @param timestamps - Optional array of firmware timestamps (microseconds)
 */
export function reportSyncedSamples(
  sensorIds: number[],
  sampleCountInPacket: number,
  frameNumber?: number,
  timestamps?: number[],
): void {
  const now = performance.now();

  // ── Frame sequence gap detection ──────────────────────────────────────────
  if (frameNumber !== undefined) {
    pipelineLoss.deliveredFrames++;
    if (_lastFrameNumber !== null) {
      // Frame numbers are uint32, handle rollover at 2^32
      let expectedNext = (_lastFrameNumber + 1) >>> 0; // unsigned wrap
      if (frameNumber !== expectedNext) {
        let gap = (frameNumber - _lastFrameNumber) >>> 0; // unsigned distance
        // Ignore huge gaps (likely a firmware restart, not packet loss)
        if (gap > 0 && gap < 1000) {
          const missed = gap - 1; // gap=2 means 1 frame was skipped
          _droppedFrameCount += missed;
          pipelineLoss.frameGapDrops += missed;
          _droppedFrameGaps.push({ at: frameNumber, gap: missed, time: now });
          if (_droppedFrameGaps.length > MAX_GAP_HISTORY) {
            _droppedFrameGaps.shift();
          }
        }
      }
    }
    _lastFrameNumber = frameNumber;
  }

  // Calculate instantaneous Hz from packet timing (for EMA smoothing)
  // BUT: filter out unrealistic spikes from bursty BLE notifications
  if (lastPacketTime > 0) {
    const deltaMs = now - lastPacketTime;
    // Only update Hz if deltaMs is realistic (> 1ms to filter BLE burst processing)
    // At 200Hz, typical inter-packet time is 5ms - allow down to 1ms for jitter
    if (deltaMs > 1 && deltaMs < 500) {
      // Instant Hz = samples in this packet / time since last packet
      const samplesThisPacket = sampleCountInPacket * sensorIds.length;
      instantHz = (samplesThisPacket / deltaMs) * 1000;

      // Apply EMA smoothing to overall sample rate
      if (stats.sampleHz === 0) {
        stats.sampleHz = instantHz; // Initialize
      } else {
        stats.sampleHz =
          EMA_ALPHA * instantHz + (1 - EMA_ALPHA) * stats.sampleHz;
      }

      // Apply EMA to packet rate
      const instantPacketHz = (1 / deltaMs) * 1000;
      if (stats.packetHz === 0) {
        stats.packetHz = instantPacketHz;
      } else {
        stats.packetHz =
          EMA_ALPHA * instantPacketHz + (1 - EMA_ALPHA) * stats.packetHz;
      }
    }
  }
  lastPacketTime = now;

  // Reset window counters periodically (for totals, not Hz calculation)
  if (now - stats.windowStart > WINDOW_MS) {
    // Reset counters
    stats.sampleCount = 0;
    stats.packetCount = 0;
    stats.incompletePackets = 0;
    stats.syncedFrameCount = 0;
    stats.partialFrameCount = 0;
    stats.windowStart = now;
  }

  // Decay synced/partial Hz if no frames seen recently (stale detection)
  if (lastSyncedFrameTime > 0 && now - lastSyncedFrameTime > 500) {
    stats.syncedHz = stats.syncedHz * 0.9; // Gentle decay
    if (stats.syncedHz < 0.5) stats.syncedHz = 0;
  }
  if (lastPartialFrameTime > 0 && now - lastPartialFrameTime > 500) {
    stats.partialHz = stats.partialHz * 0.9;
    if (stats.partialHz < 0.5) stats.partialHz = 0;
  }

  // Still track totals for the window (for debugging)
  const actualSamples = sampleCountInPacket * sensorIds.length;
  stats.sampleCount += actualSamples;
  stats.packetCount++;
  stats.lastSampleCountInPacket = sampleCountInPacket;

  // Track per-sensor Hz using FIRMWARE TIMESTAMPS (ground truth).
  // The firmware clock runs at exactly 200Hz (5000µs intervals) and is
  // immune to USB serial buffering, JS event loop jitter, and BLE burst
  // delivery that made the old JS-timing approach undercount.
  const fwTs = timestamps && timestamps.length > 0 ? timestamps[0] : undefined;

  for (const sensorId of sensorIds) {
    let sensorStats = stats.perSensorStats.get(sensorId);
    if (!sensorStats) {
      sensorStats = {
        fwTimestamps: [],
        windowStartJs: now,
        hz: 0,
        lastSeenJs: now,
      };
      stats.perSensorStats.set(sensorId, sensorStats);
    }

    sensorStats.lastSeenJs = now;

    // Collect firmware timestamp for Hz calculation
    if (fwTs !== undefined) {
      sensorStats.fwTimestamps.push(fwTs);
    }

    // Every WINDOW_MS, calculate Hz from firmware timestamps
    const elapsedJs = now - sensorStats.windowStartJs;
    if (elapsedJs >= WINDOW_MS) {
      const ts = sensorStats.fwTimestamps;
      if (ts.length >= 2) {
        // Sort to handle any out-of-order delivery
        ts.sort((a, b) => a - b);
        // Firmware time span in µs (handle uint32 rollover)
        let spanUs = ts[ts.length - 1] - ts[0];
        if (spanUs < 0) spanUs += 4294967296; // uint32 rollover
        if (spanUs > 0) {
          // Hz = (number of intervals) / (time span in seconds)
          // N timestamps = N-1 intervals, but we want samples/sec
          // so: N samples over spanUs microseconds
          sensorStats.hz = ts.length / (spanUs / 1_000_000);
        }
      } else if (ts.length === 1) {
        // Only one sample in window — use JS timing as fallback
        // (this only happens during startup)
        sensorStats.hz = 1000 / elapsedJs;
      } else {
        // No firmware timestamps available — decay
        sensorStats.hz = sensorStats.hz * 0.5;
      }
      // Reset window
      sensorStats.fwTimestamps = [];
      sensorStats.windowStartJs = now;
    }
  }

  // Track incomplete packets (expected 4 samples per packet for 200Hz)
  if (sampleCountInPacket < 4) {
    stats.incompletePackets++;
  }

  // Update sensor detection
  for (const id of sensorIds) {
    // if (id === 0) continue; // ALLOW ID 0
    recentSensorIds.add(id);
  }

  // Periodically update expected sensor set from traffic
  if (
    now - stats.lastSensorDetection > SENSOR_DETECTION_INTERVAL_MS ||
    stats.expectedSensorIds.size === 0
  ) {
    if (recentSensorIds.size > 0) {
      stats.expectedSensorIds = new Set(recentSensorIds);
      stats.lastSensorDetection = now;
      recentSensorIds.clear();
    }
  }

  // Check if this is a "synced" frame (all expected sensors present)
  const isComplete =
    stats.expectedSensorIds.size > 0 &&
    sensorIds.length >= stats.expectedSensorIds.size &&
    [...stats.expectedSensorIds].every((id) => sensorIds.includes(id));

  if (isComplete) {
    stats.syncedFrameCount++;
    // Per-packet EMA for syncedHz (same approach as packetHz)
    if (lastSyncedFrameTime > 0) {
      const syncDelta = now - lastSyncedFrameTime;
      if (syncDelta > 1 && syncDelta < 500) {
        const instantSyncedHz = (1 / syncDelta) * 1000;
        if (stats.syncedHz === 0) {
          stats.syncedHz = instantSyncedHz;
        } else {
          stats.syncedHz =
            EMA_ALPHA * instantSyncedHz + (1 - EMA_ALPHA) * stats.syncedHz;
        }
      }
    }
    lastSyncedFrameTime = now;
  } else if (sensorIds.length > 0) {
    // Partial frame: We have data, but not from ALL expected sensors
    stats.partialFrameCount++;
    // Per-packet EMA for partialHz
    if (lastPartialFrameTime > 0) {
      const partialDelta = now - lastPartialFrameTime;
      if (partialDelta > 1 && partialDelta < 500) {
        const instantPartialHz = (1 / partialDelta) * 1000;
        if (stats.partialHz === 0) {
          stats.partialHz = instantPartialHz;
        } else {
          stats.partialHz =
            EMA_ALPHA * instantPartialHz + (1 - EMA_ALPHA) * stats.partialHz;
        }
      }
    }
    lastPartialFrameTime = now;
  }

  stats.lastUpdate = now;

  // Notify diagnostics listeners (best-effort; never break streaming)
  if (syncedSamplesListeners.size > 0) {
    const cleanSensorIds = sensorIds; // Allow ID 0

    const fwTimestampUs =
      timestamps && timestamps.length > 0 ? timestamps[0] : undefined;

    // Calculate relative system latency
    let latencyMs: number | undefined;
    if (fwTimestampUs !== undefined) {
      if (firmwareBaselineUs === null || performanceBaselineMs === null) {
        // Initialize baseline with first packet
        firmwareBaselineUs = fwTimestampUs;
        performanceBaselineMs = now;
        latencyMs = 0;
      } else {
        // Calculate expected performance.now() based on firmware clock progress
        let deltaFwUs = fwTimestampUs - firmwareBaselineUs;

        // Handle uint32 rollover (4294967295µs ≈ 71.5 mins)
        if (deltaFwUs < -2000000000) {
          deltaFwUs += 4294967296;
        }

        const expectedNowByFw = performanceBaselineMs + deltaFwUs / 1000;
        latencyMs = now - expectedNowByFw;

        // If latency is negative (packet arrived "too early" due to drift/jitter),
        // adjust baseline forward to keep latency non-negative.
        if (latencyMs < 0) {
          firmwareBaselineUs = fwTimestampUs;
          performanceBaselineMs = now;
          latencyMs = 0;
        }
      }
    }

    for (const listener of syncedSamplesListeners) {
      try {
        listener({
          now,
          sensorIds: cleanSensorIds,
          sampleCountInPacket,
          frameNumber,
          firmwareTimestampUs: fwTimestampUs,
          latencyMs,
        });
      } catch (err) {
        console.warn("[SyncedSampleStats] listener error", err);
      }
    }
  }
}

/**
 * Get the actual sample rate (individual samples per second).
 * This is the rate at which individual sensor samples are received,
 * accounting for the 4 samples batched per TDMA packet.
 */
export function getSyncedSampleRate(): number {
  // If no recent updates, return 0
  if (performance.now() - stats.lastUpdate > 2000) {
    return 0;
  }
  return stats.sampleHz;
}

/**
 * Get the synced frame rate (packets where ALL sensors present).
 */
export function getSyncedFrameRate(): number {
  if (performance.now() - stats.lastUpdate > 2000) {
    return 0;
  }
  return stats.syncedHz;
}

/**
 * Get the partial frame rate (packets where SOME sensors missing).
 */
export function getPartialFrameRate(): number {
  if (performance.now() - stats.lastUpdate > 2000) {
    return 0;
  }
  return stats.partialHz;
}

/**
 * Get the raw packet rate (TDMA packets per second, before × sampleCount).
 */
export function getPacketRate(): number {
  if (performance.now() - stats.lastUpdate > 2000) {
    return 0;
  }
  return stats.packetHz;
}

/**
 * Get expected sensor count for complete frames.
 */
export function getExpectedSensorCount(): number {
  return stats.expectedSensorIds.size;
}

/**
 * Get list of expected sensor IDs.
 */
export function getExpectedSensorIds(): number[] {
  return [...stats.expectedSensorIds].sort((a, b) => a - b);
}

/**
 * Get comprehensive sample stats for debugging.
 */
export function getSampleStats(): {
  sampleHz: number;
  packetHz: number;
  syncedHz: number;
  lastSampleCountInPacket: number;
  incompletePackets: number;
  expectedSensorCount: number;
  v3KeyframeCount: number;
  v3DeltaCount: number;
  v3PacketCount: number;
  v3CompressionRatio: number;
} {
  // Calculate compression ratio: (keyframes + deltas) / total if all were keyframes
  const totalV3Samples = stats.v3KeyframeCount + stats.v3DeltaCount;
  const v3CompressionRatio =
    totalV3Samples > 0
      ? (stats.v3KeyframeCount * 25 + stats.v3DeltaCount * 16) /
        (totalV3Samples * 25)
      : 1.0;

  return {
    sampleHz: stats.sampleHz,
    packetHz: stats.packetHz,
    syncedHz: stats.syncedHz,
    lastSampleCountInPacket: stats.lastSampleCountInPacket,
    incompletePackets: stats.incompletePackets,
    expectedSensorCount: stats.expectedSensorIds.size,
    v3KeyframeCount: stats.v3KeyframeCount,
    v3DeltaCount: stats.v3DeltaCount,
    v3PacketCount: stats.v3PacketCount,
    v3CompressionRatio,
  };
}

/**
 * Report V3 delta packet statistics.
 * Called from IMUParser when processing 0x24 V3 packets.
 *
 * @param keyframeCount - Number of keyframe (absolute) samples in this packet
 * @param deltaCount - Number of delta-compressed samples in this packet
 */
export function reportV3Packet(
  keyframeCount: number,
  deltaCount: number,
): void {
  stats.v3PacketCount++;
  stats.v3KeyframeCount += keyframeCount;
  stats.v3DeltaCount += deltaCount;
}

/**
 * Get per-sensor Hz stats for 200Hz verification.
 * Returns a map of sensorId -> Hz rate.
 */
export function getPerSensorHz(): Map<number, number> {
  const result = new Map<number, number>();
  for (const [sensorId, sensorStats] of stats.perSensorStats) {
    result.set(sensorId, sensorStats.hz);
  }
  return result;
}

/**
 * Get per-sensor Hz as a sorted array for display.
 * Returns array of { sensorId, hz } sorted by sensorId.
 */
export function getPerSensorHzArray(): Array<{ sensorId: number; hz: number }> {
  const now = performance.now();
  return [...stats.perSensorStats.entries()]
    .map(([sensorId, s]) => {
      // Decay Hz for sensors that haven't sent data recently
      const staleness = now - s.lastSeenJs;
      let hz = s.hz;
      if (staleness > 1000) {
        // Sensor went silent — decay to zero over 2 seconds
        const decayFactor = Math.pow(0.5, (staleness - 1000) / 1000);
        hz = s.hz * decayFactor;
        if (hz < 0.5) hz = 0;
      }
      return { sensorId, hz };
    })
    .sort((a, b) => a.sensorId - b.sensorId);
}

/**
 * Check if all sensors are achieving target Hz (within tolerance).
 * @param targetHz - Expected Hz (default 200)
 * @param tolerancePercent - Acceptable deviation (default 10%)
 */
export function isAchieving200Hz(
  targetHz = 200,
  tolerancePercent = 10,
): boolean {
  if (stats.perSensorStats.size === 0) return false;

  const minHz = targetHz * (1 - tolerancePercent / 100);
  for (const [, sensorStats] of stats.perSensorStats) {
    if (sensorStats.hz < minHz) return false;
  }
  return true;
}

// ============================================================================
// INTER-SENSOR TIMING COHERENCE
// Detects when individual sensors diverge from the group rate, indicating
// firmware issues, wireless drop-outs, or multiplexer failures.
// ============================================================================

export interface TimingCoherenceResult {
  /** Mean Hz across all active sensors */
  meanHz: number;
  /** Standard deviation of per-sensor Hz */
  stddevHz: number;
  /** Coefficient of variation (stddev/mean) — >0.15 is suspicious, >0.30 is failure */
  cv: number;
  /** Sensors flagged as outliers (Hz differs from mean by >30%) */
  outliers: Array<{ sensorId: number; hz: number; deviationPct: number }>;
  /** Number of active sensors in the calculation */
  sensorCount: number;
}

/**
 * Assess inter-sensor timing coherence.
 * Returns statistics about Hz rate consistency across all streaming sensors.
 * Call periodically (e.g., every 2-5 seconds) for monitoring.
 */
export function getTimingCoherence(): TimingCoherenceResult {
  const hzArray = getPerSensorHzArray().filter((s) => s.hz > 1); // Only active sensors
  const n = hzArray.length;

  if (n < 2) {
    return {
      meanHz: n === 1 ? hzArray[0].hz : 0,
      stddevHz: 0,
      cv: 0,
      outliers: [],
      sensorCount: n,
    };
  }

  const sum = hzArray.reduce((acc, s) => acc + s.hz, 0);
  const meanHz = sum / n;

  const variance =
    hzArray.reduce((acc, s) => acc + (s.hz - meanHz) ** 2, 0) / n;
  const stddevHz = Math.sqrt(variance);
  const cv = meanHz > 0 ? stddevHz / meanHz : 0;

  const outliers: TimingCoherenceResult["outliers"] = [];
  for (const s of hzArray) {
    const deviationPct = (Math.abs(s.hz - meanHz) / meanHz) * 100;
    if (deviationPct > 30) {
      outliers.push({ sensorId: s.sensorId, hz: s.hz, deviationPct });
    }
  }

  return { meanHz, stddevHz, cv, outliers, sensorCount: n };
}

/**
 * Reset synced stats (for testing or reconnection).
 */
export function resetSyncedStats(): void {
  stats.sampleCount = 0;
  stats.packetCount = 0;
  stats.incompletePackets = 0;
  stats.windowStart = performance.now();
  stats.sampleHz = 0;
  stats.packetHz = 0;
  stats.syncedFrameCount = 0;
  stats.syncedHz = 0;
  stats.expectedSensorIds.clear();
  stats.lastSensorDetection = 0;
  stats.lastUpdate = 0;
  stats.v3KeyframeCount = 0;
  stats.v3DeltaCount = 0;
  stats.v3PacketCount = 0;
  stats.perSensorStats.clear();
  // Reset EMA and baseline state
  lastPacketTime = 0;
  instantHz = 0;
  lastSyncedFrameTime = 0;
  lastPartialFrameTime = 0;
  firmwareBaselineUs = null;
  performanceBaselineMs = null;
  recentSensorIds.clear();
}

// ============================================================================
// CRC STATISTICS TRACKING
// ============================================================================

interface CRCStats {
  // Rolling window of pass/fail events
  events: Array<{ time: number; passed: boolean }>;
  // Summary stats
  totalPassed: number;
  totalFailed: number;
  // Per-second history for charting (last 60 seconds)
  history: Array<{
    time: number;
    passed: number;
    failed: number;
    rate: number;
  }>;
  lastHistoryUpdate: number;
}

const crcStats: CRCStats = {
  events: [],
  totalPassed: 0,
  totalFailed: 0,
  history: [],
  lastHistoryUpdate: 0,
};

// Keep last 10 seconds of events for real-time rate calculation
const CRC_EVENT_WINDOW_MS = 10000;
// Update history every second
const CRC_HISTORY_INTERVAL_MS = 1000;
// Keep 60 seconds of history for chart
const CRC_HISTORY_LENGTH = 60;

/**
 * Report a CRC check result.
 */
export function reportCRCResult(passed: boolean): void {
  const now = performance.now();

  // Add event
  crcStats.events.push({ time: now, passed });
  if (passed) {
    crcStats.totalPassed++;
  } else {
    crcStats.totalFailed++;
    pipelineLoss.crcRejectCount++;
  }

  // Trim old events
  const cutoff = now - CRC_EVENT_WINDOW_MS;
  crcStats.events = crcStats.events.filter((e) => e.time >= cutoff);

  // Update history periodically
  if (now - crcStats.lastHistoryUpdate >= CRC_HISTORY_INTERVAL_MS) {
    updateCRCHistory(now);
  }
}

function updateCRCHistory(now: number): void {
  // Count passes and fails in current window
  const windowPassed = crcStats.events.filter((e) => e.passed).length;
  const windowFailed = crcStats.events.filter((e) => !e.passed).length;
  const total = windowPassed + windowFailed;
  const failRate = total > 0 ? (windowFailed / total) * 100 : 0;

  crcStats.history.push({
    time: now,
    passed: windowPassed,
    failed: windowFailed,
    rate: failRate,
  });

  // Trim history to last 60 entries
  if (crcStats.history.length > CRC_HISTORY_LENGTH) {
    crcStats.history = crcStats.history.slice(-CRC_HISTORY_LENGTH);
  }

  crcStats.lastHistoryUpdate = now;
}

/**
 * Get current CRC failure rate (percentage).
 */
export function getCRCFailRate(): number {
  const total = crcStats.totalPassed + crcStats.totalFailed;
  if (total === 0) return 0;
  return (crcStats.totalFailed / total) * 100;
}

/**
 * Get current window CRC stats (last 10 seconds).
 */
export function getCRCWindowStats(): {
  passed: number;
  failed: number;
  rate: number;
} {
  const windowPassed = crcStats.events.filter((e) => e.passed).length;
  const windowFailed = crcStats.events.filter((e) => !e.passed).length;
  const total = windowPassed + windowFailed;
  return {
    passed: windowPassed,
    failed: windowFailed,
    rate: total > 0 ? (windowFailed / total) * 100 : 0,
  };
}

/**
 * Get CRC history for charting.
 */
export function getCRCHistory(): Array<{
  time: number;
  passed: number;
  failed: number;
  rate: number;
}> {
  return [...crcStats.history];
}

/**
 * Get total CRC stats.
 */
export function getCRCTotals(): { passed: number; failed: number } {
  return {
    passed: crcStats.totalPassed,
    failed: crcStats.totalFailed,
  };
}

/**
 * Reset CRC stats.
 */
export function resetCRCStats(): void {
  crcStats.events = [];
  crcStats.totalPassed = 0;
  crcStats.totalFailed = 0;
  crcStats.history = [];
  crcStats.lastHistoryUpdate = 0;
}

// ============================================================================
// COMBINED RESET
// ============================================================================

export function resetAllStats(): void {
  resetSyncedStats();
  resetCRCStats();
  resetPipelineLoss();
}

// ============================================================================
// SENSOR HEALTH STATUS
// Derives streaming/stale/offline status from perSensorStats already tracked.
// Replaces the standalone SensorHealthTracker module entirely.
// ============================================================================

export type SensorStreamStatus = "streaming" | "stale" | "offline";

export interface SensorHealth {
  sensorId: number;
  status: SensorStreamStatus;
  hz: number;
  lastSeenMs: number;
}

/**
 * Get current health snapshot for all known sensors.
 * Derives status from perSensorStats.lastSeenJs and pipelineThresholds.
 */
export function getSensorHealthSnapshot(): SensorHealth[] {
  const now = performance.now();
  const result: SensorHealth[] = [];

  for (const [sensorId, sensorStats] of stats.perSensorStats) {
    const age = now - sensorStats.lastSeenJs;
    let status: SensorStreamStatus;
    if (age > OFFLINE_THRESHOLD_MS) {
      status = "offline";
    } else if (age > STALE_THRESHOLD_MS) {
      status = "stale";
    } else {
      status = "streaming";
    }
    result.push({
      sensorId,
      status,
      hz: sensorStats.hz,
      lastSeenMs: sensorStats.lastSeenJs,
    });
  }

  return result.sort((a, b) => a.sensorId - b.sensorId);
}

/**
 * Reset sensor health tracking (clears all perSensorStats).
 */
export function resetSensorHealth(): void {
  stats.perSensorStats.clear();
}

// DEBUG: Expose to window
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__syncedSampleStats = {
    getSyncedSampleRate,
    getSyncedFrameRate,
    getPacketRate,
    getSampleStats,
    getExpectedSensorCount,
    getExpectedSensorIds,
    getPerSensorHz,
    getPerSensorHzArray,
    isAchieving200Hz,
    getCRCFailRate,
    getCRCWindowStats,
    getCRCHistory,
    getCRCTotals,
    resetAllStats,
    getPipelineLoss,
    getTimingCoherence,
  };
}
