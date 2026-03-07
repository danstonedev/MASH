import { afterEach, describe, expect, it, vi } from "vitest";
import { SerialConnection } from "./SerialConnection";
import type { IMUDataPacket } from "../protocol/DeviceInterface";

function makeFrame(type = 0x06): Uint8Array {
  if (type === 0x06) {
    const payload = new TextEncoder().encode('{"type":"status"}');
    const out = new Uint8Array(1 + payload.length);
    out[0] = 0x06;
    out.set(payload, 1);
    return out;
  }
  return new Uint8Array([type, 0, 0]);
}

describe("SerialConnection queue safety", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps pending parse queue to max frame budget", () => {
    const conn = new SerialConnection() as any;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const frames = Array.from({ length: 5000 }, () => makeFrame());
    conn.enqueueFrames(frames);

    expect(conn.getPendingFrameCount()).toBeLessThanOrEqual(4096);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("signals flow control when queue overflow occurs", () => {
    const conn = new SerialConnection() as any;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const flowSpy = vi
      .spyOn(conn, "maybeAdjustFlowControl")
      .mockImplementation(() => {});

    const frames = Array.from({ length: 5000 }, () => makeFrame());
    conn.enqueueFrames(frames);

    expect(flowSpy).toHaveBeenCalledWith(true);
  });

  it("enriches IMU packets with the last sync_status completeness contract", () => {
    const conn = new SerialConnection() as unknown as {
      dispatchParsedPackets: (packets: unknown[], deviceName: string) => void;
      onData: (callback: (data: unknown) => void) => void;
    };

    let lastPayload: unknown;
    conn.onData((data) => {
      lastPayload = data;
    });

    conn.dispatchParsedPackets(
      [
        {
          type: "sync_status",
          syncBuffer: {
            expectedSensors: 12,
            authoritativeExpectedSensors: 12,
            activeStreamingSensors: 10,
          },
        },
        {
          sensorId: 1,
          timestamp: 0,
          timestampUs: 0,
          frameNumber: 1,
          quaternion: [1, 0, 0, 0],
          accelerometer: [0, 0, 1],
          gyro: [0, 0, 0],
          battery: 100,
          format: "0x25-sync",
          rawNodeId: 11,
          localSensorIndex: 0,
          frameCompleteness: {
            validCount: 10,
            expectedCount: 10,
            isComplete: true,
          },
        } satisfies IMUDataPacket,
      ],
      "USB Serial",
    );

    const forwarded = lastPayload as Array<
      IMUDataPacket & { deviceId: string }
    >;
    expect(Array.isArray(forwarded)).toBe(true);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].frameCompleteness).toMatchObject({
      validCount: 10,
      expectedCount: 10,
      authoritativeExpectedCount: 12,
      activeStreamingCount: 10,
    });
  });
});
