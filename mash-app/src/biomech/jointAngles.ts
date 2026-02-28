/**
 * Joint Angle Calculations - Computes joint angles from segment quaternions.
 *
 * Joint angles are calculated as the relative rotation between parent and child segments.
 * For biomechanical analysis, we decompose rotations into anatomical planes:
 * - Sagittal plane: Flexion/Extension (rotation around lateral axis)
 * - Frontal plane: Abduction/Adduction (rotation around anterior-posterior axis)
 * - Transverse plane: Internal/External Rotation (rotation around longitudinal axis)
 */

import * as THREE from "three";

export interface JointAngles {
  // Sagittal plane - primary movement for most joints
  flexion: number; // degrees, positive = flexion

  // Frontal plane
  abduction: number; // degrees, positive = abduction

  // Transverse plane
  rotation: number; // degrees, positive = internal rotation

  // Gimbal lock warning (optional)
  gimbalWarning?: string;
}

export interface JointDefinition {
  name: string;
  parentSegment: string;
  childSegment: string;

  // Anatomical descriptions
  flexionName: string; // e.g., "Flexion/Extension"
  abductionName: string; // e.g., "Abduction/Adduction"
  rotationName: string; // e.g., "Int/Ext Rotation"

  // Normal ROM ranges [min, max] in degrees
  flexionRange: [number, number];
  abductionRange: [number, number];
  rotationRange: [number, number];

  // Optional offsets for anatomical alignment
  flexionOffset?: number; // Added to raw flexion value
  abductionOffset?: number; // Added to raw abduction value
  rotationOffset?: number; // Added to raw rotation value
}

/**
 * Joint definitions for lower body
 */
