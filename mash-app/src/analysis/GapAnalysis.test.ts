import { describe, expect, it } from "vitest";
import type { RecordedFrame } from "../lib/db/types";
import { analyzeGaps } from "./GapAnalysis";

function makeFrame(
  sensorId: number,
  frameNumber: number,
  timestamp: number,
  systemTime: number,
): RecordedFrame {
  return {
    sessionId: "session-1",
    systemTime,
    timestamp,
    timestampUs: timestamp * 1000,
    sensorId,
    frameNumber,
    format: "0x25-sync",
    quaternion: [1, 0, 0, 0],
    accelerometer: [0, 0, 9.81],
    gyro: [0, 0, 0],
    battery: 95,
    segment: sensorId === 1 ? "thigh_l" : "thigh_r",
    frameCompleteness: {
      validCount: 1,
      expectedCount: 1,
      isComplete: true,
      authoritativeExpectedCount: 2,
      activeStreamingCount: 2,
    },
  };
}

describe("GapAnalysis", () => {
  it("uses the gateway-aligned sync timeline instead of recorder arrival jitter", () => {
    const frames: RecordedFrame[] = [
      makeFrame(1, 100, 0, 1000),
      makeFrame(2, 101, 5, 1007),
      makeFrame(1, 102, 10, 1010),
      makeFrame(2, 103, 15, 1017),
      makeFrame(1, 104, 20, 1020),
      makeFrame(2, 105, 25, 1027),
      makeFrame(1, 106, 30, 1050),
      makeFrame(2, 107, 35, 1037),
      makeFrame(1, 108, 40, 1060),
      makeFrame(2, 109, 45, 1047),
    ];

    const report = analyzeGaps(frames, "session-1", 200, 45);
    const leftSensor = report.sensorReports.find(
      (sensor) => sensor.sensorId === 1,
    );
    const rightSensor = report.sensorReports.find(
      (sensor) => sensor.sensorId === 2,
    );

    expect(report.packetLocalMode).toBe(true);
    expect(report.transportCoveragePercent).toBe(100);
    expect(report.strictEpochCoveragePercent).toBe(0);
    expect(report.timelineCoveragePercent).toBe(100);
    expect(leftSensor?.gaps).toHaveLength(0);
    expect(rightSensor?.gaps).toHaveLength(0);
    expect(leftSensor?.coveragePercent).toBe(100);
    expect(rightSensor?.coveragePercent).toBe(100);
  });
});
