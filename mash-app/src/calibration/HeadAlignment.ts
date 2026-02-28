import * as THREE from "three";
import { estimateFunctionalAxis } from "./calibrationMath";

/**
 * Head Alignment Module
 *
 * Provides mathematical functions to align a single IMU to the Head's anatomical frame
 * using functional movements (Nod/Shake).
 *
 * TWO-LAYER CALIBRATION:
 *
 * Layer 1: Axis Alignment (R_align)
 *   - Maps sensor rotation axes to anatomical rotation axes
 *   - From PCA: pitch_axis → X, yaw_axis → Y
 *   - R_align transforms sensor frame to bone frame
 *
 * Layer 2: Boresight (applied separately in CervicalCalibration)
 *   - Zeros the calibration pose to neutral
 *   - boresight = inverse(q_calibration)
 *
 * Combined formula: q_bone = R_align × q_sensor × boresight × inverse(R_align)
 *   - This conjugation ensures rotation AXES are transformed, not just position
 */

export interface HeadCalibrationResult {
  /** Axis alignment rotation: Sensor Frame → Bone Frame */
  axisAlignment: THREE.Quaternion;
  /** Confidence of the PCA axis detection (0-1) */
  confidence: number;
  /** Detected axes in sensor frame */
  axes: {
    pitch: THREE.Vector3; // The detected Pitch (X) axis in Sensor Frame
    yaw: THREE.Vector3; // The detected Yaw (Y) axis in Sensor Frame
  };
}

/**
 * Compute the Head Frame calibration from functional data.
 *
 * Mathematical Goal:
 * Find rotation R that maps Sensor Frame -> Head Frame.
 * Head Frame: Y=Up (Yaw), X=Right (Pitch), Z=Back (Roll).
 *
 * @param nodSamples - Gyro samples during Nodding (Pitch)
 * @param shakeSamples - Gyro samples during Shaking (Yaw)
 * @param gravityRef - Accelerometer vector during validation (Gravity)
 */
export function computeHeadFrame(
  nodSamples: THREE.Vector3[],
  shakeSamples: THREE.Vector3[],
  gravityRef: THREE.Vector3,
  startQuaternion?: THREE.Quaternion, // Added for Disambiguation
): HeadCalibrationResult {
  // 1. Detect Dominant Axes using PCA
  const pitchResult = estimateFunctionalAxis(nodSamples, true);
  const yawResult = estimateFunctionalAxis(shakeSamples, true);

  const pitchAxis = pitchResult.axis.normalize();
  const yawAxis = yawResult.axis.normalize();

  // 2. Resolve Sign Ambiguity using Gravity (For Yaw/Up)
  // 'gravityRef' comes from Accelerometer, which measures Reaction Force (UP).
  // So 'gravityRef' points roughly UP (World +Y).
  // Ideally, Yaw Axis (Head Up) should align with 'gravityRef'.
  // If dot product is negative, they are opposed (Yaw points Down). Flip it.
  if (yawAxis.dot(gravityRef) < 0) {
    // Yaw axis is pointing Down (opposing Up-vector) -> Flip to Up
    yawAxis.negate();
  }

  // 3. Resolve Pitch Sign Ambiguity using Start Quaternion (Boresight)
  // PCA gives a line, but not direction (Right vs Left).
  // If we pick Left, the Basis becomes rotated 180 degrees (Yaw flip), creating "Head Backwards".
  // We use the StartQuaternion (assuming roughly upright/forward start) to project the PCA axis to World.
  if (startQuaternion) {
    // Transform PCA Pitch Axis (Sensor Frame) to World Frame
    const pitchWorld = pitchAxis.clone().applyQuaternion(startQuaternion);

    // Check alignment with World Right (+X)
    // If independent X is roughly Right.
    // Or if we assume the user is Facing Forward, Pitch Axis is Right-Left.
    // Dot product with World Right (1, 0, 0).
    if (pitchWorld.x < 0) {
      // It points Left. Flip it to point Right.
      // This ensures our Basis X always points "Right".
      pitchAxis.negate();
      console.debug(
        "[HeadAlignment] Disambiguated Pitch Axis: FLIPPED (was Left)",
      );
    } else {
      console.debug(
        "[HeadAlignment] Disambiguated Pitch Axis: KEPT (was Right)",
      );
    }
  }

  // 4. Construct Orthogonal Basis (Gram-Schmidt)
  // We trust Yaw (Shake) the most for 'Up', and Gravity confirms its sign.
  // We trust Pitch (Nod) for the plane.

  // Basis Vector Y (Up)
  const Y_prime = yawAxis.clone();

  // Basis Vector Z (Forward/Back) = Pitch x Yaw
  // Note: Pitch is roughly X, Yaw is Y.
  // X x Y = Z.
  // So Z_prime = Pitch x Yaw.
  const Z_prime = new THREE.Vector3()
    .crossVectors(pitchAxis, Y_prime)
    .normalize();

  // Basis Vector X (Right) = Y x Z
  // Enforce orthogonality: Recalculate X from steady Y and derived Z.
  const X_prime = new THREE.Vector3()
    .crossVectors(Y_prime, Z_prime)
    .normalize();

  // 5. Create Rotation Matrix
  // The matrix M where columns are [X', Y', Z'] represents the rotation from
  // the Standard Basis (1,0,0...) TO the Sensor Basis (X', Y', Z').
  // i.e. M * i = X'.
  // This is Rotation_{Head -> Sensor}.
  // Note: We map X_prime -> Model X (Right), Y_prime -> Model Y (Up), Z_prime -> Model Z (Back).
  const basisMatrix = new THREE.Matrix4().makeBasis(X_prime, Y_prime, Z_prime);

  // R_align = Rotation_{Sensor -> Head} = inverse(Rotation_{Head -> Sensor})
  const alignMatrix = basisMatrix.clone().invert();
  const axisAlignment = new THREE.Quaternion().setFromRotationMatrix(
    alignMatrix,
  );

  // NOTE: No 180° correction here! The axis alignment purely maps sensor axes to bone axes.
  // The boresight (applied in CervicalCalibration) handles neutral position.
  // If the model appears backwards, it's a boresight issue, not axis alignment.

  // Confidence is geometric mean of PCA confidences
  const confidence = Math.sqrt(pitchResult.confidence * yawResult.confidence);

  return {
    axisAlignment,
    confidence,
    axes: {
      pitch: X_prime,
      yaw: Y_prime,
    },
  };
}

/**
 * Helper: Check if calibration is plausible
 */
export function validateHeadCalibration(
  result: HeadCalibrationResult,
): string[] {
  const warnings: string[] = [];
  if (result.confidence < 0.8) {
    warnings.push(
      `Low confidence (Pitch: ${(result.confidence * 100).toFixed(0)}%)`,
    );
  }
  return warnings;
}
