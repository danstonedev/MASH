# TDMA Sensor Capacity Analysis & Optimization

## Executive Summary

**Current Maximum**: ~24 total sensors across all nodes at 50Hz effective rate
**Proposed Maximum**: ~48 total sensors at 50Hz, or ~32 sensors at 100Hz effective rate

---

## Current System Constraints

### 1. ESP-NOW Hard Limits (per Espressif Official Documentation)

**Source**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/network/esp_now.html

| Constraint | Value | Notes |
|------------|-------|-------|
| Max Payload (v1.0) | **250 bytes** | `ESP_NOW_MAX_DATA_LEN` - vendor-specific element body |
| Max Payload (v2.0) | **1470 bytes** | `ESP_NOW_MAX_DATA_LEN_V2` - requires v2.0 on both ends |
| Max Total Peers | **20 devices** | `ESP_NOW_MAX_TOTAL_PEER_NUM` |
| Max Encrypted Peers | **17 devices** | Configurable via `CONFIG_ESP_WIFI_ESPNOW_MAX_ENCRYPT_NUM` (default 7) |
| Default Bit Rate | **1 Mbps** | Configurable via `esp_now_set_peer_rate_config()` |
| TX Queue Depth | ~20 packets | Exceeding causes `ESP_ERR_ESPNOW_NO_MEM` |
| Practical TX Rate | ~200 pkt/sec | Before queue overflow |

**Important**: ESP-NOW is connectionless - no pairing required for unencrypted broadcast/unicast reception. v2.0 devices can receive from both v1.0 and v2.0, but v1.0 devices truncate packets >250 bytes.

### 2. Current Packet Structure
```
TDMADataPacket Header:     8 bytes
TDMABatchedSensorData:    25 bytes per sample per sensor
  - sensorId:              1 byte
  - timestampUs:           4 bytes
  - quaternion (4×int16):  8 bytes
  - accel (3×int16):       6 bytes
  - gyro (3×int16):        6 bytes

Max data per packet: 250 - 8 = 242 bytes
```

### 3. Current Capacity Table (200Hz sample, 50Hz transmit, 4 samples/frame)
| Sensors/Node | Bytes/4-Sample | Fits? | Pkts/Frame | Effective Hz | Max Nodes |
|--------------|----------------|-------|------------|--------------|-----------|
| 1            | 100            | ✓     | 1          | 200          | 8         |
| 2            | 200            | ✓     | 1          | 200          | 8         |
| 3            | 300            | ✗     | 2          | 200          | 4         |
| 4            | 400            | ✗     | 2          | 200          | 4         |
| 5            | 500            | ✗     | 3          | 200          | 3         |
| 6            | 600            | ✗     | 4          | 200          | 2         |
| 9            | 900            | ✗     | 4          | 200          | 2         |

### 4. TDMA Frame Timing (20ms frame @ 50Hz)
```
Beacon:           0.5ms
First Slot Gap:   0.5ms
Per-Packet TX:    ~3.0ms (airtime + callback wait)
Guard Time:       2.0ms
Inter-Slot Gap:   0.1ms per node

Available for data: 20 - 0.5 - 0.5 - 2.0 = 17ms
```

### 5. Gateway Protocol Switching Overhead

The Gateway must handle three concurrent protocols with potential RF coexistence issues:

| Protocol | Role | Timing Constraints |
|----------|------|-------------------|
| ESP-NOW | Receive from nodes | Continuous, 50Hz frame rate |
| BLE | Transmit to web app | Connection interval ~45ms, notifications queued |
| WiFi (optional) | WebSocket fallback | TCP overhead, ~10-50ms latency |

**RF Coexistence** (per Espressif docs): ESP32 uses time-division multiplexing for WiFi/BLE coexistence. ESP-NOW shares the WiFi radio.

**Gateway Overhead Estimate**:
- ESP-NOW RX callback: ~0.1ms per packet (copies to queue)
- BLE notification prep: ~0.5ms per batch
- Protocol switch latency: ~1-2ms when transitioning between WiFi/BLE operations
- **Total overhead**: ~2-5ms per TDMA frame for protocol management

