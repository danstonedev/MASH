/**
 * Hinge Calibration Engine
 *
 * Calibrates hinge joints (knee, elbow, ankle, wrist) by determining the
 * functional joint axis and building a complete sensor-to-bone alignment.
 *
 * Strategy:
 *   1. SARA (preferred) — uses BOTH parent + child quaternions for superior
 *      axis estimation. Cancels soft-tissue artifact automatically.
 *   2. Single-PCA (fallback) — uses only child-sensor gyro when parent
 *      sensor is unavailable. Still effective but less robust.
 *
 * The resulting axis is combined with a gravity reference (from a static
 * pose) via Gram-Schmidt to produce a full 3-axis coordinate frame,
 * then mapped to the target anatomical frame for that joint.
 *
 * Downstream usage:
 *   axisAlignment maps sensor rotation axes → bone rotation axes
 *   boresight zeros the calibration pose to neutral (applied separately)
 */

import * as THREE from "three";
import { computeSARA, IncrementalSARA, type SARAResult } from "./sara";
import {
  estimateFunctionalAxis,
  constructGramSchmidtFrame,
  type FunctionalAxisResult,
} from "./calibrationMath";
import {
  JOINT_DEFINITIONS,
  type JointDefinition,
} from "../biomech/jointAngles";

// ============================================================================
// TYPES
// ============================================================================

export interface HingeCalibrationResult {
  /** Axis alignment quaternion: Sensor Frame → Bone Frame */
  axisAlignment: THREE.Quaternion;
  /** The detected hinge axis in child sensor frame (unit vector) */
  hingeAxisChild: THREE.Vector3;
  /** The detected hinge axis in parent sensor frame (if SARA used) */
  hingeAxisParent: THREE.Vector3 | null;
  /** Method used */
  method: "sara" | "single-pca";
  /** Confidence in axis detection (0–1) */
  confidence: number;
  /** Quality assessment */
  quality: HingeCalibrationQuality;
}

export interface HingeCalibrationQuality {
  /** Overall score 0–100 */
  score: number;
  /** Was the motion predominantly uniaxial? */
  hingeDominance: number;
  /** Angular range of motion observed (degrees) */
  rangeOfMotion: number;
  /** Number of samples used */
  sampleCount: number;
  /** Warnings */
  warnings: string[];
}

/** Input data for hinge calibration */
export interface HingeCalibrationInput {
  /** Joint identifier (e.g., 'knee_l', 'elbow_r') */
  jointId: string;
  /** Child sensor gyro samples during hinge motion [rad/s] */
  childGyroSamples: THREE.Vector3[];
  /** Gravity vector in child sensor frame (from static pose accelerometer) */
  childGravity: THREE.Vector3;
  /** Parent sensor quaternions during hinge motion (for SARA) */
  parentQuaternions?: THREE.Quaternion[];
  /** Child sensor quaternions during hinge motion (for SARA) */
  childQuaternions?: THREE.Quaternion[];
  /** Side hint for sign disambiguation */
  side?: "left" | "right";
}

// ============================================================================
// ANATOMICAL AXIS TARGETS
// ============================================================================

/**
 * For each joint type, the hinge (flexion) axis direction in ISB bone frame.
 *
 * ISB Conventions (Wu et al., 2002/2005):
 *   Knee:     flexion axis ≈ lateral (mediolateral) — mapped to Z in ZXY
 *   Elbow:    flexion axis ≈ lateral — mapped to Z in ZXY
 *   Ankle:    dorsiflexion axis ≈ lateral — mapped to Z in ZXY
 *   Wrist:    flex/ext axis ≈ lateral — mapped to Z in ZXY
 *
 * Note: "lateral" direction depends on left/right side.
 */
const ANATOMICAL_FLEXION_AXIS: Record<string, THREE.Vector3> = {
  // Knees: flexion around mediolateral axis
  // Left knee: axis points RIGHT (+X in bone frame)
  // Right knee: axis points LEFT (-X in bone frame)
  knee_l: new THREE.Vector3(1, 0, 0),
  knee_r: new THREE.Vector3(-1, 0, 0),

  // Elbows: flexion around mediolateral axis
  elbow_l: new THREE.Vector3(1, 0, 0),
  elbow_r: new THREE.Vector3(-1, 0, 0),

  // Ankles: dorsiflexion around mediolateral axis
  ankle_l: new THREE.Vector3(1, 0, 0),
  ankle_r: new THREE.Vector3(-1, 0, 0),

  // Wrists: flexion around mediolateral axis
  wrist_l: new THREE.Vector3(1, 0, 0),
  wrist_r: new THREE.Vector3(-1, 0, 0),
};

/**
 * Gravity direction in the ISB bone frame for anatomical segments.
 * Used as the secondary axis in Gram-Schmidt frame construction.
 *
 * For standing pose:
 *   - Thigh/Tibia: gravity points along -Y (down the bone)
 *   - Forearm: in T-pose, gravity points along ±X or ±Z depending on arm position
 *
 * These are approximate targets; Gram-Schmidt makes the frame orthogonal.
 */
