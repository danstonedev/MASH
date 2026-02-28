/**
 * Calibration Step Configuration
 *
 * Pure, side-effect-free constants and lookup functions for the calibration
 * state machine. No class instances, no store imports — fully unit-testable.
 */

import * as THREE from "three";
import type { CalibrationStep } from "./calibrationTypes";
import { TopologyType } from "../biomech/topology/SensorRoles";

// ============================================================================
// STEP DURATIONS
// Research-backed durations (Xsens/Rokoko/Vicon reference):
//   - Static capture: 0.5–1s sufficient with stability detection
//   - Functional:     3–5 reps × 1s/rep = 3–5s per motion type
//   - Verification:   Quick ROM check, 3s is sufficient
// ============================================================================

export const STEP_DURATIONS: Record<CalibrationStep, number> = {
  idle: 0,
  "warm-up": 1.5, // gyro bias settles within 500ms, extra margin for filters
  "static-pose": 1, // matches industry standard (Xsens, Rokoko)
  "leg-left-functional": 8,
  "leg-right-functional": 8,
  "arm-left-functional": 7,
  "arm-right-functional": 7,
  "head-functional": 8,
  "ankle-flex": 3, // quick dorsi/plantar flex
  "hip-rotation": 3, // internal/external rotation
  "generic-flex": 3, // single joint flexion (early exit on 70% confidence)
  "final-pose": 1.5, // brief stability check
  verification: 3, // quick ROM check to validate calibration quality
  "pose-check": 10, // neutral standing trust check
  "squat-check": 8, // 3-5 controlled squat reps
  complete: 0,
  error: 0,
};

// ============================================================================
// EXTENSION BUDGETS
// ============================================================================

export const RESEARCH_FUNCTIONAL_EXTENSION_SECONDS = 3;
export const MAX_RESEARCH_FUNCTIONAL_EXTENSIONS = 2;
export const RESEARCH_FUNCTIONAL_MIN_SAMPLES = 90;

// ============================================================================
// FUNCTIONAL STEPS SET
// Steps during which movement data is collected and fed to SARA/SCoRE.
// ============================================================================

export const FUNCTIONAL_STEPS = new Set<CalibrationStep>([
  "ankle-flex",
  "hip-rotation",
  "generic-flex",
  "leg-left-functional",
  "leg-right-functional",
  "arm-left-functional",
  "arm-right-functional",
  "head-functional",
]);

// ============================================================================
// SEGMENT QUALITY GATES
// ============================================================================

export const RESEARCH_STRICT_CRITICAL_SEGMENTS = new Set<string>([
  "thigh_l",
  "thigh_r",
  "tibia_l",
  "tibia_r",
  "upper_arm_l",
  "upper_arm_r",
  "forearm_l",
  "forearm_r",
  "head",
]);

/** PCA confidence threshold for each segment class. */
export function getResearchStrictThreshold(segmentId: string): number {
  if (segmentId.startsWith("tibia_") || segmentId.startsWith("forearm_"))
    return 0.8;
  if (segmentId.startsWith("thigh_") || segmentId.startsWith("upper_arm_"))
    return 0.75;
  if (segmentId === "head") return 0.8;
  return 0.7;
}

// ============================================================================
// TIMELINE GATE TIERS (Phase 2 — dual-sensor temporal pairing quality)
// ============================================================================

export type TimelineGateTier = "green" | "yellow" | "red";

/** Max skew thresholds (ms) for dual-sensor timeline pairs */
export const TIMELINE_SKEW_TIERS = {
  green: 12,   // ≤12 ms: accept unconditionally
  yellow: 20,  // ≤20 ms: accept with downgraded trust
  // >20 ms: red — fail the dual-sensor step
} as const;

/** Dropped pair ratio thresholds */
export const TIMELINE_DROP_TIERS = {
  green: 0.05,  // ≤5%: accept
  yellow: 0.10, // ≤10%: accept with warning
  // >10%: red — fail
} as const;

/** Interpolation ratio thresholds */
export const TIMELINE_INTERP_TIERS = {
  green: 0.20,  // ≤20%: accept
  yellow: 0.35, // ≤35%: accept with warning
  // >35%: red — fail
} as const;

/**
 * Evaluate timeline diagnostics into a gate tier.
 * Returns the worst (most restrictive) tier across all three metrics.
 */
