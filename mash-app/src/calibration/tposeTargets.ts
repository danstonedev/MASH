/**
 * Anatomical T-Pose Targets
 * =========================
 *
 * Defines the EXPECTED sensor orientation in Three.js world frame for each body segment
 * when the subject is in a standard T-pose (arms out, facing +Z direction in Three.js).
 *
 * Three.js Coordinate System:
 *   X = Right
 *   Y = Up
 *   Z = Forward (toward camera)
 *
 * ISB-style Segment Orientations:
 *   - Pelvis: X=right, Y=up, Z=forward
 *   - Thigh: X=right, Y=up (same as pelvis in T-pose)
 *   - Tibia: X=right, Y=up
 *   - Foot: X=forward, Y=up (toes pointing forward)
 *   - Upper Arm: X=lateral, Y=up (arm pointing left/right)
 *   - Forearm: X=lateral, Y=up
 *
 * For IMU-to-segment alignment, we assume the sensor's Y-axis aligns with the segment's
 * long axis, and X/Z are determined by the mounting orientation.
 */

import * as THREE from "three";

// ============================================================================
// T-POSE TARGET ORIENTATIONS
// ============================================================================

/**
 * Expected sensor orientation (in Three.js world frame) for each segment in T-pose.
 * These are quaternions representing "what the sensor SHOULD read" when in T-pose.
 *
 * Key assumption: Sensor is mounted with its local Y-axis along the segment's long axis.
 */
export const TPOSE_TARGETS: Record<string, THREE.Quaternion> = (() => {
  const targets: Record<string, THREE.Quaternion> = {};

  // Helper: Create quaternion from Euler angles (degrees)
  const fromEulerDeg = (x: number, y: number, z: number): THREE.Quaternion => {
    const euler = new THREE.Euler(
      (x * Math.PI) / 180,
      (y * Math.PI) / 180,
      (z * Math.PI) / 180,
      "XYZ",
    );
    return new THREE.Quaternion().setFromEuler(euler);
  };

  // =========================================================================
  // CENTRAL SEGMENTS (facing forward, upright)
  // =========================================================================

  // Pelvis/Hips: Facing forward, upright
  targets["pelvis"] = fromEulerDeg(0, 0, 0);

  // Torso/Chest: Same as pelvis
  targets["torso"] = fromEulerDeg(0, 0, 0);
  targets["chest"] = fromEulerDeg(0, 0, 0);

  // Head: Same as pelvis
  targets["head"] = fromEulerDeg(0, 0, 0);

  // =========================================================================
  // LEG SEGMENTS (vertical, sensor Y-axis pointing down)
  // =========================================================================

  // Thighs: Vertical, sensor local Y pointing down (-Y world)
  // Thighs: Vertical, sensor local Y pointing down (-Y world)
  // Target pure X-180 flip (Down) to align with standard vertical stance.
  // This removes the 90-degree Y-twist that was causing "Frog Pose" (splayed legs).
  targets["thigh_l"] = fromEulerDeg(180, 0, 0);
  targets["thigh_r"] = fromEulerDeg(180, 0, 0);

  // Tibias: Same as thighs (straight leg)
  targets["tibia_l"] = fromEulerDeg(180, 0, 0);
  targets["tibia_r"] = fromEulerDeg(180, 0, 0);

  // Feet: Toes point forward (+Z), sensor Y along foot length
  // Pitch 90 (X) aligns Y-axis (Up) to Z-axis (Forward)
  targets["foot_l"] = fromEulerDeg(90, 0, 0);
  targets["foot_r"] = fromEulerDeg(90, 0, 0);

  // =========================================================================
  // ARM SEGMENTS (horizontal, pointing left/right)
  // =========================================================================

  // Upper Arms in T-pose: Pointing left/right (±X)
  // Left arm: Sensor Y-axis pointing +X (rolled 90° around Z)
  targets["upper_arm_l"] = fromEulerDeg(0, 0, 90); // Y-axis now points +X
  targets["upper_arm_r"] = fromEulerDeg(0, 0, -90); // Y-axis now points -X

  // Forearms: Same orientation as upper arms in T-pose
  targets["forearm_l"] = fromEulerDeg(0, 0, 90);
  targets["forearm_r"] = fromEulerDeg(0, 0, -90);

  // Hands: Same as forearms
  targets["hand_l"] = fromEulerDeg(0, 0, 90);
  targets["hand_r"] = fromEulerDeg(0, 0, -90);

  return targets;
})();

/**
 * Get the T-pose target quaternion for a segment.
 * Returns identity quaternion if segment not found.
 */
export function getTposeTarget(segmentId: string): THREE.Quaternion {
  const key = segmentId.toLowerCase();
  return TPOSE_TARGETS[key]?.clone() || new THREE.Quaternion();
}

/**
 * Debug: Print all T-pose targets as Euler angles
 */
export function logTposeTargets(): void {
  console.debug("[TposeTargets] Anatomical targets (Euler degrees):");
  for (const [segment, quat] of Object.entries(TPOSE_TARGETS)) {
    const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
    console.debug(
      `  ${segment}: [${((euler.x * 180) / Math.PI).toFixed(1)}, ${((euler.y * 180) / Math.PI).toFixed(1)}, ${((euler.z * 180) / Math.PI).toFixed(1)}]`,
    );
  }
}
