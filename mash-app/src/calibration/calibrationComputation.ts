/**
 * calibrationComputation.ts
 *
 * Pure computation functions extracted from the UnifiedCalibration orchestrator.
 * Handles per-segment GramSchmidt calibration, inter-segment consistency checks,
 * SARA hinge axis estimation, and post-calibration IK validation.
 *
 * Each function is stateless: it takes explicit inputs and returns results
 * (or side-effects via console warnings). The orchestrator class remains
 * responsible for state management, error handling, and audit logging.
 */

import * as THREE from "three";
import {
  estimateFunctionalAxis,
  constructGramSchmidtFrame,
} from "./calibrationMath";
import { GRAVITY_DIRECTION } from "../lib/math/conventions";
import { ANATOMICAL_AXES, BALL_SOCKET_SEGMENTS } from "./pcaRefinement";
import type { SARACalibrator, JointPairDefinition } from "./ScoreAnalysis";
import {
  calibrationValidator,
  type ValidationResult,
} from "./CalibrationValidator";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";
import type { DeviceData } from "../store/useDeviceRegistry";
import type {
  CalibrationResult,
  JointConstraintResult,
} from "./UnifiedCalibration";

// ============================================================================
// PER-SEGMENT GRAMSCHMIDT CALIBRATION
// ============================================================================

export interface SegmentCalibrationInput {
  deviceId: string;
  segment: string;
  /** Sensor quaternion at static capture pose. */
  sensorQuat: THREE.Quaternion;
  /** Functional motion gyro data (Map<deviceId, gyro[]>). */
  functionalMotionData: Map<string, THREE.Vector3[]> | null;
  /** Optional end-of-flow static pose for sandwich calibration. */
  finalPoseData: Map<string, THREE.Quaternion> | null;
  /** Target neutral (bind) pose per segment. */
  targetNeutralPose: Map<string, THREE.Quaternion> | null;
}

export interface SegmentCalibrationSuccess {
  result: CalibrationResult;
  auditData: Record<string, unknown>;
}

export type SegmentCalibrationOutcome =
  | { ok: true; data: SegmentCalibrationSuccess }
  | { ok: false; error: string };

/** Helper formatting utilities. */
const r2d = (r: number) => ((r * 180) / Math.PI).toFixed(1);
const v3str = (v: THREE.Vector3) =>
  `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`;
const qeuler = (q: THREE.Quaternion) => {
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  return `[${r2d(e.x)}°, ${r2d(e.y)}°, ${r2d(e.z)}°]`;
};

/**
 * Compute the GramSchmidt-based calibration for a single segment.
 *
 * Pipeline:
 *   1. PCA axis validation (confidence gating)
 *   2. Temporal stability check (split-half axis deviation)
 *   3. GramSchmidt mounting tare (sensor → bone rotation)
 *   4. Heading tare with bind-pose correction
 *   5. Post-cal verification metrics (identity, axis alignment, gravity)
 *   6. Quality scoring (PCA confidence only)
 *
 * Returns the CalibrationResult on success, or an error string on failure.
 */
