import { create } from "zustand";
import { connectionManager } from "../lib/connection/ConnectionManager";
import { useDeviceRegistry } from "./useDeviceRegistry";
import { useRecordingStore } from "./useRecordingStore";
import { useNotificationStore } from "./useNotificationStore";
import { useNetworkStore } from "./useNetworkStore";
import type {
  IMUDataPacket,
  EnvironmentalDataPacket,
  JSONPacket,
  NodeInfoPacket,
} from "../lib/protocol/DeviceInterface";
import { useFirmwareStore } from "./useFirmwareStore";
import { useOptionalSensorsStore } from "./useOptionalSensorsStore";
import { liveGapFill } from "../analysis/LiveGapFill";
import { makeDeviceKey } from "../lib/deviceKey";

import {
  syncReadiness,
  type SyncPhase,
  type SyncReadinessState,
} from "../lib/connection/SyncReadiness";
import { resetAllStats as resetSyncedSampleStats } from "../lib/connection/SyncedSampleStats";
import {
  getParserDropCounts,
  resetParserDropCounts,
} from "../lib/connection/IMUParser";
import { evaluateNetworkFrameCompleteness } from "../lib/connection/networkFrameCompleteness";

import { ActivityEngine } from "../lib/analysis/ActivityEngine";
import { useSensorAssignmentStore } from "./useSensorAssignmentStore";
import { visualizationThrottler } from "../lib/visualization/VisualizationThrottler";

/** A node queued on the firmware side while discovery is locked */
export interface PendingNode {
  nodeId: number;
  name: string;
  sensorCount: number;
  hasMag: boolean;
  hasBaro: boolean;
  mac: string;
  receivedAt: number; // Date.now() when we received the notification
}

interface DeviceState {
  isConnected: boolean;
  isScanning: boolean;
  isGateway: boolean;
  battery: number;
  packetRate: number; // Hz
  lastKnownDevice: string | null; // Persisted for reconnection UX

  // Connection Settings (USB Serial via Gateway)
  wifiIP: string | null; // Gateway's WiFi IP when connected (for OTA updates)

  // Sync Readiness Verification
  syncPhase: SyncPhase;
  syncReady: boolean;
  syncState: SyncReadinessState | null;

  // Discovery Lock + Pending Nodes (Tier 2)
  discoveryLocked: boolean;
  pendingNodes: PendingNode[];

  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;
  sendCommand: (cmd: string, params?: unknown) => void;
  setWifiIP: (ip: string | null) => void;
  pollSyncStatus: () => Promise<void>;
  acceptNode: (nodeId: number) => void;
  rejectNode: (nodeId: number) => void;
  acceptAllPendingNodes: () => void;
}

const connectionIngestDiagnostics = {
  rawImuPacketCount: 0,
  acceptedImuPacketCount: 0,
  lastRawImuAt: 0,
  lastAcceptedImuAt: 0,
  lastPacketCompletenessRejectAt: 0,
  lastNetworkCompletenessRejectAt: 0,
};

export function getConnectionIngestDiagnostics() {
  return { ...connectionIngestDiagnostics };
}

// We keep the high-frequency packet data outside the reactive store
// to prevent 60Hz re-renders of the entire UI.
// Components that need 60Hz updates (like the 3D cube) should poll this ref
// or subscribe specifically to the service.
export const latestPacketRef = { current: null as IMUDataPacket | null };

// HMR guard: prevent stacking interval timers when Vite hot-reloads this module.
let _pruneTimerId: ReturnType<typeof setInterval> | null = null;
const SENSOR_TOPOLOGY_WARMUP_MS = 5000;

type FirmwareJsonPacket = JSONPacket & { type: string };

interface SyncStatusJsonPacket extends FirmwareJsonPacket {
  type: "sync_status";
  discoveryLocked?: boolean;
  pendingNodeCount?: number;
}

interface PendingNodeJson {
  nodeId?: number;
  name?: string;
  sensorCount?: number;
  hasMag?: boolean;
  hasBaro?: boolean;
  mac?: string;
}

interface PendingNodesJsonPacket extends FirmwareJsonPacket {
  type: "pending_nodes";
  nodes: PendingNodeJson[];
}

function isFirmwareJsonPacket(packet: unknown): packet is FirmwareJsonPacket {
  return (
    !!packet &&
    typeof packet === "object" &&
    "type" in packet &&
    typeof (packet as { type?: unknown }).type === "string"
  );
}

function formatResetReasonLabel(reason: number): string {
  const labels: Record<number, string> = {
    1: "POWERON",
    3: "SW",
    5: "DEEPSLEEP",
    7: "TASK_WDT",
    8: "WDT",
    9: "SDIO",
    12: "SW_CPU",
    13: "INT_WDT",
    14: "PANIC",
    15: "BROWNOUT",
  };

  return labels[reason] ?? `RESET_${reason}`;
}

