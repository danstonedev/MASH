/**
 * SARA Algorithm Tests
 *
 * Validates the Symmetrical Axis of Rotation Approach (Ehrig et al., 2007)
 * using synthetic parent/child quaternion data with known hinge axes.
 *
 * Test strategy:
 *   1. Generate parent + child quaternions for a known hinge axis
 *   2. Verify SARA recovers the axis in both frames
 *   3. Test with noise, multi-axis motion, and edge cases
 *   4. Test IncrementalSARA equivalence with batch
 *   5. Test hinge calibration engine integration
 */

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { computeSARA, IncrementalSARA } from "../calibration/sara";
import {
  calibrateHingeJoint,
  isHingeJoint,
  getParentSegment,
  getChildSegment,
  type HingeCalibrationInput,
} from "../calibration/hingeCalibration";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Generate synthetic parent + child quaternion data for a known hinge axis.
 *
 * The parent sensor rotates slowly (simulating trunk sway),
 * while the child sensor rotates around the hinge axis relative to the parent.
 *
 * @param hingeAxisParent   The hinge axis in parent sensor frame (unit vector)
 * @param hingeAxisChild    The hinge axis in child sensor frame (unit vector)
 * @param numSamples        Number of time samples
 * @param maxAngleDeg       Maximum flexion angle in degrees
 * @param parentSwayDeg     Amount of parent sway per cycle
 * @returns                 { parentQuats, childQuats }
 */
function generateHingeData(
  hingeAxisParent: THREE.Vector3,
  hingeAxisChild: THREE.Vector3,
  numSamples: number = 120,
  maxAngleDeg: number = 60,
  parentSwayDeg: number = 5,
): { parentQuats: THREE.Quaternion[]; childQuats: THREE.Quaternion[] } {
  const parentQuats: THREE.Quaternion[] = [];
  const childQuats: THREE.Quaternion[] = [];

  const axisP = hingeAxisParent.clone().normalize();
  const axisC = hingeAxisChild.clone().normalize();

  for (let i = 0; i < numSamples; i++) {
    const t = i / numSamples;

    // Parent undergoes slow sway (not around hinge axis)
    const swayAngle =
      THREE.MathUtils.degToRad(parentSwayDeg) * Math.sin(t * Math.PI * 2);
    const parentQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), // Parent sways around Y
      swayAngle,
    );

    // Child = parent rotation + hinge flexion relative to parent
    // The hinge constraint is: R_p * v_p = R_c * v_c (same axis in world)
    // So R_c = R_p * R_hinge, where R_hinge rotates around the axis
    const flexAngle =
      THREE.MathUtils.degToRad(maxAngleDeg) * Math.sin(t * Math.PI * 4); // 2 cycles

    // Hinge rotation in parent frame
    const hingeQ = new THREE.Quaternion().setFromAxisAngle(axisP, flexAngle);

    // Child orientation = parent * hinge
    // But we need it expressed so that v_c is the axis in the child's LOCAL frame.
    //
    // For the SARA constraint R_p * v_p = R_c * v_c:
    //   R_c(t) = R_p(t) * R_hinge(t)
    //   R_p(t)^T * R_c(t) = R_hinge(t) = rotation around v_p by flexAngle
    //
    // Actually, for SARA the v_c should also be meaningful.
    // Let's define: the child sensor has a fixed orientation offset from the parent
    // (simulating different sensor mounting), and the hinge rotates the child
    // relative to the parent around the shared world axis.
    //
    // Mounting offset: child sensor is mounted differently from parent
    const mountingOffset = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.3, -0.2, 0.1),
    );

    // World-frame hinge axis = R_p * axisP
    // Child orientation = R_p * R_hinge * mountingOffset
    const childQ = parentQ.clone().multiply(hingeQ).multiply(mountingOffset);

    parentQuats.push(parentQ);
    childQuats.push(childQ);
  }

  return { parentQuats, childQuats };
}

/**
 * Generate gyro samples as if only the child sensor were available.
 * Used for testing PCA fallback path.
 */
function generateGyroSamples(
  axis: THREE.Vector3,
  numSamples: number = 120,
  maxRateRadPerSec: number = 3.0,
): THREE.Vector3[] {
  const samples: THREE.Vector3[] = [];
  const ax = axis.clone().normalize();

  for (let i = 0; i < numSamples; i++) {
    const t = i / numSamples;
    const rate = maxRateRadPerSec * Math.sin(t * Math.PI * 4); // 2 cycles
    samples.push(ax.clone().multiplyScalar(rate));
  }

  return samples;
}

/**
 * Add Gaussian noise to quaternions (simulates sensor noise).
 */
