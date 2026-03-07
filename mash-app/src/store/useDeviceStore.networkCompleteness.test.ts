import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMUDataPacket } from "../lib/protocol/DeviceInterface";
import { connectionManager } from "../lib/connection/ConnectionManager";
import { useDeviceRegistry } from "./useDeviceRegistry";
import {
  getConnectionIngestDiagnostics,
  useDeviceStore,
} from "./useDeviceStore";
import { useNetworkStore } from "./useNetworkStore";

function emitSerialData(data: unknown): void {
  const serial = connectionManager.getSerial() as unknown as {
    _onData?: (payload: unknown) => void;
  };
  serial._onData?.(data);
}

function makeSyncStatus(authoritativeExpectedSensors: number) {
  return {
    type: "sync_status",
    tdmaState: "running",
    nodeCount: 1,
    nodes: [
      {
        nodeId: 11,
        name: "Node 11",
        sensorCount: authoritativeExpectedSensors,
        alive: true,
        compactBase: 1,
      },
    ],
    syncBuffer: {
      initialized: true,
      expectedSensors: authoritativeExpectedSensors,
      authoritativeExpectedSensors,
      activeStreamingSensors: Math.max(1, authoritativeExpectedSensors - 2),
      completedFrames: 1,
      trulyComplete: 1,
      partialRecovery: 0,
      dropped: 0,
      incomplete: 0,
      trueSyncRate: 100,
    },
    readiness: {
      tdmaRunning: true,
      hasAliveNodes: true,
      bufferReady: true,
      syncQualityOk: true,
      syncRate: 100,
    },
    ready: false,
    discoveryLocked: false,
  };
}

function makeImuPacket(
  frameCompleteness: NonNullable<IMUDataPacket["frameCompleteness"]>,
): IMUDataPacket & { deviceId: string } {
  return {
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
    frameCompleteness,
    deviceId: "node_11_s0",
  };
}

describe("useDeviceStore network completeness ingress", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    useDeviceRegistry.getState().clear();
    useNetworkStore.getState().reset();
    useDeviceStore.setState({
      discoveryLocked: false,
      syncReady: false,
      syncPhase: "idle",
      syncState: undefined,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useDeviceRegistry.getState().clear();
    useNetworkStore.getState().reset();
  });

  it("accepts packet-local frames even when they are incomplete for the full network", () => {
    emitSerialData(makeSyncStatus(12));

    emitSerialData(
      makeImuPacket({
        validCount: 10,
        expectedCount: 10,
        isComplete: true,
      }),
    );

    expect(useNetworkStore.getState().nodes.size).toBe(1);
    expect(useDeviceRegistry.getState().devices.has("node_11_s0")).toBe(true);
    expect(
      getConnectionIngestDiagnostics().lastNetworkCompletenessRejectAt,
    ).toBeGreaterThan(0);
  });

  it("accepts frames that satisfy the authoritative network count", () => {
    emitSerialData(makeSyncStatus(12));

    emitSerialData(
      makeImuPacket({
        validCount: 12,
        expectedCount: 12,
        isComplete: true,
      }),
    );

    expect(useNetworkStore.getState().nodes.size).toBe(1);
    expect(useDeviceRegistry.getState().devices.has("node_11_s0")).toBe(true);
  });
});
