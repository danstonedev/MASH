/**
 * Walking Refinement Tests
 *
 * Validates the three post-calibration upgrades:
 *   1. Swing-phase knee abduction zeroing
 *   2. Foot-flat heading reset
 *   3. Anthropometric segment scaling
 *
 * Test strategy:
 *   - Generate synthetic walking data with KNOWN calibration errors
 *   - Verify each algorithm detects and corrects the error
 *   - Test edge cases (insufficient data, extreme values, rate limiting)
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import {
  computeKneeAbdZeroing,
  IncrementalKneeAbdZeroing,
  FootFlatHeadingReset,
  applyAnthropometricScale,
  getSegmentLengths,
} from "../calibration/walkingRefinement";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Generate synthetic walking quaternion data with a known false abduction.
 *
 * Simulates a knee hinge with:
 *   - Flexion oscillating 0° → 60° → 0° (walking cycle)
 *   - A deliberate false abduction of `falseAbdDeg` baked into calibration
 *   - Tibia gyro magnitude high during swing (flexion > 20°), low during stance
 *
 * @param numFrames Number of frames to generate
 * @param falseAbdDeg Injected false abduction error (degrees)
 * @param cycles Number of walking cycles
 */
function generateWalkingData(
  numFrames: number = 200,
  falseAbdDeg: number = 5,
  cycles: number = 4,
): {
  thighQuats: THREE.Quaternion[];
  tibiaQuats: THREE.Quaternion[];
  tibiaGyroMag: number[];
} {
  const thighQuats: THREE.Quaternion[] = [];
  const tibiaQuats: THREE.Quaternion[] = [];
  const tibiaGyroMag: number[] = [];

  const falseAbdRad = (falseAbdDeg * Math.PI) / 180;

  for (let i = 0; i < numFrames; i++) {
    const phase = (i / numFrames) * cycles * 2 * Math.PI;

    // Knee flexion: sinusoidal 0° to 60°
    const flexionDeg = 30 * (1 - Math.cos(phase)); // 0 to 60°
    const flexionRad = (flexionDeg * Math.PI) / 180;

    // Thigh has slight forward lean (~15° flexion)
    const thighQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.26, 0, 0, "XYZ"), // ~15° forward lean
    );

    // Tibia = thigh rotation * knee flexion * false abduction error
    // XZY extraction: flexion=euler.z, abduction=euler.x, rotation=euler.y
    // So put flexion in Z, false abduction in X
    const kneeRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(falseAbdRad, 0, flexionRad, "XZY"),
    );
    const tibiaQuat = thighQuat.clone().multiply(kneeRotation);

    thighQuats.push(thighQuat);
    tibiaQuats.push(tibiaQuat);

    // Gyro magnitude: high during swing (flexion > 20°), low during stance
    tibiaGyroMag.push(flexionDeg > 20 ? 2.5 : 0.3);
  }

  return { thighQuats, tibiaQuats, tibiaGyroMag };
}

// ============================================================================
// 1. SWING-PHASE KNEE ABDUCTION ZEROING
// ============================================================================

