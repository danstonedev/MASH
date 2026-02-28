# TDMA Protocol Audit Report

**Date:** February 2026
**Status:** Audit Complete & Critical Issues Fixed
**Auditor:** GitHub Copilot

---

## Executive Summary

A comprehensive "fine tooth comb" audit was performed on the TDMA (Time Division Multiple Access) pipeline following reports of inconsistent data from multiple sensors. The audit identified critical regressions and configuration errors introduced by recent changes.

**Root Cause of Inconsistency:**
The "Junior Developer" simplified the TDMA slot calculation logic in `TDMAProtocol.h` to use a fixed 3ms slot width, ignoring the actual payload size required for the number of sensors. With 6+ sensors (600+ bytes), the transmission time exceeded the 3ms slot, causing collisions with the next node's usage of the medium.

**Secondary Issues:**
- **BLE Stream Desynchronization:** The web app's resync logic was reactive and inefficient, causing prolonged data loss after a corruption event.
- **Parser Robustness:** The `IMUParser` contained legacy fallback code that could misinterpret valid single-frame packets as data streams if the packet type wasn't explicitly whitelisted, leading to garbage data.

---

## 1. Findings & Remediation

### 1.1 Critical: TDMA Slot Calculation (Firmware)

**Location:** `firmware/libraries/IMUConnectCore/src/TDMAProtocol.h`
**Severity:** 🔥 CRITICAL (Caused Data Loss/Collision)

**Issue:**
The `calculateSlotWidth` function was hardcoded to return `TDMA_SLOT_MIN_WIDTH_US` (3000µs / 3ms) regardless of the sensor count.
- **Scenario:** A node with 6 sensors transmits ~608 bytes.
- **Airtime:** At 1Mbps (standard Long Range rate), ~608 bytes takes ~4.9ms.
- **Result:** 4.9ms > 3.0ms Slot. The node transmits into the next node's slot, causing guaranteed RF collisions.

**Fix Applied:**
Restored dynamic slot calculation logic:
```cpp
// NEW LOGIC:
uint32_t payloadBytes = 8 + (TDMA_SAMPLES_PER_FRAME * sensorCount * 25) + 1;
uint32_t airtimeUs = payloadBytes * 8 + 1000; // 8us/byte + 1ms overhead
return (airtimeUs < MIN) ? MIN : airtimeUs;
```
This ensures the slot expands to fit the data. Note: For 8 nodes with high sensor counts, this may exceed the 20ms frame budget. The firmware will now correctly warn about this instead of silently colliding.

### 1.2 High: Duplicate Length-Prefix Parsing (Web App)

**Location:** `imu-connect/src/lib/connection/IMUParser.ts`
**Severity:** ⚠️ HIGH (Risk of Stream Corruption)

**Issue:**
The `parseBLEPacket` method contained legacy code attempting to parse "stream" data (length-prefixed) if the packet type check failed. Since `BLEConnection` already strips length prefixes, any fallback to this logic would interpret the first 2 bytes of data as a length, causing massive frame misalignment.

**Fix Applied:**
Disabled the legacy stream parsing block. `IMUParser` now strictly processes single frames or returns an empty set, preventing "double parsing" errors.

### 1.3 Medium: Inefficient BLE Resync (Web App)

**Location:** `imu-connect/src/lib/connection/BLEConnection.ts`
**Severity:** ⚠️ MEDIUM (Recovery Latency)

**Issue:**
When a packet length was invalid, the system shifted the buffer index by only 1 byte (`offset += 1`) and retried. In a 512-byte buffer, this could require hundreds of iterations to find the next valid packet, dropping all data in between.

**Fix Applied:**
Implemented "Intelligent Resync":
- If a frame header is invalid, the parser now scans forward looking for a valid `[LEN_LO][LEN_HI][TYPE]` pattern.
- This allows immediate recovery to the next valid packet, minimizing data loss during RF bursts.

---

## 2. Infrastructure Status

| Component | Status | Verification |
|-----------|--------|--------------|
| **Node Firmware** | ✅ FIXED | Slot width now accommodates payload. |
| **Gateway Firmware** | ✅ OK | Correctly forwards length-prefixed frames. |
| **App BLE Connection** | ✅ FIXED | Intelligent resync added. |
| **App IMU Parser** | ✅ FIXED | Legacy stream logic disabled. |

---

## 3. Recommendations

1.  **Monitor Frame Budget:** With the fix, slots are larger. Check the Serial logs on the Gateway: if `[TDMA] WARNING: Frame time exceeds budget!` appears, you must reduce the number of nodes or sensor count per node, or increase the Frame Period (reduce rate from 50Hz to 25Hz).
2.  **Verify Data Rate:** Ensure ESP-NOW is using a sufficient data rate (Default is often 1Mbps). If you lock it to 2Mbps or higher, the slot times will decrease significantly.

---
**Audit Completed by GitHub Copilot**
