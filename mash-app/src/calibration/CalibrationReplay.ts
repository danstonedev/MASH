/**
 * Calibration Replay System
 * =========================
 *
 * Allows offline development and testing of calibration algorithms
 * using recorded debug capture files.
 *
 * Workflow:
 * 1. Record calibration session with debug recorder
 * 2. Load into this system
 * 3. Run calibration algorithms on recorded data
 * 4. Compare results, tweak parameters, repeat
 *
 * No more standing in the suit every time you change a line of code!
 */

import * as THREE from "three";
import type { SARAResult } from "./SCoRE";
import { SARACalibrator, JOINT_PAIRS, findCalibrableJoints } from "./SCoRE";
import {
  estimateFunctionalAxis,
  computeAxisAlignment,
} from "./calibrationMath";
import { refinePoseWithPCA, ANATOMICAL_AXES } from "./pcaRefinement";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Single device snapshot from debug capture.
 */
export interface DebugDeviceSnapshot {
  deviceId: string;
  name: string;
  segmentId: string;
  quaternion: [number, number, number, number]; // [w, x, y, z] or [x, y, z, w]?
  accelerometer: [number, number, number];
  gyro: [number, number, number];
  isStationary: boolean;
  quality: number;
  uncertaintyDeg?: [number, number, number];
}

/**
 * Single sample from debug capture (all devices at one timestamp).
 */
export interface DebugSample {
  tSystemMs: number;
  devices: DebugDeviceSnapshot[];
}

/**
 * Debug capture file format.
 */
export interface DebugCapture {
  schema: string;
  capturedAtIso: string;
  sampleHz: number;
  samples: DebugSample[];
}

/**
 * Detected phases in a calibration recording.
 */
export interface CalibrationPhases {
  staticStart: { startFrame: number; endFrame: number };
  walking: { startFrame: number; endFrame: number };
  staticEnd: { startFrame: number; endFrame: number };
}

/**
 * Results from running calibration on replay data.
 */
export interface ReplayCalibrationResult {
  segment: string;

  // Static pose calibration
  staticPoseOffset: THREE.Quaternion;
  staticPoseQuality: number;

  // PCA refinement (if movement detected)
  pcaAxis?: THREE.Vector3;
  pcaCorrectionDeg?: number;
  pcaRefinedOffset?: THREE.Quaternion;

  // SARA hinge axis (if dual-sensor available)
  saraResult?: SARAResult;

  // Method used
  method: "static-only" | "pca-refined" | "sara-refined";
}

// ============================================================================
// PHASE DETECTION
// ============================================================================

/**
 * Detect static and walking phases in the recording.
 * Uses gyroscope magnitude to identify movement vs stillness.
 */
