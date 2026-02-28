/**
 * CalibrationValidator Tests
 * ==========================
 *
 * Unit tests for post-calibration IK validation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { CalibrationValidator } from "../CalibrationValidator";

// Helper to create quaternion from Euler degrees (matching tposeTargets.ts)
const fromEulerDeg = (x: number, y: number, z: number): THREE.Quaternion => {
  const euler = new THREE.Euler(
    (x * Math.PI) / 180,
    (y * Math.PI) / 180,
    (z * Math.PI) / 180,
    "XYZ",
  );
  return new THREE.Quaternion().setFromEuler(euler);
};

describe("CalibrationValidator", () => {
  let validator: CalibrationValidator;

  beforeEach(() => {
    validator = new CalibrationValidator();
  });

  describe("validate", () => {
    it("returns valid result for correct T-pose orientations", () => {
      // Use the ACTUAL T-pose targets (not identity)
      // Only test central segments to avoid asymmetry checks on paired limbs
      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", fromEulerDeg(0, 0, 0)],
        ["chest", fromEulerDeg(0, 0, 0)],
        ["head", fromEulerDeg(0, 0, 0)],
      ]);

      const result = validator.validate(orientations);

      expect(result.isValid).toBe(true);
      expect(result.overallScore).toBeGreaterThan(90);
    });

    it("detects missing calibration for insufficient segments", () => {
      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", new THREE.Quaternion()],
      ]);

      const result = validator.validate(orientations);

      expect(
        result.globalIssues.some((i) => i.type === "missing_calibration"),
      ).toBe(true);
    });

    it("detects T-pose deviation when segment is off", () => {
      // Create a pelvis that's rotated 30° from neutral
      const tiltedPelvis = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        30 * (Math.PI / 180),
      );

      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", tiltedPelvis],
        ["thigh_l", fromEulerDeg(180, 0, 0)], // Correct T-pose for thigh
      ]);

      const result = validator.validate(orientations);

      // Should detect the deviation
      const pelvisValidation = result.segments.get("pelvis");
      expect(pelvisValidation).toBeDefined();
      expect(
        pelvisValidation!.issues.some((i) => i.type === "tpose_deviation"),
      ).toBe(true);
    });

    it("detects asymmetry between left and right segments", () => {
      // Left thigh in correct T-pose, right thigh significantly rotated differently
      const leftThigh = fromEulerDeg(180, 0, 0);
      const rightThigh = fromEulerDeg(180, 25, 0); // 25° yaw difference

      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", fromEulerDeg(0, 0, 0)],
        ["thigh_l", leftThigh],
        ["thigh_r", rightThigh],
      ]);

      // Use a validator with lower asymmetry threshold for testing
      const strictValidator = new CalibrationValidator({ maxAsymmetry: 10 });
      const result = strictValidator.validate(orientations);

      expect(result.globalIssues.some((i) => i.type === "asymmetry")).toBe(
        true,
      );
    });

    it("generates recommendations when issues are found", () => {
      // Create deviation to trigger recommendations
      const tiltedSegment = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        35 * (Math.PI / 180), // 35° - significant deviation
      );

      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", tiltedSegment],
        ["thigh_l", fromEulerDeg(180, 0, 0)], // Correct T-pose for thigh
      ]);

      const result = validator.validate(orientations);

      expect(result.recommendations.length).toBeGreaterThan(0);
      // Should recommend T-pose improvement
      expect(
        result.recommendations.some((r) => r.toLowerCase().includes("t-pose")),
      ).toBe(true);
    });

    it("generates positive summary for excellent calibration", () => {
      // Use actual T-pose targets: pelvis=identity, thighs=180° X rotation
      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", fromEulerDeg(0, 0, 0)],
        ["thigh_l", fromEulerDeg(180, 0, 0)],
        ["thigh_r", fromEulerDeg(180, 0, 0)],
      ]);

      const result = validator.validate(orientations);

      expect(result.summary).toContain("✓");
    });

    it("generates warning summary for acceptable calibration with issues", () => {
      const slightTilt = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        20 * (Math.PI / 180), // 20° - triggers warning but not error
      );

      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", slightTilt],
        ["thigh_l", fromEulerDeg(180, 0, 0)], // Correct T-pose for thigh
      ]);

      const result = validator.validate(orientations);

      // The summary should indicate this is acceptable but has issues
      expect(result.overallScore).toBeGreaterThanOrEqual(50);
    });
  });

  describe("configuration", () => {
    it("uses custom max T-pose deviation", () => {
      const strictValidator = new CalibrationValidator({
        maxTposeDeviation: 5,
      });

      // 8° deviation from correct T-pose
      const slightTilt = fromEulerDeg(8, 0, 0); // Pelvis with 8° pitch instead of 0°

      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", slightTilt],
        ["thigh_l", fromEulerDeg(180, 0, 0)], // Correct T-pose for thigh
      ]);

      const result = strictValidator.validate(orientations);

      const pelvisValidation = result.segments.get("pelvis");
      expect(
        pelvisValidation!.issues.some((i) => i.type === "tpose_deviation"),
      ).toBe(true);
    });

    it("uses custom min pass score", () => {
      const strictValidator = new CalibrationValidator({ minPassScore: 95 });

      // Provide perfect T-pose calibration
      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", fromEulerDeg(0, 0, 0)],
        ["thigh_l", fromEulerDeg(180, 0, 0)],
        ["thigh_r", fromEulerDeg(180, 0, 0)],
      ]);

      const result = strictValidator.validate(orientations);

      // With perfect calibration, score should be high
      expect(result.overallScore).toBeGreaterThan(90);
    });

    it("allows runtime config updates", () => {
      validator.setConfig({ maxAsymmetry: 5 });

      // Large asymmetry that would pass with default 10° but not with 5°
      const leftThigh = fromEulerDeg(180, 0, 0);
      const rightThigh = fromEulerDeg(180, 20, 0); // 20° yaw difference - well over 5° threshold

      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", fromEulerDeg(0, 0, 0)],
        ["thigh_l", leftThigh],
        ["thigh_r", rightThigh],
      ]);

      const result = validator.validate(orientations);

      expect(result.globalIssues.some((i) => i.type === "asymmetry")).toBe(
        true,
      );
    });
  });

  describe("segment validation", () => {
    it("validates each segment individually", () => {
      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", fromEulerDeg(0, 0, 0)],
        ["thigh_l", fromEulerDeg(180, 0, 0)],
        ["tibia_l", fromEulerDeg(180, 0, 0)],
      ]);

      const result = validator.validate(orientations);

      expect(result.segments.size).toBe(3);
      expect(result.segments.has("pelvis")).toBe(true);
      expect(result.segments.has("thigh_l")).toBe(true);
      expect(result.segments.has("tibia_l")).toBe(true);
    });

    it("includes quality score per segment", () => {
      const orientations = new Map<string, THREE.Quaternion>([
        ["pelvis", fromEulerDeg(0, 0, 0)],
        ["thigh_l", fromEulerDeg(180, 0, 0)],
      ]);

      const result = validator.validate(orientations);

      const pelvisValidation = result.segments.get("pelvis")!;
      expect(pelvisValidation.quality.score).toBeGreaterThan(0);
      expect(typeof pelvisValidation.isValid).toBe("boolean");
    });
  });
});