export const JOINT_DEFINITIONS: Record<string, JointDefinition> = {
  hip_l: {
    name: "Left Hip",
    parentSegment: "pelvis",
    childSegment: "thigh_l",
    flexionName: "Flexion/Extension",
    abductionName: "Abduction/Adduction",
    rotationName: "Int/Ext Rotation",
    flexionRange: [-20, 120], // Extension (-20) to Flexion (120)
    abductionRange: [-30, 45], // Adduction (-30) to Abduction (45)
    rotationRange: [-45, 45], // External (-45) to Internal (45)
    flexionOffset: 180, // Correct for thigh pointing down from pelvis
    // rotationOffset removed - raw rotation is already ~0° in T-pose
  },
  hip_r: {
    name: "Right Hip",
    parentSegment: "pelvis",
    childSegment: "thigh_r",
    flexionName: "Flexion/Extension",
    abductionName: "Abduction/Adduction",
    rotationName: "Int/Ext Rotation",
    flexionRange: [-20, 120],
    abductionRange: [-30, 45],
    rotationRange: [-45, 45],
    flexionOffset: 180, // Correct for thigh pointing down from pelvis
    // rotationOffset removed - raw rotation is already ~0° in T-pose
  },
  knee_l: {
    name: "Left Knee",
    parentSegment: "thigh_l",
    childSegment: "tibia_l",
    flexionName: "Flexion/Extension",
    abductionName: "Varus/Valgus",
    rotationName: "Int/Ext Rotation",
    flexionRange: [0, 140], // Extension (0) to Flexion (140)
    abductionRange: [-10, 10], // Limited frontal plane motion
    rotationRange: [-30, 30], // Limited rotation when flexed
  },
  knee_r: {
    name: "Right Knee",
    parentSegment: "thigh_r",
    childSegment: "tibia_r",
    flexionName: "Flexion/Extension",
    abductionName: "Varus/Valgus",
    rotationName: "Int/Ext Rotation",
    flexionRange: [0, 140],
    abductionRange: [-10, 10],
    rotationRange: [-30, 30],
  },
  ankle_l: {
    name: "Left Ankle",
    parentSegment: "tibia_l",
    childSegment: "foot_l",
    flexionName: "Dorsi/Plantarflexion",
    abductionName: "Inversion/Eversion",
    rotationName: "Int/Ext Rotation",
    flexionRange: [-50, 20], // Plantarflex (-50) to Dorsiflex (20)
    abductionRange: [-20, 20], // Eversion (-20) to Inversion (20)
    rotationRange: [-20, 20],
    abductionOffset: -60, // Correct for foot pointing forward in T-pose
  },
  ankle_r: {
    name: "Right Ankle",
    parentSegment: "tibia_r",
    childSegment: "foot_r",
    flexionName: "Dorsi/Plantarflexion",
    abductionName: "Inversion/Eversion",
    rotationName: "Int/Ext Rotation",
    flexionRange: [-50, 20],
    abductionRange: [-20, 20],
    rotationRange: [-20, 20],
    abductionOffset: -60, // Correct for foot pointing forward in T-pose
  },
  // --- Upper Body ---
  // Pelvis orientation (global reference - uses identity for parent)
  pelvis_orientation: {
    name: "Pelvis Orientation",
    parentSegment: "world", // Special: world reference
    childSegment: "pelvis",
    flexionName: "Anterior/Posterior Tilt",
    abductionName: "Lateral Tilt",
    rotationName: "Axial Rotation",
    flexionRange: [-30, 30], // Posterior (-30) to Anterior (30) tilt
    abductionRange: [-30, 30], // Contralateral (-) to Ipsilateral (+) drop
    rotationRange: [-45, 45], // Left (-) to Right (+) rotation
  },
  lumbar: {
    name: "Lumbar Spine",
    parentSegment: "pelvis",
    childSegment: "torso",
    flexionName: "Flex/Ext",
    abductionName: "Side Bend",
    rotationName: "Rotation",
    flexionRange: [-30, 90],
    abductionRange: [-30, 30],
    rotationRange: [-45, 45],
  },
  // Thoracic spine - Direct measurement when T2 sensor is present
  thoracic: {
    name: "Thoracic Spine",
    parentSegment: "torso", // Chest/T7 sensor
    childSegment: "spine_upper", // T2 sensor
    flexionName: "Flex/Ext",
    abductionName: "Side Bend",
    rotationName: "Rotation",
    flexionRange: [-40, 60],
    abductionRange: [-30, 30],
    rotationRange: [-45, 45],
  },
  // Cervicothoracic - Updated to use T2 as parent when available
  cervical: {
    name: "Cervical Spine",
    parentSegment: "spine_upper", // T2 sensor (or fallback to torso)
    childSegment: "head",
    flexionName: "Flex/Ext",
    abductionName: "Side Bend",
    rotationName: "Rotation",
    flexionRange: [-60, 70],
    abductionRange: [-45, 45],
    rotationRange: [-80, 80],
  },
  // Total spine motion (pelvis → head) - useful summary metric
  total_spine: {
    name: "Total Spine",
    parentSegment: "pelvis",
    childSegment: "head",
    flexionName: "Flex/Ext",
    abductionName: "Side Bend",
    rotationName: "Rotation",
    flexionRange: [-90, 120],
    abductionRange: [-60, 60],
    rotationRange: [-90, 90],
  },
  shoulder_l: {
    name: "Left Shoulder",
    parentSegment: "torso",
    childSegment: "upper_arm_l",
    flexionName: "Flexion/Extension",
    abductionName: "Abduction/Adduction",
    rotationName: "Int/Ext Rotation",
    flexionRange: [-60, 180],
    abductionRange: [-10, 180],
    rotationRange: [-90, 90],
    flexionOffset: 90, // Correct for arm pointing sideways in T-pose
    rotationOffset: 180, // Correct for 180° offset in arm rotation
  },
  shoulder_r: {
    name: "Right Shoulder",
    parentSegment: "torso",
    childSegment: "upper_arm_r",
    flexionName: "Flexion/Extension",
    abductionName: "Abduction/Adduction",
    rotationName: "Int/Ext Rotation",
    flexionRange: [-60, 180],
    abductionRange: [-10, 180],
    rotationRange: [-90, 90],
    flexionOffset: -90, // Correct for arm pointing sideways in T-pose
    rotationOffset: 180, // Correct for 180° offset in arm rotation
  },
  elbow_l: {
    name: "Left Elbow",
    parentSegment: "upper_arm_l",
    childSegment: "forearm_l",
    flexionName: "Flexion/Extension",
    abductionName: "Varus/Valgus",
    rotationName: "Pronation/Supination",
    flexionRange: [0, 150],
    abductionRange: [-10, 10],
    rotationRange: [-90, 90],
  },
  elbow_r: {
    name: "Right Elbow",
    parentSegment: "upper_arm_r",
    childSegment: "forearm_r",
    flexionName: "Flexion/Extension",
    abductionName: "Varus/Valgus",
    rotationName: "Pronation/Supination",
    flexionRange: [0, 150],
    abductionRange: [-10, 10],
    rotationRange: [-90, 90],
  },
  wrist_l: {
    name: "Left Wrist",
    parentSegment: "forearm_l",
    childSegment: "hand_l",
    flexionName: "Flexion/Extension",
    abductionName: "Radial/Ulnar Deviation",
    rotationName: "Pronation/Supination",
    flexionRange: [-80, 80], // Extension (-80) to Flexion (80)
    abductionRange: [-30, 25], // Ulnar (-30) to Radial (25) deviation
    rotationRange: [-90, 90], // Combined forearm/wrist rotation
  },
  wrist_r: {
    name: "Right Wrist",
    parentSegment: "forearm_r",
    childSegment: "hand_r",
    flexionName: "Flexion/Extension",
    abductionName: "Radial/Ulnar Deviation",
    rotationName: "Pronation/Supination",
    flexionRange: [-80, 80],
    abductionRange: [-30, 25],
    rotationRange: [-90, 90],
  },
};