describe("Swing-Phase Knee Abduction Zeroing", () => {
  describe("computeKneeAbdZeroing (batch)", () => {
    it("detects and corrects 5° false abduction", () => {
      const { thighQuats, tibiaQuats, tibiaGyroMag } = generateWalkingData(
        200,
        5,
      );

      const result = computeKneeAbdZeroing(
        thighQuats,
        tibiaQuats,
        tibiaGyroMag,
      );

      expect(result).not.toBeNull();
      expect(result!.swingSamples).toBeGreaterThan(10);
      // Mean false abduction should be ~5°
      expect(result!.meanFalseAbduction).toBeCloseTo(5, 0);
      // Correction should be approximately −5°
      expect(result!.correctionDeg).toBeCloseTo(-5, 0);
      // Low std (consistent error)
      expect(result!.stdAbduction).toBeLessThan(3);
    });

    it("detects negative (varus) false abduction", () => {
      const { thighQuats, tibiaQuats, tibiaGyroMag } = generateWalkingData(
        200,
        -7,
      );

      const result = computeKneeAbdZeroing(
        thighQuats,
        tibiaQuats,
        tibiaGyroMag,
      );

      expect(result).not.toBeNull();
      expect(result!.meanFalseAbduction).toBeCloseTo(-7, 0);
      expect(result!.correctionDeg).toBeCloseTo(7, 0);
    });

    it("returns near-zero correction for well-calibrated data", () => {
      const { thighQuats, tibiaQuats, tibiaGyroMag } = generateWalkingData(
        200,
        0,
      );

      const result = computeKneeAbdZeroing(
        thighQuats,
        tibiaQuats,
        tibiaGyroMag,
      );

      expect(result).not.toBeNull();
      expect(Math.abs(result!.meanFalseAbduction)).toBeLessThan(1);
      expect(Math.abs(result!.correctionDeg)).toBeLessThan(1);
    });

    it("returns null for insufficient data", () => {
      const result = computeKneeAbdZeroing(
        [new THREE.Quaternion()],
        [new THREE.Quaternion()],
        [2.0],
      );
      expect(result).toBeNull();
    });

    it("returns null when no frames qualify as mid-swing", () => {
      // All low gyro → no swing detected
      const n = 50;
      const thighQuats = Array(n)
        .fill(null)
        .map(() => new THREE.Quaternion());
      const tibiaQuats = Array(n)
        .fill(null)
        .map(() => new THREE.Quaternion());
      const tibiaGyroMag = Array(n).fill(0.1); // all very low

      const result = computeKneeAbdZeroing(
        thighQuats,
        tibiaQuats,
        tibiaGyroMag,
      );
      expect(result).toBeNull();
    });

    it("correction quaternion is approximately the inverse rotation", () => {
      const { thighQuats, tibiaQuats, tibiaGyroMag } = generateWalkingData(
        200,
        8,
      );

      const result = computeKneeAbdZeroing(
        thighQuats,
        tibiaQuats,
        tibiaGyroMag,
      );

      expect(result).not.toBeNull();
      // The correction quat rotated about Y axis should be ~8° magnitude
      const angle = 2 * Math.acos(Math.abs(result!.correctionQuat.w));
      const angleDeg = (angle * 180) / Math.PI;
      expect(angleDeg).toBeCloseTo(8, 0);
    });
  });

  describe("IncrementalKneeAbdZeroing", () => {
    it("accumulates frames and provides correction", () => {
      const zeroing = new IncrementalKneeAbdZeroing();
      const { thighQuats, tibiaQuats, tibiaGyroMag } = generateWalkingData(
        200,
        5,
      );

      let accepted = 0;
      for (let i = 0; i < thighQuats.length; i++) {
        if (zeroing.addFrame(thighQuats[i], tibiaQuats[i], tibiaGyroMag[i])) {
          accepted++;
        }
      }

      expect(accepted).toBeGreaterThan(10);
      expect(zeroing.sampleCount).toBe(accepted);

      const result = zeroing.getCorrection();
      expect(result).not.toBeNull();
      expect(result!.meanFalseAbduction).toBeCloseTo(5, 0);
    });

    it("returns null before minimum samples", () => {
      const zeroing = new IncrementalKneeAbdZeroing();
      expect(zeroing.getCorrection()).toBeNull();

      // Add a few frames but not enough
      const q = new THREE.Quaternion();
      const tibiaQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(1.0, 0, 0.1, "XZY"),
      );
      for (let i = 0; i < 3; i++) {
        zeroing.addFrame(q, tibiaQ, 2.0);
      }
      expect(zeroing.getCorrection()).toBeNull();
    });

    it("reset clears accumulated data", () => {
      const zeroing = new IncrementalKneeAbdZeroing();
      const { thighQuats, tibiaQuats, tibiaGyroMag } = generateWalkingData(
        200,
        5,
      );

      for (let i = 0; i < 50; i++) {
        zeroing.addFrame(thighQuats[i], tibiaQuats[i], tibiaGyroMag[i]);
      }

      expect(zeroing.sampleCount).toBeGreaterThan(0);
      zeroing.reset();
      expect(zeroing.sampleCount).toBe(0);
      expect(zeroing.getCorrection()).toBeNull();
    });

    it("sliding window caps at maxSamples", () => {
      const zeroing = new IncrementalKneeAbdZeroing(20); // small max
      const { thighQuats, tibiaQuats, tibiaGyroMag } = generateWalkingData(
        200,
        5,
      );

      for (let i = 0; i < thighQuats.length; i++) {
        zeroing.addFrame(thighQuats[i], tibiaQuats[i], tibiaGyroMag[i]);
      }

      expect(zeroing.sampleCount).toBeLessThanOrEqual(20);
    });
  });
});

