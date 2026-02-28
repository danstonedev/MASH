/**
 * Unified Calibration System
 *
 * A single, intelligent calibration flow that:
 * 1. Uses stability detection for reliable captures
 * 2. Applies PCA for functional axis discovery
 * 3. Uses SARA for dual-sensor hinge axis detection
 * 4. Continuously improves during runtime
 *
 * Flow: Static Pose Ã¢â€ â€™ Walk Ã¢â€ â€™ Knee Bend Ã¢â€ â€™ Arm Swing Ã¢â€ â€™ Final Pose
 */

import * as THREE from "three";
import {
  useDeviceRegistry,
  type DeviceData,
  deviceQuaternionCache,
  deviceGyroCache,
  deviceAccelCache,
} from "../store/useDeviceRegistry";
import { estimateFunctionalAxis } from "./calibrationMath";

import { TopologyType } from "../biomech/topology/SensorRoles";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";
import type { ValidationResult } from "./CalibrationValidator";

// Import what's used locally
import { averageQuaternions } from "./stability";

// SARA: Dual-sensor hinge axis detection
import {
  SARACalibrator,
  SCoRECalibrator,
  findCalibrableJoints,
  type SARAResult,
  type SCoREResult,
  type JointPairDefinition,
} from "./ScoreAnalysis";

import type { CalibrationStep, CalibrationMode } from "./calibrationTypes";
import {
  STEP_DURATIONS,
  FUNCTIONAL_STEPS,
  RESEARCH_FUNCTIONAL_EXTENSION_SECONDS,
  MAX_RESEARCH_FUNCTIONAL_EXTENSIONS,
  RESEARCH_FUNCTIONAL_MIN_SAMPLES,
  RESEARCH_STRICT_CRITICAL_SEGMENTS,
  getResearchStrictThreshold,
  getFunctionalSegmentsForStep,
  findStableSwingWindow,
  RESEARCH_STRICT_FULL_BODY_FLOW,
  RESEARCH_STRICT_FLOWS,
  evaluateTimelineGateTier,
  assessCalibrationTrust,
  getStaticCaptureRetryHint,
  CALIBRATION_VERSION,
  type TimelineGateTier,
  type CalibrationTrustLevel,
} from "./calibrationStepConfig";
import {
  SensorRingBuffers,
  buildSegmentToDeviceMap,
  type TimelineAlignmentDiagnostics,
} from "./SensorRingBuffers";
import {
  computeSegmentCalibration,
  checkKneeConsistency,
  computeSARAConstraints,
  runPostCalibrationValidation,
} from "./calibrationComputation";
import {
  evaluateStrictGates,
  buildStrictRetrySummary,
  buildCalibrationQcArtifact,
  buildCalibrationQcMarkdown,
} from "./calibrationQC";

const FULL_BODY_REQUIRED_SEGMENTS = [
  "pelvis",
  "torso",
  "head",
  "thigh_l",
  "tibia_l",
  "foot_l",
  "thigh_r",
  "tibia_r",
  "foot_r",
  "upper_arm_l",
  "forearm_l",
  "hand_l",
  "upper_arm_r",
  "forearm_r",
  "hand_r",
] as const;

const STATIC_CAPTURE_WINDOW_FRAMES = 48;
const STATIC_CAPTURE_MIN_FRAMES = 30;
const STATIC_CAPTURE_MAX_GYRO_MEAN = 0.12;
const STATIC_CAPTURE_MAX_QUAT_VARIANCE = 0.0015;
const STATIC_CAPTURE_MAX_ACCEL_STD = 0.35;
const STATIC_CAPTURE_MIN_ACCEL_MEAN = 8.0;
const STATIC_CAPTURE_MAX_ACCEL_MEAN = 11.6;

// Re-export for backward compatibility
export {
  checkStability,
  averageQuaternions,
  type StabilityResult,
} from "./stability";
export { extractYawQuaternion, removeYaw } from "./heading";
export { ANATOMICAL_AXES, type PCAWindowResult } from "./pcaRefinement";
export {
  RESEARCH_STRICT_FULL_BODY_FLOW,
  RESEARCH_STRICT_FLOWS,
} from "./calibrationStepConfig";

// ============================================================================
// TYPES
// ============================================================================

// CalibrationStep and CalibrationMode are defined in calibrationTypes.ts and
// imported above; re-export here for backward compatibility.
export type { CalibrationStep, CalibrationMode };

// StabilityResult and PCAWindowResult are imported from ./stability and ./pcaRefinement

export interface CalibrationResult {
  segmentId: string;
  /** Primary calibration offset Ã¢â‚¬â€ the GramSchmidt mountingTare (sensorÃ¢â€ â€™bone rotation from motion geometry). */
  offset: THREE.Quaternion;
  /** Two-layer arch: sensor-to-bone rotation derived from motion geometry (GramSchmidt). */
  mountingTare?: THREE.Quaternion;
  /** Two-layer arch: world-space zero reference = captureQuat Ãƒâ€” mountingTare. */
  headingTare?: THREE.Quaternion;
  quality: number;
  method: "pose" | "pca-refined" | "sara-refined" | "gravity-only";
  pcaConfidence?: number;
  /** SARA hinge axis result (for joints like knee, elbow) */
  saraResult?: SARAResult;
  /** SCoRE joint center result (for auto-scaling) */
  scoreResult?: SCoREResult;
  /** Detected drift magnitude (rad/s) */
  drift?: number;
  /** GS path: how well gravity maps to bone -Y after mountingTare (0-100) */
  gravityAlignmentPct?: number;
  /** GS path: how well PCA axis maps to anatomical axis after mountingTare (0-100) */
  axisAlignmentPct?: number;
  timestamp: number;
}

/**
 * SARA joint constraint result for hinge joints.
 */
export interface JointConstraintResult {
  jointId: string;
  jointType: "hinge" | "ball";
  /** Hinge axis in world frame (for hinge joints) */
  hingeAxisWorld?: THREE.Vector3;
  /** Hinge axis in proximal segment local frame */
  hingeAxisProximal?: THREE.Vector3;
  /** Hinge axis in distal segment local frame */
  hingeAxisDistal?: THREE.Vector3;
  /** Confidence from SARA (0-1) */
  confidence: number;
}

export type GateStatus = "PASS" | "RETRY_REQUIRED";

export interface JointGateResult {
  segmentId: string;
  status: GateStatus;
  method: CalibrationResult["method"];
  confidence: number | null;
  threshold: number;
  reason: string | null;
}

export interface FunctionalCheckResult {
  check: "pose-check" | "squat-check";
  status: "pass" | "warn" | "fail";
  summary: string;
  metrics: Record<string, number>;
  recommendation?: string;
  failedRegions?: Array<"legs" | "arms" | "head" | "core">;
}

export interface CalibrationQcArtifact {
  calibrationVersion: string;
  generatedAt: string;
  mode: CalibrationMode;
  finalStep: CalibrationStep;
  overallQuality: number;
  passed: boolean;
  trustLevel: import("./calibrationStepConfig").CalibrationTrustLevel;
  trustReasons: string[];
  error: string | null;
  criticalJointFailures: string[];
  jointGates: JointGateResult[];
  segmentResults: Array<{
    segmentId: string;
    quality: number;
    method: CalibrationResult["method"];
    pcaConfidence: number | null;
    saraConfidence: number | null;
  }>;
  validation: {
    isValid: boolean | null;
    summary: string | null;
    recommendationCount: number;
  };
  functionalChecks: FunctionalCheckResult[];
  timeline:
    | (TimelineAlignmentDiagnostics & {
        interpolationRatio: number;
        droppedRatio: number;
        tier: import("./calibrationStepConfig").TimelineGateTier;
        tierReasons: string[];
        warnings: string[];
      })
    | null;
  telemetry: CalibrationTelemetry;
  auditLog: { timestamp: string; step: string; message: string; data?: any }[];
}

/** Structured per-run telemetry counters (Phase 0 from the fit-it plan) */
export interface CalibrationTelemetry {
  preflightFailures: Record<string, number>;  // reason → count
  stageRetries: Record<string, number>;       // step → retry count
  timelineInterpolationRatio: number;
  timelineDroppedRatio: number;
  timelineMaxSkewMs: number;
  staticCaptureAttempts: number;
  staticCaptureSuccesses: number;
  functionalExtensions: Record<string, number>; // step → extension count
  durationMs: number;                           // total calibration wall-clock time
}

export interface UnifiedCalibrationState {
  step: CalibrationStep;
  progress: number; // 0-100 overall progress
  stepProgress: number; // 0-100 within current step
  countdown: number; // Seconds remaining in current step

  // Live PCA confidence feedback
  autoPcaConfidence: number; // Average PCA confidence (0-1)
  liveFunctionalConfidence: Map<
    string,
    { confidence: number; target: number; sampleCount: number }
  >;

  // Captured data
  staticPoseData: Map<string, THREE.Quaternion> | null;
  finalPoseData: Map<string, THREE.Quaternion> | null; // Sandwich calibration end-pose

  functionalMotionData: Map<string, THREE.Vector3[]> | null;

  // Validation
  driftMetrics: Map<string, number>; // Captured gyro magnitude during static pose
  gyroBiasEstimates: Map<string, { x: number; y: number; z: number }>; // Per-device gyro bias from static pose

  // Results
  results: Map<string, CalibrationResult>;
  overallQuality: number;
  // Map of joint ID to SCoRE result (joint center)
  scoreResults: Map<string, SCoREResult>;

