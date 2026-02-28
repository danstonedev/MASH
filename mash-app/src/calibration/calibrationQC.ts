/**
 * calibrationQC.ts
 *
 * Quality control, gating, and reporting functions extracted from the
 * UnifiedCalibration orchestrator. Handles per-joint quality gates,
 * retry summaries, QC artifact generation, and Markdown reporting.
 *
 * All functions are stateless: they take explicit inputs and return results.
 * The orchestrator class is responsible for supplying state and applying
 * return values to its own state fields.
 */

import type {
  CalibrationResult,
  JointGateResult,
  GateStatus,
  CalibrationQcArtifact,
  CalibrationTelemetry,
  FunctionalCheckResult,
} from "./UnifiedCalibration";
import type { CalibrationStep } from "./calibrationTypes";
import type { ValidationResult } from "./CalibrationValidator";
import {
  RESEARCH_STRICT_CRITICAL_SEGMENTS,
  getResearchStrictThreshold,
  getResearchRetryCue,
  evaluateTimelineGateTier,
  assessCalibrationTrust,
  CALIBRATION_VERSION,
} from "./calibrationStepConfig";
import type { TimelineAlignmentDiagnostics } from "./SensorRingBuffers";

// ============================================================================
// STRICT QUALITY GATES
// ============================================================================

export interface StrictGateInput {
  results: Map<string, CalibrationResult>;
  verificationData: Map<string, { maxAngle: number; smoothness: number }>;
}

export interface StrictGateOutput {
  jointGateResults: Map<string, JointGateResult>;
  criticalJointFailures: string[];
  passed: boolean;
}

/**
 * Evaluate per-joint calibration quality gates.
 *
 * For each critical segment, checks:
 *   - PCA/SARA confidence against the segment-specific threshold
 *   - Verification movement (>5° ROM, smoothness ≤5°/frame)
 *   - Bypasses movement gate for pca-refined segments where motion was already
 *     proven during the functional data collection step
 */
export function evaluateStrictGates(input: StrictGateInput): StrictGateOutput {
  const { results, verificationData } = input;
  const jointGateResults = new Map<string, JointGateResult>();
  const criticalJointFailures: string[] = [];

  for (const [segmentId, result] of results.entries()) {
    if (!RESEARCH_STRICT_CRITICAL_SEGMENTS.has(segmentId)) continue;

    const threshold = getResearchStrictThreshold(segmentId);
    const confidence =
      result.method === "sara-refined"
        ? (result.saraResult?.confidence ?? null)
        : (result.pcaConfidence ?? null);

    const movement = verificationData.get(segmentId);
    const hasMovement = movement ? movement.maxAngle >= 5 : false;
    const smoothEnough = movement ? movement.smoothness <= 5 : false;

    // For pca-refined segments, motion was already proven during the functional
    // data collection step (that data is the direct input to PCA). Requiring
    // additional movement during the 3s verification window is redundant and
    // causes false failures if the subject stands still watching their avatar.
    // Only apply movement/smoothness gates to static-pose-only calibrations.
    const motionAlreadyProven =
      result.method === "pca-refined" &&
      confidence !== null &&
      confidence >= threshold;

    let status: GateStatus = "PASS";
    let reason: string | null = null;

    if (confidence === null) {
      status = "RETRY_REQUIRED";
      reason =
        "We could not confirm clean movement quality for this segment. Try this now: repeat the motion with a larger, steadier range.";
    } else if (confidence < threshold) {
      status = "RETRY_REQUIRED";
      reason = `Movement quality was too low (${confidence.toFixed(2)} vs ${threshold.toFixed(2)} target). Try this now: ${getResearchRetryCue(segmentId)}.`;
    } else if (!motionAlreadyProven && !hasMovement) {
      status = "RETRY_REQUIRED";
      reason =
        "Not enough movement was detected during verification. Try this now: perform 3-5 larger reps for this body region.";
    } else if (!motionAlreadyProven && !smoothEnough) {
      status = "RETRY_REQUIRED";
      reason =
        "Movement was too jittery to trust. Try this now: slow down and keep the motion smooth and controlled.";
    }

    // When pca-refined motion gate is bypassed on a PASS, record why so the
    // QC artifact is self-documenting rather than silently omitting the field.
    if (status === "PASS" && motionAlreadyProven) {
      reason = `movement gate bypassed: pca-refined conf=${confidence?.toFixed(3)} (motion proven during functional step)`;
    }

    jointGateResults.set(segmentId, {
      segmentId,
      status,
      method: result.method,
      confidence,
      threshold,
      reason,
    });

    if (status !== "PASS") {
      criticalJointFailures.push(segmentId);
    }
  }

  if (criticalJointFailures.length > 0) {
    console.warn(
      `[ResearchStrict] Critical joint gate failures: ${criticalJointFailures.join(", ")}`,
    );
  }

  return {
    jointGateResults,
    criticalJointFailures,
    passed: criticalJointFailures.length === 0,
  };
}

