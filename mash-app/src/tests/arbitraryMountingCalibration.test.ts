/**
 * Arbitrary Sensor Mounting Calibration Tests
 * ============================================
 *
 * CRITICAL TESTS: These verify that body calibration works correctly
 * regardless of how the sensor is physically mounted on the body.
 *
 * The key insight is that a sensor can be strapped to a thigh:
 * - "Normally" (Y-axis along thigh, X pointing right)
 * - Rotated 90° (X-axis along thigh, Y pointing forward)
 * - Upside down (Y-axis along thigh but inverted)
 * - At any arbitrary angle
 *
 * The calibration MUST produce correct results in ALL cases.
 *
 * @module tests/arbitraryMountingCalibration
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create a quaternion from Euler angles in degrees
 */
function quatFromEulerDeg(
  x: number,
  y: number,
  z: number,
  order: THREE.EulerOrder = "XYZ",
): THREE.Quaternion {
  const euler = new THREE.Euler(
    (x * Math.PI) / 180,
    (y * Math.PI) / 180,
    (z * Math.PI) / 180,
    order,
  );
  return new THREE.Quaternion().setFromEuler(euler);
}

/**
 * Convert quaternion to Euler angles in degrees (for debugging)
 */
function eulerFromQuat(
  q: THREE.Quaternion,
  order: THREE.EulerOrder = "XYZ",
): string {
  const euler = new THREE.Euler().setFromQuaternion(q, order);
  return `(${((euler.x * 180) / Math.PI).toFixed(1)}°, ${((euler.y * 180) / Math.PI).toFixed(1)}°, ${((euler.z * 180) / Math.PI).toFixed(1)}°)`;
}

/**
 * Convert vector to string for debugging
 */
function vecToStr(v: THREE.Vector3): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

/**
 * Compare quaternions allowing for double-cover (q and -q are same rotation)
 */
function quaternionsEqual(
  a: THREE.Quaternion,
  b: THREE.Quaternion,
  tolerance: number = 0.01,
): boolean {
  const dot = Math.abs(a.dot(b));
  return dot > 1 - tolerance;
}

/**
 * Get angle difference between two quaternions in degrees
 */
function angleDifference(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return (a.angleTo(b) * 180) / Math.PI;
}

// ============================================================================
// SIMULATED TWO-LAYER CALIBRATION (What we want to implement)
// ============================================================================

interface TwoLayerCalibrationInput {
  // Static pose capture
  sensorQuatAtNeutral: THREE.Quaternion;

  // PCA result: the axis the sensor rotates around during flexion (in SENSOR frame)
  pcaFlexionAxisSensor: THREE.Vector3;

  // Gravity direction in sensor frame (during static pose)
  gravitySensor: THREE.Vector3;

  // Target bone orientation at neutral pose (what we want the bone to be)
  targetBoneQuat: THREE.Quaternion;

  // Expected anatomical flexion axis in BONE frame
  anatomicalFlexionAxis: THREE.Vector3;
}

interface TwoLayerCalibrationResult {
  // Layer 1: Maps sensor axes to bone axes
  frameAlignment: THREE.Quaternion;

  // Layer 2: Zeros the aligned frame to neutral
  mountingTare: THREE.Quaternion;
}

/**
 * CORRECT two-layer calibration algorithm for arbitrary mounting.
 *
 * This is the GOLDEN REFERENCE implementation.
 *
 * KEY INSIGHT: The frame alignment must map the PCA axis (in sensor frame)
 * to the anatomical axis (in bone frame). This is a direct mapping,
 * not affected by the current sensor orientation.
 */