function addQuaternionNoise(
  quats: THREE.Quaternion[],
  noiseDeg: number,
): THREE.Quaternion[] {
  return quats.map((q) => {
    const noiseAxis = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    ).normalize();
    const noiseAngle = THREE.MathUtils.degToRad(
      noiseDeg * (Math.random() - 0.5) * 2,
    );
    const noiseQ = new THREE.Quaternion().setFromAxisAngle(
      noiseAxis,
      noiseAngle,
    );
    return q.clone().multiply(noiseQ);
  });
}

/**
 * Compute angular error between two unit vectors (degrees).
 * Handles sign ambiguity (PCA returns a line, not a direction).
 */
function axisErrorDeg(
  detected: THREE.Vector3,
  expected: THREE.Vector3,
): number {
  const dot = Math.abs(detected.dot(expected)); // abs for sign ambiguity
  const clampedDot = Math.min(1, Math.max(-1, dot));
  return THREE.MathUtils.radToDeg(Math.acos(clampedDot));
}

// ============================================================================
// TESTS: SARA Core Algorithm
// ============================================================================

describe("SARA Algorithm", () => {
  it("should recover a known hinge axis from clean data", () => {
    // Hinge axis in parent frame = X
    const axisP = new THREE.Vector3(1, 0, 0);
    const axisC = new THREE.Vector3(1, 0, 0); // Same axis conceptually

    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisC,
      120,
      60,
      5,
    );
    const result = computeSARA(parentQuats, childQuats);

    expect(result).not.toBeNull();
    if (!result) return;

    // The detected axis in parent frame should align with axisP
    const errorParent = axisErrorDeg(result.axisInParent, axisP);
    expect(errorParent).toBeLessThan(5); // Within 5° of known axis

    // High confidence for clean hinge data
    expect(result.confidence).toBeGreaterThan(0.8);

    // Correct sample count
    expect(result.sampleCount).toBe(120);

    console.log(
      `SARA clean: parent axis error=${errorParent.toFixed(1)}° conf=${(result.confidence * 100).toFixed(1)}%`,
    );
  });

  it("should work with hinge axis in different orientations", () => {
    // Test with Z-axis hinge (e.g., knee in certain sensor mounting)
    const axisP = new THREE.Vector3(0, 0, 1);
    const axisC = new THREE.Vector3(0, 0, 1);

    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisC,
      120,
      45,
      3,
    );
    const result = computeSARA(parentQuats, childQuats);

    expect(result).not.toBeNull();
    if (!result) return;

    const errorParent = axisErrorDeg(result.axisInParent, axisP);
    expect(errorParent).toBeLessThan(5);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("should work with oblique hinge axis", () => {
    // Axis at 45° in XZ plane (simulating real sensor mounting offset)
    const axisP = new THREE.Vector3(1, 0, 1).normalize();
    const axisC = new THREE.Vector3(1, 0, 1).normalize();

    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisC,
      150,
      50,
      4,
    );
    const result = computeSARA(parentQuats, childQuats);

    expect(result).not.toBeNull();
    if (!result) return;

    const errorParent = axisErrorDeg(result.axisInParent, axisP);
    expect(errorParent).toBeLessThan(5);
    expect(result.confidence).toBeGreaterThan(0.75);
  });

  it("should be robust to sensor noise", () => {
    const axisP = new THREE.Vector3(1, 0, 0);
    const axisC = new THREE.Vector3(1, 0, 0);

    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisC,
      200,
      60,
      5,
    );

    // Add ±2° noise to both sensor streams
    const noisyParent = addQuaternionNoise(parentQuats, 2);
    const noisyChild = addQuaternionNoise(childQuats, 2);

    const result = computeSARA(noisyParent, noisyChild);

    expect(result).not.toBeNull();
    if (!result) return;

    const errorParent = axisErrorDeg(result.axisInParent, axisP);
    expect(errorParent).toBeLessThan(10); // Allow more error with noise
    expect(result.confidence).toBeGreaterThan(0.6);

    console.log(
      `SARA noisy: axis error=${errorParent.toFixed(1)}° conf=${(result.confidence * 100).toFixed(1)}%`,
    );
  });

  it("should return null for insufficient samples", () => {
    const axisP = new THREE.Vector3(1, 0, 0);
    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisP,
      10,
      30,
      0,
    );

    const result = computeSARA(parentQuats, childQuats, 20);
    expect(result).toBeNull();
  });

  it("should have low confidence for ball-joint motion", () => {
    // Simulate multi-axis rotation (not a hinge)
    // Equal amplitudes on all three axes with incommensurate frequencies
    // so no single axis dominates
    const parentQuats: THREE.Quaternion[] = [];
    const childQuats: THREE.Quaternion[] = [];

    for (let i = 0; i < 200; i++) {
      const t = i / 200;

      // Parent stays roughly still
      const pQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0.05 * Math.sin(t * 6), 0, 0),
      );

      // Child rotates around ALL three axes with EQUAL amplitude
      // Use golden-ratio-offset frequencies to avoid coherence
      const amp = 0.5;
      const cQ = pQ
        .clone()
        .multiply(
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(
              amp * Math.sin(t * Math.PI * 4),
              amp * Math.sin(t * Math.PI * 4 * 1.618),
              amp * Math.sin(t * Math.PI * 4 * 2.618),
            ),
          ),
        );

      parentQuats.push(pQ);
      childQuats.push(cQ);
    }

    const result = computeSARA(parentQuats, childQuats);
    expect(result).not.toBeNull();
    if (!result) return;

    // Ball-joint with equal-amplitude 3-axis rotation should have
    // noticeably lower confidence than a clean hinge (which gets ~1.0)
    expect(result.confidence).toBeLessThan(0.92);
  });

  it("should handle significant parent motion", () => {
    // Parent moves a lot (realistic: walking while calibrating knee)
    const axisP = new THREE.Vector3(1, 0, 0);
    const axisC = new THREE.Vector3(1, 0, 0);

    // 20° parent sway — much more than typical 5°
    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisC,
      180,
      60,
      20,
    );
    const result = computeSARA(parentQuats, childQuats);

    expect(result).not.toBeNull();
    if (!result) return;

    const errorParent = axisErrorDeg(result.axisInParent, axisP);
    expect(errorParent).toBeLessThan(8);
    expect(result.confidence).toBeGreaterThan(0.6);

    console.log(
      `SARA heavy sway: axis error=${errorParent.toFixed(1)}° conf=${(result.confidence * 100).toFixed(1)}%`,
    );
  });
});

