/**
 * Walking Refinement — Post-Calibration Upgrades
 * ================================================
 *
 * Three targeted optimizations that exploit gait biomechanics
 * to improve calibration accuracy during normal walking:
 *
 * 1. **Swing-Phase Knee Abduction Zeroing** (Seel 2014)
 *    During swing phase the knee acts as a pure hinge — any observed
 *    abduction/adduction is calibration error. We estimate the mean
 *    false abduction during mid-swing and rotate the thigh calibration
 *    about its longitudinal axis to null it out.
 *
 * 2. **Foot-Flat Heading Reset** (Foxlin 2005, Nilsson 2012)
 *    During mid-stance (foot flat on ground), we know foot pitch/roll
 *    are zero and heading drift can be corrected. This provides periodic
 *    absolute heading anchors that cascade up via the coherence system.
 *
 * 3. **Anthropometric Segment Scaling** (De Leva 1996)
 *    Scales the FK skeleton to match subject proportions using
 *    height-proportional segment lengths already in InverseDynamics.
 *
 * @module calibration/walkingRefinement
 */

import * as THREE from "three";
import { calculateJointAngle, type JointAngles } from "../biomech/jointAngles";
import { createAnthropometricModel } from "../biomech/InverseDynamics";
import { fkSolver } from "../biomech/ForwardKinematics";

// ============================================================================
// 1. SWING-PHASE KNEE ABDUCTION ZEROING
// ============================================================================

/**
 * Result of knee abduction zeroing.
 */
export interface KneeAbdZeroResult {
  /** Correction angle in degrees to rotate thigh calibration */
  correctionDeg: number;
  /** Correction quaternion — pre-multiply onto thigh calibration offset */
  correctionQuat: THREE.Quaternion;
  /** Number of swing-phase samples used */
  swingSamples: number;
  /** Mean observed abduction during swing (deg, before correction) */
  meanFalseAbduction: number;
  /** Standard deviation of swing abduction (deg) — quality metric */
  stdAbduction: number;
}

/**
 * Compute swing-phase knee abduction zeroing correction.
 *
 * **Algorithm** (adapted from Seel et al. 2014):
 * 1. For each frame, compute knee joint angles (flexion, abduction, rotation)
 * 2. Select frames in mid-swing (high flexion + gyro-based phase detection)
 * 3. Mean of abduction during mid-swing = calibration error
 * 4. Correction: rotate thigh IMU about its longitudinal axis by −mean_abd
 *
 * @param thighQuats - Thigh sensor quaternions during walking
 * @param tibiaQuats - Tibia sensor quaternions during walking (same length)
 * @param tibiaGyroMag - Tibia gyroscope magnitude per frame (rad/s)
 * @param swingGyroThreshold - Gyro threshold to detect swing (default 1.0 rad/s)
 * @param minFlexionDeg - Minimum knee flexion to qualify as mid-swing (default 30°)
 * @returns Correction result, or null if insufficient swing data
 */
export function computeKneeAbdZeroing(
  thighQuats: THREE.Quaternion[],
  tibiaQuats: THREE.Quaternion[],
  tibiaGyroMag: number[],
  swingGyroThreshold: number = 1.0,
  minFlexionDeg: number = 30,
): KneeAbdZeroResult | null {
  const n = Math.min(thighQuats.length, tibiaQuats.length, tibiaGyroMag.length);
  if (n < 20) return null;

  // Collect abduction values during mid-swing
  const swingAbductions: number[] = [];

  for (let i = 0; i < n; i++) {
    // Mid-swing heuristic: tibia gyro > threshold AND knee flexion > minimum
    if (tibiaGyroMag[i] < swingGyroThreshold) continue;

    const angles = calculateJointAngle(thighQuats[i], tibiaQuats[i], "knee_l");
    if (Math.abs(angles.flexion) < minFlexionDeg) continue;

    swingAbductions.push(angles.abduction);
  }

  if (swingAbductions.length < 5) return null;

  // Mean and std of false abduction
  const mean =
    swingAbductions.reduce((a, b) => a + b, 0) / swingAbductions.length;
  const variance =
    swingAbductions.reduce((a, b) => a + (b - mean) ** 2, 0) /
    swingAbductions.length;
  const std = Math.sqrt(variance);

  // Correction: rotate thigh about its Y (longitudinal) axis by −mean
  const correctionRad = (-mean * Math.PI) / 180;
  const correctionQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), // thigh longitudinal axis
    correctionRad,
  );

  return {
    correctionDeg: -mean,
    correctionQuat,
    swingSamples: swingAbductions.length,
    meanFalseAbduction: mean,
    stdAbduction: std,
  };
}

