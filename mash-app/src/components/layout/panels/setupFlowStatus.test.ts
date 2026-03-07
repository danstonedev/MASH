import { describe, expect, it } from "vitest";
import {
  buildCalibrationPreflightModel,
  buildSetupStatusModel,
  computeAssignmentStepComplete,
} from "./setupFlowStatus";

describe("setupFlowStatus", () => {
  it("requires all full-body required segments before assignment step is complete", () => {
    expect(
      computeAssignmentStepComplete({
        isConnected: true,
        assignedCount: 12,
        isFullBodyFlow: true,
        missingFullBodySegments: ["hand_r"],
        assignmentTargetCount: 15,
      }),
    ).toBe(false);

    expect(
      computeAssignmentStepComplete({
        isConnected: true,
        assignedCount: 15,
        isFullBodyFlow: true,
        missingFullBodySegments: [],
        assignmentTargetCount: 15,
      }),
    ).toBe(true);
  });

  it("requires all visible sensors for non-full-body assignment completion", () => {
    expect(
      computeAssignmentStepComplete({
        isConnected: true,
        assignedCount: 2,
        isFullBodyFlow: false,
        missingFullBodySegments: [],
        assignmentTargetCount: 3,
      }),
    ).toBe(false);

    expect(
      computeAssignmentStepComplete({
        isConnected: true,
        assignedCount: 3,
        isFullBodyFlow: false,
        missingFullBodySegments: [],
        assignmentTargetCount: 3,
      }),
    ).toBe(true);
  });

  it("blocks calibration preflight when late-join nodes are unresolved", () => {
    const preflight = buildCalibrationPreflightModel({
      isConnected: true,
      assignedCount: 3,
      syncReady: true,
      syncPhase: "ready",
      aliveNodeCount: 2,
      minAliveNodes: 1,
      pendingNodeCount: 2,
      isFullBodyFlow: false,
      requiredSegmentCount: 15,
      missingFullBodySegments: [],
    });

    expect(preflight.canStart).toBe(false);
    expect(preflight.failedChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Pending nodes resolved",
          detail: "2 waiting",
        }),
      ]),
    );
  });

  it("surfaces late-join nodes as a setup blocker before calibration", () => {
    const status = buildSetupStatusModel({
      isConnected: true,
      syncReady: true,
      syncPhase: "ready",
      aliveNodeCount: 2,
      connectedSensorCount: 3,
      assignmentStepComplete: true,
      isFullBodyFlow: false,
      requiredSegmentCount: 15,
      missingFullBodySegments: [],
      assignmentTargetCount: 3,
      assignedCount: 3,
      discoveryLocked: true,
      pendingNodeCount: 1,
    });

    expect(status.level).toBe("warning");
    expect(status.blockers[0]).toContain("late-joining node is waiting");
    expect(status.blockers[0]).toContain("before calibration");
  });

  it("reports ready only when link, sync, sensors, and assignments are all coherent", () => {
    const status = buildSetupStatusModel({
      isConnected: true,
      syncReady: true,
      syncPhase: "ready",
      aliveNodeCount: 2,
      connectedSensorCount: 3,
      assignmentStepComplete: true,
      isFullBodyFlow: false,
      requiredSegmentCount: 15,
      missingFullBodySegments: [],
      assignmentTargetCount: 3,
      assignedCount: 3,
      discoveryLocked: true,
      pendingNodeCount: 0,
    });

    expect(status.level).toBe("ready");
    expect(status.summary).toContain("Setup is coherent");
  });
});
