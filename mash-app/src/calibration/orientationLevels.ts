/**
 * Orientation Levels - The 4 Levels of Truth
 * ===========================================
 *
 * To debug your system, NEVER confuse these four distinct layers.
 * A bug in Level 2 will ruin Level 4, but look correct in Level 1.
 *
 * LEVEL 1: Sensor Orientation (q_sensor / q_imu)
 *   What: Orientation of silicon chip relative to North/Gravity
 *   Source: Madgwick/EKF filter output
 *   Debug: "If I rotate the PCB 45°, does this value change 45°?"
 *   Error: Magnetic interference makes sensor think North rotated
 *
 * LEVEL 2: Anatomical Orientation (q_segment / q_bone)
 *   What: Orientation of HUMAN BONE relative to Global frame
 *   Math: q_bone = q_sensor × R_SB (mounting rotation)
 *   Debug: "In T-Pose, are all q_bone values identical (world-aligned)?"
 *   Error: Wrong mounting calibration
 *
 * LEVEL 3: Relative Orientation (q_joint / q_rel)
 *   What: Rotation of Child bone relative to Parent bone
 *   Math: q_rel = inv(q_parent) × q_child
 *   Debug: "If user jumps and spins but knee stays locked, does this stay constant?"
 *   Error: Wrong parent/child assignment
 *
 * LEVEL 4: Clinical Angles (θ_clinical / flexion_deg)
 *   What: Human-readable numbers (Flexion, Abduction, Rotation)
 *   Math: Euler decomposition using correct sequence (e.g., ZXY for knee)
 *   Debug: "Does pure squat show flexion change but near-zero abduction?"
 *   Error: Wrong Euler sequence causes motion "bleed" between axes
 *
 * @module orientationLevels
 */

import * as THREE from "three";

// ============================================================================
// TYPES FOR EACH LEVEL
// ============================================================================

/**
 * Level 1: Raw sensor orientation from filter
 */
export interface Level1_SensorOrientation {
  readonly level: 1;
  readonly name: "q_sensor";
  quaternion: THREE.Quaternion;
  deviceId: string;
  timestamp: number;
}

/**
 * Level 2: Bone orientation after mounting tare
 */
export interface Level2_BoneOrientation {
  readonly level: 2;
  readonly name: "q_bone";
  quaternion: THREE.Quaternion;
  segmentId: string;
  /** Reference to the sensor this came from */
  sourceDeviceId: string;
}

/**
 * Level 3: Relative joint orientation
 */
export interface Level3_JointOrientation {
  readonly level: 3;
  readonly name: "q_rel";
  quaternion: THREE.Quaternion;
  jointId: string;
  parentSegmentId: string;
  childSegmentId: string;
}

/**
 * Level 4: Clinical angles in degrees
 */
export interface Level4_ClinicalAngles {
  readonly level: 4;
  readonly name: "θ_clinical";
  flexion: number;
  abduction: number;
  rotation: number;
  jointId: string;
  /** Euler order used for decomposition */
  eulerOrder: string;
}

/**
 * Union type for any orientation level
 */
export type OrientationLevel =
  | Level1_SensorOrientation
  | Level2_BoneOrientation
  | Level3_JointOrientation
  | Level4_ClinicalAngles;

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export function createLevel1(
  quaternion: THREE.Quaternion,
  deviceId: string,
  timestamp: number = Date.now(),
): Level1_SensorOrientation {
  return {
    level: 1,
    name: "q_sensor",
    quaternion: quaternion.clone(),
    deviceId,
    timestamp,
  };
}

export function createLevel2(
  quaternion: THREE.Quaternion,
  segmentId: string,
  sourceDeviceId: string,
): Level2_BoneOrientation {
  return {
    level: 2,
    name: "q_bone",
    quaternion: quaternion.clone(),
    segmentId,
    sourceDeviceId,
  };
}