export function evaluateTimelineGateTier(
  maxSkewMs: number,
  droppedRatio: number,
  interpolationRatio: number,
): { tier: TimelineGateTier; reasons: string[] } {
  const reasons: string[] = [];
  let tier: TimelineGateTier = "green";

  // Skew
  if (maxSkewMs > TIMELINE_SKEW_TIERS.yellow) {
    tier = "red";
    reasons.push(`max skew ${maxSkewMs.toFixed(1)}ms > ${TIMELINE_SKEW_TIERS.yellow}ms`);
  } else if (maxSkewMs > TIMELINE_SKEW_TIERS.green) {
    if (tier !== "red") tier = "yellow";
    reasons.push(`max skew ${maxSkewMs.toFixed(1)}ms > ${TIMELINE_SKEW_TIERS.green}ms`);
  }

  // Dropped
  if (droppedRatio > TIMELINE_DROP_TIERS.yellow) {
    tier = "red";
    reasons.push(`dropped ratio ${(droppedRatio * 100).toFixed(1)}% > ${TIMELINE_DROP_TIERS.yellow * 100}%`);
  } else if (droppedRatio > TIMELINE_DROP_TIERS.green) {
    if (tier !== "red") tier = "yellow";
    reasons.push(`dropped ratio ${(droppedRatio * 100).toFixed(1)}% > ${TIMELINE_DROP_TIERS.green * 100}%`);
  }

  // Interpolation
  if (interpolationRatio > TIMELINE_INTERP_TIERS.yellow) {
    tier = "red";
    reasons.push(`interpolation ratio ${(interpolationRatio * 100).toFixed(1)}% > ${TIMELINE_INTERP_TIERS.yellow * 100}%`);
  } else if (interpolationRatio > TIMELINE_INTERP_TIERS.green) {
    if (tier !== "red") tier = "yellow";
    reasons.push(`interpolation ratio ${(interpolationRatio * 100).toFixed(1)}% > ${TIMELINE_INTERP_TIERS.green * 100}%`);
  }

  return { tier, reasons };
}

// ============================================================================
// TRUST LEVEL (Phase 2/3 — calibrated vs trusted)
// ============================================================================

/**
 * Trust is separate from calibration "quality". A calibration can complete
 * (all stages accepted) but may not yet be "trusted" until functional
 * post-cal checks confirm it generalises to movement.
 *
 * Levels:
 *  - high:   all joint gates PASS + pose-check PASS + squat-check PASS + timeline green
 *  - medium: gates pass + minor warnings (yellow timeline, warn functional checks)
 *  - low:    gates pass but functional checks failed or timeline red
 *  - none:   calibration itself failed / incomplete
 */
export type CalibrationTrustLevel = "high" | "medium" | "low" | "none";

export interface TrustAssessment {
  level: CalibrationTrustLevel;
  reasons: string[];
}

/**
 * Compute overall trust from calibration quality signals.
 */
export function assessCalibrationTrust(input: {
  gatesPassed: boolean;
  poseCheckStatus: "pass" | "warn" | "fail" | null;
  squatCheckStatus: "pass" | "warn" | "fail" | null;
  timelineTier: TimelineGateTier | null;
  overallQuality: number;
}): TrustAssessment {
  const { gatesPassed, poseCheckStatus, squatCheckStatus, timelineTier, overallQuality } = input;
  const reasons: string[] = [];

  if (!gatesPassed) {
    reasons.push("One or more joint quality gates failed");
    return { level: "none", reasons };
  }

  if (overallQuality < 30) {
    reasons.push(`Overall quality too low (${overallQuality.toFixed(0)}%)`);
    return { level: "none", reasons };
  }

  let level: CalibrationTrustLevel = "high";

  // Functional checks
  if (poseCheckStatus === "fail") {
    level = "low";
    reasons.push("Pose-check failed");
  } else if (poseCheckStatus === "warn" && level === "high") {
    level = "medium";
    reasons.push("Pose-check had warnings");
  } else if (poseCheckStatus === null && level === "high") {
    level = "medium";
    reasons.push("Pose-check was not run");
  }

  if (squatCheckStatus === "fail") {
    if (level !== "low") level = "low";
    reasons.push("Squat-check failed");
  } else if (squatCheckStatus === "warn" && level === "high") {
    level = "medium";
    reasons.push("Squat-check had warnings");
  } else if (squatCheckStatus === null && level === "high") {
    level = "medium";
    reasons.push("Squat-check was not run");
  }

  // Timeline
  if (timelineTier === "red") {
    if (level !== "low") level = "low";
    reasons.push("Timeline pairing quality was red");
  } else if (timelineTier === "yellow" && level === "high") {
    level = "medium";
    reasons.push("Timeline pairing quality was yellow");
  }

  if (reasons.length === 0) {
    reasons.push("All checks passed");
  }

  return { level, reasons };
}

// ============================================================================
// CALIBRATION VERSION TAG
// ============================================================================

/** Increment when calibration algorithm or threshold logic changes materially. */
export const CALIBRATION_VERSION = "2.1.0";

