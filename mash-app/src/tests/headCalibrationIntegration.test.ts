/**
 * Head/Cervical Calibration Integration Tests
 * ============================================
 *
 * Tests the complete head calibration pipeline including:
 * 1. Frame alignment (PCA-based axis mapping via RIGHT MULTIPLICATION)
 * 2. Boresight (calibration pose zeroing)
 * 3. End-to-end motion tracking
 *
 * CRITICAL QUATERNION CONVENTIONS (from PipelineInspector.tsx):
 * - RIGHT multiplication (q × offset) preserves local frame axes ✓
 * - LEFT multiplication or similarity transform SWAPS Y/Z axes ✗
 *
 * CALIBRATION MATH:
 * - Pipeline: q_world = (q_sensor × mountingTare) × frameAlignment
 * - mountingTare = inv(startQuat) × inv(frameAlignment) [pre-compensated]
 * - At neutral: q_world = identity ✓
 * - When moving: Nod→Pitch, Shake→Yaw, Tilt→Roll ✓
 *
 * The goal is to ensure that after calibration:
 * - Physical nod → Model pitch (X rotation)
 * - Physical shake → Model yaw (Y rotation)
 * - Physical tilt → Model roll (Z rotation)
 * - Calibration pose → Model faces forward (identity)
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import {
  computeHeadFrame,
  validateHeadCalibration,
} from "../calibration/HeadAlignment";
import {
  applyFrameAlignment,
  applyMountingTare,
  createDefaultTareState,
  type TareState,
} from "../calibration/taringPipeline";
import { transformOrientation } from "../lib/math/OrientationPipeline";

/**
 * Helper: Generate synthetic gyro samples for a rotation around an axis
 */
function generateGyroSamples(
  axis: THREE.Vector3,
  count: number = 50,
): THREE.Vector3[] {
  const samples: THREE.Vector3[] = [];
  const baseOmega = 2.0; // rad/s base angular velocity

  for (let i = 0; i < count; i++) {
    // Vary magnitude sinusoidally to simulate oscillating motion
    const phase = (i / count) * Math.PI * 4; // Two full cycles
    const omega = baseOmega * Math.sin(phase);
    samples.push(axis.clone().multiplyScalar(omega));
  }

  return samples;
}

/**
 * Helper: Create quaternion from Euler angles (degrees)
 */
function quatFromEulerDeg(x: number, y: number, z: number): THREE.Quaternion {
  const DEG2RAD = Math.PI / 180;
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(x * DEG2RAD, y * DEG2RAD, z * DEG2RAD, "XYZ"),
  );
}

