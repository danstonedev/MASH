/**
 * SensorRingBuffers
 *
 * A single object that owns all four per-device ring buffers used during
 * calibration capture (gyro, accel, quaternion, timestamp). Handles:
 *   - IMU→Three.js coordinate frame conversion on ingestion
 *   - Ring-buffer truncation at a fixed capacity (~10 s at 60 fps)
 *   - Typed read access and full-map iterators for algorithms that need them
 *
 * Replaces four raw `Map` fields on `UnifiedCalibration`, giving callers a
 * single object to pass, reset, and reason about.
 */

import * as THREE from "three";
import {
  firmwareToThreeVec,
  firmwareToThreeQuat,
} from "../lib/math/conventions";

export interface TimelineAlignmentOptions {
  maxSkewMs?: number;
}

export interface TimelineAlignmentDiagnostics {
  totalPairs: number;
  interpolatedPairs: number;
  droppedPairs: number;
  averageSkewMs: number;
  maxSkewMs: number;
}

export interface AlignedJointFrame {
  timestampSec: number;
  skewMs: number;
  interpolated: boolean;
  proximal: {
    gyro: THREE.Vector3;
    accel: THREE.Vector3;
    quat: THREE.Quaternion;
  };
  distal: {
    gyro: THREE.Vector3;
    accel: THREE.Vector3;
    quat: THREE.Quaternion;
  };
}

interface InterpolatedSample<T> {
  value: T;
  timestampSec: number;
  interpolated: boolean;
}

export class SensorRingBuffers {
  /** Maximum samples retained per device (~10 s at 60 fps). */
  static readonly CAPACITY = 600;

  private readonly _gyro = new Map<string, THREE.Vector3[]>();
  private readonly _accel = new Map<string, THREE.Vector3[]>();
  private readonly _quat = new Map<string, THREE.Quaternion[]>();
  private readonly _time = new Map<string, number[]>();
  private _alignmentDiagnostics = {
    totalPairs: 0,
    interpolatedPairs: 0,
    droppedPairs: 0,
    totalSkewMs: 0,
    maxSkewMs: 0,
  };

  // ── Generic ring-push helper ─────────────────────────────────────────────

  private push<T>(map: Map<string, T[]>, id: string, value: T): void {
    const buf = map.get(id) ?? [];
    buf.push(value);
    if (buf.length > SensorRingBuffers.CAPACITY) buf.shift();
    map.set(id, buf);
  }

  // ── Write API (one method per channel, converts raw firmware values) ─────

  /** Push one gyro sample (firmware Z-up frame → Three.js Y-up). */
  pushGyro(deviceId: string, raw: [number, number, number]): void {
    this.push(this._gyro, deviceId, firmwareToThreeVec(raw));
  }

  /** Push one accelerometer sample (firmware Z-up frame → Three.js Y-up). */
  pushAccel(deviceId: string, raw: [number, number, number]): void {
    this.push(this._accel, deviceId, firmwareToThreeVec(raw));
  }

  /** Push one quaternion sample (firmware WXYZ order → THREE.Quaternion). */
  pushQuat(deviceId: string, raw: [number, number, number, number]): void {
    this.push(this._quat, deviceId, firmwareToThreeQuat(raw));
  }

  /** Push one timestamp (seconds). */
  pushTime(deviceId: string, t: number): void {
    this.push(this._time, deviceId, t);
  }

  // ── Per-device read access ───────────────────────────────────────────────

  gyro(deviceId: string): THREE.Vector3[] | undefined {
    return this._gyro.get(deviceId);
  }
  accel(deviceId: string): THREE.Vector3[] | undefined {
    return this._accel.get(deviceId);
  }
  quat(deviceId: string): THREE.Quaternion[] | undefined {
    return this._quat.get(deviceId);
  }
  time(deviceId: string): number[] | undefined {
    return this._time.get(deviceId);
  }

  // ── Full-map iterators (for algorithms that iterate all devices) ─────────

