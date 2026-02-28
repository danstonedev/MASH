/**
 * GOLDEN BODY CALIBRATION TESTS - DO NOT MODIFY
 * ==============================================
 *
 * These tests lock down the exact mathematical behavior of body segment
 * calibration. Any changes that break these tests are REGRESSIONS.
 *
 * BODY CALIBRATION ARCHITECTURE (vs HEAD):
 * ========================================
 *
 * HEAD (two-step):
 *   q_world = (q_sensor × mountingTare) × frameAlignment
 *   mountingTare = inv(startQuat) × inv(frameAlignment)
 *   At neutral: q_world = identity
 *
 * BODY (single-step):
 *   q_world = q_sensor × mountingTare
 *   mountingTare = inv(q_sensor_calib) × q_target
 *   At neutral: q_world = target orientation (bone's bind pose)
 *
 * KEY INSIGHT:
 * - Head outputs IDENTITY at neutral (looking forward = no rotation)
 * - Body outputs TARGET at neutral (bone orientation in skeleton)
 *
 * Both are CORRECT for their use cases!
 *
 * @preserve DO NOT MODIFY WITHOUT HARDWARE VERIFICATION
 */

import * as THREE from "three";
import { describe, it, expect, beforeEach } from "vitest";

// Core body calibration functions
import {
  computeSinglePoseOffset,
  applyCalibrationOffset,
} from "../calibration/calibrationMath";

import {
  transformOrientation,
  createIdentityTareState,
} from "../lib/math/OrientationPipeline";

import {
  createDefaultTareState,
  applyMountingTare,
  type TareState,
} from "../calibration/taringPipeline";

// ============================================================================
// TEST UTILITIES - LOCKED IMPLEMENTATIONS
// ============================================================================

/**
 * The EXACT formula used in body calibration.
 * offset = inv(q_sensor) × q_target
 *
 * This ensures: q_sensor × offset = q_target
 */
function computeBodyOffset(
  sensorQuat: THREE.Quaternion,
  targetQuat: THREE.Quaternion,
): THREE.Quaternion {
  // offset = inv(sensor) × target
  return sensorQuat.clone().invert().multiply(targetQuat);
}

/**
 * The EXACT pipeline transformation for body.
 * q_world = q_sensor × offset
 */
function applyBodyPipeline(
  q_sensor: THREE.Quaternion,
  offset: THREE.Quaternion,
): THREE.Quaternion {
  return q_sensor.clone().multiply(offset);
}

/**
 * Create quaternion from Euler angles (degrees)
 */
function quatFromDegrees(
  pitchDeg: number,
  yawDeg: number,
  rollDeg: number,
): THREE.Quaternion {
  const euler = new THREE.Euler(
    (pitchDeg * Math.PI) / 180,
    (yawDeg * Math.PI) / 180,
    (rollDeg * Math.PI) / 180,
    "XYZ",
  );
  return new THREE.Quaternion().setFromEuler(euler);
}

/**
 * Get Euler angles in degrees from quaternion
 */
function getEulerDegrees(q: THREE.Quaternion): {
  pitch: number;
  yaw: number;
  roll: number;
} {
  const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");
  return {
    pitch: (euler.x * 180) / Math.PI,
    yaw: (euler.y * 180) / Math.PI,
    roll: (euler.z * 180) / Math.PI,
  };
}

/**
 * Assert quaternion is close to expected (handles double-cover)
 */
function expectQuatNear(
  actual: THREE.Quaternion,
  expected: THREE.Quaternion,
  tolerance = 0.001,
) {
  const dist1 =
    Math.abs(actual.w - expected.w) +
    Math.abs(actual.x - expected.x) +
    Math.abs(actual.y - expected.y) +
    Math.abs(actual.z - expected.z);
  const dist2 =
    Math.abs(actual.w + expected.w) +
    Math.abs(actual.x + expected.x) +
    Math.abs(actual.y + expected.y) +
    Math.abs(actual.z + expected.z);
  expect(Math.min(dist1, dist2)).toBeLessThan(tolerance * 4);
}

/**
 * Assert quaternion angle difference
 */
function expectAngleNear(
  actual: THREE.Quaternion,
  expected: THREE.Quaternion,
  maxDegrees: number,
) {
  const angleDeg = (actual.angleTo(expected) * 180) / Math.PI;
  expect(angleDeg).toBeLessThan(maxDegrees);
}

