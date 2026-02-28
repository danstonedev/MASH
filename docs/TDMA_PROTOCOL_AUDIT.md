# TDMA Protocol Audit Report

**Date:** February 2026  
**Status:** Complete  
**Auditor:** Professional Code Audit

---

## Executive Summary

This audit examines the complete TDMA data pipeline from IMU sensor to web UI. The system uses a multi-hop architecture:

```
IMU Sensors → Node (ESP32) → ESP-NOW → Gateway (ESP32) → BLE → Web App
```

### Key Findings

| Component | Status | Issues Found |
|-----------|--------|--------------|
| Node TDMA Transmission | ✅ OK | None |
| Gateway ESP-NOW Reception | ✅ OK | None |
| Gateway BLE Forwarding | ⚠️ FIXED | Length prefix interleaving (already fixed) |
| Web App BLE Reception | ⚠️ HAS ISSUES | Redundant parsing, edge cases |
| IMUParser | ⚠️ HAS ISSUES | Duplicate length-prefix parsing |

---

## 1. Protocol Specification

### 1.1 TDMA Frame Structure (0x23)

```
┌────────────────────────────────────────────────────────────────┐
│                    TDMA Data Packet (0x23)                     │
├──────────┬──────────┬─────────────┬──────────┬────────────────┤
│ type (1) │ nodeId(1)│ frameNum(4) │samples(1)│ sensors(1)     │
│   0x23   │  0-255   │   uint32    │   1-4    │    1-58        │
├──────────┴──────────┴─────────────┴──────────┴────────────────┤
│                    Header: 8 bytes total                       │
├───────────────────────────────────────────────────────────────┤
│        Sample Data: sampleCount × sensorCount × 25 bytes       │
├───────────────────────────────────────────────────────────────┤
│                         CRC8 (1 byte)                          │
└───────────────────────────────────────────────────────────────┘

Note: CRC8-CCITT (polynomial 0x07) is computed over header + data,
appended as the final byte for corruption detection.
```

### 1.2 TDMABatchedSensorData Structure (25 bytes)

```
Offset  Size  Field         Scaling              Unit
─────────────────────────────────────────────────────────
  0      1    sensorId      raw                  0-255
  1      4    timestampUs   raw                  microseconds
  5      2    q[0] (w)      ÷16384              quaternion
  7      2    q[1] (x)      ÷16384              quaternion
  9      2    q[2] (y)      ÷16384              quaternion
 11      2    q[3] (z)      ÷16384              quaternion
 13      2    a[0] (ax)     ÷100                m/s²
 15      2    a[1] (ay)     ÷100                m/s²
 17      2    a[2] (az)     ÷100                m/s²
 19      2    g[0] (gx)     ÷900                rad/s
 21      2    g[1] (gy)     ÷900                rad/s
 23      2    g[2] (gz)     ÷900                rad/s
─────────────────────────────────────────────────────────
Total: 25 bytes per sensor per sample
```

### 1.3 BLE Stream Format

Gateway sends length-prefixed frames over BLE:

```
┌─────────────────────────────────────────────────────────┐
│              BLE Notification (up to 512 bytes)         │
├──────────┬───────────────┬──────────┬──────────────────┤
│ len0 (2) │ frame0 (len0) │ len1 (2) │ frame1 (len1)... │
└──────────┴───────────────┴──────────┴──────────────────┘

len: uint16 little-endian (frame length, NOT including the 2-byte prefix)
frame: raw packet data (0x23 TDMA, 0x04 Environmental, 0x05 NodeInfo, etc.)
```

---

## 2. Node Firmware Analysis

### 2.1 Sample Collection (`SyncManager::addTDMASample`)

**Location:** `firmware/MASH_Node/SyncManager.cpp:860-945`

**Findings:** ✅ CORRECT

```cpp
// Correct scaling factors applied:
sampleBuffer.samples[sampleIdx][i].q[0] = (int16_t)(q.w * 16384.0f);  // ✅
sampleBuffer.samples[sampleIdx][i].a[0] = (int16_t)(data.accelX * 100.0f);  // ✅
sampleBuffer.samples[sampleIdx][i].g[0] = (int16_t)(data.gyroX * 900.0f);  // ✅
```

### 2.2 TDMA Transmission (`SyncManager::sendTDMAData`)

**Location:** `firmware/MASH_Node/SyncManager.cpp:1036-1130`

**Findings:** ✅ CORRECT

- Properly builds contiguous packet with header + sensor data
- Correctly calculates total packet size
- Uses atomic ESP-NOW send

---

## 3. Gateway Firmware Analysis

### 3.1 ESP-NOW Reception

**Location:** `firmware/MASH_Gateway/MASH_Gateway.ino:637-780`

**Findings:** ✅ CORRECT

- Receives raw ESP-NOW packet
- Validates packet type (0x23 for TDMA)
- Immediately enqueues for BLE forwarding

