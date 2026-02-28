/**
 * PCA Refinement Module
 * =====================
 *
 * Functions for refining calibration using Principal Component Analysis
 * of functional movement data.
 *
 * @module calibration/pcaRefinement
 */

import * as THREE from "three";
import {
  computeAxisAlignment,
  constructGramSchmidtFrame,
} from "./calibrationMath";

// ============================================================================
// TYPES
// ============================================================================

export interface PCAWindowResult {
  segment: string;
  axis: THREE.Vector3;
  confidence: number;
  sampleCount: number;
  isValid: boolean;
}

// ============================================================================
// ANATOMICAL AXES
// ============================================================================

/**
 * Anatomical axes for different segment types (in bone local space).
 *
 * These define the expected flexion axis for each segment,
 * used to align PCA-detected axes with anatomical expectations.
 */
/**
 * Segments attached to ball-and-socket joints.
 *
 * Free swing at these joints excites multiple DOF simultaneously — a PCA
 * axis from unconstrained movement is not the hip/shoulder flex axis.
 * Calibration for these segments requires a STRICTLY UNIPLANAR motion
 * (pure sagittal hip flex/ext with the hip abductors isometrically contracted,
 * or pure shoulder elevation with no internal/external rotation).
 *
 * The GS calibration path enforces a HIGHER confidence threshold (0.85)
 * for these segments and emits a specific retry cue if the motion fails.
 */
export const BALL_SOCKET_SEGMENTS = new Set<string>([
  "thigh_l",
  "thigh_r", // Hip: 3-DOF ball-and-socket
  "upper_arm_l",
  "upper_arm_r", // Shoulder: 3-DOF ball-and-socket
]);

export const ANATOMICAL_AXES: Record<string, THREE.Vector3> = {
  // Lower body - knee/hip flexion axis is lateral (X in Three.js)
  // In standard Mixamo rigs, +X Rotation = Flexion for both sides
  tibia_l: new THREE.Vector3(1, 0, 0),
  tibia_r: new THREE.Vector3(1, 0, 0),
  thigh_l: new THREE.Vector3(1, 0, 0),
  thigh_r: new THREE.Vector3(1, 0, 0),

  // Feet - ankle dorsiflexion/plantarflexion axis is lateral (X in Three.js)
  foot_l: new THREE.Vector3(1, 0, 0),
  foot_r: new THREE.Vector3(1, 0, 0),
  skate_l: new THREE.Vector3(1, 0, 0),
  skate_r: new THREE.Vector3(1, 0, 0),

  // Upper body - elbow flexion axis is also lateral
  forearm_l: new THREE.Vector3(1, 0, 0),
  forearm_r: new THREE.Vector3(1, 0, 0),
  upper_arm_l: new THREE.Vector3(1, 0, 0),
  upper_arm_r: new THREE.Vector3(1, 0, 0),

  // Pelvis - flexion (pitch) axis is lateral (X in Three.js) for Sit-to-Stand
  pelvis: new THREE.Vector3(1, 0, 0),

  // Torso/Chest - lumbar flexion axis is also lateral (X)
  torso: new THREE.Vector3(1, 0, 0),
  CHEST: new THREE.Vector3(1, 0, 0),

  // Head - neck flexion axis is lateral (X)
  head: new THREE.Vector3(1, 0, 0),

  // Hands - wrist flexion axis is lateral (X)
  hand_l: new THREE.Vector3(1, 0, 0),
  hand_r: new THREE.Vector3(1, 0, 0),
};

/**
 * Get the expected anatomical axis for a segment.
 *
 * @param segmentId - Segment identifier
 * @returns Expected flexion axis vector, or null if unknown
 */
export function getAnatomicalAxis(segmentId: string): THREE.Vector3 | null {
  return ANATOMICAL_AXES[segmentId] || null;
}

// ============================================================================
// PCA REFINEMENT
// ============================================================================

/**
 * Refine calibration offset using PCA-derived axis.
 *
 * This function takes an initial pose offset and refines it by aligning
 * the PCA-detected movement axis with the expected anatomical axis.
 *
 * MATH EXPLANATION:
 * - poseOffset transforms from Three.js World Frame → Bone Frame
 *   (because sensorQuat is already converted to Three.js frame before computing offset)
 * - pcaResult.axis is the detected flexion axis in RAW SENSOR (IMU) frame
 * - expectedAnatomicalAxis is the expected flexion axis in BONE frame
 *
 * To refine:
 * 1. Convert PCA axis from IMU Sensor Frame → Three.js World Frame
 * 2. Transform PCA axis from Three.js World Frame → Bone Frame using poseOffset
 * 3. Compute correction quaternion to align with anatomical axis (both in Bone Frame)
 * 4. Apply correction: refinedOffset = poseOffset * correction (POST-multiply)
 *
 * @param poseOffset - Initial calibration offset from static pose
 * @param pcaResult - PCA analysis result with detected axis (in sensor local frame)
 * @param expectedAnatomicalAxis - Expected anatomical axis for this segment (in Bone Frame)
 * @returns Refined calibration offset
 */
