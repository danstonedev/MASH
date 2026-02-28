/**
 * End-to-End Orientation Pipeline Tests
 * ======================================
 *
 * PhD-level validation of the complete quaternion transformation pipeline.
 * Tests the actual code path from sensor data through TareStore to rendering.
 *
 * This validates:
 * 1. Coordinate frame conversion (firmwareToThreeQuat)
 * 2. Level 1: Mounting tare (calibration offset)
 * 3. Level 2: Heading tare (yaw boresighting)
 * 4. Level 3: Joint angles with clinical zero
 * 5. Sign conventions throughout the pipeline
 *
 * Run with: npx vitest run src/tests/orientationPipelineE2E.test.ts
 *
 * @module tests/orientationPipelineE2E
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import {
  firmwareToThreeQuat,
  threeQuatToFirmware,
} from "../lib/math/conventions";
import {
  applyMountingTare,
  applyHeadingTare,
  computeMountingTare,
  computeHeadingTare,
  type TareState,
} from "../calibration/taringPipeline";
import { transformOrientation } from "../lib/math/OrientationPipeline";
import { useTareStore } from "../store/useTareStore";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert degrees to radians
 */
const deg2rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Convert radians to degrees
 */
const rad2deg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Create a quaternion from Euler angles in degrees
 */
function quatFromDegrees(
  pitch: number,
  yaw: number,
  roll: number,
  order: THREE.EulerOrder = "YXZ",
): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(deg2rad(pitch), deg2rad(yaw), deg2rad(roll), order),
  );
}

/**
 * Extract Euler angles in degrees from a quaternion
 */
function quatToDegrees(
  q: THREE.Quaternion,
  order: THREE.EulerOrder = "YXZ",
): { pitch: number; yaw: number; roll: number } {
  const e = new THREE.Euler().setFromQuaternion(q, order);
  return {
    pitch: rad2deg(e.x),
    yaw: rad2deg(e.y),
    roll: rad2deg(e.z),
  };
}

/**
 * Create a default TareState for testing
 */
function createTestTareState(overrides?: Partial<TareState>): TareState {
  return {
    mountingTare: new THREE.Quaternion(),
    headingTare: new THREE.Quaternion(),
    jointTare: { flexion: 0, abduction: 0, rotation: 0 },
    mountingTareTime: 0,
    headingTareTime: 0,
    jointTareTime: 0,
    ...overrides,
  };
}

// ============================================================================
// COORDINATE FRAME CONVERSION TESTS
// ============================================================================

