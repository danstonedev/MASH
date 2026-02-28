/**
 * SensorIntegrityMonitor.ts — Real-time per-sensor data integrity checks
 *
 * Lightweight, zero-allocation (steady-state) monitor that validates each
 * incoming IMU packet for:
 *
 *  1. **NaN / Infinity**       — any non-finite value in quat/accel/gyro
 *  2. **Quat denormalization** — |q| deviates from 1.0 beyond tolerance
 *  3. **Frozen sensor**        — identical quaternion for N consecutive packets
 *  4. **Orientation jump**     — angular delta between consecutive quats >
 *                                threshold (glitch / magnetometer snap)
 *  5. **Accel out-of-range**   — |a| exceeds physical sensor limits
 *  6. **Gyro saturation**      — any gyro axis at or beyond full-scale range
 *
 * Design constraints:
 *  - Called once per packet inside `recordFrame()` at up to 200 Hz × N sensors
 *  - No heap allocations in hot path (reuses per-sensor state objects)
 *  - Returns a lightweight bitfield + optional detail so the recording store
 *    can annotate frames and accumulate session-level statistics
 */

import type { IMUDataPacket } from "../ble/DeviceInterface";

// ============================================================================
// Configuration — all thresholds are compile-time constants
// ============================================================================

/** Quaternion norm must be within 1.0 ± this value */
const QUAT_NORM_TOLERANCE = 0.05;

/** Number of consecutive identical quaternions before flagging "frozen" */
const FROZEN_FRAME_THRESHOLD = 20; // 100 ms at 200 Hz

/**
 * Maximum angular change (radians) between consecutive quaternions before
 * flagging an orientation jump. ~57° — far beyond any plausible human motion
 * in a single 5 ms sample.
 */
const ORIENTATION_JUMP_RAD = 1.0;

/**
 * Accelerometer magnitude ceiling in g.
 * ICM-20649 full-scale is ±30 g; we flag anything >32 g as likely corrupt.
 */
const ACCEL_MAX_G = 32.0;

/**
 * Gyroscope saturation threshold in rad/s.
 * ICM-20649 full-scale is ±4000 °/s ≈ 69.8 rad/s. Flag >= 68 rad/s.
 */
const GYRO_SATURATION_RAD_S = 68.0;

// ============================================================================
// Integrity flag bitfield — each bit represents one class of anomaly
// ============================================================================

export const IntegrityFlag = {
  NONE:           0,
  NAN_INF:        1 << 0,   // 0x01 — NaN or Infinity in any channel
  QUAT_DENORM:    1 << 1,   // 0x02 — |q| outside [1 ± tolerance]
  FROZEN:         1 << 2,   // 0x04 — Same quaternion for N consecutive frames
  JUMP:           1 << 3,   // 0x08 — Angular delta exceeds threshold
  ACCEL_RANGE:    1 << 4,   // 0x10 — |accel| > physical sensor limit
  GYRO_SATURATED: 1 << 5,   // 0x20 — Gyro axis at full-scale
} as const;

export type IntegrityFlags = number; // Bitwise OR of IntegrityFlag values

/** Human-readable labels keyed by flag bit position */
export const IntegrityFlagLabels: Record<number, string> = {
  [IntegrityFlag.NAN_INF]:        "NaN/Infinity",
  [IntegrityFlag.QUAT_DENORM]:    "Quat denormalized",
  [IntegrityFlag.FROZEN]:         "Frozen sensor",
  [IntegrityFlag.JUMP]:           "Orientation jump",
  [IntegrityFlag.ACCEL_RANGE]:    "Accel out-of-range",
  [IntegrityFlag.GYRO_SATURATED]: "Gyro saturated",
};

// ============================================================================
// Per-sensor tracking state (reused across calls — no allocations)
// ============================================================================

interface SensorState {
  /** Last quaternion to detect frozen + compute angular delta */
  prevQuat: [number, number, number, number];
  /** How many consecutive packets had identical quaternion */
  frozenCount: number;
  /** Whether we already flagged this freeze streak (avoid spamming) */
  frozenFlagged: boolean;
}

// ============================================================================
// Integrity check result returned per-packet
// ============================================================================