export function computeSegmentCalibration(
  input: SegmentCalibrationInput,
): SegmentCalibrationOutcome {
  const {
    deviceId,
    segment,
    sensorQuat,
    functionalMotionData,
    finalPoseData,
    targetNeutralPose,
  } = input;

  // ── 1. PCA data source ──────────────────────────────────────────────────
  let pcaData: Map<string, THREE.Vector3[]> | null = null;
  let pcaDataSource = "none";
  if (functionalMotionData && functionalMotionData.size > 0) {
    pcaData = functionalMotionData;
    pcaDataSource = "functional-motion";
  }

  if (!pcaData) {
    return {
      ok: false,
      error: `[UnifiedCal] research_strict requires functional motion data for ${segment}. No PCA data found.`,
    };
  }

  const gyroSamples = pcaData.get(deviceId);
  if (!gyroSamples || gyroSamples.length < 30) {
    return {
      ok: false,
      error: `[UnifiedCal] Insufficient functional data for ${segment} (${gyroSamples?.length ?? 0} samples). Perform the motion task fully.`,
    };
  }

  // ── 2. PCA axis estimation & confidence gating ──────────────────────────
  const pcaResult = estimateFunctionalAxis(gyroSamples);
  const isBallSocket = BALL_SOCKET_SEGMENTS.has(segment);
  // Ball-and-socket joints (hip, shoulder) need stricter PCA confidence:
  // free unconstrained swing excites multiple DOF, lowering axis dominance.
  const pcaConfThreshold = isBallSocket ? 0.85 : 0.75;
  const pcaPassed = pcaResult.confidence >= pcaConfThreshold;

  // For non-pelvis segments, low PCA confidence is a hard failure.
  // Pelvis is special: its functional data comes from leg-swing steps where
  // it's relatively still — PCA often fails. We fall back to gravity-only
  // mounting tare for pelvis, which gives correct tilt tracking and lets
  // the heading tare handle the remaining yaw alignment.
  if (!pcaPassed && segment !== "pelvis") {
    return {
      ok: false,
      error: isBallSocket
        ? `[UnifiedCal] PCA confidence too low for ${segment} (ball-and-socket): ${pcaResult.confidence.toFixed(2)} < ${pcaConfThreshold.toFixed(2)}. Perform STRICTLY SAGITTAL movement — no abduction or rotation.`
        : `[UnifiedCal] PCA confidence too low for ${segment}: ${pcaResult.confidence.toFixed(2)} < ${pcaConfThreshold.toFixed(2)}. Repeat with cleaner single-axis movement.`,
    };
  }

  // ── 3. Temporal stability: split-half PCA axis deviation ────────────────
  // Measures whether the subject's motor pattern was consistent throughout.
  // A deviation > 20° means the dominant axis shifted mid-trial (e.g. fatigue,
  // weight re-distribution), which invalidates the averaged PCA result.
  // (Only meaningful when PCA passed confidence threshold)
  if (pcaPassed && gyroSamples.length >= 60) {
    const half = Math.floor(gyroSamples.length / 2);
    const pcaFirst = estimateFunctionalAxis(gyroSamples.slice(0, half));
    const pcaSecond = estimateFunctionalAxis(gyroSamples.slice(half));
    // PCA eigenvectors have sign ambiguity — take the acute angle.
    const rawDev = pcaFirst.axis.angleTo(pcaSecond.axis) * (180 / Math.PI);
    const axisDevDeg = Math.min(rawDev, 180 - rawDev);
    if (axisDevDeg > 20) {
      console.warn(
        `  [GS-CAL] ⚠ PCA axis unstable for ${segment}: ${axisDevDeg.toFixed(1)}° between halves — motor pattern changed mid-trial`,
      );
    }
  }

  // ── 4. Anatomical axis mapping ──────────────────────────────────────────
  const anatomicalAxis = ANATOMICAL_AXES[segment];
  if (!anatomicalAxis && pcaPassed) {
    return {
      ok: false,
      error: `[UnifiedCal] No anatomical axis defined for ${segment}. Cannot perform GramSchmidt calibration.`,
    };
  }

  // ── 5. Gravity in sensor local frame at the static capture moment ──────
  //    GRAVITY_DIRECTION = (0,-1,0) in Three.js world (Y-up).
  const gravityInSensor = GRAVITY_DIRECTION.clone().applyQuaternion(
    sensorQuat.clone().invert(),
  );

  // ── 6. Mounting tare: sensor→bone alignment ────────────────────────────
  let newMountingTare: THREE.Quaternion;
  let usedGravityFallback = false;

  if (pcaPassed && anatomicalAxis) {
    // NORMAL PATH: PCA + GramSchmidt
    //    Maps: pcaFlexAxis (sensor local) → anatomicalAxis (bone frame)
    //          gravityInSensor (sensor local) → (0,-1,0) (bone frame down)
    newMountingTare = constructGramSchmidtFrame(
      pcaResult.axis, // flex axis in sensor local frame (from PCA)
      gravityInSensor, // gravity in sensor local frame (from static)
      anatomicalAxis, // flex axis in bone frame (e.g. [1,0,0])
      new THREE.Vector3(0, -1, 0), // gravity direction in bone frame = -Y
    );
  } else {
    // GRAVITY-ONLY FALLBACK (pelvis)
    //    During leg-functional steps the pelvis is relatively still, so PCA
    //    often returns a noisy/wrong axis. Instead of mapping a bad PCA axis,
    //    align only gravity (correct pitch/roll). The heading tare then
    //    handles the remaining yaw offset.
    //
    //    Dynamic behavior: vertical-axis rotations (yaw) map correctly.
    //    Horizontal-plane axis decomposition has minor yaw ambiguity that
    //    the heading tare compensates at the calibration pose. For typical
    //    pelvis movements (<15° tilt), the visual error is <5°.
    usedGravityFallback = true;
    newMountingTare = new THREE.Quaternion().setFromUnitVectors(
      gravityInSensor.clone().normalize(),
      new THREE.Vector3(0, -1, 0),
    );
    console.warn(
      `  [GS-CAL] Pelvis: PCA confidence too low (${pcaResult.confidence.toFixed(2)} < ${pcaConfThreshold}). ` +
        `Using gravity-only mounting tare fallback. Tilt tracking OK, ` +
        `horizontal-plane axis mapping has minor yaw ambiguity.`,
    );
  }

  // ── 7. Heading tare: world-space zero reference ────────────────────────
  //
  //    CRITICAL — bind-pose correction:
  //    applyToBone computes: local = inv(parentWorld) × q_world
  //    For leg bones with no pelvis sensor, parentWorld stays at bind pose.
  //    If q_world = identity at capture, local = inv(bindParent) ≠ bind_local
  //    → leg snaps to an incorrect pose (e.g. arabesque).
  //
  //    Fix: bake the bone's own bind-world quat into headingTare so that
  //    at frame 1: q_world = bindWorldQuat → local = bindWorldQuat/parentWorld = bind_local
  //
  //    headingTare = captureQuat × mountingTare × inv(bindWorldQuat)
  //    → q_world = inv(headingTare) × (captureQuat × mountingTare) = bindWorldQuat ✓
  const bindWorldQuat =
    targetNeutralPose?.get(segment) ?? new THREE.Quaternion();
  const usingFinalPose = finalPoseData?.has(deviceId) ?? false;
  const captureQuat = finalPoseData?.get(deviceId) ?? sensorQuat;
  const newHeadingTare = captureQuat
    .clone()
    .multiply(newMountingTare)
    .multiply(bindWorldQuat.clone().invert());

  // ── 8. Post-calibration verification metrics ───────────────────────────
  // Bind-pose check:
  //   q_world = inv(headingTare) × (captureQuat × mountingTare)
  //   Should equal bindWorldQuat (0° deviation from bind pose).
  const verifyBone = captureQuat.clone().multiply(newMountingTare);
  const verifyWorld = newHeadingTare.clone().invert().multiply(verifyBone);
  const identityDeg = verifyWorld.angleTo(bindWorldQuat) * (180 / Math.PI);

  // How well does the PCA axis align to anatomicalAxis after mountingTare?
  // (Only meaningful when PCA was used, not for gravity-only fallback)
  let axisAlignmentDot = 1.0;
  if (!usedGravityFallback && anatomicalAxis) {
    const pcaInBone = pcaResult.axis.clone().applyQuaternion(newMountingTare);
    axisAlignmentDot = Math.abs(pcaInBone.dot(anatomicalAxis));
  }

  // How well does gravity align to -Y after mountingTare?
  // NOTE: no Math.abs() — the dot product must be POSITIVE (gravity maps to
  // bone -Y, not +Y). A negative value means the sensor is mounted upside-down
  // and the GS basis has the wrong chirality.
  const gravityInBone = gravityInSensor
    .clone()
    .applyQuaternion(newMountingTare);
  const gravityAlignmentDot = gravityInBone.dot(new THREE.Vector3(0, -1, 0));

  // ── 9. Diagnostic warnings ─────────────────────────────────────────────
  if (identityDeg > 0.5) {
    console.warn(
      `  [GS-CAL] ⚠ Bind-world check failed for ${segment}: ${identityDeg.toFixed(2)}° > 0.5° — headingTare or bindWorldQuat mismatch`,
    );
  }
  if (axisAlignmentDot < 0.85) {
    console.warn(
      `  [GS-CAL] ⚠ Low axis alignment for ${segment}: ${(axisAlignmentDot * 100).toFixed(1)}% — PCA axis may be noisy or wrong segment`,
    );
  }

  // ── 10. Gravity alignment gates ─────────────────────────────────────────
  if (gravityAlignmentDot < 0) {
    console.error(
      `  [GS-CAL] ✖ Inverted gravity for ${segment}: dot=${gravityAlignmentDot.toFixed(3)} — sensor may be mounted upside-down or static capture was in an inverted posture`,
    );
    return {
      ok: false,
      error: `[UnifiedCal] Gravity direction inverted for ${segment}: sensor may be mounted upside-down. Check sensor orientation before calibrating.`,
    };
  }
  if (gravityAlignmentDot < 0.5) {
    console.error(
      `  [GS-CAL] ✖ Critical gravity alignment failure for ${segment}: ${(gravityAlignmentDot * 100).toFixed(1)}% < 50% — ensure body is upright during static capture`,
    );
    return {
      ok: false,
      error: `[UnifiedCal] Gravity alignment too low for ${segment}: ${(gravityAlignmentDot * 100).toFixed(0)}% — stand upright and still during the static capture step.`,
    };
  }
  if (gravityAlignmentDot < 0.7) {
    console.warn(
      `  [GS-CAL] ⚠ Low gravity alignment for ${segment}: ${(gravityAlignmentDot * 100).toFixed(1)}% — sensor may not have been vertical during static capture`,
    );
  }

  // ── 11. Quality score & result construction ─────────────────────────────
  // Quality score = PCA confidence only (or reduced for gravity-only fallback).
  // gravityAlignmentPct and axisAlignmentPct are stored as separate hardware/math
  // diagnostic fields and must NOT be blended into the primary quality metric:
  //   • axisAlignmentDot converges to ~1.0 whenever the GS math succeeds (trivially)
  //   • gravityAlignmentDot measures setup quality, not motion quality
  // Blending them inflates scores for poor-data sessions with good hardware setup.
  //
  // Gravity-only fallback: quality is capped at 60% to signal reduced accuracy.
  // Gravity alignment is perfect, but horizontal-plane axis mapping has ambiguity.
  const finalScore = usedGravityFallback
    ? Math.min(60, pcaResult.confidence * 100)
    : pcaResult.confidence * 100;

  const result: CalibrationResult = {
    segmentId: segment,
    offset: newMountingTare,
    mountingTare: newMountingTare,
    headingTare: newHeadingTare,
    quality: finalScore,
    method: usedGravityFallback ? "gravity-only" : "pca-refined",
    pcaConfidence: pcaResult.confidence,
    gravityAlignmentPct: gravityAlignmentDot * 100,
    axisAlignmentPct: axisAlignmentDot * 100,
    timestamp: Date.now(),
  };

  const auditData: Record<string, unknown> = {
    pcaSource: usedGravityFallback ? "gravity-only-fallback" : pcaDataSource,
    samples: gyroSamples.length,
    pcaAxis: v3str(pcaResult.axis),
    conf: pcaResult.confidence.toFixed(3),
    usedGravityFallback,
    gravityInSensor: v3str(gravityInSensor),
    mountingTareEuler: qeuler(newMountingTare),
    headingTareEuler: qeuler(newHeadingTare),
    captureSource: usingFinalPose ? "finalPose" : "staticPose",
    identityCheckDeg: identityDeg.toFixed(2),
    axisAlignmentPct: (axisAlignmentDot * 100).toFixed(1),
    gravityAlignPct: (gravityAlignmentDot * 100).toFixed(1),
  };

  return { ok: true, data: { result, auditData } };
}

