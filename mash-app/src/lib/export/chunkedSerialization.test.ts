import { describe, expect, it, vi } from "vitest";
import type { RecordedEnvFrame, RecordedFrame, RecordingSession } from "../db";
import { buildRecordingCsv } from "./buildRecordingCsv";
import {
  serializeRecordingCsvChunked,
  serializeSyncFrameCsvChunked,
  serializeSessionJsonChunked,
  trimToFullSensorFrames,
} from "./chunkedSerialization";

function makeSession(
  overrides: Partial<RecordingSession> = {},
): RecordingSession {
  return {
    id: "session-1",
    name: "Session 1",
    startTime: 1000,
    endTime: 2000,
    sensorCount: 1,
    sampleRate: 200,
    ...overrides,
  };
}

function makeFrame(overrides: Partial<RecordedFrame> = {}): RecordedFrame {
  return {
    sessionId: "session-1",
    systemTime: 1000,
    timestamp: 1000,
    timestampUs: 1000000,
    sensorId: 1,
    frameNumber: 0,
    format: "0x25-sync",
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

  it("emits explicit gateway, arrival, and sync-relative timing columns", () => {
    const session = makeSession();
    const csv = serializeRecordingCsvChunked({
      session,
      frames: [
        makeFrame({
          timestamp: 2035,
          systemTime: 2051,
          frameNumber: 36115,
          sensorId: 4,
        }),
      ],
    });

    const lines = csv?.split("\n") ?? [];
    const header = lines.find((line) => line.startsWith("gateway_time_s,"));
    const row = lines[lines.length - 1]?.split(",") ?? [];

    expect(header).toBe(
      [
        "gateway_time_s",
        "gateway_time_ms",
        "system_arrival_time_s",
        "system_arrival_time_ms",
        "sync_time_s",
        "sync_time_ms",
        "frame_number",
        "relative_frame",
        "sensor_id",
        "segment",
        "qw",
        "qx",
        "qy",
        "qz",
        "ax (m/s^2)",
        "ay (m/s^2)",
        "az (m/s^2)",
        "gx (rad/s)",
        "gy (rad/s)",
        "gz (rad/s)",
        "battery",
      ].join(","),
    );
    expect(row[0]).toBe("2.0350");
    expect(row[1]).toBe("2035.0");
    expect(row[2]).toBe("2.0510");
    expect(row[3]).toBe("2051.0");
    expect(row[4]).toBe("0.0000");
    expect(row[5]).toBe("0.0");
    expect(row[6]).toBe("36115");
    expect(row[7]).toBe("0");
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
      imuFrames: [
        makeFrame(),
        makeFrame({ timestamp: 1005, systemTime: 1011, frameNumber: 1 }),
      ],
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
    expect(parsed.data.imuFrames[0].st).toBe(1000);
    expect(parsed.data.imuFrames[0].fn).toBe(0);
    expect(parsed.data.imuFrames[1].rf).toBe(1);
    expect(parsed.data.envFrames[0].baro.p).toBe(101325);

    const phases = onProgress.mock.calls.map((call) => call[0].phase);
    expect(phases).toContain("imu");
    expect(phases).toContain("env");
  });

  it("derives per-sensor sample rate when session metadata is missing", () => {
    const session = makeSession({
      startTime: 0,
      endTime: 10,
      sensorCount: 2,
      sampleRate: undefined,
    });
    const frames = [
      makeFrame({ timestamp: 0, timestampUs: 0, sensorId: 1, frameNumber: 0 }),
      makeFrame({ timestamp: 0, timestampUs: 0, sensorId: 2, frameNumber: 0 }),
      makeFrame({
        timestamp: 10,
        timestampUs: 10000,
        sensorId: 1,
        frameNumber: 1,
      }),
      makeFrame({
        timestamp: 10,
        timestampUs: 10000,
        sensorId: 2,
        frameNumber: 1,
      }),
    ];

    const csv = serializeRecordingCsvChunked({
      session,
      frames,
      chunkSize: 2,
    });
    expect(csv).toContain("# Sample Rate: 200 Hz");

    const json = serializeSessionJsonChunked({
      session,
      imuFrames: frames,
      envFrames: [],
      jsonSchema: "full",
      chunkSize: 2,
    });
    const parsed = JSON.parse(json);
    expect(parsed.session.sampleRate).toBe(200);
  });
});

