import { describe, expect, it } from "vitest";
import { parseSessionImportPayload } from "./sessionImport";

describe("parseSessionImportPayload", () => {
  it("parses valid legacy session export payload", () => {
    const payload = {
      metadata: {
        id: "session-1",
        name: "Session One",
        startTime: 1000,
        sensorCount: 1,
      },
      imu: [
        {
          sessionId: "session-1",
          systemTime: 1000,
          timestamp: 1000,
          sensorId: 1,
          frameNumber: 1,
          quaternion: [1, 0, 0, 0],
          accelerometer: [0, 0, 9.81],
          gyro: [0, 0, 0],
          battery: 90,
        },
      ],
      environmental: [
        {
          sessionId: "session-1",
          timestamp: 1000,
          barometer: { pressure: 1013, temperature: 20, altitude: 10 },
        },
      ],
    };

    const parsed = parseSessionImportPayload(payload);
    expect(parsed.session.id).toBe("session-1");
    expect(parsed.imuFrames.length).toBe(1);
    expect(parsed.environmentalFrames.length).toBe(1);
  });

  it("defaults missing environmental data to empty array", () => {
    const parsed = parseSessionImportPayload({
      metadata: {
        id: "session-1",
        name: "Session One",
        startTime: 1000,
        sensorCount: 1,
      },
      imu: [],
    });

    expect(parsed.environmentalFrames).toEqual([]);
  });

  it("throws for missing metadata/imu", () => {
    expect(() => parseSessionImportPayload({})).toThrow(
      "Invalid session file format",
    );
  });

  it("throws for invalid metadata shape", () => {
    expect(() =>
      parseSessionImportPayload({
        metadata: { id: "", name: "", startTime: "oops" },
        imu: [],
      }),
    ).toThrow("Invalid session metadata");
  });
});
