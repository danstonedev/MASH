import { describe, expect, it } from "vitest";
import { LiveGapFill } from "./LiveGapFill";
import type { IMUDataPacket } from "../lib/protocol/DeviceInterface";

function makePacket(
  frameNumber: number,
  overrides: Partial<IMUDataPacket> = {},
): IMUDataPacket {
  return {
    sensorId: 1,
    timestamp: frameNumber * 0.005,
    timestampUs: frameNumber * 5000,
    frameNumber,
    quaternion: [1, 0, 0, 0],
    accelerometer: [0, 0, 1],
    gyro: [0, 0, 0],
    battery: 100,
    format: "0x25-sync",
    ...overrides,
  };
}

describe("LiveGapFill", () => {
  it("does not synthesize missing frames for packet-local sync groups", () => {
    const filler = new LiveGapFill();

    const first = makePacket(100, {
      frameCompleteness: {
        validCount: 3,
        expectedCount: 3,
        isComplete: true,
        authoritativeExpectedCount: 14,
      },
    });
    const second = makePacket(104, {
      frameCompleteness: {
        validCount: 3,
        expectedCount: 3,
        isComplete: true,
        authoritativeExpectedCount: 14,
      },
    });

    expect(filler.processPacket(first)).toHaveLength(1);
    const result = filler.processPacket(second);

    expect(result).toHaveLength(1);
    expect(result[0].frameNumber).toBe(104);
    expect(filler.stats.totalFramesFilled).toBe(0);
  });

  it("still fills true per-sensor gaps when frames are authoritative", () => {
    const filler = new LiveGapFill();

    const first = makePacket(100, {
      frameCompleteness: {
        validCount: 14,
        expectedCount: 14,
        isComplete: true,
        authoritativeExpectedCount: 14,
      },
    });
    const second = makePacket(103, {
      frameCompleteness: {
        validCount: 14,
        expectedCount: 14,
        isComplete: true,
        authoritativeExpectedCount: 14,
      },
      quaternion: [0, 1, 0, 0],
    });

    expect(filler.processPacket(first)).toHaveLength(1);
    const result = filler.processPacket(second);

    expect(result).toHaveLength(3);
    expect(result[0].__filled).toBe(true);
    expect(result[1].__filled).toBe(true);
    expect(result[2].frameNumber).toBe(103);
    expect(filler.stats.totalFramesFilled).toBe(2);
  });
});