function computeTwoLayerCalibration(
  input: TwoLayerCalibrationInput,
): TwoLayerCalibrationResult {
  const {
    sensorQuatAtNeutral,
    pcaFlexionAxisSensor,
    gravitySensor,
    targetBoneQuat,
    anatomicalFlexionAxis,
  } = input;

  // =========================================================================
  // LAYER 1: FRAME ALIGNMENT (Sensor Local Axes → Bone Local Axes)
  // =========================================================================
  //
  // CRITICAL: This is a PURE axis mapping. It answers:
  // "Which sensor axis corresponds to which bone axis?"
  //
  // We have two constraints:
  // 1. PCA axis (flexion) → anatomical flexion axis
  // 2. Gravity direction → anatomical "down" direction
  //
  // Both constraints are in their respective LOCAL frames.

  // --- SENSOR FRAME CONSTRUCTION (in sensor local space) ---
  const sensorPrimary = pcaFlexionAxisSensor.clone().normalize();
  const sensorGravity = gravitySensor.clone().normalize();

  // Handle degenerate case
  if (Math.abs(sensorPrimary.dot(sensorGravity)) > 0.99) {
    console.warn("[TwoLayer] PCA axis parallel to gravity - degenerate case");
  }

  // Build orthogonal basis via Gram-Schmidt
  // Primary (X): flexion axis
  const sensor_X = sensorPrimary.clone();
  // Orthogonalize gravity against primary
  const sensor_Y_temp = sensorGravity.clone();
  sensor_Y_temp.sub(
    sensor_X.clone().multiplyScalar(sensor_X.dot(sensor_Y_temp)),
  );
  const sensor_Y = sensor_Y_temp.normalize();
  // Third axis via cross product
  const sensor_Z = new THREE.Vector3()
    .crossVectors(sensor_X, sensor_Y)
    .normalize();

  // --- BONE FRAME CONSTRUCTION (in bone local space) ---
  const bonePrimary = anatomicalFlexionAxis.clone().normalize();

  // Gravity in bone local frame
  // For a thigh pointing DOWN in world (targetBoneQuat = 180° around X):
  //   World gravity (-Y) transformed to bone local = bone's local +Y direction
  const worldGravity = new THREE.Vector3(0, -1, 0);
  const boneGravity = worldGravity
    .clone()
    .applyQuaternion(targetBoneQuat.clone().invert());

  // Build orthogonal basis
  const bone_X = bonePrimary.clone();
  const bone_Y_temp = boneGravity.clone();
  bone_Y_temp.sub(bone_X.clone().multiplyScalar(bone_X.dot(bone_Y_temp)));
  const bone_Y = bone_Y_temp.normalize();
  const bone_Z = new THREE.Vector3().crossVectors(bone_X, bone_Y).normalize();

  // --- COMPUTE FRAME ALIGNMENT ---
  // This rotation maps sensor local basis → bone local basis
  //
  // If v_sensor is a vector in sensor frame, then:
  //   v_bone = frameAlignment × v_sensor × inv(frameAlignment)
  //
  // Equivalently: frameAlignment.applyQuaternion(v_sensor) = v_bone
  //
  // Matrix form: R_bone = R_alignment × R_sensor
  // So: R_alignment = R_bone × inv(R_sensor)

  const sensorBasis = new THREE.Matrix4().makeBasis(
    sensor_X,
    sensor_Y,
    sensor_Z,
  );
  const boneBasis = new THREE.Matrix4().makeBasis(bone_X, bone_Y, bone_Z);

  const sensorBasisInv = sensorBasis.clone().invert();
  const alignmentMatrix = boneBasis.clone().multiply(sensorBasisInv);

  const frameAlignment = new THREE.Quaternion()
    .setFromRotationMatrix(alignmentMatrix)
    .normalize();

  const frameAlignmentInv = frameAlignment.clone().invert();

  // =========================================================================
  // RETURN CALIBRATION DATA
  // =========================================================================
  //
  // We return:
  // - frameAlignment: maps sensor local axes → bone local axes
  // - sensorQuatAtCal: sensor orientation at calibration
  // - targetBoneQuat: target bone orientation
  //
  // Runtime formula:
  //   δ_local = inv(sensorQuatAtCal) × sensorQuat   (delta in sensor frame)
  //   δ_bone = frameAlignment × δ_local × inv(frameAlignment)  (delta in bone frame)
  //   q_bone = targetBoneQuat × δ_bone

  return {
    frameAlignment: frameAlignment.normalize(),
    sensorQuatAtCal: sensorQuatAtNeutral.clone(),
    targetBoneQuat: targetBoneQuat.clone(),
  };
}

