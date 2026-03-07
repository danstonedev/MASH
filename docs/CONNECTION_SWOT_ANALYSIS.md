# MASH Connection Pipeline — SWOT Analysis

**Date:** 2026-03-04  
**Updated:** 2026-03-04  
**Scope:** End-to-end connection lifecycle: ESP-NOW node→gateway→USB serial→webapp

---

## Resolution Status

| ID | Item | Status | Details |
|----|------|--------|---------|
| W1 | Unified lifecycle logging | ✅ Resolved | `[CONN:LIFECYCLE]` tags added across all 6 layers: pruneStaleNodes, pruneStaleDevices, DisconnectionAlert guards, expected-sensor gating |
| W2 | Compact sync_status useless | ✅ Resolved | `emitCompactSyncStatusDirect()` now includes full per-node array (nodeId, alive, lastHeardMs, sensorCount, compactBase, name) |
| W3 | Gateway prune invisible to webapp | ✅ Resolved | Firmware now emits `node_pruned` JSON event per pruned node via `enqueueJsonFrame()` — bypasses `suppressSerialLogs` |
| W4 | Network store prune silent | ✅ Resolved | `pruneStaleNodes()` logs `[CONN:LIFECYCLE] PRUNE node` with age details |
| W5 | Expected-sensor gating race | ✅ Mitigated | 5s warmup window + sync_status topology sync + `node_registered` immediate JSON event |
| W6 | DisconnectionAlert debounce | ✅ Resolved | 2s `setTimeout` debounce before setting `lastDisconnectedDeviceId` — recoveries within 2s are suppressed |
| W7 | Stream latch prevents STOP | ⚠️ Noted | Intentional design — gateway must always forward data. Prune intervals are appropriate for streaming. |
| W8 | Prune interval mismatch | ⚠️ Noted | Gateway prunes at 10s inactivity. Webapp prunes transient at 8s, marks offline at 5s. Reconciliation logic now detects divergence. |
| O1 | Unified lifecycle logger | ✅ Resolved | `[CONN:LIFECYCLE]` tags across all layers with standardized format |
| O2 | Firmware prune notifications | ✅ Resolved | `node_pruned` JSON frames emitted per pruned node; `node_registered` JSON frames on new node join |
| O3 | Per-node data in sync_status | ✅ Resolved | Full per-node data already present in compact sync_status |
| O4 | Connection diagnostic panel | 🔜 Future | Requires UI work to surface lifecycle logs in webapp debug panel |
| O5 | Debounce disconnect alert | ✅ Resolved | 2s debounce implemented with recovery detection |
| O6 | Prune reconciliation | ✅ Resolved | Periodic (5s) topology reconciliation compares gateway vs webapp node sets; logs `[CONN:RECONCILE]` on mismatch |
| O7 | Log suppression bypass | ✅ Resolved | Critical lifecycle events (prune/register) now use JSON frames via `enqueueJsonFrame()` which bypasses `suppressSerialLogs` |
| T1 | Silent data loss | ✅ Mitigated | Lifecycle logging across all layers + reconciliation provides visibility within 5s |
| T2 | USB buffer stall cascade | ✅ Mitigated | 2s disconnect debounce prevents false cascading alerts from transient USB stalls |
| T3 | Topology desync | ✅ Resolved | `[CONN:RECONCILE]` periodic divergence detection + immediate `node_pruned`/`node_registered` events |
| T4 | Node ID reuse after prune | ✅ Mitigated | `handleRealDeviceData` updates in-place; `node_registered` JSON event triggers immediate `registerNode()` |

---

## Executive Summary

Sensor "random" appearance/disappearance is **not random** — it's caused by deterministic but poorly-observable decision points scattered across firmware and webapp. The system has **6 independent pruning/gating layers**, each with its own timeout, and **zero unified logging** that traces a sensor from radio to screen. This analysis maps every decision point, identifies root causes, and prescribes fixes.

---

## The Full Decision Chain (How a sensor lives or dies)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: FIRMWARE — Gateway SyncManager (C++)                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Decision: "Is this node registered?"                                ││
│  │ Gate:     handleNodeRegistration() — checks TDMA_MAX_NODES slots   ││
│  │ Reject:   Frame overbudget → REJECTED (silent to webapp)           ││
│  │           Discovery locked → queued in pendingNodes[]              ││
│  │           ID collision → SET_NODE_ID sent, node reboots            ││
│  │ Timeout:  pruneInactiveNodes() → 10s no lastHeard → unregistered  ││
│  │           But isStreaming → prune interval is 30s (not 5s)         ││
│  │ Log:      "[TDMA] Pruning inactive node X" — only visible on      ││
│  │           Serial Monitor, NOT forwarded to webapp                  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  LAYER 2: FIRMWARE — sync_status emission                               │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Decision: "Is this node alive?"                                    ││
│  │ Gate:     (now - lastHeard) < 5000 → alive=true                   ││
│  │ Issue:    Compact emitCompactSyncStatusDirect() sends "nodes":[]  ││
│  │           (EMPTY array!) — webapp gets no per-node data from the   ││
│  │           periodic push. Only GET_SYNC_STATUS command response     ││
│  │           includes per-node details.                               ││
│  │ Impact:   Webapp depends on periodic sync_status for topology,    ││
│  │           but the periodic version has NO node data.               ││
│  └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
          │ USB Serial (921600 baud, framed binary)
          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  LAYER 3: WEBAPP — useDeviceStore.ts: Expected Sensor Gating            │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Decision: "Is this sensorId expected?"                             ││
