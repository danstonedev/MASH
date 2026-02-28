/**
 * Body Calibration Neutral Pose Tests
 * ====================================
 *
 * Tests that verify body segment calibration produces correct orientations
 * at the calibration (neutral) pose.
 *
 * KEY DIFFERENCE FROM HEAD CALIBRATION:
 * - Head: neutral = identity (looking forward)
 * - Body: neutral = target bone orientation (T-pose)
 *
 * BODY CALIBRATION ARCHITECTURE:
 * - Uses single-step transformation: q_world = q_sensor × offset
 * - Gram-Schmidt creates combined offset (sensor frame → bone frame)
 * - NO separate frameAlignment in TareState
 * - At calibration pose: q_world = target orientation ✓
 *
 * This validates that the UnifiedCalibration system correctly maps
 * sensor orientations to bone orientations for full body tracking.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import {
  computeSinglePoseOffset,
  applyCalibrationOffset,
} from "../calibration/calibrationMath";
import {
  refinePoseWithPCA,
  ANATOMICAL_AXES,
} from "../calibration/pcaRefinement";
import {
  transformOrientation,
  createIdentityTareState,
} from "../lib/math/OrientationPipeline";
import {
  createDefaultTareState,
  type TareState,
} from "../calibration/taringPipeline";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create quaternion from Euler angles (degrees)
 */
function quatFromEulerDeg(x: number, y: number, z: number): THREE.Quaternion {
  const DEG2RAD = Math.PI / 180;
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(x * DEG2RAD, y * DEG2RAD, z * DEG2RAD, "XYZ"),
  );
}

/**
 * Extract Euler angles from quaternion (degrees)
 */
function eulerFromQuat(q: THREE.Quaternion): {
  x: number;
  y: number;
  z: number;
} {
  const RAD2DEG = 180 / Math.PI;
  const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");
  return {
    x: euler.x * RAD2DEG,
    y: euler.y * RAD2DEG,
    z: euler.z * RAD2DEG,
  };
}

/**
 * Generate synthetic gyro samples for PCA axis detection
 */
function generateGyroSamples(
  axis: THREE.Vector3,
  count: number = 60,
): THREE.Vector3[] {
  const samples: THREE.Vector3[] = [];
  const baseOmega = 2.5; // rad/s

  for (let i = 0; i < count; i++) {
    const phase = (i / count) * Math.PI * 4;
    const omega = baseOmega * Math.sin(phase);
    samples.push(axis.clone().multiplyScalar(omega));
  }

  return samples;
}

/**
 * Simulate what UnifiedCalibration does for a body segment
 */
function simulateBodyCalibration(
  sensorQuat: THREE.Quaternion,
  targetQuat: THREE.Quaternion,
  gyroSamples?: THREE.Vector3[],
  segment?: string,
): { offset: THREE.Quaternion; method: string } {
  // Step 1: Basic pose offset (same as UnifiedCalibration)
  let offset = computeSinglePoseOffset(sensorQuat, targetQuat);
  let method = "pose";

  // Step 2: PCA refinement if data available (simulating UnifiedCalibration)
  if (gyroSamples && gyroSamples.length > 30 && segment) {
    const anatomicalAxis = ANATOMICAL_AXES[segment];
    if (anatomicalAxis) {
      // Simplified PCA result simulation
      // In real code, this comes from estimateFunctionalAxis
      const pcaResult = {
        segment,
        axis: gyroSamples[0].clone().normalize(),
        confidence: 0.85,
        sampleCount: gyroSamples.length,
        isValid: true,
      };

      // Compute sensor gravity for Gram-Schmidt
      const GRAVITY_DIRECTION = new THREE.Vector3(0, -1, 0);
      const sensorGravity = GRAVITY_DIRECTION.clone().applyQuaternion(
        sensorQuat.clone().invert(),
      );

      offset = refinePoseWithPCA(
        offset,
        pcaResult,
        anatomicalAxis,
        sensorGravity,
      );
      method = "pca-refined";
    }
  }

  return { offset, method };
}

// ============================================================================
// TESTS
// ============================================================================