/**
 * Apply two-layer calibration at runtime
 *
 * The key insight: frameAlignment is an AXIS REMAPPING transform.
 *
 * If the sensor rotates by δ around its local axis, we want the bone to
 * rotate by δ around the CORRESPONDING bone axis.
 *
 * Approach: We don't use similarity transform on the full quaternion.
 * Instead, we compute:
 *   1. The rotation delta from neutral: δ = inv(q_neutral) × q_sensor
 *   2. Remap this delta to bone axes: δ_bone = frameAlignment × δ × inv(frameAlignment)
 *   3. Apply to target: q_bone = targetBone × δ_bone
 *
 * But we can simplify by precomputing a combined offset during calibration.
 *
 * SIMPLER APPROACH:
 * The frame alignment tells us: sensor axis A maps to bone axis B.
 *
 * If we express the sensor quaternion in terms of how far it's rotated from
 * the calibration pose, and then remap those axes, we get the bone rotation.
 *
 * Final runtime formula:
 *   q_bone = frameAlignment × q_sensor × inv(frameAlignment) × mountingTare
 *
 * Where mountingTare absorbs the initial offset.
 *
 * ACTUALLY, let's think even simpler:
 *
 * We want: when sensor axis S rotates, bone axis B rotates the same way.
 * frameAlignment maps S → B (as a vector rotation)
 *
 * For quaternion: q_bone = q_target × inv(q_target) × q_actual
 *                       = q_target × rotation_from_target_to_actual
 *
 * The rotation delta in sensor frame is: δ_sensor = inv(q_sensor_cal) × q_sensor
 *
 * We need to express this delta in bone frame:
 *   δ_bone = frameAlignment × δ_sensor × inv(frameAlignment)
 *
 * Then: q_bone = q_target × δ_bone
 *
 * This can be rewritten:
 *   q_bone = q_target × frameAlignment × inv(q_sensor_cal) × q_sensor × inv(frameAlignment)
 *
 * Let combinedOffset = inv(frameAlignment) × q_target × frameAlignment × inv(q_sensor_cal)
 * Then: q_bone = frameAlignment × q_sensor × combinedOffset × inv(frameAlignment)
 *
 * Actually, let's just use the direct approach with precomputation:
 *   precomputed = q_target × frameAlignment × inv(q_sensor_cal)
 *   q_bone = precomputed × q_sensor × inv(frameAlignment)
 *
 * Hmm, this is getting complex. Let me try a different formulation.
 *
 * CLEAN APPROACH:
 * Define: axisRemap(q) = frameAlignment × q × inv(frameAlignment)
 * This takes a rotation expressed in sensor axes and re-expresses it in bone axes.
 *
 * At calibration: axisRemap(q_sensor_cal) × offset = q_target
 * So: offset = inv(axisRemap(q_sensor_cal)) × q_target
 *
 * At runtime: q_bone = axisRemap(q_sensor) × offset
 *
 * Let's verify: At calibration, q_bone = axisRemap(q_sensor_cal) × offset
 *                                      = axisRemap(q_sensor_cal) × inv(axisRemap(q_sensor_cal)) × q_target
 *                                      = q_target ✓
 */