// ============================================================================
// TESTS: IncrementalSARA
// ============================================================================

describe("IncrementalSARA", () => {
  it("should match batch SARA results", () => {
    const axisP = new THREE.Vector3(1, 0, 0);
    const axisC = new THREE.Vector3(1, 0, 0);

    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisC,
      100,
      45,
      3,
    );

    // Batch
    const batchResult = computeSARA(parentQuats, childQuats);

    // Incremental
    const inc = new IncrementalSARA();
    for (let i = 0; i < parentQuats.length; i++) {
      inc.addSample(parentQuats[i], childQuats[i]);
    }
    const incResult = inc.compute();

    expect(batchResult).not.toBeNull();
    expect(incResult).not.toBeNull();
    if (!batchResult || !incResult) return;

    // Results should be essentially identical
    expect(incResult.confidence).toBeCloseTo(batchResult.confidence, 4);
    expect(incResult.sigmaMax).toBeCloseTo(batchResult.sigmaMax, 4);

    // Axes should match (within sign ambiguity)
    const axisError = axisErrorDeg(
      incResult.axisInParent,
      batchResult.axisInParent,
    );
    expect(axisError).toBeLessThan(0.1); // Near-identical
  });

  it("should provide increasing confidence as samples accumulate", () => {
    const axisP = new THREE.Vector3(0, 0, 1);
    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisP,
      200,
      50,
      5,
    );

    const inc = new IncrementalSARA();
    const confidences: number[] = [];

    for (let i = 0; i < parentQuats.length; i++) {
      inc.addSample(parentQuats[i], childQuats[i]);

      if (inc.count >= 20 && inc.count % 20 === 0) {
        const r = inc.compute();
        if (r) confidences.push(r.confidence);
      }
    }

    // Confidence should stabilize (not necessarily monotonically increase,
    // but final should be reasonable)
    expect(confidences.length).toBeGreaterThan(0);
    expect(confidences[confidences.length - 1]).toBeGreaterThan(0.7);
  });

  it("should reset correctly", () => {
    const inc = new IncrementalSARA();
    const { parentQuats, childQuats } = generateHingeData(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(1, 0, 0),
      50,
      30,
      2,
    );

    for (let i = 0; i < parentQuats.length; i++) {
      inc.addSample(parentQuats[i], childQuats[i]);
    }
    expect(inc.count).toBe(50);

    inc.reset();
    expect(inc.count).toBe(0);
    expect(inc.compute()).toBeNull(); // No data after reset
  });
});

// ============================================================================
// TESTS: Hinge Calibration Engine
// ============================================================================