This overhead is already accounted for in the 2ms guard time, but high sensor counts may require increasing guard time to 3-4ms.

### 6. Magnetometer Architecture

**Current Design**: Magnetometer data is sent via separate `EnviroData` packets (not in `TDMABatchedSensorData`).

**Planned Architecture**: Single magnetometer at pelvis for entire system
- Reduces per-node data overhead (mag not in every sensor sample)
- Pelvis-mounted Gateway node sends EnviroData at lower rate (~10Hz)
- Used for heading reference/yaw correction across all body segments
- **Benefit**: No additional bytes per IMU sample - magnetometer is system-level, not sensor-level

---

## Problem Analysis: Why 6-Sensor Nodes Struggle

With 6 sensors, current system:
1. Waits for 4 samples (80ms delay)
2. Sends 4 packets × 3ms each = **12ms** transmit time
3. Only ~5ms margin for timing jitter

**Result**: Packets collide with next beacon or miss the transmit window.

---

## Proposed Solution: Adaptive Batching with Compression

### Strategy 1: Reduce Data Per Sample (RECOMMENDED)

**Observation**: The timestamp per sample is redundant within a batch - all samples in one packet have predictable timestamps (5ms apart).

**New Compact Structure** (17 bytes instead of 25):
```cpp
struct __attribute__((packed)) TDMACompactSensorData {
  uint8_t sensorId;       // 1 byte - could use 4-bit if <16 sensors
  int16_t q[4];           // 8 bytes - quaternion
  int16_t a[3];           // 6 bytes - accel
  int16_t g[2];           // 4 bytes - gyroX, gyroY only (gyroZ derivable)
  // Total: 19 bytes (save 6 bytes/sample/sensor = 24% reduction)
};
```

**Even more compact** (15 bytes - drop full gyro, send only magnitude + axis):
```cpp
struct __attribute__((packed)) TDMAUltraCompactData {
  uint8_t sensorId;       // 1 byte
  int16_t q[4];           // 8 bytes - quaternion (essential)
  int16_t a[3];           // 6 bytes - accel (essential for ZUPT/gravity)
  // Gyro: reconstructed from quaternion delta on receiver
  // Total: 15 bytes (40% reduction!)
};
```

### Strategy 2: Packet-Level Timestamp Optimization

Move timestamp from per-sensor to per-packet:
```cpp
struct __attribute__((packed)) TDMADataPacketV2 {
  uint8_t type;           // 1 byte
  uint8_t nodeId;         // 1 byte
  uint32_t frameNumber;   // 4 bytes
  uint32_t baseTimestamp; // 4 bytes - timestamp of first sample
  uint8_t sampleCount;    // 1 byte
  uint8_t sensorCount;    // 1 byte
  uint8_t sampleIntervalMs; // 1 byte - delta between samples (usually 5ms)
  // Total header: 13 bytes (was 8 + 4*sensors timestamps)
};

struct __attribute__((packed)) TDMACompactSensorDataV2 {
  uint8_t sensorId;       // 1 byte
  int16_t q[4];           // 8 bytes
  int16_t a[3];           // 6 bytes
  int16_t g[3];           // 6 bytes
  // Total: 21 bytes per sample per sensor
};
```

**Savings**: 4 bytes × sensors × samples moved to single 5-byte header addition

### Strategy 3: Adaptive Sample Rate Per Node

Instead of forcing all nodes to 200Hz/50Hz, let high-sensor-count nodes run at lower effective rates:

| Sensors | Sample Rate | Batch Size | TX Rate | Pkts/Frame |
|---------|-------------|------------|---------|------------|
| 1-2     | 200Hz       | 4          | 50Hz    | 1          |
| 3-4     | 200Hz       | 2          | 100Hz   | 1          |
| 5-6     | 100Hz       | 2          | 50Hz    | 1          |
| 7-9     | 100Hz       | 1          | 100Hz   | 1          |

