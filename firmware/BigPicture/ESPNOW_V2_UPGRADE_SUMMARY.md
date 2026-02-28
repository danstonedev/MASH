# ESP-NOW v2.0 Upgrade Summary

## Overview

This document summarizes the ESP-NOW v2.0 upgrade for IMU Connect firmware, which dramatically simplifies the TDMA protocol by eliminating multi-packet batching complexity.

## Key Change: Payload Size

| Version | Max Payload | Max Data (minus header) |
|---------|-------------|------------------------|
| v1.0    | 250 bytes   | 242 bytes              |
| **v2.0**| **1470 bytes** | **1462 bytes**      |

**Result:** 5.88× larger payload capacity

## Impact on Sensor Configurations

### Before (v1.0 - 250 bytes)

| Sensors | Data/Frame | Packets Needed | Complexity |
|---------|------------|----------------|------------|
| 1-2     | 200 bytes  | 1 packet       | Simple     |
| 3-4     | 400 bytes  | 2 packets      | Medium     |
| 5-6     | 600 bytes  | 3 packets      | High       |
| 7-9     | 900 bytes  | 4 packets      | Very High  |

### After (v2.0 - 1470 bytes)

| Sensors | Data/Frame | Packets Needed | Complexity |
|---------|------------|----------------|------------|
| 1-2     | 200 bytes  | **1 packet**   | **Simple** |
| 3-4     | 400 bytes  | **1 packet**   | **Simple** |
| 5-6     | 600 bytes  | **1 packet**   | **Simple** |
| 7-9     | 900 bytes  | **1 packet**   | **Simple** |

**ALL configurations now fit in a single packet!**

## Code Changes Made

### 1. TDMAProtocol.h - Constants

```cpp
// Before (v1.0)
constexpr uint16_t ESPNOW_MAX_PAYLOAD = 250;
constexpr uint16_t TDMA_MAX_DATA_BYTES = 242;
constexpr uint8_t TDMA_MAX_SENSORS_PER_NODE = 11;

// After (v2.0)
constexpr uint16_t ESPNOW_MAX_PAYLOAD = 1470;
constexpr uint16_t TDMA_MAX_DATA_BYTES = 1462;
constexpr uint8_t TDMA_MAX_SENSORS_PER_NODE = 58;
```

### 2. TDMAProtocol.h - Helper Functions

Simplified all helper functions to reflect single-packet architecture:

- `calculateMaxSamplesPerPacket()` - Always returns 4 (TDMA_SAMPLES_PER_FRAME)
- `calculatePacketsPerFrame()` - Always returns 1
- `calculateSlotWidth()` - Fixed width (TDMA_SLOT_MIN_WIDTH_US)
- `calculateFrameTime()` - Simplified calculation with uniform slots

### 3. SyncManager.cpp - sendTDMAData()

**Before:** Complex multi-packet while loop with packet index tracking
**After:** Simple single-packet send

Key changes:
- Removed `while (totalSamplesSent < sampleBuffer.sampleCount)` loop
- Changed `uint8_t packet[250]` to `uint8_t packet[ESPNOW_MAX_PAYLOAD]`
- Single `esp_now_send()` call per frame

### 4. SyncManager.h - hasBufferedData()

**Before:** Complex per-sensor-count threshold calculation
**After:** Simple threshold check

```cpp
// Before
uint8_t bytesPerSample = sampleBuffer.sensorCount * TDMA_SENSOR_DATA_SIZE;
uint8_t maxSamplesPerPacket = TDMA_MAX_DATA_BYTES / bytesPerSample;
// ... complex clamping logic ...
return sampleBuffer.sampleCount >= maxSamplesPerPacket;

// After
return sampleBuffer.sampleCount >= TDMA_SAMPLES_PER_FRAME;
```

## Test Suite

Two comprehensive test sketches created:

### 1. TDMAProtocol_v2_Tests.ino

Unit tests validating:
- ESP-NOW v2.0 constants
- Packet sizes for 1-9 sensor configs
- 200Hz timing feasibility
- Multi-node frame calculations
- Slot width uniformity
- v1.0 vs v2.0 comparison

**Run on any ESP32 - no WiFi/BLE needed.**

### 2. TDMA_200Hz_Gateway_Test.ino

Runtime reliability test validating:
- Actual 200Hz data rate per node
- Frame sequence continuity
- Packet loss percentage
- Timestamp synchronization

**Pass Criteria:**
- 198-202 Hz actual rate
- 0 frame gaps
- <0.1% packet loss

## Platform Requirements

### Arduino IDE

1. Open **Boards Manager** (Tools → Board → Boards Manager)
2. Search for "esp32"
3. Install **esp32 by Espressif Systems v3.3.6** or later
4. Select board: **ESP32S3 Dev Module** (or your ESP32-S3 variant)

### Verification

After upgrading, verify ESP-NOW v2.0 availability:

```cpp
#include <esp_now.h>

void setup() {
    Serial.begin(115200);
    #ifdef ESP_NOW_MAX_DATA_LEN_V2
        Serial.printf("ESP-NOW v2.0 available! Max payload: %d bytes\n", 
                      ESP_NOW_MAX_DATA_LEN_V2);
    #else
        Serial.println("WARNING: ESP-NOW v2.0 NOT available!");
    #endif
}
```

## Benefits Summary

1. **Simplicity:** No multi-packet logic, easier debugging
2. **Reliability:** Single packet = single ack, no reassembly needed
3. **Latency:** No inter-packet delays within a frame
4. **Scalability:** Support for up to 58 sensors per node (theoretical)
5. **Future-proof:** Room for protocol expansion

## Migration Checklist

- [x] Update TDMAProtocol.h constants
- [x] Simplify TDMAProtocol.h helper functions
- [x] Simplify SyncManager.cpp sendTDMAData()
- [x] Simplify SyncManager.h hasBufferedData()
- [x] Create unit tests
- [x] Create reliability tests
- [ ] Update Arduino-ESP32 to v3.3.6+
- [ ] Compile and flash Gateway
- [ ] Compile and flash all Nodes
- [ ] Run TDMA_200Hz_Gateway_Test
- [ ] Verify 200Hz with all sensor configs

## Rollback Plan

If v2.0 causes issues, revert by:
1. Change `ESPNOW_MAX_PAYLOAD` back to `250`
2. Change `TDMA_MAX_DATA_BYTES` back to `242`
3. Change `TDMA_MAX_SENSORS_PER_NODE` back to `11`
4. Restore complex helper functions from git history
5. Restore multi-packet sendTDMAData() from git history
