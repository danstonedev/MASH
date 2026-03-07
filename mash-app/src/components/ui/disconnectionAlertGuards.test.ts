import { describe, expect, it } from "vitest";
import { shouldSuppressDisconnectAlertForIngestStorm } from "./disconnectionAlertGuards";

describe("shouldSuppressDisconnectAlertForIngestStorm", () => {
  it("suppresses alerts during a widespread offline cascade while raw IMU traffic still flows", () => {
    const now = 20_000;
    expect(
      shouldSuppressDisconnectAlertForIngestStorm({
        now,
        connected: true,
        deviceCount: 14,
        offlineCount: 14,
        ingest: {
          rawImuPacketCount: 18_000,
          acceptedImuPacketCount: 2_900,
          lastRawImuAt: now - 200,
          lastAcceptedImuAt: now - 6_500,
          lastPacketCompletenessRejectAt: 0,
          lastNetworkCompletenessRejectAt: now - 300,
        },
      }),
    ).toBe(true);
  });

  it("does not suppress an isolated sensor disconnect", () => {
    const now = 20_000;
    expect(
      shouldSuppressDisconnectAlertForIngestStorm({
        now,
        connected: true,
        deviceCount: 14,
        offlineCount: 1,
        ingest: {
          rawImuPacketCount: 18_000,
          acceptedImuPacketCount: 17_900,
          lastRawImuAt: now - 200,
          lastAcceptedImuAt: now - 200,
          lastPacketCompletenessRejectAt: 0,
          lastNetworkCompletenessRejectAt: 0,
        },
      }),
    ).toBe(false);
  });
});