/**
 * Incremental version — accumulates swing-phase data over time
 * and provides a running correction estimate.
 */
export class IncrementalKneeAbdZeroing {
  private swingAbductions: number[] = [];
  private readonly maxSamples: number;
  private readonly gyroThreshold: number;
  private readonly minFlexion: number;

  constructor(
    maxSamples: number = 500,
    gyroThreshold: number = 1.0,
    minFlexion: number = 30,
  ) {
    this.maxSamples = maxSamples;
    this.gyroThreshold = gyroThreshold;
    this.minFlexion = minFlexion;
  }

  /**
   * Add a single frame of walking data.
   * @returns true if this frame was accepted as mid-swing
   */
  addFrame(
    thighQuat: THREE.Quaternion,
    tibiaQuat: THREE.Quaternion,
    tibiaGyroMag: number,
  ): boolean {
    if (tibiaGyroMag < this.gyroThreshold) return false;

    const angles = calculateJointAngle(thighQuat, tibiaQuat, "knee_l");
    if (Math.abs(angles.flexion) < this.minFlexion) return false;

    this.swingAbductions.push(angles.abduction);

    // Sliding window
    if (this.swingAbductions.length > this.maxSamples) {
      this.swingAbductions.shift();
    }

    return true;
  }

  /**
   * Get current correction estimate.
   * @returns null if insufficient data (< 5 swing samples)
   */
  getCorrection(): KneeAbdZeroResult | null {
    if (this.swingAbductions.length < 5) return null;

    const mean =
      this.swingAbductions.reduce((a, b) => a + b, 0) /
      this.swingAbductions.length;
    const variance =
      this.swingAbductions.reduce((a, b) => a + (b - mean) ** 2, 0) /
      this.swingAbductions.length;
    const std = Math.sqrt(variance);

    const correctionRad = (-mean * Math.PI) / 180;
    const correctionQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      correctionRad,
    );

    return {
      correctionDeg: -mean,
      correctionQuat,
      swingSamples: this.swingAbductions.length,
      meanFalseAbduction: mean,
      stdAbduction: std,
    };
  }

  /** Reset accumulated data */
  reset(): void {
    this.swingAbductions.length = 0;
  }

  /** Number of accumulated swing samples */
  get sampleCount(): number {
    return this.swingAbductions.length;
  }
}

// ============================================================================
// 2. FOOT-FLAT HEADING RESET
// ============================================================================

/**
 * Heading reset result for a single foot-flat event.
 */
export interface HeadingResetResult {
  /** Corrected heading quaternion (yaw-only, pitch/roll zeroed) */
  headingAnchor: THREE.Quaternion;
  /** Heading drift detected (degrees) */
  driftDeg: number;
  /** Confidence of this reset (0-1) */
  confidence: number;
  /** Timestamp of the reset */
  timestamp: number;
}

/**
 * Foot-flat heading reset detector.
 *
 * **Algorithm** (Foxlin 2005 ZUPT + Nilsson 2012 heading):
 * 1. During confirmed foot-flat (stance phase + low gyro):
 *    - Foot pitch & roll must be ~0 (gravity-aligned)
 *    - Extract heading (yaw) from current orientation
 *    - Create a gravity-aligned quaternion with only the yaw component
 *    - Provide this as a heading anchor to the VQF filter
 * 2. The VQF's adaptive heading stage gently corrects toward this anchor
 * 3. Heading corrections cascade up via the cross-sensor coherence system
 *
 * This class works with FootContactDetector events.
 */
export class FootFlatHeadingReset {
  /** Minimum time between heading resets (ms) — prevents over-correction */
  private readonly minResetInterval: number;
  /** Maximum gyro magnitude during foot-flat to qualify (rad/s) */
  private readonly maxGyroMag: number;
  /** Maximum pitch/roll deviation from level to qualify (rad) */
  private readonly maxTiltRad: number;

  private lastResetTime: Map<string, number> = new Map();
  private resetCount = 0;

  /** Reference heading per foot — set on first valid foot-flat */
  private referenceHeading: Map<string, number> = new Map();

  constructor(
    minResetIntervalMs: number = 500,
    maxGyroMag: number = 0.3,
    maxTiltDeg: number = 10,
  ) {
    this.minResetInterval = minResetIntervalMs;
    this.maxGyroMag = maxGyroMag;
    this.maxTiltRad = (maxTiltDeg * Math.PI) / 180;
  }

