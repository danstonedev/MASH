/**
 * Temporal Synchronization - Fixing IMU Tearing
 * ==============================================
 *
 * "IMU Tearing" = Temporal Desynchronization Artifact
 *
 * When multi-sensor packets arrive at different times but are rendered
 * in the same frame, joints appear to "detach" or snap unnaturally.
 *
 * Example: User kicks at 400°/sec
 *   - Thigh packet arrives at t=0ms (leg back)
 *   - Tibia packet arrives at t=10ms (leg forward)
 *   - Render at t=5ms shows disconnected bones
 *
 * Solution: SLERP Interpolation
 *   - Buffer sensor data with timestamps
 *   - Interpolate ALL sensors to the same render timestamp
 *   - Use Spherical Linear Interpolation (SLERP) for smooth rotation
 *
 * @module temporalSync
 */

import * as THREE from "three";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Timestamped orientation sample
 */
export interface TimestampedQuaternion {
  quaternion: THREE.Quaternion;
  timestamp: number; // milliseconds
}

/**
 * Sensor data buffer for a single device
 */
export interface SensorBuffer {
  deviceId: string;
  samples: TimestampedQuaternion[];
  maxSize: number;
}

/**
 * Synchronized frame with all sensors at same timestamp
 */
export interface SynchronizedFrame {
  timestamp: number;
  quaternions: Map<string, THREE.Quaternion>;
  interpolated: Set<string>; // Which sensors were interpolated vs. exact match
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_BUFFER_SIZE = 10; // Keep last 10 samples per sensor
const MAX_INTERPOLATION_GAP_MS = 100; // Don't interpolate beyond 100ms gap
const STALE_DATA_THRESHOLD_MS = 200; // Consider data stale after 200ms

// ============================================================================
// TIMESTAMP JITTER SMOOTHING
// ============================================================================

/**
 * Smooths timestamp jitter using a moving average filter.
 *
 * Problem: BLE packet arrival times have ~5-15ms jitter due to:
 *   - Radio scheduling
 *   - OS task scheduling
 *   - GATT queue delays
 *
 * Solution: Apply exponential moving average to timestamp deltas
 * to produce smoother inter-frame intervals for integration.
 */
export class TimestampSmoother {
  private readonly alpha: number; // EMA smoothing factor (0 = full smooth, 1 = no smooth)
  private smoothedDelta: number = 0;
  private lastRawTimestamp: number = 0;
  private initialized: boolean = false;

  /**
   * Create a timestamp smoother.
   * @param targetDeltaMs Expected inter-frame interval (e.g., 10ms for 100Hz)
   * @param smoothFactor Smoothing factor 0-1 (default 0.3 = ~20ms effective window)
   */
  constructor(targetDeltaMs: number = 10, smoothFactor: number = 0.3) {
    this.alpha = Math.max(0.1, Math.min(1.0, smoothFactor));
    this.smoothedDelta = targetDeltaMs;
  }

  /**
   * Process a raw timestamp and return smoothed timestamp.
   * @param rawTimestamp Raw packet timestamp (ms)
   * @returns Smoothed timestamp (ms)
   */
  smooth(rawTimestamp: number): number {
    if (!this.initialized) {
      this.lastRawTimestamp = rawTimestamp;
      this.initialized = true;
      return rawTimestamp;
    }

    const rawDelta = rawTimestamp - this.lastRawTimestamp;
    this.lastRawTimestamp = rawTimestamp;

    // Ignore unreasonable deltas (likely clock wrap or missed packets)
    if (rawDelta <= 0 || rawDelta > 500) {
      return rawTimestamp;
    }

    // EMA: smoothed = alpha * raw + (1 - alpha) * previous
    this.smoothedDelta =
      this.alpha * rawDelta + (1 - this.alpha) * this.smoothedDelta;

    // Return smoothed timestamp based on previous smoothed + smoothed delta
    return rawTimestamp; // Note: actual smoothing is in the delta, not absolute time
  }

  /**
   * Get smoothed delta for integration (dt in seconds).
   * Use this instead of raw frame deltas for Madgwick/velocity integration.
   */
  getSmoothedDeltaSeconds(): number {
    return this.smoothedDelta / 1000.0;
  }