/**
 * Refine calibration offset using PCA-derived axis.
 *
 * @param poseOffset - Initial calibration offset from static pose
 * @param pcaResult - PCA analysis result with detected axis (in sensor local frame)
 * @param expectedAnatomicalAxis - Expected anatomical axis for this segment (in Bone Frame)
 * @param sensorGravity - Optional: Gravity vector in sensor frame (from static pose) for Gram-Schmidt
 * @returns Refined calibration offset
 */
export function refinePoseWithPCA(
  poseOffset: THREE.Quaternion,
  pcaResult: PCAWindowResult,
  expectedAnatomicalAxis: THREE.Vector3,
  sensorGravity?: THREE.Vector3, // NEW: Required for Gram-Schmidt
): THREE.Quaternion {
  if (!pcaResult.isValid || pcaResult.confidence < 0.5) {
    // PCA not reliable enough, return original
    return poseOffset;
  }

  // Step 1: PCA axis is already in Three.js World Frame
  // (Gyro data is now collected in Three.js frame via firmwareToThreeVec in UnifiedCalibration)
  const pcaAxisThreeJS = pcaResult.axis.clone();

  // Step 2: Transform PCA axis from Three.js World Frame → Bone Frame
  // poseOffset transforms vectors from World to Bone when applied via applyQuaternion
  const pcaAxisInBoneFrame = pcaAxisThreeJS.applyQuaternion(poseOffset);

  // Step 3: Handle axis sign ambiguity
  // PCA gives axis direction but not sign (flexion could be + or -)
  // If dot product is negative, the axis is pointing "backwards" - flip it
  const dotProduct = pcaAxisInBoneFrame.dot(expectedAnatomicalAxis);
  if (dotProduct < 0) {
    pcaAxisInBoneFrame.negate();
    // Also flip the original source axis for Gram-Schmidt usage
    pcaAxisThreeJS.negate();
  }

  // METHOD A: GRAM-SCHMIDT (Preferred if Gravity available)
  // Constructs a completely new stable frame based on Functional Axis + Gravity
  if (sensorGravity) {
    // sensorGravity is expected to be in Three.js frame already (converted at collection)
    // If not, caller must convert before passing
    const gravityThreeJS = sensorGravity.clone();

    // We want to align:
    // Primary (PCA) -> expectedAnatomicalAxis (e.g. X)
    // Reference (Gravity) -> maintains consistency with static pose

    // Target Gravity in Bone Frame:
    // We can estimate it by applying the INITIAL pose offset to the sensor gravity.
    const estimatedTargetGravity = gravityThreeJS
      .clone()
      .applyQuaternion(poseOffset);

    // POLARITY CHECK:
    // PCA axis is sign-ambiguous (eigenvector can be + or -).
    // If we pick the wrong sign, the computed offset will include a 180° flip,
    // causing "backwards rotation" (Extension instead of Flexion).
    // We use the Static Pose (T-Pose) as a hint for the correct direction.
    const pcaAxisInInitialBoneFrame = pcaAxisThreeJS
      .clone()
      .applyQuaternion(poseOffset);
    if (pcaAxisInInitialBoneFrame.dot(expectedAnatomicalAxis) < 0) {
      console.debug(
        `[PCA-GS] Flipping PCA axis for ${pcaResult.segment} to match static pose polarity`,
      );
      pcaAxisThreeJS.negate();
    }

    // =====================================================================
    // FIX: Use Frame Alignment to CORRECT offset, not REPLACE it
    // =====================================================================
    //
    // KEY INSIGHT: The Gram-Schmidt frame alignment maps sensor LOCAL axes
    // to bone LOCAL axes. This is an AXIS MAPPING, not a calibration offset.
    //
    // The calibration offset = inv(q_sensor_cal) × q_target encodes BOTH:
    //   - The axis mapping (implicitly via sensor orientation)
    //   - The absolute sensor orientation at calibration time
    //
    // If we replace the offset with just the frame alignment, we lose the
    // absolute orientation information, breaking calibration for any sensor
    // mounting that isn't aligned with the bone axes.
    //
    // CORRECT APPROACH:
    // 1. Keep the original poseOffset (it correctly captures sensor_cal → target)
    // 2. Use PCA+Gram-Schmidt to compute an AXIS CORRECTION in bone frame
    // 3. Post-multiply the correction to fix axis alignment
    //
    // This preserves the absolute orientation while fixing axis alignment.

    const frameAlignment = constructGramSchmidtFrame(
      pcaAxisThreeJS, // Primary (Sensor Frame)
      gravityThreeJS, // Secondary (Sensor Frame)
      expectedAnatomicalAxis, // Primary (Bone Frame)
      estimatedTargetGravity, // Secondary (Bone Frame)
    );

    // Check how well the original poseOffset aligns the PCA axis
    const poseAxisAligned = pcaAxisThreeJS.clone().applyQuaternion(poseOffset);
    const poseAxisDot = Math.abs(poseAxisAligned.dot(expectedAnatomicalAxis));

    if (poseAxisDot > 0.95) {
      // Original offset is already good, use Method B for fine-tuning
      const correction = computeAxisAlignment(
        poseAxisAligned,
        expectedAnatomicalAxis,
      );
      const refinedOffset = poseOffset.clone().multiply(correction);

      const changeAngle =
        (2 *
          Math.acos(Math.min(1, Math.abs(poseOffset.dot(refinedOffset)))) *
          180) /
        Math.PI;
      console.debug(
        `[PCA-GS] ${pcaResult.segment}: using Method B (axis already aligned ${(poseAxisDot * 100).toFixed(0)}%), correction=${changeAngle.toFixed(1)}°`,
      );

      return refinedOffset;
    }

    // For significant axis misalignment, compute correction using PCA axis
    // transformed through poseOffset, then align to anatomical axis
    const pcaInBone = pcaAxisThreeJS.clone().applyQuaternion(poseOffset);
    const axisCorrection = computeAxisAlignment(
      pcaInBone,
      expectedAnatomicalAxis,
    );
    const refinedOffset = poseOffset.clone().multiply(axisCorrection);

    const changeAngle =
      (2 *
        Math.acos(Math.min(1, Math.abs(poseOffset.dot(refinedOffset)))) *
        180) /
      Math.PI;
    console.debug(
      `[PCA-GS] ${pcaResult.segment}: correction=${changeAngle.toFixed(1)}°, conf=${pcaResult.confidence.toFixed(2)}`,
    );

    return refinedOffset;
  }

  // METHOD B: SIMPLE ROTATION CORRECTION (Fallback)
  // Step 4: Compute correction rotation (in Bone Frame)
  const correctionInBoneFrame = computeAxisAlignment(
    pcaAxisInBoneFrame,
    expectedAnatomicalAxis,
  );

  // DEBUG: Log the correction angle
  const correctionAngle =
    (2 * Math.acos(Math.abs(correctionInBoneFrame.w)) * 180) / Math.PI;
  console.debug(
    `[PCA] ${pcaResult.segment}: dot=${Math.abs(dotProduct).toFixed(3)}, correction=${correctionAngle.toFixed(1)}°, conf=${pcaResult.confidence.toFixed(2)}`,
  );

  // Step 5: Apply correction by POST-multiplying
  return poseOffset.clone().multiply(correctionInBoneFrame);
}

