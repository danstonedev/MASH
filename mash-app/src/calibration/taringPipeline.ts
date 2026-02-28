/**
 * Taring Pipeline - PhD-Level IMU Calibration Hierarchy
 * ======================================================
 *
 * "Taring" = mathematically defining "Zero" at a specific moment.
 *
 * Three distinct Tares strip away error layers to reveal clinical truth:
 *
 * LEVEL 1: Sensor Tare (Mounting Offset)
 *   Problem: Sensor taped crooked on limb
 *   Solution: q_bone = q_sensor ⊗ q_tare_mount
 *
 * LEVEL 2: Heading Tare (Boresighting)
 *   Problem: User facing any direction, not camera
 *   Solution: q_global = q_heading_tare⁻¹ ⊗ q_bone
 *
 * LEVEL 3: Joint Tare (Goniometric Zero)
 *   Problem: User has natural bend, can't reach anatomical zero
 *   Solution: θ_clinical = θ_measured - θ_tare_offset
 *
 * The full pipeline:
 *   q_sensor → [Level 1] → q_bone → [Level 2] → q_world → [Joint Calc] → q_rel → [Level 3] → θ_clinical
 *
 * @module taringPipeline
 */

import * as THREE from "three";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Complete taring state for a single sensor/segment
 */
export interface TareState {
  /** Level 1: Mounting offset (sensor → bone alignment) */
  mountingTare: THREE.Quaternion;

  /** Level 2: Heading offset (global yaw correction) */
  headingTare: THREE.Quaternion;

  /** Level 3: Joint angle offsets (flexion, abduction, rotation in degrees) */
  jointTare: {
    flexion: number;
    abduction: number;
    rotation: number;
  };

  /**
   * Frame alignment: Right-multiplied in the pipeline (q × frameAlignment).
   * Computed via PCA during functional calibration (nod/shake movements).
   *
   * For cervical calibration, this stores inv(R) where R = PCA axis alignment.
   * Combined with headingTare = q_cal × inv(R), this implements the full
   * similarity transform: q_world = R × inv(q_cal) × q_sensor × inv(R)
   */
  frameAlignment?: THREE.Quaternion;
  frameAlignmentTime?: number;

  /** Timestamps for debugging */
  mountingTareTime: number;
  headingTareTime: number;
  jointTareTime: number;
}

/**
 * Taring configuration options
 */
export interface TareOptions {
  /** Number of samples to average for stable tare (default: 30) */
  sampleCount?: number;

  /** Maximum variance allowed during tare capture (default: 0.001 rad²) */
  maxVariance?: number;

  /** Target pose for mounting tare (optional, for guided calibration) */
  targetPose?: THREE.Quaternion;
}

/**
 * Result of a tare operation
 */
export interface TareResult {
  success: boolean;
  tare: THREE.Quaternion;
  quality: number; // 0-1, higher is better
  message: string;
}

/**
 * Quality assessment result for calibration
 */
export interface CalibrationQuality {
  /** Overall quality score 0-1 */
  score: number;
  /** Stillness quality (low variance = good) */
  stillnessScore: number;
  /** Pose alignment quality (close to expected = good) */
  poseScore: number;
  /** Gravity alignment quality (accel near 1G = good) */
  gravityScore: number;
  /** Human-readable quality level */
  level: "excellent" | "good" | "acceptable" | "poor";
  /** Detailed message */
  message: string;
}

// ============================================================================
// CALIBRATION QUALITY ASSESSMENT
// ============================================================================

/**
 * Compute quaternion variance across a sample set.
 * Uses geodesic distance from mean for proper spherical statistics.
 *
 * @param samples Array of quaternion samples
 * @returns Variance in radians squared
 */
export function computeQuaternionVariance(samples: THREE.Quaternion[]): number {
  if (samples.length < 2) return 0;

  // Compute spherical mean
  const mean = computeSphericalMean(samples);

  // Compute average squared geodesic distance
  let sumSquaredDist = 0;
  for (const q of samples) {
    const angle = mean.angleTo(q);
    sumSquaredDist += angle * angle;
  }

  return sumSquaredDist / samples.length;
}

