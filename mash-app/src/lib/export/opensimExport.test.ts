import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDataManager, mockExportSessionData, mockBuildOpenSimStoArtifact } =
  vi.hoisted(() => ({
    mockDataManager: {
      getSession: vi.fn(),
      exportSessionData: vi.fn(),
    },
    mockExportSessionData: vi.fn(),
    mockBuildOpenSimStoArtifact: vi.fn(),
  }));

vi.mock("../db", () => ({
  dataManager: mockDataManager,
}));

vi.mock("./ExportOrchestrator", () => ({
  exportSessionData: mockExportSessionData,
}));

vi.mock("./OpenSimExporter", () => ({
  buildOpenSimStoArtifact: mockBuildOpenSimStoArtifact,
}));

import { exportToCSV, exportToJSON, exportToSTO } from "./opensimExport";

describe("opensimExport compatibility wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates CSV export to orchestrator", async () => {
    mockExportSessionData.mockResolvedValue({
      content: "csv-content",
      filename: "session.csv",
      mimeType: "text/csv",
    });

    const csv = await exportToCSV("session-1");

    expect(csv).toBe("csv-content");
    expect(mockExportSessionData).toHaveBeenCalledWith(
      { sessionId: "session-1", format: "csv", jsonSchema: undefined },
      { preferWorker: false },
    );
  });

  it("delegates JSON export to orchestrator full schema", async () => {
    mockExportSessionData.mockResolvedValue({
      content: "json-content",
      filename: "session.json",
      mimeType: "application/json",
    });

    const json = await exportToJSON("session-2");

    expect(json).toBe("json-content");
    expect(mockExportSessionData).toHaveBeenCalledWith(
      { sessionId: "session-2", format: "json", jsonSchema: "full" },
      { preferWorker: false },
    );
  });

  it("builds STO result from unified OpenSim artifact", async () => {
    mockDataManager.getSession.mockResolvedValue({
      id: "session-3",
      name: "Session Three",
      startTime: 1000,
      endTime: 1010,
      sensorCount: 1,
      sampleRate: 200,
    });

    mockDataManager.exportSessionData.mockResolvedValue([
      {
        sessionId: "session-3",
        systemTime: 1000,
        timestamp: 1000,
        sensorId: 1,
        frameNumber: 0,
        quaternion: [1, 0, 0, 0],
        accelerometer: [0, 0, 9.81],
        gyro: [0, 0, 0],
        battery: 90,
        segment: "pelvis",
      },
      {
        sessionId: "session-3",
        systemTime: 1005,
        timestamp: 1005,
        sensorId: 1,
        frameNumber: 1,
        quaternion: [1, 0, 0, 0],
        accelerometer: [0, 0, 9.81],
        gyro: [0, 0, 0],
        battery: 90,
        segment: "pelvis",
      },
    ]);

    mockBuildOpenSimStoArtifact.mockReturnValue({
      content:
        "result_file\nversion=1\nendheader\ntime\tpelvis_imu_q1\n0.0\t1.0",
      filename: "Session_Three.sto",
      mimeType: "text/plain",
    });

    const result = await exportToSTO({ sessionId: "session-3" });

    expect(result.filename).toBe("Session_Three.sto");
    expect(result.frameCount).toBe(2);
    expect(result.duration).toBeCloseTo(0.005, 6);
    expect(result.columns).toEqual(["time", "pelvis_imu_q1"]);
  });
});