/**
 * Refines the calibration "Zero" (Offset) using a final static pose.
 * This rotates the offset around the Anatomical Axis (X) to match the target pose,
 * effectively "Zeroing" the flexion angle without disturbing the PCA-derived axis alignment.
 *
 * @param currentOffset The offset derived from PCA refinement
 * @param segment Segment ID
 * @param finalSensorQuat Sensor orientation during final static pose
 * @param targetQuat Target orientation (Zero pose)
 */
export function refineZeroWithFinalPose(
  currentOffset: THREE.Quaternion,
  segment: string,
  finalSensorQuat: THREE.Quaternion,
  targetQuat: THREE.Quaternion,
): THREE.Quaternion {
  const anatomicalAxis = ANATOMICAL_AXES[segment] || new THREE.Vector3(1, 0, 0);

  // Calculate current bone orientation with the PCA-refined offset
  const currentBone = finalSensorQuat.clone().multiply(currentOffset);

  // Calculate the rotation needed to get from Current Bone to Target Bone
  // currentBone * R = target  =>  R = currentBone^(-1) * target
  const rotationNeeded = currentBone.clone().invert().multiply(targetQuat);

  // Decompose R into Twist (around anatomical axis) and Swing.
  // We only apply the Twist component to zero the flexion/rotation correction.
  // If we applied the full R, we would revert to a purely Static calibration (overwriting PCA).
  const twist = extractTwist(rotationNeeded, anatomicalAxis);

  // Apply the twist to the offset
  // offset_new = offset_old * twist
  return currentOffset.clone().multiply(twist);
}

/**
 * Decomposes a quaternion into the Twist component around a specific axis.
 */
function extractTwist(
  q: THREE.Quaternion,
  axis: THREE.Vector3,
): THREE.Quaternion {
  // Project the vector part of the quaternion onto the axis
  // twist_v = dot(q_v, axis) * axis
  const dot = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const projected = axis.clone().multiplyScalar(dot);

  // Construct twist quaternion (v_projected, w) and normalize
  return new THREE.Quaternion(
    projected.x,
    projected.y,
    projected.z,
    q.w,
  ).normalize();
}
