/**
 * Network Store: Tracks mesh network topology state
 * Gateway → Nodes → Sensors hierarchy with real-time status
 */

import { create } from "zustand";
import {
  registerNodeId,
  getNodeDisplayName,
  resetNodeRegistry,
} from "../lib/nodeDisplayName";
import {
  STALE_THRESHOLD_MS,
  OFFLINE_THRESHOLD_MS,
  PRUNE_THRESHOLD_MS,
} from "../lib/connection/SyncedSampleStats";

export interface SensorInfo {
  id: number;
  name: string;
  segment: string | null;
  lastSeen: number; // Timestamp
  packetsReceived: number;
}

export interface NodeInfo {
  id: number; // Node ID (= compactBase from gateway, used for _sensorToNodeMap)
  rawNodeId?: number; // Physical MAC-derived node ID from firmware (stable across topology changes)
  name: string;
  firmwareName?: string; // Original name from firmware NodeInfo (e.g. "MASH", custom name)
  sensors: Map<number, SensorInfo>;
  lastPacketTime: number;
  totalPackets: number;
  sensorCount?: number;
  hasBarometer: boolean;
  hasMagnetometer: boolean;
}

export interface GatewayInfo {
  connected: boolean;
  name: string;
  packetsForwarded: number;
  connectedSince: number;
}

interface NetworkState {
  gateway: GatewayInfo;
  nodes: Map<number, NodeInfo>;

  // Actions
  setGatewayConnected: (connected: boolean, name?: string) => void;
  /** Fast packet counter — called at full 200Hz rate, does NOT trigger Zustand re-render */
  countPacket: (sensorId: number) => void;
  /** Throttled metadata update (~10Hz) — updates sensor name, segment, lastSeen */
  updateFromPacket: (
    sensorId: number,
    sensorName?: string,
    segment?: string | null,
  ) => void;
  registerNode: (
    nodeId: number,
    name: string,
    sensorCount: number,
    hasBaro: boolean,
    hasMag: boolean,
    rawNodeId?: number,
  ) => void;
  updateNodeEnvironmental: (
    nodeId: number,
    hasBaro: boolean,
    hasMag: boolean,
  ) => void;
  pruneStaleNodes: () => void;
  reset: () => void;

  // Computed
  getNodeForSensor: (sensorId: number) => number;
  getNodeNameForSensor: (sensorId: number) => string | null;
  getNodeSensorCount: (sensorId: number) => number | undefined;
  getSensorRelativeIndex: (sensorId: number) => number | null;
  isExpectedSensorId: (sensorId: number) => boolean;
  getSensorStatus: (sensorId: number) => "active" | "stale" | "offline";
  getNodeStatus: (nodeId: number) => "active" | "stale" | "offline";

  // PHASE-1: Physical identity lookups
  /** Get node info by physical rawNodeId (MAC-derived) */
  getNodeByRawId: (rawNodeId: number) => NodeInfo | null;
  /** Get node name by rawNodeId for display */
  getNodeNameByRawId: (rawNodeId: number) => string | null;
  /** Get sensor count for a node by rawNodeId */
  getNodeSensorCountByRawId: (rawNodeId: number) => number | undefined;
}

// Sensor ID → Node ID lookup table (populated from Node Info + sync_status)
// Maps each compact sensorId to its owning compact nodeId (base) so that
// incoming 0x25 SyncFrame samples route to the correct node.
const _sensorToNodeMap = new Map<number, number>();

// PHASE-1: Raw node ID → compact node ID reverse map.
// Allows looking up node metadata when we only have the physical rawNodeId.
const _rawToCompactNodeMap = new Map<number, number>();

/**
 * Derive Node ID from Sensor ID.
 * Uses the lookup table populated by registerNode() when Node Info packets arrive.
 * Fallback: treat sensorId as its own node (single-sensor node or pre-discovery).
 */
const getNodeId = (sensorId: number): number => {
  return _sensorToNodeMap.get(sensorId) ?? sensorId;
};