export function detectPhases(capture: DebugCapture): CalibrationPhases {
  const samples = capture.samples;
  const n = samples.length;

  // Compute average gyro magnitude per frame across all sensors
  const gyroMagnitudes: number[] = samples.map((sample) => {
    let totalMag = 0;
    let count = 0;
    for (const device of sample.devices) {
      const [gx, gy, gz] = device.gyro;
      totalMag += Math.sqrt(gx * gx + gy * gy + gz * gz);
      count++;
    }
    return count > 0 ? totalMag / count : 0;
  });

  // Smooth with 10-frame moving average
  const windowSize = 10;
  const smoothedGyro = gyroMagnitudes.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (
      let j = Math.max(0, i - windowSize);
      j <= Math.min(n - 1, i + windowSize);
      j++
    ) {
      sum += gyroMagnitudes[j];
      count++;
    }
    return sum / count;
  });

  // Threshold for "moving" vs "still" (rad/s)
  const MOVEMENT_THRESHOLD = 0.15;

  // Find transitions
  let staticStartEnd = 0;
  let walkingStart = 0;
  let walkingEnd = n - 1;
  let staticEndStart = n - 1;

  // Find end of initial static phase
  for (let i = 0; i < n; i++) {
    if (smoothedGyro[i] > MOVEMENT_THRESHOLD) {
      staticStartEnd = Math.max(0, i - 5);
      walkingStart = i;
      break;
    }
  }

  // Find start of final static phase (search backwards)
  for (let i = n - 1; i >= 0; i--) {
    if (smoothedGyro[i] > MOVEMENT_THRESHOLD) {
      walkingEnd = i;
      staticEndStart = Math.min(n - 1, i + 5);
      break;
    }
  }

  console.log(`[CalibReplay] Phases detected:`);
  console.log(
    `  Static start: frames 0-${staticStartEnd} (${(staticStartEnd / capture.sampleHz).toFixed(1)}s)`,
  );
  console.log(
    `  Walking: frames ${walkingStart}-${walkingEnd} (${((walkingEnd - walkingStart) / capture.sampleHz).toFixed(1)}s)`,
  );
  console.log(
    `  Static end: frames ${staticEndStart}-${n - 1} (${((n - 1 - staticEndStart) / capture.sampleHz).toFixed(1)}s)`,
  );

  return {
    staticStart: { startFrame: 0, endFrame: staticStartEnd },
    walking: { startFrame: walkingStart, endFrame: walkingEnd },
    staticEnd: { startFrame: staticEndStart, endFrame: n - 1 },
  };
}

// ============================================================================
// CALIBRATION REPLAY
// ============================================================================

/**
 * Main class for replaying calibration from recorded data.
 */
export class CalibrationReplay {
  private capture: DebugCapture;
  private phases: CalibrationPhases;
  private segments: string[];

  constructor(capture: DebugCapture) {
    this.capture = capture;
    this.phases = detectPhases(capture);

    // Extract unique segments
    const segmentSet = new Set<string>();
    for (const device of capture.samples[0].devices) {
      if (device.segmentId) {
        segmentSet.add(device.segmentId);
      }
    }
    this.segments = Array.from(segmentSet);

    console.log(
      `[CalibReplay] Loaded ${capture.samples.length} frames, ${this.segments.length} segments`,
    );
    console.log(`[CalibReplay] Segments: ${this.segments.join(", ")}`);
  }

  /**
   * Get capture info.
   */
  getInfo(): {
    frames: number;
    duration: number;
    sampleHz: number;
    segments: string[];
  } {
    return {
      frames: this.capture.samples.length,
      duration: this.capture.samples.length / this.capture.sampleHz,
      sampleHz: this.capture.sampleHz,
      segments: this.segments,
    };
  }

  /**
   * Get detected phases.
   */
  getPhases(): CalibrationPhases {
    return this.phases;
  }

  /**
   * Run full calibration on the recorded data.
   */
  runCalibration(
    targetPose?: Map<string, THREE.Quaternion>,
  ): Map<string, ReplayCalibrationResult> {
    const results = new Map<string, ReplayCalibrationResult>();

    // Default target pose: T-pose (identity quaternion for all segments)
    // In practice, should use the model's bind pose
    const defaultTarget = new THREE.Quaternion();

    for (const segment of this.segments) {
      const result = this.calibrateSegment(
        segment,
        targetPose?.get(segment) || defaultTarget,
      );
      results.set(segment, result);
    }

    // Run SARA for dual-sensor joints
    this.runSARACalibration(results);

    return results;
  }