  // SARA Joint Constraints (hinge axes for knee, elbow, etc.)
  jointConstraints: Map<string, JointConstraintResult>;

  // IK Validation (post-calibration quality check)
  validationResult: ValidationResult | null;

  // Post-calibration functional checks
  functionalChecks: Map<"pose-check" | "squat-check", FunctionalCheckResult>;

  // Research strict gating
  jointGateResults: Map<string, JointGateResult>;
  criticalJointFailures: string[];

  // Errors
  error: string | null;
}

// ============================================================================
// UNIFIED CALIBRATION ORCHESTRATOR
// ============================================================================

export class UnifiedCalibration {
  private state: UnifiedCalibrationState;
  // Expose current flow so UI can render the correct steps
  public currentFlow: CalibrationStep[] = RESEARCH_STRICT_FULL_BODY_FLOW;

  /** Encapsulated ring buffers for all four sensor channels (gyro/accel/quat/time). */
  private readonly buffers = new SensorRingBuffers();
  private stepStartTime: number = 0;
  private onStateChange?: (state: UnifiedCalibrationState) => void;
  private targetNeutralPose: Map<string, THREE.Quaternion> | null = null;

  /**
   * Set the target neutral pose (from 3D Model Bind Pose).
   * Must be called before calibration starts to ensure accuracy.
   */
  public setTargetNeutralPose(pose: Map<string, THREE.Quaternion>): void {
    this.targetNeutralPose = pose;
    console.debug(
      `[UnifiedCal] Target neutral pose updated with ${pose.size} segments`,
    );
  }
  private pcaConfidences: Map<string, number> = new Map(); // Per-segment PCA confidence
  private verificationMovementLogged: boolean = false; // Track if we've logged good movement
  private functionalStepExtensions: Map<CalibrationStep, number> = new Map();

  // SARA: Dual-sensor hinge axis calibrators
  private saraCalibrators: Map<string, SARACalibrator> = new Map();
  // SCoRE: Dual-sensor joint center calibrators
  private scoreCalibrators: Map<string, SCoRECalibrator> = new Map();
  private calibrableJoints: JointPairDefinition[] = [];
  // Device IDs that were connected AND assigned when calibration started.
  // Only these are checked for mid-calibration disconnects (avoids false
  // failures from stale persisted assignments for devices not in this session).
  private connectedAtStart: Set<string> = new Set();

  // ---- Telemetry tracking (Phase 0) ----
  private calibrationStartMs = 0;
  private staticCaptureAttempts = 0;
  private staticCaptureSuccesses = 0;
  private preflightFailures: Record<string, number> = {};
  private stageRetries: Record<string, number> = {};
  /** Per-step counter: how many times we retried a functional step due to red timeline */
  private timelineRedRetries: Record<string, number> = {};
  private static readonly MAX_TIMELINE_RED_RETRIES = 2;

  constructor() {
    this.state = this.getInitialState();
  }

  private getInitialState(): UnifiedCalibrationState {
    return {
      step: "idle",
      progress: 0,
      stepProgress: 0,
      countdown: 0,
      autoPcaConfidence: 0,
      liveFunctionalConfidence: new Map(),
      staticPoseData: null,
      finalPoseData: null,

      functionalMotionData: null,
      driftMetrics: new Map(),
      gyroBiasEstimates: new Map(),
      results: new Map(),
      overallQuality: 0,
      scoreResults: new Map(),
      jointConstraints: new Map(), // SARA joint constraints
      validationResult: null,
      functionalChecks: new Map(),
      jointGateResults: new Map(),
      criticalJointFailures: [],
      error: null,
    };
  }

  // =========================================================================
  // AUDIT LOGGING SYSTEM
  // =========================================================================
  private auditLog: {
    timestamp: string;
    step: string;
    message: string;
    data?: any;
  }[] = [];

  private logAudit(step: string, message: string, data?: any) {
    const entry = {
      timestamp: new Date().toISOString().split("T")[1].slice(0, 8),
      step,
      message,
      data,
    };
    this.auditLog.push(entry);
    console.debug(`[UnifiedCal:${step}] ${message}`, data || "");
  }

  public printAuditReport() {
    console.group("Ã°Å¸â€œÅ  CALIBRATION AUDIT REPORT");
    console.table(this.auditLog);

    // Detailed Segment Report
    console.group("Sensor Offsets & Quality");
    const reportData: any[] = [];
    this.state.results.forEach((res, segment) => {
      const e = new THREE.Euler().setFromQuaternion(res.offset, "XYZ");
      const rad2deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);
      reportData.push({
        Segment: segment,
        Quality: res.quality + "%",
        Method: res.method,
        OffsetEuler: `[${rad2deg(e.x)}, ${rad2deg(e.y)}, ${rad2deg(e.z)}]`,
        PCA_Conf: (this.pcaConfidences.get(segment) || 0).toFixed(2),
      });
    });
    console.table(reportData);
    console.groupEnd();