// ============================================================================
// RETRY SUMMARY
// ============================================================================

/**
 * Build a human-readable summary of which segments failed quality gates.
 * Used in the error message presented to the operator.
 */
export function buildStrictRetrySummary(
  jointGateResults: Map<string, JointGateResult>,
  criticalJointFailures: string[],
  maxItems = 4,
): string {
  const failures = Array.from(jointGateResults.values()).filter(
    (gate) => gate.status === "RETRY_REQUIRED",
  );

  if (failures.length === 0) {
    return criticalJointFailures.join(", ") || "unknown segment(s)";
  }

  const lines = failures
    .slice(0, maxItems)
    .map(
      (failure) =>
        `${failure.segmentId} (${failure.reason ?? "quality gate failed"})`,
    );

  const hiddenCount = failures.length - lines.length;
  return hiddenCount > 0
    ? `${lines.join("; ")}; +${hiddenCount} more`
    : lines.join("; ");
}

// ============================================================================
// QC ARTIFACT GENERATION
// ============================================================================

export interface QcArtifactInput {
  step: CalibrationStep;
  overallQuality: number;
  error: string | null;
  results: Map<string, CalibrationResult>;
  jointGateResults: Map<string, JointGateResult>;
  criticalJointFailures: string[];
  validationResult: ValidationResult | null;
  functionalChecks: Map<"pose-check" | "squat-check", FunctionalCheckResult>;
  auditLog: {
    timestamp: string;
    step: string;
    message: string;
    data?: any;
  }[];
  timelineDiagnostics?: TimelineAlignmentDiagnostics;
  telemetry: CalibrationTelemetry;
}

/**
 * Build a structured QC artifact from the current calibration state.
 * This artifact is designed to be JSON-serializable for archival and review.
 */