/**
 * ISB Joint Coordinate System (JCS) Euler Sequences
 *
 * Reference: Grood & Suntay (1983), Wu et al. (2002, 2005)
 *
 * Lower limb uses ZXY order:
 *   Z = Flexion/Extension (floating axis)
 *   X = Abduction/Adduction (tibial-fixed)
 *   Y = Internal/External Rotation
 */
export const JCS_EULER_ORDERS: Record<string, THREE.EulerOrder> = {
  // Lower limb: Z-X-Y (Grood & Suntay)
  hip_l: "ZXY",
  hip_r: "ZXY",
  knee_l: "XZY", // X=Flexion, Z=Abduction, Y=Rotation (Avoids Gimbal Lock at 90 deg flexion)
  knee_r: "XZY",
  ankle_l: "ZXY",
  ankle_r: "ZXY",

  // Upper limb (ISB recommendations)
  shoulder_l: "YXZ",
  shoulder_r: "YXZ",
  elbow_l: "ZXY",
  elbow_r: "ZXY",
  wrist_l: "ZXY",
  wrist_r: "ZXY",

  // Spine (ISB recommendations: XZY for spinal segments)
  // X = lateral bending, Z = flexion/extension, Y = axial rotation
  lumbar: "XZY",
  thoracic: "XZY",
};

/**
 * Calculate the relative rotation between parent and child segments.
 * Returns angles in degrees decomposed into anatomical planes using
 * ISB-compliant Joint Coordinate System (JCS).
 *
 * @param parentQuat - Parent segment orientation
 * @param childQuat - Child segment orientation
 * @param jointId - Optional joint ID for JCS-specific Euler order
 */
export function calculateJointAngle(
  parentQuat: THREE.Quaternion,
  childQuat: THREE.Quaternion,
  jointId?: string,
): JointAngles {
  // Relative rotation: q_rel = q_parent^-1 * q_child
  const parentInv = parentQuat.clone().invert();
  const relativeQuat = parentInv.multiply(childQuat.clone());

  // Get joint-specific Euler order (default to XYZ for backwards compatibility)
  const eulerOrder = jointId ? JCS_EULER_ORDERS[jointId] || "XYZ" : "XYZ";

  // Convert to Euler angles using JCS order
  const euler = new THREE.Euler().setFromQuaternion(relativeQuat, eulerOrder);

  // Convert to degrees
  const rad2deg = 180 / Math.PI;

  // Extract angles based on Euler order
  let flexion: number, abduction: number, rotation: number;

  if (eulerOrder === "ZXY") {
    // Grood & Suntay: Z=flexion, X=abduction, Y=rotation (Standard JCS)
    flexion = euler.z * rad2deg;
    abduction = euler.x * rad2deg;
    rotation = euler.y * rad2deg;
  } else if (eulerOrder === "XZY") {
    // XZY order: Used for knee (gimbal-optimized) AND spine (ISB standard)
    // For knee: X=Flexion, Z=Abduction, Y=Rotation (avoids gimbal lock at 90° flexion)
    // For spine: X=Lateral bending, Z=Flexion/Extension, Y=Axial rotation
    // Note: Semantic mapping depends on joint; calling code may need to reinterpret.
    flexion = euler.z * rad2deg; // Z = primary motion (flex/ext for spine)
    abduction = euler.x * rad2deg; // X = secondary (lat bend for spine)
    rotation = euler.y * rad2deg; // Y = tertiary (rotation)
  } else if (eulerOrder === "YXZ") {
    // Shoulder: Y=flexion, X=abduction, Z=rotation
    flexion = euler.y * rad2deg;
    abduction = euler.x * rad2deg;
    rotation = euler.z * rad2deg;
  } else {
    // Legacy XYZ fallback
    flexion = euler.x * rad2deg;
    abduction = euler.y * rad2deg;
    rotation = euler.z * rad2deg;
  }

  // Normalize rotation to ±180° range
  rotation = clampAngle(rotation);

  // Check for gimbal lock (near ±90° on MIDDLE axis of Euler sequence)
  // Middle axis varies by Euler order:
  //   ZXY: middle = X (abduction)
  //   XZY: middle = Z (abduction)
  //   YXZ: middle = X (abduction)
  //   XYZ: middle = Y
  let gimbalWarning: string | undefined;
  let middleAxisAngle: number;
  let middleAxisName: string;

  if (eulerOrder === "XZY") {
    // For knee: middle axis is Z (abduction/varus-valgus)
    middleAxisAngle = abduction;
    middleAxisName = "abduction";
  } else {
    // ZXY, YXZ, XYZ all have X or Y in middle which maps to abduction
    middleAxisAngle = abduction;
    middleAxisName = "abduction";
  }

  const absMiddle = Math.abs(middleAxisAngle);
  if (absMiddle > 80 && absMiddle < 100) {
    gimbalWarning = `⚠️ GIMBAL LOCK: ${middleAxisName}=${absMiddle.toFixed(1)}° (near ±90°). Flexion/rotation unreliable.`;
  } else if (absMiddle > 70) {
    gimbalWarning = `Approaching gimbal lock (${middleAxisName}=${absMiddle.toFixed(1)}°).`;
  }

  return {
    flexion,
    abduction,
    rotation,
    gimbalWarning,
  };
}

