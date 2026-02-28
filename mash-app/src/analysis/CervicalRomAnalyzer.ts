/**
 * Cervical Range of Motion Analyzer
 * ===================================
 *
 * Processes head-segment quaternion frames into per-plane ROM distributions
 * using the full orientation pipeline for clinical-grade accuracy.
 *
 * PIPELINE INTEGRATION (Tier 1):
 *   When TareState is provided (from session calibration data), quaternions
 *   are routed through OrientationPipeline.transformOrientation() which applies:
 *     L0: Array → THREE.Quaternion
 *     L1: Mounting tare (sensor → bone alignment)
 *     FA: Frame alignment (PCA functional axes from cervical calibration)
 *     L2: Heading tare (boresighting to world frame)
 *   When no TareState exists, falls back to raw quat with self-referenced neutral.
 *
 * VIRTUAL THORAX PARENT FRAME (Tier 2):
 *   Single-sensor cervical recordings lack a physical thorax sensor. We construct
 *   a gravity-locked virtual thorax quaternion from the head sensor's accelerometer:
 *     1. Extract gravity direction from accelerometer (low-pass filtered)
 *     2. Assume thorax vertical axis = world Y (gravity-aligned)
 *     3. Use calibration heading for thorax forward direction
 *     4. q_cervical = q_virtualThorax⁻¹ × q_head  (isolates head-on-thorax motion)
 *   This removes whole-body postural sway from cervical ROM measurements.
 *
 * EULER DECOMPOSITION (ISB Standard):
 *   Intrinsic XZY order (ISB recommended for cervical spine):
 *     X = flexion/extension (sagittal plane)
 *     Z = lateral flexion   (frontal plane)
 *     Y = axial rotation    (transverse plane)
 *
 * COMPENSATION DETECTION:
 *   Monitors accelerometer drift from calibration gravity vector.
 *   If trunk inclination exceeds threshold, flags compensation artifact.
 *
 * Convention: positive = flexion, right lateral, right rotation
 *
 * @module CervicalRomAnalyzer
 */

import * as THREE from "three";
import { firmwareToThreeQuat } from "../lib/math/conventions";
import { transformOrientation } from "../lib/math/OrientationPipeline";
import type { TareState } from "../calibration/taringPipeline";
import type { RecordedFrame } from "../lib/db";

// ============================================================================
// TYPES
// ============================================================================

/** One degree-bin of dwell-time density */
export interface RomHistogram {
  /** Bin centres in degrees (e.g. -80, -79, … 0, … +80) */
  bins: number[];
  /** Normalized density per bin (0-1, sum = 1) */
  density: number[];
  /** Peak density value (for colour-scale normalisation) */
  peakDensity: number;
}

/** Per-direction (neg / pos) ROM & velocity breakdown */
export interface DirectionalMetrics {
  rom: number; // absolute degrees in this direction (always ≥ 0)
  normalRom: number; // textbook normal for this direction (always ≥ 0)
  pctOfNormal: number; // (rom / normalRom) * 100
  avgVelocityDegS: number; // mean angular velocity when moving in this direction
  peakVelocityDegS: number; // peak instantaneous velocity in this direction
  dwellPercent: number; // % of total time spent on this side of zero
  reps: number; // number of excursions into this direction
}

/**
 * Composite symmetry score for a single plane.
 *
 * Research basis:
 *   ROM symmetry:      Duc et al. (2014) — L/R ROM ratio is the primary
 *                      clinical symmetry indicator for cervical assessment.
 *   Velocity symmetry: Kristjansson & Oddsdóttir (2010) — movement speed
 *                      asymmetry is an independent predictor of dysfunction.
 *
 * Composite = 0.60 * romSymmetry + 0.40 * velocitySymmetry
 *   where each sub-score = (smaller / larger) * 100
 */
export interface PlaneSymmetry {
  romSymmetry: number; // (min(negRom,posRom) / max(negRom,posRom)) * 100
  velocitySymmetry: number; // (min(negVel,posVel) / max(negVel,posVel)) * 100
  compositeScore: number; // weighted blend (0-100, 100 = perfect symmetry)
}

