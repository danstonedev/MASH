2# TDMA Sync Architecture — Independent Expert Review

**Date:** 2026-02-09  
**Scope:** PTP staleness fix, TX guard zone fix, and full TDMA/PTP architecture scalability  
**Verdict:** Both fixes address real root causes but introduce one new risk. One **HIGH severity liveness bug** was found independently.

---

## Executive Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| **F1** | `awaitingDelayResp` has no timeout — a single lost DELAY_RESP permanently disables PTP | **HIGH** | **Needs fix** |
| **F2** | `isPtpStale` bypasses PTP stagger — multiple stale nodes can corrupt each other's T2 | **MEDIUM** | Needs mitigation |
| **F3** | TX guard zone is correct for current topology (4 nodes) | **OK** | Verified |
| **F4** | `TDMA_MAX_NODES = 8` exceeds frame capacity (max 6 with min slots) | **LOW** | Guarded by `MAX_NODES = 4` |
| **F5** | `calculateSlotWidth()` is dead code — diverged from actual `recalculateSlots()` | **LOW** | Cleanup |
| **F6** | `sendDelayReq()` called from ESP-NOW callback — acceptable but not ideal | **LOW** | Acceptable |
| **F7** | DELAY_RESP sent via broadcast instead of unicast | **LOW** | Minor waste |

---

## F1 — CRITICAL: `awaitingDelayResp` Has No Timeout

### The Bug

When a node sends a `DELAY_REQ`, it sets `awaitingDelayResp = true` and blocks all future PTP attempts until `handleDelayResp()` receives a matching response. If that response is lost (WiFi interference, gateway busy), PTP is **permanently disabled** for that node.

### Code Path

```
sendDelayReq()                    → sets awaitingDelayResp = true
                                    ↓ (DELAY_RESP lost)
handleTDMABeacon() on next beacon → !awaitingDelayResp is FALSE → skips PTP
                                    ↓ (forever)
PTP clock offset drifts unboundedly
```

### Where `awaitingDelayResp` Can Be Cleared

| Location | Trigger |
|----------|---------|
| `handleDelayResp()` line 2069 | Successful matching response |
| `sendDelayReq()` line 2042 | `esp_now_send()` returns error (immediate failure) |
| SYNC_RESET handler line 833 | Full reset from webapp reconnect |

**No timeout path exists.** If the DELAY_RESP packet is lost in transit, the node is stuck until a full system reset.

### Impact

- **Single-node scenario:** PTP offset aging log observed at 14+ seconds. If the first staleness-fallback DELAY_REQ's response is also lost, PTP stays dead permanently.
- **Multi-node scenario at scale:** Packet loss probability increases with more nodes (more contention). Any node that loses a DELAY_RESP permanently loses clock sync.
- **The isPtpStale fix makes this WORSE:** It forces stale nodes to send DELAY_REQ aggressively, but `awaitingDelayResp` still blocks the gate. The stale node sends ONE DELAY_REQ, response is lost, and it's stuck again — the staleness fallback can't retry because `!awaitingDelayResp` is still false.

### Recommended Fix

Add a timeout to `handleTDMABeacon()` to clear a stale `awaitingDelayResp`:

```cpp
// Clear stale DELAY_REQ awaiting response (lost packet recovery)
if (awaitingDelayResp && (millis() - lastDelayReqTime > 500)) {
    awaitingDelayResp = false;  // Allow retry on next eligible beacon
}
```

Place this **before** the `shouldDoPtp` decision block. This gives the response 500ms to arrive (~25 beacon cycles) before allowing retry.

---

## F2 — MEDIUM: `isPtpStale` Bypasses PTP Stagger

### The Problem

The PTP stagger system assigns one node per frame via `beacon.ptpSlotNode`. The new `isPtpStale` flag bypasses this protection:

```cpp
bool shouldDoPtp = isOurPtpSlot || isInitialCalibration || isPtpStale;
```

If multiple nodes reach the 2-second staleness threshold simultaneously (likely when beacons are lost for all nodes), they ALL send DELAY_REQ on the same beacon, creating a PTP collision.

### What Happens On Collision

1. Gateway `handleDelayReq()` captures `T2 = micros()` immediately
2. Gateway calls `sendDelayResp()` which executes `esp_now_send()` (~50-200µs)
3. Second DELAY_REQ arrives — its T2 is captured AFTER the first response's send overhead
4. The T2 measurement for the second node is contaminated by 50-200µs of ESP-NOW processing