/**
 * Compute spherical mean of quaternions using iterative algorithm.
 * Handles quaternion double-cover properly.
 *
 * @param samples Array of quaternion samples
 * @returns Mean quaternion
 */
export function computeSphericalMean(
  samples: THREE.Quaternion[],
): THREE.Quaternion {
  if (samples.length === 0) return new THREE.Quaternion();
  if (samples.length === 1) return samples[0].clone();

  // Start with first sample as initial estimate
  const mean = samples[0].clone();

  // Iterative refinement (converges quickly for small variance)
  for (let iter = 0; iter < 10; iter++) {
    let sumX = 0,
      sumY = 0,
      sumZ = 0,
      sumW = 0;

    for (const q of samples) {
      // Handle hemisphere: flip q if on opposite side
      const dot = mean.dot(q);
      const sign = dot < 0 ? -1 : 1;

      sumW += sign * q.w;
      sumX += sign * q.x;
      sumY += sign * q.y;
      sumZ += sign * q.z;
    }

    mean.set(sumX, sumY, sumZ, sumW).normalize();
  }

  return mean;
}

/**
 * Assess calibration quality based on multiple factors.
 *
 * @param samples Quaternion samples collected during calibration
 * @param expectedPose Expected pose (optional, for pose alignment check)
 * @param accelSamples Accelerometer samples (optional, for gravity check)
 * @returns Detailed quality assessment
 */
export function assessCalibrationQuality(
  samples: THREE.Quaternion[],
  expectedPose?: THREE.Quaternion,
  accelSamples?: THREE.Vector3[],
): CalibrationQuality {
  // 1. Stillness Score (based on variance)
  // Excellent: variance < 0.0001 rad² (~0.5°)
  // Good: variance < 0.001 rad² (~2°)
  // Acceptable: variance < 0.01 rad² (~6°)
  // Poor: variance >= 0.01 rad²
  const variance = computeQuaternionVariance(samples);
  const stillnessScore = Math.exp(-variance / 0.001); // Exponential decay

  // 2. Pose Alignment Score (if expected pose provided)
  let poseScore = 1.0;
  if (expectedPose && samples.length > 0) {
    const mean = computeSphericalMean(samples);
    const angularError = mean.angleTo(expectedPose);
    // Score drops off with angular error
    // 0° = 1.0, 5° = 0.9, 15° = 0.5, 30° = 0.1
    poseScore = Math.exp(-angularError / 0.15);
  }

  // 3. Gravity Alignment Score (if accel samples provided)
  let gravityScore = 1.0;
  if (accelSamples && accelSamples.length > 0) {
    let sumDeviation = 0;
    for (const a of accelSamples) {
      const mag = a.length();
      sumDeviation += Math.abs(mag - 9.81);
    }
    const avgDeviation = sumDeviation / accelSamples.length;
    // Score based on how close to 1G
    // 0 m/s² deviation = 1.0, 0.5 m/s² deviation = 0.6, 1.0 m/s² deviation = 0.37
    gravityScore = Math.exp(-avgDeviation / 0.5);
  }

  // Combined score (weighted geometric mean)
  const score = Math.pow(stillnessScore * poseScore * gravityScore, 1 / 3);

  // Determine quality level
  let level: CalibrationQuality["level"];
  if (score >= 0.9) level = "excellent";
  else if (score >= 0.7) level = "good";
  else if (score >= 0.5) level = "acceptable";
  else level = "poor";

  // Generate message
  const varianceDeg = Math.sqrt(variance) * (180 / Math.PI);
  let message = `Calibration ${level} (${(score * 100).toFixed(0)}%). `;
  message += `Stillness: ${varianceDeg.toFixed(1)}° variance. `;
  if (score < 0.7) {
    message += "Try holding still during calibration.";
  }

  return {
    score,
    stillnessScore,
    poseScore,
    gravityScore,
    level,
    message,
  };
}

