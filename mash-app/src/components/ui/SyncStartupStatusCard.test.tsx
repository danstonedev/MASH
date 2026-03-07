import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockUseDeviceStore = vi.fn();

vi.mock("../../store/useDeviceStore", () => ({
  useDeviceStore: () => mockUseDeviceStore(),
}));

import { SyncStartupStatusCard } from "./SyncStartupStatusCard";

describe("SyncStartupStatusCard", () => {
  it("stays hidden during normal startup because DevicePanel owns setup guidance", () => {
    mockUseDeviceStore.mockReturnValue({
      isConnected: true,
      syncReady: false,
      syncPhase: "discovering",
      syncState: {
        nodeCount: 1,
        tdmaState: "discovery",
        nodes: [{ nodeId: 1, name: "Node 1", alive: true, sensorCount: 2 }],
        syncBuffer: { completedFrames: 0 },
        failureReasons: [],
      },
      pollSyncStatus: vi.fn(),
    });

    const html = renderToStaticMarkup(<SyncStartupStatusCard />);
    expect(html).toBe("");
  });

  it("renders when sync has failed so the issue is still surfaced globally", () => {
    mockUseDeviceStore.mockReturnValue({
      isConnected: true,
      syncReady: false,
      syncPhase: "error",
      syncState: {
        nodeCount: 1,
        tdmaState: "idle",
        nodes: [{ nodeId: 1, name: "Node 1", alive: false, sensorCount: 2 }],
        syncBuffer: { completedFrames: 0 },
        failureReason: "No complete frames received",
        failureReasons: ["No complete frames received"],
      },
      pollSyncStatus: vi.fn(),
    });

    const html = renderToStaticMarkup(<SyncStartupStatusCard />);
    expect(html).toContain("Sync Attention Required");
    expect(html).toContain("Retry Sync Check");
    expect(html).toContain("No complete frames received");
  });
});