// ============================================================================
// GOLDEN TESTS - BODY CALIBRATION MATHEMATICS
// ============================================================================

describe("GOLDEN: Body Calibration Mathematics", () => {
  describe("Fundamental Formula: offset = inv(sensor) × target", () => {
    it("should compute offset that maps sensor to target", () => {
      // Any arbitrary sensor and target orientations
      const sensor = quatFromDegrees(30, -20, 15);
      const target = quatFromDegrees(0, 0, -10);

      // Compute offset using exact formula
      const offset = computeBodyOffset(sensor, target);

      // Applying offset should give target
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });

    it("should produce identity offset when sensor equals target", () => {
      const pose = quatFromDegrees(45, 30, -15);

      const offset = computeBodyOffset(pose, pose);

      // offset should be identity
      expectQuatNear(offset, new THREE.Quaternion());
    });

    it("should match computeSinglePoseOffset from calibrationMath.ts", () => {
      const sensor = quatFromDegrees(20, -10, 5);
      const target = quatFromDegrees(5, 0, -5);

      // Our formula
      const myOffset = computeBodyOffset(sensor, target);

      // Library function
      const libOffset = computeSinglePoseOffset(sensor, target);

      // Should be identical
      expectQuatNear(myOffset, libOffset);
    });
  });

  describe("Neutral Pose → Target Orientation (CRITICAL)", () => {
    it("pelvis: sensor at any orientation should output identity target", () => {
      // Pelvis target is identity (root bone)
      const target = new THREE.Quaternion();

      // Sensor at random orientation during T-pose calibration
      const sensor = quatFromDegrees(15, -8, 22);

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });

    it("thigh_l: should output thigh target orientation at calibration", () => {
      // Left thigh in A-pose has slight inward rotation
      const target = quatFromDegrees(0, 0, -10);

      const sensor = quatFromDegrees(35, 12, -5);

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });

    it("thigh_r: should output mirrored target orientation", () => {
      // Right thigh mirrors left
      const target = quatFromDegrees(0, 0, 10);

      const sensor = quatFromDegrees(-20, 8, 30);

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });

    it("tibia: should output tibia target (typically identity or slight bend)", () => {
      // Tibia in standing pose
      const target = new THREE.Quaternion();

      const sensor = quatFromDegrees(5, -3, 12);

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });

    it("foot: should output foot target (platform parallel to ground)", () => {
      // Foot flat on ground
      const target = new THREE.Quaternion();

      // Sensor on top of foot
      const sensor = quatFromDegrees(10, 5, -5);

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });
  });

  describe("Motion Tracking After Body Calibration", () => {
    it("knee flexion: sensor pitch should appear as world pitch", () => {
      // Calibrate tibia
      const target = new THREE.Quaternion();
      const sensorCalib = quatFromDegrees(10, 5, -3);

      const offset = computeBodyOffset(sensorCalib, target);

      // User flexes knee 60°: sensor rotates 60° pitch in local frame
      const flexion = quatFromDegrees(60, 0, 0);
      const sensorMoved = sensorCalib.clone().multiply(flexion);

      const result = applyBodyPipeline(sensorMoved, offset);

      // Result should be 60° from target (which is identity)
      const angleDeg = (result.angleTo(target) * 180) / Math.PI;
      expect(angleDeg).toBeCloseTo(60, 1);
    });

    it("hip rotation: sensor yaw should appear as world yaw", () => {
      const target = new THREE.Quaternion();
      const sensorCalib = quatFromDegrees(-5, 8, 15);

      const offset = computeBodyOffset(sensorCalib, target);

      // User rotates hip 45° internally (yaw)
      const rotation = quatFromDegrees(0, 45, 0);
      const sensorMoved = sensorCalib.clone().multiply(rotation);

      const result = applyBodyPipeline(sensorMoved, offset);

      const angleDeg = (result.angleTo(target) * 180) / Math.PI;
      expect(angleDeg).toBeCloseTo(45, 1);
    });

    it("combined motion: flexion + rotation should compound correctly", () => {
      const target = new THREE.Quaternion();
      const sensorCalib = quatFromDegrees(0, 0, 0); // Start simple

      const offset = computeBodyOffset(sensorCalib, target);

      // 30° flexion then 30° rotation
      const motion = quatFromDegrees(30, 30, 0);
      const sensorMoved = sensorCalib.clone().multiply(motion);

      const result = applyBodyPipeline(sensorMoved, offset);

      // Total rotation should be composed (not simply additive due to quaternion math)
      const euler = getEulerDegrees(result);
      // With identity start, should see approximately 30° in both axes
      expect(Math.abs(euler.pitch)).toBeGreaterThan(20);
      expect(Math.abs(euler.yaw)).toBeGreaterThan(20);
    });
  });

  describe("Edge Cases and Numerical Stability", () => {
    it("should handle 180° sensor flip (upside down)", () => {
      const target = new THREE.Quaternion();
      const sensor = quatFromDegrees(180, 0, 0); // Flipped

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });

    it("should handle gimbal lock at 90° pitch", () => {
      const target = new THREE.Quaternion();
      const sensor = quatFromDegrees(90, 0, 0); // Gimbal lock boundary

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });

    it("should preserve unit quaternion through all operations", () => {
      const sensor = quatFromDegrees(37, -61, 89);
      const target = quatFromDegrees(12, 45, -33);

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expect(offset.length()).toBeCloseTo(1, 5);
      expect(result.length()).toBeCloseTo(1, 5);
    });

    it("should handle near-identity quaternions", () => {
      const target = new THREE.Quaternion();
      const sensor = new THREE.Quaternion(0.0001, 0, 0, 1).normalize();

      const offset = computeBodyOffset(sensor, target);
      const result = applyBodyPipeline(sensor, offset);

      expectQuatNear(result, target);
    });
  });
});

