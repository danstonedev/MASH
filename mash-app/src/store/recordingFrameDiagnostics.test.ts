import { describe, expect, it } from "vitest";
import {
  createRecordingFrameDiagnostics,
  updateRecordingFrameDiagnostics,
} from "./recordingFrameDiagnostics";
import type { IMUDataPacket } from "../lib/protocol/DeviceInterface";

function makePacket(
  sensorId: number,
  frameNumber: number,
  expectedCount: number,
): IMUDataPacket {
  return {
    sensorId,
    timestamp: frameNumber * 0.005,
    timestampUs: frameNumber * 5000,
    frameNumber,
    quaternion: [1, 0, 0, 0],
    accelerometer: [0, 0, 1],
    gyro: [0, 0, 0],
    battery: 100,
    format: "0x25-sync",
    frameCompleteness: {
      validCount: expectedCount,
      expectedCount,
      isComplete: true,
    },
  };
}

describe("recordingFrameDiagnostics", () => {
  it("counts packet-local groups as complete when they satisfy their own expected count", () => {
    let diag = createRecordingFrameDiagnostics(0);

    diag = updateRecordingFrameDiagnostics(diag, makePacket(1, 100, 2), 1000);
    diag = updateRecordingFrameDiagnostics(diag, makePacket(2, 100, 2), 1001);
    diag = updateRecordingFrameDiagnostics(diag, makePacket(11, 101, 3), 1002);
    diag = updateRecordingFrameDiagnostics(diag, makePacket(12, 101, 3), 1003);
    diag = updateRecordingFrameDiagnostics(diag, makePacket(13, 101, 3), 1004);

    expect(diag.totalFrames).toBe(2);
    expect(diag.completeFrames).toBe(2);
    expect(diag.allSensorIds.size).toBe(5);
  });

  it("does not count an incomplete packet-local group as complete", () => {
    let diag = createRecordingFrameDiagnostics(0);

    diag = updateRecordingFrameDiagnostics(diag, makePacket(1, 100, 3), 1000);
    diag = updateRecordingFrameDiagnostics(diag, makePacket(2, 100, 3), 1001);

    expect(diag.totalFrames).toBe(1);
    expect(diag.completeFrames).toBe(0);
  });
});