│  │ Gate:     useNetworkStore.isExpectedSensorId(sensorId)            ││
│  │           Checks if sensorId falls within [nodeBase..nodeBase+N)  ││
│  │           for ANY known node.                                     ││
│  │ Reject:   discoveryLocked + unexpected → BLOCKED (packet dropped) ││
│  │ Warmup:   First 5s after connect → all packets allowed            ││
│  │ Log:      "[DeviceStore] Blocking sensorId=X" — throttled 5s     ││
│  │ Problem:  If sync_status hasn't arrived yet, node ranges unknown  ││
│  │           → valid sensors get blocked. Race condition.             ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  LAYER 4: WEBAPP — useDeviceRegistry.ts: pruneStaleDevices()            │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Decision: "Is this device stale/offline/pruneable?"               ││
│  │ Timer:    setInterval(1000ms) in useDeviceStore                   ││
│  │ Health:   deviceStatsCache.lastUpdate age:                        ││
│  │           < 1500ms = active                                       ││
│  │           < 5000ms = stale                                        ││
│  │           > 5000ms = offline                                      ││
│  │ Prune:    > 8000ms + NOT established (firstSeen < 3s ago) → DELETE││
│  │ Retain:   Established devices (>3s old) → NEVER pruned, just     ││
│  │           marked "offline"                                        ││
│  │ Side:     Sets lastDisconnectedDeviceId on offline transition     ││
│  │           → triggers DisconnectionAlert modal                     ││
│  │ Log:      "[Registry] Pruning transient device: X" — sparse      ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  LAYER 5: WEBAPP — useNetworkStore.ts: pruneStaleNodes()                │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Decision: "Is this node a stale placeholder?"                     ││
│  │ Timer:    Same 1s interval as Layer 4                             ││
│  │ Prune:    isPlaceholder (no sensorCount + no sensors Map) AND     ││
│  │           > PRUNE_THRESHOLD_MS (10s) → DELETE from Map            ││
│  │ Retain:   Nodes WITH sensor metadata → NEVER pruned              ││
│  │ Note:     _sensorToNodeMap intentionally NOT cleared on prune     ││
│  │ Log:      NONE — completely silent                                ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  LAYER 6: WEBAPP — DisconnectionAlert.tsx                               │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Decision: "Should we show disconnect modal?"                      ││
│  │ Trigger:  lastDisconnectedDeviceId changes (from Layer 4)        ││
│  │ Guards:   1. If device already back to active/stale → suppress   ││
│  │           2. If equivalent physical identity active → suppress    ││
│  │ Problem:  Guards are REACTIVE — the offline→active bounce may    ││
│  │           happen within milliseconds, but React re-render delay   ││
│  │           means the modal can flash before the guard fires.       ││
│  │ Log:      NONE                                                    ││
│  └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

---

## SWOT Analysis

### STRENGTHS

| # | Strength | Detail |
|---|----------|--------|
| S1 | **Physical-key identity** | `node_<rawNodeId>_s<localSensorIndex>` is MAC-derived, stable across reconnects/topology changes. Sensors don't get confused when compact IDs shuffle. |
| S2 | **Established device retention** | Devices older than 3s are NEVER pruned from the registry — only marked "offline". This prevents topology churn during brief WiFi stalls. |
| S3 | **NVS topology persistence** | Gateway saves node topology to flash, enabling fast re-discovery on reboot (15s vs 30s). |
| S4 | **Discovery lock** | Once sync is ready, unknown nodes are queued (not auto-admitted), preventing mid-session topology disruption. |
| S5 | **Collision resolution** | Two nodes with same ID → gateway auto-assigns new ID and forces re-register. |
| S6 | **deviceStatsCache** | High-frequency cache (updated at 200Hz) prevents the React heartbeat optimization (5s) from causing false prune decisions. |
| S7 | **Multi-layer timeout hierarchy** | 1.5s stale → 5s offline → 8s prune transient → 10s prune placeholder → 10s firmware prune. Graduated response prevents whack-a-mole. |