export const useNetworkStore = create<NetworkState>()((set, get) => ({
  gateway: {
    connected: false,
    name: "",
    packetsForwarded: 0,
    connectedSince: 0,
  },
  nodes: new Map(),

  setGatewayConnected: (connected, name) => {
    set((state) => ({
      gateway: {
        ...state.gateway,
        connected,
        name: name || state.gateway.name,
        connectedSince: connected ? Date.now() : state.gateway.connectedSince,
      },
    }));
  },

  // PIPELINE FIX: Fast counter — mutates in place, no Zustand set()
  // Called at full 200Hz. Counters are read on next UI tick.
  countPacket: (sensorId) => {
    const state = get();
    const nodeId = getNodeId(sensorId);
    const node = state.nodes.get(nodeId);
    if (node) {
      node.totalPackets++;
      const sensor = node.sensors.get(sensorId);
      if (sensor) sensor.packetsReceived++;
    }
    // Gateway counter — mutate directly (read on next render)
    (state.gateway as GatewayInfo).packetsForwarded++;
  },

  updateFromPacket: (sensorId, sensorName, segment) => {
    const nodeId = getNodeId(sensorId);
    const now = Date.now();
    // Is this a real node mapping or just the sensorId fallback?
    const isRealMapping = _sensorToNodeMap.has(sensorId);

    set((state) => {
      const nodes = new Map(state.nodes);
      let node = nodes.get(nodeId);

      if (!node) {
        // Only register in the display-name registry when we have a real
        // node→sensor mapping (from NodeInfo / sync_status).  Without it,
        // nodeId === sensorId, and registering every sensor as its own
        // "node" pollutes the sequential Node 1/2/3 numbering.
        const displayName = isRealMapping
          ? (() => {
              registerNodeId(nodeId);
              return getNodeDisplayName(nodeId);
            })()
          : `Node (${nodeId})`; // Temporary placeholder — will be replaced by registerNode()

        node = {
          id: nodeId,
          name: displayName,
          sensors: new Map(),
          lastPacketTime: now,
          totalPackets: 0,
          sensorCount: undefined,
          hasBarometer: false,
          hasMagnetometer: false,
        };
      }

      // Update sensor metadata (name, segment, lastSeen) — counters handled by countPacket()
      const existingSensor = node.sensors.get(sensorId);
      node.sensors.set(sensorId, {
        id: sensorId,
        name: sensorName || existingSensor?.name || `IMU ${sensorId}`,
        segment:
          segment !== undefined ? segment : existingSensor?.segment || null,
        lastSeen: now,
        packetsReceived: existingSensor?.packetsReceived || 0,
      });

      node.lastPacketTime = now;

      nodes.set(nodeId, node);

      return {
        nodes,
        gateway: state.gateway, // Don't spread — counters mutated by countPacket()
      };
    });
  },

  registerNode: (nodeId, name, sensorCount, hasBaro, hasMag, rawNodeId) => {
    const now = Date.now();
    registerNodeId(nodeId);

    // LIFECYCLE LOG: Node registration event
    console.info(
      `[CONN:LIFECYCLE] REGISTER node: id=${nodeId} name="${name}" sensors=${sensorCount} rawNodeId=${rawNodeId ?? "n/a"} hasMag=${hasMag} hasBaro=${hasBaro}`,
    );

    // PHASE-1: Track rawNodeId → compactBase mapping
    if (rawNodeId !== undefined && rawNodeId > 0) {
      _rawToCompactNodeMap.set(rawNodeId, nodeId);
    }

    // Use firmware-provided name when it's meaningful (not the generic default).
    // Generic defaults: "MASH", empty, or starts with "Node-" (gateway placeholder).
    const isGenericFwName =
      !name ||
      name === "MASH" ||
      name.startsWith("Node-") ||
      /^Node\s+\d+$/.test(name);
    const logicalName = isGenericFwName ? getNodeDisplayName(nodeId) : name;

    // Populate sensor→node lookup for all sensors belonging to this node.
    // After the compact-ID fix, nodeId here is the Gateway-assigned compact
    // base (sequential, 1-based).  Sensor IDs are nodeId+0 .. nodeId+(sensorCount-1),
    // matching the compact IDs used in 0x25 SyncFrame packets.
    for (let i = 0; i < sensorCount; i++) {
      _sensorToNodeMap.set((nodeId + i) % 256, nodeId);
    }

    set((state) => {
      const nodes = new Map(state.nodes);
      let node = nodes.get(nodeId);

      // Create or Update
      if (!node) {
        node = {
          id: nodeId,
          rawNodeId: rawNodeId,
          name: logicalName,
          firmwareName: name || undefined,
          sensors: new Map(),
          lastPacketTime: now,
          totalPackets: 0,
          sensorCount: sensorCount, // Store reported count
          hasBarometer: hasBaro,
          hasMagnetometer: hasMag,
        };
      } else {
        // Update existing node metadata if changed
        if (
          node.name !== logicalName ||
          node.hasBarometer !== hasBaro ||
          node.sensorCount !== sensorCount
        ) {
          node = {
            ...node,
            rawNodeId: rawNodeId ?? node.rawNodeId,
            name: logicalName,
            firmwareName: name || node.firmwareName,
            hasBarometer: hasBaro,
            hasMagnetometer: hasMag,
            sensorCount: sensorCount,
            lastPacketTime: now, // Treat discovery as a "heartbeat"
          };
        } else {
          // Just update heartbeat
          node.lastPacketTime = now;
        }
      }

      // Clean up phantom nodes: before NodeInfo arrived, `updateFromPacket`
      // may have created individual node entries keyed by sensor IDs (because
      // _sensorToNodeMap wasn't populated yet).  Now that we know the real
      // mapping, merge their sensor data into this node and delete them.
      for (let i = 1; i < sensorCount; i++) {
        const phantomId = (nodeId + i) % 256;
        const phantomNode = nodes.get(phantomId);
        if (phantomNode && phantomId !== nodeId) {
          // Migrate any sensor data collected under the phantom entry
          for (const [sId, sensorData] of phantomNode.sensors) {
            if (!node.sensors.has(sId)) {
              node.sensors.set(sId, sensorData);
            }
          }
          nodes.delete(phantomId);
        }
      }

      nodes.set(nodeId, node);
      return { nodes };
    });
  },

  updateNodeEnvironmental: (nodeId, hasBaro, hasMag) => {
    set((state) => {
      const nodes = new Map(state.nodes);
      const node = nodes.get(nodeId);
      if (node) {
        nodes.set(nodeId, {
          ...node,
          hasBarometer: hasBaro,
          hasMagnetometer: hasMag,
        });
      }
      return { nodes };
    });
  },

  pruneStaleNodes: () => {
    const now = Date.now();
    set((state) => {
      const nodes = new Map(state.nodes);
      let changed = false;

      for (const [nodeId, node] of state.nodes.entries()) {
        const ageMs = now - node.lastPacketTime;
        const isPlaceholder =
          (typeof node.sensorCount !== "number" || node.sensorCount <= 0) &&
          node.sensors.size === 0;

        // Stability-first behavior:
        // - Keep known nodes (with sensor metadata/history) even if temporarily
        //   offline, so the UI topology doesn't churn during packet jitter.
        // - Only prune stale placeholder nodes that never resolved.
        if (isPlaceholder && ageMs > PRUNE_THRESHOLD_MS) {
          console.info(
            `[CONN:LIFECYCLE] PRUNE node: id=${nodeId} (placeholder, no sensors, stale ${(ageMs / 1000).toFixed(1)}s)`,
          );
          nodes.delete(nodeId);

          // NOTE: We intentionally do NOT delete _sensorToNodeMap entries here.
          // The sensorId→nodeId mapping is stable topology info learned from
          // NodeInfo discovery packets. Clearing it during a transient prune
          // breaks isExpectedSensorId() and causes valid packets to be dropped
          // until the next NodeInfo packet re-registers the mapping.

          changed = true;
        }
      }

      return changed ? { nodes } : {};
    });
  },

  reset: () => {
    _sensorToNodeMap.clear();
    _rawToCompactNodeMap.clear();
    resetNodeRegistry();
    set({
      gateway: {
        connected: false,
        name: "",
        packetsForwarded: 0,
        connectedSince: 0,
      },
      nodes: new Map(),
    });
  },

  getNodeForSensor: (sensorId) => getNodeId(sensorId),

  getNodeNameForSensor: (sensorId) => {
    // Only return a node name when we have a CONFIRMED mapping from
    // registerNode() (via NodeInfo or sync_status).  Without it, getNodeId()
    // falls back to sensorId which hits a phantom node created by
    // updateFromPacket — returning its placeholder name would mislead the UI.
    if (!_sensorToNodeMap.has(sensorId)) return null;
    const nodeId = _sensorToNodeMap.get(sensorId)!;
    const node = get().nodes.get(nodeId);
    return node?.name || null;
  },

  getNodeSensorCount: (sensorId) => {
    if (!_sensorToNodeMap.has(sensorId)) return undefined;
    const nodeId = _sensorToNodeMap.get(sensorId)!;
    const node = get().nodes.get(nodeId);
    return node?.sensorCount;
  },

  getSensorRelativeIndex: (sensorId) => {
    if (!_sensorToNodeMap.has(sensorId)) return null;
    const nodeId = _sensorToNodeMap.get(sensorId)!;
    let diff = sensorId - nodeId;
    // Handle wrap-around (e.g. sensor 0 belonging to Node 253 with offset 3)
    if (diff < 0) diff += 256;
    return diff;
  },

  isExpectedSensorId: (sensorId) => {
    const nodes = get().nodes;

    // If we haven't discovered any nodes yet, don't block early packets.
    if (nodes.size === 0) return true;

    let hasKnownRanges = false;

    for (const node of nodes.values()) {
      const countFromMeta =
        typeof node.sensorCount === "number" && node.sensorCount > 0
          ? node.sensorCount
          : node.sensors.size;
      const count = countFromMeta;
      if (!count || count <= 0) continue;
      hasKnownRanges = true;

      // Handle wrap-around ID ranges (uint8 arithmetic)
      const rel = (sensorId - node.id + 256) % 256;
      if (rel >= 0 && rel < count) {
        return true;
      }
    }

    // If all nodes are still "unknown-size" placeholders, allow packets until
    // NodeInfo metadata arrives and defines concrete ranges.
    if (!hasKnownRanges) return true;

    return false;
  },

  getSensorStatus: (sensorId) => {
    const nodeId = getNodeId(sensorId);
    const node = get().nodes.get(nodeId);
    const sensor = node?.sensors.get(sensorId);
    if (!sensor) return "offline";

    const age = Date.now() - sensor.lastSeen;
    if (age < STALE_THRESHOLD_MS) return "active";
    if (age < OFFLINE_THRESHOLD_MS) return "stale";
    return "offline";
  },

  getNodeStatus: (nodeId) => {
    const node = get().nodes.get(nodeId);
    if (!node) return "offline";

    const age = Date.now() - node.lastPacketTime;
    if (age < STALE_THRESHOLD_MS) return "active";
    if (age < OFFLINE_THRESHOLD_MS) return "stale";
    return "offline";
  },

  // PHASE-1: Physical identity lookups
  getNodeByRawId: (rawNodeId) => {
    const compactBase = _rawToCompactNodeMap.get(rawNodeId);
    if (compactBase === undefined) return null;
    return get().nodes.get(compactBase) ?? null;
  },

  getNodeNameByRawId: (rawNodeId) => {
    const compactBase = _rawToCompactNodeMap.get(rawNodeId);
    if (compactBase === undefined) return null;
    const node = get().nodes.get(compactBase);
    return node?.name ?? null;
  },

  getNodeSensorCountByRawId: (rawNodeId) => {
    const compactBase = _rawToCompactNodeMap.get(rawNodeId);
    if (compactBase === undefined) return undefined;
    const node = get().nodes.get(compactBase);
    return node?.sensorCount;
  },
}));