  /**
   * Calibrate a single segment using static pose + PCA refinement.
   */
  private calibrateSegment(
    segment: string,
    targetPose: THREE.Quaternion,
  ): ReplayCalibrationResult {
    // 1. Extract static pose data
    const staticFrames = this.getFramesForSegment(
      segment,
      this.phases.staticStart.startFrame,
      this.phases.staticStart.endFrame,
    );

    // 2. Compute average quaternion during static pose
    const avgQuat = this.averageQuaternions(staticFrames.map((f) => f.quat));

    // 3. Compute static pose offset: offset = inv(sensor) * target
    const sensorInv = avgQuat.clone().invert();
    const staticOffset = sensorInv.multiply(targetPose.clone());

    // 4. Compute static pose quality (lower uncertainty = higher quality)
    const avgUncertainty =
      staticFrames.reduce((sum, f) => sum + (f.uncertainty || 0), 0) /
      staticFrames.length;
    const staticQuality = Math.max(0, 100 - avgUncertainty * 10);

    // 5. Extract walking data for PCA refinement
    const walkingFrames = this.getFramesForSegment(
      segment,
      this.phases.walking.startFrame,
      this.phases.walking.endFrame,
    );

    // 6. Check if enough movement for PCA
    const hasMovement = this.hasSignificantMovement(walkingFrames);

    if (!hasMovement) {
      console.log(
        `[CalibReplay] ${segment}: Static only (no significant movement)`,
      );
      return {
        segment,
        staticPoseOffset: staticOffset,
        staticPoseQuality: staticQuality,
        method: "static-only",
      };
    }

    // 7. Run PCA on gyro data
    const gyroData = walkingFrames.map((f) => f.gyro);

    const pcaResult = estimateFunctionalAxis(gyroData);

    if (pcaResult.confidence < 0.5) {
      console.log(
        `[CalibReplay] ${segment}: PCA low confidence (${(pcaResult.confidence * 100).toFixed(0)}%), using static only`,
      );
      return {
        segment,
        staticPoseOffset: staticOffset,
        staticPoseQuality: staticQuality,
        method: "static-only",
      };
    }

    // 8. Get anatomical axis for this segment
    const anatomicalAxis = ANATOMICAL_AXES[segment];
    if (!anatomicalAxis) {
      console.log(
        `[CalibReplay] ${segment}: No anatomical axis defined, using static only`,
      );
      return {
        segment,
        staticPoseOffset: staticOffset,
        staticPoseQuality: staticQuality,
        pcaAxis: pcaResult.axis,
        method: "static-only",
      };
    }

    // 9. Apply PCA refinement using the production function
    const refinedOffset = refinePoseWithPCA(
      staticOffset,
      {
        segment,
        axis: pcaResult.axis,
        confidence: pcaResult.confidence,
        sampleCount: pcaResult.sampleCount,
        isValid: true,
      },
      anatomicalAxis,
    );

    // Compute correction angle for logging
    const diff = staticOffset.clone().invert().multiply(refinedOffset);
    const correctionAngleDeg =
      (2 * Math.acos(Math.min(1, Math.abs(diff.w))) * 180) / Math.PI;

    console.log(
      `[CalibReplay] ${segment}: PCA refined, correction=${correctionAngleDeg.toFixed(1)}°, confidence=${(pcaResult.confidence * 100).toFixed(0)}%`,
    );

    return {
      segment,
      staticPoseOffset: staticOffset,
      staticPoseQuality: staticQuality,
      pcaAxis: pcaResult.axis,
      pcaCorrectionDeg: correctionAngleDeg,
      pcaRefinedOffset: refinedOffset,
      method: "pca-refined",
    };
  }