// ============================================================================
// DEFAULT STATE
// ============================================================================

/**
 * Create default (identity) tare state
 */
export function createDefaultTareState(): TareState {
  return {
    mountingTare: new THREE.Quaternion(), // Identity
    headingTare: new THREE.Quaternion(), // Identity
    jointTare: { flexion: 0, abduction: 0, rotation: 0 },
    frameAlignment: undefined,
    frameAlignmentTime: 0,
    mountingTareTime: 0,
    headingTareTime: 0,
    jointTareTime: 0,
  };
}

// ============================================================================
// LEVEL 0: FRAME ALIGNMENT (NEW - for functional calibration)
// ============================================================================

/**
 * Apply frame alignment as a similarity transform.
 *
 * This rotates the sensor quaternion into the anatomical coordinate frame,
 * ensuring that sensor rotation axes map to anatomical rotation axes.
 *
 * Formula: q_aligned = R × q_sensor × inv(R)
 *
 * Where R is the frame alignment quaternion computed from PCA analysis
 * of functional movements (nod → pitch axis, shake → yaw axis).
 *
 * @param sensorQuat Raw sensor quaternion
 * @param frameAlignment Frame alignment rotation (sensor → bone axes)
 * @returns Quaternion with axes remapped to anatomical frame
 */
export function applyFrameAlignment(
  sensorQuat: THREE.Quaternion,
  frameAlignment: THREE.Quaternion,
): THREE.Quaternion {
  // LESSON FROM PIPELINE INSPECTOR:
  // The correct multiplication order is: q_bone = q_sensor × R
  // This is RIGHT multiplication, same as mounting tare.
  //
  // DO NOT USE similarity transform (R × q × R⁻¹) - that swaps Y/Z!
  // See: src/components/tools/PipelineInspector.tsx lines 207-227
  //
  // The frameAlignment quaternion IS the rotation from sensor frame to bone frame.
  // We apply it via right multiplication to preserve local rotation semantics.
  return sensorQuat.clone().multiply(frameAlignment);
}

// ============================================================================
// LEVEL 1: SENSOR TARE (MOUNTING OFFSET)
// ============================================================================

/**
 * Compute Level 1 mounting tare.
 *
 * Given the current sensor reading when the user is in a known pose (e.g., T-Pose),
 * calculate the rotation that aligns the Sensor Frame with the Bone Frame.
 *
 * Math: q_mount = inv(q_sensor) × q_target_bone
 * Usage: q_bone = q_sensor × q_mount
 *
 * @param sensorQuat Current sensor quaternion (from Madgwick filter)
 * @param targetBoneQuat Expected bone orientation in global frame (from T-Pose model)
 * @returns TareResult with mounting quaternion
 */
export function computeMountingTare(
  sensorQuat: THREE.Quaternion,
  targetBoneQuat: THREE.Quaternion,
): TareResult {
  // q_mount = inv(q_sensor) × q_target
  const sensorInv = sensorQuat.clone().invert();
  const mountingTare = sensorInv.multiply(targetBoneQuat.clone());

  // Normalize to ensure unit quaternion
  mountingTare.normalize();

  return {
    success: true,
    tare: mountingTare,
    quality: 1.0, // Single-sample: no quality assessment possible
    message:
      "Mounting tare computed (single sample - consider using computeMountingTareRobust)",
  };
}

/**
 * Compute Level 1 mounting tare with multi-sample averaging and quality assessment.
 *
 * OpenSim best practice: Average 30+ samples with stillness verification.
 *
 * @param samples Array of sensor quaternion samples (minimum 10 recommended)
 * @param targetBoneQuat Expected bone orientation in global frame
 * @param accelSamples Optional accelerometer samples for gravity quality check
 * @returns TareResult with quality score
 */