const ANATOMICAL_GRAVITY_AXIS: Record<string, THREE.Vector3> = {
  // Lower limb: gravity points DOWN along shank/thigh long axis
  knee_l: new THREE.Vector3(0, -1, 0),
  knee_r: new THREE.Vector3(0, -1, 0),
  ankle_l: new THREE.Vector3(0, -1, 0),
  ankle_r: new THREE.Vector3(0, -1, 0),

  // Upper limb: in T-pose, gravity is perpendicular to forearm long axis
  elbow_l: new THREE.Vector3(0, -1, 0),
  elbow_r: new THREE.Vector3(0, -1, 0),
  wrist_l: new THREE.Vector3(0, -1, 0),
  wrist_r: new THREE.Vector3(0, -1, 0),
};

// ============================================================================
// MAIN CALIBRATION FUNCTION
// ============================================================================

/**
 * Calibrate a hinge joint using the best available method.
 *
 * Tries SARA first (requires both parent + child quaternions).
 * Falls back to single-sensor PCA on child gyro data.
 *
 * @param input  Calibration data for the joint
 * @returns      HingeCalibrationResult, or null if insufficient data
 */
export function calibrateHingeJoint(
  input: HingeCalibrationInput,
): HingeCalibrationResult | null {
  const {
    jointId,
    childGyroSamples,
    childGravity,
    parentQuaternions,
    childQuaternions,
    side,
  } = input;

  // Resolve joint definition
  const jointDef = JOINT_DEFINITIONS[jointId];
  if (!jointDef) {
    console.warn(`[HingeCal] Unknown joint: ${jointId}`);
    return null;
  }

  // Resolve anatomical targets (default to generic if not in map)
  const targetFlexionAxis =
    ANATOMICAL_FLEXION_AXIS[jointId] ?? new THREE.Vector3(1, 0, 0);
  const targetGravityAxis =
    ANATOMICAL_GRAVITY_AXIS[jointId] ?? new THREE.Vector3(0, -1, 0);

  // ─── Attempt SARA ───
  let saraResult: SARAResult | null = null;
  let method: "sara" | "single-pca" = "single-pca";

  if (
    parentQuaternions &&
    childQuaternions &&
    parentQuaternions.length >= 20 &&
    childQuaternions.length >= 20
  ) {
    saraResult = computeSARA(parentQuaternions, childQuaternions, 20);

    if (saraResult && saraResult.confidence > 0.4) {
      method = "sara";
      console.debug(
        `[HingeCal] SARA success for ${jointId}: ` +
          `conf=${(saraResult.confidence * 100).toFixed(1)}% ` +
          `σ_max=${saraResult.sigmaMax.toFixed(2)} ` +
          `N=${saraResult.sampleCount}`,
      );
    } else {
      // SARA confidence too low — fall back to PCA
      console.debug(
        `[HingeCal] SARA low confidence for ${jointId} ` +
          `(${saraResult ? (saraResult.confidence * 100).toFixed(1) : 0}%), falling back to PCA`,
      );
      saraResult = null;
    }
  }

  // ─── Get hinge axis in child sensor frame ───
  let hingeAxisChild: THREE.Vector3;
  let hingeAxisParent: THREE.Vector3 | null = null;
  let confidence: number;
  let sampleCount: number;

  if (method === "sara" && saraResult) {
    hingeAxisChild = saraResult.axisInChild.clone();
    hingeAxisParent = saraResult.axisInParent.clone();
    confidence = saraResult.confidence;
    sampleCount = saraResult.sampleCount;
  } else {
    // Single-PCA fallback on child gyro
    const pcaResult = estimateFunctionalAxis(childGyroSamples, true);
    if (pcaResult.confidence < 0.3) {
      console.warn(
        `[HingeCal] PCA confidence too low for ${jointId}: ${(pcaResult.confidence * 100).toFixed(1)}%`,
      );
      return null;
    }
    hingeAxisChild = pcaResult.axis.clone();
    confidence = pcaResult.confidence;
    sampleCount = pcaResult.sampleCount;
    method = "single-pca";
    console.debug(
      `[HingeCal] PCA fallback for ${jointId}: ` +
        `conf=${(confidence * 100).toFixed(1)}% N=${sampleCount}`,
    );
  }

  // ─── Sign disambiguation ───
  // Use gravity to ensure consistent axis direction.
  // For knee/elbow hinge axis (mediolateral), it should be perpendicular to gravity.
  // We use the cross-product convention:
  //   cross(gravity, hingeAxis) should point "forward" for the limb.
  // If it points backward, negate the axis.
  const gravNorm = childGravity.clone().normalize();
  const sideSign = side === "right" ? -1 : 1;

  // Compute cross product of gravity with hinge axis
  const forward = new THREE.Vector3().crossVectors(gravNorm, hingeAxisChild);
  if (forward.length() > 0.1) {
    // Use the dominant component of the cross product to determine "forward"
    // In a standing pose with Y-up, gravity ≈ (0, -1, 0) in sensor frame
    // Cross with lateral axis gives forward direction
    // Adjust sign so that flexion rotation is positive in ISB convention
    const fwdDot = forward.dot(new THREE.Vector3(0, 0, sideSign));
    if (fwdDot < 0) {
      hingeAxisChild.negate();
      if (hingeAxisParent) hingeAxisParent.negate();
    }
  }

  // ─── Build full coordinate frame via Gram-Schmidt ───
  const axisAlignment = constructGramSchmidtFrame(
    hingeAxisChild, // Primary axis: the detected hinge axis
    childGravity, // Secondary reference: gravity
    targetFlexionAxis, // Target: where the hinge axis should map in bone frame
    targetGravityAxis, // Target: where gravity should map in bone frame
  );

  // ─── Quality assessment ───
  const quality = assessHingeQuality(
    childGyroSamples,
    jointDef,
    confidence,
    sampleCount,
    method,
  );

  return {
    axisAlignment,
    hingeAxisChild,
    hingeAxisParent,
    method,
    confidence,
    quality,
  };
}