  /**
   * Run SARA calibration for dual-sensor joints.
   */
  private runSARACalibration(
    results: Map<string, ReplayCalibrationResult>,
  ): void {
    // Find calibrable joints
    const calibrableJoints = findCalibrableJoints(this.segments);

    if (calibrableJoints.length === 0) {
      console.log(`[CalibReplay] No dual-sensor joints available for SARA`);
      return;
    }

    console.log(
      `[CalibReplay] Running SARA for ${calibrableJoints.length} joints`,
    );

    for (const joint of calibrableJoints) {
      const calibrator = new SARACalibrator(joint.jointId);

      // Feed walking phase data
      for (
        let i = this.phases.walking.startFrame;
        i <= this.phases.walking.endFrame;
        i++
      ) {
        const sample = this.capture.samples[i];

        const proximalDevice = sample.devices.find(
          (d) => d.segmentId === joint.proximalSegment,
        );
        const distalDevice = sample.devices.find(
          (d) => d.segmentId === joint.distalSegment,
        );

        if (proximalDevice && distalDevice) {
          const proximalGyro = new THREE.Vector3(...proximalDevice.gyro);
          const distalGyro = new THREE.Vector3(...distalDevice.gyro);
          const proximalQuat = this.arrayToQuat(proximalDevice.quaternion);
          const distalQuat = this.arrayToQuat(distalDevice.quaternion);

          calibrator.addFrame(
            proximalGyro,
            distalGyro,
            proximalQuat,
            distalQuat,
          );
        }
      }

      // Compute SARA result
      const saraResult = calibrator.compute();

      if (saraResult && saraResult.confidence > 0.5) {
        console.log(
          `[CalibReplay] SARA ${joint.jointId}: axis=[${saraResult.axisWorld
            .toArray()
            .map((v: number) => v.toFixed(3))
            .join(", ")}], ` +
            `confidence=${(saraResult.confidence * 100).toFixed(1)}%`,
        );

        // Update distal segment result
        const distalResult = results.get(joint.distalSegment);
        if (distalResult) {
          distalResult.saraResult = saraResult;
          distalResult.method = "sara-refined";
        }
      } else {
        console.log(
          `[CalibReplay] SARA ${joint.jointId}: failed or low confidence`,
        );
      }
    }
  }

  /**
   * Extract frames for a specific segment.
   */
  private getFramesForSegment(
    segment: string,
    startFrame: number,
    endFrame: number,
  ): {
    quat: THREE.Quaternion;
    gyro: THREE.Vector3;
    accel: THREE.Vector3;
    uncertainty: number;
  }[] {
    const frames: {
      quat: THREE.Quaternion;
      gyro: THREE.Vector3;
      accel: THREE.Vector3;
      uncertainty: number;
    }[] = [];

    for (let i = startFrame; i <= endFrame; i++) {
      const sample = this.capture.samples[i];
      const device = sample.devices.find((d) => d.segmentId === segment);

      if (device) {
        frames.push({
          quat: this.arrayToQuat(device.quaternion),
          gyro: new THREE.Vector3(...device.gyro),
          accel: new THREE.Vector3(...device.accelerometer),
          uncertainty: device.uncertaintyDeg ? device.uncertaintyDeg[2] : 0,
        });
      }
    }

    return frames;
  }

  /**
   * Convert quaternion array to THREE.Quaternion.
   * Debug capture uses [w, x, y, z] format.
   */
  private arrayToQuat(arr: [number, number, number, number]): THREE.Quaternion {
    // Debug capture appears to use [w, x, y, z] based on typical values
    // Check: if arr[0] is large (~0.7+), it's likely w
    const [w, x, y, z] = arr;
    return new THREE.Quaternion(x, y, z, w);
  }

  /**
   * Average multiple quaternions using iterative approach.
   */
  private averageQuaternions(quats: THREE.Quaternion[]): THREE.Quaternion {
    if (quats.length === 0) return new THREE.Quaternion();
    if (quats.length === 1) return quats[0].clone();

    // Use first quaternion as reference
    const ref = quats[0].clone();
    const sum = new THREE.Quaternion(0, 0, 0, 0);

    for (const q of quats) {
      // Flip if in opposite hemisphere
      const dot = ref.dot(q);
      const qAligned =
        dot < 0 ? new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w) : q.clone();

      sum.x += qAligned.x;
      sum.y += qAligned.y;
      sum.z += qAligned.z;
      sum.w += qAligned.w;
    }