// ============================================================================
// STATIC CAPTURE RETRY GUIDANCE (segment-specific)
// ============================================================================

/** Segment-specific retry guidance when static capture fails. */
export function getStaticCaptureRetryHint(segment: string, failReason: string): string {
  const base = `Hold completely still for 1 second`;

  if (failReason.includes("gyro") || failReason.includes("movement")) {
    if (segment.includes("foot"))
      return `${base}. Make sure your foot is flat on the ground with no ankle wobble.`;
    if (segment.includes("hand"))
      return `${base}. Let your arms hang relaxed at your sides — no grip changes.`;
    if (segment.includes("head"))
      return `${base}. Fix your gaze on a point straight ahead and don't swallow.`;
    if (segment.includes("tibia") || segment.includes("thigh"))
      return `${base}. Lock your knees gently — don't shift weight between feet.`;
    return `${base}. Minimise all movement including breathing-related sway.`;
  }

  if (failReason.includes("gravity") || failReason.includes("accel")) {
    return `${base}. Ensure the sensor is firmly attached — loose mounting causes gravity mismatch.`;
  }

  if (failReason.includes("orientation") || failReason.includes("variance")) {
    return `${base}. If the sensor strap is loose, tighten it before retrying.`;
  }

  if (failReason.includes("insufficient")) {
    return `Wait a moment for sensor data to arrive, then retry. If this persists, check the sensor connection.`;
  }

  return `${base}. Stand in a neutral pose with arms at your sides and feet shoulder-width apart.`;
}

/** Human-readable retry coaching hint for a given segment. */
export function getResearchRetryCue(segmentId: string): string {
  if (segmentId.startsWith("tibia_")) {
    return "repeat with deeper, cleaner knee flexion while keeping hip/trunk stable";
  }
  if (segmentId.startsWith("thigh_")) {
    return "shift fully onto the opposite foot first, then swing the free leg through larger hip flex/ext arcs at controlled tempo";
  }
  if (segmentId.startsWith("forearm_")) {
    return "repeat with larger elbow flexion arc and less shoulder compensation";
  }
  if (segmentId.startsWith("upper_arm_")) {
    return "repeat with clear shoulder raise/lower cycles and minimal trunk sway";
  }
  if (segmentId === "head") {
    return "repeat with distinct nod and turn motions while shoulders stay still";
  }
  return "repeat with larger range of motion at controlled speed";
}

// ============================================================================
// STEP → TARGET SEGMENTS MAP
// ============================================================================

/**
 * Returns the segment IDs that are the primary calibration targets for a
 * given functional step. Used for extension decisions and live confidence UI.
 */
export function getFunctionalSegmentsForStep(step: CalibrationStep): string[] {
  switch (step) {
    case "leg-left-functional":
      return ["thigh_l", "tibia_l", "foot_l"];
    case "leg-right-functional":
      return ["thigh_r", "tibia_r", "foot_r"];
    case "arm-left-functional":
      return ["upper_arm_l", "forearm_l", "hand_l"];
    case "arm-right-functional":
      return ["upper_arm_r", "forearm_r", "hand_r"];
    case "head-functional":
      return ["head"];
    default:
      return [];
  }
}

// ============================================================================
// SWING WINDOW DETECTION
// ============================================================================

/**
 * Detect the stable single-leg-stance window within a functional motion capture,
 * trimming away the bilateral weight-shift transients at the start and end.
 *
 * Two signals are combined to gate the valid window:
 *   1. Gyro magnitude   (low = sensor not moving → stable stance or bilateral rest)
 *   2. Angular distance from bilateral-neutral start pose (elevated = weight shifted
 *      onto stance leg, NOT just standing still before the motion begins)
 *
 * This disambiguates:
 *   "quiet bilateral"  = low gyro + low dist   → EXCLUDE (pre-motion)
 *   "weight shifting"  = high gyro + rising dist → EXCLUDE (transient)
 *   "quiet unilateral" = low gyro + HIGH dist   → INCLUDE ← valid swing window
 *   "returning"        = high gyro + falling dist → EXCLUDE (transient)
 *
 * Falls back to a 20%/85% fixed head/tail trim if detection fails.
 *
 * @param referenceGyro  Gyro buffer for the reference sensor (pelvis preferred)
 * @param referenceQuat  Quat buffer for the reference sensor (same length as gyro)
 * @param startQuat      Captured bilateral-neutral quat for this sensor
 */