// ============================================================================
// GOLDEN TESTS - PIPELINE INTEGRATION
// ============================================================================

describe("GOLDEN: Body Calibration Pipeline Integration", () => {
  it("should work through transformOrientation with TareState", () => {
    const target = quatFromDegrees(0, 0, -10); // Thigh target
    const sensor = quatFromDegrees(30, -15, 20);

    const offset = computeBodyOffset(sensor, target);

    // Create TareState as UnifiedCalibration does
    const tareState: TareState = {
      ...createDefaultTareState(),
      mountingTare: offset,
      mountingTareTime: Date.now(),
      // No frameAlignment for body segments
    };

    // Transform through pipeline
    const rawQuat: [number, number, number, number] = [
      sensor.w,
      sensor.x,
      sensor.y,
      sensor.z,
    ];

    const result = transformOrientation(rawQuat, tareState);

    expectQuatNear(result.q_world, target);
  });

  it("should track motion through full pipeline", () => {
    const target = new THREE.Quaternion();
    const sensorCalib = quatFromDegrees(15, -10, 5);

    const offset = computeBodyOffset(sensorCalib, target);

    const tareState: TareState = {
      ...createDefaultTareState(),
      mountingTare: offset,
      mountingTareTime: Date.now(),
    };

    // Simulate knee flexion
    const flexion = quatFromDegrees(45, 0, 0);
    const sensorMoved = sensorCalib.clone().multiply(flexion);

    const rawQuat: [number, number, number, number] = [
      sensorMoved.w,
      sensorMoved.x,
      sensorMoved.y,
      sensorMoved.z,
    ];

    const result = transformOrientation(rawQuat, tareState);

    // Should show 45° from target
    const angleDeg = (result.q_world.angleTo(target) * 180) / Math.PI;
    expect(angleDeg).toBeCloseTo(45, 1);
  });

  it("should handle null/undefined TareState gracefully", () => {
    const rawQuat: [number, number, number, number] = [1, 0, 0, 0];

    // Should not throw
    const result = transformOrientation(rawQuat, null);
    expect(result.q_world).toBeInstanceOf(THREE.Quaternion);
  });
});

// ============================================================================
// GOLDEN TESTS - COMPARISON WITH HEAD CALIBRATION
// ============================================================================

