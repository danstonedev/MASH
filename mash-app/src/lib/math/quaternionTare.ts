/**
 * Quaternion Tare Utilities
 * =========================
 *
 * CENTRALIZED CONVENTION for quaternion tare operations.
 *
 * THE GOLDEN RULE:
 *   tared = sensor × offset
 *   where offset = inverse(sensor_at_tare_time)
 *
 * This applies the offset in the SENSOR'S LOCAL FRAME, which:
 * - Preserves axis relationships regardless of tare pose
 * - Matches ISB and OpenSim conventions
 * - Is consistent with calibrationMath.ts: bone = sensor × offset
 *
 * DO NOT MODIFY THIS CONVENTION without updating:
 * - quaternionConventions.test.ts (unit tests)
 * - PipelineInspector.tsx (Tare Flat button)
 * - SkeletonModel.tsx (mounting offset application)
 * - useDeviceRegistry.ts (tareDevice function)
 *
 * @module quaternionTare
 */

import * as THREE from "three";

/**
 * Compute tare offset from current sensor orientation.
 *
 * @param sensorAtTareTime - Sensor quaternion at the moment of taring
 * @returns Offset quaternion to be applied as: tared = sensor × offset
 */
export function computeTareOffset(
  sensorAtTareTime: THREE.Quaternion,
): THREE.Quaternion {
  return sensorAtTareTime.clone().invert();
}

/**
 * Compute tare offset from array format [w, x, y, z].
 *
 * @param quatArray - Quaternion as [w, x, y, z] array
 * @returns Offset as [w, x, y, z] array (conjugate)
 */
export function computeTareOffsetArray(
  quatArray: [number, number, number, number],
): [number, number, number, number] {
  const [w, x, y, z] = quatArray;
  return [w, -x, -y, -z]; // Conjugate = inverse for unit quaternion
}

/**
 * Apply tare offset using the CORRECT convention.
 *
 * IMPORTANT: This uses sensor × offset (local frame), NOT offset × sensor (world frame)!
 *
 * @param sensor - Current sensor quaternion
 * @param offset - Tare offset from computeTareOffset()
 * @returns Tared quaternion
 */
export function applyTareOffset(
  sensor: THREE.Quaternion,
  offset: THREE.Quaternion,
): THREE.Quaternion {
  // CORRECT: sensor × offset (local frame)
  // WRONG: offset × sensor (world frame - causes Y/Z axis swap!)
  return sensor.clone().multiply(offset);
}

/**
 * Apply tare offset to a quaternion in-place.
 * More efficient when you don't need to preserve the original.
 *
 * @param sensor - Sensor quaternion (will be modified)
 * @param offset - Tare offset
 * @returns The modified sensor quaternion
 */
export function applyTareOffsetInPlace(
  sensor: THREE.Quaternion,
  offset: THREE.Quaternion,
): THREE.Quaternion {
  return sensor.multiply(offset);
}

/**
 * Apply tare offset using array format.
 *
 * @param sensorArray - Current sensor as [w, x, y, z]
 * @param offsetArray - Tare offset as [w, x, y, z]
 * @returns Tared quaternion as [w, x, y, z]
 */
export function applyTareOffsetArrays(
  sensorArray: [number, number, number, number],
  offsetArray: [number, number, number, number],
): [number, number, number, number] {
  // Convert to THREE for multiplication (safer than manual quat multiply)
  const sensor = new THREE.Quaternion(
    sensorArray[1],
    sensorArray[2],
    sensorArray[3],
    sensorArray[0],
  );
  const offset = new THREE.Quaternion(
    offsetArray[1],
    offsetArray[2],
    offsetArray[3],
    offsetArray[0],
  );

  // sensor × offset
  sensor.multiply(offset);

  return [sensor.w, sensor.x, sensor.y, sensor.z];
}

/**
 * One-shot tare: compute offset and apply it.
 *
 * @param sensorAtTare - Sensor orientation at tare time
 * @param sensorNow - Current sensor orientation
 * @returns Tared orientation
 */
export function tare(
  sensorAtTare: THREE.Quaternion,
  sensorNow: THREE.Quaternion,
): THREE.Quaternion {
  const offset = computeTareOffset(sensorAtTare);
  return applyTareOffset(sensorNow, offset);
}

// ============================================================================
// DOCUMENTATION / DEBUGGING
// ============================================================================

/**
 * Get a human-readable explanation of the tare convention.
 * Useful for documentation and debugging.
 */
export function getTareConventionExplanation(): string {
  return `
QUATERNION TARE CONVENTION
==========================

Formula:
  tared = sensor × offset
  where offset = inverse(sensor_at_tare_time)

Why sensor × offset (not offset × sensor)?
------------------------------------------
- sensor × offset: rotates in SENSOR'S LOCAL FRAME
- offset × sensor: rotates in WORLD FRAME

When taring from a non-flat orientation (e.g., vertical):
- LOCAL FRAME: Preserves axis relationships. Y stays Y, Z stays Z.
- WORLD FRAME: Axes get confused. Y might become Z (THE BUG!).

This matches:
- calibrationMath.ts: bone = sensor × offset
- ISB conventions for biomechanics
- OpenSim joint angle decomposition

Test coverage: src/tests/quaternionConventions.test.ts (19 tests)
`;
}

/**
 * Validate that a tare offset was computed correctly.
 *
 * @param sensorAtTare - Original sensor orientation at tare time
 * @param offset - Computed offset
 * @returns True if sensor × offset ≈ identity
 */
export function validateTareOffset(
  sensorAtTare: THREE.Quaternion,
  offset: THREE.Quaternion,
): boolean {
  const result = applyTareOffset(sensorAtTare, offset);
  // Check if result is near identity
  const angle = 2 * Math.acos(Math.min(1, Math.abs(result.w)));
  return angle < 0.001; // Less than 0.06° error
}