// ============================================================================
// INTER-SEGMENT CONSISTENCY CHECK
// ============================================================================

/**
 * Check knee joint consistency at the static capture pose.
 *
 * In a neutral standing posture the knee should be fully extended (~0°).
 * A measured angle > 8° means one (or both) calibrations failed silently
 * and the avatar will display a bent knee at rest.
 */
export function checkKneeConsistency(
  results: Map<string, CalibrationResult>,
  staticPoseData: Map<string, THREE.Quaternion>,
  devices: Map<string, DeviceData>,
  getSegmentForSensor: (id: string) => string | undefined,
): void {
  const KNEE_PAIRS: [string, string, string][] = [
    ["knee_l", "thigh_l", "tibia_l"],
    ["knee_r", "thigh_r", "tibia_r"],
  ];

  for (const [jointLabel, proxSeg, distSeg] of KNEE_PAIRS) {
    const proxResult = results.get(proxSeg);
    const distResult = results.get(distSeg);
    if (!proxResult || !distResult) continue;

    // Locate device IDs for each segment by scanning the device registry.
    let proxDevId: string | undefined;
    let distDevId: string | undefined;
    devices.forEach((d) => {
      const seg = getSegmentForSensor(d.id);
      if (seg === proxSeg) proxDevId = d.id;
      if (seg === distSeg) distDevId = d.id;
    });
    if (!proxDevId || !distDevId) continue;

    const proxStaticQuat = staticPoseData.get(proxDevId);
    const distStaticQuat = staticPoseData.get(distDevId);
    if (!proxStaticQuat || !distStaticQuat) continue;

    // q_bone = q_sensor_static × mountingTare  (world-space bone orientation)
    const proxMounting = proxResult.mountingTare ?? proxResult.offset;
    const distMounting = distResult.mountingTare ?? distResult.offset;
    const proxBone = proxStaticQuat.clone().multiply(proxMounting);
    const distBone = distStaticQuat.clone().multiply(distMounting);

    // Relative rotation from proximal to distal segment at static pose.
    // For a neutral standing posture this should be near identity (0°).
    const relQuat = proxBone.clone().invert().multiply(distBone);
    const angleDeg =
      2 * Math.acos(Math.min(1, Math.abs(relQuat.w))) * (180 / Math.PI);

    if (angleDeg > 8) {
      console.warn(
        `[CalCheck] ⚠ ${jointLabel}: ${angleDeg.toFixed(1)}° at static pose` +
          ` (expect < 8°) — ${proxSeg} / ${distSeg} calibration mismatch`,
      );
    }
  }
}