/** ROM metrics for a single anatomical plane */
export interface PlaneRom {
  label: string; // e.g. "Flexion / Extension"
  negLabel: string; // e.g. "Extension"
  posLabel: string; // e.g. "Flexion"
  minDeg: number; // most negative observed (e.g. -35  = 35° extension)
  maxDeg: number; // most positive observed (e.g. +42  = 42° flexion)
  totalRomDeg: number; // maxDeg - minDeg
  meanDeg: number; // average position → postural bias
  histogram: RomHistogram; // 1° bin dwell time
  normalMinDeg: number; // textbook normal range (negative)
  normalMaxDeg: number; // textbook normal range (positive)
  avgVelocityDegS: number; // mean angular velocity during active phases

  // --- Directional breakdown ---
  neg: DirectionalMetrics; // negative direction (extension / left)
  pos: DirectionalMetrics; // positive direction (flexion / right)
  symmetry: PlaneSymmetry; // composite symmetry for this plane
}

/**
 * Master symmetry score methodology:
 *
 * Weights reflect clinical significance of L/R asymmetry:
 *   - Sagittal  (flex/ext):      30%  — less laterality-dependent
 *   - Frontal   (lateral flex):  35%  — direct L/R comparison
 *   - Transverse (rotation):     35%  — direct L/R comparison
 *
 * masterSymmetry = Σ(planeWeight × planeCompositeScore)
 */
export interface MasterSymmetry {
  score: number; // 0-100, 100 = perfect symmetry
  sagittalWeight: number; // 0.30
  frontalWeight: number; // 0.35
  transverseWeight: number; // 0.35
  grade: "excellent" | "good" | "fair" | "poor"; // clinical interpretation
}

/** Thoracic compensation detection result */
export interface CompensationInfo {
  /** Whether significant trunk compensation was detected */
  detected: boolean;
  /** Mean trunk inclination from vertical (degrees) */
  meanTrunkInclinationDeg: number;
  /** Peak trunk inclination from vertical (degrees) */
  peakTrunkInclinationDeg: number;
  /** Percentage of frames where trunk inclination exceeded threshold */
  compensationPercent: number;
  /** Threshold used for detection (degrees) */
  thresholdDeg: number;
}

/** Pipeline metadata — documents which corrections were applied */
export interface PipelineInfo {
  /** Whether calibrated quaternions were used (via taring pipeline) */
  usedCalibratedQuats: boolean;
  /** Whether virtual thorax parent frame was applied */
  usedVirtualThorax: boolean;
  /** Euler decomposition order used */
  eulerOrder: string;
  /** Which tare levels were applied */
  appliedLevels: {
    mountingTare: boolean;
    frameAlignment: boolean;
    headingTare: boolean;
  };
}

