import { describe, expect, it } from "vitest";
import { preparePlaybackSession } from "./preparePlaybackSession";
import type { RecordedFrame } from "../db";

function makeFrame(
  sensorId: number,
  frameNumber: number,
  systemTime: number,
  expectedCount: number,
): RecordedFrame {
  return {
    sessionId: "s1",
    sensorId,
    frameNumber,
    timestamp: systemTime,
    systemTime,
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

describe("preparePlaybackSession", () => {
  it("uses recorded sample rate for packet-local transport sessions", () => {
    const frames: RecordedFrame[] = [];
    for (let index = 0; index < 6; index++) {
      frames.push(makeFrame(1, 100 + index * 2, 1000 + index * 100, 1));
      frames.push(makeFrame(2, 101 + index * 2, 1050 + index * 100, 1));
    }

    const prepared = preparePlaybackSession({
      frames,
      sessionStartTime: 1000,
      sessionEndTime: 1600,
      recordedSampleRate: 178,
    });

    expect(prepared.frameRate).toBe(178);
  });

  it("still derives frame rate from unique frame numbers for full-network frames", () => {
    const frames: RecordedFrame[] = [];
    for (let frameNumber = 200; frameNumber < 241; frameNumber++) {
      const systemTime = 1000 + (frameNumber - 200) * 5;
      frames.push(makeFrame(1, frameNumber, systemTime, 2));
      frames.push(makeFrame(2, frameNumber, systemTime, 2));
    }

    const prepared = preparePlaybackSession({
      frames,
      sessionStartTime: 1000,
      sessionEndTime: 1200,
      recordedSampleRate: 123,
    });

    expect(prepared.frameRate).toBe(200);
  });
});