    return sum.normalize();
  }

  /**
   * Check if segment has significant movement.
   */
  private hasSignificantMovement(frames: { gyro: THREE.Vector3 }[]): boolean {
    const THRESHOLD = 0.3; // rad/s
    let movingFrames = 0;

    for (const frame of frames) {
      if (frame.gyro.length() > THRESHOLD) {
        movingFrames++;
      }
    }

    // Need at least 20% of frames with movement
    return movingFrames > frames.length * 0.2;
  }

  /**
   * Get expected principal axis for a segment.
   */
  private getExpectedAxis(segment: string): THREE.Vector3 {
    // For lower body segments during walking, primary rotation is flexion/extension
    // which is around the lateral (X) axis
    const lowerBodySegments = [
      "thigh_l",
      "thigh_r",
      "tibia_l",
      "tibia_r",
      "foot_l",
      "foot_r",
    ];

    if (lowerBodySegments.includes(segment)) {
      return new THREE.Vector3(1, 0, 0); // Lateral axis
    }

    // Default: no strong expectation
    return new THREE.Vector3(1, 0, 0);
  }

  /**
   * Compare two calibration results.
   */
  static compareResults(
    resultA: Map<string, ReplayCalibrationResult>,
    resultB: Map<string, ReplayCalibrationResult>,
  ): Map<string, { angleDiffDeg: number; methodA: string; methodB: string }> {
    const comparison = new Map<
      string,
      { angleDiffDeg: number; methodA: string; methodB: string }
    >();

    for (const [segment, resA] of resultA) {
      const resB = resultB.get(segment);
      if (!resB) continue;

      // Get final offsets
      const offsetA = resA.pcaRefinedOffset || resA.staticPoseOffset;
      const offsetB = resB.pcaRefinedOffset || resB.staticPoseOffset;

      // Compute angle between quaternions
      const diff = offsetA.clone().invert().multiply(offsetB);
      const angleDeg =
        (2 * Math.acos(Math.min(1, Math.abs(diff.w))) * 180) / Math.PI;

      comparison.set(segment, {
        angleDiffDeg: angleDeg,
        methodA: resA.method,
        methodB: resB.method,
      });
    }

    return comparison;
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Load a debug capture file.
 */
export async function loadDebugCapture(
  filePath: string,
): Promise<DebugCapture> {
  const response = await fetch(filePath);
  const json = await response.json();
  return json as DebugCapture;
}

/**
 * Quick test function - run calibration on a debug capture.
 */
export function runCalibrationTest(capture: DebugCapture): void {
  console.log("\n========== CALIBRATION REPLAY TEST ==========\n");

  const replay = new CalibrationReplay(capture);
  const info = replay.getInfo();

  console.log(
    `Recording: ${info.frames} frames, ${info.duration.toFixed(1)}s @ ${info.sampleHz}Hz`,
  );
  console.log(`Segments: ${info.segments.join(", ")}\n`);

  const results = replay.runCalibration();

  console.log("\n========== CALIBRATION RESULTS ==========\n");

  for (const [segment, result] of results) {
    const offset = result.pcaRefinedOffset || result.staticPoseOffset;
    const euler = new THREE.Euler().setFromQuaternion(offset);

    console.log(`${segment}:`);
    console.log(`  Method: ${result.method}`);
    console.log(`  Quality: ${result.staticPoseQuality.toFixed(0)}%`);
    console.log(
      `  Offset: [${offset.w.toFixed(4)}, ${offset.x.toFixed(4)}, ${offset.y.toFixed(4)}, ${offset.z.toFixed(4)}]`,
    );
    console.log(
      `  Euler (deg): [${((euler.x * 180) / Math.PI).toFixed(1)}, ${((euler.y * 180) / Math.PI).toFixed(1)}, ${((euler.z * 180) / Math.PI).toFixed(1)}]`,
    );

    if (result.pcaCorrectionDeg !== undefined) {
      console.log(`  PCA correction: ${result.pcaCorrectionDeg.toFixed(1)}°`);
    }

    if (result.saraResult) {
      console.log(
        `  SARA axis: [${result.saraResult.axisWorld
          .toArray()
          .map((v: number) => v.toFixed(3))
          .join(", ")}]`,
      );
      console.log(
        `  SARA confidence: ${(result.saraResult.confidence * 100).toFixed(1)}%`,
      );
    }

    console.log();
  }
}
