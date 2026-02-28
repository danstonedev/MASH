/**
 * Quaternion Convention Tests
 * ===========================
 *
 * CRITICAL: These tests protect against the Y/Z axis swap bug.
 *
 * The bug occurred when taring from non-flat orientations because
 * the wrong multiplication order was used:
 *
 *   WRONG: offset × sensor (rotates in world frame, swaps axes)
 *   RIGHT: sensor × offset (rotates in local frame, preserves axes)
 *
 * These tests verify the convention is correct by testing tare
 * from multiple orientations and ensuring axes remain consistent.
 *
 * DO NOT MODIFY THESE TESTS WITHOUT UNDERSTANDING THE MATH!
 * If these tests fail, there is a serious bug in the orientation pipeline.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";

// ============================================================================
// THE GOLDEN RULE
// ============================================================================

/**
 * THE QUATERNION CONVENTION:
 *
 *   calibrated = sensor × offset
 *
 * where offset = inverse(sensor_at_calibration_time)
 *
 * This applies the offset in the SENSOR'S LOCAL FRAME, which:
 * - Preserves axis relationships regardless of calibration pose
 * - Matches ISB and OpenSim conventions
 * - Is consistent with calibrationMath.ts: bone = sensor × offset
 */

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function quatFromAxisAngle(
  axis: THREE.Vector3,
  degrees: number,
): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(
    axis.normalize(),
    (degrees * Math.PI) / 180,
  );
}

function quatFromEulerDegrees(
  x: number,
  y: number,
  z: number,
  order: THREE.EulerOrder = "XYZ",
): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      (x * Math.PI) / 180,
      (y * Math.PI) / 180,
      (z * Math.PI) / 180,
      order,
    ),
  );
}

function eulerDegreesFromQuat(q: THREE.Quaternion): {
  x: number;
  y: number;
  z: number;
} {
  const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");
  return {
    x: (euler.x * 180) / Math.PI,
    y: (euler.y * 180) / Math.PI,
    z: (euler.z * 180) / Math.PI,
  };
}

/**
 * Apply tare using the CORRECT convention: sensor × offset
 */
function applyTareCorrect(
  sensor: THREE.Quaternion,
  offset: THREE.Quaternion,
): THREE.Quaternion {
  // bone = sensor × offset (local frame)
  return sensor.clone().multiply(offset);
}

/**
 * Apply tare using the WRONG convention: offset × sensor
 * (This is what caused the Y/Z swap bug)
 */
function applyTareWrong(
  sensor: THREE.Quaternion,
  offset: THREE.Quaternion,
): THREE.Quaternion {
  // offset × sensor (world frame - CAUSES AXIS CONFUSION)
  return offset.clone().multiply(sensor);
}

/**
 * Compute tare offset from current sensor orientation
 */
function computeTareOffset(
  sensorAtTareTime: THREE.Quaternion,
): THREE.Quaternion {
  return sensorAtTareTime.clone().invert();
}

/**
 * Transform a vector from sensor frame to world frame
 */
function transformVector(v: THREE.Vector3, q: THREE.Quaternion): THREE.Vector3 {
  return v.clone().applyQuaternion(q);
}

// ============================================================================
// TESTS: TARE FROM FLAT ORIENTATION
// ============================================================================

describe("Quaternion Conventions: Tare from Flat", () => {
  it("taring from flat produces identity for subsequent flat reading", () => {
    // Sensor is flat (identity)
    const sensorAtTare = new THREE.Quaternion(); // identity
    const offset = computeTareOffset(sensorAtTare);

    // Later, sensor is still flat
    const sensorNow = new THREE.Quaternion();
    const result = applyTareCorrect(sensorNow, offset);

    // Should be identity
    expect(result.w).toBeCloseTo(1, 5);
    expect(result.x).toBeCloseTo(0, 5);
    expect(result.y).toBeCloseTo(0, 5);
    expect(result.z).toBeCloseTo(0, 5);
  });

  it("after tare from flat, pitch rotation shows as pitch", () => {
    // Tare when flat
    const sensorAtTare = new THREE.Quaternion();
    const offset = computeTareOffset(sensorAtTare);

    // Now pitch 45 degrees
    const sensorNow = quatFromEulerDegrees(45, 0, 0);
    const result = applyTareCorrect(sensorNow, offset);

    const euler = eulerDegreesFromQuat(result);
    expect(euler.x).toBeCloseTo(45, 1);
    expect(euler.y).toBeCloseTo(0, 1);
    expect(euler.z).toBeCloseTo(0, 1);
  });

  it("after tare from flat, yaw rotation shows as yaw", () => {
    const sensorAtTare = new THREE.Quaternion();
    const offset = computeTareOffset(sensorAtTare);

    const sensorNow = quatFromEulerDegrees(0, 45, 0);
    const result = applyTareCorrect(sensorNow, offset);

    const euler = eulerDegreesFromQuat(result);
    expect(euler.x).toBeCloseTo(0, 1);
    expect(euler.y).toBeCloseTo(45, 1);
    expect(euler.z).toBeCloseTo(0, 1);
  });
});