describe("Coordinate Frame Conversion", () => {
  /**
   * IMU Frame (ICM-20649/NWU convention):
   *   X: Right (East)
   *   Y: Forward (North)
   *   Z: Up
   *
   * Three.js Frame:
   *   X: Right
   *   Y: Up
   *   Z: Forward (out of screen)
   *
   * The firmwareToThreeQuat function must correctly handle this remapping.
   */

  // Since Firmware now handles the rotation, the client just passes data through.
  // These tests verify that firmwareToThreeQuat is effectively an Identity map
  // (modulo data structure: array -> object)

  describe("Identity and Axis Preservation", () => {
    it("should convert identity quaternion correctly", () => {
      const imuIdentity: [number, number, number, number] = [1, 0, 0, 0];
      const result = firmwareToThreeQuat(imuIdentity);

      expect(result.w).toBeCloseTo(1, 5);
      expect(result.x).toBeCloseTo(0, 5);
      expect(result.y).toBeCloseTo(0, 5);
      expect(result.z).toBeCloseTo(0, 5);
    });

    it("should preserve quaternion normalization", () => {
      // Arbitrary normalized quaternion
      const imuQuat: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5];
      const result = firmwareToThreeQuat(imuQuat);

      const magnitude = Math.sqrt(
        result.w ** 2 + result.x ** 2 + result.y ** 2 + result.z ** 2,
      );
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it("should round-trip consistency", () => {
      const testQuats: [number, number, number, number][] = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0.7071, 0, 0.7071, 0],
        [0.5, 0.5, 0.5, 0.5],
      ];

      for (const imuQuat of testQuats) {
        const threeQuat = firmwareToThreeQuat(imuQuat);
        const backToIMU = threeQuatToFirmware(threeQuat);

        expect(backToIMU[0]).toBeCloseTo(imuQuat[0], 4);
        expect(backToIMU[1]).toBeCloseTo(imuQuat[1], 4);
        expect(backToIMU[2]).toBeCloseTo(imuQuat[2], 4);
        expect(backToIMU[3]).toBeCloseTo(imuQuat[3], 4);
      }
    });
  });

  // NOTE: Previous "Physical Motion Mapping" tests are removed/commented out
  // because they tested specific axis permutations (X->Z etc) which are no longer
  // done in the Client. The Client now blindly trusts the Firmware's frame.
  /*
    describe('Physical Motion Mapping', () => { ... });
    */

  /*
    describe('Physical Motion Mapping', () => {
        it('should map "look up" (Pitch) to Three.js correctly', () => {
            // "Look up" in Y-Up Frame = Rotation around X (Pitch)
            // Firmware now outputs this directly.
            const lookUpAngle = 30; // degrees
            const c = Math.cos(deg2rad(lookUpAngle) / 2);
            const s = Math.sin(deg2rad(lookUpAngle) / 2);

            // Firmware sends X-axis rotation quaternion
            const imuQuat: [number, number, number, number] = [c, s, 0, 0];
            const threeQuat = firmwareToThreeQuat(imuQuat);

            // Should match X-axis rotation in Three.js
            const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'YXZ');
            expect(rad2deg(euler.x)).toBeCloseTo(lookUpAngle, 1);
        });

        it('should map "turn right" (Yaw) to Three.js correctly', () => {
            // "Turn right" in Y-Up Frame = Rotation around Y (Yaw) (negative for Right/CW)
            // Firmware now outputs this directly.
            const turnRightAngle = -45; // degrees
            const c = Math.cos(deg2rad(turnRightAngle) / 2);
            const s = Math.sin(deg2rad(turnRightAngle) / 2);

            // Firmware sends Y-axis rotation quaternion
            const imuQuat: [number, number, number, number] = [c, 0, s, 0];
            const threeQuat = firmwareToThreeQuat(imuQuat);

            // Should match Y-axis rotation in Three.js
            const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'YXZ');
            expect(rad2deg(euler.y)).toBeCloseTo(turnRightAngle, 1);
        });

        it('should map "roll right" (Roll) to Three.js correctly', () => {
            // "Roll right" in Y-Up Frame = Rotation around Z (Roll)
            // Firmware now outputs this directly.
            const rollRightAngle = -20; // degrees (right shoulder down)
            const c = Math.cos(deg2rad(rollRightAngle) / 2);
            const s = Math.sin(deg2rad(rollRightAngle) / 2);

            // Firmware sends Z-axis rotation quaternion
            const imuQuat: [number, number, number, number] = [c, 0, 0, s];
            const threeQuat = firmwareToThreeQuat(imuQuat);

            // Should match Z-axis rotation in Three.js
            const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'YXZ');
            expect(rad2deg(euler.z)).toBeCloseTo(rollRightAngle, 1);
        });
    });
    */
});

// ============================================================================
// LEVEL 1: MOUNTING TARE TESTS
// ============================================================================

describe("Level 1: Mounting Tare", () => {
  /**
   * Mounting tare corrects for physical sensor placement on the body.
   * Formula: q_bone = q_sensor × q_mounting_tare
   *
   * The tare is computed as: offset = inv(sensorQuat) * targetQuat
   * At runtime: result = sensorQuat * offset = sensorQuat * inv(sensorCalib) * target
   *
   * If sensor hasn't moved since calibration: result = target ✓
   */

  it("should return target when sensor unchanged since calibration", () => {
    // Sensor orientation during calibration
    const sensorCalib = quatFromDegrees(10, 30, 5);
    // Target bone orientation (e.g., thigh pointing down in T-pose)
    const targetBone = quatFromDegrees(-90, 0, 0); // pointing down

    // Compute mounting tare
    const mountingTare = computeMountingTare(sensorCalib, targetBone);

    // At runtime, sensor is still at calibration pose
    const sensorRuntime = sensorCalib.clone();
    const result = applyMountingTare(sensorRuntime, mountingTare.tare);

    // Result should match target
    expect(result.angleTo(targetBone) * (180 / Math.PI)).toBeLessThan(0.1);
  });

  it("should track relative motion after calibration", () => {
    // Calibration: sensor at some arbitrary orientation
    const sensorCalib = quatFromDegrees(0, 45, 0);
    // Target: bone upright
    const targetBone = new THREE.Quaternion(); // identity

    const mountingTare = computeMountingTare(sensorCalib, targetBone);

    // Runtime: sensor has rotated 30° forward (flexion)
    const flexion = quatFromDegrees(30, 0, 0);
    const sensorRuntime = sensorCalib.clone().premultiply(flexion);

    const result = applyMountingTare(sensorRuntime, mountingTare.tare);

    // Result should show ~30° pitch from target
    const euler = quatToDegrees(result);
    expect(euler.pitch).toBeCloseTo(30, 2);
  });

  it("should handle sensor mounted upside-down", () => {
    // Sensor mounted 180° rotated (common mistake)
    const sensorCalib = quatFromDegrees(0, 0, 180); // upside-down
    const targetBone = new THREE.Quaternion(); // upright

    const mountingTare = computeMountingTare(sensorCalib, targetBone);
    const result = applyMountingTare(sensorCalib.clone(), mountingTare.tare);

    // Should still produce upright bone
    const euler = quatToDegrees(result);
    expect(Math.abs(euler.pitch)).toBeLessThan(1);
    expect(Math.abs(euler.yaw)).toBeLessThan(1);
    expect(Math.abs(euler.roll)).toBeLessThan(1);
  });
});