describe("GOLDEN: Body vs Head Calibration Differences", () => {
  it("BODY: outputs TARGET at neutral (bone orientation)", () => {
    const target = quatFromDegrees(0, 0, -10); // Non-identity target
    const sensor = quatFromDegrees(30, 15, -5);

    const offset = computeBodyOffset(sensor, target);
    const result = applyBodyPipeline(sensor, offset);

    // Body outputs the TARGET
    expectQuatNear(result, target);

    // NOT identity
    const identity = new THREE.Quaternion();
    expect((result.angleTo(identity) * 180) / Math.PI).toBeGreaterThan(5);
  });

  it("HEAD: outputs IDENTITY at neutral (looking forward)", () => {
    // Head calibration formula (from goldenCalibration.test.ts):
    // mountingTare = inv(startQuat) × inv(frameAlignment)
    // q_world = (q_sensor × mountingTare) × frameAlignment

    const startQuat = quatFromDegrees(20, -10, 5);
    const frameAlignment = quatFromDegrees(0, 0, 15); // PCA axis alignment

    // HEAD mounting tare formula
    const boresight = startQuat.clone().invert();
    const frameAlignmentInv = frameAlignment.clone().invert();
    const headMountingTare = boresight.clone().multiply(frameAlignmentInv);

    // At neutral: apply head pipeline
    const q_tared = startQuat.clone().multiply(headMountingTare);
    const q_world = q_tared.multiply(frameAlignment);

    // Head outputs IDENTITY
    expectQuatNear(q_world, new THREE.Quaternion());
  });

  it("documents WHY the difference exists", () => {
    // HEAD: "neutral" means looking forward relative to torso
    // - Parent bone (spine/chest) defines the reference frame
    // - Head rotation is RELATIVE to parent
    // - Identity = no rotation from parent = looking straight

    // BODY: "neutral" means bone orientation in T-pose/A-pose
    // - Each bone has absolute world orientation in bind pose
    // - Renderer expects these absolute orientations
    // - Target = bind pose orientation (may not be identity)

    // BOTH ARE CORRECT FOR THEIR USE CASES

    // Example: Left thigh in A-pose
    // - Bone points slightly inward (~10° Z rotation)
    // - Target = (0, 0, -10°) rotation
    // - At T-pose, q_world should equal this target

    const thighTarget = quatFromDegrees(0, 0, -10);
    const thighSensor = quatFromDegrees(25, 10, -5);

    const offset = computeBodyOffset(thighSensor, thighTarget);
    const result = applyBodyPipeline(thighSensor, offset);

    // Body correctly outputs the target bone orientation
    expectQuatNear(result, thighTarget);

    // This is NOT a bug - it's the correct behavior for body segments!
    expect(true).toBe(true);
  });
});

// ============================================================================
// GOLDEN TESTS - FULL BODY MULTI-SEGMENT
// ============================================================================