  /**
   * Check if current foot-flat conditions warrant a heading reset.
   *
   * @param foot - Which foot ('left' | 'right')
   * @param footQuat - Current foot sensor orientation quaternion
   * @param gyroMag - Current gyroscope magnitude (rad/s)
   * @param isGrounded - Whether foot is confirmed grounded (from FootContactDetector)
   * @param timestamp - Current timestamp (ms)
   * @returns Heading reset result, or null if conditions not met
   */
  tryReset(
    foot: string,
    footQuat: THREE.Quaternion,
    gyroMag: number,
    isGrounded: boolean,
    timestamp: number,
  ): HeadingResetResult | null {
    // Must be grounded with low rotation
    if (!isGrounded || gyroMag > this.maxGyroMag) return null;

    // Rate-limit resets per foot
    const lastReset = this.lastResetTime.get(foot) ?? 0;
    if (timestamp - lastReset < this.minResetInterval) return null;

    // Extract pitch, roll, yaw from foot orientation
    const euler = new THREE.Euler().setFromQuaternion(footQuat, "YXZ");
    const pitch = euler.x; // forward tilt
    const roll = euler.z; // lateral tilt
    const yaw = euler.y; // heading

    // Foot must be approximately level (pitch/roll near zero)
    if (Math.abs(pitch) > this.maxTiltRad || Math.abs(roll) > this.maxTiltRad) {
      return null;
    }

    // Confidence based on how close to perfectly flat
    const tiltMag = Math.sqrt(pitch * pitch + roll * roll);
    const confidence = Math.max(0, 1 - tiltMag / this.maxTiltRad);

    // Create gravity-aligned heading anchor (yaw only, pitch/roll zeroed)
    const headingAnchor = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, yaw, 0, "YXZ"),
    );

    // Compute drift from reference heading
    let driftDeg = 0;
    const ref = this.referenceHeading.get(foot);
    if (ref !== undefined) {
      driftDeg = ((yaw - ref) * 180) / Math.PI;
      // Normalize to ±180
      while (driftDeg > 180) driftDeg -= 360;
      while (driftDeg < -180) driftDeg += 360;
    } else {
      // First reset — set reference
      this.referenceHeading.set(foot, yaw);
    }

    this.lastResetTime.set(foot, timestamp);
    this.resetCount++;

    return {
      headingAnchor,
      driftDeg,
      confidence,
      timestamp,
    };
  }

  /** Get total number of heading resets performed */
  get totalResets(): number {
    return this.resetCount;
  }

  /** Reset state (e.g., on recalibration) */
  reset(): void {
    this.lastResetTime.clear();
    this.referenceHeading.clear();
    this.resetCount = 0;
  }
}

// ============================================================================
// 3. ANTHROPOMETRIC SEGMENT SCALING
// ============================================================================

/** Default model height in mm (matches DEFAULT_SKELETON_STRUCTURE offsets) */
const MODEL_DEFAULT_HEIGHT_CM = 180;

/**
 * Apply anthropometric scaling to the FK skeleton.
 *
 * Uses De Leva (1996) proportions via createAnthropometricModel()
 * already in InverseDynamics.ts. For now, applies uniform scaling
 * based on subject height ratio. Per-segment proportional scaling
 * is available via the returned model but would require modifying
 * the FK chain offsets individually.
 *
 * @param heightCm - Subject height in cm
 * @param weightKg - Subject weight in kg (for mass model, not bone lengths)
 * @param gender - 'male' | 'female' (affects proportions slightly)
 * @returns The scale factor applied
 */
export function applyAnthropometricScale(
  heightCm: number,
  weightKg: number = 75,
  gender: "male" | "female" = "male",
): number {
  // Uniform scale based on height ratio
  const scaleFactor = heightCm / MODEL_DEFAULT_HEIGHT_CM;
  fkSolver.setScale(scaleFactor);

  return scaleFactor;
}

/**
 * Get per-segment De Leva lengths for a subject (meters).
 * Useful for research export, GRF, or future per-segment FK scaling.
 */
export function getSegmentLengths(
  heightCm: number,
  weightKg: number = 75,
  gender: "male" | "female" = "male",
): Map<string, number> {
  const model = createAnthropometricModel(heightCm, weightKg, gender);
  return model.segmentLengths;
}