### 3.2 BLE Frame Enqueueing (`enqueueBleFrame`)

**Location:** `firmware/MASH_Gateway/MASH_Gateway.ino:333-356`

**Findings:** ✅ FIXED (previously broken)

**Current Implementation (CORRECT):**
```cpp
static inline void enqueueBleFrame(const uint8_t *frame, size_t len) {
  BleFrame f;
  // Stream format: [len_lo][len_hi][frame...]
  f.data[0] = (uint8_t)(len & 0xFF);
  f.data[1] = (uint8_t)((len >> 8) & 0xFF);
  memcpy(f.data + 2, frame, len);
  f.len = (uint16_t)(len + 2);
  
  xQueueSend(bleTxQueue, &f, 0);
}
```

**Key Fix:** Length prefix and frame data are combined into a single `BleFrame` entry before enqueueing. This prevents interleaving when multiple frames are batched together.

### 3.3 BLE TX Task (`BleTxTask`)

**Location:** `firmware/MASH_Gateway/MASH_Gateway.ino:357-443`

**Findings:** ✅ CORRECT

- Batch buffer properly sized (1500 bytes)
- Frames are concatenated in order
- Time-based flush every 40ms

---

## 4. Web App Analysis

### 4.1 BLEConnection Stream Reassembly

**Location:** `imu-connect/src/lib/connection/BLEConnection.ts:135-175`

**Findings:** ⚠️ NEEDS ATTENTION

**Current Implementation:**
```typescript
// Extract frames from stream buffer
while (offset + 2 <= this.streamBuffer.length) {
  const frameLen = this.streamBuffer[offset] | (this.streamBuffer[offset + 1] << 8);
  
  // Sanity checks
  if (frameLen === 0 || frameLen > MAX_FRAME_LEN) {
    offset += 1; // resync by shifting one byte
    continue;
  }
  // ... extract frame
}
```

**Issue:** The resync logic (shifting by 1 byte) is reactive, not preventive. Once corruption occurs, it may take many iterations to resync.

### 4.2 IMUParser

**Location:** `imu-connect/src/lib/connection/IMUParser.ts:17-50`

**CRITICAL ISSUE:** ❌ DUPLICATE LENGTH-PREFIX PARSING

The `parseBLEPacket` method attempts to parse length-prefixed frames, but `BLEConnection` already extracts individual frames and strips the length prefix before calling `parseSingleFrame`.

**Problem Flow:**
```
BLEConnection receives: [len1][frame1][len2][frame2]...
BLEConnection extracts: frame1, frame2 (no length prefix)
BLEConnection calls: IMUParser.parseBLEPacket(frame1)
IMUParser tries to: Read length prefix from frame1 data ← WRONG!
```

**The `parseBLEPacket` method should NOT be called by BLEConnection** because BLEConnection already handles framing. BLEConnection should call `parseSingleFrame` directly.

---

## 5. Identified Issues & Fixes

### Issue #1: Legacy RAW Format Parser Creating Ghost Sensors (CRITICAL - FIXED)

**Problem:** The "FORMAT B (New 120Hz Raw)" parser in IMUParser.ts was matching ANY frame where:
- Length >= 30 bytes
- First byte is NOT 0x02, 0x03, 0x04, 0x05, or 0x23

This meant corrupted data with first byte values like 1, 2, 4, 108, 213, 215, 255 (any value outside the explicit checks) would be incorrectly parsed as legacy RAW format, extracting garbage sensor IDs.

**Impact:** Ghost sensors with IDs like 1, 2, 4, 108, 213, 215, 255 appearing at low rates (0.3-2.1 Hz) while real TDMA sensors showed proper rates (42-86 Hz).

**Fix:** Removed the legacy RAW format parser entirely since the system is now TDMA-only. The ambiguous "first byte is sensor count" format was fundamentally flawed.

### Issue #2: Stream Desync Resync Logic (MEDIUM - FIXED)

**Problem:** When stream desync happened, byte-by-byte shifting could create scenarios where corrupted data passed both length and packet-type validation.

**Fix:** Added:
1. Packet-type validation (must be 0x01, 0x02, 0x03, 0x04, 0x05, or 0x23)
2. Resync attempt limit (32 max) to prevent infinite loops
3. Buffer overflow protection with truncation

### Issue #3: Double Length-Prefix Parsing (MEDIUM - FIXED)

**Problem:** `BLEConnection.ts` called `IMUParser.parseBLEPacket()` which tried to parse length prefixes, but `BLEConnection` already stripped them.

**Fix:** Changed `BLEConnection` to call `parseSingleFrame()` directly.

---

## 6. Recommended Code Changes

### Change 1: Make `parseSingleFrame` Public

```typescript
// IMUParser.ts
// Change from:
private static parseSingleFrame(data: DataView): ...
// To:
static parseSingleFrame(data: DataView): ...
```