// ============================================================================
// 2. FOOT-FLAT HEADING RESET
// ============================================================================

describe("Foot-Flat Heading Reset", () => {
  let headingReset: FootFlatHeadingReset;

  beforeEach(() => {
    headingReset = new FootFlatHeadingReset(500, 0.3, 10);
  });

  it("produces heading anchor when foot is flat and grounded", () => {
    // Foot perfectly level, facing forward (yaw=0)
    const footQuat = new THREE.Quaternion(); // identity = level, facing Z+
    const result = headingReset.tryReset("left", footQuat, 0.1, true, 1000);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0.5);
    expect(result!.timestamp).toBe(1000);
    // First reset: drift should be 0 (reference established)
    expect(result!.driftDeg).toBe(0);
  });

  it("detects heading drift on subsequent resets", () => {
    // First reset: establish reference at yaw=0
    const q0 = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, 0, "YXZ"),
    );
    headingReset.tryReset("left", q0, 0.1, true, 1000);

    // Second reset: yaw has drifted 5°
    const driftRad = (5 * Math.PI) / 180;
    const q1 = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, driftRad, 0, "YXZ"),
    );
    const result = headingReset.tryReset("left", q1, 0.1, true, 2000);

    expect(result).not.toBeNull();
    expect(result!.driftDeg).toBeCloseTo(5, 0);
  });

  it("rejects when foot is not grounded", () => {
    const footQuat = new THREE.Quaternion();
    const result = headingReset.tryReset("left", footQuat, 0.1, false, 1000);
    expect(result).toBeNull();
  });

  it("rejects when gyro is too high", () => {
    const footQuat = new THREE.Quaternion();
    const result = headingReset.tryReset("left", footQuat, 0.5, true, 1000);
    expect(result).toBeNull();
  });

  it("rejects when foot is tilted", () => {
    // 20° pitch — too tilted for foot-flat
    const tiltedQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.35, 0, 0, "YXZ"),
    );
    const result = headingReset.tryReset("left", tiltedQuat, 0.1, true, 1000);
    expect(result).toBeNull();
  });

  it("rate-limits resets per foot", () => {
    const footQuat = new THREE.Quaternion();

    // First reset succeeds
    const r1 = headingReset.tryReset("left", footQuat, 0.1, true, 1000);
    expect(r1).not.toBeNull();

    // Second reset too soon (< 500ms)
    const r2 = headingReset.tryReset("left", footQuat, 0.1, true, 1200);
    expect(r2).toBeNull();

    // Third reset after interval
    const r3 = headingReset.tryReset("left", footQuat, 0.1, true, 1600);
    expect(r3).not.toBeNull();
  });

  it("tracks left and right feet independently", () => {
    const footQuat = new THREE.Quaternion();

    // Left foot reset
    const rL = headingReset.tryReset("left", footQuat, 0.1, true, 1000);
    expect(rL).not.toBeNull();

    // Right foot reset at same time — should work (independent rate limiting)
    const rR = headingReset.tryReset("right", footQuat, 0.1, true, 1000);
    expect(rR).not.toBeNull();

    expect(headingReset.totalResets).toBe(2);
  });

  it("heading anchor is gravity-aligned (zero pitch/roll)", () => {
    // Foot with slight pitch but valid (< 10°)
    const footQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.05, 0.3, 0.02, "YXZ"), // pitch=~3°, yaw=17°, roll=~1°
    );
    const result = headingReset.tryReset("left", footQuat, 0.1, true, 1000);

    expect(result).not.toBeNull();
    // The anchor should have zero pitch/roll, only yaw
    const anchorEuler = new THREE.Euler().setFromQuaternion(
      result!.headingAnchor,
      "YXZ",
    );
    expect(Math.abs(anchorEuler.x)).toBeLessThan(0.001); // no pitch
    expect(Math.abs(anchorEuler.z)).toBeLessThan(0.001); // no roll
    expect(Math.abs(anchorEuler.y)).toBeCloseTo(0.3, 1); // yaw preserved
  });

  it("reset clears state", () => {
    const footQuat = new THREE.Quaternion();
    headingReset.tryReset("left", footQuat, 0.1, true, 1000);
    expect(headingReset.totalResets).toBe(1);

    headingReset.reset();
    expect(headingReset.totalResets).toBe(0);

    // Should be able to reset immediately after clear
    const r = headingReset.tryReset("left", footQuat, 0.1, true, 1001);
    expect(r).not.toBeNull();
  });
});