export function buildCalibrationQcArtifact(
  input: QcArtifactInput,
): CalibrationQcArtifact {
  const jointGates = Array.from(input.jointGateResults.values());
  const segmentResults = Array.from(input.results.values()).map((result) => ({
    segmentId: result.segmentId,
    quality: result.quality,
    method: result.method,
    pcaConfidence: result.pcaConfidence ?? null,
    saraConfidence: result.saraResult?.confidence ?? null,
  }));
  const functionalChecks = Array.from(input.functionalChecks.values());

  const passed =
    input.step !== "error" &&
    input.criticalJointFailures.length === 0 &&
    jointGates.every((gate) => gate.status === "PASS");

  // --- Timeline with tier evaluation ---
  const timeline = input.timelineDiagnostics
    ? (() => {
        const totalPairs = input.timelineDiagnostics.totalPairs;
        const interpolationRatio =
          totalPairs > 0
            ? input.timelineDiagnostics.interpolatedPairs / totalPairs
            : 0;
        const droppedRatio =
          totalPairs + input.timelineDiagnostics.droppedPairs > 0
            ? input.timelineDiagnostics.droppedPairs /
              (totalPairs + input.timelineDiagnostics.droppedPairs)
            : 0;

        // Evaluate timeline quality tier
        const { tier, reasons: tierReasons } = evaluateTimelineGateTier({
          maxSkewMs: input.timelineDiagnostics.maxSkewMs,
          droppedRatio,
          interpolationRatio,
        });

        const warnings: string[] = [];
        if (interpolationRatio > 0.35) {
          warnings.push(
            `Sensor timing drift was high (${(interpolationRatio * 100).toFixed(1)}% repaired samples). Try this now: keep sensors within range, reduce USB/Bluetooth load, and run calibration again.`,
          );
        }
        if (input.timelineDiagnostics.maxSkewMs > 15) {
          warnings.push(
            `Sensor frames arrived too far apart (max ${input.timelineDiagnostics.maxSkewMs.toFixed(2)}ms). Try this now: pause other heavy apps and repeat the movement step at a steady pace.`,
          );
        }
        if (droppedRatio > 0.25) {
          warnings.push(
            `Too many paired samples were dropped (${(droppedRatio * 100).toFixed(1)}%). Try this now: reconnect unstable sensors and rerun only the failed calibration region.`,
          );
        }

        return {
          ...input.timelineDiagnostics,
          interpolationRatio,
          droppedRatio,
          tier,
          tierReasons,
          warnings,
        };
      })()
    : null;

  // --- Trust assessment ---
  const poseCheck = input.functionalChecks.get("pose-check");
  const squatCheck = input.functionalChecks.get("squat-check");
  const trust = assessCalibrationTrust({
    gatesPassed: passed,
    poseCheckStatus: poseCheck?.status ?? null,
    squatCheckStatus: squatCheck?.status ?? null,
    timelineTier: timeline?.tier ?? "green",
    overallQuality: input.overallQuality,
  });

  return {
    calibrationVersion: CALIBRATION_VERSION,
    generatedAt: new Date().toISOString(),
    mode: "research_strict",
    finalStep: input.step,
    overallQuality: input.overallQuality,
    passed,
    trustLevel: trust.level,
    trustReasons: trust.reasons,
    error: input.error,
    criticalJointFailures: [...input.criticalJointFailures],
    jointGates,
    segmentResults,
    validation: {
      isValid: input.validationResult?.isValid ?? null,
      summary: input.validationResult?.summary ?? null,
      recommendationCount: input.validationResult?.recommendations.length ?? 0,
    },
    functionalChecks,
    timeline,
    telemetry: input.telemetry,
    auditLog: input.auditLog.map((entry) => ({ ...entry })),
  };
}

// ============================================================================
// QC MARKDOWN REPORT
// ============================================================================

/**
 * Generate a human-readable Markdown report from a QC artifact.
 */