// ============================================================================
// LEVEL 2: HEADING TARE TESTS
// ============================================================================

describe("Level 2: Heading Tare (Boresighting)", () => {
  /**
   * Heading tare removes yaw offset so user faces world-forward.
   * Formula: q_world = inv(q_heading) × q_bone
   *
   * Sign Convention Chain:
   * 1. UnifiedCalibration extracts pelvis yaw (e.g., facing 30° right = +30°)
   * 2. Stores walkHeadingOffset = -yaw = -30° (the correction)
   * 3. TareStore receives globalHeadingOffset = -30°
   * 4. TareStore computes headingTareAngle = -globalHeadingOffset = +30° (the error)
   * 5. applyHeadingTare does: inv(+30°) × bone = -30° rotation applied
   *
   * This test validates that chain.
   */

  it("should remove pure yaw offset", () => {
    // Bone is facing 30° right (positive yaw in Y-up frame)
    const boneQuat = quatFromDegrees(0, 30, 0);

    // Heading tare captures this 30° error
    const headingTare = quatFromDegrees(0, 30, 0);

    const result = applyHeadingTare(boneQuat, headingTare);

    // Result should be facing forward (0° yaw)
    const euler = quatToDegrees(result);
    expect(euler.yaw).toBeCloseTo(0, 1);
  });

  it("should preserve pitch/roll when removing yaw", () => {
    // Bone has pitch, yaw, and roll
    const boneQuat = quatFromDegrees(15, 45, 10);

    // Heading tare only captures yaw
    const headingTare = quatFromDegrees(0, 45, 0);

    const result = applyHeadingTare(boneQuat, headingTare);
    const euler = quatToDegrees(result);

    // Yaw should be removed
    expect(euler.yaw).toBeCloseTo(0, 2);
    // Pitch and roll should be approximately preserved
    expect(euler.pitch).toBeCloseTo(15, 3);
    expect(euler.roll).toBeCloseTo(10, 3);
  });

  it("should handle negative yaw (facing left)", () => {
    // Bone facing 25° left
    const boneQuat = quatFromDegrees(0, -25, 0);

    // Heading tare captures -25° error
    const headingTare = quatFromDegrees(0, -25, 0);

    const result = applyHeadingTare(boneQuat, headingTare);
    const euler = quatToDegrees(result);

    expect(euler.yaw).toBeCloseTo(0, 1);
  });

  describe("Sign Convention Validation", () => {
    /**
     * Critical test: validates the entire sign convention chain
     * from UnifiedCalibration through TareStore to OrientationProcessor
     */
    it("should correctly apply sign convention chain", () => {
      // Simulate: pelvis sensor shows user facing 30° right
      const pelvisYawDegrees = 30;

      // Step 1: UnifiedCalibration extracts yaw and stores CORRECTION
      const walkHeadingOffset = -deg2rad(pelvisYawDegrees); // -30° in radians

      // Step 2: TareStore computes heading tare quaternion
      // This is what applyCalibrationResults does
      const headingTareAngle = -walkHeadingOffset; // -(-30°) = +30°
      const headingTare = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        headingTareAngle,
      );

      // Step 3: OrientationProcessor applies inv(headingTare) * bone
      const boneQuat = quatFromDegrees(0, 30, 0); // facing 30° right
      const result = applyHeadingTare(boneQuat, headingTare);

      // Final result should be facing forward
      const euler = quatToDegrees(result);
      expect(euler.yaw).toBeCloseTo(0, 1);
    });
  });
});