describe("serializeSyncFrameCsvChunked", () => {
  it("groups packets by frameNumber into wide-format rows", () => {
    const session = makeSession({ sensorCount: 3 });

    // 3 sensors share frameNumber 100, 3 share 101
    const frames = [
      makeFrame({
        frameNumber: 100,
        timestamp: 500,
        sensorId: 1,
        segment: "pelvis",
        quaternion: [1, 0, 0, 0],
        accelerometer: [0, 0, 9.81],
      }),
      makeFrame({
        frameNumber: 100,
        timestamp: 500,
        sensorId: 2,
        segment: "thigh_r",
        quaternion: [0.9, 0.1, 0, 0],
        accelerometer: [1, 0, 9.81],
      }),
      makeFrame({
        frameNumber: 100,
        timestamp: 500,
        sensorId: 3,
        segment: "shank_r",
        quaternion: [0.8, 0.2, 0, 0],
        accelerometer: [2, 0, 9.81],
      }),
      makeFrame({
        frameNumber: 101,
        timestamp: 505,
        sensorId: 1,
        segment: "pelvis",
        quaternion: [1, 0, 0, 0],
        accelerometer: [0, 0, 9.81],
      }),
      makeFrame({
        frameNumber: 101,
        timestamp: 505,
        sensorId: 2,
        segment: "thigh_r",
        quaternion: [0.9, 0.1, 0, 0],
        accelerometer: [1, 0, 9.81],
      }),
      makeFrame({
        frameNumber: 101,
        timestamp: 505,
        sensorId: 3,
        segment: "shank_r",
        quaternion: [0.8, 0.2, 0, 0],
        accelerometer: [2, 0, 9.81],
      }),
    ];

    const { csv, summary } = serializeSyncFrameCsvChunked({ session, frames });

    // Summary verification — both frames complete, no trim
    expect(summary.totalSyncFrames).toBe(2);
    expect(summary.fullySyncedFrames).toBe(2);
    expect(summary.partialFrames).toBe(0);
    expect(summary.syncPercent).toBe(100);
    expect(summary.sensorIds).toEqual([1, 2, 3]);

    // CSV structure
    const lines = csv!.split("\n");
    const headerLine = lines.find((l) => l.startsWith("frame_number,"))!;
    const headers = headerLine.split(",");

    // Should have: frame_number, relative_frame, gateway_time_s, gateway_time_ms,
    //              sensors_present, is_complete, then 10 cols per sensor (3 sensors = 30)
    expect(headers.length).toBe(6 + 3 * 10); // 36 total

    // Both data rows should be present (no trim needed)
    const dataRows = lines.filter(
      (l) =>
        l.length > 0 && !l.startsWith("#") && !l.startsWith("frame_number"),
    );
    expect(dataRows.length).toBe(2);

    const row0 = dataRows[0].split(",");
    expect(row0[0]).toBe("100"); // frame_number
    expect(row0[1]).toBe("0"); // relative_frame
    expect(row0[4]).toBe("3"); // sensors_present
    expect(row0[5]).toBe("1"); // is_complete
  });

  it("trims partial ramp-up and ramp-down frames", () => {
    const session = makeSession({ sensorCount: 3 });

    // Frame 99: only sensor 1 (ramp-up — should be trimmed)
    // Frame 100: all 3 sensors (complete)
    // Frame 101: only sensors 1,2 (ramp-down — should be trimmed)
    const frames = [
      makeFrame({
        frameNumber: 99,
        timestamp: 495,
        sensorId: 1,
        segment: "pelvis",
      }),
      makeFrame({
        frameNumber: 100,
        timestamp: 500,
        sensorId: 1,
        segment: "pelvis",
      }),
      makeFrame({
        frameNumber: 100,
        timestamp: 500,
        sensorId: 2,
        segment: "thigh_r",
      }),
      makeFrame({
        frameNumber: 100,
        timestamp: 500,
        sensorId: 3,
        segment: "shank_r",
      }),
      makeFrame({
        frameNumber: 101,
        timestamp: 505,
        sensorId: 1,
        segment: "pelvis",
      }),
      makeFrame({
        frameNumber: 101,
        timestamp: 505,
        sensorId: 2,
        segment: "thigh_r",
      }),
    ];

    const { csv, summary } = serializeSyncFrameCsvChunked({ session, frames });

    // Only the 1 complete frame (100) should survive
    expect(summary.totalSyncFrames).toBe(1);
    expect(summary.fullySyncedFrames).toBe(1);

    const dataRows = csv!
      .split("\n")
      .filter(
        (l) =>
          l.length > 0 && !l.startsWith("#") && !l.startsWith("frame_number"),
      );
    expect(dataRows.length).toBe(1);
    expect(dataRows[0].split(",")[0]).toBe("100");

    // Header should note the trim
    expect(csv).toContain("Sync Trim: removed 1 start / 1 end frames");
  });

  it("header comments show sync frame statistics", () => {
    const session = makeSession({ sensorCount: 2, name: "Test Sync" });
    const frames = [
      makeFrame({ frameNumber: 0, timestamp: 0, sensorId: 1, segment: "a" }),
      makeFrame({ frameNumber: 0, timestamp: 0, sensorId: 2, segment: "b" }),
    ];

    const { csv } = serializeSyncFrameCsvChunked({ session, frames });
    expect(csv).toContain("# Fully Synchronised: 1 / 1 (100%)");
    expect(csv).toContain("# Sensors: 2");
    expect(csv).toContain("Synchronised Frame Export");
  });
});