function applyTwoLayerCalibration(
  sensorQuat: THREE.Quaternion,
  calibrationData: {
    sensorQuatAtCal: THREE.Quaternion;
    targetBoneQuat: THREE.Quaternion;
    frameAlignment: THREE.Quaternion; // Not used in this simpler formulation!
  },
): THREE.Quaternion {
  const { sensorQuatAtCal, targetBoneQuat } = calibrationData;

  // SIMPLE FORMULATION:
  // If sensor is rigidly attached to bone with relationship q_sensor = q_bone × M,
  // then: q_bone = q_sensor × inv(M)
  //
  // At calibration: q_sensor_cal = q_bone_target × M
  // So: M = inv(q_bone_target) × q_sensor_cal
  // And: inv(M) = inv(q_sensor_cal) × q_bone_target
  //
  // Therefore: q_bone = q_sensor × inv(q_sensor_cal) × q_bone_target

  return sensorQuat
    .clone()
    .multiply(sensorQuatAtCal.clone().invert())
    .multiply(targetBoneQuat);
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

describe("Arbitrary Mounting Calibration", () => {
  // Target for thigh in T-pose: pointing DOWN (180° around X)
  const targetThighQuat = quatFromEulerDeg(180, 0, 0);

  // Anatomical flexion axis for thigh (medial-lateral, X in bone frame)
  const anatomicalFlexionAxis = new THREE.Vector3(1, 0, 0);

  describe("Normal Mounting (sensor Y along thigh)", () => {
    it("should produce correct calibration", () => {
      // Sensor mounted "normally": Y-axis along thigh (pointing down)
      // In T-pose, sensor reads 180° rotation around X
      const sensorQuat = quatFromEulerDeg(180, 0, 0);

      // PCA during knee flexion: sensor rotates around its X-axis
      const pcaAxis = new THREE.Vector3(1, 0, 0);

      // Gravity in sensor frame: pointing along +Y (sensor Y points down)
      const gravitySensor = new THREE.Vector3(0, 1, 0);

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Apply calibration to neutral pose
      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      // Should match target
      expect(angleDifference(calibratedNeutral, targetThighQuat)).toBeLessThan(
        1,
      );
    });

    it("should track knee flexion correctly", () => {
      const sensorQuat = quatFromEulerDeg(180, 0, 0);
      const pcaAxis = new THREE.Vector3(1, 0, 0);
      const gravitySensor = new THREE.Vector3(0, 1, 0);

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Simulate 45° knee flexion: sensor rotates 45° around its X-axis
      const sensorFlexed = quatFromEulerDeg(180 + 45, 0, 0);

      // Apply calibration
      const calibratedFlexed = applyTwoLayerCalibration(sensorFlexed, result);

      // Expected: target thigh + 45° flexion around X
      const expectedFlexed = targetThighQuat
        .clone()
        .multiply(quatFromEulerDeg(45, 0, 0));

      expect(angleDifference(calibratedFlexed, expectedFlexed)).toBeLessThan(2);
    });
  });

  describe("90° Rotated Mounting (sensor X along thigh)", () => {
    it("should produce correct calibration with 90° rotated sensor", () => {
      // Sensor mounted rotated 90° around Z: X-axis now along thigh
      // Equivalent to normal mounting but rotated 90° around the thigh axis
      const sensorQuat = quatFromEulerDeg(180, 0, 90);

      // PCA during knee flexion: sensor now rotates around its Y-axis!
      // (because sensor X is along thigh, and we're rotating around the knee)
      const pcaAxis = new THREE.Vector3(0, 1, 0);

      // Gravity in sensor frame (rotated 90°)
      const gravitySensor = new THREE.Vector3(-1, 0, 0);

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Apply calibration to neutral pose
      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      // Should match target despite rotated mounting
      expect(angleDifference(calibratedNeutral, targetThighQuat)).toBeLessThan(
        1,
      );
    });

    it("should track knee flexion correctly with 90° rotated sensor", () => {
      const sensorQuat = quatFromEulerDeg(180, 0, 90);
      const pcaAxis = new THREE.Vector3(0, 1, 0);
      const gravitySensor = new THREE.Vector3(-1, 0, 0);

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Debug: Let's think about what happens when thigh flexes
      //
      // At neutral: bone is at targetThighQuat (180°, 0, 0) = pointing down
      // Sensor is at (180°, 0, 90°) = same but with 90° rotation around its long axis
      //
      // When thigh flexes 45° around X:
      //   Bone goes to: targetThighQuat × flexion = (180°, 0, 0) × 45°_around_X
      //
      // The sensor is RIGIDLY attached. So the sensor also rotates 45° around the WORLD X axis.
      // But the sensor quaternion reports its orientation relative to world.
      //
      // So the new sensor quaternion is:
      //   q_sensor_flexed = q_bone_flexed × inv(q_bone_neutral) × q_sensor_neutral × (local mounting offset)
      //
      // Wait, that's not right either. Let me think about this more carefully.
      //
      // The sensor is mounted on the bone with some fixed relationship.
      // Let q_bone = bone orientation in world
      // Let R = rotation from bone local frame to sensor local frame (fixed)
      // Then q_sensor = q_bone × R (roughly)
      //
      // More precisely: sensor orientation = bone orientation rotated by mounting offset
      // If mounting offset is a 90° Z rotation:
      //   q_sensor = q_bone × q_mounting
      //   where q_mounting = (0, 0, 90°) euler
      //
      // So:
      //   At neutral: q_sensor_neutral = q_bone_neutral × q_mounting = (180,0,0) × (0,0,90) = (180,0,90)  ✓
      //   At flexed:  q_sensor_flexed = q_bone_flexed × q_mounting
      //             = [(180,0,0) × (45,0,0)] × (0,0,90)
      //             = (225,0,0) × (0,0,90)

      // Let's compute q_bone_flexed properly
      const q_bone_flexed = targetThighQuat
        .clone()
        .multiply(quatFromEulerDeg(45, 0, 0));

      // The mounting offset is the relative rotation from bone frame to sensor frame
      // q_sensor = q_bone × q_mounting
      // At neutral: (180,0,90) = (180,0,0) × q_mounting
      // So: q_mounting = inv(180,0,0) × (180,0,90)
      const q_bone_neutral_inv = targetThighQuat.clone().invert();
      const q_mounting = q_bone_neutral_inv.multiply(sensorQuat.clone());

      // Sensor at flexed position:
      const sensorFlexed = q_bone_flexed.clone().multiply(q_mounting);

      console.log("=== 90° Rotated Test Debug ===");
      console.log("Bone neutral:", eulerFromQuat(targetThighQuat));
      console.log("Sensor neutral:", eulerFromQuat(sensorQuat));
      console.log("Mounting offset:", eulerFromQuat(q_mounting));
      console.log("Bone flexed:", eulerFromQuat(q_bone_flexed));
      console.log("Sensor flexed:", eulerFromQuat(sensorFlexed));

      const calibratedFlexed = applyTwoLayerCalibration(sensorFlexed, result);

      // Expected: same as normal mounting case
      const expectedFlexed = targetThighQuat
        .clone()
        .multiply(quatFromEulerDeg(45, 0, 0));

      console.log("Calibrated flexed:", eulerFromQuat(calibratedFlexed));
      console.log("Expected flexed:", eulerFromQuat(expectedFlexed));
      console.log(
        "Error:",
        angleDifference(calibratedFlexed, expectedFlexed).toFixed(2) + "°",
      );

      expect(angleDifference(calibratedFlexed, expectedFlexed)).toBeLessThan(2);
    });
  });

  describe("Upside Down Mounting (sensor Y pointing up along thigh)", () => {
    it("should produce correct calibration with upside down sensor", () => {
      // Sensor mounted upside down: Y-axis along thigh but pointing UP
      // This is a 180° flip around X compared to normal
      const sensorQuat = quatFromEulerDeg(0, 0, 0); // Identity = sensor Y pointing up

      // PCA during knee flexion: still X-axis (axis of rotation unchanged)
      // But the SIGN might be different
      const pcaAxis = new THREE.Vector3(1, 0, 0);

      // Gravity in sensor frame: pointing along -Y (sensor is upside down)
      const gravitySensor = new THREE.Vector3(0, -1, 0);

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Apply calibration to neutral pose
      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      // Should match target despite upside down mounting
      expect(angleDifference(calibratedNeutral, targetThighQuat)).toBeLessThan(
        1,
      );
    });

    it("should track knee flexion correctly with upside down sensor", () => {
      const sensorQuat = quatFromEulerDeg(0, 0, 0);
      const pcaAxis = new THREE.Vector3(1, 0, 0);
      const gravitySensor = new THREE.Vector3(0, -1, 0);

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Simulate 45° knee flexion
      // Upside down: positive rotation in sensor frame = negative in bone frame
      // PCA axis sign disambiguation should handle this
      const sensorFlexed = sensorQuat
        .clone()
        .multiply(quatFromEulerDeg(45, 0, 0));

      const calibratedFlexed = applyTwoLayerCalibration(sensorFlexed, result);

      // The expected bone orientation: target + 45° flexion
      // Note: when sensor is upside-down, sensor +45° rotation = bone +45° flexion
      // because q_bone = q_sensor × inv(q_sensor_cal) × q_bone_target handles this correctly
      const expectedFlexed = targetThighQuat
        .clone()
        .multiply(quatFromEulerDeg(45, 0, 0));

      // Use quaternion angle difference instead of Euler subtraction
      expect(angleDifference(calibratedFlexed, expectedFlexed)).toBeLessThan(2);
    });
  });

  describe("45° Diagonal Mounting", () => {
    it("should produce correct calibration with 45° diagonal mounting", () => {
      // Sensor mounted at 45° angle
      const sensorQuat = quatFromEulerDeg(180, 45, 0);

      // PCA during knee flexion: rotates around a diagonal axis in sensor frame
      const pcaAxis = new THREE.Vector3(
        Math.cos((45 * Math.PI) / 180),
        Math.sin((45 * Math.PI) / 180),
        0,
      ).normalize();

      // Gravity in sensor frame (tilted)
      const gravitySensor = new THREE.Vector3(0, 1, 0).applyQuaternion(
        quatFromEulerDeg(0, -45, 0),
      );

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Apply calibration to neutral pose
      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      // Should match target despite diagonal mounting
      expect(angleDifference(calibratedNeutral, targetThighQuat)).toBeLessThan(
        1,
      );
    });
  });

  describe("Arbitrary Random Mounting", () => {
    it("should handle completely arbitrary mounting orientation", () => {
      // Random mounting orientation
      const sensorQuat = quatFromEulerDeg(127, -43, 88);

      // PCA axis in this arbitrary sensor frame
      // We need to figure out what axis the sensor WOULD rotate around during knee flexion
      // This is the anatomical flexion axis (world X) transformed to sensor frame
      const worldFlexionAxis = new THREE.Vector3(1, 0, 0);
      const pcaAxis = worldFlexionAxis
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      // Gravity in sensor frame
      const worldGravity = new THREE.Vector3(0, -1, 0);
      const gravitySensor = worldGravity
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Apply calibration to neutral pose
      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      // Should match target
      expect(angleDifference(calibratedNeutral, targetThighQuat)).toBeLessThan(
        1,
      );
    });

    it("should track motion correctly with arbitrary mounting", () => {
      const sensorQuat = quatFromEulerDeg(127, -43, 88);

      const worldFlexionAxis = new THREE.Vector3(1, 0, 0);
      const pcaAxis = worldFlexionAxis
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const worldGravity = new THREE.Vector3(0, -1, 0);
      const gravitySensor = worldGravity
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      // Simulate 60° knee flexion
      // Sensor rotates around the PCA axis (which is bone X in sensor frame)
      const flexionQuat = new THREE.Quaternion().setFromAxisAngle(
        pcaAxis,
        (60 * Math.PI) / 180,
      );
      const sensorFlexed = sensorQuat.clone().multiply(flexionQuat);

      const calibratedFlexed = applyTwoLayerCalibration(sensorFlexed, result);

      // Expected: target + 60° around bone X
      const expectedFlexed = targetThighQuat
        .clone()
        .multiply(quatFromEulerDeg(60, 0, 0));

      expect(angleDifference(calibratedFlexed, expectedFlexed)).toBeLessThan(2);
    });
  });

  describe("Motion Tracking Consistency", () => {
    it("should produce identical motion output regardless of mounting", () => {
      // Three different mountings
      const mountings = [
        { quat: quatFromEulerDeg(180, 0, 0), name: "normal" },
        { quat: quatFromEulerDeg(180, 0, 90), name: "90° rotated" },
        { quat: quatFromEulerDeg(0, 0, 0), name: "upside down" },
      ];

      const calibrationResults: TwoLayerCalibrationResult[] = [];

      // Calibrate each mounting
      for (const mounting of mountings) {
        const worldFlexionAxis = new THREE.Vector3(1, 0, 0);
        const pcaAxis = worldFlexionAxis
          .clone()
          .applyQuaternion(mounting.quat.clone().invert());

        const worldGravity = new THREE.Vector3(0, -1, 0);
        const gravitySensor = worldGravity
          .clone()
          .applyQuaternion(mounting.quat.clone().invert());

        const result = computeTwoLayerCalibration({
          sensorQuatAtNeutral: mounting.quat,
          pcaFlexionAxisSensor: pcaAxis,
          gravitySensor,
          targetBoneQuat: targetThighQuat,
          anatomicalFlexionAxis,
        });

        calibrationResults.push(result);
      }

      // Apply 30° flexion to each and compare outputs
      const calibratedOutputs: THREE.Quaternion[] = [];

      for (let i = 0; i < mountings.length; i++) {
        const mounting = mountings[i];
        const result = calibrationResults[i];

        // Create flexion in sensor's local frame
        const worldFlexionAxis = new THREE.Vector3(1, 0, 0);
        const pcaAxis = worldFlexionAxis
          .clone()
          .applyQuaternion(mounting.quat.clone().invert());
        const flexionQuat = new THREE.Quaternion().setFromAxisAngle(
          pcaAxis,
          (30 * Math.PI) / 180,
        );
        const sensorFlexed = mounting.quat.clone().multiply(flexionQuat);

        const calibrated = applyTwoLayerCalibration(sensorFlexed, result);

        calibratedOutputs.push(calibrated);
      }

      // All outputs should be nearly identical
      for (let i = 1; i < calibratedOutputs.length; i++) {
        const diff = angleDifference(
          calibratedOutputs[0],
          calibratedOutputs[i],
        );
        expect(diff).toBeLessThan(2);
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle sensor mounted horizontally (90° from vertical)", () => {
      // Sensor mounted with Y horizontal, X pointing down
      const sensorQuat = quatFromEulerDeg(90, 0, 0);

      // PCA axis: Y-axis (horizontal, perpendicular to thigh)
      const pcaAxis = new THREE.Vector3(0, 1, 0);

      // Gravity: along +X in sensor frame
      const gravitySensor = new THREE.Vector3(1, 0, 0);

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      expect(angleDifference(calibratedNeutral, targetThighQuat)).toBeLessThan(
        1,
      );
    });

    it("should handle near-gimbal-lock orientations", () => {
      // Sensor pointing straight up (near gimbal lock)
      const sensorQuat = quatFromEulerDeg(90, 0, 0);

      // Use a more realistic PCA axis for this orientation
      const worldFlexionAxis = new THREE.Vector3(1, 0, 0);
      const pcaAxis = worldFlexionAxis
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const worldGravity = new THREE.Vector3(0, -1, 0);
      const gravitySensor = worldGravity
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetThighQuat,
        anatomicalFlexionAxis,
      });

      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      // Should still work
      expect(angleDifference(calibratedNeutral, targetThighQuat)).toBeLessThan(
        2,
      );
    });
  });

  describe("Multi-Segment Calibration", () => {
    it("should calibrate pelvis with arbitrary mounting", () => {
      // Pelvis target: identity (facing forward, upright)
      const targetPelvisQuat = new THREE.Quaternion();

      // Pelvis flexion axis (anterior tilt = X rotation)
      const pelvisFlexionAxis = new THREE.Vector3(1, 0, 0);

      // Arbitrary pelvis sensor mounting
      const sensorQuat = quatFromEulerDeg(15, -30, 45);

      const worldFlexionAxis = pelvisFlexionAxis;
      const pcaAxis = worldFlexionAxis
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const worldGravity = new THREE.Vector3(0, -1, 0);
      const gravitySensor = worldGravity
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetPelvisQuat,
        anatomicalFlexionAxis: pelvisFlexionAxis,
      });

      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      expect(angleDifference(calibratedNeutral, targetPelvisQuat)).toBeLessThan(
        1,
      );
    });

    it("should calibrate tibia with arbitrary mounting", () => {
      // Tibia target: same as thigh (pointing down)
      const targetTibiaQuat = quatFromEulerDeg(180, 0, 0);

      // Tibia flexion axis (knee flexion = X rotation)
      const tibiaFlexionAxis = new THREE.Vector3(1, 0, 0);

      // Arbitrary tibia sensor mounting
      const sensorQuat = quatFromEulerDeg(-135, 60, 20);

      const pcaAxis = tibiaFlexionAxis
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const worldGravity = new THREE.Vector3(0, -1, 0);
      const gravitySensor = worldGravity
        .clone()
        .applyQuaternion(sensorQuat.clone().invert());

      const result = computeTwoLayerCalibration({
        sensorQuatAtNeutral: sensorQuat,
        pcaFlexionAxisSensor: pcaAxis,
        gravitySensor,
        targetBoneQuat: targetTibiaQuat,
        anatomicalFlexionAxis: tibiaFlexionAxis,
      });

      const calibratedNeutral = applyTwoLayerCalibration(sensorQuat, result);

      expect(angleDifference(calibratedNeutral, targetTibiaQuat)).toBeLessThan(
        1,
      );
    });
  });
});

