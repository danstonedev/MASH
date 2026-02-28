/**
 * LiveGapFill.ts - Real-time gap detection and interpolation for live IMU pipeline
 *
 * OPP-3: Integrates into the live data pipeline (useDeviceStore.onData callback)
 * to detect frame number gaps and fill them with slerp-interpolated frames.
 *
 * Unlike GapFill.ts (offline, batch processing of recorded sessions), this module
 * operates on individual packets as they arrive, maintaining per-sensor state to
 * detect and fill gaps in real-time.
 *
 * Strategy:
 * - Track last seen frame number per sensor
 * - When a gap of 1-N frames is detected (frameNumber jumped), generate
 *   interpolated frames using slerp for quaternions and linear for accel/gyro
 * - Max fill gap: 20 frames (100ms at 200Hz) — beyond this, treat as reconnect
 * - Mark filled frames with __filled: true for downstream consumers
 *
 * Performance: O(1) per packet (plus O(gap_size) when filling)
 * Memory: ~200 bytes per sensor (prev packet + frame counter)
 */

import type { IMUDataPacket } from "../lib/ble/DeviceInterface";

// ============================================================================
// Configuration
// ============================================================================

/** Maximum frames to interpolate (100ms at 200Hz). Beyond this = reconnect. */
const MAX_FILL_GAP_FRAMES = 20;

/** Frame period in seconds at 200Hz */
const FRAME_PERIOD_SEC = 1 / 200;

/** Frame period in microseconds at 200Hz */
const FRAME_PERIOD_US = 5000;

// ============================================================================
// Types
// ============================================================================

/** IMUDataPacket with additional live gap-fill metadata */
export interface LiveFilledPacket extends IMUDataPacket {
  /** True if this packet was interpolated (not from hardware) */
  __filled?: boolean;
  /** Original gap size that triggered this interpolation */
  __gapSize?: number;
}

/** Per-sensor tracking state */
interface SensorState {
  lastFrameNumber: number;
  lastPacket: IMUDataPacket;
}

// ============================================================================
// Statistics
// ============================================================================
export interface LiveGapFillStats {
  totalGapsDetected: number;
  totalFramesFilled: number;
  largestGap: number;
  gapsSkipped: number; // Gaps too large to fill
}

// ============================================================================
// Quaternion SLERP (simplified for real-time)
// ============================================================================

function slerp(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  // Compute dot product
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

  // If dot is negative, negate one quaternion to take shortest path
  const bAdj: [number, number, number, number] =
    dot < 0 ? [-b[0], -b[1], -b[2], -b[3]] : [...b];
  if (dot < 0) dot = -dot;

  // If quaternions are very close, use linear interpolation
  if (dot > 0.9995) {
    return [
      a[0] + t * (bAdj[0] - a[0]),
      a[1] + t * (bAdj[1] - a[1]),
      a[2] + t * (bAdj[2] - a[2]),
      a[3] + t * (bAdj[3] - a[3]),
    ];
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;

  return [
    wa * a[0] + wb * bAdj[0],
    wa * a[1] + wb * bAdj[1],
    wa * a[2] + wb * bAdj[2],
    wa * a[3] + wb * bAdj[3],
  ];
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
    a[2] + t * (b[2] - a[2]),
  ];
}

// ============================================================================
// LiveGapFill Class
// ============================================================================

export class LiveGapFill {
  private sensorStates = new Map<number, SensorState>();
  private _enabled = true;
  private _stats: LiveGapFillStats = {
    totalGapsDetected: 0,
    totalFramesFilled: 0,
    largestGap: 0,
    gapsSkipped: 0,
  };

  /** Enable/disable live gap filling */
  set enabled(value: boolean) {
    this._enabled = value;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Get statistics */
  get stats(): Readonly<LiveGapFillStats> {
    return this._stats;
  }

  /** Reset all state (on disconnect/reconnect) */
  reset(): void {
    this.sensorStates.clear();
    this._stats = {
      totalGapsDetected: 0,
      totalFramesFilled: 0,
      largestGap: 0,
      gapsSkipped: 0,
    };
  }

  /**
   * Process an incoming IMU packet and return it plus any interpolated fill packets.
   *
   * @param packet The incoming live IMU packet
   * @returns Array of packets: [filled_1, filled_2, ..., original_packet]
   *          If no gap detected, returns [packet] (single element)
   */
  processPacket(packet: IMUDataPacket): LiveFilledPacket[] {
    if (!this._enabled) return [packet];

    if (
      typeof packet.sensorId !== "number" ||
      !Number.isFinite(packet.sensorId)
    ) {
      return [packet];
    }
    const sensorId = packet.sensorId;
    const frameNumber = packet.frameNumber;

    // No frame number = can't detect gaps
    if (frameNumber === undefined) return [packet];

    const state = this.sensorStates.get(sensorId);

    // First packet for this sensor — just record state
    if (!state) {
      this.sensorStates.set(sensorId, {
        lastFrameNumber: frameNumber,
        lastPacket: packet,
      });
      return [packet];
    }

    const gap = frameNumber - state.lastFrameNumber;

    // Normal sequential frame (gap=1) or duplicate/old (gap<=0)
    if (gap <= 1) {
      state.lastFrameNumber = frameNumber;
      state.lastPacket = packet;
      return [packet];
    }

    // Gap detected!
    const missingFrames = gap - 1;
    this._stats.totalGapsDetected++;

    if (missingFrames > MAX_FILL_GAP_FRAMES) {
      // Gap too large — likely a reconnect or major dropout
      this._stats.gapsSkipped++;
      state.lastFrameNumber = frameNumber;
      state.lastPacket = packet;
      return [packet];
    }

    // Track largest gap
    if (missingFrames > this._stats.largestGap) {
      this._stats.largestGap = missingFrames;
    }

    // Fill the gap with interpolated frames
    const result: LiveFilledPacket[] = [];
    const prevPacket = state.lastPacket;

    for (let i = 1; i <= missingFrames; i++) {
      const t = i / (missingFrames + 1); // interpolation parameter (0..1)

      const filledPacket: LiveFilledPacket = {
        sensorId,
        quaternion: slerp(prevPacket.quaternion, packet.quaternion, t),
        accelerometer: lerp3(prevPacket.accelerometer, packet.accelerometer, t),
        gyro:
          prevPacket.gyro && packet.gyro
            ? lerp3(prevPacket.gyro, packet.gyro, t)
            : packet.gyro,
        battery: packet.battery,
        timestamp: (prevPacket.timestamp ?? 0) + i * FRAME_PERIOD_SEC,
        timestampUs: (prevPacket.timestampUs ?? 0) + i * FRAME_PERIOD_US,
        frameNumber: state.lastFrameNumber + i,
        format: packet.format,
        syncQuality: packet.syncQuality,
        frameCompleteness: packet.frameCompleteness,
        __filled: true,
        __gapSize: missingFrames,
      };

      result.push(filledPacket);
    }

    this._stats.totalFramesFilled += missingFrames;

    // Append the real packet at the end
    result.push(packet);

    // Update state
    state.lastFrameNumber = frameNumber;
    state.lastPacket = packet;

    return result;
  }
}

// ============================================================================
// Singleton instance for the live pipeline
// ============================================================================
export const liveGapFill = new LiveGapFill();