describe("trimToFullSensorFrames", () => {
  it("trims ramp-up and ramp-down frames, keeps complete middle", () => {
    // 3 sensors total. Frame 10: 1 sensor, Frame 11: 2, Frame 12-13: all 3, Frame 14: 2
    const frames = [
      makeFrame({ frameNumber: 10, sensorId: 1 }),
      makeFrame({ frameNumber: 11, sensorId: 1 }),
      makeFrame({ frameNumber: 11, sensorId: 2 }),
      makeFrame({ frameNumber: 12, sensorId: 1 }),
      makeFrame({ frameNumber: 12, sensorId: 2 }),
      makeFrame({ frameNumber: 12, sensorId: 3 }),
      makeFrame({ frameNumber: 13, sensorId: 1 }),
      makeFrame({ frameNumber: 13, sensorId: 2 }),
      makeFrame({ frameNumber: 13, sensorId: 3 }),
      makeFrame({ frameNumber: 14, sensorId: 1 }),
      makeFrame({ frameNumber: 14, sensorId: 2 }),
    ];

    const result = trimToFullSensorFrames(frames);
    expect(result.wasTrimmed).toBe(true);
    expect(result.trimmedStartFrames).toBe(2); // frames 10, 11
    expect(result.trimmedEndFrames).toBe(1); // frame 14
    expect(result.frames.length).toBe(6); // 2 complete frames × 3 sensors
    expect(result.frames[0].frameNumber).toBe(12);
    expect(result.frames[result.frames.length - 1].frameNumber).toBe(13);
  });

  it("returns untrimmed when all frames are complete", () => {
    const frames = [
      makeFrame({ frameNumber: 1, sensorId: 1 }),
      makeFrame({ frameNumber: 1, sensorId: 2 }),
      makeFrame({ frameNumber: 2, sensorId: 1 }),
      makeFrame({ frameNumber: 2, sensorId: 2 }),
    ];

    const result = trimToFullSensorFrames(frames);
    expect(result.wasTrimmed).toBe(false);
    expect(result.frames.length).toBe(4);
    expect(result.trimmedPackets).toBe(0);
  });

  it("returns empty when no frame has all sensors", () => {
    const frames = [
      makeFrame({ frameNumber: 1, sensorId: 1 }),
      makeFrame({ frameNumber: 2, sensorId: 2 }),
      makeFrame({ frameNumber: 3, sensorId: 3 }),
    ];

    const result = trimToFullSensorFrames(frames);
    expect(result.frames.length).toBe(0);
    expect(result.wasTrimmed).toBe(true);
  });
});