export interface IntegrityResult {
  /** Bitwise OR of IntegrityFlag values, 0 = clean */
  flags: IntegrityFlags;
  /** Angular delta to previous quaternion (radians), NaN if no previous */
  angularDeltaRad: number;
  /** Quaternion norm */
  quatNorm: number;
  /** Accelerometer magnitude (g) */
  accelMag: number;
}

// ============================================================================
// Session-level integrity summary (aggregated across all sensors)
// ============================================================================

export interface IntegritySummary {
  /** Total packets inspected */
  totalChecked: number;
  /** Number of packets with at least one flag raised */
  totalFlagged: number;
  /** Counts per flag type (keyed by IntegrityFlag value) */
  flagCounts: Record<number, number>;
  /** Per-sensor flag counts */
  perSensor: Map<number, { checked: number; flagged: number; flags: Record<number, number> }>;
}

// ============================================================================
// SensorIntegrityMonitor — singleton per recording session
// ============================================================================

export class SensorIntegrityMonitor {
  private sensorStates = new Map<number, SensorState>();
  private summary: IntegritySummary;

  constructor() {
    this.summary = SensorIntegrityMonitor.emptySummary();
  }

  // --------------------------------------------------------------------------
  // Hot-path: called once per IMU packet inside recordFrame()
  // --------------------------------------------------------------------------

  check(packet: IMUDataPacket): IntegrityResult {
    let flags: IntegrityFlags = IntegrityFlag.NONE;
    const q = packet.quaternion;
    const a = packet.accelerometer;
    const g = packet.gyro;
    const sid = packet.sensorId;

    // ------ 1. NaN / Infinity -----------------------------------------------
    if (
      !isFinite(q[0]) || !isFinite(q[1]) || !isFinite(q[2]) || !isFinite(q[3]) ||
      !isFinite(a[0]) || !isFinite(a[1]) || !isFinite(a[2]) ||
      (g && (!isFinite(g[0]) || !isFinite(g[1]) || !isFinite(g[2])))
    ) {
      flags |= IntegrityFlag.NAN_INF;
    }

    // ------ 2. Quaternion normalization -------------------------------------
    const qNorm = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (Math.abs(qNorm - 1.0) > QUAT_NORM_TOLERANCE) {
      flags |= IntegrityFlag.QUAT_DENORM;
    }

    // ------ 3 & 4. Frozen / Jump (need previous state) ----------------------
    let angularDelta = NaN;
    let state = this.sensorStates.get(sid);
    if (!state) {
      state = {
        prevQuat: [q[0], q[1], q[2], q[3]],
        frozenCount: 0,
        frozenFlagged: false,
      };
      this.sensorStates.set(sid, state);
    } else {
      const pq = state.prevQuat;

      // Frozen check: exact bitwise equality (firmware quantises to int16/16384)
      const identical =
        q[0] === pq[0] && q[1] === pq[1] && q[2] === pq[2] && q[3] === pq[3];

      if (identical) {
        state.frozenCount++;
        if (state.frozenCount >= FROZEN_FRAME_THRESHOLD && !state.frozenFlagged) {
          flags |= IntegrityFlag.FROZEN;
          state.frozenFlagged = true;
        }
      } else {
        state.frozenCount = 0;
        state.frozenFlagged = false;
      }

      // Orientation jump — angle between consecutive quaternions
      // Using: angle = 2 * arccos(|dot(q_prev, q_cur)|)
      // Clamp dot to [-1,1] to avoid NaN from floating point noise
      let dot = pq[0] * q[0] + pq[1] * q[1] + pq[2] * q[2] + pq[3] * q[3];
      dot = Math.min(1, Math.max(-1, Math.abs(dot)));
      angularDelta = 2 * Math.acos(dot);

      if (angularDelta > ORIENTATION_JUMP_RAD) {
        flags |= IntegrityFlag.JUMP;
      }

      // Update stored quaternion
      pq[0] = q[0]; pq[1] = q[1]; pq[2] = q[2]; pq[3] = q[3];
    }

    // ------ 5. Accelerometer range ------------------------------------------
    const aMag = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (aMag > ACCEL_MAX_G) {
      flags |= IntegrityFlag.ACCEL_RANGE;
    }

    // ------ 6. Gyro saturation ----------------------------------------------
    if (
      g &&
      (Math.abs(g[0]) >= GYRO_SATURATION_RAD_S ||
       Math.abs(g[1]) >= GYRO_SATURATION_RAD_S ||
       Math.abs(g[2]) >= GYRO_SATURATION_RAD_S)
    ) {
      flags |= IntegrityFlag.GYRO_SATURATED;
    }

    // ------ Accumulate summary ----------------------------------------------
    this.summary.totalChecked++;
    if (flags !== IntegrityFlag.NONE) {
      this.summary.totalFlagged++;
      for (const flagVal of FLAG_VALUES) {
        if (flags & flagVal) {
          this.summary.flagCounts[flagVal] = (this.summary.flagCounts[flagVal] || 0) + 1;
        }
      }

      // Per-sensor summary
      let ps = this.summary.perSensor.get(sid);
      if (!ps) {
        ps = { checked: 0, flagged: 0, flags: {} };
        this.summary.perSensor.set(sid, ps);
      }
      ps.flagged++;
      for (const flagVal of FLAG_VALUES) {
        if (flags & flagVal) {
          ps.flags[flagVal] = (ps.flags[flagVal] || 0) + 1;
        }
      }
    }
    // Always update per-sensor checked count
    let ps = this.summary.perSensor.get(sid);
    if (!ps) {
      ps = { checked: 0, flagged: 0, flags: {} };
      this.summary.perSensor.set(sid, ps);
    }
    ps.checked++;

    return { flags, angularDeltaRad: angularDelta, quatNorm: qNorm, accelMag: aMag };
  }

