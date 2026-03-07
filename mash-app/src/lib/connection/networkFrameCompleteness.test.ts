import { describe, expect, it } from "vitest";
import { evaluateNetworkFrameCompleteness } from "./networkFrameCompleteness";

describe("evaluateNetworkFrameCompleteness", () => {
  it("rejects frames already marked incomplete at the packet level", () => {
    const decision = evaluateNetworkFrameCompleteness({
      validCount: 10,
      packetExpectedCount: 12,
      syncExpectedSensors: 12,
      topologyExpectedSensors: 12,
      discoveryLocked: true,
    });

    expect(decision.reject).toBe(true);
    expect(decision.packetIsIncomplete).toBe(true);
  });

  it("rejects locally complete frames that are incomplete for the full network", () => {
    const decision = evaluateNetworkFrameCompleteness({
      validCount: 10,
      packetExpectedCount: 10,
      syncExpectedSensors: 12,
      topologyExpectedSensors: 12,
      discoveryLocked: true,
    });

    expect(decision.reject).toBe(false);
    expect(decision.packetIsIncomplete).toBe(false);
    expect(decision.networkIsIncomplete).toBe(true);
    expect(decision.authoritativeExpectedCount).toBe(12);
  });

  it("uses topology counts when sync_status has not provided an expected count yet", () => {
    const decision = evaluateNetworkFrameCompleteness({
      validCount: 8,
      packetExpectedCount: 8,
      syncExpectedSensors: 0,
      topologyExpectedSensors: 12,
      discoveryLocked: true,
    });

    expect(decision.reject).toBe(false);
    expect(decision.networkIsIncomplete).toBe(true);
    expect(decision.authoritativeExpectedCount).toBe(12);
  });

  it("does not enforce network-wide completeness before topology is authoritative", () => {
    const decision = evaluateNetworkFrameCompleteness({
      validCount: 8,
      packetExpectedCount: 8,
      syncExpectedSensors: 0,
      topologyExpectedSensors: 12,
      discoveryLocked: false,
    });

    expect(decision.reject).toBe(false);
    expect(decision.networkIsIncomplete).toBe(false);
  });
});