// ============================================================================
// 3. ANTHROPOMETRIC SEGMENT SCALING
// ============================================================================

describe("Anthropometric Segment Scaling", () => {
  it("applies uniform scale factor based on height", () => {
    const scale = applyAnthropometricScale(180);
    expect(scale).toBeCloseTo(1.0, 3);

    const scale2 = applyAnthropometricScale(160);
    expect(scale2).toBeCloseTo(160 / 180, 3);

    const scale3 = applyAnthropometricScale(200);
    expect(scale3).toBeCloseTo(200 / 180, 3);
  });

  it("getSegmentLengths returns De Leva proportions", () => {
    const lengths = getSegmentLengths(180, 75, "male");

    expect(lengths).toBeInstanceOf(Map);
    expect(lengths.size).toBeGreaterThan(0);

    // Thigh should be ~0.245 * 1.8m = 0.441m
    const thigh = lengths.get("thigh_l");
    expect(thigh).toBeDefined();
    expect(thigh!).toBeCloseTo(0.441, 2);

    // Tibia should be ~0.246 * 1.8m = 0.4428m
    const tibia = lengths.get("tibia_l");
    expect(tibia).toBeDefined();
    expect(tibia!).toBeCloseTo(0.443, 2);
  });

  it("returns different proportions for male vs female", () => {
    const maleLengths = getSegmentLengths(170, 70, "male");
    const femaleLengths = getSegmentLengths(170, 70, "female");

    // De Leva shows slightly different proportions
    const maleThigh = maleLengths.get("thigh_l") ?? 0;
    const femaleThigh = femaleLengths.get("thigh_l") ?? 0;
    // Both should be close but not identical
    expect(maleThigh).toBeGreaterThan(0);
    expect(femaleThigh).toBeGreaterThan(0);
    // Female thigh ratio is 0.249 vs male 0.245
    expect(femaleThigh).toBeGreaterThan(maleThigh);
  });

  it("scales linearly with height", () => {
    const lengths170 = getSegmentLengths(170, 75, "male");
    const lengths180 = getSegmentLengths(180, 75, "male");

    const thigh170 = lengths170.get("thigh_l") ?? 0;
    const thigh180 = lengths180.get("thigh_l") ?? 0;

    // Ratio should be 170/180 = 0.944
    expect(thigh170 / thigh180).toBeCloseTo(170 / 180, 2);
  });
});
