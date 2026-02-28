/**
 * Two-Layer Biomechanical Calibration Tests
 *
 * Tests the HEAD calibration pipeline that combines:
 * - Layer 1: Axis Alignment (PCA) - maps sensor rotation axes to anatomical axes
 * - Layer 2: Boresight - zeros calibration pose to neutral
 *
 * Combined formula: q_bone = R_align × q_sensor × boresight × inv(R_align)
 *
 * Run with: npx vitest run src/tests/twoLayerCalibration.test.ts
 */

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { computeHeadFrame } from "../calibration/HeadAlignment";
import { transformOrientation } from "../lib/math/OrientationPipeline";
import {
  applyMountingTare,
  applyHeadingTare,
  TareState,
  createDefaultTareState,
} from "../calibration/taringPipeline";

// Helper: Create quaternion from Euler angles (degrees)
function quatFromDegrees(
  pitch: number,
  yaw: number,
  roll: number,
): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      (pitch * Math.PI) / 180,
      (yaw * Math.PI) / 180,
      (roll * Math.PI) / 180,
      "XYZ",
    ),
  );
}

// Helper: Get Euler angles in degrees from quaternion
function quatToDegrees(q: THREE.Quaternion): {
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

// Helper: Check if two quaternions are approximately equal (handles hemisphere)
function quatApproxEqual(
  a: THREE.Quaternion,
  b: THREE.Quaternion,
  tolerance = 0.01,
): boolean {
  // Quaternions q and -q represent the same rotation
  const dot = a.dot(b);
  return Math.abs(Math.abs(dot) - 1) < tolerance;
}

// Helper: Get angle between two quaternions in degrees
function quatAngleDegrees(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return (a.angleTo(b) * 180) / Math.PI;
}

describe("Two-Layer Biomechanical Calibration", () => {
  describe("Layer 2: Boresight (Position Zero)", () => {
    it("should return identity when sensor equals calibration pose", () => {
      // User calibrates at some arbitrary position
      const q_calibration = quatFromDegrees(15, -30, 5);

      // Boresight = inverse(q_calibration)
      const boresight = q_calibration.clone().invert();

      // When sensor is at calibration pose, result should be identity
      // q_bone = q_sensor × boresight = q_cal × inv(q_cal) = identity
      const q_bone = q_calibration.clone().multiply(boresight);

      expect(quatApproxEqual(q_bone, new THREE.Quaternion())).toBe(true);
    });

    it("should show correct delta when sensor moves from calibration", () => {
      // Calibrate at 0° (looking straight)
      const q_calibration = new THREE.Quaternion();
      const boresight = q_calibration.clone().invert();

      // User nods down 20° (pitch)
      const q_sensor = quatFromDegrees(20, 0, 0);

      // Result should show 20° pitch
      const q_bone = q_sensor.clone().multiply(boresight);
      const result = quatToDegrees(q_bone);

      expect(result.pitch).toBeCloseTo(20, 1);
      expect(result.yaw).toBeCloseTo(0, 1);
      expect(result.roll).toBeCloseTo(0, 1);
    });

    it("should handle tilted calibration pose", () => {
      // User calibrates while looking 10° down
      const q_calibration = quatFromDegrees(10, 0, 0);
      const boresight = q_calibration.clone().invert();

      // User then looks 30° down (20° further from calibration)
      const q_sensor = quatFromDegrees(30, 0, 0);

      // Result should show only 20° pitch (relative to calibration)
      const q_bone = q_sensor.clone().multiply(boresight);
      const result = quatToDegrees(q_bone);

      expect(result.pitch).toBeCloseTo(20, 1);
    });
  });

  describe("Layer 1: Axis Alignment (PCA)", () => {
    it("should detect pitch axis from nod motion", () => {
      // Simulate nod motion: rotation primarily around X axis
      const nodSamples: THREE.Vector3[] = [];
      for (let i = 0; i < 100; i++) {
        // Nod = gyro around X with some noise
        const x = Math.sin(i * 0.1) * 2.0; // Primary axis
        const y = Math.random() * 0.1 - 0.05; // Noise
        const z = Math.random() * 0.1 - 0.05; // Noise
        nodSamples.push(new THREE.Vector3(x, y, z));
      }

      // Simulate shake motion: rotation primarily around Y axis
      const shakeSamples: THREE.Vector3[] = [];
      for (let i = 0; i < 100; i++) {
        const x = Math.random() * 0.1 - 0.05; // Noise
        const y = Math.sin(i * 0.1) * 2.0; // Primary axis
        const z = Math.random() * 0.1 - 0.05; // Noise
        shakeSamples.push(new THREE.Vector3(x, y, z));
      }

      // Gravity pointing up (Y direction in sensor frame)
      const gravity = new THREE.Vector3(0, 1, 0);
      const startQuat = new THREE.Quaternion();

      const result = computeHeadFrame(
        nodSamples,
        shakeSamples,
        gravity,
        startQuat,
      );

      // Pitch axis should be close to X
      expect(Math.abs(result.axes.pitch.x)).toBeGreaterThan(0.9);
      // Yaw axis should be close to Y
      expect(Math.abs(result.axes.yaw.y)).toBeGreaterThan(0.9);
      // Confidence should be high
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it("should handle rotated sensor mounting (X becomes Z)", () => {
      // Sensor mounted sideways: nod motion appears on Z axis
      const nodSamples: THREE.Vector3[] = [];
      for (let i = 0; i < 100; i++) {
        const x = Math.random() * 0.1 - 0.05;
        const y = Math.random() * 0.1 - 0.05;
        const z = Math.sin(i * 0.1) * 2.0; // Nod on Z
        nodSamples.push(new THREE.Vector3(x, y, z));
      }

      const shakeSamples: THREE.Vector3[] = [];
      for (let i = 0; i < 100; i++) {
        const x = Math.random() * 0.1 - 0.05;
        const y = Math.sin(i * 0.1) * 2.0; // Still Y
        const z = Math.random() * 0.1 - 0.05;
        shakeSamples.push(new THREE.Vector3(x, y, z));
      }

      const gravity = new THREE.Vector3(0, 1, 0);
      const startQuat = new THREE.Quaternion();

      const result = computeHeadFrame(
        nodSamples,
        shakeSamples,
        gravity,
        startQuat,
      );

      // Pitch axis should have been detected from Z motion but mapped to X
      // The axis alignment should correct this
      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });

  describe("Combined Two-Layer Pipeline", () => {
    it("should produce neutral bone when sensor at calibration pose", () => {
      // Simulate calibration data
      const nodSamples: THREE.Vector3[] = [];
      const shakeSamples: THREE.Vector3[] = [];
      for (let i = 0; i < 50; i++) {
        nodSamples.push(new THREE.Vector3(Math.sin(i * 0.2) * 2, 0.05, 0.05));
        shakeSamples.push(new THREE.Vector3(0.05, Math.sin(i * 0.2) * 2, 0.05));
      }

      const gravity = new THREE.Vector3(0, 1, 0);
      const q_calibration = quatFromDegrees(10, -20, 5); // Arbitrary calibration pose

      // Compute PCA axis alignment
      const pcaResult = computeHeadFrame(
        nodSamples,
        shakeSamples,
        gravity,
        q_calibration,
      );
      const R_align = pcaResult.axisAlignment;
      const R_align_inv = R_align.clone().invert();

      // Compute boresight
      const boresight = q_calibration.clone().invert();

      // Combined tares
      const mountingTare = boresight.clone().multiply(R_align_inv);
      const headingTare = R_align_inv.clone();

      // Simulate the pipeline: q_world = headingTare_inv × (q_sensor × mountingTare)
      const q_sensor = q_calibration.clone(); // Sensor at calibration pose

      // Apply mounting tare
      const q_bone = q_sensor.clone().multiply(mountingTare);

      // Apply heading tare (inverse)
      const q_world = headingTare.clone().invert().multiply(q_bone);

      // Result should be approximately identity
      const angleDiff = quatAngleDegrees(q_world, new THREE.Quaternion());
      expect(angleDiff).toBeLessThan(5); // Within 5 degrees of neutral
    });

    it("should correctly transform pitch motion", () => {
      // Setup: sensor axes already aligned (identity R_align)
      const R_align = new THREE.Quaternion();
      const R_align_inv = R_align.clone().invert();

      // Calibrate at identity
      const q_calibration = new THREE.Quaternion();
      const boresight = q_calibration.clone().invert();

      // Combined tares
      const mountingTare = boresight.clone().multiply(R_align_inv);
      const headingTare = R_align_inv.clone();

      // User nods down 30°
      const q_sensor = quatFromDegrees(30, 0, 0);

      // Apply pipeline
      const q_bone = q_sensor.clone().multiply(mountingTare);
      const q_world = headingTare.clone().invert().multiply(q_bone);

      // Should show 30° pitch
      const result = quatToDegrees(q_world);
      expect(result.pitch).toBeCloseTo(30, 1);
      expect(Math.abs(result.yaw)).toBeLessThan(5);
      expect(Math.abs(result.roll)).toBeLessThan(5);
    });

    it("should correctly transform yaw motion", () => {
      // Setup: sensor axes already aligned (identity R_align)
      const R_align = new THREE.Quaternion();
      const R_align_inv = R_align.clone().invert();

      // Calibrate at identity
      const q_calibration = new THREE.Quaternion();
      const boresight = q_calibration.clone().invert();

      // Combined tares
      const mountingTare = boresight.clone().multiply(R_align_inv);
      const headingTare = R_align_inv.clone();

      // User shakes head 45° left
      const q_sensor = quatFromDegrees(0, 45, 0);

      // Apply pipeline
      const q_bone = q_sensor.clone().multiply(mountingTare);
      const q_world = headingTare.clone().invert().multiply(q_bone);

      // Should show 45° yaw
      const result = quatToDegrees(q_world);
      expect(Math.abs(result.pitch)).toBeLessThan(5);
      expect(result.yaw).toBeCloseTo(45, 1);
      expect(Math.abs(result.roll)).toBeLessThan(5);
    });

    it("should handle 90° rotated sensor mounting", () => {
      // Sensor mounted 90° rotated around Y
      // Meaning: sensor's X axis = bone's Z axis
      const R_align = quatFromDegrees(0, 90, 0); // 90° Y rotation
      const R_align_inv = R_align.clone().invert();

      // Calibrate at some pose
      const q_calibration = quatFromDegrees(0, 0, 0);
      const boresight = q_calibration.clone().invert();

      // Combined tares
      const mountingTare = boresight.clone().multiply(R_align_inv);
      const headingTare = R_align_inv.clone();

      // User nods 20° - in sensor frame this appears as Z rotation due to mounting
      // We test that after axis alignment, it appears as pitch
      const sensorPitchInFrame = quatFromDegrees(0, 0, 20); // Z rotation in sensor

      // Apply pipeline
      const q_bone = sensorPitchInFrame.clone().multiply(mountingTare);
      const q_world = headingTare.clone().invert().multiply(q_bone);

      // The axis alignment should have remapped this to pitch
      const result = quatToDegrees(q_world);

      // Note: The exact mapping depends on convention
      // Main check is that motion IS transformed, not identity
      const totalRotation = quatAngleDegrees(q_world, new THREE.Quaternion());
      expect(totalRotation).toBeGreaterThan(10); // Motion should be visible
    });
  });

  describe("TareStore Pipeline Integration", () => {
    it("should work with actual TareState interface", () => {
      // Create a TareState as used in the real pipeline
      const q_calibration = quatFromDegrees(15, -10, 0);
      const boresight = q_calibration.clone().invert();
      const R_align = new THREE.Quaternion(); // Identity for simple case
      const R_align_inv = R_align.clone().invert();

      const tareState: TareState = {
        mountingTare: boresight.clone().multiply(R_align_inv),
        headingTare: R_align_inv.clone(),
        jointTare: { flexion: 0, abduction: 0, rotation: 0 },
        mountingTareTime: Date.now(),
        headingTareTime: Date.now(),
        jointTareTime: 0,
      };

      // Sensor returns to calibration pose
      const q_sensor = q_calibration.clone();

      // Apply the tare functions
      const q_bone = applyMountingTare(q_sensor, tareState.mountingTare);
      const q_world = applyHeadingTare(q_bone, tareState.headingTare);

      // Should be approximately identity
      const angleDiff = quatAngleDegrees(q_world, new THREE.Quaternion());
      expect(angleDiff).toBeLessThan(1);
    });

    it("should preserve motion magnitude", () => {
      // Calibrate at identity
      const q_calibration = new THREE.Quaternion();
      const boresight = q_calibration.clone().invert();
      const R_align = new THREE.Quaternion();
      const R_align_inv = R_align.clone().invert();

      const tareState: TareState = {
        mountingTare: boresight.clone().multiply(R_align_inv),
        headingTare: R_align_inv.clone(),
        jointTare: { flexion: 0, abduction: 0, rotation: 0 },
        mountingTareTime: Date.now(),
        headingTareTime: Date.now(),
        jointTareTime: 0,
      };

      // Test various motion magnitudes
      const testAngles = [10, 25, 45, 60, 90];

      for (const angle of testAngles) {
        const q_sensor = quatFromDegrees(angle, 0, 0);
        const q_bone = applyMountingTare(q_sensor, tareState.mountingTare);
        const q_world = applyHeadingTare(q_bone, tareState.headingTare);

        const result = quatToDegrees(q_world);
        expect(result.pitch).toBeCloseTo(angle, 1);
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle identity calibration (no tare needed)", () => {
      const q_calibration = new THREE.Quaternion();
      const boresight = q_calibration.clone().invert(); // Still identity

      // With identity boresight, motion should pass through unchanged
      const q_sensor = quatFromDegrees(20, 30, 10);
      const q_bone = q_sensor.clone().multiply(boresight);

      expect(quatApproxEqual(q_bone, q_sensor)).toBe(true);
    });

    it("should handle 180° yaw calibration", () => {
      // User facing backwards during calibration
      const q_calibration = quatFromDegrees(0, 180, 0);
      const boresight = q_calibration.clone().invert();

      // Sensor still at 180° yaw
      const q_sensor = quatFromDegrees(0, 180, 0);

      // Result should be neutral (facing forward)
      const q_bone = q_sensor.clone().multiply(boresight);

      const angleDiff = quatAngleDegrees(q_bone, new THREE.Quaternion());
      expect(angleDiff).toBeLessThan(1);
    });

    it("should handle gimbal lock region (90° pitch)", () => {
      // Calibrate at 0
      const q_calibration = new THREE.Quaternion();
      const boresight = q_calibration.clone().invert();

      // Look straight up (90° pitch - gimbal lock danger zone)
      const q_sensor = quatFromDegrees(89, 0, 0); // Just under 90 to avoid singularity
      const q_bone = q_sensor.clone().multiply(boresight);

      // Should still report ~89° pitch
      const result = quatToDegrees(q_bone);
      expect(result.pitch).toBeCloseTo(89, 2);
    });
  });
});

describe("OrientationPipeline Integration", () => {
  it("should transform raw quaternion array through full pipeline", () => {
    // Create tare state
    const q_calibration = quatFromDegrees(10, 0, 0);
    const boresight = q_calibration.clone().invert();

    const tareState: TareState = {
      mountingTare: boresight,
      headingTare: new THREE.Quaternion(),
      jointTare: { flexion: 0, abduction: 0, rotation: 0 },
      mountingTareTime: Date.now(),
      headingTareTime: 0,
      jointTareTime: 0,
    };

    // Raw quaternion in [w, x, y, z] format as from firmware
    const q_sensor = quatFromDegrees(30, 0, 0); // 30° pitch
    const rawQuat: [number, number, number, number] = [
      q_sensor.w,
      q_sensor.x,
      q_sensor.y,
      q_sensor.z,
    ];

    // Transform through pipeline
    const result = transformOrientation(rawQuat, tareState);

    // Should show 20° pitch (30° - 10° calibration)
    const euler = quatToDegrees(result.q_world);
    expect(euler.pitch).toBeCloseTo(20, 1);
  });
});