describe("GOLDEN: Full Body Multi-Segment Calibration", () => {
  it("should calibrate lower body kinematic chain consistently", () => {
    // Define typical T-pose/A-pose targets for lower body
    const segments = [
      { name: "pelvis", target: new THREE.Quaternion() },
      { name: "thigh_l", target: quatFromDegrees(0, 0, -8) },
      { name: "thigh_r", target: quatFromDegrees(0, 0, 8) },
      { name: "tibia_l", target: new THREE.Quaternion() },
      { name: "tibia_r", target: new THREE.Quaternion() },
      { name: "foot_l", target: new THREE.Quaternion() },
      { name: "foot_r", target: new THREE.Quaternion() },
    ];

    // Simulate random sensor placements for each segment
    const calibrations = segments.map((seg) => {
      // Random sensor orientation during calibration pose
      const sensor = quatFromDegrees(
        Math.sin(seg.name.length * 1.1) * 40,
        Math.cos(seg.name.length * 1.3) * 30,
        Math.sin(seg.name.length * 0.7) * 25,
      );

      const offset = computeBodyOffset(sensor, seg.target);

      return {
        ...seg,
        sensor,
        offset,
      };
    });

    // Verify each segment outputs correct target at calibration
    for (const cal of calibrations) {
      const result = applyBodyPipeline(cal.sensor, cal.offset);
      expectAngleNear(result, cal.target, 0.1);
    }

    // Simulate walking motion: all segments rotate 15° pitch
    const walkFlexion = quatFromDegrees(15, 0, 0);

    for (const cal of calibrations) {
      const sensorMoved = cal.sensor.clone().multiply(walkFlexion);
      const result = applyBodyPipeline(sensorMoved, cal.offset);

      // Each segment should now be 15° rotated from its target
      const angleDeg = (result.angleTo(cal.target) * 180) / Math.PI;
      expect(angleDeg).toBeCloseTo(15, 1);
    }
  });

  it("should maintain relative joint angles in kinematic chain", () => {
    // Parent: thigh
    const thighTarget = new THREE.Quaternion();
    const thighSensor = quatFromDegrees(20, 10, 5);
    const thighOffset = computeBodyOffset(thighSensor, thighTarget);

    // Child: tibia
    const tibiaTarget = new THREE.Quaternion();
    const tibiaSensor = quatFromDegrees(-15, 8, -12);
    const tibiaOffset = computeBodyOffset(tibiaSensor, tibiaTarget);

    // At calibration: both at their targets
    const thighWorld = applyBodyPipeline(thighSensor, thighOffset);
    const tibiaWorld = applyBodyPipeline(tibiaSensor, tibiaOffset);

    // Joint angle = relative rotation between parent and child
    const jointAngleAtCalib = thighWorld.clone().invert().multiply(tibiaWorld);

    // At calibration, joint angle should be identity (straight leg)
    expectQuatNear(jointAngleAtCalib, new THREE.Quaternion());

    // Now flex knee 45°: only tibia rotates
    const kneeFlexion = quatFromDegrees(45, 0, 0);
    const tibiaMoved = tibiaSensor.clone().multiply(kneeFlexion);

    const thighWorldNew = applyBodyPipeline(thighSensor, thighOffset);
    const tibiaWorldNew = applyBodyPipeline(tibiaMoved, tibiaOffset);

    // Joint angle should now show 45° flexion
    const jointAngleFlexed = thighWorldNew
      .clone()
      .invert()
      .multiply(tibiaWorldNew);
    const jointAngleDeg =
      (jointAngleFlexed.angleTo(new THREE.Quaternion()) * 180) / Math.PI;

    expect(jointAngleDeg).toBeCloseTo(45, 1);
  });
});

// ============================================================================
// GOLDEN TESTS - MATHEMATICAL INVARIANTS
// ============================================================================

describe("GOLDEN: Body Calibration Mathematical Invariants", () => {
  it("offset formula is mathematically correct: inv(s) × t", () => {
    const s = quatFromDegrees(30, -20, 15);
    const t = quatFromDegrees(10, 5, -5);

    // offset = inv(s) × t
    const offset = s.clone().invert().multiply(t);

    // Then: s × offset = s × inv(s) × t = t
    const result = s.clone().multiply(offset);

    expectQuatNear(result, t);
  });

  it("offset is NOT commutative: order matters", () => {
    const a = quatFromDegrees(30, 0, 0);
    const b = quatFromDegrees(0, 30, 0);

    // a × b ≠ b × a (quaternion multiplication is non-commutative)
    const ab = a.clone().multiply(b);
    const ba = b.clone().multiply(a);

    expect(ab.equals(ba)).toBe(false);

    // This is why RIGHT multiplication (q × offset) is critical
    // and differs from LEFT multiplication (offset × q)
  });

  it("double application of inverse offset returns to sensor frame", () => {
    const sensor = quatFromDegrees(25, -15, 10);
    const target = quatFromDegrees(0, 0, -10);

    const offset = computeBodyOffset(sensor, target);
    const offsetInv = offset.clone().invert();

    // sensor → target
    const toTarget = sensor.clone().multiply(offset);
    expectQuatNear(toTarget, target);

    // target → sensor (using inverse offset)
    const backToSensor = target.clone().multiply(offsetInv);
    expectQuatNear(backToSensor, sensor);
  });

  it("chained calibrations should compose correctly", () => {
    // If we recalibrate from a new sensor position
    const target = quatFromDegrees(0, 0, -10);

    // First calibration
    const sensor1 = quatFromDegrees(20, 10, 5);
    const offset1 = computeBodyOffset(sensor1, target);

    // Verify first calibration works
    const result1 = applyBodyPipeline(sensor1, offset1);
    expectQuatNear(result1, target);

    // Second calibration from different sensor position
    const sensor2 = quatFromDegrees(-15, 25, -8);
    const offset2 = computeBodyOffset(sensor2, target);

    // Verify second calibration works
    const result2 = applyBodyPipeline(sensor2, offset2);
    expectQuatNear(result2, target);

    // Both should produce the same target
    expectQuatNear(result1, result2);
  });
});