/** Full cervical ROM analysis result */
export interface CervicalRomResult {
  sagittal: PlaneRom; // flexion / extension
  frontal: PlaneRom; // lateral flexion L/R
  transverse: PlaneRom; // rotation L/R
  masterSymmetry: MasterSymmetry; // overall symmetry grade
  activePercent: number; // % of time in motion
  totalFrames: number;
  durationMs: number;
  compensation: CompensationInfo; // thoracic compensation detection
  pipeline: PipelineInfo; // pipeline metadata
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Normal ROM ranges (textbook values, degrees) */
const NORMAL_RANGES = {
  sagittal: { min: -60, max: 50 }, // extension(-) / flexion(+)
  frontal: { min: -45, max: 45 }, // left(-) / right(+) lateral flex
  transverse: { min: -80, max: 80 }, // left(-) / right(+) rotation
};

/** Gyro magnitude threshold (rad/s) to classify frame as "active" */
const ACTIVE_GYRO_THRESHOLD = 0.15; // ~8.6 °/s

/** Number of initial frames to average as the neutral reference pose */
const NEUTRAL_WINDOW = 30;

/** Rep counting thresholds (degrees) */
const REP_ENTRY_THRESHOLD = 10; // must travel this far from zero to start a rep
const REP_EXIT_THRESHOLD = 5; // must return within this of zero to complete a rep

/** Trunk compensation detection threshold (degrees from vertical) */
const COMPENSATION_THRESHOLD_DEG = 5;

/** Low-pass filter alpha for accelerometer gravity estimation */
const GRAVITY_LP_ALPHA = 0.05;

/** ISB Euler decomposition order for cervical spine */
const ISB_SPINE_EULER_ORDER = "XZY" as const;

/** Options for the cervical ROM analyzer */
export interface CervicalRomOptions {
  /** TareState for the head segment (enables calibrated quaternions) */
  tareState?: TareState | null;
  /** Calibration gravity vector captured during cervical cal (accelerometer at rest) */
  calibrationGravity?: [number, number, number] | null;
}

// ============================================================================
// ANALYZER
// ============================================================================

/**
 * Analyse an array of head-segment RecordedFrames and return cervical ROM results.
 *
 * Tier 1: When `options.tareState` is provided, quaternions are routed through
 * the orientation pipeline (L0→L1→FA→L2) for calibrated bone orientations.
 *
 * Tier 2: When accelerometer data is available, a gravity-locked virtual thorax
 * parent frame is constructed to isolate head-on-thorax motion from trunk sway.
 *
 * ISB Standard: Euler decomposition uses XZY order (not ZYX) per ISB
 * recommendation for the cervical spine.
 *
 * @param headFrames  Frames for the head sensor, time-sorted
 * @param options     Optional calibration/tare data for enhanced accuracy
 * @returns CervicalRomResult or null if insufficient data
 */
export function analyzeCervicalRom(
  headFrames: RecordedFrame[],
  options: CervicalRomOptions = {},
): CervicalRomResult | null {
  // ----- 0. De-interleave multi-sensor frames -----
  // When multiple sensors are present (no segment labels), frames alternate
  // between sensors. Adjacent frames from different sensors have wildly
  // different quaternions but near-identical timestamps, producing
  // astronomical velocity artifacts (e.g. 71000°/s).
  // Solution: extract only the most frequent (primary) sensor's frames.
  const sensorCounts = new Map<number, number>();
  for (const f of headFrames) {
    if (f.sensorId !== undefined) {
      sensorCounts.set(f.sensorId, (sensorCounts.get(f.sensorId) || 0) + 1);
    }
  }
  let filteredFrames = headFrames;
  if (sensorCounts.size > 1) {
    // Pick the sensor with the most frames
    let primarySensor = -1;
    let maxCount = 0;
    for (const [id, count] of sensorCounts) {
      if (count > maxCount) {
        maxCount = count;
        primarySensor = id;
      }
    }
    filteredFrames = headFrames.filter((f) => f.sensorId === primarySensor);
    console.debug(
      `[CervicalROM] De-interleaved: ${sensorCounts.size} sensors detected, ` +
        `using primary sensor ${primarySensor} (${filteredFrames.length}/${headFrames.length} frames)`,
    );
  }

  if (filteredFrames.length < NEUTRAL_WINDOW + 10) {
    console.warn(
      "[CervicalROM] Not enough frames for analysis:",
      filteredFrames.length,
    );
    return null;
  }

  const tareState = options.tareState ?? null;
  const hasTare =
    tareState !== null &&
    (tareState.mountingTareTime > 0 || tareState.headingTareTime > 0);

  // Track pipeline metadata
  const pipelineInfo: PipelineInfo = {
    usedCalibratedQuats: hasTare,
    usedVirtualThorax: false,
    eulerOrder: ISB_SPINE_EULER_ORDER,
    appliedLevels: {
      mountingTare: false,
      frameAlignment: false,
      headingTare: false,
    },
  };

  // ----- 1. Transform quaternions through orientation pipeline -----
  const worldQuats: THREE.Quaternion[] = [];

  if (hasTare) {
    // TIER 1: Use full orientation pipeline with calibrated tare data
    for (const frame of filteredFrames) {
      const result = transformOrientation(
        frame.quaternion,
        tareState,
        {},
        "head",
      );
      worldQuats.push(result.q_world.clone());

      // Capture applied levels from first frame
      if (worldQuats.length === 1) {
        pipelineInfo.appliedLevels.mountingTare =
          result.appliedLevels.mountingTare;
        pipelineInfo.appliedLevels.headingTare =
          result.appliedLevels.headingTare;
        // Check frame alignment
        pipelineInfo.appliedLevels.frameAlignment =
          tareState?.frameAlignment !== undefined &&
          tareState?.frameAlignmentTime !== undefined &&
          tareState.frameAlignmentTime > 0;
      }
    }
    console.debug(
      "[CervicalROM] Using calibrated quaternions via OrientationPipeline",
      pipelineInfo.appliedLevels,
    );
  } else {
    // FALLBACK: Raw quaternions with self-referenced neutral (legacy behaviour)
    for (const frame of filteredFrames) {
      worldQuats.push(firmwareToThreeQuat(frame.quaternion));
    }
    console.debug(
      "[CervicalROM] No tare data — using raw quaternions with self-referenced neutral",
    );
  }

  // ----- 2. Virtual thorax parent frame (Tier 2) -----
  // IMPORTANT: Virtual thorax requires calibrated quaternions (Tier 1).
  // Without calibration, the accel-to-world transform is unreliable because
  // the head sensor's raw quaternion doesn't accurately represent world frame.
  // Additionally, a head-mounted accelerometer transformed by its own quaternion
  // cancels out head tilt, producing a near-identity thorax — meaningless.
  const hasAccel =
    hasTare &&
    filteredFrames.some(
      (f) =>
        f.accelerometer &&
        (f.accelerometer[0] !== 0 ||
          f.accelerometer[1] !== 0 ||
          f.accelerometer[2] !== 0),
    );

  const virtualThoraxQuats: THREE.Quaternion[] = [];
  const trunkInclinationsDeg: number[] = [];

  if (hasAccel) {
    pipelineInfo.usedVirtualThorax = true;

    // Initialize gravity estimate from calibration or first valid frame
    let gravEst: THREE.Vector3;
    if (
      options.calibrationGravity &&
      options.calibrationGravity.some((v) => v !== 0)
    ) {
      gravEst = new THREE.Vector3(
        options.calibrationGravity[0],
        options.calibrationGravity[1],
        options.calibrationGravity[2],
      ).normalize();
    } else {
      // Use average of first NEUTRAL_WINDOW accelerometer readings
      const initAccel = new THREE.Vector3(0, 0, 0);
      let initCount = 0;
      for (
        let i = 0;
        i < Math.min(NEUTRAL_WINDOW, filteredFrames.length);
        i++
      ) {
        const a = filteredFrames[i].accelerometer;
        if (a && (a[0] !== 0 || a[1] !== 0 || a[2] !== 0)) {
          initAccel.add(new THREE.Vector3(a[0], a[1], a[2]));
          initCount++;
        }
      }
      gravEst =
        initCount > 0
          ? initAccel.divideScalar(initCount).normalize()
          : new THREE.Vector3(0, 1, 0); // default: Y-up
    }

    // Reference gravity direction (Y-up in world frame = straight posture)
    const worldUp = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < filteredFrames.length; i++) {
      const frame = filteredFrames[i];
      const accel = frame.accelerometer;

      if (accel && (accel[0] !== 0 || accel[1] !== 0 || accel[2] !== 0)) {
        // Low-pass filter accelerometer to extract gravity
        const rawAccel = new THREE.Vector3(accel[0], accel[1], accel[2]);

        // Transform accel to world frame using head orientation
        const worldAccel = rawAccel.clone().applyQuaternion(worldQuats[i]);
        const accelNorm = worldAccel.clone().normalize();

        // Low-pass filter
        gravEst.lerp(accelNorm, GRAVITY_LP_ALPHA).normalize();
      }

      // Trunk inclination = angle between filtered gravity and world up
      const inclinationRad = gravEst.angleTo(worldUp);
      const inclinationDeg = THREE.MathUtils.radToDeg(inclinationRad);
      trunkInclinationsDeg.push(inclinationDeg);

      // Build virtual thorax quaternion: rotation from world-up to gravity direction
      // This represents the trunk's orientation (gravity-locked, no heading)
      const thoraxQuat = new THREE.Quaternion().setFromUnitVectors(
        worldUp,
        gravEst.clone().normalize(),
      );
      virtualThoraxQuats.push(thoraxQuat);
    }

    console.debug(
      "[CervicalROM] Virtual thorax enabled — mean trunk inclination:",
      round1(
        trunkInclinationsDeg.reduce((s, v) => s + v, 0) /
          trunkInclinationsDeg.length,
      ),
      "°",
    );
  }