/**
 * Calculate joint angles for all defined joints given segment quaternions
 */
export function calculateAllJointAngles(
  segmentQuaternions: Map<string, THREE.Quaternion>,
): Map<string, JointAngles> {
  const jointAngles = new Map<string, JointAngles>();

  for (const [jointId, definition] of Object.entries(JOINT_DEFINITIONS)) {
    const parentQuat = segmentQuaternions.get(definition.parentSegment);
    const childQuat = segmentQuaternions.get(definition.childSegment);

    if (parentQuat && childQuat) {
      const angles = calculateJointAngle(parentQuat, childQuat);

      // Apply specific offsets if defined
      if (definition.rotationOffset) {
        angles.rotation = clampAngle(
          angles.rotation + definition.rotationOffset,
        );
      }

      jointAngles.set(jointId, angles);
    }
  }

  return jointAngles;
}

/**
 * Get a formatted string for displaying a joint angle
 */
export function formatAngle(degrees: number, decimals: number = 1): string {
  const sign = degrees >= 0 ? "+" : "";
  return `${sign}${degrees.toFixed(decimals)}°`;
}

/**
 * Clamp angle to reasonable display range
 */
export function clampAngle(angle: number): number {
  // Clamp to ±180 degrees
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;
  return angle;
}

/**
 * Gimbal lock severity levels
 */
export type GimbalLockSeverity = "none" | "warning" | "critical";

/**
 * Detect gimbal lock condition for a given Euler decomposition.
 *
 * Gimbal lock occurs when the middle axis of an Euler sequence reaches ±90°,
 * causing the first and third axes to become parallel (loss of DOF).
 *
 * @param middleAxisAngle The angle of the middle axis in degrees
 * @param warningThreshold Degrees from 90° to trigger warning (default: 20°)
 * @param criticalThreshold Degrees from 90° to trigger critical (default: 10°)
 * @returns Severity level and detailed info
 */
export function detectGimbalLock(
  middleAxisAngle: number,
  warningThreshold: number = 20,
  criticalThreshold: number = 10,
): {
  severity: GimbalLockSeverity;
  distanceFrom90: number;
  message: string;
} {
  const absAngle = Math.abs(middleAxisAngle);
  const distanceFrom90 = Math.abs(90 - absAngle);

  if (distanceFrom90 < criticalThreshold) {
    return {
      severity: "critical",
      distanceFrom90,
      message: `GIMBAL LOCK: Middle axis at ${absAngle.toFixed(1)}° (${distanceFrom90.toFixed(1)}° from singularity). First/third axis angles unreliable.`,
    };
  } else if (distanceFrom90 < warningThreshold) {
    return {
      severity: "warning",
      distanceFrom90,
      message: `Approaching gimbal lock: Middle axis at ${absAngle.toFixed(1)}° (${distanceFrom90.toFixed(1)}° from singularity).`,
    };
  }

  return {
    severity: "none",
    distanceFrom90,
    message: "",
  };
}

/**
 * Get the middle axis index for a given Euler order.
 * The middle axis is where gimbal lock occurs at ±90°.
 */
export function getMiddleAxisForEulerOrder(
  order: THREE.EulerOrder,
): "x" | "y" | "z" {
  // Euler order ABC means: rotate around A, then B, then C
  // Middle axis is B
  const orderStr = order.toLowerCase();
  return orderStr[1] as "x" | "y" | "z";
}
