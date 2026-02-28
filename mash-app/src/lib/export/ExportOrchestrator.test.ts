import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDataManager } = vi.hoisted(() => ({
  mockDataManager: {
    getSession: vi.fn(),
    exportSessionData: vi.fn(),
    exportEnvData: vi.fn(),
  },
}));

vi.mock("../db", () => ({
  dataManager: mockDataManager,
}));

import type { RecordedFrame, RecordingSession } from "../db/types";
import { exportPlaybackData, exportSessionData } from "./ExportOrchestrator";
import { EXPORT_PROGRESS_STAGE } from "./formatExportStage";

function makeSession(): RecordingSession {
  return {
    id: "session-1",
    name: "Session 1",
    startTime: 1000,
    endTime: 2000,
    sensorCount: 1,
    sampleRate: 200,
  };
}

function makeFrame(overrides: Partial<RecordedFrame> = {}): RecordedFrame {
  return {
    sessionId: "session-1",
    systemTime: 1000,
    timestamp: 1000,
    sensorId: 1,
    frameNumber: 0,
    quaternion: [1, 0, 0, 0],
    accelerometer: [0, 0, 9.81],
    gyro: [0, 0, 0],
    battery: 90,
    segment: "pelvis",
    ...overrides,
  };
}

describe("ExportOrchestrator (non-worker path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDataManager.getSession.mockResolvedValue(makeSession());
    mockDataManager.exportSessionData.mockResolvedValue([
      makeFrame(),
      makeFrame({ timestamp: 1005, frameNumber: 1 }),
    ]);
    mockDataManager.exportEnvData.mockResolvedValue([]);
  });

  it("exports legacy JSON when preferWorker is false", async () => {
    const artifact = await exportSessionData(
      {
        sessionId: "session-1",
        format: "json",
        jsonSchema: "legacy",
      },
      { preferWorker: false },
    );

    expect(artifact.mimeType).toBe("application/json");
    expect(typeof artifact.content).toBe("string");
    const parsed = JSON.parse(artifact.content as string);
    expect(parsed.metadata.id).toBe("session-1");
    expect(Array.isArray(parsed.imu)).toBe(true);
  });

  it("exports full JSON when requested", async () => {
    const artifact = await exportSessionData(
      {
        sessionId: "session-1",
        format: "json",
        jsonSchema: "full",
      },
      { preferWorker: false },
    );

    const parsed = JSON.parse(artifact.content as string);
    expect(parsed.exportVersion).toBe("1.0.0");
    expect(parsed.session.id).toBe("session-1");
    expect(parsed.data.imuFrameCount).toBe(2);
  });

  it("exports playback CSV when preferWorker is false", async () => {
    const frames = [
      makeFrame(),
      makeFrame({ timestamp: 1005, frameNumber: 1 }),
    ];

    const artifact = await exportPlaybackData(
      {
        format: "csv",
        sessionName: "Playback Session",
        frameRate: 200,
        frames,
      },
      { preferWorker: false },
    );

    expect(artifact.mimeType).toBe("text/csv");
    expect(typeof artifact.content).toBe("string");
    expect((artifact.content as string).includes("frame_number")).toBe(true);
  });

  it("emits session telemetry with timing metrics", async () => {
    const onTelemetry = vi.fn();

    await exportSessionData(
      {
        sessionId: "session-1",
        format: "json",
        jsonSchema: "legacy",
      },
      { preferWorker: false, onTelemetry },
    );

    expect(onTelemetry).toHaveBeenCalled();
    const event = onTelemetry.mock.calls[0][0];
    expect(event.scope).toBe("session");
    expect(event.mode).toBe("data");
    expect(event.path).toBe("main");
    expect(event.frameCount).toBe(2);
    expect(event.sensorCount).toBe(1);
    expect(event.fetchMs).toBeGreaterThanOrEqual(0);
    expect(event.serializeMs).toBeGreaterThanOrEqual(0);
    expect(event.totalMs).toBeGreaterThanOrEqual(0);
    expect(event.stage).toBe(EXPORT_PROGRESS_STAGE.DONE);
    expect(event.stageLabel).toBe("Finalizing");
  });

  it("emits playback telemetry with timing metrics", async () => {
    const onTelemetry = vi.fn();
    const frames = [
      makeFrame(),
      makeFrame({ timestamp: 1005, frameNumber: 1 }),
    ];

    await exportPlaybackData(
      {
        format: "csv",
        sessionName: "Playback Session",
        frameRate: 200,
        frames,
      },
      { preferWorker: false, onTelemetry },
    );

    expect(onTelemetry).toHaveBeenCalled();
    const event = onTelemetry.mock.calls[0][0];
    expect(event.scope).toBe("playback");
    expect(event.mode).toBe("data");
    expect(event.path).toBe("main");
    expect(event.frameCount).toBe(2);
    expect(event.sensorCount).toBe(1);
    expect(event.serializeMs).toBeGreaterThanOrEqual(0);
    expect(event.totalMs).toBeGreaterThanOrEqual(0);
  });
});