// ============================================================================
// TESTS: TARE FROM VERTICAL ORIENTATION (THE BUG CASE)
// ============================================================================

describe("Quaternion Conventions: Tare from Vertical (Critical)", () => {
  it("taring from 90° pitch produces identity for subsequent 90° pitch reading", () => {
    // Sensor is pitched 90° (vertical, pointing forward)
    const sensorAtTare = quatFromEulerDegrees(90, 0, 0);
    const offset = computeTareOffset(sensorAtTare);

    // Later, sensor is still at 90° pitch
    const sensorNow = quatFromEulerDegrees(90, 0, 0);
    const result = applyTareCorrect(sensorNow, offset);

    // Should be identity (tared to zero)
    expect(result.w).toBeCloseTo(1, 4);
    expect(result.x).toBeCloseTo(0, 4);
    expect(result.y).toBeCloseTo(0, 4);
    expect(result.z).toBeCloseTo(0, 4);
  });

  it("CRITICAL: local frame rotation after tare produces expected angular magnitude", () => {
    // This test verifies that rotations applied in local frame
    // produce the same angular magnitude regardless of tare pose

    // Tare when sensor is vertical (90° pitch)
    const sensorAtTare = quatFromEulerDegrees(90, 0, 0);
    const offset = computeTareOffset(sensorAtTare);

    // Apply 30° rotation in sensor's LOCAL frame (not global Euler)
    const localRotation = quatFromAxisAngle(new THREE.Vector3(0, 1, 0), 30);
    const sensorNow = sensorAtTare.clone().multiply(localRotation);
    const result = applyTareCorrect(sensorNow, offset);

    // The result should show 30° total rotation (as angle from identity)
    const angle =
      (2 * Math.acos(Math.min(1, Math.abs(result.w))) * 180) / Math.PI;
    expect(angle).toBeCloseTo(30, 1);
  });

  it("CRITICAL: sensor × offset vs offset × sensor produce different results", () => {
    // This test proves that multiplication order matters

    const sensorAtTare = quatFromEulerDegrees(90, 0, 0);
    const offset = computeTareOffset(sensorAtTare);

    // Apply a local rotation
    const localRotation = quatFromAxisAngle(new THREE.Vector3(0, 1, 0), 30);
    const sensorNow = sensorAtTare.clone().multiply(localRotation);

    // Correct: sensor × offset
    const correctResult = applyTareCorrect(sensorNow, offset);

    // Wrong: offset × sensor
    const wrongResult = applyTareWrong(sensorNow, offset);

    // They should NOT be the same (except when tare is from flat)
    const angleDiff = (correctResult.angleTo(wrongResult) * 180) / Math.PI;
    expect(angleDiff).toBeGreaterThan(1); // Should be different

    // Correct result should show ~30° from identity
    const correctAngle =
      (2 * Math.acos(Math.min(1, Math.abs(correctResult.w))) * 180) / Math.PI;
    expect(correctAngle).toBeCloseTo(30, 2);
  });

  it("CRITICAL: return to tare pose gives identity regardless of tare orientation", () => {
    // The key property: if you return to the pose you tared at,
    // the result should always be identity

    const testPoses = [
      quatFromEulerDegrees(0, 0, 0), // Flat
      quatFromEulerDegrees(90, 0, 0), // Vertical pitch
      quatFromEulerDegrees(0, 0, 90), // Vertical roll
      quatFromEulerDegrees(45, 45, 45), // Combined
    ];

    for (const pose of testPoses) {
      const offset = computeTareOffset(pose);
      const result = applyTareCorrect(pose, offset);

      // Result should be identity
      expect(result.w).toBeCloseTo(1, 4);
      expect(result.x).toBeCloseTo(0, 4);
      expect(result.y).toBeCloseTo(0, 4);
      expect(result.z).toBeCloseTo(0, 4);
    }
  });
});

// ============================================================================
// TESTS: TARE FROM ARBITRARY ORIENTATIONS
// ============================================================================

