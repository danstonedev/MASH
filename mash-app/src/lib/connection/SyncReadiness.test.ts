import { describe, expect, it } from "vitest";
import { deriveSyncBufferMetrics } from "./SyncReadiness";

describe("deriveSyncBufferMetrics", () => {
  it("derives transport sync from completed and incomplete frames", () => {
    const metrics = deriveSyncBufferMetrics({
      syncBuffer: {
        initialized: true,
        expectedSensors: 14,
        authoritativeExpectedSensors: 14,
        activeStreamingSensors: 14,
        completedFrames: 7353,
        trulyComplete: 88,
        partialRecovery: 7265,
        dropped: 0,
        incomplete: 2,
        trueSyncRate: 1.2,
      },
    });

    expect(metrics.strictTrueSyncRate).toBeCloseTo(1.2, 3);
    expect(metrics.trueSyncRate).toBeCloseTo(1.2, 3);
    expect(metrics.transportSyncRate).toBeCloseTo((7353 / (7353 + 2)) * 100, 3);
  });

  it("falls back to strict sync rate before any frame history exists", () => {
    const metrics = deriveSyncBufferMetrics({
      syncBuffer: {
        initialized: true,
        expectedSensors: 14,
        authoritativeExpectedSensors: 14,
        activeStreamingSensors: 14,
        completedFrames: 0,
        trulyComplete: 0,
        partialRecovery: 0,
        dropped: 0,
        incomplete: 0,
        trueSyncRate: 0,
      },
    });

    expect(metrics.transportSyncRate).toBe(0);
    expect(metrics.strictTrueSyncRate).toBe(0);
  });
});