This keeps all nodes to **1 packet per frame**, eliminating timing collisions.

---

## Recommended Implementation: Hybrid Approach

### Phase 1: Immediate Fix (Firmware Only)

Modify `hasBufferedData()` to be sensor-count aware:

```cpp
bool hasBufferedData() const {
  uint8_t maxSamplesPerPacket = calculateMaxSamplesPerPacket(sampleBuffer.sensorCount);
  
  // For high sensor counts (>5), send as soon as we have 1 packet's worth
  // This trades latency for reliability
  if (maxSamplesPerPacket == 1) {
    return sampleBuffer.sampleCount >= 1;
  }
  
  // For medium sensor counts (3-5), send at 2 samples
  if (maxSamplesPerPacket <= 2) {
    return sampleBuffer.sampleCount >= 2;
  }
  
  // For low sensor counts (1-2), wait for full 4-sample batch
  return sampleBuffer.sampleCount >= TDMA_SAMPLES_PER_FRAME;
}
```

### Phase 2: Protocol Optimization (Requires Both Ends)

1. Implement `TDMACompactSensorDataV2` structure
2. Update web app parser to handle new format
3. Derive gyro from quaternion deltas when needed

### Phase 3: BLE Throughput Optimization

**Source**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/ble/get-started/ble-connection.html

#### BLE Data Channel Limits (per Espressif Official Documentation)

| Parameter | Value | Notes |
|-----------|-------|-------|
| Default MTU | **23 bytes** | Before BLE 4.2 |
| Max MTU with DLE | **247 bytes** ATT data | Data Length Extension (BLE 4.2+) |
| Data PDU Payload | 0-27 bytes (legacy) / 0-251 bytes (DLE) | Includes L2CAP header |
| L2CAP Header | **4 bytes** | Part of PDU payload |
| Connection Interval | 7.5ms - 4.0s | Step size 1.25ms, determines data exchange frequency |
| Peripheral Latency | 0-499 | Max connection events peripheral can skip |
| Supervision Timeout | 100ms - 32s | Max time between successful connection events |

#### BLE Throughput Calculation

**Connection Interval**: Our system uses ~36 × 1.25ms = **45ms** connection interval
**MTU**: Configured at **512 bytes** (after MTU exchange)
**Effective ATT Payload**: 512 - 3 (ATT header) = **509 bytes** per notification

Current BLE bottleneck:
- MTU: 512 bytes (negotiated)
- Batch interval: 40ms (25 Hz batches)
- Throughput: ~12.8 KB/s effective

With compact format at 15 bytes/sample:
- 12,800 bytes/sec ÷ 15 bytes = **853 samples/sec** theoretical
- With 8 nodes × 6 sensors = 48 sensors
- 853 ÷ 48 = **~17 Hz per sensor** sustainable

**Recommendation**: Reduce BLE_BATCH_INTERVAL to 20ms (50 Hz batches) and use compression.

---

## Maximum Sensor Capacity Matrix

### With Current Protocol (25 bytes/sample)
| Configuration | Total Sensors | Effective Rate | Packets/Sec |
|---------------|---------------|----------------|-------------|
| 8 × 1 sensor  | 8             | 200Hz          | 50          |
| 4 × 2 sensors | 8             | 200Hz          | 50          |
| 4 × 3 sensors | 12            | 200Hz          | 100         |
| 3 × 4 sensors | 12            | 200Hz          | 75          |
| 2 × 6 sensors | 12            | 200Hz          | 100         |
| **Mixed optimal** | **~24** | **50-100Hz** | **~100** |

### With Compact Protocol (15 bytes/sample)
| Configuration | Total Sensors | Effective Rate | Packets/Sec |
|---------------|---------------|----------------|-------------|
| 8 × 2 sensors | 16            | 200Hz          | 50          |
| 4 × 4 sensors | 16            | 200Hz          | 50          |
| 4 × 6 sensors | 24            | 200Hz          | 100         |
| 2 × 9 sensors | 18            | 200Hz          | 50          |
| **Mixed optimal** | **~32-48** | **100-200Hz** | **~100** |