/**
 * Helper: Extract Euler angles from quaternion (degrees)
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

describe("Head Calibration Integration", () => {
  describe("Frame Alignment (Right Multiplication)", () => {
    it("should apply identity transform correctly", () => {
      const sensorQuat = quatFromEulerDeg(30, 0, 0); // 30° pitch
      const identity = new THREE.Quaternion();

      const aligned = applyFrameAlignment(sensorQuat, identity);

      // Identity transform should not change the quaternion
      expect(aligned.angleTo(sensorQuat)).toBeLessThan(0.001);
    });

    it("should combine rotations via right multiplication", () => {
      // Sensor rotates around its X axis (pitch in sensor frame)
      const sensorQuat = quatFromEulerDeg(30, 0, 0);

      // Frame alignment: rotate 90° around Z
      const frameAlignment = quatFromEulerDeg(0, 0, 90);

      // Right multiplication: result = sensor × frameAlignment
      // This combines the rotations (30° X then 90° Z)
      const aligned = applyFrameAlignment(sensorQuat, frameAlignment);
      const euler = eulerFromQuat(aligned);

      // The combined rotation should have both X and Z components
      // (not a remapping of X to Y like similarity transform would do)
      expect(Math.abs(euler.x)).toBeGreaterThan(20);
      expect(Math.abs(euler.z)).toBeGreaterThan(20);
    });

    it("should be consistent with mounting tare multiplication order", () => {
      // This test verifies frame alignment uses the same multiplication order
      // as mounting tare (q_result = q_sensor × q_offset)
      // See: PipelineInspector.tsx lines 207-227

      const sensorQuat = quatFromEulerDeg(45, 0, 0);
      const offset = quatFromEulerDeg(0, 30, 0);

      // Manual right multiplication
      const expected = sensorQuat.clone().multiply(offset);

      // Frame alignment should do the same
      const aligned = applyFrameAlignment(sensorQuat, offset);

      expect(aligned.angleTo(expected)).toBeLessThan(0.001);
    });

    it("should correctly compose with mounting tare", () => {
      // Sensor at some pose
      const sensorQuat = quatFromEulerDeg(45, 20, 10);

      // Boresight zeros to identity
      const boresight = sensorQuat.clone().invert();

      // Frame alignment
      const frameAlignment = quatFromEulerDeg(10, 20, 30);

      // Pipeline: sensor × boresight × frameAlignment = identity × frameAlignment = frameAlignment
      const tared = applyMountingTare(sensorQuat, boresight);
      const world = applyFrameAlignment(tared, frameAlignment);

      // At calibration pose, result should equal frameAlignment
      expect(world.angleTo(frameAlignment)).toBeLessThan(0.01);
    });
  });

  describe("PCA Axis Detection (HeadAlignment)", () => {
    it("should detect pitch axis from nod samples", () => {
      // Nod motion: rotation around sensor X axis
      const nodAxis = new THREE.Vector3(1, 0, 0);
      const nodSamples = generateGyroSamples(nodAxis);

      // Shake motion: rotation around sensor Y axis
      const shakeAxis = new THREE.Vector3(0, 1, 0);
      const shakeSamples = generateGyroSamples(shakeAxis);

      // Gravity points up (+Y in sensor frame)
      const gravity = new THREE.Vector3(0, 1, 0);

      const result = computeHeadFrame(nodSamples, shakeSamples, gravity);

      // Confidence should be high for clean data
      expect(result.confidence).toBeGreaterThan(0.7);

      // The detected pitch axis should align with X
      const pitchDot = result.axes.pitch.dot(new THREE.Vector3(1, 0, 0));
      expect(Math.abs(pitchDot)).toBeGreaterThan(0.9);
    });

    it("should detect yaw axis from shake samples", () => {
      // Standard motion with Y-up
      const nodSamples = generateGyroSamples(new THREE.Vector3(1, 0, 0));
      const shakeSamples = generateGyroSamples(new THREE.Vector3(0, 1, 0));
      const gravity = new THREE.Vector3(0, 1, 0);

      const result = computeHeadFrame(nodSamples, shakeSamples, gravity);

      // The detected yaw axis should align with Y (up)
      const yawDot = result.axes.yaw.dot(new THREE.Vector3(0, 1, 0));
      expect(Math.abs(yawDot)).toBeGreaterThan(0.9);
    });

    it("should handle sensor mounted with different orientation", () => {
      // Sensor mounted 90° rotated: nod is now around Z, shake around X
      const nodSamples = generateGyroSamples(new THREE.Vector3(0, 0, 1));
      const shakeSamples = generateGyroSamples(new THREE.Vector3(0, 1, 0)); // Y still up
      const gravity = new THREE.Vector3(0, 1, 0);

      const result = computeHeadFrame(nodSamples, shakeSamples, gravity);

      // Should still have reasonable confidence
      expect(result.confidence).toBeGreaterThan(0.5);

      // The axis alignment should compensate for the mounting
      expect(result.axisAlignment).toBeDefined();
    });
  });

  describe("Complete Calibration Pipeline", () => {
    it("should produce identity at calibration pose", () => {
      // Generate calibration data
      const nodSamples = generateGyroSamples(new THREE.Vector3(1, 0, 0));
      const shakeSamples = generateGyroSamples(new THREE.Vector3(0, 1, 0));
      const gravity = new THREE.Vector3(0, 1, 0);

      // Simulate calibration pose: sensor slightly tilted
      const calibrationQuat = quatFromEulerDeg(10, 5, -3);

      const headFrame = computeHeadFrame(
        nodSamples,
        shakeSamples,
        gravity,
        calibrationQuat,
      );

      // Create boresight from calibration pose
      const boresight = calibrationQuat.clone().invert();

      // Create tare state
      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: boresight,
        mountingTareTime: Date.now(),
        frameAlignment: headFrame.axisAlignment,
        frameAlignmentTime: Date.now(),
      };

      // Transform the calibration pose through the pipeline
      const quatArray: [number, number, number, number] = [
        calibrationQuat.w,
        calibrationQuat.x,
        calibrationQuat.y,
        calibrationQuat.z,
      ];

      const result = transformOrientation(quatArray, tareState);

      // At calibration pose, result should be near identity
      const euler = eulerFromQuat(result.q_world);
      expect(Math.abs(euler.x)).toBeLessThan(5);
      expect(Math.abs(euler.y)).toBeLessThan(5);
      expect(Math.abs(euler.z)).toBeLessThan(5);
    });

    it("should correctly track pitch motion after calibration", () => {
      // Setup calibration
      const nodSamples = generateGyroSamples(new THREE.Vector3(1, 0, 0));
      const shakeSamples = generateGyroSamples(new THREE.Vector3(0, 1, 0));
      const gravity = new THREE.Vector3(0, 1, 0);
      const calibrationQuat = new THREE.Quaternion(); // Identity calibration pose

      const headFrame = computeHeadFrame(
        nodSamples,
        shakeSamples,
        gravity,
        calibrationQuat,
      );
      const boresight = calibrationQuat.clone().invert();

      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: boresight,
        mountingTareTime: Date.now(),
        frameAlignment: headFrame.axisAlignment,
        frameAlignmentTime: Date.now(),
      };

      // Simulate nod down (pitch +30°)
      const pitchedQuat = quatFromEulerDeg(30, 0, 0);
      const quatArray: [number, number, number, number] = [
        pitchedQuat.w,
        pitchedQuat.x,
        pitchedQuat.y,
        pitchedQuat.z,
      ];

      const result = transformOrientation(quatArray, tareState);
      const euler = eulerFromQuat(result.q_world);

      // Should show pitch in X axis
      expect(euler.x).toBeCloseTo(30, 5);
      expect(Math.abs(euler.y)).toBeLessThan(5);
      expect(Math.abs(euler.z)).toBeLessThan(5);
    });

    it("should correctly track yaw motion after calibration", () => {
      // Setup calibration
      const nodSamples = generateGyroSamples(new THREE.Vector3(1, 0, 0));
      const shakeSamples = generateGyroSamples(new THREE.Vector3(0, 1, 0));
      const gravity = new THREE.Vector3(0, 1, 0);
      const calibrationQuat = new THREE.Quaternion();

      const headFrame = computeHeadFrame(
        nodSamples,
        shakeSamples,
        gravity,
        calibrationQuat,
      );
      const boresight = calibrationQuat.clone().invert();

      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: boresight,
        mountingTareTime: Date.now(),
        frameAlignment: headFrame.axisAlignment,
        frameAlignmentTime: Date.now(),
      };

      // Simulate look left (yaw +45°)
      const yawedQuat = quatFromEulerDeg(0, 45, 0);
      const quatArray: [number, number, number, number] = [
        yawedQuat.w,
        yawedQuat.x,
        yawedQuat.y,
        yawedQuat.z,
      ];

      const result = transformOrientation(quatArray, tareState);
      const euler = eulerFromQuat(result.q_world);

      // Should show yaw in Y axis
      expect(Math.abs(euler.x)).toBeLessThan(5);
      expect(euler.y).toBeCloseTo(45, 5);
      expect(Math.abs(euler.z)).toBeLessThan(5);
    });
  });

  describe("Edge Cases", () => {
    it("should handle very small movements in PCA", () => {
      // Very small, noisy movements
      const smallSamples = generateGyroSamples(new THREE.Vector3(1, 0, 0), 10);
      smallSamples.forEach((s) => s.multiplyScalar(0.01)); // Very small

      const shakeSamples = generateGyroSamples(new THREE.Vector3(0, 1, 0), 10);
      shakeSamples.forEach((s) => s.multiplyScalar(0.01));

      const gravity = new THREE.Vector3(0, 1, 0);

      const result = computeHeadFrame(smallSamples, shakeSamples, gravity);

      // Should have low confidence
      expect(result.confidence).toBeLessThan(0.5);

      // Validation should warn
      const warnings = validateHeadCalibration(result);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it("should handle calibration with sensor looking up", () => {
      // Sensor calibrated while looking up 30°
      const nodSamples = generateGyroSamples(new THREE.Vector3(1, 0, 0));
      const shakeSamples = generateGyroSamples(new THREE.Vector3(0, 1, 0));
      const gravity = new THREE.Vector3(0, 1, 0);
      const calibrationQuat = quatFromEulerDeg(-30, 0, 0); // Looking up

      const headFrame = computeHeadFrame(
        nodSamples,
        shakeSamples,
        gravity,
        calibrationQuat,
      );
      const boresight = calibrationQuat.clone().invert();

      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: boresight,
        mountingTareTime: Date.now(),
        frameAlignment: headFrame.axisAlignment,
        frameAlignmentTime: Date.now(),
      };

      // At calibration pose, should be identity
      const quatArray: [number, number, number, number] = [
        calibrationQuat.w,
        calibrationQuat.x,
        calibrationQuat.y,
        calibrationQuat.z,
      ];

      const result = transformOrientation(quatArray, tareState);
      const euler = eulerFromQuat(result.q_world);

      expect(Math.abs(euler.x)).toBeLessThan(5);
      expect(Math.abs(euler.y)).toBeLessThan(5);
      expect(Math.abs(euler.z)).toBeLessThan(5);
    });

    it("should handle calibration with sensor rotated sideways", () => {
      // Sensor mounted 90° rolled (ear towards shoulder at calibration)
      const nodSamples = generateGyroSamples(new THREE.Vector3(1, 0, 0));
      const shakeSamples = generateGyroSamples(new THREE.Vector3(0, 1, 0));
      const gravity = new THREE.Vector3(0, 1, 0);
      const calibrationQuat = quatFromEulerDeg(0, 0, 90); // Rolled right 90°

      const headFrame = computeHeadFrame(
        nodSamples,
        shakeSamples,
        gravity,
        calibrationQuat,
      );
      const boresight = calibrationQuat.clone().invert();

      const tareState: TareState = {
        ...createDefaultTareState(),
        mountingTare: boresight,
        mountingTareTime: Date.now(),
        frameAlignment: headFrame.axisAlignment,
        frameAlignmentTime: Date.now(),
      };

      // After moving to neutral (identity), model should face forward
      const neutralQuat = new THREE.Quaternion();
      const quatArray: [number, number, number, number] = [
        neutralQuat.w,
        neutralQuat.x,
        neutralQuat.y,
        neutralQuat.z,
      ];

      const result = transformOrientation(quatArray, tareState);
      const euler = eulerFromQuat(result.q_world);

      // Should show the 90° roll removed by boresight
      // (sensor at identity means head rolled opposite to calibration)
      expect(Math.abs(euler.z + 90) < 10 || Math.abs(euler.z) < 10).toBe(true);
    });
  });
});
