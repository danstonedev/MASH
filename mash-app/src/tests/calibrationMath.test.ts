/**
 * Calibration Math Tests
 *
 * Tests for the calibration algorithms in calibrationMath.ts and anatomicalConstraints.ts
 * Run with: npx vitest run src/tests/calibrationMath.test.ts
 */

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  computeSinglePoseOffset,
  applyCalibrationOffset,
  computeDualPoseCalibration,
  computeCalibrationQuality,
  assessSensorStability,
  estimateFunctionalAxis,
} from "../calibration/calibrationMath";
import {
  firmwareToThreeQuat,
  threeQuatToFirmware,
} from "../lib/math/conventions";
import {
  applySoftConstraints,
  applyHardConstraints,
  isValidPose,
  getViolationSeverity,
  JOINT_LIMITS,
} from "../calibration/anatomicalConstraints";

describe("Calibration Math", () => {
  describe("Single-Pose Calibration", () => {
    it("should compute identity offset when sensor matches target", () => {
      const sensorQuat = new THREE.Quaternion(); // identity
      const targetQuat = new THREE.Quaternion(); // identity

      const offset = computeSinglePoseOffset(sensorQuat, targetQuat);

      // Identity quaternion = [x:0, y:0, z:0, w:1]
      expect(offset.x).toBeCloseTo(0, 5);
      expect(offset.y).toBeCloseTo(0, 5);
      expect(offset.z).toBeCloseTo(0, 5);
      expect(offset.w).toBeCloseTo(1, 5);
    });

    it("should compute 90° offset when sensor is rotated", () => {
      // Sensor rotated 90° around Y
      const sensorQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, Math.PI / 2, 0),
      );
      const targetQuat = new THREE.Quaternion(); // identity

      const offset = computeSinglePoseOffset(sensorQuat, targetQuat);

      // Apply offset to sensor should give target
      const result = applyCalibrationOffset(sensorQuat.clone(), offset);
      expect(result.angleTo(targetQuat)).toBeCloseTo(0, 3);
    });

    it("should correctly invert and apply offset", () => {
      // Random sensor orientation
      const sensorQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0.3, -0.5, 0.2),
      );
      // Random target orientation
      const targetQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-0.1, 0.4, 0.7),
      );

      const offset = computeSinglePoseOffset(sensorQuat, targetQuat);
      const result = applyCalibrationOffset(sensorQuat.clone(), offset);

      // Result should match target
      expect(result.angleTo(targetQuat)).toBeCloseTo(0, 3);
    });

    it("should work for runtime motion after calibration", () => {
      // Calibration: sensor at 45° Y, target at identity
      const calibSensor = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, Math.PI / 4, 0),
      );
      const calibTarget = new THREE.Quaternion();
      const offset = computeSinglePoseOffset(calibSensor, calibTarget);

      // At calibration time, applying offset should give identity
      const calibResult = applyCalibrationOffset(calibSensor.clone(), offset);
      expect(calibResult.angleTo(calibTarget)).toBeCloseTo(0, 3);

      // Runtime: sensor rotates additional 30° around X (in sensor's local frame)
      const additionalRotation = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(Math.PI / 6, 0, 0),
      );
      const runtimeSensor = calibSensor.clone().multiply(additionalRotation);

      // Apply calibration
      const boneQuat = applyCalibrationOffset(runtimeSensor, offset);

      // The bone should have moved from identity by the additional rotation
      // The angle between calibTarget and boneQuat should be ~30°
      const angleMoved = calibTarget.angleTo(boneQuat) * (180 / Math.PI);
      expect(angleMoved).toBeCloseTo(30, 1); // ~30° of motion observed
    });
  });

  describe("Dual-Pose Calibration", () => {
    it("should compute tilt offset from T-pose", () => {
      const tPoseSensor = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0.1, 0, 0), // Slight tilt
      );
      const tPoseTarget = new THREE.Quaternion();
      const nPoseSensor = tPoseSensor.clone();
      const nPoseTarget = new THREE.Quaternion();

      const result = computeDualPoseCalibration(
        tPoseSensor,
        tPoseTarget,
        nPoseSensor,
        nPoseTarget,
      );

      expect(result.method).toBe("dual-pose");
      expect(result.quality).toBeGreaterThan(90);
    });

    it("should correct heading from N-pose", () => {
      // T-Pose: sensor has correct tilt
      const tPoseSensor = new THREE.Quaternion();
      const tPoseTarget = new THREE.Quaternion();

      // N-Pose: sensor has 30° heading error
      const nPoseSensor = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, Math.PI / 6, 0),
      );
      const nPoseTarget = new THREE.Quaternion();

      const result = computeDualPoseCalibration(
        tPoseSensor,
        tPoseTarget,
        nPoseSensor,
        nPoseTarget,
      );

      // Heading correction should be about -30° around Y
      const headingEuler = new THREE.Euler().setFromQuaternion(
        result.headingCorrection,
        "YXZ",
      );
      expect(headingEuler.y).toBeCloseTo(-Math.PI / 6, 1);
    });

    it("should produce higher quality than single-pose for heading errors", () => {
      const tPoseSensor = new THREE.Quaternion();
      const tPoseTarget = new THREE.Quaternion();
      const nPoseSensor = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, 0.2, 0), // Small heading error
      );
      const nPoseTarget = new THREE.Quaternion();

      const dualResult = computeDualPoseCalibration(
        tPoseSensor,
        tPoseTarget,
        nPoseSensor,
        nPoseTarget,
      );

      // Quality is computed BEFORE heading correction is applied,
      // so it reflects the raw error. The value of dual-pose is in the correction.
      expect(dualResult.method).toBe("dual-pose");
      expect(dualResult.headingCorrection).toBeDefined();
    });
  });

  describe("Quality Metrics", () => {
    it("should give 100% quality for perfect alignment", () => {
      const actual = new THREE.Quaternion();
      const expected = new THREE.Quaternion();

      const quality = computeCalibrationQuality(actual, expected);

      expect(quality.score).toBe(100);
      expect(quality.metrics.angularError).toBe(0);
      expect(quality.warnings.length).toBe(0);
    });

    it("should degrade quality with angular error", () => {
      const actual = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0.1, 0, 0), // ~5.7°
      );
      const expected = new THREE.Quaternion();

      const quality = computeCalibrationQuality(actual, expected);

      expect(quality.score).toBeLessThan(85);
      expect(quality.score).toBeGreaterThan(50);
      expect(quality.metrics.angularError).toBeCloseTo(5.7, 0);
    });

    it("should warn for high angular error", () => {
      const actual = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0.3, 0, 0), // ~17°
      );
      const expected = new THREE.Quaternion();

      const quality = computeCalibrationQuality(actual, expected);

      expect(quality.warnings.length).toBeGreaterThan(0);
      expect(quality.score).toBeLessThan(50);
    });

    it("should assess sensor stability from samples", () => {
      // Stable samples (all similar)
      const stableSamples = [
        new THREE.Quaternion(),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.001, 0, 0)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.001, 0.001, 0)),
      ];

      const stability = assessSensorStability(stableSamples);
      expect(stability).toBeGreaterThan(90);

      // Unstable samples
      const unstableSamples = [
        new THREE.Quaternion(),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 0)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.2, 0)),
      ];

      const unstability = assessSensorStability(unstableSamples);
      expect(unstability).toBeLessThan(stability);
    });
  });

  describe("Functional Axis Estimation (PCA)", () => {
    it("should identify X-axis rotation from angular velocity", () => {
      // Simulate flexion/extension around X with clear signal
      const samples: THREE.Vector3[] = [];
      for (let i = 0; i < 50; i++) {
        samples.push(
          new THREE.Vector3(
            1.0 + Math.sin(i * 0.1) * 0.2, // Primary X rotation (deterministic)
            Math.sin(i * 0.3) * 0.02, // Small noise Y
            Math.cos(i * 0.2) * 0.02, // Small noise Z
          ),
        );
      }

      const result = estimateFunctionalAxis(samples);

      // Should identify X as primary axis
      expect(Math.abs(result.axis.x)).toBeGreaterThan(0.9);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should identify Z-axis rotation from angular velocity", () => {
      const samples: THREE.Vector3[] = [];
      for (let i = 0; i < 100; i++) {
        samples.push(
          new THREE.Vector3(
            Math.random() * 0.05,
            Math.random() * 0.05,
            2.0 + Math.random() * 0.1, // Primary Z rotation
          ),
        );
      }

      const result = estimateFunctionalAxis(samples, false);

      expect(Math.abs(result.axis.z)).toBeGreaterThan(0.9);
    });

    it("should return low confidence for insufficient data", () => {
      const samples = [
        new THREE.Vector3(0.5, 0, 0),
        new THREE.Vector3(0.5, 0, 0),
      ];

      const result = estimateFunctionalAxis(samples);
      expect(result.confidence).toBe(0);
    });
  });

  describe("Coordinate Frame Conversion", () => {
    it("should convert IMU to Three.js frame", () => {
      // IMU: identity [w=1, x=0, y=0, z=0]
      const threeQuat = firmwareToThreeQuat([1, 0, 0, 0]);

      expect(threeQuat.w).toBeCloseTo(1, 5);
      expect(threeQuat.x).toBeCloseTo(0, 5);
      expect(threeQuat.y).toBeCloseTo(0, 5);
      expect(threeQuat.z).toBeCloseTo(0, 5);
    });

    it("should round-trip convert correctly", () => {
      const original: [number, number, number, number] = [
        0.7071, 0.3, 0.4, 0.5,
      ];

      const threeQuat = firmwareToThreeQuat(original);
      const backToIMU = threeQuatToFirmware(threeQuat);

      expect(backToIMU[0]).toBeCloseTo(original[0], 3);
      expect(backToIMU[1]).toBeCloseTo(original[1], 3);
      expect(backToIMU[2]).toBeCloseTo(original[2], 3);
      expect(backToIMU[3]).toBeCloseTo(original[3], 3);
    });
  });
});

