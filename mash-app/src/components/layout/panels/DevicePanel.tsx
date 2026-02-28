/**
 * Device Panel (Quick Win UX)
 * ===========================
 *
 * Streamlined flow with:
 * - Dimmed future sections
 * - Single primary CTA
 * - Removed technical jargon
 * - Clean visual hierarchy
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as THREE from "three";
import {
  Bluetooth,
  Usb,
  Power,
  RefreshCw,
  RotateCcw,
  Target,
  CheckCircle,
  Circle,
  Download,
  AlertTriangle,
} from "lucide-react";
import { useDeviceStore } from "../../../store/useDeviceStore";
import { useDeviceRegistry } from "../../../store/useDeviceRegistry";
import { useNetworkStore } from "../../../store/useNetworkStore";
import { useCalibrationStore } from "../../../store/useCalibrationStore";
import { useSensorAssignmentStore } from "../../../store/useSensorAssignmentStore";
import { useTareStore } from "../../../store/useTareStore";
import { isValidSensorId } from "../../../lib/constants/HardwareRanges";
import { unifiedCalibration } from "../../../calibration/UnifiedCalibration";
import type {
  UnifiedCalibrationState,
  CalibrationStep,
} from "../../../calibration/UnifiedCalibration";
import {
  detectTopology,
  type TopologyDetectionResult,
} from "../../../calibration/TopologyDetector";
import { fkSolver } from "../../../biomech/ForwardKinematics";
import { JOINT_PAIRS } from "../../../calibration/ScoreAnalysis";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/Button";
import { SensorAssignmentPanel } from "../../ui/SensorAssignmentPanel";
import { RecordingControls } from "../../ui/RecordingControls";
import { MagnetometerCalibrationCard } from "../../settings/MagnetometerCalibrationCard";
import { CervicalCalibrationPanel } from "./CervicalCalibrationPanel";
import { LateJoinBanner } from "../../ui/LateJoinBanner";
import { TopologyType } from "../../../biomech/topology/SensorRoles";
import { STEP_DURATIONS } from "../../../calibration/calibrationStepConfig";

const CALIBRATION_MIN_TRUE_SYNC_RATE = 90;
const CALIBRATION_MIN_ALIVE_NODES = 1;
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

// Simplified step instructions
// Segment-specific instructions for functional calibration (generic-flex step)
// Used when single sensor is assigned - tells user exactly what motion to perform
// NOTE: Segment names follow kinematic chain - sensor on segment captures PROXIMAL joint motion:
//   - upper_arm sensor → shoulder joint (arm raises, shoulder flex/ext)
//   - forearm sensor → elbow joint (elbow flex/ext)
//   - thigh sensor → hip joint (free-leg swing, weight shifted to opposite foot first)
//   - tibia sensor → knee joint (knee flex/ext)
const FLEX_INSTRUCTIONS: Record<
  string,
  { title: string; instruction: string; icon: string }
> = {
  // Legs - shift weight first, then freely swing the leg (no weight-shift contamination)
  thigh_l: {
    title: "Left Hip Swing",
    instruction: "Shift onto RIGHT foot, swing LEFT leg forward/back 5×",
    icon: "🦵",
  },
  thigh_r: {
    title: "Right Hip Swing",
    instruction: "Shift onto LEFT foot, swing RIGHT leg forward/back 5×",
    icon: "🦵",
  },
  // Tibia - captures knee motion, but ankle dorsiflexion also works
  tibia_l: {
    title: "Left Knee/Ankle",
    instruction: "Bend knee OR point toes up/down 5×",
    icon: "🦵",
  },
  tibia_r: {
    title: "Right Knee/Ankle",
    instruction: "Bend knee OR point toes up/down 5×",
    icon: "🦵",
  },
  // Foot - ankle motion
  foot_l: {
    title: "Left Ankle",
    instruction: "Point toes up & down 5× (left)",
    icon: "🦶",
  },
  foot_r: {
    title: "Right Ankle",
    instruction: "Point toes up & down 5× (right)",
    icon: "🦶",
  },

  // Arms - upper_arm sensor captures SHOULDER motion (it's on the arm, joint is at shoulder)
  upper_arm_l: {
    title: "Left Shoulder",
    instruction: "Raise & lower LEFT arm 5× (shoulder flex)",
    icon: "💪",
  },
  upper_arm_r: {
    title: "Right Shoulder",
    instruction: "Raise & lower RIGHT arm 5× (shoulder flex)",
    icon: "💪",
  },
  // Forearm - captures ELBOW motion
  forearm_l: {
    title: "Left Elbow",
    instruction: "Bend & extend LEFT elbow 5×",
    icon: "💪",
  },
  forearm_r: {
    title: "Right Elbow",
    instruction: "Bend & extend RIGHT elbow 5×",
    icon: "💪",
  },
  // Hand - captures wrist motion
  hand_l: {
    title: "Left Wrist",
    instruction: "Flex & extend LEFT wrist 5×",
    icon: "✋",
  },
  hand_r: {
    title: "Right Wrist",
    instruction: "Flex & extend RIGHT wrist 5×",
    icon: "✋",
  },

  // Core
  pelvis: {
    title: "Pelvis",
    instruction: "Pelvic tilts (anterior/posterior) 5×",
    icon: "⭕",
  },
  torso: {
    title: "Torso",
    instruction: "Gentle forward/back bending 5×",
    icon: "🔄",
  },
  head: {
    title: "Head/Neck",
    instruction: "Nod head (chin to chest) 5×",
    icon: "🙂",
  },
};

const STEP_INSTRUCTIONS: Record<
  CalibrationStep,
  { title: string; instruction: string; icon: string }
> = {
  idle: { title: "Ready", instruction: "Press Start to begin", icon: "🎯" },
  "warm-up": {
    title: "Initializing",
    instruction: "Stand ready...",
    icon: "⏳",
  },
  "static-pose": {
    title: "Stand Still",
    instruction: "Feet hip-width, arms relaxed, eyes forward, hold still",
    icon: "🧍",
  },
  "leg-left-functional": {
    title: "Left Leg Swing",
    instruction:
      "Shift onto RIGHT foot, swing LEFT leg straight forward/back 10× (sagittal only — no hip circles)",
    icon: "🦵",
  },
  "leg-right-functional": {
    title: "Right Leg Swing",
    instruction:
      "Shift onto LEFT foot, swing RIGHT leg straight forward/back 10× (sagittal only — no hip circles)",
    icon: "🦵",
  },
  "arm-left-functional": {
    title: "Left Arm Movement",
    instruction: "Do 8-10 LEFT elbow bends + shoulder raises, controlled speed",
    icon: "💪",
  },
  "arm-right-functional": {
    title: "Right Arm Movement",
    instruction:
      "Do 8-10 RIGHT elbow bends + shoulder raises, controlled speed",
    icon: "💪",
  },
  "head-functional": {
    title: "Head Movement",
    instruction: "5 nods + 5 gentle left/right turns, avoid shoulder motion",
    icon: "🙂",
  },
  "ankle-flex": {
    title: "Ankle Motion",
    instruction: "Toes up and down 5 times",
    icon: "🦶",
  },
  "hip-rotation": {
    title: "Hip Circle",
    instruction: "Circle leg outward 5 times",
    icon: "⭕",
  },
  "generic-flex": {
    title: "Move Joint",
    instruction: "Full range of motion",
    icon: "↔️",
  },
  "final-pose": {
    title: "Final Check",
    instruction: "Return to neutral stance and hold still",
    icon: "✓",
  },
  verification: {
    title: "Verify",
    instruction: "Move freely to check calibration",
    icon: "🔍",
  },
  "pose-check": {
    title: "Neutral Hold Check",
    instruction: "Stand neutral and steady for 10 seconds",
    icon: "🧍",
  },
  "squat-check": {
    title: "Squat Check",
    instruction: "Perform 3-5 smooth squat reps",
    icon: "🏋️",
  },
  complete: { title: "Done!", instruction: "Ready to record", icon: "✅" },
  error: { title: "Error", instruction: "Try again", icon: "❌" },
};

const getLiveCueForSegment = (segmentId: string): string => {
  if (segmentId.startsWith("tibia_")) {
    return "Deeper knee flexion, keep hip/trunk stable";
  }
  if (segmentId.startsWith("thigh_")) {
    return "More weight on stance leg, bigger free-leg hip swing";
  }
  if (segmentId.startsWith("forearm_")) {
    return "Bigger elbow arc, reduce shoulder compensation";
  }
  if (segmentId.startsWith("upper_arm_")) {
    return "Clear shoulder raise/lower, minimize trunk sway";
  }
  if (segmentId === "head") {
    return "Distinct nod/turns, shoulders stay still";
  }
  if (segmentId.startsWith("foot_")) {
    return "Add stronger ankle dorsiflex/plantarflex cycles";
  }
  return "Increase range and keep motion controlled";
};

const getSegmentBadge = (
  segmentId: string,
): { icon: string; side: string; label: string } => {
  const side = segmentId.endsWith("_l")
    ? "L"
    : segmentId.endsWith("_r")
      ? "R"
      : "C";

  if (segmentId.startsWith("tibia_") || segmentId.startsWith("thigh_")) {
    return { icon: "🦵", side, label: "Leg" };
  }
  if (
    segmentId.startsWith("forearm_") ||
    segmentId.startsWith("upper_arm_") ||
    segmentId.startsWith("hand_")
  ) {
    return { icon: "💪", side, label: "Arm" };
  }
  if (segmentId.startsWith("foot_")) {
    return { icon: "🦶", side, label: "Foot" };
  }
  if (segmentId === "head") {
    return { icon: "🙂", side: "C", label: "Head" };
  }
  if (segmentId === "pelvis" || segmentId === "torso") {
    return { icon: "🧍", side: "C", label: "Core" };
  }

  return { icon: "📍", side, label: "Segment" };
};

type TrustLevel = "ready" | "caution" | "not-ready";

type RetryRegion = "legs" | "arms" | "head" | "core";

const RETRY_REGION_LABELS: Record<RetryRegion, string> = {
  legs: "Legs",
  arms: "Arms",
  head: "Head",
  core: "Core",
};

const extractFailureTags = (reasons: string[]): string[] => {
  const tags = new Set<string>();

  for (const rawReason of reasons) {
    const reason = rawReason.toLowerCase();

    if (
      reason.includes("movement quality") ||
      reason.includes("not enough movement") ||
      reason.includes("insufficient movement")
    ) {
      tags.add("Low Movement");
    }
    if (
      reason.includes("jitter") ||
      reason.includes("smooth") ||
      reason.includes("unstable")
    ) {
      tags.add("Unstable Motion");
    }
    if (
      reason.includes("timing") ||
      reason.includes("skew") ||
      reason.includes("dropped")
    ) {
      tags.add("Timing Quality");
    }
    if (reason.includes("retry cue") || reason.includes("repeat")) {
      tags.add("Needs Repeat");
    }
  }

  return Array.from(tags);
};

const segmentToRetryRegion = (segmentId: string): RetryRegion | null => {
  const s = segmentId.toLowerCase();
  if (
    s.startsWith("thigh_") ||
    s.startsWith("tibia_") ||
    s.startsWith("foot_")
  ) {
    return "legs";
  }
  if (
    s.startsWith("upper_arm_") ||
    s.startsWith("forearm_") ||
    s.startsWith("hand_")
  ) {
    return "arms";
  }
  if (s === "head") return "head";
  if (s === "pelvis" || s === "torso") return "core";
  return null;
};

const TRUST_STYLES: Record<
  TrustLevel,
  { label: string; badge: string; panel: string; text: string }
> = {
  ready: {
    label: "Ready",
    badge: "bg-success/20 text-success border-success/30",
    panel: "border-success/40 bg-success/10",
    text: "text-success",
  },
  caution: {
    label: "Caution",
    badge: "bg-warning/20 text-warning border-warning/30",
    panel: "border-warning/40 bg-warning/10",
    text: "text-warning",
  },
  "not-ready": {
    label: "Not Ready",
    badge: "bg-danger/20 text-danger border-danger/30",
    panel: "border-danger/40 bg-danger/10",
    text: "text-danger",
  },
};

// Section component for consistent styling (Moved outside to prevent re-mounts)
const Section = ({
  step,
  title,
  completed,
  active,
  rightContent,
  children,
}: {
  step: number;
  title: string;
  completed?: boolean;
  active?: boolean;
  rightContent?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div
    className={cn(
      "rounded-lg border p-3 transition-all",
      completed
        ? "border-success/30 bg-success/5"
        : active
          ? "border-accent/50 bg-accent/5"
          : "border-white/10 bg-white/2 opacity-50",
    )}
  >
    <div className="flex items-center gap-2 mb-2">
      <div
        className={cn(
          "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold",
          completed
            ? "bg-success text-white"
            : active
              ? "bg-accent text-white"
              : "bg-white/20 text-white/60",
        )}
      >
        {completed ? <CheckCircle className="w-3 h-3" /> : step}
      </div>
      <span
        className={cn(
          "text-xs font-semibold uppercase tracking-wider",
          completed ? "text-success" : active ? "text-accent" : "text-white/40",
        )}
      >
        {title}
      </span>
      {rightContent && <div className="ml-auto">{rightContent}</div>}
    </div>
    {children}
  </div>
);

export function DevicePanel() {
  const {
    connect,
    disconnect,
    isConnected,
    isScanning,
    lastKnownDevice,
    connectionType,
    syncReady,
    syncState,
  } = useDeviceStore();

  // Use unified assignment store
  const { assignments, activeTopology, autoAssignByName } =
    useSensorAssignmentStore();

  const {
    calibrationStep,
    targetNeutralPose,
    setCalibrationStep,
    reset: resetCalibration,
    setCalibrationMode,
    setHeadingResetOffset,
    setOverallQuality,
    overallQuality,
  } = useCalibrationStore();

  const [unifiedState, setUnifiedState] =
    useState<UnifiedCalibrationState | null>(null);
  const [calMode, setCalMode] = useState<"full" | "cervical">("full");
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [activeRetryRegions, setActiveRetryRegions] = useState<RetryRegion[]>(
    [],
  );
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastAutoExportFailureKeyRef = useRef<string | null>(null);

  const hasKnownDevice = !!lastKnownDevice;
  const isCalibrated = calibrationStep === "calibrated";

  const connectedSensorCountFromRegistry = useDeviceRegistry((state) => {
    const extractNumericId = (id: string): number => {
      const lastUnderscore = id.lastIndexOf("_");
      if (lastUnderscore >= 0) {
        return parseInt(id.substring(lastUnderscore + 1), 10);
      }
      const legacy = id.startsWith("sensor_") ? id.substring(7) : id;
      return parseInt(legacy, 10);
    };

    let count = 0;
    state.devices.forEach((device, id) => {
      const numericId = extractNumericId(id);
      if (!device.isConnected || Number.isNaN(numericId)) return;
      if (!isValidSensorId(numericId) || numericId === 73) return;
      count++;
    });
    return count;
  });

  const topologySensorCount = useNetworkStore((state) => {
    let count = 0;
    state.nodes.forEach((node) => {
      const nodeSensorCount =
        typeof node.sensorCount === "number" && node.sensorCount > 0
          ? node.sensorCount
          : node.sensors.size;
      if (nodeSensorCount > 0) count += nodeSensorCount;
    });
    return count;
  });

  const connectedSensorCount =
    topologySensorCount > 0
      ? topologySensorCount
      : connectedSensorCountFromRegistry;

  const detectedTopology = topologyResult?.topology || activeTopology;

  const calibrationPreflight = useMemo(() => {
    const assignedCount = assignments.size;
    const aliveNodes =
      syncState?.nodes.filter((node) => node.alive).length || 0;
    const trueSyncRate = syncState?.syncBuffer.trueSyncRate || 0;

    const connectedAssignedSegments = new Set<string>();
    const deviceRegistry = useDeviceRegistry.getState().devices;
    assignments.forEach((assignment, deviceId) => {
      if (deviceRegistry.has(deviceId)) {
        connectedAssignedSegments.add(assignment.segmentId.toLowerCase());
      }
    });

    const isFullBodyFlow = detectedTopology === TopologyType.FULL_BODY;
    const missingFullBodySegments = isFullBodyFlow
      ? FULL_BODY_REQUIRED_SEGMENTS.filter(
          (segmentId) => !connectedAssignedSegments.has(segmentId),
        )
      : [];

    const checks = [
      {
        label: "Gateway connected",
        passed: isConnected,
        detail: isConnected ? "connected" : "offline",
      },
      {
        label: "Assignments present",
        passed: assignedCount > 0,
        detail: `${assignedCount} assigned`,
      },
      {
        label: "Sync readiness",
        passed: syncReady,
        detail: syncState?.phase || "idle",
      },
      {
        label: `True sync ≥ ${CALIBRATION_MIN_TRUE_SYNC_RATE}%`,
        passed: trueSyncRate >= CALIBRATION_MIN_TRUE_SYNC_RATE,
        detail: `${trueSyncRate.toFixed(1)}%`,
      },
      {
        label: `Alive nodes ≥ ${CALIBRATION_MIN_ALIVE_NODES}`,
        passed: aliveNodes >= CALIBRATION_MIN_ALIVE_NODES,
        detail: `${aliveNodes} alive`,
      },
    ];

    if (isFullBodyFlow) {
      checks.push({
        label: "Full-body required segments",
        passed: missingFullBodySegments.length === 0,
        detail:
          missingFullBodySegments.length === 0
            ? `${FULL_BODY_REQUIRED_SEGMENTS.length}/${FULL_BODY_REQUIRED_SEGMENTS.length}`
            : `${FULL_BODY_REQUIRED_SEGMENTS.length - missingFullBodySegments.length}/${FULL_BODY_REQUIRED_SEGMENTS.length}`,
      });
    }

    const failedChecks = checks.filter((check) => !check.passed);

    return {
      checks,
      failedChecks,
      canStart: failedChecks.length === 0,
      missingFullBodySegments,
    };
  }, [
    assignments,
    detectedTopology,
    isConnected,
    registeredDeviceCount,
    syncReady,
    syncState,
  ]);

  // Subscribe to device registry changes to trigger auto-assignment
  // This ensures auto-assign runs when new devices connect
  const registeredDeviceCount = useDeviceRegistry(
    (state) => state.devices.size,
  );

  // Auto-Assign Logic: When new devices appear, try to assign them
  // This effect runs whenever the device registry changes
  useEffect(() => {
    if (!isConnected) return;

    const devices = useDeviceRegistry.getState().devices;

    // Sort device IDs for consistent sequential indexing
    // This ensures deterministic processing order while assigning by name.
    const sortedDeviceIds = Array.from(devices.keys()).sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, "")) || 0;
      const numB = parseInt(b.replace(/\D/g, "")) || 0;
      return numA - numB;
    });

    sortedDeviceIds.forEach((deviceId, index) => {
      const device = devices.get(deviceId);
      if (!device) return;

      // Skip if already assigned
      if (assignments.has(device.id)) return;

      // 1. Try Provisioned Name
      if (autoAssignByName(device.id, device.name)) {
        console.debug(`[AutoAssign] Assigned ${device.name} by name`);
        return;
      }
    });
  }, [
    isConnected,
    assignments,
    autoAssignByName,
    registeredDeviceCount, // Re-run when devices are added/removed
  ]);

  // Workflow states
  const hasAssignments = assignments.size > 0;

  // Topology detection
  const topologyResult: TopologyDetectionResult | null = useMemo(() => {
    const segments = Array.from(assignments.values()).map((a) => a.segmentId);
    if (segments.length === 0) return null;
    return detectTopology(segments);
  }, [assignments]);

  // Calibration animation loop
  const processCalibrationFrame = useCallback(
    (timestamp: number) => {
      const deltaTime = lastTimeRef.current
        ? (timestamp - lastTimeRef.current) / 1000
        : 0.016;
      lastTimeRef.current = timestamp;

      unifiedCalibration.processFrame(deltaTime);
      const state = unifiedCalibration.getState();

      // Log step transitions
      if (state.step !== unifiedState?.step) {
        console.debug(
          `[Calibration] Step: ${unifiedState?.step || "idle"} → ${state.step}`,
          `| progress: ${(state.stepProgress * 100).toFixed(0)}%, quality: ${state.overallQuality.toFixed(0)}%`,
        );
      }

      setUnifiedState(state);

      if (state.step === "complete") {
        setIsCalibrating(false);
        setActiveRetryRegions([]);
        setCalibrationStep("calibrated");

        // DIAGNOSTIC: Log calibration results
        console.debug(
          "[DevicePanel] Calibration COMPLETE. Results count:",
          state.results.size,
        );
        if (state.results.size === 0) {
          console.error(
            "[DevicePanel] WARNING: No calibration results! This will break bone orientation.",
          );
        }

        const resultsForStore = new Map<
          string,
          {
            offset: THREE.Quaternion;
            mountingTare?: THREE.Quaternion;
            headingTare?: THREE.Quaternion;
          }
        >();
        state.results.forEach((result, segmentId) => {
          resultsForStore.set(segmentId, {
            offset: result.offset,
            mountingTare: result.mountingTare,
            headingTare: result.headingTare,
          });
        });

        useTareStore.getState().applyCalibrationResults(resultsForStore);

        // Save quality score to store
        setOverallQuality(state.overallQuality);

        // Apply SARA joint constraints to FK solver
        const jointConstraints = unifiedCalibration.getJointConstraints();
        if (jointConstraints.size > 0) {
          console.debug(
            `[DevicePanel] Applying ${jointConstraints.size} SARA joint constraints to FK solver`,
          );
          jointConstraints.forEach((constraint, jointId) => {
            // Find the distal bone for this joint
            const jointDef = JOINT_PAIRS.find((j) => j.jointId === jointId);
            if (
              jointDef &&
              constraint.hingeAxisProximal &&
              constraint.confidence > 0.6
            ) {
              // Apply to the distal (child) bone - axis is in proximal frame
              fkSolver.setHingeConstraint(
                jointDef.distalSegment.toUpperCase(),
                constraint.hingeAxisProximal,
                constraint.confidence,
              );
            }
          });
        }

        // NEW: Auto-Scaling Verification (Log Bone Lengths)
        if (state.scoreResults && state.scoreResults.size > 0) {
          console.debug(
            `[DevicePanel] SCoRE Results available: ${state.scoreResults.size}. Calculating bone lengths...`,
          );
          const scoreResults = state.scoreResults;

          // Define segments to measure (Simplified for leg)
          const segmentsToMeasure = [
            {
              name: "Thigh R",
              proximal: "hip_r",
              distal: "knee_r",
              distalIsProximalInSegment: true,
            },
            {
              name: "Thigh L",
              proximal: "hip_l",
              distal: "knee_l",
              distalIsProximalInSegment: true,
            },
            {
              name: "Shin R",
              proximal: "knee_r",
              distal: "ankle_r",
              distalIsProximalInSegment: true,
            },
            {
              name: "Shin L",
              proximal: "knee_l",
              distal: "ankle_l",
              distalIsProximalInSegment: true,
            },
          ];

          segmentsToMeasure.forEach((seg) => {
            const proxJoint = scoreResults.get(seg.proximal);
            const distJoint = scoreResults.get(seg.distal);

            if (proxJoint && distJoint) {
              // Proximal point: Joint center of 'proximal' joint (Hip) in Distal segment (Thigh) frame -> jointCenterDistal
              const p1 = proxJoint.jointCenterDistal;
              // Distal point: Joint center of 'distal' joint (Knee) in Proximal segment (Thigh) frame -> jointCenterProximal
              const p2 = distJoint.jointCenterProximal;

              const length = p1.distanceTo(p2);
              console.debug(
                `[AutoCal] Scaled ${seg.name}: ${length.toFixed(1)}mm (Confidence: ${((proxJoint.confidence + distJoint.confidence) / 2).toFixed(2)})`,
              );
            }
          });
        }

        // LEGACY STORE UPDATE REMOVED
        // We now rely solely on useTareStore for orientation data.
        // useCalibrationStore is kept only for UI state management (step progress etc).
        // applyUnifiedResults(legacyResults);
      } else if (state.step === "error") {
        setIsCalibrating(false);
      }

      if (
        isCalibrating &&
        state.step !== "complete" &&
        state.step !== "error"
      ) {
        animationFrameRef.current = requestAnimationFrame(
          processCalibrationFrame,
        );
      }
    },
    [
      isCalibrating,
      setCalibrationStep,
      setHeadingResetOffset,
      setOverallQuality,
    ],
  );

  useEffect(() => {
    if (isCalibrating) {
      lastTimeRef.current = 0;
      animationFrameRef.current = requestAnimationFrame(
        processCalibrationFrame,
      );
    }
    return () => {
      if (animationFrameRef.current)
        cancelAnimationFrame(animationFrameRef.current);
      // Safety: Only cancel if calibration is actually still in progress
      // Don't cancel if already complete/error (prevents false cancel on state transitions)
      const currentState = unifiedCalibration.getState();
      if (
        isCalibrating &&
        currentState.step !== "complete" &&
        currentState.step !== "error"
      ) {
        console.debug(
          "[DevicePanel] Unmounting during active calibration - cancelling",
        );
        unifiedCalibration.cancel();
      }
    };
  }, [isCalibrating, processCalibrationFrame]);

  const handleStartCalibration = () => {
    if (!hasAssignments) return;

    if (!calibrationPreflight.canStart) {
      const failureSummary = calibrationPreflight.failedChecks
        .map((check) => `${check.label} (${check.detail})`)
        .join("; ");
      setPreflightError(`Calibration preflight failed: ${failureSummary}`);
      return;
    }

    setPreflightError(null);

    console.debug(`[DevicePanel] CALIBRATION START`);

    // CRITICAL: Ensure we have the model's bind pose targets
    if (!targetNeutralPose || targetNeutralPose.size === 0) {
      console.error(
        "[DevicePanel] CRITICAL: Target Neutral Pose map is empty! Calibration would fallback to T-Pose.",
      );
      // We could block here, but for now let's make it very visible
    }

    setCalibrationMode("research_strict");
    setActiveRetryRegions([]);
    console.debug(
      `[DevicePanel] Topology: ${detectedTopology}, Assignments: ${assignments.size}, Mode: research_strict`,
    );
    setIsCalibrating(true);

    // RESET: Ensure a clean slate for calibration (prevent accumulated tares)
    useTareStore.getState().resetAll();
    resetCalibration(); // Reset CalibrationStore state too

    unifiedCalibration.start(
      (state) => setUnifiedState(state),
      detectedTopology,
      targetNeutralPose,
    );
  };

  const handleRetryFailedRegion = useCallback(() => {
    if (!hasAssignments) return;
    if (!calibrationPreflight.canStart) {
      const failureSummary = calibrationPreflight.failedChecks
        .map((check) => `${check.label} (${check.detail})`)
        .join("; ");
      setPreflightError(`Calibration preflight failed: ${failureSummary}`);
      return;
    }

    if (retryRegionScope.length === 0) {
      handleStartCalibration();
      return;
    }

    const regionList = retryRegionScope;
    const retryFlow = unifiedCalibration.buildTargetedRetryFlow(regionList);

    setPreflightError(null);
    setCalibrationMode("research_strict");
    setActiveRetryRegions(regionList);
    setIsCalibrating(true);

    useTareStore.getState().resetAll();
    resetCalibration();

    unifiedCalibration.start(
      (state) => setUnifiedState(state),
      detectedTopology,
      targetNeutralPose,
      retryFlow,
    );
  }, [
    calibrationPreflight,
    detectedTopology,
    handleStartCalibration,
    hasAssignments,
    retryRegionScope,
    resetCalibration,
    setCalibrationMode,
    targetNeutralPose,
  ]);

  const currentStep = unifiedState?.step || "idle";
  const baseStepInfo = STEP_INSTRUCTIONS[currentStep];
  const stepProgress = unifiedState?.stepProgress || 0;
  const countdown = unifiedState?.countdown || 0;
  const flowSteps = unifiedCalibration.currentFlow;

  // Dynamic instruction for generic-flex: use segment-specific instructions when single sensor
  const stepInfo = useMemo(() => {
    if (currentStep !== "generic-flex") return baseStepInfo;

    // Get the assigned segment for single-sensor calibration
    const assignedSegments = Array.from(assignments.values());
    if (assignedSegments.length === 1) {
      const segmentId = assignedSegments[0].segmentId;
      const flexInfo = FLEX_INSTRUCTIONS[segmentId];
      if (flexInfo) return flexInfo;
    }

    return baseStepInfo; // Fallback to generic
  }, [currentStep, baseStepInfo, assignments]);

  const strictGateFailures = useMemo(() => {
    if (!unifiedState?.jointGateResults) return [];
    return Array.from(unifiedState.jointGateResults.values()).filter(
      (gate) => gate.status === "RETRY_REQUIRED",
    );
  }, [unifiedState]);

  const liveFunctionalConfidence = useMemo(() => {
    if (!unifiedState?.liveFunctionalConfidence) return [];

    return Array.from(unifiedState.liveFunctionalConfidence.entries())
      .map(([segmentId, data]) => ({ segmentId, ...data }))
      .sort((a, b) => a.confidence - b.confidence);
  }, [unifiedState]);

  const hasStrictFailure =
    unifiedState?.step === "error" && strictGateFailures.length > 0;

  const failureTags = useMemo(() => {
    const reasons: string[] = [];
    strictGateFailures.forEach((gate) => {
      if (gate.reason) reasons.push(gate.reason);
    });

    const artifact = unifiedCalibration.getCalibrationQcArtifact();
    (artifact.timeline?.warnings || []).forEach((warning) => reasons.push(warning));
    (artifact.functionalChecks || [])
      .filter((check) => check.status !== "pass")
      .forEach((check) => {
        if (check.summary) reasons.push(check.summary);
        if (check.recommendation) reasons.push(check.recommendation);
      });

    return extractFailureTags(reasons);
  }, [strictGateFailures, unifiedState]);

  const timelineWarnings = useMemo(() => {
    if (!unifiedState) return [] as string[];
    const artifact = unifiedCalibration.getCalibrationQcArtifact();
    return artifact.timeline?.warnings || [];
  }, [unifiedState]);

  const functionalCheckWarnings = useMemo(() => {
    if (!unifiedState) return [] as string[];
    const artifact = unifiedCalibration.getCalibrationQcArtifact();
    return (artifact.functionalChecks || [])
      .filter((check) => check.status !== "pass")
      .map((check) => check.recommendation || check.summary);
  }, [unifiedState]);

  const hasFunctionalCheckFailure = useMemo(() => {
    if (!unifiedState) return false;
    const artifact = unifiedCalibration.getCalibrationQcArtifact();
    return (artifact.functionalChecks || []).some(
      (check) => check.status === "fail",
    );
  }, [unifiedState]);

  const retryRegionScope = useMemo(() => {
    if (!unifiedState) return [] as RetryRegion[];
    const artifact = unifiedCalibration.getCalibrationQcArtifact();
    const regions = new Set<RetryRegion>();

    artifact.criticalJointFailures.forEach((segmentId) => {
      const mapped = segmentToRetryRegion(segmentId);
      if (mapped) regions.add(mapped);
    });

    (artifact.functionalChecks || []).forEach((check) => {
      if (check.status === "fail" && check.failedRegions) {
        check.failedRegions.forEach((region) => regions.add(region));
      }
    });

    return Array.from(regions);
  }, [unifiedState]);

  const trustStatus = useMemo(() => {
    const reasons: string[] = [];

    if (!isConnected) {
      reasons.push("Gateway is not connected.");
    }
    if (assignments.size === 0) {
      reasons.push("No sensors are assigned to body segments.");
    }
    if (isConnected && assignments.size > 0 && !calibrationPreflight.canStart) {
      reasons.push("Calibration preflight checks are incomplete.");
    }

    if (reasons.length > 0) {
      return {
        level: "not-ready" as TrustLevel,
        summary: "Setup is incomplete.",
        reasons,
      };
    }

    if (hasFunctionalCheckFailure) {
      return {
        level: "not-ready" as TrustLevel,
        summary: "Post-calibration checks failed.",
        reasons:
          functionalCheckWarnings.length > 0
            ? functionalCheckWarnings
            : [
                "Repeat pose-check and squat-check before recording critical data.",
              ],
      };
    }

    const cautionReasons: string[] = [];
    if (timelineWarnings.length > 0) {
      cautionReasons.push("Timing quality is degraded; measurements may be less stable.");
    }
    cautionReasons.push(...functionalCheckWarnings);
    if (isCalibrated && overallQuality > 0 && overallQuality < 75) {
      cautionReasons.push("Calibration quality is below optimal threshold.");
    }

    if (cautionReasons.length > 0) {
      return {
        level: "caution" as TrustLevel,
        summary: "System is usable with caution.",
        reasons: cautionReasons,
      };
    }

    return {
      level: "ready" as TrustLevel,
      summary: "System is ready for high-confidence capture.",
      reasons: [] as string[],
    };
  }, [
    assignments.size,
    calibrationPreflight.canStart,
    isCalibrated,
    isConnected,
    overallQuality,
    functionalCheckWarnings,
    hasFunctionalCheckFailure,
    timelineWarnings.length,
  ]);

  const nextBestAction = useMemo(() => {
    if (!isConnected) {
      return {
        label: "Connect Gateway",
        onClick: () => {
          void connect();
        },
        disabled: isScanning,
      };
    }

    if (assignments.size === 0) {
      return {
        label: "Assign Sensors",
        onClick: () => undefined,
        disabled: true,
      };
    }

    if (!isCalibrating && !isCalibrated && calibrationPreflight.canStart) {
      return {
        label: "Start Calibration",
        onClick: handleStartCalibration,
        disabled: false,
      };
    }

    if (!isCalibrating && (hasStrictFailure || hasFunctionalCheckFailure)) {
      return {
        label: "Retry Failed Region",
        onClick: handleRetryFailedRegion,
        disabled: false,
      };
    }

    return {
      label: "Review Preflight",
      onClick: () => undefined,
      disabled: true,
    };
  }, [
    assignments.size,
    calibrationPreflight.canStart,
    connect,
    handleRetryFailedRegion,
    handleStartCalibration,
    hasFunctionalCheckFailure,
    hasStrictFailure,
    isCalibrated,
    isCalibrating,
    isConnected,
    isScanning,
  ]);

  const estimatedTimeLeftSec = useMemo(() => {
    if (!isCalibrating || !unifiedState) return 0;
    const currentIdx = flowSteps.indexOf(currentStep);
    if (currentIdx < 0) return Math.max(0, countdown);

    let remaining = Math.max(0, countdown);
    for (let i = currentIdx + 1; i < flowSteps.length; i++) {
      const step = flowSteps[i];
      if (step === "complete" || step === "error") continue;
      remaining += STEP_DURATIONS[step] || 0;
    }

    return Math.ceil(remaining);
  }, [countdown, currentStep, flowSteps, isCalibrating, unifiedState]);

  const downloadFile = useCallback((fileName: string, content: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleExportQcJson = useCallback(() => {
    const artifact = unifiedCalibration.getCalibrationQcArtifact();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadFile(
      `calibration-qc-${stamp}.json`,
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
  }, [downloadFile]);

  const handleExportQcMarkdown = useCallback(() => {
    const markdown = unifiedCalibration.getCalibrationQcMarkdown();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadFile(`calibration-qc-${stamp}.md`, markdown);
  }, [downloadFile]);

  useEffect(() => {
    if (!hasStrictFailure || !unifiedState) return;

    const failureKey = `${unifiedState.criticalJointFailures.join("|")}::${unifiedState.error || ""}`;
    if (lastAutoExportFailureKeyRef.current === failureKey) return;

    lastAutoExportFailureKeyRef.current = failureKey;

    const artifact = unifiedCalibration.getCalibrationQcArtifact();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadFile(
      `calibration-qc-auto-${stamp}.json`,
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
  }, [downloadFile, hasStrictFailure, unifiedState]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header - Status Bar */}
      <div className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {connectionType === "serial" ? (
              <Usb className="h-4 w-4 text-accent" />
            ) : (
              <Bluetooth className="h-4 w-4 text-accent" />
            )}
            <span className="text-sm font-semibold text-white">
              Quick Start
            </span>
          </div>
          <div
            className={cn(
              "flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full",
              isConnected
                ? "bg-green-500/20 text-green-400 border border-green-500/30"
                : "bg-white/10 text-white/40",
            )}
          >
            <Circle
              className={cn(
                "w-1.5 h-1.5 fill-current",
                isConnected && "animate-pulse",
              )}
            />
            {isConnected ? "Connected" : "Offline"}
          </div>
        </div>

        {!isConnected && (
          <Button
            variant="gradient"
            size="sm"
            onClick={() => connect()}
            disabled={isScanning}
            className="w-full"
          >
            {isScanning ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                Scanning...
              </>
            ) : hasKnownDevice ? (
              <>
                {connectionType === "serial" ? (
                  <Usb className="h-4 w-4 mr-2" />
                ) : (
                  <Bluetooth className="h-4 w-4 mr-2" />
                )}
                Reconnect
              </>
            ) : (
              <>
                {connectionType === "serial" ? (
                  <Usb className="h-4 w-4 mr-2" />
                ) : (
                  <Bluetooth className="h-4 w-4 mr-2" />
                )}
                Connect Gateway
              </>
            )}
          </Button>
        )}
      </div>

      {/* Content - Step-based workflow */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Late-join pending nodes banner */}
        {isConnected && <LateJoinBanner />}

        {/* Step 1: Assign Sensors */}
        <Section
          step={1}
          title="Assign Sensors"
          completed={hasAssignments}
          active={isConnected && !hasAssignments}
          rightContent={
            <span className="text-[10px] font-semibold text-white/80">
              {connectedSensorCount} Connected
            </span>
          }
        >
          {isConnected ? (
            <SensorAssignmentPanel />
          ) : (
            <p className="text-[10px] text-white/40">
              Connect to assign sensors
            </p>
          )}
        </Section>

        {/* Step 2: Calibrate */}
        <Section
          step={2}
          title="Calibrate"
          completed={isCalibrated}
          active={hasAssignments && !isCalibrated}
        >
          {/* Mode Switching Tabs */}
          <div className="flex p-1 mb-4 bg-gray-800 rounded-lg">
            <button
              className={cn(
                "flex-1 py-1.5 text-xs font-medium rounded-md transition-all",
                calMode === "full"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-gray-400 hover:text-gray-200",
              )}
              onClick={() => setCalMode("full")}
            >
              Full Body
            </button>
            <button
              className={cn(
                "flex-1 py-1.5 text-xs font-medium rounded-md transition-all",
                calMode === "cervical"
                  ? "bg-purple-600 text-white shadow-sm"
                  : "text-gray-400 hover:text-gray-200",
              )}
              onClick={() => setCalMode("cervical")}
            >
              Cervical (Head)
            </button>
          </div>
          {calMode === "cervical" ? (
            <CervicalCalibrationPanel />
          ) : (
            <>
              <div
                className={cn(
                  "mb-3 p-2.5 rounded-lg border",
                  TRUST_STYLES[trustStatus.level].panel,
                )}
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-white/85">
                    Trust Status
                  </div>
                  <span
                    className={cn(
                      "text-[10px] px-2 py-0.5 rounded-full border font-semibold",
                      TRUST_STYLES[trustStatus.level].badge,
                    )}
                  >
                    {TRUST_STYLES[trustStatus.level].label}
                  </span>
                </div>
                <p className="text-[10px] text-white/85 mb-1.5">
                  {trustStatus.summary}
                </p>
                {trustStatus.reasons.length > 0 && (
                  <div className="space-y-1 mb-2">
                    {trustStatus.reasons.slice(0, 2).map((reason, idx) => (
                      <div
                        key={`${reason}-${idx}`}
                        className={cn(
                          "text-[9px]",
                          TRUST_STYLES[trustStatus.level].text,
                        )}
                      >
                        {reason}
                      </div>
                    ))}
                  </div>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  className="w-full text-[10px]"
                  onClick={nextBestAction.onClick}
                  disabled={nextBestAction.disabled}
                >
                  {nextBestAction.label}
                </Button>
              </div>

              {hasStrictFailure && (
                <div className="mb-3 p-2.5 rounded-lg border border-danger/40 bg-danger/10">
                  <div className="flex items-center gap-2 text-danger mb-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide">
                      Research Strict Gate Failed
                    </span>
                  </div>
                  <p className="text-[10px] text-white/80 mb-2">
                    {unifiedState?.error ||
                      "One or more critical joints failed quality gates."}
                  </p>
                  {failureTags.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {failureTags.slice(0, 5).map((tag) => (
                        <span
                          key={tag}
                          className="text-[9px] px-2 py-0.5 rounded-full border border-danger/35 bg-danger/15 text-danger/95 font-medium"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="space-y-1 mb-2">
                    {strictGateFailures.slice(0, 5).map((gate) => (
                      <div
                        key={gate.segmentId}
                        className="text-[10px] text-white/75"
                      >
                        <span className="font-medium text-danger/90">
                          {gate.segmentId}
                        </span>
                        {`: ${gate.reason || "retry required"}`}
                      </div>
                    ))}
                  </div>
                  {retryRegionScope.length > 0 && (
                    <div className="mb-2">
                      <span className="text-[10px] px-2 py-0.5 rounded-full border border-warning/40 bg-warning/15 text-warning font-semibold">
                        Targeted Retry Scope: {retryRegionScope.map((region) => RETRY_REGION_LABELS[region]).join(", ")}
                      </span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 text-[10px]"
                      onClick={handleRetryFailedRegion}
                    >
                      {retryRegionScope.length > 0
                        ? "Retry Failed Region"
                        : "Restart Calibration"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 text-[10px]"
                      onClick={handleExportQcJson}
                    >
                      <Download className="h-3 w-3 mr-1" />
                      Export QC JSON
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 text-[10px]"
                      onClick={handleExportQcMarkdown}
                    >
                      <Download className="h-3 w-3 mr-1" />
                      Export QC MD
                    </Button>
                  </div>
                </div>
              )}

              {timelineWarnings.length > 0 && (
                <div className="mb-3 p-2.5 rounded-lg border border-warning/40 bg-warning/10">
                  <div className="flex items-center gap-2 text-warning mb-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide">
                      Timeline Quality Warnings
                    </span>
                  </div>
                  <div className="space-y-1">
                    {timelineWarnings.slice(0, 3).map((warning, idx) => (
                      <div key={`${warning}-${idx}`} className="text-[10px] text-white/80">
                        {warning}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Mode Toggle inside Full Body (Optional, or just header above?) - lets put header above */}
              {isCalibrating && unifiedState ? (
                // Active calibration UI
                <div className="space-y-3">
                  <div className="p-3 rounded-lg border border-accent/30 bg-accent/10 text-center">
                    <div className="text-3xl mb-1">{stepInfo.icon}</div>
                    <div className="text-sm font-bold text-accent">
                      {stepInfo.title}
                    </div>
                    <div className="text-[11px] text-white/70">
                      {stepInfo.instruction}
                    </div>
                    <div className="mt-1 text-[10px] text-white/65">
                      Est. time left: ~{Math.max(0, estimatedTimeLeftSec)}s
                    </div>
                    {activeRetryRegions.length > 0 && (
                      <div className="mt-2 flex justify-center">
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-warning/40 bg-warning/15 text-warning font-semibold">
                          Targeted Retry: {activeRetryRegions.map((region) => RETRY_REGION_LABELS[region]).join(", ")}
                        </span>
                      </div>
                    )}
                    {countdown > 0 && (
                      <div className="text-2xl font-mono text-accent font-bold mt-2 animate-pulse">
                        {Math.ceil(countdown)}s
                      </div>
                    )}
                    <progress
                      className="mt-3 w-full h-1.5 overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-white/10 [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
                      max={100}
                      value={Math.max(0, Math.min(100, stepProgress))}
                    />
                  </div>

                  {/* Progress dots */}
                  <div className="flex justify-center gap-1">
                    {flowSteps
                      .filter((s) => s !== "complete" && s !== "error")
                      .map((step, idx) => (
                        <div
                          key={step}
                          className={cn(
                            "w-2 h-2 rounded-full",
                            idx < flowSteps.indexOf(currentStep)
                              ? "bg-success"
                              : step === currentStep
                                ? "bg-accent animate-pulse"
                                : "bg-white/20",
                          )}
                        />
                      ))}
                  </div>

                  {liveFunctionalConfidence.length > 0 && (
                    <div className="p-2 rounded-lg border border-white/15 bg-white/5">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-white/80 mb-1.5">
                        Live Movement Quality
                      </div>
                      <div className="space-y-1">
                        {liveFunctionalConfidence.slice(0, 6).map((entry) => {
                          const confidencePct = Math.round(
                            entry.confidence * 100,
                          );
                          const targetPct = Math.round(entry.target * 100);
                          const isReady = entry.confidence >= entry.target;
                          const hasSamples = entry.sampleCount >= 30;
                          const showCue = hasSamples && !isReady;
                          const badge = getSegmentBadge(entry.segmentId);

                          return (
                            <div
                              key={entry.segmentId}
                              className={cn(
                                "text-[10px] rounded px-1.5 py-1 border",
                                showCue
                                  ? "border-danger/40 bg-danger/15"
                                  : "border-white/10 bg-transparent",
                              )}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-white/85 flex items-center gap-1">
                                  <span>{badge.icon}</span>
                                  <span className="text-white/60 font-medium">
                                    {badge.side}
                                  </span>
                                  <span>{entry.segmentId}</span>
                                </span>
                                <span
                                  className={cn(
                                    "font-semibold",
                                    !hasSamples
                                      ? "text-white/50"
                                      : isReady
                                        ? "text-success"
                                        : "text-danger",
                                  )}
                                >
                                  {!hasSamples
                                    ? `${entry.sampleCount} samples`
                                    : `${confidencePct}% / ${targetPct}%`}
                                </span>
                              </div>
                              {showCue && (
                                <div className="text-[9px] text-danger/90 mt-0.5 font-medium">
                                  {badge.label}:{" "}
                                  {getLiveCueForSegment(entry.segmentId)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => {
                      setIsCalibrating(false);
                      setActiveRetryRegions([]);
                      unifiedCalibration.cancel();
                      setUnifiedState(null);
                    }}
                    className="w-full py-1.5 text-xs text-danger hover:bg-danger/10 rounded border border-danger/30"
                  >
                    Cancel
                  </button>
                </div>
              ) : isCalibrated ? (
                // Calibrated state
                <div className="space-y-2">
                  {overallQuality > 0 && (
                    <div className="p-2 bg-success/10 border border-success/30 rounded flex items-center justify-between">
                      <span className="text-[10px] text-success/80 font-medium">
                        Quality Score
                      </span>
                      <span className="text-sm font-bold text-success">
                        {overallQuality.toFixed(0)}%
                      </span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 text-xs"
                      onClick={handleStartCalibration}
                    >
                      Recalibrate
                    </Button>
                    <button
                      onClick={() => {
                        resetCalibration();
                        useTareStore.getState().resetAll();
                        setUnifiedState(null);
                      }}
                      className="px-2 py-1 text-xs text-white/40 hover:text-danger border border-white/10 rounded"
                      title="Reset Calibration"
                      aria-label="Reset Calibration"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ) : (
                // Ready to calibrate
                <>
                  <div className="mb-3 p-2 rounded-lg border border-white/15 bg-white/5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-white/80 mb-1.5">
                      Calibration Preflight
                    </div>
                    <div className="space-y-1">
                      {calibrationPreflight.checks.map((check) => (
                        <div
                          key={check.label}
                          className="flex items-center justify-between text-[10px]"
                        >
                          <div className="flex items-center gap-1.5">
                            {check.passed ? (
                              <CheckCircle className="h-3 w-3 text-success" />
                            ) : (
                              <AlertTriangle className="h-3 w-3 text-danger" />
                            )}
                            <span className="text-white/80">{check.label}</span>
                          </div>
                          <span
                            className={cn(
                              "font-medium",
                              check.passed ? "text-success" : "text-danger",
                            )}
                          >
                            {check.detail}
                          </span>
                        </div>
                      ))}
                    </div>
                    {calibrationPreflight.missingFullBodySegments.length >
                      0 && (
                      <div className="mt-2 text-[9px] text-danger/90">
                        Missing segments:{" "}
                        {calibrationPreflight.missingFullBodySegments.join(
                          ", ",
                        )}
                      </div>
                    )}
                    {preflightError && (
                      <div className="mt-2 text-[9px] text-danger/90">
                        {preflightError}
                      </div>
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant="gradient"
                    className="w-full"
                    onClick={handleStartCalibration}
                    disabled={!hasAssignments || !calibrationPreflight.canStart}
                  >
                    <Target className="h-3 w-3 mr-2" />
                    {hasAssignments
                      ? calibrationPreflight.canStart
                        ? "Start Calibration"
                        : "Preflight checks required"
                      : "Assign sensors first"}
                  </Button>
                </>
              )}
            </>
          )}
        </Section>

        {/* Step 3: Record */}
        <Section
          step={3}
          title="Record Session"
          completed={false}
          active={hasAssignments && !isScanning}
        >
          <RecordingControls />
        </Section>

        {/* Magnetometer Calibration - auto-detects which node has mag sensor */}
        <MagnetometerCalibrationCard />
      </div>
    </div>
  );
}