export function computeMountingTareRobust(
  samples: THREE.Quaternion[],
  targetBoneQuat: THREE.Quaternion,
  accelSamples?: THREE.Vector3[],
): TareResult {
  if (samples.length < 3) {
    return {
      success: false,
      tare: new THREE.Quaternion(),
      quality: 0,
      message: `Insufficient samples (${samples.length}). Need at least 3.`,
    };
  }

  // Assess quality
  const quality = assessCalibrationQuality(samples, undefined, accelSamples);

  // Reject if too much motion
  if (quality.stillnessScore < 0.3) {
    return {
      success: false,
      tare: new THREE.Quaternion(),
      quality: quality.score,
      message: `Motion detected during calibration. ${quality.message}`,
    };
  }

  // Compute spherical mean of samples
  const meanSensorQuat = computeSphericalMean(samples);

  // Compute mounting tare from mean
  const sensorInv = meanSensorQuat.clone().invert();
  const mountingTare = sensorInv.multiply(targetBoneQuat.clone());
  mountingTare.normalize();

  return {
    success: true,
    tare: mountingTare,
    quality: quality.score,
    message: quality.message,
  };
}

/**
 * Apply Level 1 tare: Sensor → Bone
 *
 * @param sensorQuat Raw sensor quaternion
 * @param mountingTare Previously computed mounting tare
 * @returns Bone orientation in global frame
 */
export function applyMountingTare(
  sensorQuat: THREE.Quaternion,
  mountingTare: THREE.Quaternion,
): THREE.Quaternion {
  // q_bone = q_sensor × q_mount
  return sensorQuat.clone().multiply(mountingTare);
}

// ============================================================================
// LEVEL 2: HEADING TARE (BORESIGHTING)
// ============================================================================

/**
 * Compute Level 2 heading tare.
 *
 * Extracts and removes the yaw (heading) component so the user's current
 * "forward" becomes the world's "forward" (+Z in Three.js).
 *
 * This allows the user to face any direction and still have the avatar
 * face the camera.
 *
 * Math: Extract yaw from current orientation, invert it
 * Usage: q_world = inv(q_heading) × q_bone
 *
 * @param boneQuat Current bone orientation after Level 1 tare
 * @param upVector World up direction (default: Y-up)
 * @returns TareResult with heading quaternion
 */
export function computeHeadingTare(
  boneQuat: THREE.Quaternion,
  upVector: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
): TareResult {
  // Extract yaw (rotation around Y axis) from the bone quaternion
  // Decompose: q = q_yaw × q_tilt (yaw first, then tilt)

  // Get forward direction in world space
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(boneQuat);

  // Project onto XZ plane (remove Y component)
  forward.y = 0;

  if (forward.length() < 0.01) {
    // Looking straight up/down, use X direction
    forward.set(1, 0, 0).applyQuaternion(boneQuat);
    forward.y = 0;
  }

  forward.normalize();

  // Calculate yaw angle from +Z axis
  const yawAngle = Math.atan2(forward.x, forward.z);

  // Create yaw-only quaternion
  const headingTare = new THREE.Quaternion().setFromAxisAngle(
    upVector,
    yawAngle,
  );

  return {
    success: true,
    tare: headingTare,
    quality: 1.0,
    message: `Heading tare: ${((yawAngle * 180) / Math.PI).toFixed(1)}° yaw correction`,
  };
}

/**
 * Apply Level 2 tare: Remove heading offset
 *
 * @param boneQuat Bone orientation after Level 1
 * @param headingTare Previously computed heading tare
 * @returns World-aligned orientation (facing camera forward)
 */
export function applyHeadingTare(
  boneQuat: THREE.Quaternion,
  headingTare: THREE.Quaternion,
): THREE.Quaternion {
  // q_world = inv(q_heading) × q_bone
  const headingInv = headingTare.clone().invert();
  return headingInv.multiply(boneQuat.clone());
}

// ============================================================================
// LEVEL 3: JOINT TARE (GONIOMETRIC ZERO)
// ============================================================================

/**
 * Joint angle offsets for Level 3 tare
 */
export interface JointAngleOffsets {
  flexion: number;
  abduction: number;
  rotation: number;
}