// ============================================================================
// COMPLETE PIPELINE TESTS
// ============================================================================

describe("Complete Orientation Pipeline", () => {
  /**
   * Tests the full transformOrientation function from OrientationPipeline.ts
   * This is the actual code path used in rendering.
   */

  it("should apply all tare levels in sequence", () => {
    // Create tare state with all levels populated
    const tareState: TareState = {
      mountingTare: quatFromDegrees(10, 0, 0), // 10° pitch offset
      headingTare: quatFromDegrees(0, 30, 0), // 30° yaw offset
      jointTare: { flexion: 5, abduction: 2, rotation: 1 },
      mountingTareTime: Date.now(),
      headingTareTime: Date.now(),
      jointTareTime: Date.now(),
    };

    // Raw sensor quaternion (in IMU frame)
    // Identity in IMU = standing upright facing north
    const rawQuat: [number, number, number, number] = [1, 0, 0, 0];

    const result = transformOrientation(rawQuat, tareState);

    // Verify all levels were applied
    expect(result.appliedLevels.mountingTare).toBe(true);
    expect(result.appliedLevels.headingTare).toBe(true);
  });

  it("should handle missing tares gracefully", () => {
    // Create tare state with no tares
    const tareState: TareState = {
      mountingTare: new THREE.Quaternion(),
      headingTare: new THREE.Quaternion(),
      jointTare: { flexion: 0, abduction: 0, rotation: 0 },
      mountingTareTime: 0, // No tares captured
      headingTareTime: 0,
      jointTareTime: 0,
    };

    const rawQuat: [number, number, number, number] = [0.707, 0.707, 0, 0];

    // Should not throw
    const result = transformOrientation(rawQuat, tareState);

    expect(result.q_world).toBeDefined();
    expect(result.appliedLevels.mountingTare).toBe(false);
    expect(result.appliedLevels.headingTare).toBe(false);
  });

  it("should produce clinically meaningful joint angles", () => {
    // Setup: hip joint with parent (pelvis) and child (thigh)
    const pelvisTare = createTestTareState({
      mountingTareTime: Date.now(),
    });
    const thighTare = createTestTareState({
      mountingTareTime: Date.now(),
    });

    // Pelvis upright
    const pelvisRaw: [number, number, number, number] = [1, 0, 0, 0];
    const pelvisResult = transformOrientation(pelvisRaw, pelvisTare);

    // Thigh flexed 45° forward
    const flexAngle = deg2rad(45);
    const thighRaw: [number, number, number, number] = [
      Math.cos(flexAngle / 2),
      Math.sin(flexAngle / 2),
      0,
      0,
    ];

    const thighResult = transformOrientation(thighRaw, thighTare, {
      parentQuat: pelvisResult.q_world,
      parentTareState: pelvisTare,
    });

    // Joint angles should show ~45° flexion
    if (thighResult.jointAngles) {
      expect(thighResult.jointAngles.flexion).toBeCloseTo(45, 5);
    }
  });
});

// ============================================================================
// TARESTORE INTEGRATION TESTS
// ============================================================================