export function findStableSwingWindow(
  referenceGyro: THREE.Vector3[],
  referenceQuat: THREE.Quaternion[],
  startQuat: THREE.Quaternion,
  opts: { smoothHalf?: number; gyroThresh?: number; minRun?: number } = {},
): { startIdx: number; endIdx: number } {
  const { smoothHalf = 12, gyroThresh = 0.3, minRun = 5 } = opts;
  const n = referenceGyro.length;
  const fallback = {
    startIdx: Math.floor(n * 0.2),
    endIdx: Math.floor(n * 0.85),
  };
  if (n < 50 || referenceQuat.length !== n) return fallback;

  // 1. Smoothed gyro magnitude ──────────────────────────────────────────────
  const mags = referenceGyro.map((v) => v.length());
  const smooth = mags.map((_, i) => {
    const lo = Math.max(0, i - smoothHalf);
    const hi = Math.min(n - 1, i + smoothHalf);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += mags[j];
    return s / (hi - lo + 1);
  });

  // 2. Angular distance from bilateral-neutral start pose ───────────────────
  const dist = referenceQuat.map((q) => q.angleTo(startQuat) * (180 / Math.PI));
  const peakDist = dist.reduce((a, b) => Math.max(a, b), 0);
  // Lowered from 30%/3° to accommodate Trendelenburg-negative subjects.
  const distThresh = Math.max(peakDist * 0.2, 1.5);

  // 3. Onset: first run of minRun frames that are quiet AND displaced ────────
  let runLen = 0;
  let startIdx = fallback.startIdx;
  let foundStart = false;
  for (let i = Math.floor(n * 0.05); i < n - minRun; i++) {
    if (smooth[i] < gyroThresh && dist[i] > distThresh) {
      if (++runLen >= minRun) {
        startIdx = i - minRun + 1;
        foundStart = true;
        break;
      }
    } else {
      runLen = 0;
    }
  }

  // 4. Offset: last such run scanning backwards ─────────────────────────────
  runLen = 0;
  let endIdx = fallback.endIdx;
  let foundEnd = false;
  for (let i = Math.floor(n * 0.95); i > startIdx + minRun; i--) {
    if (smooth[i] < gyroThresh && dist[i] > distThresh) {
      if (++runLen >= minRun) {
        endIdx = i + minRun - 1;
        foundEnd = true;
        break;
      }
    } else {
      runLen = 0;
    }
  }

  if (!foundStart || !foundEnd || endIdx - startIdx < 30) return fallback;
  return { startIdx, endIdx };
}

// ============================================================================
// STEP FLOWS (per topology)
// ============================================================================

export const RESEARCH_STRICT_FULL_BODY_FLOW: CalibrationStep[] = [
  "warm-up",
  "static-pose",
  "leg-left-functional",
  "leg-right-functional",
  "arm-left-functional",
  "arm-right-functional",
  "head-functional",
  "final-pose",
  "verification",
  "pose-check",
  "squat-check",
  "complete",
];

export const RESEARCH_STRICT_FLOWS: Record<TopologyType, CalibrationStep[]> = {
  [TopologyType.SINGLE_SENSOR]: [
    "warm-up",
    "static-pose",
    "generic-flex",
    "final-pose",
    "verification",
    "pose-check",
    "squat-check",
    "complete",
  ],
  [TopologyType.SPARSE_LEG]: [
    "warm-up",
    "static-pose",
    "leg-left-functional",
    "leg-right-functional",
    "final-pose",
    "verification",
    "pose-check",
    "squat-check",
    "complete",
  ],
  [TopologyType.FULL_LEG]: [
    "warm-up",
    "static-pose",
    "leg-left-functional",
    "leg-right-functional",
    "final-pose",
    "verification",
    "pose-check",
    "squat-check",
    "complete",
  ],
  [TopologyType.DUAL_SKATE]: [
    "warm-up",
    "static-pose",
    "ankle-flex",
    "final-pose",
    "verification",
    "pose-check",
    "squat-check",
    "complete",
  ],
  [TopologyType.CORE]: [
    "warm-up",
    "static-pose",
    "hip-rotation",
    "final-pose",
    "verification",
    "pose-check",
    "squat-check",
    "complete",
  ],
  [TopologyType.SPARSE_ARM]: [
    "warm-up",
    "static-pose",
    "arm-left-functional",
    "arm-right-functional",
    "final-pose",
    "verification",
    "pose-check",
    "squat-check",
    "complete",
  ],
  [TopologyType.SPARSE_BODY]: RESEARCH_STRICT_FULL_BODY_FLOW,
  [TopologyType.FULL_BODY]: RESEARCH_STRICT_FULL_BODY_FLOW,
  [TopologyType.CUSTOM]: [
    "warm-up",
    "static-pose",
    "generic-flex",
    "final-pose",
    "verification",
    "pose-check",
    "squat-check",
    "complete",
  ],
};