  // ----- 3. Compute relative quaternions and decompose to Euler -----
  // ALWAYS compute a neutral reference, even with virtual thorax.
  // With virtual thorax: neutral is averaged from first N thorax-relative quats.
  // Without: neutral is averaged from first N world quats directly.
  // This ensures angles start from ~0° regardless of initial pose offset.

  // First pass: compute per-frame base quaternions (before neutral subtraction)
  const baseQuats: THREE.Quaternion[] = [];
  for (let i = 0; i < filteredFrames.length; i++) {
    const q_head = worldQuats[i];

    if (pipelineInfo.usedVirtualThorax) {
      // TIER 2: Head relative to virtual thorax parent (removes trunk sway)
      const thoraxInv = virtualThoraxQuats[i].clone().invert();
      baseQuats.push(thoraxInv.multiply(q_head.clone()));
    } else {
      // Direct world orientation (trunk sway not removed)
      baseQuats.push(q_head.clone());
    }
  }

  // Compute neutral reference from first N base quaternions
  const neutralQuat = averageQuaternions(baseQuats.slice(0, NEUTRAL_WINDOW));
  const neutralInv = neutralQuat.clone().invert();

  const angles: { flexExt: number; latFlex: number; axialRot: number }[] = [];
  const gyroMags: number[] = [];