### Severity Assessment

- **Bounded error:** The T2 contamination is ~100-200µs at worst
- **Self-correcting:** The median filter (`OFFSET_SAMPLE_COUNT = 5`) will reject outliers
- **Rare trigger:** Requires sustained beacon loss > 2s for multiple nodes simultaneously
- **But:** If it happens during initial operation, it can corrupt the PTP median filter for multiple nodes at once

### Recommended Mitigation

Instead of a boolean `isPtpStale`, stagger the staleness threshold per node:

```cpp
// Stagger staleness threshold by nodeId to avoid simultaneous recovery
uint32_t staleThresholdMs = 2000 + (nodeId * 200);
bool isPtpStale = (lastTwoWaySyncTime > 0) && (millis() - lastTwoWaySyncTime > staleThresholdMs);
```

This ensures node 0 goes stale at 2.0s, node 1 at 2.2s, node 2 at 2.4s, etc. — avoiding simultaneous DELAY_REQ collisions.

---

## F3 — TX Guard Zone: Verified Correct

### Analysis

The guard zone at `framePeriodUs - 2000` (18,000 µs) prevents transmission in the last 2ms of each frame.

**For current topology (4 nodes, 4 sensors each):**

| Node | Slot Start | Slot End | Guard Start | Clearance |
|------|-----------|----------|-------------|-----------|
| 0 | 1,000 µs | 3,500 µs | 18,000 µs | 14,500 µs |
| 1 | 3,600 µs | 6,100 µs | 18,000 µs | 11,900 µs |
| 2 | 6,200 µs | 8,700 µs | 18,000 µs | 9,300 µs |
| 3 | 8,800 µs | 11,300 µs | 18,000 µs | 6,700 µs |

All nodes finish with >6ms clearance before the guard zone. The guard zone is effectively irrelevant for 4 nodes — slots end naturally well before 18ms.

**For maximum capacity (6 nodes, 1 sensor each):**

| Node | Slot Start | Slot End | Guard Start | Clearance |
|------|-----------|----------|-------------|-----------|
| 5 (last) | ~14,000 µs | ~16,500 µs | 18,000 µs | 1,500 µs |

Still safe but tight. The guard zone becomes critical at 6+ nodes.

### Assessment

The fix is **correct and necessary** as a safety net, especially as node count grows. The implementation is clean — a simple additional condition in the existing `isInTransmitWindow()` check.

One minor consideration: the guard zone is hardcoded at 2000µs in the node but defined as `TDMA_GUARD_TIME_US = 2000` in `TDMAProtocol.h`. The node should reference the constant instead:

```cpp
uint32_t guardZoneStartUs = framePeriodUs - TDMA_GUARD_TIME_US;
```

---

## F4 — Scalability: Maximum Node Count

### Frame Budget Math

```
Available = 20,000 - 500 (beacon) - 500 (first gap) - 2,000 (guard) = 17,000 µs
Per node  = 2,500 (min slot) + 100 (inter-slot gap) = 2,600 µs
Max nodes = 17,000 / 2,600 = 6.5 → 6 nodes
```

`TDMA_MAX_NODES = 8` is **unreachable** with current timing constants. However, `MAX_NODES = 4` in `SharedConfig.h` limits practical deployment, so this is not a live issue.

### Recommendation

Add a `static_assert` in `TDMAProtocol.h`:

```cpp
// Verify MAX_NODES actually fits in the frame with minimum slot widths
static_assert(
    (TDMA_BEACON_DURATION_US + TDMA_FIRST_SLOT_GAP_US +
     TDMA_MAX_NODES * (TDMA_SLOT_MIN_WIDTH_US + 100) +
     TDMA_GUARD_TIME_US) <= (TDMA_FRAME_PERIOD_MS * 1000),
    "ERROR: TDMA_MAX_NODES exceeds frame capacity with minimum slot widths!"
);
```

This will catch the mismatch at compile time if anyone changes `MAX_NODES`.

### PTP Stagger Cycle Time With More Nodes

With N nodes, each node gets PTP every N frames (N × 20ms). Current refresh interval is 500ms.

| Nodes | PTP cycle | PTP syncs/sec/node | Sufficient? |
|-------|-----------|-------------------|-------------|
| 1 | 20ms | 50 | Yes (clamped by 500ms interval) |
| 2 | 40ms | 2 | Yes |
| 4 | 80ms | 2 | Yes |
| 6 | 120ms | 2 | Yes |
| 8 | 160ms | 2 | Marginal with beacon losses |

