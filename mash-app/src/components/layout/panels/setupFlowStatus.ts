export interface SetupStatusRow {
  label: string;
  passed: boolean;
  detail: string;
}

export interface SetupStatusModel {
  level: "ready" | "warning" | "blocked";
  rows: SetupStatusRow[];
  blockers: string[];
  summary: string;
}

export interface SetupStatusInput {
  isConnected: boolean;
  syncReady: boolean;
  syncPhase: string;
  aliveNodeCount: number;
  connectedSensorCount: number;
  assignmentStepComplete: boolean;
  isFullBodyFlow: boolean;
  requiredSegmentCount: number;
  missingFullBodySegments: string[];
  assignmentTargetCount: number;
  assignedCount: number;
  discoveryLocked: boolean;
  pendingNodeCount: number;
}

export interface CalibrationPreflightCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface CalibrationPreflightModel {
  checks: CalibrationPreflightCheck[];
  failedChecks: CalibrationPreflightCheck[];
  canStart: boolean;
  missingFullBodySegments: string[];
}

export interface CalibrationPreflightInput {
  isConnected: boolean;
  assignedCount: number;
  syncReady: boolean;
  syncPhase: string;
  aliveNodeCount: number;
  minAliveNodes: number;
  pendingNodeCount: number;
  isFullBodyFlow: boolean;
  requiredSegmentCount: number;
  missingFullBodySegments: string[];
}

export function computeAssignmentStepComplete(input: {
  isConnected: boolean;
  assignedCount: number;
  isFullBodyFlow: boolean;
  missingFullBodySegments: string[];
  assignmentTargetCount: number;
}): boolean {
  if (!input.isConnected || input.assignedCount === 0) return false;
  if (input.isFullBodyFlow) {
    return input.missingFullBodySegments.length === 0;
  }

  return (
    input.assignmentTargetCount > 0 &&
    input.assignedCount >= input.assignmentTargetCount
  );
}

export function buildCalibrationPreflightModel(
  input: CalibrationPreflightInput,
): CalibrationPreflightModel {
  const checks: CalibrationPreflightCheck[] = [
    {
      label: "Gateway connected",
      passed: input.isConnected,
      detail: input.isConnected ? "connected" : "offline",
    },
    {
      label: "Assignments present",
      passed: input.assignedCount > 0,
      detail: `${input.assignedCount} assigned`,
    },
    {
      label: "Sync readiness",
      passed: input.syncReady,
      detail: input.syncPhase || "idle",
    },
    {
      label: `Alive nodes ≥ ${input.minAliveNodes}`,
      passed: input.aliveNodeCount >= input.minAliveNodes,
      detail: `${input.aliveNodeCount} alive`,
    },
  ];

  if (input.pendingNodeCount > 0) {
    checks.push({
      label: "Pending nodes resolved",
      passed: false,
      detail: `${input.pendingNodeCount} waiting`,
    });
  }

  if (input.isFullBodyFlow) {
    checks.push({
      label: "Full-body required segments",
      passed: input.missingFullBodySegments.length === 0,
      detail:
        input.missingFullBodySegments.length === 0
          ? `${input.requiredSegmentCount}/${input.requiredSegmentCount}`
          : `${input.requiredSegmentCount - input.missingFullBodySegments.length}/${input.requiredSegmentCount}`,
    });
  }

  const failedChecks = checks.filter((check) => !check.passed);

  return {
    checks,
    failedChecks,
    canStart: failedChecks.length === 0,
    missingFullBodySegments: input.missingFullBodySegments,
  };
}

export function buildSetupStatusModel(
  input: SetupStatusInput,
): SetupStatusModel {
  const blockers: string[] = [];
  const rows: SetupStatusRow[] = [
    {
      label: "Gateway link",
      passed: input.isConnected,
      detail: input.isConnected ? "connected" : "offline",
    },
    {
      label: "Discovery and sync",
      passed: input.syncReady,
      detail: input.syncReady
        ? `${input.aliveNodeCount} node${input.aliveNodeCount === 1 ? "" : "s"} ready`
        : input.syncPhase === "idle"
          ? "waiting to start"
          : input.syncPhase,
    },
    {
      label: "Visible sensors",
      passed: input.connectedSensorCount > 0,
      detail:
        input.connectedSensorCount > 0
          ? `${input.connectedSensorCount} visible`
          : input.isConnected
            ? "waiting for topology"
            : "none",
    },
    {
      label: "Assignments",
      passed: input.assignmentStepComplete,
      detail: input.isFullBodyFlow
        ? `${input.requiredSegmentCount - input.missingFullBodySegments.length}/${input.requiredSegmentCount} required`
        : input.assignmentTargetCount > 0
          ? `${Math.min(input.assignedCount, input.assignmentTargetCount)}/${input.assignmentTargetCount} mapped`
          : `${input.assignedCount} mapped`,
    },
  ];

  if (!input.isConnected) {
    blockers.push("Connect the gateway before assigning sensors.");
  } else if (!input.syncReady) {
    blockers.push(
      input.discoveryLocked
        ? "Wait for the discovery-locked topology to finish synchronizing before trusting assignments."
        : "Wait for node discovery and synchronization to settle before calibrating.",
    );
  }

  if (input.connectedSensorCount === 0 && input.isConnected) {
    blockers.push(
      "The gateway is connected, but sensor topology has not surfaced in the assignment list yet.",
    );
  }

  if (input.pendingNodeCount > 0) {
    blockers.push(
      `${input.pendingNodeCount} late-joining node${input.pendingNodeCount === 1 ? " is" : "s are"} waiting to be added or ignored before calibration.`,
    );
  }

  if (!input.assignmentStepComplete && input.assignedCount > 0) {
    blockers.push(
      input.isFullBodyFlow
        ? `Assign the remaining required segments: ${input.missingFullBodySegments.join(", ")}.`
        : "Map every visible sensor before starting calibration.",
    );
  } else if (input.assignedCount === 0 && input.connectedSensorCount > 0) {
    blockers.push("Assign the visible sensors to body segments.");
  }

  const level =
    blockers.length === 0 ? "ready" : input.isConnected ? "warning" : "blocked";

  return {
    level,
    rows,
    blockers,
    summary:
      level === "ready"
        ? "Setup is coherent. You can trust the assignment state and move into calibration."
        : blockers[0] || "Setup is still stabilizing.",
  };
}