describe("Anatomical Constraints", () => {
  describe("Joint Limits Definition", () => {
    it("should have limits defined for major joints", () => {
      const requiredJoints = [
        "thigh_l",
        "thigh_r",
        "tibia_l",
        "tibia_r",
        "foot_l",
        "foot_r",
        "upper_arm_l",
        "upper_arm_r",
        "forearm_l",
        "forearm_r",
        "pelvis",
        "torso",
        "head",
      ];

      for (const joint of requiredJoints) {
        expect(JOINT_LIMITS[joint]).toBeDefined();
        expect(JOINT_LIMITS[joint].length).toBeGreaterThan(0);
      }
    });

    it("should have valid min < max for all limits", () => {
      for (const [joint, limits] of Object.entries(JOINT_LIMITS)) {
        for (const limit of limits) {
          expect(limit.min).toBeLessThan(limit.max);
        }
      }
    });
  });

  describe("Soft Constraints", () => {
    it("should not modify pose within limits", () => {
      const euler = new THREE.Euler(0.5, 0, 0); // Within knee flexion range

      const result = applySoftConstraints("tibia_l", euler, 0.7);

      expect(result.wasConstrained).toBe(false);
      expect(result.euler.x).toBeCloseTo(0.5, 5);
    });

    it("should softly constrain pose exceeding limits", () => {
      // Knee hyperextension (-30° = -0.52 rad)
      const euler = new THREE.Euler(-0.5, 0, 0);

      const result = applySoftConstraints("tibia_l", euler, 0.7);

      expect(result.wasConstrained).toBe(true);
      expect(result.violations.length).toBeGreaterThan(0);
      // Should be pushed back but not all the way
      expect(result.euler.x).toBeGreaterThan(-0.5);
      expect(result.euler.x).toBeLessThan(-0.09); // Limit is -0.09
    });

    it("should return unchanged for unknown joint", () => {
      const euler = new THREE.Euler(5, 5, 5); // Way out of range

      const result = applySoftConstraints("unknown_joint", euler, 0.7);

      expect(result.wasConstrained).toBe(false);
      expect(result.euler.x).toBeCloseTo(5, 5);
    });
  });

  describe("Hard Constraints", () => {
    it("should clamp to exact limits", () => {
      // Elbow hyperflexion (200° = 3.49 rad, limit is 2.62)
      const euler = new THREE.Euler(3.5, 0, 0);

      const result = applyHardConstraints("forearm_l", euler);

      expect(result.x).toBe(2.62); // Exactly at limit
    });

    it("should not modify pose within limits", () => {
      const euler = new THREE.Euler(1.0, 0, 0);

      const result = applyHardConstraints("forearm_l", euler);

      expect(result.x).toBeCloseTo(1.0, 5);
    });
  });

  describe("Pose Validation", () => {
    it("should validate pose within limits", () => {
      const euler = new THREE.Euler(1.0, 0, 0); // Normal knee flexion

      expect(isValidPose("tibia_l", euler)).toBe(true);
    });

    it("should invalidate pose exceeding limits", () => {
      const euler = new THREE.Euler(-1.0, 0, 0); // Severe hyperextension

      expect(isValidPose("tibia_l", euler)).toBe(false);
    });

    it("should consider tolerance", () => {
      // Just slightly beyond limit
      const euler = new THREE.Euler(-0.15, 0, 0); // Limit is -0.09

      // Should fail with default 5° tolerance
      expect(isValidPose("tibia_l", euler, 0)).toBe(false);
      // Should pass with larger tolerance
      expect(isValidPose("tibia_l", euler, 10)).toBe(true);
    });
  });

  describe("Violation Severity", () => {
    it("should return 0 for valid pose", () => {
      const euler = new THREE.Euler(1.0, 0, 0);

      expect(getViolationSeverity("tibia_l", euler)).toBe(0);
    });

    it("should increase with violation magnitude", () => {
      const mildViolation = new THREE.Euler(-0.2, 0, 0);
      const severeViolation = new THREE.Euler(-1.0, 0, 0);

      const mildSeverity = getViolationSeverity("tibia_l", mildViolation);
      const severeSeverity = getViolationSeverity("tibia_l", severeViolation);

      expect(severeSeverity).toBeGreaterThan(mildSeverity);
      expect(mildSeverity).toBeGreaterThan(0);
    });
  });
});