  // --------------------------------------------------------------------------
  // Retrieve the session-level summary (call at recording stop)
  // --------------------------------------------------------------------------

  getSummary(): IntegritySummary {
    return this.summary;
  }

  /**
   * Serializable version of the summary (Maps → plain objects)
   * suitable for storing in RecordingSession.dataQuality
   */
  getSerializableSummary(): {
    totalChecked: number;
    totalFlagged: number;
    flagCounts: Record<string, number>;
    perSensor: Record<string, { checked: number; flagged: number; flags: Record<string, number> }>;
  } {
    const perSensor: Record<string, { checked: number; flagged: number; flags: Record<string, number> }> = {};
    for (const [sid, stats] of this.summary.perSensor) {
      const flagsLabeled: Record<string, number> = {};
      for (const [fv, count] of Object.entries(stats.flags)) {
        const label = IntegrityFlagLabels[Number(fv)] || `flag_${fv}`;
        flagsLabeled[label] = count;
      }
      perSensor[String(sid)] = { checked: stats.checked, flagged: stats.flagged, flags: flagsLabeled };
    }

    const flagCounts: Record<string, number> = {};
    for (const [fv, count] of Object.entries(this.summary.flagCounts)) {
      const label = IntegrityFlagLabels[Number(fv)] || `flag_${fv}`;
      flagCounts[label] = count;
    }

    return {
      totalChecked: this.summary.totalChecked,
      totalFlagged: this.summary.totalFlagged,
      flagCounts,
      perSensor,
    };
  }

  // --------------------------------------------------------------------------
  // Reset for new recording session
  // --------------------------------------------------------------------------

  reset(): void {
    this.sensorStates.clear();
    this.summary = SensorIntegrityMonitor.emptySummary();
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private static emptySummary(): IntegritySummary {
    return {
      totalChecked: 0,
      totalFlagged: 0,
      flagCounts: {},
      perSensor: new Map(),
    };
  }
}

/** Pre-computed array of all flag values for fast iteration */
const FLAG_VALUES = [
  IntegrityFlag.NAN_INF,
  IntegrityFlag.QUAT_DENORM,
  IntegrityFlag.FROZEN,
  IntegrityFlag.JUMP,
  IntegrityFlag.ACCEL_RANGE,
  IntegrityFlag.GYRO_SATURATED,
];

// ============================================================================
// Singleton instance shared by the recording store
// ============================================================================

export const sensorIntegrityMonitor = new SensorIntegrityMonitor();