### WEAKNESSES

| # | Weakness | Severity | Detail |
|---|----------|----------|--------|
| W1 | **No unified connection lifecycle log** | CRITICAL | There is NO single log line that traces a sensor from "radio received" → "forwarded to USB" → "parsed by webapp" → "accepted/rejected by gating" → "registered in device registry". Each layer logs independently (or not at all) with different formats, throttle rates, and tag prefixes. |
| W2 | **Compact sync_status is useless** | HIGH | `emitCompactSyncStatusDirect()` (periodic push) sends `"nodes":[]` — an empty array! The webapp only gets per-node data from the command-response `GET_SYNC_STATUS`, which is polled during sync readiness. After readiness completes, node topology updates are invisible unless the webapp polls again. |
| W3 | **Gateway prune events invisible to webapp** | HIGH | When firmware calls `pruneInactiveNodes()`, it logs `[TDMA] Pruning inactive node X` to Serial Monitor (which gets suppressed during streaming because `suppressSerialLogs=true`). The webapp has NO notification that a node was just removed from the gateway's registry. |
| W4 | **Network store prune is silent** | MEDIUM | `pruneStaleNodes()` deletes nodes from the Map with zero logging. No console output, no diagnostic event, nothing. |
| W5 | **Expected-sensor gating race** | MEDIUM | If discovery lock engages BEFORE sync_status delivers node ranges, valid sensor IDs get blocked. The 5s warmup window helps but doesn't fully prevent this — especially if sync readiness completes via `imu_fallback` rather than `sync_status`. |
| W6 | **DisconnectionAlert debounce** | LOW-MED | The offline→active bounce happens at the 1s prune interval cadence. The false-positive guards rely on React re-render seeing the updated health, but there's no explicit debounce delay — a momentary data stall (e.g., USB buffer backup) triggers the modal before recovery registers. |
| W7 | **Stream latch prevents STOP** | LOW | `loop()` force-sets `isStreaming=true` — the gateway can never transition to standby. This means the 30s prune interval is always active (vs 5s when idle), which delays legitimate pruning of dead nodes. |
| W8 | **Prune interval mismatch** | LOW | Firmware prunes at 30s during streaming, but webapp prunes at 1s intervals with 5s offline / 8s transient thresholds. The webapp can mark a device "offline" 25 seconds before the gateway drops the node. During this gap, the gateway still allocates TDMA slots for the dead node. |

### OPPORTUNITIES

| # | Opportunity | Impact | Detail |
|---|-------------|--------|--------|
| O1 | **Unified lifecycle logger** | CRITICAL | Add a single `[CONN]` tagged logging system across all layers with sensor-level granularity. One log line per lifecycle event: `RADIO_RX`, `USB_FWD`, `PARSED`, `GATED`, `REGISTERED`, `STALE`, `OFFLINE`, `PRUNED`. |
| O2 | **Firmware prune notifications** | HIGH | When `pruneInactiveNodes()` fires, send a JSON frame `{"type":"node_pruned","nodeId":X}` to the webapp via USB. This lets the webapp immediately update its topology without waiting for the next `GET_SYNC_STATUS` poll. |
| O3 | **Include nodes in compact sync_status** | HIGH | The periodic `emitCompactSyncStatusDirect()` should include at minimum `nodeId`, `alive`, `lastHeardMs` for each registered node. This gives the webapp continuous visibility into node health. |
| O4 | **Connection diagnostic panel** | MEDIUM | Surface the per-layer decision audit log in the webapp's debug panel so the operator can see WHY sensors appear/disappear without opening browser DevTools. |
| O5 | **Debounce disconnect alert** | MEDIUM | Add a 2-3 second debounce before setting `lastDisconnectedDeviceId`. Only fire if the device is STILL offline after the debounce period. |
| O6 | **Prune reconciliation** | MEDIUM | When webapp marks a device "offline", periodically check if the gateway still considers that node alive (via sync_status). If gateway says alive but webapp says offline, it's a USB/parse issue — log it. If gateway says dead too, it's wireless — log it. |
| O7 | **Log suppression bypass for lifecycle events** | MEDIUM | `suppressSerialLogs=true` during streaming blocks ALL `SAFE_LOG` output. Critical lifecycle events (prune, registration, collision) should bypass this suppression via JSON frames rather than text logs. |

### THREATS