---

## Final Recommendations

### Immediate (No Protocol Change)
1. ✅ Implement adaptive `hasBufferedData()` based on sensor count
2. ✅ Accept 50Hz effective rate for 6+ sensor nodes
3. ✅ Web app already has dt smoothing to handle variable rates

### Short Term (Minor Protocol Change)
1. Move timestamps to packet header (saves 4 bytes × sensors per sample)
2. Add protocol version field for backward compatibility
3. Update IMUParser.ts to handle both formats

### Long Term (Major Optimization)
1. Implement 15-byte ultra-compact format
2. Derive gyro from quaternion deltas in web app
3. Increase BLE batch rate to 50Hz
4. Target: 48+ sensors at 100Hz effective rate

---

## Implementation Priority

| Priority | Change | Effort | Impact |
|----------|--------|--------|--------|
| 1 | Adaptive hasBufferedData() | 1 hour | High - fixes 6-sensor nodes |
| 2 | Packet-level timestamps | 4 hours | Medium - +30% capacity |
| 3 | Compact data format | 8 hours | High - +60% capacity |
| 4 | BLE batch optimization | 2 hours | Medium - removes final bottleneck |

---

## ESP-NOW v2.0 Migration Assessment

**🎉 AVAILABLE NOW**: ESP-NOW v2.0 supports **1470 bytes** per packet (5.88× improvement over v1.0's 250 bytes).

**Arduino-ESP32 v3.3.6** (ESP-IDF v5.5.2) is stable and includes full v2.0 support!

| Scenario | v1.0 (250 bytes) | v2.0 (1470 bytes) |
|----------|------------------|-------------------|
| 6 sensors × 4 samples | 600 bytes → **4 packets** | 600 bytes → **1 packet** ✅ |
| 9 sensors × 4 samples | 908 bytes → **4 packets** | 908 bytes → **1 packet** ✅ |

### How to Upgrade (Arduino IDE)
1. Tools → Board → Boards Manager
2. Search "esp32" → Update to **v3.3.6** or later
3. Update firmware constant: `ESPNOW_MAX_PAYLOAD 1470`
4. Remove multi-packet batching complexity

**Recommendation**: Upgrade now - v2.0 eliminates ALL batching issues permanently.

📄 **Full Analysis**: [ESPNOW_V2_MIGRATION_ANALYSIS.md](./ESPNOW_V2_MIGRATION_ANALYSIS.md)

---

## Official Documentation References

### ESP-NOW Protocol
- **Main Documentation**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/network/esp_now.html
- **Key Constants**:
  - `ESP_NOW_MAX_DATA_LEN` = 250 bytes (v1.0)
  - `ESP_NOW_MAX_DATA_LEN_V2` = 1470 bytes (v2.0)
  - `ESP_NOW_MAX_TOTAL_PEER_NUM` = 20 devices
  - `ESP_NOW_MAX_ENCRYPT_PEER_NUM` = 17 devices (configurable)
- **Frame Format**: Vendor-specific action frame with CCMP encryption support
- **Error Codes**: `ESP_ERR_ESPNOW_NO_MEM` indicates TX queue overflow

### Bluetooth Low Energy
- **Connection Guide**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/ble/get-started/ble-connection.html
- **Data Exchange Guide**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/ble/get-started/ble-data-exchange.html
- **Key Parameters**:
  - Default MTU: 23 bytes (pre-BLE 4.2), up to 247 bytes ATT data with DLE
  - Connection Interval: 7.5ms - 4.0s (step 1.25ms)
  - Peripheral Latency: Allows skipping connection events when idle
  - GATT Notifications: Server-initiated push without ACK (faster than indications)

### RF Coexistence
- **Coexistence Guide**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/coexist.html
- ESP32 uses time-division multiplexing for WiFi/BLE coexistence
- ESP-NOW shares WiFi radio resources