  for (let i = 0; i < filteredFrames.length; i++) {
    const frame = filteredFrames[i];

    // Subtract neutral reference to get motion relative to starting pose
    const q_relative = neutralInv.clone().multiply(baseQuats[i]);

    // ISB XZY Euler decomposition for cervical spine
    // X = flexion/extension (sagittal)
    // Z = lateral flexion   (frontal)
    // Y = axial rotation    (transverse)
    const euler = new THREE.Euler().setFromQuaternion(
      q_relative,
      ISB_SPINE_EULER_ORDER,
    );

    // XZY order: euler.x = flexion, euler.z = lateral flex, euler.y = rotation
    // In our [Right, Up, Backward] frame (Three.js Y-up):
    //   +X rotation = extension (not flexion) → negate for ISB flex(+)/ext(-)
    //   +Z rotation = left lateral flex → negate for ISB right(+)/left(-)
    //   +Y rotation = right turn → matches ISB convention
    const flexExtDeg = -THREE.MathUtils.radToDeg(euler.x); // flex(+)/ext(-)
    const latFlexDeg = -THREE.MathUtils.radToDeg(euler.z); // right(+)/left(-)
    const axialRotDeg = THREE.MathUtils.radToDeg(euler.y); // right(+)/left(-)

    angles.push({
      flexExt: flexExtDeg,
      latFlex: latFlexDeg,
      axialRot: axialRotDeg,
    });

    // Gyro magnitude for active/rest classification
    if (frame.gyro) {
      const gm = Math.sqrt(
        frame.gyro[0] ** 2 + frame.gyro[1] ** 2 + frame.gyro[2] ** 2,
      );
      gyroMags.push(gm);
    } else {
      gyroMags.push(0);
    }
  }

  // ----- 4. Per-plane analysis -----
  const flexExtValues = angles.map((a) => a.flexExt);
  const latFlexValues = angles.map((a) => a.latFlex);
  const axialRotValues = angles.map((a) => a.axialRot);

  const dtMs = computeDtMs(filteredFrames);