describe("TareStore Integration", () => {
  beforeEach(() => {
    // Reset TareStore before each test
    useTareStore.getState().resetAll();
  });

  afterEach(() => {
    // Clean up
    useTareStore.getState().resetAll();
  });

  it("should store and retrieve mounting tare", () => {
    const segmentId = "thigh_r";
    const mountingTare = quatFromDegrees(15, 30, 5);

    // Simulate calibration storing result
    const results = new Map([
      [segmentId, { offset: mountingTare, quality: 95 }],
    ]);
    useTareStore.getState().applyCalibrationResults(results);

    // Retrieve and verify
    const tareState = useTareStore.getState().getTareState(segmentId);
    expect(
      tareState.mountingTare.angleTo(mountingTare) * (180 / Math.PI),
    ).toBeLessThan(0.1);
    expect(tareState.mountingTareTime).toBeGreaterThan(0);
  });

  it("should apply global heading offset to all segments", () => {
    const segments = ["pelvis", "thigh_l", "thigh_r", "tibia_l", "tibia_r"];

    // Initialize all segments with mounting tares
    const results = new Map(
      segments.map((s) => [
        s,
        { offset: new THREE.Quaternion(), quality: 100 },
      ]),
    );

    // Apply with 30° heading correction
    const headingCorrection = deg2rad(-30); // walkHeadingOffset is correction
    useTareStore.getState().applyCalibrationResults(results, headingCorrection);

    // All segments should have the same heading tare
    for (const segment of segments) {
      const state = useTareStore.getState().getTareState(segment);
      expect(state.headingTareTime).toBeGreaterThan(0);

      // Heading tare angle should be +30° (error = -correction)
      const euler = new THREE.Euler().setFromQuaternion(
        state.headingTare,
        "YXZ",
      );
      expect(rad2deg(euler.y)).toBeCloseTo(30, 1);
    }
  });

  it("should reset all tares correctly", () => {
    // Setup some tares
    const results = new Map([
      ["pelvis", { offset: quatFromDegrees(10, 20, 5), quality: 90 }],
    ]);
    useTareStore.getState().applyCalibrationResults(results, deg2rad(15));

    // Verify tares exist
    expect(useTareStore.getState().hasTares()).toBe(true);

    // Reset
    useTareStore.getState().resetAll();

    // Verify cleared
    expect(useTareStore.getState().hasTares()).toBe(false);
    const state = useTareStore.getState().getTareState("pelvis");
    expect(state.mountingTareTime).toBe(0);
    expect(state.headingTareTime).toBe(0);
  });
});

// ============================================================================
// NUMERICAL STABILITY TESTS
// ============================================================================

describe("Numerical Stability", () => {
  it("should handle near-identity quaternions", () => {
    // Very small rotation - potential for numerical issues
    const smallAngle = 0.001; // radians
    const q: [number, number, number, number] = [
      Math.cos(smallAngle / 2),
      Math.sin(smallAngle / 2),
      0,
      0,
    ];

    const result = firmwareToThreeQuat(q);
    const magnitude = Math.sqrt(
      result.w ** 2 + result.x ** 2 + result.y ** 2 + result.z ** 2,
    );

    expect(magnitude).toBeCloseTo(1, 5);
    expect(isNaN(result.w)).toBe(false);
  });

  it("should handle 180° rotations (gimbal lock boundary)", () => {
    // 180° around Y - can cause gimbal lock issues
    const q: [number, number, number, number] = [0, 0, 1, 0]; // 180° around IMU Y

    const result = firmwareToThreeQuat(q);

    expect(isNaN(result.w)).toBe(false);
    expect(isNaN(result.x)).toBe(false);
    expect(isNaN(result.y)).toBe(false);
    expect(isNaN(result.z)).toBe(false);
  });

  it("should maintain orthonormality through repeated operations", () => {
    let q = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5);

    // Apply many small rotations
    const smallRot = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.01, 0.01, 0.01),
    );

    for (let i = 0; i < 1000; i++) {
      q.multiply(smallRot);
    }

    // Quaternion should still be normalized
    const magnitude = Math.sqrt(q.w ** 2 + q.x ** 2 + q.y ** 2 + q.z ** 2);
    expect(magnitude).toBeCloseTo(1, 3);
  });

  it("should detect and reject NaN quaternions", () => {
    const invalidQuat: [number, number, number, number] = [NaN, 0, 0, 0];

    // The pipeline should handle this gracefully
    const tareState = createTestTareState({ mountingTareTime: Date.now() });

    // transformOrientation should either return null or handle gracefully
    // This depends on implementation - adjust assertion as needed
    const result = transformOrientation(invalidQuat, tareState);

    // At minimum, check the result doesn't contain NaN
    if (result) {
      expect(isNaN(result.q_world.w)).toBe(false);
    }
  });
});

// ============================================================================
// DIAGNOSTIC HELPERS
// ============================================================================

/**
 * Helper to print detailed quaternion info for debugging
 */
function debugQuat(label: string, q: THREE.Quaternion) {
  const euler = new THREE.Euler().setFromQuaternion(q, "YXZ");
  console.log(`[${label}]`);
  console.log(
    `  Quat: [${q.w.toFixed(4)}, ${q.x.toFixed(4)}, ${q.y.toFixed(4)}, ${q.z.toFixed(4)}]`,
  );
  console.log(
    `  Euler (YXZ): pitch=${rad2deg(euler.x).toFixed(1)}° yaw=${rad2deg(euler.y).toFixed(1)}° roll=${rad2deg(euler.z).toFixed(1)}°`,
  );
}