  /**
   * Reset the smoother state.
   */
  reset(): void {
    this.initialized = false;
    this.smoothedDelta = 10; // Default 100Hz
    this.lastRawTimestamp = 0;
  }
}

/** Singleton smoothers per device */
const smoothers = new Map<string, TimestampSmoother>();

/**
 * Get or create a timestamp smoother for a device.
 */
export function getTimestampSmoother(
  deviceId: string,
  targetHz: number = 100,
): TimestampSmoother {
  if (!smoothers.has(deviceId)) {
    smoothers.set(deviceId, new TimestampSmoother(1000 / targetHz));
  }
  return smoothers.get(deviceId)!;
}

// ============================================================================
// SENSOR BUFFER MANAGEMENT
// ============================================================================

/**
 * Create a new sensor buffer
 */
export function createSensorBuffer(
  deviceId: string,
  maxSize = DEFAULT_BUFFER_SIZE,
): SensorBuffer {
  return {
    deviceId,
    samples: [],
    maxSize,
  };
}

/**
 * Add a new sample to the buffer (ring buffer behavior)
 */
export function addSample(
  buffer: SensorBuffer,
  quaternion: THREE.Quaternion,
  timestamp: number,
): void {
  buffer.samples.push({
    quaternion: quaternion.clone(),
    timestamp,
  });

  // Maintain max size
  while (buffer.samples.length > buffer.maxSize) {
    buffer.samples.shift();
  }
}

/**
 * Get the latest sample from buffer
 */
export function getLatestSample(
  buffer: SensorBuffer,
): TimestampedQuaternion | null {
  if (buffer.samples.length === 0) return null;
  return buffer.samples[buffer.samples.length - 1];
}

// ============================================================================
// SLERP INTERPOLATION
// ============================================================================

/**
 * Interpolate quaternion at target timestamp using SLERP.
 *
 * Finds the two samples that bracket the target time and
 * spherically interpolates between them.
 *
 * @param buffer Sensor buffer with timestamped samples
 * @param targetTime Target timestamp for interpolation
 * @returns Interpolated quaternion or null if not possible
 */
export function interpolateAtTime(
  buffer: SensorBuffer,
  targetTime: number,
): { quaternion: THREE.Quaternion; exact: boolean } | null {
  const samples = buffer.samples;

  if (samples.length === 0) {
    return null;
  }

  // If only one sample, return it (can't interpolate)
  if (samples.length === 1) {
    const age = targetTime - samples[0].timestamp;
    if (age > STALE_DATA_THRESHOLD_MS) {
      return null; // Data too old
    }
    return { quaternion: samples[0].quaternion.clone(), exact: true };
  }

  // Find bracketing samples
  let before: TimestampedQuaternion | null = null;
  let after: TimestampedQuaternion | null = null;

  for (let i = 0; i < samples.length; i++) {
    if (samples[i].timestamp <= targetTime) {
      before = samples[i];
    }
    if (samples[i].timestamp >= targetTime && !after) {
      after = samples[i];
    }
  }

  // Handle edge cases
  if (!before && after) {
    // Target is before all samples, use earliest
    return { quaternion: after.quaternion.clone(), exact: false };
  }

  if (before && !after) {
    // Target is after all samples, check staleness
    const age = targetTime - before.timestamp;
    if (age > STALE_DATA_THRESHOLD_MS) {
      return null; // Data too old
    }
    return { quaternion: before.quaternion.clone(), exact: false };
  }

  if (!before || !after) {
    return null;
  }

  // Check for exact match
  if (before.timestamp === targetTime) {
    return { quaternion: before.quaternion.clone(), exact: true };
  }

  if (after.timestamp === targetTime) {
    return { quaternion: after.quaternion.clone(), exact: true };
  }

  // Check interpolation gap
  const gap = after.timestamp - before.timestamp;
  if (gap > MAX_INTERPOLATION_GAP_MS) {
    // Gap too large, return closest
    const closestToBefore = targetTime - before.timestamp;
    const closestToAfter = after.timestamp - targetTime;
    const closest = closestToBefore < closestToAfter ? before : after;
    return { quaternion: closest.quaternion.clone(), exact: false };
  }

  // SLERP interpolation
  const t = (targetTime - before.timestamp) / gap;
  const result = before.quaternion.clone().slerp(after.quaternion, t);

  return { quaternion: result, exact: false };
}

// ============================================================================
// MULTI-SENSOR SYNCHRONIZATION
// ============================================================================

/**
 * Synchronize multiple sensor buffers to a common timestamp.
 *
 * This is the core anti-tearing function. Call this before rendering
 * to ensure all bones are positioned at the same moment in time.
 *
 * @param buffers Map of device ID to sensor buffer
 * @param targetTime Target timestamp (typically render time or latest common time)
 * @returns Synchronized frame with all quaternions at same timestamp
 */
export function synchronizeAllSensors(
  buffers: Map<string, SensorBuffer>,
  targetTime?: number,
): SynchronizedFrame {
  // If no target time specified, use the latest time we have data for all sensors
  if (targetTime === undefined) {
    targetTime = findLatestCommonTime(buffers);
  }

  const result: SynchronizedFrame = {
    timestamp: targetTime,
    quaternions: new Map(),
    interpolated: new Set(),
  };

  for (const [deviceId, buffer] of buffers) {
    const interpolated = interpolateAtTime(buffer, targetTime);

    if (interpolated) {
      result.quaternions.set(deviceId, interpolated.quaternion);
      if (!interpolated.exact) {
        result.interpolated.add(deviceId);
      }
    }
  }

  return result;
}

/**
 * Find the latest timestamp where all sensors have data.
 */
export function findLatestCommonTime(
  buffers: Map<string, SensorBuffer>,
): number {
  let minLatest = Infinity;

  for (const buffer of buffers.values()) {
    const latest = getLatestSample(buffer);
    if (latest) {
      if (latest.timestamp < minLatest) {
        minLatest = latest.timestamp;
      }
    }
  }

  return minLatest === Infinity ? Date.now() : minLatest;
}

// ============================================================================
// TIMESTAMP DIAGNOSTICS
// ============================================================================

/**
 * Analyze temporal spread across sensors for debugging
 */
export function analyzeTemporalSpread(buffers: Map<string, SensorBuffer>): {
  maxSpread: number;
  spreads: Map<string, number>;
  recommendation: string;
} {
  const latestTimes = new Map<string, number>();
  let minTime = Infinity;
  let maxTime = 0;

  for (const [deviceId, buffer] of buffers) {
    const latest = getLatestSample(buffer);
    if (latest) {
      latestTimes.set(deviceId, latest.timestamp);
      minTime = Math.min(minTime, latest.timestamp);
      maxTime = Math.max(maxTime, latest.timestamp);
    }
  }

  const maxSpread = maxTime - minTime;
  const spreads = new Map<string, number>();

  for (const [deviceId, time] of latestTimes) {
    spreads.set(deviceId, time - minTime);
  }

  let recommendation: string;
  if (maxSpread < 5) {
    recommendation = "Excellent sync (<5ms)";
  } else if (maxSpread < 15) {
    recommendation = "Good sync, minor interpolation";
  } else if (maxSpread < 50) {
    recommendation = "Moderate desync, visible during fast motion";
  } else {
    recommendation = "Severe desync, expect joint tearing artifacts";
  }

  return { maxSpread, spreads, recommendation };
}

// ============================================================================
// RENDER LOOP INTEGRATION HELPER
// ============================================================================

/**
 * Singleton-style manager for temporal synchronization.
 * Integrate this into your render loop.
 */
export class TemporalSyncManager {
  private buffers: Map<string, SensorBuffer> = new Map();
  private renderTimestamp: number = 0;

  /**
   * Feed new sensor data into the sync system
   */
  updateSensor(
    deviceId: string,
    quaternion: THREE.Quaternion,
    timestamp: number,
  ): void {
    if (!this.buffers.has(deviceId)) {
      this.buffers.set(deviceId, createSensorBuffer(deviceId));
    }
    addSample(this.buffers.get(deviceId)!, quaternion, timestamp);
  }

  /**
   * Get synchronized quaternions for the current render frame
   */
  getSynchronized(renderTime?: number): SynchronizedFrame {
    this.renderTimestamp = renderTime ?? Date.now();
    return synchronizeAllSensors(this.buffers, this.renderTimestamp);
  }

  /**
   * Get sync quality diagnostics
   */
  getDiagnostics(): ReturnType<typeof analyzeTemporalSpread> {
    return analyzeTemporalSpread(this.buffers);
  }

  /**
   * Clear all buffers
   */
  reset(): void {
    this.buffers.clear();
  }
}

// Singleton instance
export const temporalSyncManager = new TemporalSyncManager();