  const sagittal = buildPlaneRom(
    flexExtValues,
    gyroMags,
    dtMs,
    "Flexion / Extension",
    "Extension",
    "Flexion",
    NORMAL_RANGES.sagittal.min,
    NORMAL_RANGES.sagittal.max,
  );

  const frontal = buildPlaneRom(
    latFlexValues,
    gyroMags,
    dtMs,
    "Lateral Flexion",
    "Left",
    "Right",
    NORMAL_RANGES.frontal.min,
    NORMAL_RANGES.frontal.max,
  );

  const transverse = buildPlaneRom(
    axialRotValues,
    gyroMags,
    dtMs,
    "Rotation",
    "Left",
    "Right",
    NORMAL_RANGES.transverse.min,
    NORMAL_RANGES.transverse.max,
  );

  // ----- 5. Master symmetry score -----
  const SAG_W = 0.3,
    FRONT_W = 0.35,
    TRANS_W = 0.35;
  const masterScore =
    SAG_W * sagittal.symmetry.compositeScore +
    FRONT_W * frontal.symmetry.compositeScore +
    TRANS_W * transverse.symmetry.compositeScore;

  const grade: MasterSymmetry["grade"] =
    masterScore >= 90
      ? "excellent"
      : masterScore >= 75
        ? "good"
        : masterScore >= 55
          ? "fair"
          : "poor";

  const masterSymmetry: MasterSymmetry = {
    score: round1(masterScore),
    sagittalWeight: SAG_W,
    frontalWeight: FRONT_W,
    transverseWeight: TRANS_W,
    grade,
  };

  // ----- 6. Active vs rest -----
  const activeCount = gyroMags.filter((g) => g > ACTIVE_GYRO_THRESHOLD).length;
  const activePercent = (activeCount / gyroMags.length) * 100;

  // ----- 7. Duration -----
  const durationMs =
    filteredFrames.length > 1
      ? filteredFrames[filteredFrames.length - 1].timestamp -
        filteredFrames[0].timestamp
      : 0;

  // ----- 8. Thoracic compensation detection -----
  const compensation = computeCompensation(trunkInclinationsDeg);