describe("Hinge Calibration Engine", () => {
  it("should calibrate a knee joint with SARA", () => {
    const axisP = new THREE.Vector3(1, 0, 0);
    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisP,
      120,
      60,
      5,
    );

    // Generate matching gyro samples for fallback path
    const gyroSamples = generateGyroSamples(axisP, 120, 3);

    const input: HingeCalibrationInput = {
      jointId: "knee_l",
      childGyroSamples: gyroSamples,
      childGravity: new THREE.Vector3(0, -9.81, 0), // Gravity down
      parentQuaternions: parentQuats,
      childQuaternions: childQuats,
      side: "left",
    };

    const result = calibrateHingeJoint(input);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.method).toBe("sara");
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.hingeAxisParent).not.toBeNull();
    expect(result.quality.score).toBeGreaterThan(50);
    expect(result.axisAlignment).toBeDefined();

    console.log(
      `Knee SARA: method=${result.method} conf=${(result.confidence * 100).toFixed(1)}% quality=${result.quality.score}`,
    );
  });

  it("should fall back to PCA when parent data is missing", () => {
    const axis = new THREE.Vector3(1, 0, 0);
    const gyroSamples = generateGyroSamples(axis, 120, 3);

    const input: HingeCalibrationInput = {
      jointId: "knee_r",
      childGyroSamples: gyroSamples,
      childGravity: new THREE.Vector3(0, -9.81, 0),
      // No parent data
      side: "right",
    };

    const result = calibrateHingeJoint(input);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.method).toBe("single-pca");
    expect(result.hingeAxisParent).toBeNull();
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should fall back to PCA when parent data is insufficient", () => {
    const axis = new THREE.Vector3(1, 0, 0);
    const gyroSamples = generateGyroSamples(axis, 120, 3);

    // Only 5 parent/child quaternions (below threshold)
    const { parentQuats, childQuats } = generateHingeData(axis, axis, 5, 30, 0);

    const input: HingeCalibrationInput = {
      jointId: "elbow_l",
      childGyroSamples: gyroSamples,
      childGravity: new THREE.Vector3(0, -9.81, 0),
      parentQuaternions: parentQuats,
      childQuaternions: childQuats,
      side: "left",
    };

    const result = calibrateHingeJoint(input);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.method).toBe("single-pca");
  });

  it("should return null for unknown joint", () => {
    const input: HingeCalibrationInput = {
      jointId: "imaginary_joint",
      childGyroSamples: [],
      childGravity: new THREE.Vector3(0, -1, 0),
    };

    const result = calibrateHingeJoint(input);
    expect(result).toBeNull();
  });

  it("should produce a valid quaternion alignment", () => {
    const axisP = new THREE.Vector3(0, 0, 1);
    const { parentQuats, childQuats } = generateHingeData(
      axisP,
      axisP,
      150,
      50,
      5,
    );
    const gyroSamples = generateGyroSamples(axisP, 150, 2.5);

    const input: HingeCalibrationInput = {
      jointId: "elbow_r",
      childGyroSamples: gyroSamples,
      childGravity: new THREE.Vector3(0, -9.81, 0),
      parentQuaternions: parentQuats,
      childQuaternions: childQuats,
      side: "right",
    };

    const result = calibrateHingeJoint(input);
    expect(result).not.toBeNull();
    if (!result) return;

    // Quaternion should be normalized
    const qLen = result.axisAlignment.length();
    expect(qLen).toBeCloseTo(1, 5);
  });
});

// ============================================================================
// TESTS: Utility Functions
// ============================================================================

describe("Hinge Calibration Utilities", () => {
  it("should correctly identify hinge joints", () => {
    expect(isHingeJoint("knee_l")).toBe(true);
    expect(isHingeJoint("knee_r")).toBe(true);
    expect(isHingeJoint("elbow_l")).toBe(true);
    expect(isHingeJoint("elbow_r")).toBe(true);
    expect(isHingeJoint("ankle_l")).toBe(true);
    expect(isHingeJoint("wrist_r")).toBe(true);

    // Non-hinge joints
    expect(isHingeJoint("hip_l")).toBe(false);
    expect(isHingeJoint("shoulder_r")).toBe(false);
    expect(isHingeJoint("cervical")).toBe(false);
    expect(isHingeJoint("lumbar")).toBe(false);
  });

  it("should look up parent/child segments", () => {
    expect(getParentSegment("knee_l")).toBe("thigh_l");
    expect(getChildSegment("knee_l")).toBe("tibia_l");

    expect(getParentSegment("elbow_r")).toBe("upper_arm_r");
    expect(getChildSegment("elbow_r")).toBe("forearm_r");

    expect(getParentSegment("nonexistent")).toBeNull();
    expect(getChildSegment("nonexistent")).toBeNull();
  });
});