| # | Threat | Likelihood | Detail |
|---|--------|------------|--------|
| T1 | **Silent data loss** | HIGH | If a sensor stops sending data, the current system takes 5-30 seconds to even indicate something is wrong, and provides no information about WHERE in the pipeline the data stopped flowing. A researcher could lose several walking trials before noticing. |
| T2 | **USB buffer stall → false disconnect cascade** | MEDIUM | If the USB serial buffer backs up (e.g., CPU load spike), ALL sensors appear to stop simultaneously. The 1s prune timer marks them all "offline" → fires `lastDisconnectedDeviceId` → shows disconnect modal, even though the gateway radio side is fine. |
| T3 | **Topology desync** | MEDIUM | The gateway and webapp can have different views of which nodes are alive. Gateway says 6 nodes registered, webapp shows 4 sensors because the topology update arrived late or got lost in serial corruption. No reconciliation mechanism exists. |
| T4 | **Node ID reuse after prune** | LOW | If a node is pruned from the gateway and then re-joins, it gets the same nodeId (MAC-derived) but the webapp may still have stale state for that key. The `handleRealDeviceData` function handles this (updates in-place), but the network store `registerNode` may not fire if the node re-registers slightly differently. |

---

## Root Cause Mapping: "Why Does a Sensor Randomly Disappear?"

| Symptom | Most Likely Cause | Layer | Evidence |
|---------|-------------------|-------|----------|
| Sensor disappears, gateway display still shows connected | Webapp prune fired before firmware prune. `deviceStatsCache.lastUpdate` went stale (>5s) even though firmware node is fine. Usually a USB buffer stall. | Layer 4 | `[Registry] Stability diag` shows `retainedStale > 0` |
| Sensor disappears, gateway display shows fewer nodes | Firmware `pruneInactiveNodes()` fired because node stopped sending ESP-NOW packets (RF interference, node crash, power issue) | Layer 1 | Only visible in Serial Monitor `[TDMA] Pruning inactive node` |
| Sensor never appears after connect | Expected-sensor gating blocked the sensorId because sync_status hadn't delivered node ranges yet. | Layer 3 | `[DeviceStore] Blocking sensorId=X` in console |
| Disconnect modal appears but sensors are still working | Layer 4 transiently marked device "offline", fired `lastDisconnectedDeviceId`, then device recovered within 1s. Modal showed before React re-render caught the recovery. | Layer 6 | Can dismiss modal, all sensors still present |
| Node appears in gateway but not in webapp | Compact sync_status sends `"nodes":[]`. Webapp topology store never got the node info. | Layer 2+3 | `getNodeRangesSummary()` returns "none" in `[ConnDiag]` |

---

## Prescribed Solution

### Phase 1: Lifecycle Logging (Immediate — fixes observability)
1. **Add `[CONN:LIFECYCLE]` log tag** across all 6 layers with standardized format
2. **Make Network store prune auditable** — add `console.info` to `pruneStaleNodes()`
3. **Add offline-transition logging** in `pruneStaleDevices()` with per-device detail
4. **Rate-limited gating summary** — when sensors are blocked, log the full decision context

### Phase 2: Firmware → Webapp Notifications (Short-term — fixes topology desync)
1. **Include per-node data in compact sync_status** — at minimum `nodeId`, `alive`, `lastHeardMs`
2. **Emit `node_pruned` JSON frame** when `pruneInactiveNodes()` fires
3. **Emit `node_registered` JSON frame** when a new node joins mid-session

### Phase 3: Debounce + Reconciliation (Medium-term — fixes false positives)
1. **Debounce `lastDisconnectedDeviceId`** — 2s delay before firing
2. **Webapp↔Gateway topology reconciliation** — periodic comparison + logging

---

## Threshold Summary Table

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `STALE_THRESHOLD_MS` | 1500ms | `SyncedSampleStats.ts:109` | Device health → "stale" |
| `OFFLINE_THRESHOLD_MS` | 5000ms | `SyncedSampleStats.ts:112` | Device health → "offline" |
| `PRUNE_THRESHOLD_MS` | 10000ms | `SyncedSampleStats.ts:115` | Network store placeholder prune |
| `ESTABLISHED_DEVICE_MIN_AGE_MS` | 3000ms | `useDeviceRegistry.ts` | Minimum age before device is "established" |
| Transient prune | 8000ms | `useDeviceRegistry.ts:573` | `timeSinceData > 8000 && !isEstablished → delete` |
| Firmware prune (streaming) | 10000ms heard + 30000ms interval | `SyncManager.cpp:1549, :370` | Node's `lastHeard > 10s → unregister` |
| Firmware prune (idle) | 10000ms heard + 5000ms interval | `SyncManager.cpp:370` | Same threshold, checked more often |
| Firmware "alive" | 5000ms | `GatewayCallbacks.ino:277` | `(now - lastHeard) < 5000 → alive=true` |
| Sensor gating warmup | 5000ms | `useDeviceStore.ts` | All sensor IDs accepted during startup |
| `SENSOR_TOPOLOGY_WARMUP_MS` | 5000ms | `useDeviceStore.ts` | Same as above |
| Discovery lock timeout | N/A | Manual | Locked after sync_status ready, never auto-unlocks |