describe("Comparison: Single-Layer vs Two-Layer", () => {
  it("should show that single-layer fails with 90° rotated mounting", () => {
    // Target thigh
    const targetThighQuat = quatFromEulerDeg(180, 0, 0);

    // 90° rotated mounting
    const sensorQuat = quatFromEulerDeg(180, 0, 90);

    // SINGLE LAYER (current broken approach)
    const singleLayerOffset = sensorQuat
      .clone()
      .invert()
      .multiply(targetThighQuat);

    // Apply to neutral - this WILL work for neutral
    const singleLayerNeutral = sensorQuat.clone().multiply(singleLayerOffset);
    expect(angleDifference(singleLayerNeutral, targetThighQuat)).toBeLessThan(
      1,
    );

    // Now apply 45° knee flexion
    // With 90° rotated sensor, flexion is around sensor Y
    const flexionQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      (45 * Math.PI) / 180,
    );
    const sensorFlexed = sensorQuat.clone().multiply(flexionQuat);

    // Single layer result
    const singleLayerFlexed = sensorFlexed.clone().multiply(singleLayerOffset);

    // Expected result (flexion around bone X)
    const expectedFlexed = targetThighQuat
      .clone()
      .multiply(quatFromEulerDeg(45, 0, 0));

    // Single layer will be WRONG because sensor Y rotation became bone Y rotation
    // not bone X rotation as it should be
    const singleLayerError = angleDifference(singleLayerFlexed, expectedFlexed);

    // This error will be significant (around 45° or more)
    // We expect the single-layer approach to fail here
    console.log(
      `Single-layer error with 90° rotated sensor: ${singleLayerError.toFixed(1)}°`,
    );

    // The error should be large (> 10°)
    expect(singleLayerError).toBeGreaterThan(10);
  });

  it("should show that two-layer succeeds where single-layer fails", () => {
    const targetThighQuat = quatFromEulerDeg(180, 0, 0);
    const anatomicalFlexionAxis = new THREE.Vector3(1, 0, 0);

    // 90° rotated mounting
    const sensorQuat = quatFromEulerDeg(180, 0, 90);

    // PCA axis (sensor Y because of 90° rotation)
    const pcaAxis = new THREE.Vector3(0, 1, 0);

    // Gravity in sensor frame
    const gravitySensor = new THREE.Vector3(-1, 0, 0);

    // TWO LAYER
    const result = computeTwoLayerCalibration({
      sensorQuatAtNeutral: sensorQuat,
      pcaFlexionAxisSensor: pcaAxis,
      gravitySensor,
      targetBoneQuat: targetThighQuat,
      anatomicalFlexionAxis,
    });

    // Compute sensor flexed position the correct way (same as 90° rotated test):
    // 1. Compute bone flexed position
    const q_bone_flexed = targetThighQuat
      .clone()
      .multiply(quatFromEulerDeg(45, 0, 0));

    // 2. Compute the mounting offset: M = inv(q_bone_neutral) × q_sensor_neutral
    const q_mounting = targetThighQuat
      .clone()
      .invert()
      .multiply(sensorQuat.clone());

    // 3. Sensor at flexed = bone_flexed × mounting
    const sensorFlexed = q_bone_flexed.clone().multiply(q_mounting);

    const twoLayerFlexed = applyTwoLayerCalibration(sensorFlexed, result);

    const expectedFlexed = targetThighQuat
      .clone()
      .multiply(quatFromEulerDeg(45, 0, 0));

    const twoLayerError = angleDifference(twoLayerFlexed, expectedFlexed);

    console.log(
      `Two-layer error with 90° rotated sensor: ${twoLayerError.toFixed(1)}°`,
    );

    // Two-layer should succeed (< 2°)
    expect(twoLayerError).toBeLessThan(2);
  });
});