### Change 2: Call parseSingleFrame Directly from BLEConnection

```typescript
// BLEConnection.ts - change:
const parsed = IMUParser.parseBLEPacket(
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength),
);
// To:
const parsed = IMUParser.parseSingleFrame(
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength),
);
```

### Change 3: Add Packet Type Validation in Resync

```typescript
// BLEConnection.ts - after reading frameLen:
const VALID_PACKET_TYPES = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x23]);
if (frameLen === 0 || frameLen > MAX_FRAME_LEN) {
  offset += 1;
  continue;
}
// Peek at packet type
const packetType = this.streamBuffer[offset + 2];
if (!VALID_PACKET_TYPES.has(packetType)) {
  offset += 1; // Invalid packet type, shift to resync
  continue;
}
```

---

## 7. Data Flow Diagram (Correct Path)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CORRECT DATA FLOW                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  NODE                                                                       │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐            │
│  │ IMU Sensors │ -> │ addTDMASample()  │ -> │ sendTDMAData()  │            │
│  │ (200Hz)     │    │ Scale & buffer   │    │ ESP-NOW send    │            │
│  └─────────────┘    └──────────────────┘    └────────┬────────┘            │
│                                                       │                     │
│  ════════════════════════════════════════════════════╪═════════════════    │
│                        ESP-NOW (wireless)            │                     │
│  ════════════════════════════════════════════════════╪═════════════════    │
│                                                       │                     │
│  GATEWAY                                              ▼                     │
│  ┌──────────────────┐    ┌─────────────────┐    ┌─────────────────┐        │
│  │ onDataReceived() │ -> │ enqueueBleFrame │ -> │ BleTxTask()     │        │
│  │ ESP-NOW callback │    │ [len][data]     │    │ Batch & notify  │        │
│  └──────────────────┘    └─────────────────┘    └────────┬────────┘        │
│                                                          │                  │
│  ════════════════════════════════════════════════════════╪═════════════    │
│                        BLE (wireless)                    │                  │
│  ════════════════════════════════════════════════════════╪═════════════    │
│                                                          │                  │
│  WEB APP                                                 ▼                  │
│  ┌──────────────────┐    ┌─────────────────┐    ┌─────────────────┐        │
│  │ BLE notification │ -> │ Stream reassembly│ -> │ parseSingleFrame│        │
│  │ Append to buffer │    │ Extract frames  │    │ 0x23 TDMA parse │        │
│  └──────────────────┘    └─────────────────┘    └────────┬────────┘        │
│                                                          │                  │
│                                                          ▼                  │
│                                                 ┌─────────────────┐        │
│                                                 │ IMUDataPacket   │        │
│                                                 │ to stores/UI    │        │
│                                                 └─────────────────┘        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. CRC8 Corruption Detection

### 8.1 Implementation Details

Added CRC8-CCITT checksum to TDMA packets for corruption detection:

**Firmware (Node):** `SyncManager::sendTDMAData()`
- CRC8 calculated over entire packet (header + data)
- Appended as final byte before ESP-NOW transmission
- Uses polynomial 0x07 with lookup table for speed

**Web App:** `IMUParser.parseSingleFrame()`
- Detects CRC presence by checking if packet size = header + data + 1
- Verifies CRC before parsing data
- Rejects corrupted packets with diagnostic logging
- Tracks pass/fail statistics for monitoring

### 8.2 Packet Format with CRC

```
Without CRC (legacy):
[Header (8)] [Data (N)]

With CRC (new):
[Header (8)] [Data (N)] [CRC8 (1)]

CRC8 is computed over bytes 0..(8+N-1), stored at byte (8+N)
```

### 8.3 Benefits

- **Early rejection:** Corrupted packets dropped before processing
- **Diagnostic visibility:** CRC fail rate logged every 5 seconds
- **Backwards compatible:** Parser auto-detects CRC presence
- **Low overhead:** Only 1 byte per packet

---

## 9. Validation Checklist

After applying fixes, verify:

- [ ] No "Incomplete frame" warnings in console
- [ ] No ghost sensors (IDs > 255 or unexpected ranges)
- [ ] Consistent 200Hz data rate per sensor
- [ ] TDMA SUMMARY logs show expected sensor IDs
- [ ] No accelerometer/gyro value spikes from parsing errors
- [ ] CRC fail rate < 1% under normal conditions

---

## 10. Conclusion

The TDMA protocol implementation is fundamentally sound. The main issue was **double length-prefix parsing** in the web app where `IMUParser.parseBLEPacket()` assumed it was receiving raw length-prefixed streams, but `BLEConnection` had already extracted individual frames.

**Priority Fixes:**
1. HIGH: Make `parseSingleFrame` public and call it directly
2. MEDIUM: Add packet-type validation in resync logic
3. LOW (Future): Add CRC to frame format

The gateway firmware already has the correct atomic frame enqueueing fix in place.