  return {
    sagittal,
    frontal,
    transverse,
    masterSymmetry,
    activePercent,
    totalFrames: filteredFrames.length,
    durationMs,
    compensation,
    pipeline: pipelineInfo,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/** Round to 1 decimal place */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Symmetry ratio: (smaller / larger) * 100.  Returns 100 if both ≈ 0. */
function symRatio(a: number, b: number): number {
  const bigger = Math.max(Math.abs(a), Math.abs(b));
  if (bigger < 0.01) return 100;
  const smaller = Math.min(Math.abs(a), Math.abs(b));
  return (smaller / bigger) * 100;
}

/** Build PlaneRom with full directional breakdown and composite symmetry. */
function buildPlaneRom(
  degValues: number[],
  gyroMags: number[],
  dtMs: number[],
  label: string,
  negLabel: string,
  posLabel: string,
  normalMin: number,
  normalMax: number,
): PlaneRom {
  const minDeg = Math.min(...degValues);
  const maxDeg = Math.max(...degValues);
  const totalRomDeg = maxDeg - minDeg;
  const meanDeg = degValues.reduce((s, v) => s + v, 0) / degValues.length;

  // --- Histogram (1° bins spanning observed range padded to normal range) ---
  const histMin = Math.floor(Math.min(minDeg, normalMin)) - 1;
  const histMax = Math.ceil(Math.max(maxDeg, normalMax)) + 1;
  const binCount = histMax - histMin + 1;
  const bins: number[] = [];
  const counts: number[] = new Array(binCount).fill(0);

  for (let i = 0; i < binCount; i++) {
    bins.push(histMin + i);
  }
  for (const v of degValues) {
    const idx = Math.round(v - histMin);
    if (idx >= 0 && idx < binCount) counts[idx]++;
  }
  const maxCount = Math.max(...counts, 1);
  const density = counts.map((c) => c / maxCount);

  // --- Per-direction velocity & dwell breakdown ---
  // "Negative" = values < 0 (extension / left), "Positive" = values ≥ 0 (flexion / right)
  // Velocity is computed from frame-to-frame Euler diffs during active phases,
  // classified by direction of the *current* position.
  let negVelSum = 0,
    negVelCount = 0,
    negVelPeak = 0;
  let posVelSum = 0,
    posVelCount = 0,
    posVelPeak = 0;
  let negDwellFrames = 0,
    posDwellFrames = 0;
  let allVelSum = 0,
    allVelCount = 0;

  for (let i = 0; i < degValues.length; i++) {
    const v = degValues[i];
    if (v < 0) negDwellFrames++;
    else posDwellFrames++;

    if (i === 0 || dtMs[i] <= 0) continue;
    const isActive = gyroMags[i] > ACTIVE_GYRO_THRESHOLD;
    if (!isActive) continue;

    // Guard against near-zero dt (can happen with timestamp jitter)
    const dtSec = dtMs[i] / 1000;
    if (dtSec < 0.0005) continue; // skip sub-0.5ms intervals (>2000Hz is noise)

    const vel = Math.abs(degValues[i] - degValues[i - 1]) / dtSec;

    // Physiological sanity clamp: cervical angular velocity above ~1500°/s
    // is non-physiological (even whiplash peaks around 500-800°/s).
    // Values beyond this indicate timestamp or data artifacts.
    if (vel > 1500) continue;

    allVelSum += vel;
    allVelCount++;

    // Classify by which side of zero the head is currently on
    if (v < 0) {
      negVelSum += vel;
      negVelCount++;
      if (vel > negVelPeak) negVelPeak = vel;
    } else {
      posVelSum += vel;
      posVelCount++;
      if (vel > posVelPeak) posVelPeak = vel;
    }
  }

  const totalFrames = degValues.length || 1;
  const negAvgVel = negVelCount > 0 ? negVelSum / negVelCount : 0;
  const posAvgVel = posVelCount > 0 ? posVelSum / posVelCount : 0;
  const avgVelocityDegS = allVelCount > 0 ? allVelSum / allVelCount : 0;

  // --- Rep counting (excursion detection with hysteresis) ---
  let negReps = 0,
    posReps = 0;
  let repState: "neutral" | "neg" | "pos" = "neutral";
  for (const v of degValues) {
    switch (repState) {
      case "neutral":
        if (v < -REP_ENTRY_THRESHOLD) repState = "neg";
        else if (v > REP_ENTRY_THRESHOLD) repState = "pos";
        break;
      case "neg":
        if (Math.abs(v) < REP_EXIT_THRESHOLD) {
          negReps++;
          repState = "neutral";
        } else if (v > REP_ENTRY_THRESHOLD) {
          negReps++;
          repState = "pos";
        }
        break;
      case "pos":
        if (Math.abs(v) < REP_EXIT_THRESHOLD) {
          posReps++;
          repState = "neutral";
        } else if (v < -REP_ENTRY_THRESHOLD) {
          posReps++;
          repState = "neg";
        }
        break;
    }
  }

  const negRom = Math.abs(minDeg); // how far into negative direction
  const posRom = Math.abs(maxDeg); // how far into positive direction
  const normalNegRom = Math.abs(normalMin); // textbook norm for negative side
  const normalPosRom = Math.abs(normalMax); // textbook norm for positive side

  const neg: DirectionalMetrics = {
    rom: round1(negRom),
    normalRom: normalNegRom,
    pctOfNormal: round1(normalNegRom > 0 ? (negRom / normalNegRom) * 100 : 0),
    avgVelocityDegS: round1(negAvgVel),
    peakVelocityDegS: round1(negVelPeak),
    dwellPercent: round1((negDwellFrames / totalFrames) * 100),
    reps: negReps,
  };

  const pos: DirectionalMetrics = {
    rom: round1(posRom),
    normalRom: normalPosRom,
    pctOfNormal: round1(normalPosRom > 0 ? (posRom / normalPosRom) * 100 : 0),
    avgVelocityDegS: round1(posAvgVel),
    peakVelocityDegS: round1(posVelPeak),
    dwellPercent: round1((posDwellFrames / totalFrames) * 100),
    reps: posReps,
  };

  // --- Composite symmetry score ---
  // ROM symmetry:      (smaller ROM / larger ROM) * 100
  // Velocity symmetry: (smaller avgVel / larger avgVel) * 100
  // Composite:         60% ROM + 40% velocity  (Duc et al. 2014)
  const romSym = symRatio(negRom, posRom);
  const velSym = symRatio(negAvgVel, posAvgVel);
  const ROM_WEIGHT = 0.6;
  const VEL_WEIGHT = 0.4;
  const compositeScore = ROM_WEIGHT * romSym + VEL_WEIGHT * velSym;

  const symmetry: PlaneSymmetry = {
    romSymmetry: round1(romSym),
    velocitySymmetry: round1(velSym),
    compositeScore: round1(compositeScore),
  };

  return {
    label,
    negLabel,
    posLabel,
    minDeg: round1(minDeg),
    maxDeg: round1(maxDeg),
    totalRomDeg: round1(totalRomDeg),
    meanDeg: round1(meanDeg),
    histogram: { bins, density, peakDensity: 1.0 },
    normalMinDeg: normalMin,
    normalMaxDeg: normalMax,
    avgVelocityDegS: round1(avgVelocityDegS),
    neg,
    pos,
    symmetry,
  };
}

/**
 * Compute thoracic compensation metrics from trunk inclination data.
 *
 * When trunk inclination exceeds the threshold, the subject is likely leaning
 * their torso rather than isolating cervical motion — a compensation artifact
 * that inflates ROM values and reduces clinical validity.
 */
function computeCompensation(trunkInclinationsDeg: number[]): CompensationInfo {
  if (trunkInclinationsDeg.length === 0) {
    return {
      detected: false,
      meanTrunkInclinationDeg: 0,
      peakTrunkInclinationDeg: 0,
      compensationPercent: 0,
      thresholdDeg: COMPENSATION_THRESHOLD_DEG,
    };
  }

  const mean =
    trunkInclinationsDeg.reduce((s, v) => s + v, 0) /
    trunkInclinationsDeg.length;
  const peak = Math.max(...trunkInclinationsDeg);
  const compensatingFrames = trunkInclinationsDeg.filter(
    (v) => v > COMPENSATION_THRESHOLD_DEG,
  ).length;
  const compensationPercent =
    (compensatingFrames / trunkInclinationsDeg.length) * 100;

  return {
    detected: compensationPercent > 15, // >15% of time compensating = flagged
    meanTrunkInclinationDeg: round1(mean),
    peakTrunkInclinationDeg: round1(peak),
    compensationPercent: round1(compensationPercent),
    thresholdDeg: COMPENSATION_THRESHOLD_DEG,
  };
}

/** Compute per-frame dt in ms (first element = 0). */
function computeDtMs(frames: RecordedFrame[]): number[] {
  const dt: number[] = [0];
  for (let i = 1; i < frames.length; i++) {
    dt.push(Math.max(0, frames[i].timestamp - frames[i - 1].timestamp));
  }
  return dt;
}

/**
 * Spherical average of quaternions (iterative normalised mean).
 * Good enough for a small cluster of nearly-aligned orientations.
 */
function averageQuaternions(quats: THREE.Quaternion[]): THREE.Quaternion {
  if (quats.length === 0) return new THREE.Quaternion();
  if (quats.length === 1) return quats[0].clone();

  // Ensure consistent hemisphere (flip to match first)
  const ref = quats[0];
  const aligned = quats.map((q) => {
    if (q.dot(ref) < 0) {
      return new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w);
    }
    return q;
  });

  // Component-wise mean then normalise
  let sx = 0,
    sy = 0,
    sz = 0,
    sw = 0;
  for (const q of aligned) {
    sx += q.x;
    sy += q.y;
    sz += q.z;
    sw += q.w;
  }
  const n = aligned.length;
  const avg = new THREE.Quaternion(sx / n, sy / n, sz / n, sw / n);
  avg.normalize();
  return avg;
}