  /** Full gyro map — pass to `checkStability()` or iterate all devices. */
  gyroMap(): Map<string, THREE.Vector3[]> {
    return this._gyro;
  }
  /** Full quaternion map — use for pose averaging across all devices. */
  quatMap(): Map<string, THREE.Quaternion[]> {
    return this._quat;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  clear(): void {
    this._gyro.clear();
    this._accel.clear();
    this._quat.clear();
    this._time.clear();
    this.resetAlignmentDiagnostics();
  }

  getAlignedJointFrame(
    proximalDeviceId: string,
    distalDeviceId: string,
    options: TimelineAlignmentOptions = {},
  ): AlignedJointFrame | null {
    const proximalTimes = this.time(proximalDeviceId);
    const distalTimes = this.time(distalDeviceId);
    const proximalGyro = this.gyro(proximalDeviceId);
    const distalGyro = this.gyro(distalDeviceId);
    const proximalAccel = this.accel(proximalDeviceId);
    const distalAccel = this.accel(distalDeviceId);
    const proximalQuat = this.quat(proximalDeviceId);
    const distalQuat = this.quat(distalDeviceId);

    if (
      !proximalTimes?.length ||
      !distalTimes?.length ||
      !proximalGyro?.length ||
      !distalGyro?.length ||
      !proximalAccel?.length ||
      !distalAccel?.length ||
      !proximalQuat?.length ||
      !distalQuat?.length
    ) {
      this._alignmentDiagnostics.droppedPairs++;
      return null;
    }

    const targetTime = Math.min(
      proximalTimes[proximalTimes.length - 1],
      distalTimes[distalTimes.length - 1],
    );

    const proxGyro = this.interpolateVector3(
      proximalTimes,
      proximalGyro,
      targetTime,
    );
    const distGyro = this.interpolateVector3(
      distalTimes,
      distalGyro,
      targetTime,
    );
    const proxAccel = this.interpolateVector3(
      proximalTimes,
      proximalAccel,
      targetTime,
    );
    const distAccel = this.interpolateVector3(
      distalTimes,
      distalAccel,
      targetTime,
    );
    const proxQuat = this.interpolateQuaternion(
      proximalTimes,
      proximalQuat,
      targetTime,
    );
    const distQuat = this.interpolateQuaternion(
      distalTimes,
      distalQuat,
      targetTime,
    );

    if (
      !proxGyro ||
      !distGyro ||
      !proxAccel ||
      !distAccel ||
      !proxQuat ||
      !distQuat
    ) {
      this._alignmentDiagnostics.droppedPairs++;
      return null;
    }

    const skewMs =
      Math.abs(proxGyro.timestampSec - distGyro.timestampSec) * 1000;
    const maxSkewMs = options.maxSkewMs ?? 20;

    if (skewMs > maxSkewMs) {
      this._alignmentDiagnostics.droppedPairs++;
      return null;
    }

    const interpolated =
      proxGyro.interpolated ||
      distGyro.interpolated ||
      proxAccel.interpolated ||
      distAccel.interpolated ||
      proxQuat.interpolated ||
      distQuat.interpolated;

    this._alignmentDiagnostics.totalPairs++;
    if (interpolated) {
      this._alignmentDiagnostics.interpolatedPairs++;
    }
    this._alignmentDiagnostics.totalSkewMs += skewMs;
    this._alignmentDiagnostics.maxSkewMs = Math.max(
      this._alignmentDiagnostics.maxSkewMs,
      skewMs,
    );

    return {
      timestampSec: targetTime,
      skewMs,
      interpolated,
      proximal: {
        gyro: proxGyro.value,
        accel: proxAccel.value,
        quat: proxQuat.value,
      },
      distal: {
        gyro: distGyro.value,
        accel: distAccel.value,
        quat: distQuat.value,
      },
    };
  }

  getAlignmentDiagnostics(): TimelineAlignmentDiagnostics {
    const {
      totalPairs,
      interpolatedPairs,
      droppedPairs,
      totalSkewMs,
      maxSkewMs,
    } = this._alignmentDiagnostics;
    return {
      totalPairs,
      interpolatedPairs,
      droppedPairs,
      averageSkewMs: totalPairs > 0 ? totalSkewMs / totalPairs : 0,
      maxSkewMs,
    };
  }

  resetAlignmentDiagnostics(): void {
    this._alignmentDiagnostics = {
      totalPairs: 0,
      interpolatedPairs: 0,
      droppedPairs: 0,
      totalSkewMs: 0,
      maxSkewMs: 0,
    };
  }

  private findBoundingIndices(
    times: number[],
    targetTime: number,
  ): [number, number] {
    if (times.length === 1) return [0, 0];

    let low = 0;
    let high = times.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const t = times[mid];

      if (t === targetTime) {
        return [mid, mid];
      }

      if (t < targetTime) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const left = Math.max(0, high);
    const right = Math.min(times.length - 1, low);
    return [left, right];
  }

  private interpolateVector3(
    times: number[],
    values: THREE.Vector3[],
    targetTime: number,
  ): InterpolatedSample<THREE.Vector3> | null {
    if (times.length === 0 || values.length === 0) return null;

    const [leftIdx, rightIdx] = this.findBoundingIndices(times, targetTime);
    const leftTime = times[leftIdx];
    const rightTime = times[rightIdx];
    const leftValue = values[leftIdx];
    const rightValue = values[rightIdx];

    if (!leftValue || !rightValue) return null;

    if (leftIdx === rightIdx || rightTime === leftTime) {
      return {
        value: leftValue.clone(),
        timestampSec: leftTime,
        interpolated: false,
      };
    }

    const alpha = (targetTime - leftTime) / (rightTime - leftTime);
    const clamped = Math.max(0, Math.min(1, alpha));

    return {
      value: leftValue.clone().lerp(rightValue, clamped),
      timestampSec: leftTime + (rightTime - leftTime) * clamped,
      interpolated: true,
    };
  }

  private interpolateQuaternion(
    times: number[],
    values: THREE.Quaternion[],
    targetTime: number,
  ): InterpolatedSample<THREE.Quaternion> | null {
    if (times.length === 0 || values.length === 0) return null;

    const [leftIdx, rightIdx] = this.findBoundingIndices(times, targetTime);
    const leftTime = times[leftIdx];
    const rightTime = times[rightIdx];
    const leftValue = values[leftIdx];
    const rightValue = values[rightIdx];

    if (!leftValue || !rightValue) return null;

    if (leftIdx === rightIdx || rightTime === leftTime) {
      return {
        value: leftValue.clone(),
        timestampSec: leftTime,
        interpolated: false,
      };
    }

    const alpha = (targetTime - leftTime) / (rightTime - leftTime);
    const clamped = Math.max(0, Math.min(1, alpha));

    return {
      value: leftValue.clone().slerp(rightValue, clamped),
      timestampSec: leftTime + (rightTime - leftTime) * clamped,
      interpolated: true,
    };
  }
}

// ============================================================================
// UTILITY
// ============================================================================

/**
 * Build a `segment → deviceId` lookup from the current device registry.
 * Used by SARA/SCoRE calibrators to find the proximal/distal device for each joint.
 */
export function buildSegmentToDeviceMap(
  devices: Map<string, { id: string }>,
  getSegmentForSensor: (id: string) => string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  devices.forEach((device) => {
    const segment = getSegmentForSensor(device.id);
    if (segment) map.set(segment.toLowerCase(), device.id);
  });
  return map;
}