export function createLevel3(
  quaternion: THREE.Quaternion,
  jointId: string,
  parentSegmentId: string,
  childSegmentId: string,
): Level3_JointOrientation {
  return {
    level: 3,
    name: "q_rel",
    quaternion: quaternion.clone(),
    jointId,
    parentSegmentId,
    childSegmentId,
  };
}

export function createLevel4(
  flexion: number,
  abduction: number,
  rotation: number,
  jointId: string,
  eulerOrder: string,
): Level4_ClinicalAngles {
  return {
    level: 4,
    name: "θ_clinical",
    flexion,
    abduction,
    rotation,
    jointId,
    eulerOrder,
  };
}

// ============================================================================
// DEBUG UTILITIES
// ============================================================================

/**
 * Debug table for each level
 */
export const DEBUG_QUESTIONS: Record<1 | 2 | 3 | 4, string> = {
  1: "If I tilt the chip up, does the virtual box tilt up?",
  2: "If I stand in T-pose, are all bones aligned to the grid?",
  3: "If I spin the whole body, does the knee angle stay constant?",
  4: "Does the graph allow for >120° of flexion without flipping?",
};

/**
 * Common bugs per level
 */
export const COMMON_BUGS: Record<1 | 2 | 3 | 4, string[]> = {
  1: [
    "Magnetic interference (nearby metal/electronics)",
    "Wrong coordinate frame convention",
    "Filter divergence (check beta value)",
  ],
  2: [
    "Mounting tare captured with sensor moving",
    "Wrong target pose expected during T-pose",
    "Coordinate system mismatch (sensor vs Three.js)",
  ],
  3: [
    "Parent/child segments swapped",
    "Wrong segment assigned to sensor",
    "Missing heading tare causing global rotation leak",
  ],
  4: [
    "Wrong Euler sequence (XYZ vs ZXY)",
    "Gimbal lock near ±90° pitch",
    "Sign convention reversed (flexion vs extension)",
  ],
};

/**
 * Log orientation at a specific level with debug info
 */
export function debugLog(orientation: OrientationLevel): void {
  const levelEmoji = ["", "🔵", "🟢", "🟡", "📊"][orientation.level];

  console.group(
    `${levelEmoji} Level ${orientation.level}: ${orientation.name}`,
  );

  switch (orientation.level) {
    case 1:
      const l1 = orientation as Level1_SensorOrientation;
      console.debug(`Device: ${l1.deviceId}`);
      console.debug(
        `Quaternion: [${l1.quaternion.w.toFixed(3)}, ${l1.quaternion.x.toFixed(3)}, ${l1.quaternion.y.toFixed(3)}, ${l1.quaternion.z.toFixed(3)}]`,
      );
      break;
    case 2:
      const l2 = orientation as Level2_BoneOrientation;
      console.debug(`Segment: ${l2.segmentId} (from ${l2.sourceDeviceId})`);
      console.debug(
        `Quaternion: [${l2.quaternion.w.toFixed(3)}, ${l2.quaternion.x.toFixed(3)}, ${l2.quaternion.y.toFixed(3)}, ${l2.quaternion.z.toFixed(3)}]`,
      );
      break;
    case 3:
      const l3 = orientation as Level3_JointOrientation;
      console.debug(
        `Joint: ${l3.jointId} (${l3.parentSegmentId} → ${l3.childSegmentId})`,
      );
      console.debug(
        `Quaternion: [${l3.quaternion.w.toFixed(3)}, ${l3.quaternion.x.toFixed(3)}, ${l3.quaternion.y.toFixed(3)}, ${l3.quaternion.z.toFixed(3)}]`,
      );
      break;
    case 4:
      const l4 = orientation as Level4_ClinicalAngles;
      console.debug(`Joint: ${l4.jointId} (Euler: ${l4.eulerOrder})`);
      console.debug(
        `Flexion: ${l4.flexion.toFixed(1)}° | Abduction: ${l4.abduction.toFixed(1)}° | Rotation: ${l4.rotation.toFixed(1)}°`,
      );
      break;
  }

  console.debug(`🔍 Debug: ${DEBUG_QUESTIONS[orientation.level]}`);
  console.groupEnd();
}