/**
 * Compute Level 3 joint tare.
 *
 * For users who cannot achieve anatomical zero (e.g., natural genu varum,
 * contractures, or simply comfortable standing position), this captures
 * the current joint angles as the "clinical zero" reference.
 *
 * Math: θ_offset = θ_current (measured during "neutral" stance)
 * Usage: θ_clinical = θ_measured - θ_offset
 *
 * @param currentAngles Current joint angles (measured from Level 1+2 corrected data)
 * @returns Joint angle offsets to define as zero
 */
export function computeJointTare(
  currentAngles: JointAngleOffsets,
): JointAngleOffsets {
  // Simply store current angles as the offset
  return {
    flexion: currentAngles.flexion,
    abduction: currentAngles.abduction,
    rotation: currentAngles.rotation,
  };
}

/**
 * Apply Level 3 tare: Subtract joint offset
 *
 * @param measuredAngles Raw joint angles from decomposition
 * @param jointTare Previously captured joint offsets
 * @returns Clinical angles with user's neutral as zero
 */
export function applyJointTare(
  measuredAngles: JointAngleOffsets,
  jointTare: JointAngleOffsets,
): JointAngleOffsets {
  return {
    flexion: measuredAngles.flexion - jointTare.flexion,
    abduction: measuredAngles.abduction - jointTare.abduction,
    rotation: measuredAngles.rotation - jointTare.rotation,
  };
}

// ============================================================================
// FULL PIPELINE
// ============================================================================

/**
 * Apply the complete taring pipeline: Raw sensor → Clinical angles
 *
 * Level 1: Sensor → Bone (mounting correction)
 * Level 2: Bone → World (heading correction)
 * Level 3: Applied after joint angle calculation
 *
 * @param sensorQuat Raw sensor quaternion from Madgwick
 * @param tareState Complete tare state for this segment
 * @returns World-aligned bone orientation (Level 1+2 applied)
 */
export function applyFullTarePipeline(
  sensorQuat: THREE.Quaternion,
  tareState: TareState,
): THREE.Quaternion {
  // Level 1: Sensor → Bone
  const boneQuat = applyMountingTare(sensorQuat, tareState.mountingTare);

  // Level 2: Bone → World
  const worldQuat = applyHeadingTare(boneQuat, tareState.headingTare);

  return worldQuat;
}

/**
 * Pipeline stage names for debugging
 */
export const PIPELINE_STAGES = {
  RAW: "q_sensor",
  BONE: "q_bone",
  WORLD: "q_world",
  JOINT: "q_rel",
  CLINICAL: "θ_clinical",
} as const;

// ============================================================================
// GUIDED CALIBRATION HELPERS
// ============================================================================

/**
 * Validate that user is holding still enough for tare capture
 */
export function validateStillness(
  samples: THREE.Quaternion[],
  maxVariance: number = 0.001,
): { isStill: boolean; variance: number } {
  if (samples.length < 5) {
    return { isStill: false, variance: Infinity };
  }

  // Calculate mean quaternion (simplified: just use last sample for stability)
  const mean = samples[samples.length - 1];

  // Calculate variance as average angular distance from mean
  let sumAngularDist = 0;
  for (const q of samples) {
    const dot = Math.abs(q.dot(mean)); // abs handles q ≈ -q equivalence
    const angle = 2 * Math.acos(Math.min(1, dot)); // Geodesic distance
    sumAngularDist += angle * angle;
  }

  const variance = sumAngularDist / samples.length;

  return {
    isStill: variance < maxVariance,
    variance,
  };
}

/**
 * Average multiple quaternion samples (using SLERP approach)
 */
export function averageQuaternions(
  samples: THREE.Quaternion[],
): THREE.Quaternion {
  if (samples.length === 0) {
    return new THREE.Quaternion();
  }

  if (samples.length === 1) {
    return samples[0].clone();
  }

  // Start with first sample, iteratively SLERP toward others
  const result = samples[0].clone();

  for (let i = 1; i < samples.length; i++) {
    // Weight decreases as we accumulate more samples
    const weight = 1 / (i + 1);
    result.slerp(samples[i], weight);
  }

  return result.normalize();
}