export const useDeviceStore = create<DeviceState>((set, get) => {
  // Periodic maintenance: prune stale devices/nodes to prevent ghost entries.
  if (_pruneTimerId !== null) clearInterval(_pruneTimerId);
  _pruneTimerId = setInterval(() => {
    const connected = get().isConnected;
    if (!connected) return;
    useDeviceRegistry.getState().pruneStaleDevices();
    useNetworkStore.getState().pruneStaleNodes();
  }, 1000);

  // Setup callbacks
  // Note: We bind to the manager which handles routing
  connectionManager.onStatus((status) => {
    const isConnected = status === "connected";
    const { success, error } = useNotificationStore.getState();
    const activeType = connectionManager.getActiveType();

    // Check if connected device is a Gateway
    const deviceName = connectionManager.getDeviceName();
    // Serial connections are always to the Gateway firmware in this system.
    const isGateway =
      isConnected &&
      (activeType === "serial" || deviceName?.includes("Gateway") || false);

    if (isConnected) {
      connectStartedAtMs = Date.now();
      firstAcceptedImuLogged = false;
      rawImuPacketCount = 0;
      acceptedImuPacketCount = 0;
      connectionIngestDiagnostics.rawImuPacketCount = 0;
      connectionIngestDiagnostics.acceptedImuPacketCount = 0;
      connectionIngestDiagnostics.lastRawImuAt = 0;
      connectionIngestDiagnostics.lastAcceptedImuAt = 0;
      connectionIngestDiagnostics.lastPacketCompletenessRejectAt = 0;
      connectionIngestDiagnostics.lastNetworkCompletenessRejectAt = 0;
      lastSyncDiagLogMs = 0;
      lastReconcileLogMs = 0;
      lastNoDataWarnMs = 0;
      lastRangeDiagLogMs = 0;
      lastPendingNodesRequestMs = 0;
      observedSensorIds.clear();
      blockedSensorIds.clear();
      readySourceSyncCount = 0;
      readySourceFallbackCount = 0;
      lastReadyState = false;

      // Fresh session baseline: clear stale topology/device state from previous runs.
      useDeviceRegistry.getState().clear();
      useNetworkStore.getState().reset();

      // Persist device name for reconnection UX
      if (deviceName) {
        localStorage.setItem("imu-connect-last-device", deviceName);
        set({ lastKnownDevice: deviceName });
      }

      // Update network topology store
      useNetworkStore
        .getState()
        .setGatewayConnected(true, deviceName || "Device");

      if (isGateway) {
        success(
          "Gateway Connected",
          `Connected to ESP-NOW Gateway via ${activeType.toUpperCase()}`,
        );
      } else {
        success(
          "Connected",
          `Device connected via ${activeType.toUpperCase()}`,
        );
      }

      // Auto-start streaming after a short delay
      setTimeout(async () => {
        // Guard: abort if we disconnected during the delay
        if (!get().isConnected) {
          return;
        }

        try {
          const serialStartup = activeType === "serial";
          if (serialStartup) {
            // In serial mode the gateway prints unframed boot logs until START.
            // Send START early so subsequent command responses stay cleanly framed.
            await connectionManager.sendCommand("START");
            await new Promise((r) => setTimeout(r, 100));
            await connectionManager.sendCommand("RESUME");
            connectionManager
              .sendCommand("GET_PENDING_NODES")
              .catch((e) =>
                console.warn(
                  "[DeviceStore] Initial GET_PENDING_NODES failed:",
                  e,
                ),
              );
          }

          await connectionManager.sendCommand("GET_STATUS");

          // Guard: abort if disconnected mid-sequence
          if (!get().isConnected) return;

          // Firmware-driven labeling/versioning
          await new Promise((r) => setTimeout(r, 150));
          await connectionManager.sendCommand("GET_VERSION");

          // Guard: abort if disconnected mid-sequence
          if (!get().isConnected) return;

          // Delay to let GATT stabilize between commands
          await new Promise((r) => setTimeout(r, 250));

          // Set extended quaternion mode (0x03) as default - includes accel/gyro
          await connectionManager.sendCommand("SET_OUTPUT_MODE", {
            mode: "quaternion_extended",
          });

          // Guard: abort if disconnected mid-sequence
          if (!get().isConnected) return;

          await new Promise((r) => setTimeout(r, 200));
          if (!serialStartup) {
            await connectionManager.sendCommand("START");
          }

          // ================================================================
          // Sync Readiness Verification
          // ================================================================
          // After START, poll GET_SYNC_STATUS to verify TDMA discovery
          // completes, nodes register, and data flows before declaring ready.
          // The UI can show phase progress (discovering → syncing → ready).
          // ================================================================
          set({ syncPhase: "connecting", syncReady: false });
          setTimeout(() => {
            if (get().isConnected && !firstAcceptedImuLogged) {
              console.warn(
                "[ConnDiag] No accepted IMU packets after 5s of connection startup.",
              );
              logConnectionSnapshot("no-imu-5s");
            }
          }, 5000);

          try {
            const finalState = await syncReadiness.waitForReady();
            // Guard: don't update state if disconnected while waiting
            if (!get().isConnected) return;

            const detectedSensors = finalState.nodes.reduce(
              (sum, node) => sum + (node.sensorCount || 0),
              0,
            );

            set({
              syncPhase: "ready",
              syncReady: true,
              syncState: finalState,
            });
            trackReadySource(finalState);

            // Tier 2: Lock discovery only when readiness was confirmed by
            // sync_status (control-plane complete). If we reached ready via
            // IMU fallback, defer lock until sync_status catches up.
            if (finalState.readySource === "sync_status") {
              connectionManager
                .sendCommand("LOCK_DISCOVERY")
                .then(() => {
                  set({ discoveryLocked: true });
                })
                .catch((e) =>
                  console.warn("[DeviceStore] LOCK_DISCOVERY failed:", e),
                );
            }

            success(
              "System Ready",
              `${finalState.nodeCount} node(s), ${detectedSensors} sensor(s), transport sync: ${finalState.syncBuffer.transportSyncRate.toFixed(0)}%`,
            );
          } catch (readinessErr: unknown) {
            // Guard: don't show warnings if we disconnected during verification
            if (!get().isConnected) return;

            console.warn(
              "[SyncReadiness] Verification issue:",
              readinessErr?.message,
            );
            // Don't block streaming on timeout — data may still be flowing
            const phase = syncReadiness.state.phase;
            set({
              syncPhase: phase,
              syncReady: phase === "ready",
              syncState: syncReadiness.state,
            });
            trackReadySource(syncReadiness.state);

            const failureMessage =
              readinessErr instanceof Error
                ? readinessErr.message
                : syncReadiness.state.failureReason ||
                  "Unable to verify node/sensor synchronization";

            warning("Sync Verification Failed", failureMessage);
          }
        } catch (err) {
          console.error("Initialization sequence failed:", err);
        }
      }, 500);
    } else if (status === "disconnected") {
      // OPP-3: Reset live gap fill state on disconnect
      liveGapFill.reset();

      // Clear stale session state on disconnect to avoid ghost nodes/sensors.
      useDeviceRegistry.getState().clear();
      useNetworkStore.getState().reset();

      // Reset sync readiness state on disconnect
      syncReadiness.reset();
      set({
        syncPhase: "idle",
        syncReady: false,
        syncState: null,
        discoveryLocked: false,
        pendingNodes: [],
      });

      // Reset sample/sync statistics so reconnect doesn't show stale metrics
      resetSyncedSampleStats();
      resetParserDropCounts();

      // Clear per-session debug tracking (grows unbounded across reconnects)
      seenSensorIds.clear();
      unexpectedSensorLogTime.clear();
      frames = 0;
      lastTime = performance.now();
      rawImuPacketCount = 0;
      acceptedImuPacketCount = 0;
      firstAcceptedImuLogged = false;
      connectStartedAtMs = 0;
      lastRangeDiagLogMs = 0;
      lastPendingNodesRequestMs = 0;
      observedSensorIds.clear();
      blockedSensorIds.clear();
      readySourceSyncCount = 0;
      readySourceFallbackCount = 0;
      lastReadyState = false;

      // Update network topology store
      useNetworkStore.getState().setGatewayConnected(false);

      // Only show warning if we were previously connected
      const wasConnected = get().isConnected;
      if (wasConnected) {
        const msg =
          activeType === "serial"
            ? "Device connection lost. Close any apps using the port, then click Reconnect."
            : "Device connection lost. Auto-reconnect in progress...";
        warning("Disconnected", msg);
      }
    } else if (status === "error") {
      // Suppress duplicate connect-failure toast while connect() is still
      // handling a richer, transport-specific error.
      if (!get().isScanning) {
        error(
          "Connection Error",
          "Failed to connect to device. Please try again.",
        );
      }
    }

    if (!isConnected) {
      connectionIngestDiagnostics.lastRawImuAt = 0;
      connectionIngestDiagnostics.lastAcceptedImuAt = 0;
      connectionIngestDiagnostics.lastPacketCompletenessRejectAt = 0;
      connectionIngestDiagnostics.lastNetworkCompletenessRejectAt = 0;
    }

    set({ isConnected, isScanning: status === "connecting", isGateway });
  });

  let lastTime = performance.now();
  let frames = 0;
  let rawImuPacketCount = 0;
  let acceptedImuPacketCount = 0;
  let connectStartedAtMs = 0;
  let firstAcceptedImuLogged = false;
  let lastSyncDiagLogMs = 0;
  let lastReconcileLogMs = 0;
  let lastNoDataWarnMs = 0;
  let lastRangeDiagLogMs = 0;
  let lastNetworkCompletenessLogMs = 0;
  let lastPendingNodesRequestMs = 0;
  let readySourceSyncCount = 0;
  let readySourceFallbackCount = 0;
  let lastReadyState = false;
  const observedSensorIds = new Set<number>();
  const blockedSensorIds = new Set<number>();

  const trackReadySource = (state: SyncReadinessState): void => {
    if (state.ready && !lastReadyState) {
      if (state.readySource === "sync_status") {
        readySourceSyncCount++;
      } else if (state.readySource === "imu_fallback") {
        readySourceFallbackCount++;
      }
    }
    lastReadyState = state.ready;
  };

  const getNodeRangesSummary = (): string => {
    const nodes = Array.from(useNetworkStore.getState().nodes.values());
    if (nodes.length === 0) return "none";
    return nodes
      .map((node) => {
        const count =
          typeof node.sensorCount === "number" && node.sensorCount > 0
            ? node.sensorCount
            : node.sensors.size;
        const end = (node.id + Math.max(0, count - 1)) % 256;
        return `${node.id}-${end}(${count})`;
      })
      .join(", ");
  };

  const getAllowedRangesSummary = (): string => {
    const nodes = Array.from(useNetworkStore.getState().nodes.values());
    if (nodes.length === 0) return "none";
    const parts: string[] = [];
    for (const node of nodes) {
      const count =
        typeof node.sensorCount === "number" && node.sensorCount > 0
          ? node.sensorCount
          : node.sensors.size;
      if (!count || count <= 0) continue;
      const end = (node.id + Math.max(0, count - 1)) % 256;
      parts.push(`${node.id}-${end}(${count})`);
    }
    return parts.length > 0 ? parts.join(", ") : "none";
  };

  const getTopologyExpectedSensorCount = (): number => {
    const nodes = Array.from(useNetworkStore.getState().nodes.values());
    return nodes.reduce((sum, node) => {
      const count =
        typeof node.sensorCount === "number" && node.sensorCount > 0
          ? node.sensorCount
          : node.sensors.size;
      return sum + Math.max(0, count);
    }, 0);
  };

  const maybeLogRangeDiagnostics = (reason: string): void => {
    const now = Date.now();
    if (now - lastRangeDiagLogMs < 2000) return;
    lastRangeDiagLogMs = now;
    const observed = Array.from(observedSensorIds).sort((a, b) => a - b);
    const blocked = Array.from(blockedSensorIds).sort((a, b) => a - b);
    console.info(
      `[ConnDiag:ranges] reason=${reason} discoveryLocked=${get().discoveryLocked} allowed=[${getAllowedRangesSummary()}] observed=[${observed.join(",") || "none"}] blocked=[${blocked.join(",") || "none"}] pending=${get().pendingNodes.length}`,
    );
  };

  const requestPendingNodesSnapshot = (
    sensorId: number,
    context: "startup" | "unexpected" = "unexpected",
  ): void => {
    const now = Date.now();
    if (now - lastPendingNodesRequestMs < 2000) return;
    lastPendingNodesRequestMs = now;
    connectionManager
      .sendCommand("GET_PENDING_NODES")
      .catch((e) =>
        console.warn(
          context === "startup"
            ? "[DeviceStore] GET_PENDING_NODES failed during startup warmup:"
            : `[DeviceStore] GET_PENDING_NODES failed while handling unexpected sensorId=${sensorId}:`,
          e,
        ),
      );
  };

  const logConnectionSnapshot = (tag: string): void => {
    const storeState = get();
    const syncState = syncReadiness.state;
    const aliveNodes = syncState.nodes.filter((n) => n.alive).length;
    const parserDrops = getParserDropCounts();

    const serialStats =
      connectionManager.getActiveType() === "serial"
        ? connectionManager.getSerial().getDebugStats()
        : null;
    const serialMsg = serialStats
      ? ` serial={chunks:${serialStats.chunks},bytes:${serialStats.chunkBytes},frames:${serialStats.framesExtracted},pkts:${serialStats.packetsDispatched},ring:${serialStats.ringLength},wring:${serialStats.workerRingLength},pending:${serialStats.pendingFrames},reader:${serialStats.hasReader ? 1 : 0},writer:${serialStats.hasWriter ? 1 : 0},flowPaused:${serialStats.flowPaused ? 1 : 0},ascii:"${serialStats.lastAsciiPreview || ""}"}`
      : "";

    console.info(
      `[ConnDiag:${tag}] connected=${storeState.isConnected} type=${connectionManager.getActiveType()} phase=${storeState.syncPhase} tdma=${syncState.tdmaState} nodes=${syncState.nodeCount} alive=${aliveNodes}/${syncState.nodeCount} expectedSensors=${syncState.syncBuffer.expectedSensors} transportSync=${syncState.syncBuffer.transportSyncRate.toFixed(1)}% strictSync=${syncState.syncBuffer.strictTrueSyncRate.toFixed(1)}% ready=${syncState.ready} readySrc=${syncState.readySource} readySrcCount={sync:${readySourceSyncCount},fallback:${readySourceFallbackCount}} imuRaw=${rawImuPacketCount} imuAccepted=${acceptedImuPacketCount} drops={invalid:${parserDrops.invalid},ghostIdentity:${parserDrops.ghostIdentity},untrusted:${parserDrops.untrusted},corrupt:${parserDrops.corruptFrame}} ranges=[${getNodeRangesSummary()}] reasons=${syncState.failureReasons.slice(0, 2).join(" | ") || "none"}${serialMsg}`,
    );
  };

  // DEBUG: Track unique sensor IDs seen (for multi-sensor node debugging)
  const seenSensorIds = new Set<number>();
  let lastSensorLog = 0;
  const unexpectedSensorLogTime = new Map<number, number>();

  // ========================================================================
  // DEFERRED WORK QUEUE
  // ========================================================================
  // Non-critical per-packet work (network topology, debug logging) is
  // batched and flushed via queueMicrotask to avoid blocking the USB
  // serial read loop. This keeps the critical path (recording + VQF +
  // cache writes) as lean as possible.
  // ========================================================================
  let deferredQueue: Array<() => void> = [];
  let deferredScheduled = false;

  function scheduleDeferredFlush() {
    if (deferredScheduled) return;
    deferredScheduled = true;
    queueMicrotask(() => {
      const batch = deferredQueue;
      deferredQueue = [];
      deferredScheduled = false;
      for (let i = 0; i < batch.length; i++) {
        batch[i]();
      }
    });
  }

  connectionManager.onData((data) => {
    // Handle array of packets or single packet
    const packets = Array.isArray(data) ? data : [data];

    // Forward to Registry for 3D Model updates
    packets.forEach((packet) => {
      if ("quaternion" in packet) {
        // IMU Packet (from SerialConnection via Gateway)
        const imuPacket = packet as IMUDataPacket & { deviceId?: string };
        rawImuPacketCount++;
        connectionIngestDiagnostics.rawImuPacketCount = rawImuPacketCount;
        connectionIngestDiagnostics.lastRawImuAt = Date.now();

        // Guard: ignore malformed IMU-shaped packets without a valid sensorId.
        // These can appear during brief serial corruption and must not be
        // coerced to sensor 0 (which creates ghost entries like MASH Gateway_0).
        if (
          typeof imuPacket.sensorId !== "number" ||
          !Number.isFinite(imuPacket.sensorId)
        ) {
          console.warn(
            "[DeviceStore] Dropping IMU packet with invalid sensorId",
            imuPacket,
          );
          return;
        }

        // Reject sync frames that are incomplete either at the packet level or,
        // once topology is authoritative, relative to the full network.
        if (imuPacket.frameCompleteness) {
          const authoritativeExpectedCount =
            imuPacket.frameCompleteness.authoritativeExpectedCount ??
            get().syncState?.syncBuffer.authoritativeExpectedSensors ??
            get().syncState?.syncBuffer.expectedSensors;
          const activeStreamingCount =
            imuPacket.frameCompleteness.activeStreamingCount ??
            get().syncState?.syncBuffer.activeStreamingSensors;
          imuPacket.frameCompleteness = {
            ...imuPacket.frameCompleteness,
            authoritativeExpectedCount,
            activeStreamingCount,
          };

          const completenessDecision = evaluateNetworkFrameCompleteness({
            validCount: imuPacket.frameCompleteness.validCount,
            packetExpectedCount: imuPacket.frameCompleteness.expectedCount,
            syncExpectedSensors: authoritativeExpectedCount,
            topologyExpectedSensors: getTopologyExpectedSensorCount(),
            discoveryLocked: get().discoveryLocked,
          });

          if (completenessDecision.reject) {
            const now = Date.now();
            if (completenessDecision.networkIsIncomplete) {
              connectionIngestDiagnostics.lastNetworkCompletenessRejectAt = now;
            } else {
              connectionIngestDiagnostics.lastPacketCompletenessRejectAt = now;
            }
            if (now - lastNetworkCompletenessLogMs > 2000) {
              lastNetworkCompletenessLogMs = now;
              console.warn(
                `[ConnDiag] Rejecting network-incomplete frame sensor=${imuPacket.sensorId} frame=${imuPacket.frameNumber} valid=${imuPacket.frameCompleteness.validCount} packetExpected=${imuPacket.frameCompleteness.expectedCount} authoritativeExpected=${completenessDecision.authoritativeExpectedCount} activeStreaming=${get().syncState?.syncBuffer.activeStreamingSensors ?? 0} locked=${get().discoveryLocked} readySrc=${get().syncState?.readySource ?? "none"}`,
              );
              logConnectionSnapshot(
                completenessDecision.networkIsIncomplete
                  ? "network-incomplete-frame"
                  : "packet-incomplete-frame",
              );
            }
            return;
          }

          if (completenessDecision.networkIsIncomplete) {
            const now = Date.now();
            connectionIngestDiagnostics.lastNetworkCompletenessRejectAt = now;
            if (now - lastNetworkCompletenessLogMs > 2000) {
              lastNetworkCompletenessLogMs = now;
              console.info(
                `[ConnDiag] Accepting packet-local sync frame sensor=${imuPacket.sensorId} frame=${imuPacket.frameNumber} valid=${imuPacket.frameCompleteness.validCount} packetExpected=${imuPacket.frameCompleteness.expectedCount} authoritativeExpected=${completenessDecision.authoritativeExpectedCount} activeStreaming=${get().syncState?.syncBuffer.activeStreamingSensors ?? 0} locked=${get().discoveryLocked} readySrc=${get().syncState?.readySource ?? "none"}`,
              );
              logConnectionSnapshot("packet-local-sync-frame");
            }
          }
        }

        observedSensorIds.add(imuPacket.sensorId);

        // Guard: when nodes are discovered, only accept IDs in their announced ranges.
        // This blocks rare transport corruption that can emit bogus sensorId=0.
        const expected = useNetworkStore
          .getState()
          .isExpectedSensorId(imuPacket.sensorId);
        if (!expected) {
          const now = Date.now();
          const discoveryLocked = get().discoveryLocked;
          const inTopologyWarmup =
            connectStartedAtMs > 0 &&
            now - connectStartedAtMs < SENSOR_TOPOLOGY_WARMUP_MS;
          const last = unexpectedSensorLogTime.get(imuPacket.sensorId) || 0;
          if (now - last > 5000) {
            unexpectedSensorLogTime.set(imuPacket.sensorId, now);
            if (inTopologyWarmup) {
              console.info(
                `[DeviceStore] Warmup allow for sensorId=${imuPacket.sensorId} (${SENSOR_TOPOLOGY_WARMUP_MS}ms startup collection window)`,
              );
            } else if (discoveryLocked) {
              console.info(
                `[DeviceStore] Blocking sensorId=${imuPacket.sensorId} (discovery locked) — requesting pending nodes snapshot`,
              );
            } else {
              console.info(
                `[DeviceStore] Blocking unexpected sensorId=${imuPacket.sensorId} while discovery is unlocked`,
              );
            }
          }

          maybeLogRangeDiagnostics(
            inTopologyWarmup
              ? "unexpected-warmup"
              : discoveryLocked
                ? "unexpected-locked"
                : "unexpected-unlocked",
          );

          if (inTopologyWarmup) {
            requestPendingNodesSnapshot(imuPacket.sensorId, "startup");
          }

          if (!inTopologyWarmup) {
            blockedSensorIds.add(imuPacket.sensorId);
            // Strict post-warmup policy: reject any sensor outside known ranges.
            // Legit new sensors must first arrive through discovery/sync_status,
            // which updates allowed ranges before IMU packets are accepted.
            requestPendingNodesSnapshot(imuPacket.sensorId);
            return;
          }

          if (
            !firstAcceptedImuLogged &&
            connectStartedAtMs > 0 &&
            now - connectStartedAtMs > 5000 &&
            now - lastNoDataWarnMs > 5000
          ) {
            lastNoDataWarnMs = now;
            console.warn(
              `[ConnDiag] IMU packets are arriving but being rejected by expected-sensor filter. sensorId=${imuPacket.sensorId}, ranges=[${getNodeRangesSummary()}]`,
            );
            logConnectionSnapshot("expected-filter-drop");
          }
        }
        acceptedImuPacketCount++;
        connectionIngestDiagnostics.acceptedImuPacketCount =
          acceptedImuPacketCount;
        connectionIngestDiagnostics.lastAcceptedImuAt = Date.now();
        syncReadiness.noteAcceptedImuPacket(imuPacket.sensorId);
        if (!firstAcceptedImuLogged) {
          firstAcceptedImuLogged = true;
          const startupMs =
            connectStartedAtMs > 0 ? Date.now() - connectStartedAtMs : 0;
          console.info(
            `[ConnDiag] First accepted IMU packet after ${startupMs}ms (sensor=${imuPacket.sensorId}, frame=${imuPacket.frameNumber ?? "n/a"})`,
          );
          logConnectionSnapshot("first-imu");
        }

        // OPP-3: Live gap fill — detect frame gaps and interpolate
        const filledPackets = liveGapFill.processPacket(imuPacket);

        for (const filledImuPacket of filledPackets) {
          // Carry deviceId through to filled packets
          if ("deviceId" in imuPacket && !("deviceId" in filledImuPacket)) {
            (
              filledImuPacket as IMUDataPacket & { deviceId?: string }
            ).deviceId = imuPacket.deviceId;
          }
          const processedPacket = filledImuPacket as IMUDataPacket & {
            deviceId?: string;
          };

          // ============================================================
          // CRITICAL PATH — runs synchronously, must be fast
          // ============================================================

          // Track data frame for throttler stats (always - full 200Hz)
          visualizationThrottler.recordDataFrame();

          // Visualization updates: Registry updates caches which visualization reads
          // This also calculates VQF fusion and updates packet.quaternion in-place
          useDeviceRegistry.getState().handleRealDeviceData(processedPacket);

          // ALWAYS record at full 200Hz (research-grade recording)
          // MOVED AFTER handleRealDeviceData to capture the FUSED quaternion!
          // NEVER record synthetic gap-filled frames — only real hardware data.
          if (!(filledImuPacket as any).__filled) {
            useRecordingStore.getState().recordFrame(processedPacket);
          }

          // ALWAYS push to ActivityEngine (needs full rate, and benefits from fused data)
          ActivityEngine.push(processedPacket);

          // ============================================================
          // DEFERRED PATH — batched via microtask, not time-critical
          // ============================================================
          const pkt = processedPacket; // capture for closure
          deferredQueue.push(() => {
            // DEBUG: Log unique sensor IDs (throttled to every 5s)
            if (pkt.sensorId !== undefined) {
              seenSensorIds.add(pkt.sensorId);
            }

            // PHASE-1: Use physical identity key (consistent with SerialConnection)
            const deviceKey =
              pkt.deviceId ||
              makeDeviceKey(
                (pkt as IMUDataPacket).rawNodeId,
                (pkt as IMUDataPacket).localSensorIndex,
                pkt.sensorId ?? 0,
              );

            // PIPELINE FIX: Always increment packet counters at full rate (no throttle)
            // Only throttle the Zustand set() that updates sensor metadata / triggers re-renders
            useNetworkStore.getState().countPacket(pkt.sensorId ?? 0);

            // Update network topology store (throttled to ~10Hz to reduce set() overhead)
            const networkThrottleKey = `_netThrottle_${pkt.sensorId ?? 0}`;
            const netNow = Date.now();
            const throttleState = globalThis as typeof globalThis &
              Record<string, unknown>;
            const lastThrottleAt = throttleState[networkThrottleKey];
            if (
              typeof lastThrottleAt !== "number" ||
              netNow - lastThrottleAt >= 100
            ) {
              throttleState[networkThrottleKey] = netNow;
              const device = useDeviceRegistry
                .getState()
                .devices.get(deviceKey);
              const segment = useSensorAssignmentStore
                .getState()
                .getSegmentForSensor(deviceKey);

              useNetworkStore
                .getState()
                .updateFromPacket(pkt.sensorId ?? 0, device?.name, segment);
            }
          });
          scheduleDeferredFlush();
        } // end OPP-3 gap-fill loop
      } else if ("barometer" in packet || "magnetometer" in packet) {
        // Environmental Packet
        const env = packet as EnvironmentalDataPacket;
        useOptionalSensorsStore.getState().updateFromStatus({
          hasMagnetometer: !!env.magnetometer,
          hasBarometer: !!env.barometer,
          magnetometer: env.magnetometer,
          barometer: env.barometer,
        });

        // Record environmental frame if recording is active
        useRecordingStore.getState().recordEnvFrame(env);
      } else if ("nodeName" in packet) {
        // Node Info / Discovery Packet
        const info = packet as NodeInfoPacket;
        useNetworkStore
          .getState()
          .registerNode(
            info.sensorIdOffset,
            info.nodeName,
            info.sensorCount,
            info.hasBarometer,
            info.hasMagnetometer,
          );
      } else if (isFirmwareJsonPacket(packet)) {
        // Firmware JSON packet (GET_STATUS / GET_VERSION / calibration progress, etc.)
        const json = packet;

        if (json.type === "sync_status") {
          try {
            const syncStatus = json as SyncStatusJsonPacket;
            syncReadiness.handleSyncStatusResponse(syncStatus);
            const st = syncReadiness.state;
            set({ syncPhase: st.phase, syncReady: st.ready, syncState: st });
            trackReadySource(st);

            // Keep network topology in lockstep with authoritative sync_status
            // so expected-sensor gating does not depend solely on 0x05 packet timing.
            //
            // IDENTITY FIX: Use compactBase (the Gateway's sequential compact
            // sensor base ID) instead of raw nodeId for registerNode. This
            // ensures the webapp's sensor→node map uses the same compact IDs
            // that appear in 0x25 SyncFrame packets.
            if (Array.isArray(st.nodes) && st.nodes.length > 0) {
              const networkStore = useNetworkStore.getState();
              for (const node of st.nodes) {
                if (!Number.isFinite(node.nodeId) || node.nodeId < 0) continue;
                if (!Number.isFinite(node.sensorCount) || node.sensorCount <= 0)
                  continue;

                // Prefer compact base (matches 0x25 SyncFrame sensor IDs)
                // Fallback to raw nodeId for pre-TDMA or legacy firmware
                const compactBase =
                  typeof node.compactBase === "number" ? node.compactBase : 0;
                const effectiveId = compactBase > 0 ? compactBase : node.nodeId;

                networkStore.registerNode(
                  effectiveId,
                  node.name || `Node ${node.nodeId}`,
                  node.sensorCount,
                  node.hasBaro,
                  node.hasMag,
                  // PHASE-1: Pass raw nodeId so NetworkStore can build the
                  // rawNodeId → compactBase reverse lookup map.
                  node.nodeId,
                );
                networkStore.updateNodeEnvironmental(
                  effectiveId,
                  node.hasBaro,
                  node.hasMag,
                );
              }
            }

            // SWOT-O6: Topology reconciliation — compare gateway vs webapp view.
            // Throttled to once per 5s to avoid log spam. Detects divergence
            // where webapp shows devices the gateway doesn't know about, or
            // gateway has nodes the webapp hasn't registered.
            if (Array.isArray(st.nodes)) {
              const now = Date.now();
              if (now - lastReconcileLogMs > 5000) {
                lastReconcileLogMs = now;
                const networkStore = useNetworkStore.getState();
                const gatewayNodeIds = new Set(
                  st.nodes
                    .filter(
                      (node) =>
                        node.alive &&
                        typeof node.compactBase === "number" &&
                        node.compactBase > 0,
                    )
                    .map((node) => node.compactBase as number),
                );
                const webappNodeIds = new Set(
                  Array.from(networkStore.nodes.keys()),
                );

                const gatewayOnly = [...gatewayNodeIds].filter(
                  (id) => !webappNodeIds.has(id),
                );
                const webappOnly = [...webappNodeIds].filter(
                  (id) => !gatewayNodeIds.has(id),
                );

                if (gatewayOnly.length > 0 || webappOnly.length > 0) {
                  console.warn(
                    `[CONN:RECONCILE] Topology mismatch! gateway-only=[${gatewayOnly.join(",")}] webapp-only=[${webappOnly.join(",")}] (gateway nodes=${gatewayNodeIds.size}, webapp nodes=${webappNodeIds.size})`,
                  );
                }
              }
            }

            if (
              st.ready &&
              st.readySource === "sync_status" &&
              !get().discoveryLocked
            ) {
              connectionManager
                .sendCommand("LOCK_DISCOVERY")
                .then(() => {
                  set({ discoveryLocked: true });
                })
                .catch((e) =>
                  console.warn("[DeviceStore] LOCK_DISCOVERY failed:", e),
                );
            }

            // Track discovery lock state from firmware response
            if (typeof json.discoveryLocked === "boolean") {
              set({ discoveryLocked: json.discoveryLocked });
            }

            const now = Date.now();
            if (now - lastSyncDiagLogMs > 1000) {
              lastSyncDiagLogMs = now;
              const aliveNodes = st.nodes.filter((n) => n.alive).length;
              console.info(
                `[SyncDiag] phase=${st.phase} tdma=${st.tdmaState} nodes=${st.nodeCount} alive=${aliveNodes}/${st.nodeCount} expectedSensors=${st.syncBuffer.authoritativeExpectedSensors} activeStreaming=${st.syncBuffer.activeStreamingSensors} transportSync=${st.syncBuffer.transportSyncRate.toFixed(1)}% strictSync=${st.syncBuffer.strictTrueSyncRate.toFixed(1)}% ready=${st.ready} locked=${json.discoveryLocked ?? "?"} pending=${json.pendingNodeCount ?? 0} reasons=${st.failureReasons.slice(0, 2).join(" | ") || "none"}`,
              );
            }
          } catch (err) {
            console.error("[DeviceStore] sync_status handler error:", err);
          }
        }

        // Tier 2: node_pending — a new node tried to join while discovery was locked
        if (json.type === "node_pending") {
          const pending: PendingNode = {
            nodeId: json.nodeId ?? 0,
            name: json.name ?? `Node ${json.nodeId}`,
            sensorCount: json.sensorCount ?? 0,
            hasMag: json.hasMag ?? false,
            hasBaro: json.hasBaro ?? false,
            mac: json.mac ?? "",
            receivedAt: Date.now(),
          };
          // Deduplicate by nodeId (firmware already dedupes by MAC, but belt & suspenders)
          const existing = get().pendingNodes;
          const updated = existing.filter((n) => n.nodeId !== pending.nodeId);
          updated.push(pending);
          set({ pendingNodes: updated });
          console.info(
            `[DeviceStore] Pending node: ${pending.name} (id=${pending.nodeId}, sensors=${pending.sensorCount})`,
          );
          useNotificationStore
            .getState()
            .warning(
              "New Node Detected",
              `${pending.name} wants to join (${pending.sensorCount} sensor${pending.sensorCount !== 1 ? "s" : ""}). Accept or ignore in the sidebar.`,
            );
        }

        if (json.type === "pending_nodes" && Array.isArray(json.nodes)) {
          const pendingNodes = (json as PendingNodesJsonPacket).nodes;
          const incoming = pendingNodes
            .map((n) => ({
              nodeId: Number(n.nodeId ?? 0),
              name: String(n.name ?? `Node ${n.nodeId ?? "?"}`),
              sensorCount: Number(n.sensorCount ?? 0),
              hasMag: !!n.hasMag,
              hasBaro: !!n.hasBaro,
              mac: String(n.mac ?? ""),
              receivedAt: Date.now(),
            }))
            .filter(
              (n: PendingNode) => Number.isFinite(n.nodeId) && n.nodeId > 0,
            );

          if (incoming.length > 0) {
            const byNodeId = new Map<number, PendingNode>();
            for (const existing of get().pendingNodes) {
              byNodeId.set(existing.nodeId, existing);
            }
            for (const item of incoming) {
              byNodeId.set(item.nodeId, item);
            }
            const updated = Array.from(byNodeId.values()).sort(
              (a, b) => a.nodeId - b.nodeId,
            );
            set({ pendingNodes: updated });
            console.info(
              `[DeviceStore] Pending nodes snapshot: count=${updated.length} ids=[${updated.map((n) => n.nodeId).join(",")}]`,
            );
          }

          if (typeof json.discoveryLocked === "boolean") {
            set({ discoveryLocked: json.discoveryLocked });
          }
        }

        // SWOT-O2: Handle node_pruned — gateway notifies us a node was removed
        if (json.type === "node_pruned" && Number.isFinite(json.nodeId)) {
          console.warn(
            `[CONN:LIFECYCLE] GATEWAY PRUNED node ${json.nodeId} — firmware removed inactive node`,
          );
          // The sync_status that follows will update topology.
          // Log for observability; the sync_status handler does the actual
          // network store update.
        }

        // SWOT-O2: Handle node_registered — gateway notifies us a node joined
        if (
          json.type === "node_registered" &&
          Number.isFinite(json.nodeId) &&
          Number.isFinite(json.sensorCount)
        ) {
          const compactBase =
            Number.isFinite(json.compactBase) && json.compactBase > 0
              ? json.compactBase
              : json.nodeId;
          console.info(
            `[CONN:LIFECYCLE] GATEWAY REGISTERED node ${json.nodeId} (sensors=${json.sensorCount}, compactBase=${compactBase})`,
          );
          // Immediately update network store — don't wait for next sync_status poll
          useNetworkStore
            .getState()
            .registerNode(
              compactBase,
              json.name || `Node ${json.nodeId}`,
              json.sensorCount,
              !!json.hasBaro,
              !!json.hasMag,
              json.nodeId,
            );
        }

        if (
          json.type === "node_power_diag" &&
          Number.isFinite(json.nodeId) &&
          Number.isFinite(json.brownoutCount)
        ) {
          const reason = Number.isFinite(json.lastResetReason)
            ? Number(json.lastResetReason)
            : -1;
          const brownouts = Number(json.brownoutCount);
          const boots = Number.isFinite(json.bootCount)
            ? Number(json.bootCount)
            : -1;
          const recovery = !!json.recoveryActive;

          const reasonLabel = formatResetReasonLabel(reason);
          console.warn(
            `[CONN:POWER] node=${json.nodeId} boots=${boots} brownouts=${brownouts} last=${reasonLabel} recovery=${recovery}`,
          );
        }

        if (
          json.type === "node_tdma_diag" &&
          Number.isFinite(json.nodeId) &&
          Number.isFinite(json.intervalMs)
        ) {
          const intervalMs = Math.max(1, Number(json.intervalMs));
          const txAttempts = Number.isFinite(json.txAttempts)
            ? Number(json.txAttempts)
            : 0;
          const txSuccess = Number.isFinite(json.txSuccess)
            ? Number(json.txSuccess)
            : 0;
          const txFail = Number.isFinite(json.txFail) ? Number(json.txFail) : 0;
          const txStallClears = Number.isFinite(json.txStallClears)
            ? Number(json.txStallClears)
            : 0;
          const staleIncompleteDrops = Number.isFinite(
            json.staleIncompleteDrops,
          )
            ? Number(json.staleIncompleteDrops)
            : 0;
          const maxQueueDepth = Number.isFinite(json.maxQueueDepth)
            ? Number(json.maxQueueDepth)
            : 0;
          const currentFrame = Number.isFinite(json.currentFrame)
            ? Number(json.currentFrame)
            : -1;
          const successPct =
            txAttempts > 0 ? (txSuccess / txAttempts) * 100 : 100;
          const effectiveSensorHz = (txSuccess * 4 * 1000) / intervalMs;
          const level =
            txFail > 0 || txStallClears > 0 || staleIncompleteDrops > 0
              ? console.warn
              : console.info;

          level(
            `[CONN:TDMA] node=${json.nodeId} frame=${currentFrame} interval=${intervalMs}ms attempts=${txAttempts} success=${txSuccess} fail=${txFail} successPct=${successPct.toFixed(1)} sensorHz=${effectiveSensorHz.toFixed(1)} stalls=${txStallClears} staleDrops=${staleIncompleteDrops} qMax=${maxQueueDepth}`,
          );
        }

        if (json.type === "flow" && typeof json.status === "string") {
          console.info(`[FlowCtrl] Gateway serial flow status: ${json.status}`);
        }

        if (json.type === "status") {
          if (json.role === "gateway") {
            set({ isGateway: true });
            // Ensure topology store has a stable friendly gateway name.
            useNetworkStore
              .getState()
              .setGatewayConnected(true, "MASH Gateway");
          }
        }

        if (json.type === "version" && typeof json.version === "string") {
          const firmware = {
            version: json.version,
            major: Number(json.major ?? 0),
            minor: Number(json.minor ?? 0),
            patch: Number(json.patch ?? 0),
            role:
              json.role === "node" || json.role === "standalone"
                ? json.role
                : "gateway",
          } as const;

          // If we're connected to the gateway (typical), store as gateway firmware.
          // If a direct node connection is ever used, this still keeps the UI informed.
          useFirmwareStore.getState().setGatewayFirmware({
            ...firmware,
            role: firmware.role === "node" ? "standalone" : firmware.role,
          });

          const friendlyName =
            firmware.role === "gateway"
              ? `MASH Gateway v${firmware.version}`
              : `Device v${firmware.version}`;

          localStorage.setItem("imu-connect-last-device", friendlyName);
          set({ lastKnownDevice: friendlyName });
          useNetworkStore.getState().setGatewayConnected(true, friendlyName);
        }
      }
    });

    // Compatibility for legacy components
    const firstImu = packets.find(
      (p): p is IMUDataPacket =>
        !!p && typeof p === "object" && "quaternion" in p,
    );
    if (firstImu) latestPacketRef.current = firstImu;

    // Update battery and Stats at a lower rate (e.g. 1Hz)
    const statsNow = performance.now();
    frames++;
    if (statsNow - lastTime >= 1000) {
      set({
        battery: firstImu?.battery || 0, // Use first IMU packet battery if present
        packetRate: Math.round((frames * 1000) / (statsNow - lastTime)),
      });
      lastTime = statsNow;
      frames = 0;
    }
  });

  return {
    isConnected: false,
    isScanning: false,
    isGateway: false,
    battery: 0,
    packetRate: 0,
    lastKnownDevice: localStorage.getItem("imu-connect-last-device"),

    wifiIP: null, // For OTA firmware updates only

    // Sync Readiness initial state
    syncPhase: "idle" as SyncPhase,
    syncReady: false,
    syncState: null,

    // Discovery Lock + Pending Nodes (Tier 2) initial state
    discoveryLocked: false,
    pendingNodes: [],

    setWifiIP: (ip) => {
      set({ wifiIP: ip });
    },

    connect: async () => {
      const { error } = useNotificationStore.getState();
      set({ isScanning: true });
      let connectErr: unknown = null;

      try {
        await connectionManager.connect();
        return;
      } catch (e) {
        connectErr = e;
      }

      const errMsg =
        connectErr instanceof Error ? connectErr.message : String(connectErr);

      console.error("Connect failed", connectErr);
      set({ isScanning: false });

      // User-friendly error messages
      if (errMsg.includes("cancelled") || errMsg.includes("canceled")) {
        // User cancelled - no notification needed
      } else if (errMsg.includes("serial") || errMsg.includes("Serial")) {
        error("Serial Connection Failed", errMsg);
      } else {
        error("Connection Failed", errMsg || "Unable to connect to device.");
      }
    },

    disconnect: () => {
      connectionManager.disconnect();
      // Clear registry to prevent ghost sensors
      useDeviceRegistry.getState().clear();
    },

    sendCommand: (cmd: string, params?: unknown) => {
      connectionManager.sendCommand(cmd, params);
    },

    pollSyncStatus: async () => {
      await connectionManager.sendCommand("GET_SYNC_STATUS");
    },

    acceptNode: (nodeId: number) => {
      connectionManager
        .sendCommand("ACCEPT_NODE", { nodeId })
        .then(() => {
          // Remove from pending list optimistically
          const updated = get().pendingNodes.filter((n) => n.nodeId !== nodeId);
          set({ pendingNodes: updated });
          useNotificationStore
            .getState()
            .success("Node Accepted", `Node ${nodeId} added — re-syncing.`);
          console.info(`[DeviceStore] Accepted pending node ${nodeId}`);
        })
        .catch((e) => {
          console.warn(`[DeviceStore] ACCEPT_NODE ${nodeId} failed:`, e);
          useNotificationStore
            .getState()
            .error("Accept Failed", `Could not accept node ${nodeId}.`);
        });
    },

    rejectNode: (nodeId: number) => {
      connectionManager
        .sendCommand("REJECT_NODE", { nodeId })
        .then(() => {
          const updated = get().pendingNodes.filter((n) => n.nodeId !== nodeId);
          set({ pendingNodes: updated });
          console.info(`[DeviceStore] Rejected pending node ${nodeId}`);
        })
        .catch((e) => {
          console.warn(`[DeviceStore] REJECT_NODE ${nodeId} failed:`, e);
        });
    },

    acceptAllPendingNodes: () => {
      const nodes = get().pendingNodes;
      for (const node of nodes) {
        get().acceptNode(node.nodeId);
      }
    },
  };
});

if (typeof window !== "undefined") {
  const debugWindow = window as Window & {
    __mashConnDiag?: () => Record<string, unknown>;
  };

  debugWindow.__mashConnDiag = () => {
    const state = useDeviceStore.getState();
    const serialStats =
      connectionManager.getActiveType() === "serial"
        ? connectionManager.getSerial().getDebugStats()
        : null;
    const snapshot = {
      connected: state.isConnected,
      connectionType: state.connectionType,
      syncPhase: state.syncPhase,
      syncReady: state.syncReady,
      syncState: syncReadiness.state,
      parserDrops: getParserDropCounts(),
      serialStats,
    };
    console.info("[ConnDiag] Manual snapshot", snapshot);
    return snapshot;
  };
}
