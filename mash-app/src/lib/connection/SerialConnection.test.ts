import { afterEach, describe, expect, it, vi } from "vitest";
import { SerialConnection } from "./SerialConnection";

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
});