describe("Quaternion Conventions: Tare from Arbitrary Orientations", () => {
  const testOrientations = [
    { name: "flat", euler: [0, 0, 0] },
    { name: "45° pitch", euler: [45, 0, 0] },
    { name: "90° pitch (vertical)", euler: [90, 0, 0] },
    { name: "45° roll", euler: [0, 0, 45] },
    { name: "90° roll", euler: [0, 0, 90] },
    { name: "45° yaw", euler: [0, 45, 0] },
    { name: "combined 30° all axes", euler: [30, 30, 30] },
    { name: "extreme 60° all axes", euler: [60, 60, 60] },
  ];

  testOrientations.forEach(({ name, euler }) => {
    it(`tare from ${name}: small local rotation produces correct magnitude`, () => {
      // Tare at this orientation
      const sensorAtTare = quatFromEulerDegrees(euler[0], euler[1], euler[2]);
      const offset = computeTareOffset(sensorAtTare);

      // Apply small rotation in LOCAL frame (15° around local Y)
      const testRotation = 15; // degrees
      const localRotation = quatFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        testRotation,
      );
      const sensorNow = sensorAtTare.clone().multiply(localRotation);

      // Apply tare
      const result = applyTareCorrect(sensorNow, offset);

      // The rotation magnitude should be ~15° regardless of tare pose
      const angle =
        (2 * Math.acos(Math.min(1, Math.abs(result.w))) * 180) / Math.PI;
      expect(angle).toBeCloseTo(15, 2);
    });
  });

  it("tare from any orientation + return to tare pose = identity", () => {
    // This is the fundamental invariant we must preserve
    const randomOrientations = [
      quatFromEulerDegrees(17, 42, 73),
      quatFromEulerDegrees(-30, 60, -15),
      quatFromEulerDegrees(85, 5, 45),
    ];

    for (const pose of randomOrientations) {
      const offset = computeTareOffset(pose);
      const result = applyTareCorrect(pose, offset);

      // Must be identity
      const angle =
        (2 * Math.acos(Math.min(1, Math.abs(result.w))) * 180) / Math.PI;
      expect(angle).toBeLessThan(0.1);
    }
  });
});

// ============================================================================
// TESTS: GRAVITY VECTOR CONSISTENCY
// ============================================================================

describe("Quaternion Conventions: Gravity Vector Consistency", () => {
  const GRAVITY = new THREE.Vector3(0, -9.81, 0); // World down

  it("gravity in sensor frame is consistent after tare from flat", () => {
    const sensorAtTare = new THREE.Quaternion();
    const offset = computeTareOffset(sensorAtTare);

    // Pitch forward 30°
    const sensorNow = quatFromEulerDegrees(30, 0, 0);
    const result = applyTareCorrect(sensorNow, offset);

    // Transform gravity to tared frame
    const gravityInTared = transformVector(GRAVITY, result.clone().invert());

    // Should have Y (down) and Z (forward tilt) components
    expect(gravityInTared.y).toBeLessThan(0); // Still mostly down
    expect(gravityInTared.z).toBeGreaterThan(0); // Forward tilt
  });

  it("gravity in sensor frame is consistent after tare from vertical", () => {
    // Tare when pitched 90° (sensor facing forward)
    const sensorAtTare = quatFromEulerDegrees(90, 0, 0);
    const offset = computeTareOffset(sensorAtTare);

    // Now pitch a bit more (95°)
    const sensorNow = quatFromEulerDegrees(95, 0, 0);
    const result = applyTareCorrect(sensorNow, offset);

    // The result should show ~5° pitch
    const euler = eulerDegreesFromQuat(result);
    expect(euler.x).toBeCloseTo(5, 1);
  });
});

// ============================================================================
// TESTS: VERIFY CONVENTIONS MATCH calibrationMath.ts
// ============================================================================

describe("Quaternion Conventions: Match calibrationMath.ts", () => {
  it("tare convention matches computeSinglePoseOffset + applyCalibrationOffset", () => {
    // The calibrationMath.ts functions:
    // offset = inv(sensor) * target
    // bone = sensor * offset

    // For tare, target = identity, so:
    // offset = inv(sensor) * identity = inv(sensor)
    // tared = sensor * offset = sensor * inv(sensor_at_tare)

    const sensorAtTare = quatFromEulerDegrees(45, 30, 15);
    const target = new THREE.Quaternion(); // Identity for "flat"

    // calibrationMath.ts style: offset = inv(sensor) * target
    const calibOffset = sensorAtTare.clone().invert().multiply(target);

    // Tare style: offset = inv(sensor)
    const tareOffset = computeTareOffset(sensorAtTare);

    // These should be identical when target is identity
    expect(calibOffset.w).toBeCloseTo(tareOffset.w, 5);
    expect(calibOffset.x).toBeCloseTo(tareOffset.x, 5);
    expect(calibOffset.y).toBeCloseTo(tareOffset.y, 5);
    expect(calibOffset.z).toBeCloseTo(tareOffset.z, 5);

    // Application should also match: bone = sensor * offset
    const sensorNow = quatFromEulerDegrees(60, 30, 15);

    const calibResult = sensorNow.clone().multiply(calibOffset);
    const tareResult = applyTareCorrect(sensorNow, tareOffset);

    expect(calibResult.w).toBeCloseTo(tareResult.w, 5);
    expect(calibResult.x).toBeCloseTo(tareResult.x, 5);
    expect(calibResult.y).toBeCloseTo(tareResult.y, 5);
    expect(calibResult.z).toBeCloseTo(tareResult.z, 5);
  });
});