// ============================================================================
// SARA HINGE AXIS CONSTRAINTS
// ============================================================================

/**
 * Compute SARA hinge axis constraints for all calibrated joint pairs.
 *
 * Returns a map of joint constraints. Also mutates the `results` map
 * to mark child segments as "sara-refined" when SARA confidence > 0.7.
 */
export function computeSARAConstraints(
  saraCalibrators: Map<string, SARACalibrator>,
  calibrableJoints: JointPairDefinition[],
  results: Map<string, CalibrationResult>,
): Map<string, JointConstraintResult> {
  const constraints = new Map<string, JointConstraintResult>();

  if (saraCalibrators.size === 0) return constraints;

  console.debug("[SARA] Computing hinge axis constraints...");

  for (const [jointId, calibrator] of saraCalibrators) {
    const frameCount = calibrator.getFrameCount();
    if (frameCount < 30) continue;

    const result = calibrator.compute();
    if (!result) {
      console.debug(`[SARA] ${jointId}: Estimation failed`);
      continue;
    }

    const constraint: JointConstraintResult = {
      jointId,
      jointType: "hinge",
      hingeAxisWorld: result.axisWorld.clone(),
      hingeAxisProximal: result.axisInProximal.clone(),
      hingeAxisDistal: result.axisInDistal.clone(),
      confidence: result.confidence,
    };

    constraints.set(jointId, constraint);

    // Mark child segment as SARA-refined if confidence is high enough
    const joint = calibrableJoints.find((j) => j.jointId === jointId);
    if (joint && result.confidence > 0.7) {
      const childResult = results.get(joint.distalSegment.toLowerCase());
      if (childResult) {
        childResult.method = "sara-refined";
        childResult.saraResult = result;
      }
    }
  }

  if (constraints.size > 0) {
    console.debug(`[SARA] ${constraints.size} joint constraint(s) computed`);
  }

  return constraints;
}

