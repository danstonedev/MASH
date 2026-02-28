import { describe, expect, it, vi } from "vitest";
import type { RecordedEnvFrame, RecordedFrame, RecordingSession } from "../db";
import { buildRecordingCsv } from "./buildRecordingCsv";
import {
  serializeRecordingCsvChunked,
  serializeSessionJsonChunked,
} from "./chunkedSerialization";

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

function makeEnvFrame(
  overrides: Partial<RecordedEnvFrame> = {},
): RecordedEnvFrame {
  return {
    sessionId: "session-1",
    timestamp: 1000,
    barometer: {
      pressure: 101325,
      temperature: 22,
      altitude: 100,
    },
    magnetometer: {
      x: 1,
      y: 2,
      z: 3,
      heading: 45,
    },
    ...overrides,
  };
}

describe("chunkedSerialization", () => {
  it("produces CSV output equivalent to buildRecordingCsv", () => {
    const session = makeSession();
    const frames = [
      makeFrame(),
      makeFrame({ timestamp: 1005, frameNumber: 1 }),
      makeFrame({ timestamp: 1010, frameNumber: 2 }),
    ];

    const chunked = serializeRecordingCsvChunked({
      session,
      frames,
      chunkSize: 1,
    });

    const legacy = buildRecordingCsv({ session, frames });

    expect(chunked).toBe(legacy);
  });

  it("emits CSV chunk progress updates", () => {
    const session = makeSession();
    const frames = [
      makeFrame(),
      makeFrame({ timestamp: 1005, frameNumber: 1 }),
      makeFrame({ timestamp: 1010, frameNumber: 2 }),
    ];

    const onProgress = vi.fn();
    serializeRecordingCsvChunked({
      session,
      frames,
      chunkSize: 1,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, { processed: 1, total: 3 });
    expect(onProgress).toHaveBeenNthCalledWith(3, { processed: 3, total: 3 });
  });

  it("serializes legacy JSON in chunked mode", () => {
    const json = serializeSessionJsonChunked({
      session: makeSession(),
      imuFrames: [makeFrame(), makeFrame({ timestamp: 1005, frameNumber: 1 })],
      envFrames: [makeEnvFrame(), makeEnvFrame({ timestamp: 1005 })],
      jsonSchema: "legacy",
      chunkSize: 1,
    });

    const parsed = JSON.parse(json);
    expect(parsed.metadata.id).toBe("session-1");
    expect(parsed.imu.length).toBe(2);
    expect(parsed.environmental.length).toBe(2);
  });

  it("serializes full JSON in chunked mode and emits per-phase progress", () => {
    const onProgress = vi.fn();

    const json = serializeSessionJsonChunked({
      session: makeSession(),
      imuFrames: [makeFrame(), makeFrame({ timestamp: 1005, frameNumber: 1 })],
      envFrames: [makeEnvFrame(), makeEnvFrame({ timestamp: 1005 })],
      jsonSchema: "full",
      chunkSize: 1,
      onProgress,
    });

    const parsed = JSON.parse(json);
    expect(parsed.exportVersion).toBe("1.0.0");
    expect(parsed.data.imuFrameCount).toBe(2);
    expect(parsed.data.envFrameCount).toBe(2);
    expect(parsed.data.imuFrames[0].t).toBe(1000);
    expect(parsed.data.envFrames[0].baro.p).toBe(101325);

    const phases = onProgress.mock.calls.map((call) => call[0].phase);
    expect(phases).toContain("imu");
    expect(phases).toContain("env");
  });
});