export function buildCalibrationQcMarkdown(
  artifact: CalibrationQcArtifact,
): string {
  const gateLines =
    artifact.jointGates.length === 0
      ? ["- No joint gates recorded"]
      : artifact.jointGates.map((gate) => {
          const confidenceText =
            gate.confidence === null ? "n/a" : gate.confidence.toFixed(2);
          const reasonText = gate.reason ?? "none";
          return `- ${gate.segmentId}: ${gate.status} (method=${gate.method}, confidence=${confidenceText}, threshold=${gate.threshold.toFixed(2)}, reason=${reasonText})`;
        });

  const segmentLines =
    artifact.segmentResults.length === 0
      ? ["- No segment results recorded"]
      : artifact.segmentResults.map(
          (segment) =>
            `- ${segment.segmentId}: quality=${segment.quality.toFixed(1)}%, method=${segment.method}, pca=${segment.pcaConfidence ?? "n/a"}, sara=${segment.saraConfidence ?? "n/a"}`,
        );

  // --- Trust summary ---
  const trustLines = [
    `- Level: **${artifact.trustLevel.toUpperCase()}**`,
    ...(artifact.trustReasons.length > 0
      ? artifact.trustReasons.map((r) => `  - ${r}`)
      : ["  - all checks passed"]),
  ];

  // --- Telemetry summary ---
  const tel = artifact.telemetry;
  const preflightEntries = Object.entries(tel.preflightFailures);
  const stageRetryEntries = Object.entries(tel.stageRetries);
  const funcExtEntries = Object.entries(tel.functionalExtensions);
  const telemetryLines = [
    `- Duration: ${(tel.durationMs / 1000).toFixed(1)}s`,
    `- Static capture: ${tel.staticCaptureSuccesses}/${tel.staticCaptureAttempts} attempts succeeded`,
    `- Timeline: interpolation=${(tel.timelineInterpolationRatio * 100).toFixed(1)}%, dropped=${(tel.timelineDroppedRatio * 100).toFixed(1)}%, maxSkew=${tel.timelineMaxSkewMs.toFixed(1)}ms`,
    preflightEntries.length > 0
      ? `- Preflight failures: ${preflightEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
      : "- Preflight failures: none",
    stageRetryEntries.length > 0
      ? `- Stage retries: ${stageRetryEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
      : "- Stage retries: none",
    funcExtEntries.length > 0
      ? `- Functional extensions: ${funcExtEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
      : "- Functional extensions: none",
  ];

  // --- Timeline with tier ---
  const timelineSection = artifact.timeline
    ? [
        `- totalPairs: ${artifact.timeline.totalPairs}`,
        `- interpolatedPairs: ${artifact.timeline.interpolatedPairs}`,
        `- droppedPairs: ${artifact.timeline.droppedPairs}`,
        `- averageSkewMs: ${artifact.timeline.averageSkewMs.toFixed(2)}`,
        `- maxSkewMs: ${artifact.timeline.maxSkewMs.toFixed(2)}`,
        `- interpolationRatio: ${(artifact.timeline.interpolationRatio * 100).toFixed(1)}%`,
        `- droppedRatio: ${(artifact.timeline.droppedRatio * 100).toFixed(1)}%`,
        `- tier: **${artifact.timeline.tier.toUpperCase()}**`,
        artifact.timeline.tierReasons.length > 0
          ? `- tierReasons:\n${artifact.timeline.tierReasons.map((r) => `  - ${r}`).join("\n")}`
          : "- tierReasons: none",
        artifact.timeline.warnings.length > 0
          ? `- warnings:\n${artifact.timeline.warnings.map((w) => `  - ${w}`).join("\n")}`
          : "- warnings: none",
      ].join("\n")
    : "- Timeline diagnostics not available";

  return [
    "# Calibration QC Artifact",
    "",
    `- Calibration Version: ${artifact.calibrationVersion}`,
    `- Generated: ${artifact.generatedAt}`,
    `- Mode: ${artifact.mode}`,
    `- Final Step: ${artifact.finalStep}`,
    `- Overall Quality: ${artifact.overallQuality.toFixed(1)}%`,
    `- Passed: ${artifact.passed ? "YES" : "NO"}`,
    `- Error: ${artifact.error ?? "none"}`,
    "",
    "## Trust Assessment",
    ...trustLines,
    "",
    "## Critical Joint Failures",
    artifact.criticalJointFailures.length > 0
      ? artifact.criticalJointFailures
          .map((segment) => `- ${segment}`)
          .join("\n")
      : "- None",
    "",
    "## Joint Gate Results",
    ...gateLines,
    "",
    "## Segment Results",
    ...segmentLines,
    "",
    "## Validation",
    `- isValid: ${artifact.validation.isValid === null ? "n/a" : artifact.validation.isValid ? "true" : "false"}`,
    `- summary: ${artifact.validation.summary ?? "n/a"}`,
    `- recommendationCount: ${artifact.validation.recommendationCount}`,
    "",
    "## Functional Checks",
    artifact.functionalChecks.length > 0
      ? artifact.functionalChecks
          .map((check) => {
            const metrics = Object.entries(check.metrics)
              .map(([key, value]) => `${key}=${Number.isFinite(value) ? value.toFixed(3) : value}`)
              .join(", ");
            const regions = check.failedRegions?.length
              ? ` | failedRegions: ${check.failedRegions.join(", ")}`
              : "";
            return `- ${check.check}: ${check.status.toUpperCase()} (${check.summary})${metrics ? ` [${metrics}]` : ""}${regions}${check.recommendation ? ` | recommendation: ${check.recommendation}` : ""}`;
          })
          .join("\n")
      : "- No functional checks recorded",
    "",
    "## Timeline Diagnostics",
    timelineSection,
    "",
    "## Telemetry",
    ...telemetryLines,
  ].join("\n");
}