// ============================================================================
// POST-CALIBRATION IK VALIDATION
// ============================================================================

export interface PostCalibrationValidationResult {
  validationResult: ValidationResult;
  qualityDowngrade: number | null;
}

/**
 * Run IK validation on the calibrated orientations to detect issues.
 *
 * Reconstructs world-space bone orientations from static-pose sensor data
 * and calibration offsets, then passes them through the CalibrationValidator.
 *
 * Returns the validation result and whether quality should be downgraded
 * (null if no static pose data is available).
 */
export function runPostCalibrationValidation(
  results: Map<string, CalibrationResult>,
  staticPoseData: Map<string, THREE.Quaternion>,
  driftMetrics: Map<string, number>,
  targetNeutralPose: Map<string, THREE.Quaternion> | null,
): PostCalibrationValidationResult | null {
  if (!staticPoseData) {
    console.warn("[UnifiedCal] Cannot validate - no static pose data");
    return null;
  }

  const { getSegmentForSensor } = useSensorAssignmentStore.getState();
  const calibratedOrientations = new Map<string, THREE.Quaternion>();

  console.debug(
    `[UnifiedCal] Validating ${results.size} calibrated segments using static pose data for ${staticPoseData.size} devices`,
  );

  for (const [segmentId, result] of results) {
    let sensorQuat: THREE.Quaternion | undefined;
    for (const [deviceId, quat] of staticPoseData) {
      if (getSegmentForSensor(deviceId) === segmentId) {
        sensorQuat = quat;
        break;
      }
    }

    if (sensorQuat) {
      const calibratedQuat = sensorQuat.clone().multiply(result.offset);
      calibratedOrientations.set(segmentId, calibratedQuat);
    } else {
      console.warn(
        `[UnifiedCal] Validation skipped for ${segmentId}: No matching static pose data found`,
      );
    }
  }

  if (calibratedOrientations.size === 0) {
    console.error(
      "[UnifiedCal] Validation ABORTED: No calibrated orientations could be reconstructed",
    );
  }

  // Pass the targetNeutralPose (if available) so validation checks against A-Pose, not T-Pose
  const validationResult = calibrationValidator.validate(
    calibratedOrientations,
    targetNeutralPose || undefined,
    driftMetrics,
  );

  console.debug(`[UnifiedCal] IK Validation: ${validationResult.summary}`);

  let qualityDowngrade: number | null = null;
  if (
    validationResult.recommendations.length > 0 &&
    !validationResult.isValid
  ) {
    // Use validator score as a concrete fallback quality target.
    qualityDowngrade = Math.max(
      0,
      Math.min(100, validationResult.overallScore),
    );
  }

  return { validationResult, qualityDowngrade };
}