The PTP stagger mechanism scales well. Even at 8 nodes, each node can sync at 2Hz (500ms interval, slot every 160ms). The bottleneck is beacon loss, not the stagger cycle.

---

## F5 — Dead Code: `calculateSlotWidth()` vs `recalculateSlots()`

`TDMAProtocol.h` defines `calculateSlotWidth()` which includes I2C read time (1ms/sensor), ESP-NOW airtime, and 2ms overhead. This function returns **9,200 µs** for 4 sensors.

The Gateway's `recalculateSlots()` uses the much simpler `TDMA_SLOT_OVERHEAD_US + sensors × TDMA_SLOT_BASE_US` formula, returning **2,500 µs** for 4 sensors.

The simpler formula is correct for the current architecture because I2C reads happen on Core 1 (SensorTask) while TX happens on Core 0 (ProtocolTask) — the slot only covers airtime, not sensor reads. But `calculateSlotWidth()` is misleading and should be removed or annotated.

---

## F6 — `sendDelayReq()` Called From ESP-NOW Callback

`handleTDMABeacon()` → `sendDelayReq()` → `esp_now_send()` executes within the WiFi task callback on Core 0. This is supported by ESP-IDF (ESP-NOW sends are queued), but it means:

1. **T1 timestamp accuracy:** T1 is captured at `sendDelayReq()` entry, but actual TX is asynchronous. The queuing delay (~50-100µs) is added to the PTP offset calculation. This is bounded and handled by the RTT averaging.

2. **WiFi task blocking:** The beacon handler holds the WiFi task for the entire `handleTDMABeacon()` execution. With PTP and debug logging, this could be 200-500µs. Other incoming ESP-NOW packets are queued during this time.

### Assessment

Acceptable for current scale. If WiFi task latency becomes a problem at 6+ nodes (more log spam, more PTP activity), consider moving `sendDelayReq()` out of the callback via a flag:

```cpp
// In handleTDMABeacon():
ptpRequestPending = true;

// In update() or ProtocolTask main loop:
if (ptpRequestPending) {
    sendDelayReq();
    ptpRequestPending = false;
}
```

This would decouple PTP timing from beacon processing latency. Not needed today.

---

## Overall Architecture Assessment

### Strengths

1. **Pipelined TX:** The snapshot approach in `sendTDMAData()` is excellent — mutex held ~50µs, packet building happens entirely outside the lock. Well-designed for multi-core.

2. **Freewheel mechanism:** Nodes continue transmitting during beacon loss using modular frame timing. This is exactly right for handling transient radio congestion.

3. **Frame budget headroom:** At 4 nodes, only 56.5% of the 20ms frame is used. Plenty of room for retransmission or additional nodes.

4. **Beacon-anchored timestamps:** Using beacon arrival as the reference clock (instead of PTP offset alone) is the right design. PTP corrects drift, beacons provide phase alignment.

5. **Static_asserts:** Good compile-time validation of timing constraints.

### Weaknesses

1. **No lost-packet recovery for PTP** (F1) — This is the most critical gap.

2. **Stagger bypass on staleness** (F2) — The fix is directionally correct but the stagger bypass needs guardrails.

3. **No adaptive PTP interval** — When PTP is stale, the 500ms retry interval is too conservative. After 2s of staleness, the node should increase PTP frequency (e.g., 100ms) until the offset stabilizes, then drop back to 500ms.

4. **No PTP quality feedback to webapp** — The gateway's `SyncQualityFlags` struct includes sync age and confidence, but the webapp doesn't use this to warn the user when sync quality degrades.

---

## Recommended Immediate Actions (Priority Order)

### 1. Fix `awaitingDelayResp` timeout — **MUST DO** (3 lines)

Without this, the `isPtpStale` fallback doesn't actually work — it can send ONE retry, and if that response is also lost, PTP is permanently dead again.

### 2. Stagger the staleness threshold per node — **SHOULD DO** (1 line change)

Prevents simultaneous recovery collisions between nodes.

### 3. Use `TDMA_GUARD_TIME_US` constant in guard zone — **SHOULD DO** (1 line change)

Keeps the node's guard zone synchronized with the protocol constant.

### 4. Add `static_assert` for max node capacity — **NICE TO HAVE**

Catches future misconfigurations at compile time.

---

*Review conducted against firmware source as of 2026-02-09. All line references are approximate and may shift with edits.*