// ============================================================================
// QUALITY ASSESSMENT
// ============================================================================

function assessHingeQuality(
  gyroSamples: THREE.Vector3[],
  jointDef: JointDefinition,
  confidence: number,
  sampleCount: number,
  method: "sara" | "single-pca",
): HingeCalibrationQuality {
  const warnings: string[] = [];

  // Estimate range of motion from gyro integration
  // (rough approximation — integrate angular velocity magnitudes)
  let totalAngle = 0;
  let maxRate = 0;
  const dt = 1 / 60; // Assume ~60 Hz

  for (const v of gyroSamples) {
    const rate = v.length();
    totalAngle += rate * dt;
    if (rate > maxRate) maxRate = rate;
  }

  // Total angle is sum of absolute rotations. For a back-and-forth motion,
  // actual ROM is roughly totalAngle / (2 * cycles).
  // Rough estimate: ROM ~= totalAngle / 4 (assumes ~2 cycles)
  const romDeg = THREE.MathUtils.radToDeg(totalAngle / 4);

  // Expected ROM for this joint
  const expectedROM = jointDef.flexionRange[1] - jointDef.flexionRange[0];
  const romRatio = Math.min(1, romDeg / (expectedROM * 0.3)); // 30% of full ROM is acceptable

  // Quality scoring
  let score = 0;
  score += confidence * 40; // Axis detection confidence (0–40)
  score += romRatio * 30; // Adequate ROM (0–30)
  score += sampleCount >= 60 ? 15 : (sampleCount / 60) * 15; // Enough samples (0–15)
  score += method === "sara" ? 15 : 8; // SARA bonus (8–15)

  // Warnings
  if (confidence < 0.6) {
    warnings.push(
      `Low axis confidence (${(confidence * 100).toFixed(0)}%). Try slower, smoother flexion.`,
    );
  }
  if (romDeg < 20) {
    warnings.push(
      `Small range of motion (${romDeg.toFixed(0)}°). Try larger movements.`,
    );
  }
  if (sampleCount < 30) {
    warnings.push(`Few samples (${sampleCount}). Move for at least 2 seconds.`);
  }
  if (maxRate > 8) {
    warnings.push("Very fast movement detected. Slower is more accurate.");
  }

  return {
    score: Math.round(Math.min(100, score)),
    hingeDominance: confidence,
    rangeOfMotion: romDeg,
    sampleCount,
    warnings,
  };
}

// ============================================================================
// HELPER: Detect if a joint is a hinge type
// ============================================================================

/** Joints where SARA / single-PCA hinge calibration applies */
export const HINGE_JOINTS = new Set([
  "knee_l",
  "knee_r",
  "elbow_l",
  "elbow_r",
  "ankle_l",
  "ankle_r",
  "wrist_l",
  "wrist_r",
]);

/**
 * Returns true if this joint should use hinge (SARA/PCA) calibration
 * rather than static-only or 2-axis PCA.
 */
export function isHingeJoint(jointId: string): boolean {
  return HINGE_JOINTS.has(jointId);
}

/**
 * Look up the parent segment for a given joint.
 * Returns null if the joint is not defined.
 */
export function getParentSegment(jointId: string): string | null {
  const def = JOINT_DEFINITIONS[jointId];
  return def ? def.parentSegment : null;
}

/**
 * Look up the child segment for a given joint.
 * Returns null if the joint is not defined.
 */
export function getChildSegment(jointId: string): string | null {
  const def = JOINT_DEFINITIONS[jointId];
  return def ? def.childSegment : null;
}