describe("ExportOrchestrator (worker path)", () => {
  const originalWorker = globalThis.Worker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDataManager.getSession.mockResolvedValue(makeSession());
    mockDataManager.exportSessionData.mockResolvedValue([
      makeFrame(),
      makeFrame({ timestamp: 1005, frameNumber: 1 }),
    ]);
    mockDataManager.exportEnvData.mockResolvedValue([]);
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it("emits worker progress callbacks", async () => {
    class ProgressWorkerMock {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() {}
      postMessage() {
        this.onmessage?.({
          data: {
            type: "progress",
            progress: 25,
            stage: EXPORT_PROGRESS_STAGE.NORMALIZE,
          },
        } as MessageEvent);
        this.onmessage?.({
          data: {
            type: "done",
            artifact: {
              content: "ok",
              filename: "session-1.csv",
              mimeType: "text/csv",
            },
          },
        } as MessageEvent);
      }
      terminate() {}
    }

    globalThis.Worker = ProgressWorkerMock as unknown as typeof Worker;

    const onProgress = vi.fn();
    const artifact = await exportSessionData(
      { sessionId: "session-1", format: "csv" },
      { onProgress },
    );

    expect(onProgress).toHaveBeenCalledWith(
      25,
      EXPORT_PROGRESS_STAGE.NORMALIZE,
    );
    expect(artifact.filename).toBe("session-1.csv");
  });

  it("throws cancellation error when aborted", async () => {
    class SlowWorkerMock {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() {}
      postMessage() {}
      terminate() {}
    }

    globalThis.Worker = SlowWorkerMock as unknown as typeof Worker;

    const controller = new AbortController();
    controller.abort();

    await expect(
      exportSessionData(
        { sessionId: "session-1", format: "csv" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Export cancelled");
  });

  it("falls back to main-thread export when worker errors", async () => {
    class ErrorWorkerMock {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() {}
      postMessage() {
        this.onerror?.({ message: "worker exploded" } as ErrorEvent);
      }
      terminate() {}
    }

    globalThis.Worker = ErrorWorkerMock as unknown as typeof Worker;

    const artifact = await exportPlaybackData({
      format: "csv",
      sessionName: "Playback",
      frameRate: 200,
      frames: [makeFrame(), makeFrame({ timestamp: 1005, frameNumber: 1 })],
    });

    expect(artifact.mimeType).toBe("text/csv");
    expect(typeof artifact.content).toBe("string");
  });

  it("flags telemetry fallback when worker export fails", async () => {
    class ErrorWorkerMock {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() {}
      postMessage() {
        this.onerror?.({ message: "worker exploded" } as ErrorEvent);
      }
      terminate() {}
    }

    globalThis.Worker = ErrorWorkerMock as unknown as typeof Worker;

    const onTelemetry = vi.fn();

    await exportPlaybackData(
      {
        format: "csv",
        sessionName: "Playback",
        frameRate: 200,
        frames: [makeFrame(), makeFrame({ timestamp: 1005, frameNumber: 1 })],
      },
      { onTelemetry },
    );

    expect(onTelemetry).toHaveBeenCalled();
    const event = onTelemetry.mock.calls[0][0];
    expect(event.path).toBe("main");
    expect(event.fallbackUsed).toBe(true);
  });
});