    // Validation Errors
    // Validation Errors
    if (this.state.validationResult) {
      // Per-Segment Issues
      const segmentIssues: any[] = [];
      this.state.validationResult.segments.forEach((seg, segId) => {
        seg.issues.forEach((issue) => {
          segmentIssues.push({
            segment: segId,
            type: issue.type,
            severity: issue.severity,
            message: issue.message,
          });
        });
      });

      if (segmentIssues.length > 0) {
        console.table(segmentIssues);
      }
    }
    console.groupEnd();
  }

  /**
   * Start the unified calibration flow
   * @param onStateChange Callback for state updates
   * @param topology Sensor topology type
   * @param targetPose Target neutral pose quaternions (Keys must match internal IDs e.g. 'thigh_l', 'pelvis')
   * @param useQuickMode Quick T-pose only mode
   * @param useStreamlined NEW: Streamlined Stand Ã¢â€ â€™ Walk auto-calibration
   */
  start(
    onStateChange: (state: UnifiedCalibrationState) => void,
    topology: TopologyType = TopologyType.SINGLE_SENSOR,
    targetPose?: Map<string, THREE.Quaternion>,
    flowOverride?: CalibrationStep[],
  ): void {
    this.onStateChange = onStateChange;
    this.targetNeutralPose = targetPose || null;

    // Reset state
    this.pcaConfidences.clear();
    this.functionalStepExtensions.clear();

    this.currentFlow =
      flowOverride && flowOverride.length > 0
        ? flowOverride
        : RESEARCH_STRICT_FLOWS[topology] || RESEARCH_STRICT_FULL_BODY_FLOW;
    console.debug(
      `[UnifiedCal] Starting RESEARCH STRICT flow for ${topology}:`,
      this.currentFlow,
    );

    this.state = this.getInitialState();
    this.clearBuffers();
    this.buffers.resetAlignmentDiagnostics();
    this.auditLog = []; // Reset log

    // Reset telemetry counters
    this.calibrationStartMs = Date.now();
    this.staticCaptureAttempts = 0;
    this.staticCaptureSuccesses = 0;
    this.preflightFailures = {};
    this.stageRetries = {};
    this.timelineRedRetries = {};

    this.logAudit("START", `Starting calibration flow: ${topology}`, {
      flow: this.currentFlow,
      topology,
      calibrationVersion: CALIBRATION_VERSION,
    });

    // Snapshot which assigned devices are actually connected right now.
    // Stale persisted assignments for devices not in this session are ignored.
    this.connectedAtStart = new Set<string>();
    const { devices: startDevices } = useDeviceRegistry.getState();
    const { assignments: startAssignments } =
      useSensorAssignmentStore.getState();
    startAssignments.forEach((_, deviceId) => {
      if (startDevices.has(deviceId)) {
        this.connectedAtStart.add(deviceId);
      }
    });

    if (!this.validateCalibrationPreflight(topology)) {
      this.notifyState();
      return;
    }

    // Initialize SARA and SCoRE calibrators for available joint pairs
    this.initializeJointCalibrators();

    // Start first step
    if (this.currentFlow.length > 0) {
      this.transitionTo(this.currentFlow[0]);
    }
  }

  public buildTargetedRetryFlow(
    regions: Array<"legs" | "arms" | "head" | "core">,
  ): CalibrationStep[] {
    const requested = new Set(regions);
    const steps: CalibrationStep[] = ["warm-up", "static-pose"];

    if (requested.has("legs")) {
      steps.push("leg-left-functional", "leg-right-functional");
    }
    if (requested.has("arms")) {
      steps.push("arm-left-functional", "arm-right-functional");
    }
    if (requested.has("head")) {
      steps.push("head-functional");
    }
    if (requested.has("core") && !steps.includes("hip-rotation")) {
      steps.push("hip-rotation");
    }

    if (
      !steps.includes("leg-left-functional") &&
      !steps.includes("arm-left-functional") &&
      !steps.includes("head-functional") &&
      !steps.includes("hip-rotation")
    ) {
      steps.push("generic-flex");
    }

    steps.push(
      "final-pose",
      "verification",
      "pose-check",
      "squat-check",
      "complete",
    );

    return steps;
  }

  /**
   * Initialize SARA and SCoRE calibrators for hinge joints where both sensors are available.
   */
  private initializeJointCalibrators(): void {
    this.saraCalibrators.clear();
    this.scoreCalibrators.clear();

    // Get list of assigned segments
    const assignedSegments: string[] = [];
    this.forEachAssignedDevice((_, segment) => {
      assignedSegments.push(segment.toLowerCase());
    });

    // Find calibrable joint pairs (both parent and child have sensors)
    this.calibrableJoints = findCalibrableJoints(assignedSegments);

    // Create calibrators
    for (const joint of this.calibrableJoints) {
      // SCoRE works for ALL joint types (Ball & Hinge) to find center
      this.scoreCalibrators.set(
        joint.jointId,
        new SCoRECalibrator(joint.jointId),
      );
      console.debug(`[SCoRE] Initialized calibrator for ${joint.jointId}`);

      // SARA only for Hinge joints
      if (joint.jointType === "hinge") {
        this.saraCalibrators.set(
          joint.jointId,
          new SARACalibrator(joint.jointId),
        );
        console.debug(
          `[SARA] Initialized calibrator for ${joint.jointId} (${joint.proximalSegment} Ã¢â€ â€™ ${joint.distalSegment})`,
        );
      }
    }

    if (this.saraCalibrators.size > 0 || this.scoreCalibrators.size > 0) {
      console.debug(
        `[Calibration] ${this.saraCalibrators.size} SARA + ${this.scoreCalibrators.size} SCoRE calibrators ready`,
      );
    }
  }

  /**
   * Cancel calibration
   */
  cancel(): void {
    this.state = this.getInitialState();
    this.functionalStepExtensions.clear();
    this.saraCalibrators.clear();
    this.scoreCalibrators.clear();
    this.calibrableJoints = [];
    this.connectedAtStart.clear();
    this.notifyState();
  }

  /**
   * Process a frame of sensor data (call every frame)
   */
  processFrame(_deltaTime: number): void {
    if (
      this.state.step === "idle" ||
      this.state.step === "complete" ||
      this.state.step === "error"
    ) {
      return;
    }

    // Collect sensor data
    this.collectSensorData();

    // Live confidence feedback for operator during functional capture
    this.updateLiveFunctionalConfidence(this.state.step);

    // Update countdown
    const stepDuration = this.getStepDuration(this.state.step);
    const elapsed = (Date.now() - this.stepStartTime) / 1000;
    this.state.countdown = Math.max(0, stepDuration - elapsed);
    this.state.stepProgress = Math.min(100, (elapsed / stepDuration) * 100);

    // =====================================================================
    // GENERIC-FLEX: Single sensor PCA with early exit
    // For single sensor mode, exit as soon as we have good axis detection
    // =====================================================================
    if (this.state.step === "generic-flex") {
      const SINGLE_SENSOR_THRESHOLD = 0.65; // Lower threshold for single sensor
      const MIN_SAMPLES = 45; // ~0.75s at 60fps

      let canExit = false;
      this.forEachAssignedDevice((device, segment) => {
        const gyroSamples = this.buffers.gyro(device.id);
        if (!gyroSamples || gyroSamples.length < MIN_SAMPLES) return;

        const pcaResult = estimateFunctionalAxis(gyroSamples);
        this.pcaConfidences.set(segment, pcaResult.confidence);
        this.state.autoPcaConfidence = pcaResult.confidence;
        this.state.stepProgress = Math.min(
          100,
          (pcaResult.confidence / 0.8) * 100,
        );

        // Early exit if confidence is good enough
        if (pcaResult.confidence >= SINGLE_SENSOR_THRESHOLD && elapsed >= 1.5) {
          canExit = true;
        }
      });

      if (canExit) {
        this.logAudit(
          "GENERIC-FLEX",
          "Early exit - single sensor confidence reached",
          {
            conf: this.state.autoPcaConfidence.toFixed(2),
            duration: elapsed.toFixed(1),
          },
        );
        console.debug(
          `[AutoCal] Ã¢Å“â€œ Generic-flex early exit! Confidence ${(this.state.autoPcaConfidence * 100).toFixed(0)}% in ${elapsed.toFixed(1)}s`,
        );
        this.completeCurrentStep();
        return;
      }
    }

    // =====================================================================
    // VERIFICATION: Real-time quality feedback during ROM check
    // User sees their avatar moving - confirms calibration worked
    // =====================================================================
    if (this.state.step === "verification") {
      // Track max movement seen so far for progress indicator
      let maxMovementSeen = 0;
      const MIN_MOVEMENT_TARGET = 15; // degrees - want to see at least this much movement

      this.forEachAssignedDevice((device, _segment) => {
        const quatSamples = this.buffers.quat(device.id);
        if (!quatSamples || quatSamples.length < 10) return;

        // Calculate current movement range
        const firstQuat = quatSamples[0];
        let maxAngle = 0;
        for (const q of quatSamples) {
          const angle = q.angleTo(firstQuat) * (180 / Math.PI);
          maxAngle = Math.max(maxAngle, angle);
        }
        maxMovementSeen = Math.max(maxMovementSeen, maxAngle);
      });

      // Progress based on movement seen (target = 15Ã‚Â°)
      this.state.stepProgress = Math.min(
        100,
        (maxMovementSeen / MIN_MOVEMENT_TARGET) * 100,
      );

      // Log milestone movement
      if (
        maxMovementSeen >= MIN_MOVEMENT_TARGET &&
        !this.verificationMovementLogged
      ) {
        console.debug(
          `[Verification] Ã¢Å“â€œ Good movement detected: ${maxMovementSeen.toFixed(1)}Ã‚Â°`,
        );
        this.verificationMovementLogged = true;
      }
    }

    // Check if step complete (timeout fallback for auto steps, normal for others)
    if (elapsed >= stepDuration) {
      if (this.tryExtendResearchFunctionalStep(this.state.step)) {
        this.notifyState();
        return;
      }

      if (this.state.step === "generic-flex") {
        console.warn(
          "[AutoCal] Generic-flex timeout - completing with current confidence",
        );
      }
      this.logAudit(this.state.step.toUpperCase(), "Step Timeout", {
        duration: elapsed.toFixed(1),
      });
      this.completeCurrentStep();
    }

    // Update overall progress
    const stepIndex = this.currentFlow.indexOf(this.state.step);
    if (stepIndex >= 0) {
      this.state.progress =
        ((stepIndex + this.state.stepProgress / 100) /
          this.currentFlow.length) *
        100;
    }

    this.notifyState();
  }

  private collectSensorData(): void {
    const { devices } = useDeviceRegistry.getState();
    const { getSegmentForSensor } = useSensorAssignmentStore.getState();
    const getSegmentOrUndefined = (sensorId: string) =>
      getSegmentForSensor(sensorId) ?? undefined;
    const segmentToDevice = buildSegmentToDeviceMap(
      devices,
      getSegmentOrUndefined,
    );

    devices.forEach((device) => {
      const rawGyro = deviceGyroCache.get(device.id);
      const rawAccel = deviceAccelCache.get(device.id);
      const rawQuat = deviceQuaternionCache.get(device.id) ?? device.quaternion;

      if (rawGyro)
        this.buffers.pushGyro(device.id, rawGyro as [number, number, number]);
      if (rawAccel)
        this.buffers.pushAccel(device.id, rawAccel as [number, number, number]);
      this.buffers.pushQuat(
        device.id,
        rawQuat as [number, number, number, number],
      );
      this.buffers.pushTime(device.id, performance.now() / 1000);
    });

    // Verify sensors that were connected at calibration start are still connected.
    // Only checks devices that were live when start() was called — stale persisted
    // assignments for devices not in this session are safely ignored.
    for (const deviceId of this.connectedAtStart) {
      if (!devices.has(deviceId)) {
        this.fail(
          `Sensor ${deviceId} (${getSegmentForSensor(deviceId)}) disconnected`,
        );
      }
    }

    // Feed SARA/SCoRE calibrators during functional movement steps.
    if (
      FUNCTIONAL_STEPS.has(this.state.step) &&
      (this.saraCalibrators.size > 0 || this.scoreCalibrators.size > 0)
    ) {
      this.feedJointCalibrators(segmentToDevice);
    }
  }

  /**
   * Iterate over all registered devices that have a segment assignment.
   * Eliminates the boilerplate: useDeviceRegistry Ã¢â€ â€™ getSegmentForSensor Ã¢â€ â€™ forEach Ã¢â€ â€™ null-check.
   */
  private forEachAssignedDevice(
    callback: (device: DeviceData, segment: string) => void,
  ): void {
    const { devices } = useDeviceRegistry.getState();
    const { getSegmentForSensor } = useSensorAssignmentStore.getState();
    const getSegmentOrUndefined = (sensorId: string) =>
      getSegmentForSensor(sensorId) ?? undefined;
    devices.forEach((device) => {
      const segment = getSegmentForSensor(device.id);
      if (!segment) return;
      callback(device, segment);
    });
  }

  /**
   * Fail the calibration process with an error message
   */
  public fail(reason: string): void {
    console.error(`[UnifiedCal] FAILED: ${reason}`);
    this.state.error = reason;
    this.state.step = "error";
    this.clearBuffers();
    this.notifyState();
  }

  /**
   * Feed dual-sensor data to joint calibrators (SARA + SCoRE).
   * For each joint, collects data from both parent and child sensors.
   */
  private feedJointCalibrators(segmentToDevice: Map<string, string>): void {
    for (const joint of this.calibrableJoints) {
      // Find device IDs for proximal (parent) and distal (child) segments
      const proximalDeviceId = segmentToDevice.get(
        joint.proximalSegment.toLowerCase(),
      );
      const distalDeviceId = segmentToDevice.get(
        joint.distalSegment.toLowerCase(),
      );

      if (!proximalDeviceId || !distalDeviceId) continue;

      // Get latest gyro data (raw sensor frame)
      const proximalGyroBuffer = this.buffers.gyro(proximalDeviceId);
      const distalGyroBuffer = this.buffers.gyro(distalDeviceId);

      // Get latest quaternion data (already in Three.js frame)
      if (!proximalGyroBuffer?.length || !distalGyroBuffer?.length) {
        continue;
      }

      const aligned = this.buffers.getAlignedJointFrame(
        proximalDeviceId,
        distalDeviceId,
        { maxSkewMs: 20 },
      );
      if (!aligned) {
        continue;
      }

      const proxGyro = aligned.proximal.gyro;
      const distGyro = aligned.distal.gyro;
      const proxQuat = aligned.proximal.quat;
      const distQuat = aligned.distal.quat;

      // Feed SARA (Hinge)
      if (joint.jointType === "hinge") {
        const saraCalib = this.saraCalibrators.get(joint.jointId);
        if (saraCalib) {
          // Gyro frame: proxGyro / distGyro are in sensor-local frame.
          // firmwareToThreeVec() converts axis convention (firmwareÃ¢â€ â€™Three.js) but
          // does NOT rotate into world frame Ã¢â‚¬â€ the vectors are still body-fixed.
          // estimateHingeAxis internally applies proxQuat / distQuat to project
          // each gyro into world frame before accumulating the outer-product matrix,
          // so the sensor-local frame here is correct and expected.
          saraCalib.addFrame(proxGyro, distGyro, proxQuat, distQuat);
        }
      }

      // Feed SCoRE (All Joints) with IMU data
      const scoreCalib = this.scoreCalibrators.get(joint.jointId);
      if (scoreCalib) {
        const pa = aligned.proximal.accel;
        const da = aligned.distal.accel;
        const t = aligned.timestampSec || performance.now() / 1000;

        // Pass accel as 'pos' arguments, and true for isAccelMode
        scoreCalib.addFrame(
          pa,
          da,
          proxQuat,
          distQuat,
          proxGyro,
          distGyro,
          true,
          t,
        );
      }
    }
  }

  private validateCalibrationPreflight(topology: TopologyType): boolean {
    if (topology !== TopologyType.FULL_BODY) {
      return true;
    }

    const { devices } = useDeviceRegistry.getState();
    const { assignments } = useSensorAssignmentStore.getState();
    const connectedSegments = new Set<string>();

    assignments.forEach((assignment, deviceId) => {
      if (devices.has(deviceId)) {
        connectedSegments.add(assignment.segmentId.toLowerCase());
      }
    });

    const missingSegments = FULL_BODY_REQUIRED_SEGMENTS.filter(
      (segment) => !connectedSegments.has(segment),
    );

    if (missingSegments.length === 0) {
      return true;
    }

    this.state.step = "error";
    this.state.error =
      `Full-body calibration requires ${FULL_BODY_REQUIRED_SEGMENTS.length} connected/assigned core segments. ` +
      `Missing: ${missingSegments.join(", ")}`;

    this.logAudit("PREFLIGHT-FAIL", this.state.error, {
      topology,
      requiredSegments: FULL_BODY_REQUIRED_SEGMENTS,
      missingSegments,
      connectedAtStart: Array.from(this.connectedAtStart.values()),
    });

    return false;
  }

  private transitionTo(step: CalibrationStep): void {
    this.state.step = step;
    this.stepStartTime = Date.now();
    this.state.countdown = this.getStepDuration(step);
    this.state.stepProgress = 0;
    this.logAudit("TRANSITION", `Transitioning to step: ${step}`);

    // Reset verification tracking when entering verification step
    if (step === "verification") {
      this.verificationMovementLogged = false;
    }

    // CRITICAL: Clear buffers when starting a new data capture step to avoid analyzing stale data
    if (step !== "idle" && step !== "complete" && step !== "error") {
      // If we are transitioning from a functional step, compute SCoRE results before clearing buffers
      if (FUNCTIONAL_STEPS.has(this.state.step)) {
        // Compute SCoRE results before clearing buffers
        this.scoreCalibrators.forEach((calibrator, jointId) => {
          // Only update if we don't have a high confidence result yet
          // or if this step provided better data
          const result = calibrator.compute();
          if (result && result.confidence > 0.4) {
            const existing = this.state.scoreResults.get(jointId);
            if (!existing || result.confidence > existing.confidence) {
              this.state.scoreResults.set(jointId, result);
              console.debug(
                `[SCoRE] Updated result for ${jointId}: Confidence=${result.confidence.toFixed(2)}`,
              );
            }
          }
        });
      }

      this.clearBuffers();
      this.pcaConfidences.clear();
      // Reset SARA/SCoRE calibrators for new capture
      this.saraCalibrators.forEach((calibrator) => calibrator.reset());
      this.scoreCalibrators.forEach((calibrator) => calibrator.reset());
    }

    this.notifyState();
  }

  private getStepDuration(step: CalibrationStep): number {
    const baseDuration = STEP_DURATIONS[step] || 0;
    const extensionCount = this.functionalStepExtensions.get(step) || 0;
    return (
      baseDuration + extensionCount * RESEARCH_FUNCTIONAL_EXTENSION_SECONDS
    );
  }

  private updateLiveFunctionalConfidence(step: CalibrationStep): void {
    this.state.liveFunctionalConfidence.clear();

    const isFunctionalStep = FUNCTIONAL_STEPS.has(step);

    if (!isFunctionalStep) {
      return;
    }

    const targetedSegments = new Set(getFunctionalSegmentsForStep(step));

    this.forEachAssignedDevice((device, rawSegment) => {
      const segment = rawSegment.toLowerCase();

      if (targetedSegments.size > 0 && !targetedSegments.has(segment)) {
        return;
      }

      const samples = this.buffers.gyro(device.id);
      const sampleCount = samples?.length || 0;

      let confidence = 0;
      if (samples && sampleCount >= 30) {
        const pcaResult = estimateFunctionalAxis(samples);
        confidence = pcaResult.confidence;
      }

      const target = RESEARCH_STRICT_CRITICAL_SEGMENTS.has(segment)
        ? getResearchStrictThreshold(segment)
        : 0.65;

      this.state.liveFunctionalConfidence.set(segment, {
        confidence,
        target,
        sampleCount,
      });
    });
  }

  private tryExtendResearchFunctionalStep(step: CalibrationStep): boolean {
    const targetSegments = getFunctionalSegmentsForStep(step);
    if (targetSegments.length === 0) return false;

    const extensionCount = this.functionalStepExtensions.get(step) || 0;
    if (extensionCount >= MAX_RESEARCH_FUNCTIONAL_EXTENSIONS) return false;

    const weakSegments: string[] = [];

    this.forEachAssignedDevice((device, segment) => {
      const segmentLower = segment.toLowerCase();
      if (!targetSegments.includes(segmentLower)) return;

      const gyroSamples = this.buffers.gyro(device.id);
      if (
        !gyroSamples ||
        gyroSamples.length < RESEARCH_FUNCTIONAL_MIN_SAMPLES
      ) {
        weakSegments.push(`${segmentLower} (insufficient samples)`);
        return;
      }

      const pcaResult = estimateFunctionalAxis(gyroSamples);
      this.pcaConfidences.set(segmentLower, pcaResult.confidence);

      const threshold = Math.max(
        0.65,
        getResearchStrictThreshold(segmentLower) - 0.03,
      );
      if (pcaResult.confidence < threshold) {
        weakSegments.push(
          `${segmentLower} (${pcaResult.confidence.toFixed(2)} < ${threshold.toFixed(2)})`,
        );
      }
    });

    if (weakSegments.length === 0) return false;

    this.functionalStepExtensions.set(step, extensionCount + 1);
    this.logAudit(
      "EXTEND",
      `Extending ${step} for additional movement capture`,
      {
        extension: extensionCount + 1,
        weakSegments,
      },
    );
    console.warn(
      `[ResearchStrict] Extending ${step} (+${RESEARCH_FUNCTIONAL_EXTENSION_SECONDS}s). Weak segments: ${weakSegments.join(", ")}`,
    );

    return true;
  }

  private completeCurrentStep(): void {
    // 1. Capture data for the current step
    switch (this.state.step) {
      case "warm-up":
        // No data capture, just filter settling
        console.debug("[UnifiedCal] Warm-up complete, filters settled");
        break;

      case "static-pose":
        if (!this.captureStaticPose()) {
          this.notifyState();
          return;
        }
        break;

      case "leg-left-functional":
        if (!this.checkTimelineGateBeforeCapture("leg-left-functional")) return;
        this.captureFunctionalDataByPredicate(
          (segmentLower) =>
            segmentLower.includes("thigh_l") ||
            segmentLower.includes("tibia_l") ||
            segmentLower.includes("foot_l") ||
            segmentLower === "pelvis" ||
            segmentLower === "torso",
          "left leg",
        );
        break;

      case "leg-right-functional":
        if (!this.checkTimelineGateBeforeCapture("leg-right-functional")) return;
        this.captureFunctionalDataByPredicate(
          (segmentLower) =>
            segmentLower.includes("thigh_r") ||
            segmentLower.includes("tibia_r") ||
            segmentLower.includes("foot_r") ||
            segmentLower === "pelvis" ||
            segmentLower === "torso",
          "right leg",
        );
        break;

      case "arm-left-functional":
        if (!this.checkTimelineGateBeforeCapture("arm-left-functional")) return;
        this.captureFunctionalDataByPredicate(
          (segmentLower) =>
            segmentLower.includes("upper_arm_l") ||
            segmentLower.includes("forearm_l") ||
            segmentLower.includes("hand_l"),
          "left arm",
        );
        break;

      case "arm-right-functional":
        if (!this.checkTimelineGateBeforeCapture("arm-right-functional")) return;
        this.captureFunctionalDataByPredicate(
          (segmentLower) =>
            segmentLower.includes("upper_arm_r") ||
            segmentLower.includes("forearm_r") ||
            segmentLower.includes("hand_r"),
          "right arm",
        );
        break;

      case "head-functional":
        if (!this.checkTimelineGateBeforeCapture("head-functional")) return;
        this.captureFunctionalDataByPredicate(
          (segmentLower) => segmentLower === "head",
          "head",
        );
        break;

      case "ankle-flex":
        if (!this.checkTimelineGateBeforeCapture("ankle-flex")) return;
        // Capture ankle flexion data for skate mode
        this.captureFunctionalData("ankle");
        break;

      case "hip-rotation":
        if (!this.checkTimelineGateBeforeCapture("hip-rotation")) return;
        // Capture hip rotation data for core mode
        this.captureFunctionalData("hip");
        break;

      case "generic-flex":
        if (!this.checkTimelineGateBeforeCapture("generic-flex")) return;
        // Capture generic functional data for any sensor
        this.captureFunctionalData("generic");
        // For flows without final-pose, compute calibration here
        if (
          !this.currentFlow.includes("final-pose") &&
          !this.currentFlow.includes("verification")
        ) {
          this.computeFinalCalibration();
        }
        break;

      case "final-pose":
        // Capture final static pose for "Sandwich" calibration (Zero refinement)
        if (!this.captureStaticPose("finalPoseData")) {
          this.notifyState();
          return;
        }
        this.computeFinalCalibration();
        break;

      case "verification":
        // Verification step: validate calibration quality with ROM check
        {
          const verificationPassed = this.performVerification();
          if (!verificationPassed) {
            const retrySummary = this.getStrictRetrySummary();
            this.state.step = "error";
            this.state.error = `Research strict gate failed. Retry required: ${retrySummary}`;
            this.logAudit("GATE-FAIL", this.state.error, {
              failures: [...this.state.criticalJointFailures],
            });
            this.notifyState();
            return;
          }
        }
        break;

      case "pose-check": {
        const poseCheck = this.performPoseCheck();
        this.state.functionalChecks.set("pose-check", poseCheck);
        if (poseCheck.status === "fail") {
          this.state.step = "error";
          this.state.error =
            poseCheck.recommendation ||
            "Pose-check failed. Hold a neutral posture and recalibrate.";
          this.notifyState();
          return;
        }
        break;
      }

      case "squat-check": {
        const squatCheck = this.performSquatCheck();
        this.state.functionalChecks.set("squat-check", squatCheck);
        if (squatCheck.status === "fail") {
          this.state.step = "error";
          this.state.error =
            squatCheck.recommendation ||
            "Squat-check failed. Repeat 3-5 controlled reps and recalibrate the failed region.";
          this.notifyState();
          return;
        }
        break;
      }
    }

    // 2. Transition to next step in the flow
    const currentIndex = this.currentFlow.indexOf(this.state.step);
    if (currentIndex >= 0 && currentIndex < this.currentFlow.length - 1) {
      const nextStep = this.currentFlow[currentIndex + 1];
      this.transitionTo(nextStep);
    } else {
      // End of flow or unknown step
      if (this.state.step !== "complete" && this.state.step !== "error") {
        this.transitionTo("complete");
      }
    }
  }

  /**
   * Verification step: Quick ROM check to validate calibration quality.
   * Computes calibration if not already done, then validates the results.
   */
  private performVerification(): boolean {
    // Ensure calibration is computed before verification
    if (this.state.results.size === 0) {
      this.computeFinalCalibration();
    }

    // Capture verification movement data (ROM check)
    const verificationData = new Map<
      string,
      { maxAngle: number; smoothness: number }
    >();

    this.forEachAssignedDevice((device, segment) => {
      const quatSamples = this.buffers.quat(device.id);
      if (!quatSamples || quatSamples.length < 30) return;

      // Calculate max angle deviation during verification movement
      const firstQuat = quatSamples[0];
      let maxAngle = 0;
      let totalAngularVelocity = 0;

      for (let i = 1; i < quatSamples.length; i++) {
        const angle = quatSamples[i].angleTo(firstQuat) * (180 / Math.PI);
        maxAngle = Math.max(maxAngle, angle);

        // Calculate angular velocity for smoothness metric
        const prevAngle =
          quatSamples[i - 1].angleTo(firstQuat) * (180 / Math.PI);
        totalAngularVelocity += Math.abs(angle - prevAngle);
      }

      // Smoothness: lower is better (jerky movement = higher value)
      const smoothness =
        quatSamples.length > 1
          ? totalAngularVelocity / (quatSamples.length - 1)
          : 0;

      verificationData.set(segment, { maxAngle, smoothness });
      this.logAudit(
        "VERIFICATION",
        `${segment}: max=${maxAngle.toFixed(1)}Ã‚Â°, smoothness=${smoothness.toFixed(2)}`,
      );
    });

    // Assess verification quality
    let totalMaxAngle = 0;
    let segmentCount = 0;

    verificationData.forEach(({ maxAngle, smoothness }, segment) => {
      totalMaxAngle += maxAngle;
      segmentCount++;

      // Verification criteria:
      // - Must see some movement (>5Ã‚Â°) - proves sensor is responding
      // - Smoothness should be reasonable (<5Ã‚Â° per frame average)
      const minMovement = 5; // degrees
      const maxJerk = 5; // degrees per frame

      if (maxAngle < minMovement) {
        console.warn(
          `[Verification] ${segment}: Insufficient movement (${maxAngle.toFixed(1)}Ã‚Â° < ${minMovement}Ã‚Â°)`,
        );
        // Don't fail, just warn - user might not have moved much
      }
      if (smoothness > maxJerk) {
        console.warn(
          `[Verification] ${segment}: High jitter detected (${smoothness.toFixed(2)} > ${maxJerk})`,
        );
      }
    });

    const avgMovement = segmentCount > 0 ? totalMaxAngle / segmentCount : 0;

    const verificationPassed =
      this.evaluateResearchStrictGates(verificationData);
    this.logAudit(
      "VERIFICATION",
      `Complete: avg movement=${avgMovement.toFixed(1)}Ã‚Â°, passed=${verificationPassed}`,
    );

    // Run IK validation if not already done
    // Note: full validation runs in runValidation() with proper calibrated orientations

    console.debug(
      `[UnifiedCal] Ã¢Å“â€œ Verification complete. Avg movement: ${avgMovement.toFixed(1)}Ã‚Â°`,
    );
    return verificationPassed;
  }

  /**
   * Evaluate strict per-joint calibration gates.
   */
  private evaluateResearchStrictGates(
    verificationData: Map<string, { maxAngle: number; smoothness: number }>,
  ): boolean {
    const gateOutput = evaluateStrictGates({
      results: this.state.results,
      verificationData,
    });

    this.state.jointGateResults = gateOutput.jointGateResults;
    this.state.criticalJointFailures = [...gateOutput.criticalJointFailures];

    return gateOutput.passed;
  }

  private getStrictRetrySummary(maxItems = 4): string {
    return buildStrictRetrySummary(
      this.state.jointGateResults,
      this.state.criticalJointFailures,
      maxItems,
    );
  }

  public getCalibrationQcArtifact(): CalibrationQcArtifact {
    const timelineDiag = this.buffers.getAlignmentDiagnostics();
    const durationMs = this.calibrationStartMs > 0
      ? Date.now() - this.calibrationStartMs
      : 0;

    // Build telemetry
    const totalPairs = timelineDiag.totalPairs;
    const interpolationRatio = totalPairs > 0
      ? timelineDiag.interpolatedPairs / totalPairs
      : 0;
    const droppedDenom = totalPairs + timelineDiag.droppedPairs;
    const droppedRatio = droppedDenom > 0
      ? timelineDiag.droppedPairs / droppedDenom
      : 0;

    const functionalExtensions: Record<string, number> = {};
    for (const [step, count] of this.functionalStepExtensions) {
      functionalExtensions[step] = count;
    }

    const telemetry: CalibrationTelemetry = {
      preflightFailures: { ...this.preflightFailures },
      stageRetries: { ...this.stageRetries },
      timelineInterpolationRatio: interpolationRatio,
      timelineDroppedRatio: droppedRatio,
      timelineMaxSkewMs: timelineDiag.maxSkewMs,
      staticCaptureAttempts: this.staticCaptureAttempts,
      staticCaptureSuccesses: this.staticCaptureSuccesses,
      functionalExtensions,
      durationMs,
    };

    return buildCalibrationQcArtifact({
      step: this.state.step,
      overallQuality: this.state.overallQuality,
      error: this.state.error,
      results: this.state.results,
      jointGateResults: this.state.jointGateResults,
      criticalJointFailures: this.state.criticalJointFailures,
      validationResult: this.state.validationResult,
      functionalChecks: this.state.functionalChecks,
      timelineDiagnostics: timelineDiag,
      auditLog: this.auditLog,
      telemetry,
    });
  }

  public getCalibrationQcMarkdown(): string {
    return buildCalibrationQcMarkdown(this.getCalibrationQcArtifact());
  }

  private captureStaticPose(
    target: "staticPoseData" | "finalPoseData" = "staticPoseData",
  ): boolean {
    this.staticCaptureAttempts++;
    const poseData = new Map<string, THREE.Quaternion>();
    const failedSegments: string[] = [];
    const failedSegmentHints: string[] = [];

    this.forEachAssignedDevice((device, segment) => {
      const quatSamples = this.buffers.quat(device.id);
      const gyroSamples = this.buffers.gyro(device.id);
      const accelSamples = this.buffers.accel(device.id);

      const windowQuality = this.evaluateStaticCaptureWindow(
        quatSamples,
        gyroSamples,
        accelSamples,
      );

      if (!windowQuality.accepted || !windowQuality.averagedQuat) {
        failedSegments.push(`${segment} (${windowQuality.reason})`);
        failedSegmentHints.push(
          getStaticCaptureRetryHint(segment, windowQuality.reason || ""),
        );
        return;
      }

      poseData.set(device.id, windowQuality.averagedQuat);
    });

    if (failedSegments.length > 0) {
      const failedPreview = failedSegments.slice(0, 4).join("; ");
      const suffix = failedSegments.length > 4 ? " +more" : "";
      // Use the most specific hint from the first failed segment
      const hint = failedSegmentHints[0] || "Stand fully still and retry.";
      this.state.step = "error";
      this.state.error =
        `Static capture quality check failed. ${hint} ` +
        `Affected segments: ${failedPreview}${suffix}`;

      // Track preflight failures by reason
      for (const seg of failedSegments) {
        const reason = seg.match(/\((.+)\)/)?.[1] || "unknown";
        this.preflightFailures[reason] = (this.preflightFailures[reason] || 0) + 1;
      }

      this.logAudit(
        target === "staticPoseData" ? "STATIC-POSE-FAIL" : "FINAL-POSE-FAIL",
        this.state.error,
        { failedSegments, hints: failedSegmentHints },
      );
      return false;
    }

    this.staticCaptureSuccesses++;

    if (target === "staticPoseData") {
      this.state.staticPoseData = poseData;
      this.logAudit(
        "STATIC-POSE",
        `Captured static pose for ${poseData.size} sensors`,
      );
    } else {
      this.state.finalPoseData = poseData;
      this.logAudit(
        "FINAL-POSE",
        `Captured final pose for ${poseData.size} sensors`,
      );
    }

    // CAPTURE DRIFT METRICS + GYRO BIAS (while stationary)
    // Drift validates if hardware offset correction is working.
    // Gyro bias vector captures residual DC offset for webapp-level
    // bias subtraction (firmware correction is imperfect).
    this.buffers.gyroMap().forEach((samples, deviceId) => {
      if (samples.length >= 10) {
        // Get last 1 second of data (approx 60 frames)
        const recent = samples.slice(-60);
        let sumMag = 0;
        let sumX = 0,
          sumY = 0,
          sumZ = 0;
        recent.forEach((v) => {
          sumMag += v.length();
          sumX += v.x;
          sumY += v.y;
          sumZ += v.z;
        });
        const n = recent.length;
        const avgDrift = sumMag / n;
        const biasX = sumX / n;
        const biasY = sumY / n;
        const biasZ = sumZ / n;

        // ── Stationarity validation ────────────────────────────────────
        // Compute per-axis variance to detect motion contamination.
        // True stationary gyro has σ < ~0.01 rad/s (MEMS noise floor).
        // If σ > 0.05 rad/s on any axis, samples include real motion.
        let varX = 0,
          varY = 0,
          varZ = 0;
        recent.forEach((v) => {
          varX += (v.x - biasX) ** 2;
          varY += (v.y - biasY) ** 2;
          varZ += (v.z - biasZ) ** 2;
        });
        const stdX = Math.sqrt(varX / n);
        const stdY = Math.sqrt(varY / n);
        const stdZ = Math.sqrt(varZ / n);
        const maxStd = Math.max(stdX, stdY, stdZ);

        // Threshold: 0.05 rad/s (≈2.9°/s). Below this is MEMS jitter;
        // above means motion is contaminating the bias estimate.
        const GYRO_STATIONARY_STD_THRESHOLD = 0.05;

        if (maxStd > GYRO_STATIONARY_STD_THRESHOLD) {
          console.warn(
            `[UnifiedCal] ⚠ Gyro bias for ${deviceId} may be contaminated: ` +
              `std=[${stdX.toFixed(4)}, ${stdY.toFixed(4)}, ${stdZ.toFixed(4)}] rad/s ` +
              `(max ${maxStd.toFixed(4)} > threshold ${GYRO_STATIONARY_STD_THRESHOLD}). ` +
              `Using zero bias instead.`,
          );
          // Fall back to zero bias rather than a corrupted estimate
          this.state.gyroBiasEstimates.set(deviceId, { x: 0, y: 0, z: 0 });
        } else {
          this.state.gyroBiasEstimates.set(deviceId, {
            x: biasX,
            y: biasY,
            z: biasZ,
          });
        }

        this.state.driftMetrics.set(deviceId, avgDrift);
        console.debug(
          `[UnifiedCal] Sensor ${deviceId} drift: ${avgDrift.toFixed(5)} rad/s (${((avgDrift * 180) / Math.PI).toFixed(3)} deg/s), ` +
            `bias: [${biasX.toFixed(5)}, ${biasY.toFixed(5)}, ${biasZ.toFixed(5)}], ` +
            `std: [${stdX.toFixed(4)}, ${stdY.toFixed(4)}, ${stdZ.toFixed(4)}]`,
        );
      }
    });

    console.debug(
      `[UnifiedCal] Captured static pose for ${poseData.size} sensors`,
    );

    return true;
  }

  private evaluateStaticCaptureWindow(
    quatSamples: THREE.Quaternion[] | undefined,
    gyroSamples: THREE.Vector3[] | undefined,
    accelSamples: THREE.Vector3[] | undefined,
  ): {
    accepted: boolean;
    averagedQuat?: THREE.Quaternion;
    reason?: string;
  } {
    const qCount = quatSamples?.length || 0;
    const gCount = gyroSamples?.length || 0;
    const aCount = accelSamples?.length || 0;
    const minCount = Math.min(qCount, gCount, aCount);

    if (minCount < STATIC_CAPTURE_MIN_FRAMES) {
      return {
        accepted: false,
        reason: `insufficient samples (${minCount}/${STATIC_CAPTURE_MIN_FRAMES})`,
      };
    }

    const windowFrames = Math.max(
      STATIC_CAPTURE_MIN_FRAMES,
      Math.min(STATIC_CAPTURE_WINDOW_FRAMES, minCount),
    );

    const qWindow = (quatSamples || []).slice(-windowFrames);
    const gWindow = (gyroSamples || []).slice(-windowFrames);
    const aWindow = (accelSamples || []).slice(-windowFrames);

    const averagedQuat = averageQuaternions(qWindow);

    let quatVariance = 0;
    qWindow.forEach((sample) => {
      const angle = sample.angleTo(averagedQuat);
      quatVariance += angle * angle;
    });
    quatVariance /= qWindow.length;

    const gyroMean =
      gWindow.reduce((sum, sample) => sum + sample.length(), 0) / gWindow.length;

    const accelMagnitudes = aWindow.map((sample) => sample.length());
    const accelMean =
      accelMagnitudes.reduce((sum, value) => sum + value, 0) /
      accelMagnitudes.length;
    const accelVariance =
      accelMagnitudes.reduce(
        (sum, value) => sum + (value - accelMean) * (value - accelMean),
        0,
      ) / accelMagnitudes.length;
    const accelStd = Math.sqrt(accelVariance);

    if (gyroMean > STATIC_CAPTURE_MAX_GYRO_MEAN) {
      return {
        accepted: false,
        reason: `too much movement (gyro=${gyroMean.toFixed(3)} rad/s)`,
      };
    }

    if (quatVariance > STATIC_CAPTURE_MAX_QUAT_VARIANCE) {
      return {
        accepted: false,
        reason: `orientation unstable (variance=${quatVariance.toFixed(4)})`,
      };
    }

    if (accelStd > STATIC_CAPTURE_MAX_ACCEL_STD) {
      return {
        accepted: false,
        reason: `accelerometer unstable (std=${accelStd.toFixed(3)})`,
      };
    }

    if (
      accelMean < STATIC_CAPTURE_MIN_ACCEL_MEAN ||
      accelMean > STATIC_CAPTURE_MAX_ACCEL_MEAN
    ) {
      return {
        accepted: false,
        reason: `gravity mismatch (|a|=${accelMean.toFixed(2)} m/s²)`,
      };
    }

    return { accepted: true, averagedQuat };
  }

  private performPoseCheck(): FunctionalCheckResult {
    const maxAngles: number[] = [];

    this.forEachAssignedDevice((device) => {
      const samples = this.buffers.quat(device.id);
      if (!samples || samples.length < STATIC_CAPTURE_MIN_FRAMES) return;

      const baseline = samples[0];
      let maxAngle = 0;
      for (const sample of samples) {
        maxAngle = Math.max(maxAngle, sample.angleTo(baseline) * (180 / Math.PI));
      }
      maxAngles.push(maxAngle);
    });

    if (maxAngles.length === 0) {
      return {
        check: "pose-check",
        status: "fail",
        summary: "No reliable neutral-hold samples were captured.",
        metrics: { sensorsChecked: 0 },
        recommendation:
          "Try this now: stand still for 10 seconds and rerun pose-check.",
        failedRegions: ["core"],
      };
    }

    const averageMaxAngle =
      maxAngles.reduce((sum, angle) => sum + angle, 0) / maxAngles.length;
    const unstableCount = maxAngles.filter((angle) => angle > 8).length;
    const unstableRatio = unstableCount / maxAngles.length;

    if (unstableRatio > 0.35) {
      return {
        check: "pose-check",
        status: "fail",
        summary: "Neutral hold was too unstable for trusted calibration.",
        metrics: {
          sensorsChecked: maxAngles.length,
          unstableRatio,
          averageMaxAngleDeg: averageMaxAngle,
        },
        recommendation:
          "Try this now: keep feet planted, reduce sway, and rerun calibration.",
        failedRegions: ["core"],
      };
    }

    if (unstableRatio > 0.15 || averageMaxAngle > 6) {
      return {
        check: "pose-check",
        status: "warn",
        summary: "Neutral hold passed with mild instability.",
        metrics: {
          sensorsChecked: maxAngles.length,
          unstableRatio,
          averageMaxAngleDeg: averageMaxAngle,
        },
        recommendation:
          "Optional improvement: repeat pose-check with a steadier neutral stance.",
      };
    }

    return {
      check: "pose-check",
      status: "pass",
      summary: "Neutral hold quality is stable.",
      metrics: {
        sensorsChecked: maxAngles.length,
        unstableRatio,
        averageMaxAngleDeg: averageMaxAngle,
      },
    };
  }

  private performSquatCheck(): FunctionalCheckResult {
    const leftThigh = this.getMaxAngleSeriesForSegment("thigh_l");
    const rightThigh = this.getMaxAngleSeriesForSegment("thigh_r");

    let signal: number[] = [];
    if (leftThigh.length > 0 && rightThigh.length > 0) {
      const n = Math.min(leftThigh.length, rightThigh.length);
      signal = Array.from({ length: n }, (_, i) => (leftThigh[i] + rightThigh[i]) / 2);
    } else {
      signal = this.buildGlobalMotionSignal();
    }

    if (signal.length < STATIC_CAPTURE_MIN_FRAMES) {
      return {
        check: "squat-check",
        status: "fail",
        summary: "Not enough dynamic data to score squat quality.",
        metrics: { samples: signal.length },
        recommendation:
          "Try this now: perform 3-5 controlled squat reps and rerun squat-check.",
      };
    }

    const minAngle = Math.min(...signal);
    const maxAngle = Math.max(...signal);
    const motionRange = maxAngle - minAngle;
    const reps = this.countReps(signal, 18, 10);

    const symmetryDelta =
      leftThigh.length > 0 && rightThigh.length > 0
        ? Math.abs(Math.max(...leftThigh) - Math.max(...rightThigh))
        : 0;

    if (motionRange < 14 || reps < 2) {
      return {
        check: "squat-check",
        status: "fail",
        summary: "Squat movement was insufficient for a reliable functional check.",
        metrics: { motionRangeDeg: motionRange, repsDetected: reps, symmetryDeltaDeg: symmetryDelta },
        recommendation:
          "Try this now: complete 3-5 deeper, controlled squat reps and keep both legs moving symmetrically.",
        failedRegions: ["legs"],
      };
    }

    if (reps < 3 || reps > 6 || symmetryDelta > 14) {
      return {
        check: "squat-check",
        status: "warn",
        summary: "Squat-check passed with moderate quality warnings.",
        metrics: { motionRangeDeg: motionRange, repsDetected: reps, symmetryDeltaDeg: symmetryDelta },
        recommendation:
          "Optional improvement: repeat squat-check with 3-5 smooth, symmetric reps.",
      };
    }

    return {
      check: "squat-check",
      status: "pass",
      summary: "Squat-check confirms stable dynamic calibration transfer.",
      metrics: { motionRangeDeg: motionRange, repsDetected: reps, symmetryDeltaDeg: symmetryDelta },
    };
  }

  private getMaxAngleSeriesForSegment(segmentId: string): number[] {
    const { devices } = useDeviceRegistry.getState();
    const { getSegmentForSensor } = useSensorAssignmentStore.getState();

    for (const device of devices.values()) {
      const segment = getSegmentForSensor(device.id)?.toLowerCase();
      if (segment !== segmentId) continue;

      const samples = this.buffers.quat(device.id);
      if (!samples || samples.length < 2) return [];

      const baseline = samples[0];
      return samples.map((sample) => sample.angleTo(baseline) * (180 / Math.PI));
    }

    return [];
  }

  private buildGlobalMotionSignal(): number[] {
    const allSignals: number[][] = [];

    this.forEachAssignedDevice((device) => {
      const samples = this.buffers.quat(device.id);
      if (!samples || samples.length < 2) return;
      const baseline = samples[0];
      allSignals.push(
        samples.map((sample) => sample.angleTo(baseline) * (180 / Math.PI)),
      );
    });

    if (allSignals.length === 0) return [];

    const n = Math.min(...allSignals.map((signal) => signal.length));
    return Array.from({ length: n }, (_, i) => {
      let sum = 0;
      for (const signal of allSignals) sum += signal[i];
      return sum / allSignals.length;
    });
  }

  private countReps(signal: number[], peakThresholdDeg: number, minSpacing: number): number {
    let reps = 0;
    let lastPeakIdx = -minSpacing;

    for (let i = 1; i < signal.length - 1; i++) {
      const isPeak = signal[i] > signal[i - 1] && signal[i] >= signal[i + 1];
      if (!isPeak) continue;
      if (signal[i] < peakThresholdDeg) continue;
      if (i - lastPeakIdx < minSpacing) continue;
      reps++;
      lastPeakIdx = i;
    }

    return reps;
  }

  // ============================================================================
  // TIMELINE HARD GATE — blocks functional capture when timeline quality is red
  // ============================================================================

  /**
   * Check timeline quality before a functional data capture.
   * Returns `true` if capture should proceed, `false` if the step should
   * be retried (caller must re-transition and return early).
   *
   * On "red" tier with retries remaining → logs, increments retry counter,
   * re-transitions to the same step, and returns false.
   * On "red" tier with retries exhausted → logs high-severity warning,
   * returns true (degraded capture, tracked via telemetry / trust level).
   * On "yellow" / "green" tier → returns true silently.
   */
  private checkTimelineGateBeforeCapture(step: CalibrationStep): boolean {
    const diag = this.buffers.getAlignmentDiagnostics();
    const totalPairs = diag.totalPairs;
    if (totalPairs === 0) return true; // no paired data yet — nothing to gate

    const interpolationRatio =
      totalPairs > 0 ? diag.interpolatedPairs / totalPairs : 0;
    const droppedDenom = totalPairs + diag.droppedPairs;
    const droppedRatio = droppedDenom > 0 ? diag.droppedPairs / droppedDenom : 0;

    const { tier, reasons } = evaluateTimelineGateTier({
      maxSkewMs: diag.maxSkewMs,
      droppedRatio,
      interpolationRatio,
    });

    if (tier === "green") return true;

    if (tier === "yellow") {
      this.logAudit(
        "TIMELINE-WARN",
        `Timeline quality yellow during ${step}: ${reasons.join("; ")}`,
      );
      return true;
    }

    // tier === "red"
    const retries = this.timelineRedRetries[step] ?? 0;
    if (retries < UnifiedCalibration.MAX_TIMELINE_RED_RETRIES) {
      this.timelineRedRetries[step] = retries + 1;
      this.stageRetries[step] = (this.stageRetries[step] ?? 0) + 1;
      this.logAudit(
        "TIMELINE-RED-RETRY",
        `Timeline quality red during ${step} (attempt ${retries + 1}/${UnifiedCalibration.MAX_TIMELINE_RED_RETRIES}). Retrying step. ${reasons.join("; ")}`,
      );
      console.warn(
        `[UnifiedCal] Timeline red during ${step} — retrying (${retries + 1}/${UnifiedCalibration.MAX_TIMELINE_RED_RETRIES})`,
      );
      // Re-transition to the same step (clears buffers, restarts timer)
      this.transitionTo(step);
      return false;
    }

    // Retries exhausted — proceed with degraded data
    this.logAudit(
      "TIMELINE-RED-EXHAUSTED",
      `Timeline quality red during ${step} after ${UnifiedCalibration.MAX_TIMELINE_RED_RETRIES} retries. Proceeding with degraded data. ${reasons.join("; ")}`,
    );
    console.error(
      `[UnifiedCal] Timeline red during ${step} — retries exhausted, proceeding with degraded data`,
    );
    return true;
  }

  /**
   * Capture functional movement data for PCA axis detection.
   * This is a generic method that works for any segment type.
   */
  private captureFunctionalData(type: "ankle" | "hip" | "generic"): void {
    const funcData = new Map<string, THREE.Vector3[]>();

    this.forEachAssignedDevice((device, seg) => {
      const samples = this.buffers.gyro(device.id);
      if (!samples || samples.length < 30) return;

      const segmentLower = seg.toLowerCase();

      // Filter based on type (case-insensitive matching)
      if (type === "ankle") {
        // Ankle/foot sensors for skate mode
        if (
          segmentLower.includes("foot") ||
          segmentLower.includes("skate") ||
          segmentLower.includes("ankle")
        ) {
          funcData.set(device.id, [...samples]);
        }
      } else if (type === "hip") {
        // Hip/pelvis sensors for core mode
        if (
          segmentLower.includes("hip") ||
          segmentLower.includes("pelvis") ||
          segmentLower.includes("spine")
        ) {
          funcData.set(device.id, [...samples]);
        }
      } else {
        // Generic: capture all connected sensors
        funcData.set(device.id, [...samples]);
      }
    });

    // Merge into functional motion data for PCA
    if (!this.state.functionalMotionData) {
      this.state.functionalMotionData = funcData;
    } else {
      funcData.forEach((samples, key) => {
        this.state.functionalMotionData!.set(key, samples);
      });
    }

    console.debug(
      `[UnifiedCal] Captured ${type} functional data for ${funcData.size} sensors`,
    );
  }

  /**
   * Capture functional data for a strict, filtered subset of segments.
   */
  private captureFunctionalDataByPredicate(
    predicate: (segmentLower: string) => boolean,
    label: string,
  ): void {
    const funcData = new Map<string, THREE.Vector3[]>();
    const { getSegmentForSensor } = useSensorAssignmentStore.getState();

    this.forEachAssignedDevice((device, seg) => {
      const samples = this.buffers.gyro(device.id);
      if (!samples || samples.length < 30) return;

      const segmentLower = seg.toLowerCase();
      if (!predicate(segmentLower)) return;

      funcData.set(device.id, [...samples]);
    });

    // Ã¢â€â‚¬Ã¢â€â‚¬ Trim to stable single-leg-stance window Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // Use the pelvis sensor (if captured) as the stability reference:
    //   - Low gyro magnitude = sensor not moving
    //   - Elevated angle from staticPoseData = weight shifted onto stance leg
    // Combining both signals removes the bilateral weight-shift transients
    // that contaminate PCA with off-axis coronal/transverse gyro.
    // Without pelvis: no trim (fixed-trim fallback via findStableSwingWindow).
    let pelvisDeviceId: string | null = null;
    funcData.forEach((_, deviceId) => {
      if (pelvisDeviceId !== null) return;
      const seg = getSegmentForSensor(deviceId)?.toLowerCase();
      if (seg === "pelvis") pelvisDeviceId = deviceId;
    });

    if (pelvisDeviceId !== null) {
      const pDevId = pelvisDeviceId as string;
      const pelvisGyro = this.buffers.gyro(pDevId);
      const pelvisQuat = this.buffers.quat(pDevId);
      const pelvisStart = this.state.staticPoseData?.get(pDevId);

      if (
        pelvisGyro &&
        pelvisQuat &&
        pelvisStart &&
        pelvisGyro.length === pelvisQuat.length
      ) {
        const { startIdx, endIdx } = findStableSwingWindow(
          pelvisGyro,
          pelvisQuat,
          pelvisStart,
        );

        funcData.forEach((samples, deviceId) => {
          // SKIP pelvis trimming — pelvis needs full motion range for PCA.
          // The swing window is designed for leg sensors (removes off-axis
          // weight-shift transients), but for pelvis the transitions
          // contain the MOST motion signal for axis identification.
          if (deviceId === pDevId) return;
          funcData.set(deviceId, samples.slice(startIdx, endIdx + 1));
        });
      }
    }
    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    if (!this.state.functionalMotionData) {
      this.state.functionalMotionData = funcData;
    } else {
      funcData.forEach((samples, key) => {
        const existing = this.state.functionalMotionData!.get(key);
        if (existing) {
          // ACCUMULATE across steps (e.g. pelvis data from both left/right
          // leg steps). Combined bilateral data gives PCA a stronger
          // motion signal for root segments like pelvis.
          this.state.functionalMotionData!.set(key, [...existing, ...samples]);
        } else {
          this.state.functionalMotionData!.set(key, samples);
        }
      });
    }

    console.debug(
      `[UnifiedCal] Captured ${label} functional data for ${funcData.size} sensors`,
    );
  }

  private computeFinalCalibration(): void {
    const { staticPoseData } = this.state;
    if (!staticPoseData) {
      this.state.error = "Missing static pose data";
      this.state.step = "error";
      return;
    }

    const { devices } = useDeviceRegistry.getState();
    const { getSegmentForSensor } = useSensorAssignmentStore.getState();
    const getSegmentOrUndefined = (sensorId: string) =>
      getSegmentForSensor(sensorId) ?? undefined;

    let totalQuality = 0;
    let calibratedCount = 0;

    this.forEachAssignedDevice((device, segment) => {
      const sensorQuat = staticPoseData.get(device.id);
      if (!sensorQuat) {
        console.warn(
          `[UnifiedCal] WARNING: No static pose data for ${device.id} (${segment}). Skipping.`,
        );
        return;
      }

      // Delegate per-segment GramSchmidt pipeline to extracted function
      const outcome = computeSegmentCalibration({
        deviceId: device.id,
        segment,
        sensorQuat,
        functionalMotionData: this.state.functionalMotionData,
        finalPoseData: this.state.finalPoseData,
        targetNeutralPose: this.targetNeutralPose,
      });

      if (!outcome.ok) {
        this.fail(outcome.error);
        return;
      }

      this.logAudit(
        "GS-APPLY",
        `GramSchmidt calibration for ${segment}`,
        outcome.data.auditData,
      );

      this.state.results.set(segment, outcome.data.result);
      totalQuality += outcome.data.result.quality;
      calibratedCount++;
    });

    if (this.state.step === "error") return;

    this.state.overallQuality =
      calibratedCount > 0 ? totalQuality / calibratedCount : 0;
    this.logAudit("COMPLETE", `Calibration calculated`, {
      quality: this.state.overallQuality,
      count: calibratedCount,
    });
    console.debug(
      `[UnifiedCal] Calibration complete! ${calibratedCount} sensors, quality: ${this.state.overallQuality.toFixed(0)}%`,
    );

    const timelineDiag = this.buffers.getAlignmentDiagnostics();
    this.logAudit(
      "TIMELINE",
      "Dual-sensor alignment diagnostics",
      timelineDiag,
    );
    console.debug(
      `[UnifiedCal] Timeline alignment: pairs=${timelineDiag.totalPairs}, interp=${timelineDiag.interpolatedPairs}, dropped=${timelineDiag.droppedPairs}, avgSkew=${timelineDiag.averageSkewMs.toFixed(2)}ms, maxSkew=${timelineDiag.maxSkewMs.toFixed(2)}ms`,
    );

    // Print Full Report
    this.printAuditReport();

    // Run inter-segment knee consistency check
    checkKneeConsistency(
      this.state.results,
      staticPoseData,
      devices,
      getSegmentOrUndefined,
    );

    // Run SARA hinge axis estimation for dual-sensor joints
    const saraConstraints = computeSARAConstraints(
      this.saraCalibrators,
      this.calibrableJoints,
      this.state.results,
    );
    for (const [jointId, constraint] of saraConstraints) {
      this.state.jointConstraints.set(jointId, constraint);
    }

    // Run IK Validation Loop
    const validationOutcome = runPostCalibrationValidation(
      this.state.results,
      staticPoseData,
      this.state.driftMetrics,
      this.targetNeutralPose,
    );
    if (validationOutcome) {
      this.state.validationResult = validationOutcome.validationResult;
      if (validationOutcome.qualityDowngrade !== null) {
        console.warn(
          `[UnifiedCal] Downgrading quality score from ${this.state.overallQuality.toFixed(0)}% to ${validationOutcome.qualityDowngrade}% due to validation failure.`,
        );
        this.state.overallQuality = validationOutcome.qualityDowngrade;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // CRITICAL: Set gyro bias + VQF heading anchor for each calibrated sensor.
    //
    // Without these, 6-axis (no magnetometer) sensors will yaw-drift
    // ("spin") indefinitely because:
    //   1. setGyroBias subtracts residual DC offset from the (imperfect)
    //      firmware bias correction.
    //   2. setVQFHeadingAnchor gives the VQF a yaw reference to correct
    //      against during rest periods — the ONLY mechanism to fight
    //      heading drift without a magnetometer.
    //
    // CervicalCalibrationFunctions.ts already does this; it was missing
    // from UnifiedCalibration, causing post-calibration spinning.
    // ══════════════════════════════════════════════════════════════════════
    const registry = useDeviceRegistry.getState();
    this.forEachAssignedDevice((device) => {
      // 1. Apply gyro bias (residual DC offset from static pose)
      const biasEstimate = this.state.gyroBiasEstimates.get(device.id);
      if (biasEstimate) {
        registry.setGyroBias(device.id, biasEstimate);
        console.debug(
          `[UnifiedCal] Set gyro bias for ${device.id}: [${biasEstimate.x.toFixed(5)}, ${biasEstimate.y.toFixed(5)}, ${biasEstimate.z.toFixed(5)}]`,
        );
      }

      // 2. Set VQF heading anchor (yaw drift correction reference)
      registry.setVQFHeadingAnchor(device.id);
    });
    console.debug(
      `[UnifiedCal] ✓ Gyro bias + VQF heading anchors applied for ${calibratedCount} sensors`,
    );
  }

  private clearBuffers(): void {
    this.buffers.clear();
  }

  private notifyState(): void {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state });
    }
  }

  getState(): UnifiedCalibrationState {
    return { ...this.state };
  }

  /**
   * Get SARA joint constraints for use with FK solver.
   */
  getJointConstraints(): Map<string, JointConstraintResult> {
    return new Map(this.state.jointConstraints);
  }
}

// Singleton instance
export const unifiedCalibration = new UnifiedCalibration();