describe("Body Calibration Neutral Pose", () => {
  describe("Single-Pose Offset (No PCA)", () => {
    it("should produce target orientation at calibration pose", () => {
      // Simulate pelvis sensor at some arbitrary orientation during T-pose
      const sensorCalib = quatFromEulerDeg(15, -10, 5);

      // Target: pelvis in T-pose (identity for root bone)
      const targetQuat = new THREE.Quaternion();

      // Compute calibration offset
      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);

      // At calibration pose, applying offset should give target
      const result = applyCalibrationOffset(sensorCalib, offset);

      expect(result.angleTo(targetQuat)).toBeLessThan(0.001);
    });

    it("should track relative motion from calibration pose", () => {
      const sensorCalib = quatFromEulerDeg(20, 10, -5);
      const targetQuat = new THREE.Quaternion();

      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);

      // Now sensor moves 30° pitch from calibration
      const sensorMoved = sensorCalib
        .clone()
        .multiply(quatFromEulerDeg(30, 0, 0));
      const result = applyCalibrationOffset(sensorMoved, offset);

      // Result should show ~30° deviation from target
      const euler = eulerFromQuat(result);
      // Note: Due to Euler angle coupling from non-zero initial orientation,
      // the result may not be exactly 30° in pure X. Check total rotation instead.
      const totalRotation = result.angleTo(targetQuat) * (180 / Math.PI);
      expect(totalRotation).toBeCloseTo(30, 0); // ~30° total rotation from target
    });

    it("should work for thigh with non-identity target", () => {
      // Thigh T-pose target: slightly rotated from world (typical A-pose)
      const targetQuat = quatFromEulerDeg(0, 0, -5); // Slight inward rotation

      // Sensor on thigh during calibration
      const sensorCalib = quatFromEulerDeg(45, 20, 10);

      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);

      // At calibration, should match target
      const result = applyCalibrationOffset(sensorCalib, offset);
      expect(result.angleTo(targetQuat)).toBeLessThan(0.001);
    });
  });

  describe("Full Pipeline Integration", () => {
    it("should produce target orientation through OrientationPipeline", () => {
      // Setup: sensor orientation at calibration
      const sensorCalib = quatFromEulerDeg(25, -15, 8);
      const targetQuat = new THREE.Quaternion(); // Identity target

      // Compute offset (what UnifiedCalibration does)
      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);

      // Create TareState (what applyCalibrationResults does)
      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: offset,
        mountingTareTime: Date.now(),
      };

      // Transform through pipeline
      const quatArray: [number, number, number, number] = [
        sensorCalib.w,
        sensorCalib.x,
        sensorCalib.y,
        sensorCalib.z,
      ];

      const result = transformOrientation(quatArray, tareState);

      // At calibration pose, q_world should match target
      expect(result.q_world.angleTo(targetQuat)).toBeLessThan(0.01);
    });

    it("should work for multiple body segments with different targets", () => {
      const segments = [
        { id: "pelvis", target: new THREE.Quaternion() },
        { id: "thigh_l", target: quatFromEulerDeg(0, 0, -10) },
        { id: "thigh_r", target: quatFromEulerDeg(0, 0, 10) },
        { id: "tibia_l", target: quatFromEulerDeg(0, 0, -5) },
        { id: "tibia_r", target: quatFromEulerDeg(0, 0, 5) },
      ];

      for (const seg of segments) {
        // Random sensor orientation
        const sensorCalib = quatFromEulerDeg(
          Math.random() * 60 - 30,
          Math.random() * 60 - 30,
          Math.random() * 60 - 30,
        );

        const offset = computeSinglePoseOffset(sensorCalib, seg.target);

        const tareState: TareState = {
          ...createDefaultTareState(),
          mountingTare: offset,
          mountingTareTime: Date.now(),
        };

        const quatArray: [number, number, number, number] = [
          sensorCalib.w,
          sensorCalib.x,
          sensorCalib.y,
          sensorCalib.z,
        ];

        const result = transformOrientation(quatArray, tareState);

        // Each segment should match its target at calibration
        expect(result.q_world.angleTo(seg.target)).toBeLessThan(0.01);
      }
    });
  });

  describe("Motion Tracking After Calibration", () => {
    it("should correctly track knee flexion", () => {
      // Tibia at T-pose
      const targetQuat = new THREE.Quaternion();
      const sensorCalib = quatFromEulerDeg(10, 5, -3);

      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);

      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: offset,
        mountingTareTime: Date.now(),
      };

      // Simulate 45° knee flexion (rotation around X axis in bone frame)
      // Sensor rotates the same amount in its local frame
      const flexionDelta = quatFromEulerDeg(45, 0, 0);
      const sensorMoved = sensorCalib.clone().multiply(flexionDelta);

      const quatArray: [number, number, number, number] = [
        sensorMoved.w,
        sensorMoved.x,
        sensorMoved.y,
        sensorMoved.z,
      ];

      const result = transformOrientation(quatArray, tareState);
      const euler = eulerFromQuat(result.q_world);

      // Should show ~45° in X (flexion)
      expect(euler.x).toBeCloseTo(45, 0);
      expect(Math.abs(euler.y)).toBeLessThan(5);
      expect(Math.abs(euler.z)).toBeLessThan(5);
    });

    it("should correctly track hip rotation", () => {
      // Thigh at T-pose
      const targetQuat = new THREE.Quaternion();
      const sensorCalib = quatFromEulerDeg(-5, 10, 15);

      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);

      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: offset,
        mountingTareTime: Date.now(),
      };

      // Simulate 30° hip internal rotation (Y axis in bone frame)
      const rotationDelta = quatFromEulerDeg(0, 30, 0);
      const sensorMoved = sensorCalib.clone().multiply(rotationDelta);

      const quatArray: [number, number, number, number] = [
        sensorMoved.w,
        sensorMoved.x,
        sensorMoved.y,
        sensorMoved.z,
      ];

      const result = transformOrientation(quatArray, tareState);
      const euler = eulerFromQuat(result.q_world);

      // Should show ~30° total rotation from neutral
      // Note: Due to Euler coupling, may not be pure Y rotation in Euler representation
      const totalRotation =
        result.q_world.angleTo(targetQuat) * (180 / Math.PI);
      expect(totalRotation).toBeCloseTo(30, 0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle sensor mounted upside-down", () => {
      // Sensor is 180° flipped
      const sensorCalib = quatFromEulerDeg(180, 0, 0);
      const targetQuat = new THREE.Quaternion();

      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);
      const result = applyCalibrationOffset(sensorCalib, offset);

      expect(result.angleTo(targetQuat)).toBeLessThan(0.001);
    });

    it("should handle sensor at gimbal lock boundary", () => {
      // Sensor pointing straight up (90° pitch)
      const sensorCalib = quatFromEulerDeg(90, 0, 0);
      const targetQuat = new THREE.Quaternion();

      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);
      const result = applyCalibrationOffset(sensorCalib, offset);

      expect(result.angleTo(targetQuat)).toBeLessThan(0.001);
    });

    it("should maintain unit quaternion through calibration", () => {
      const sensorCalib = quatFromEulerDeg(37, -23, 81);
      const targetQuat = quatFromEulerDeg(5, 10, -15);

      const offset = computeSinglePoseOffset(sensorCalib, targetQuat);
      const result = applyCalibrationOffset(sensorCalib, offset);

      // Check normalization
      expect(offset.length()).toBeCloseTo(1, 5);
      expect(result.length()).toBeCloseTo(1, 5);
    });
  });

  describe("Comparison with Head Calibration", () => {
    it("documents the key difference: body uses target, head uses identity", () => {
      // BODY CALIBRATION: At neutral, q_world = target orientation
      const bodySensor = quatFromEulerDeg(20, 10, 5);
      const bodyTarget = quatFromEulerDeg(0, 0, -10); // Non-identity T-pose target

      const bodyOffset = computeSinglePoseOffset(bodySensor, bodyTarget);
      const bodyResult = applyCalibrationOffset(bodySensor, bodyOffset);

      // Body outputs TARGET at neutral (not identity!)
      expect(bodyResult.angleTo(bodyTarget)).toBeLessThan(0.001);
      expect(bodyResult.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.1);

      // This is CORRECT for body segments because:
      // - Bones have specific orientations in the skeleton's bind pose
      // - The renderer expects world orientations matching the model

      // HEAD CALIBRATION (for comparison) would output identity at neutral
      // because we want "looking forward" = no rotation from parent
    });

    it("body calibration does NOT need frameAlignment pre-compensation", () => {
      // Body calibration uses a single combined offset from Gram-Schmidt
      // There's no separate frameAlignment step, so no pre-compensation needed

      const sensorCalib = quatFromEulerDeg(30, -20, 15);
      const target = new THREE.Quaternion();

      // Simple offset computation (what UnifiedCalibration does)
      const offset = computeSinglePoseOffset(sensorCalib, target);

      // TareState with NO frameAlignment (body segments)
      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: offset,
        mountingTareTime: Date.now(),
        // frameAlignment: undefined (body segments don't use this)
      };

      const quatArray: [number, number, number, number] = [
        sensorCalib.w,
        sensorCalib.x,
        sensorCalib.y,
        sensorCalib.z,
      ];

      const result = transformOrientation(quatArray, tareState);

      // Without frameAlignment, q_world = q_sensor × mountingTare = target ✓
      expect(result.q_world.angleTo(target)).toBeLessThan(0.01);
    });
  });
});
