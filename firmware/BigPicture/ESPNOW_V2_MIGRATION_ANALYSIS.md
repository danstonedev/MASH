# ESP-NOW v2.0 Migration Analysis

## Executive Summary

**Opportunity**: ESP-NOW v2.0 increases maximum payload from **250 bytes to 1470 bytes** - a **5.88× improvement** that would eliminate all current batching complexity.

**Current Platform**: Arduino IDE with Arduino-ESP32 board package.

**Verdict**: ✅ **v2.0 IS AVAILABLE NOW!** Arduino-ESP32 v3.3.6 (ESP-IDF v5.5.2) is stable and includes full ESP-NOW v2.0 support.

---

## 1. ESP-NOW Version Comparison

| Feature | v1.0 | v2.0 |
|---------|------|------|
| Max Payload | **250 bytes** | **1470 bytes** |
| ESP-IDF Version | v4.x, v5.0-5.2 | v5.3+ (stable) |
| API | `ESP_NOW_MAX_DATA_LEN` | `ESP_NOW_MAX_DATA_LEN_V2` |
| Interoperability | v1.0 only | Receives from v1.0 and v2.0 |
| Frame Format | Single vendor element | Multiple vendor elements (fragmented) |

**Source**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/network/esp_now.html

---

## 2. Current Platform Analysis

### Arduino IDE Setup
- **Board Manager**: esp32 by Espressif Systems
- **Current Stable**: v3.3.6 (released ~January 2026)
- **Based on**: ESP-IDF v5.5.2
- **ESP-NOW**: ✅ **v2.0 SUPPORTED** (1470 bytes)

### How to Upgrade in Arduino IDE

1. **Open Arduino IDE** → Tools → Board → Boards Manager
2. **Search** for "esp32"
3. **Update** "esp32 by Espressif Systems" to **v3.x.x** (v3.3.6 or later)
4. **Recompile** firmware

### Version Check
If unsure of your current version:
- Arduino IDE 2.x: Tools → Board → Boards Manager → search "esp32" → shows installed version
- Or check: File → Preferences → look at board manager URL

### Breaking Changes in v3.x
Arduino-ESP32 v3.x has some API changes from v2.x:
- WiFi API changes (minor)
- BLE library restructured (may need updates)
- Some deprecated functions removed
- **ESP-NOW API is the same** - just larger packet size available

---

## 3. Migration Path

### ✅ RECOMMENDED: Upgrade to Arduino-ESP32 v3.x

| Step | Action | Effort |
|------|--------|--------|
| 1 | Update board package in Arduino IDE | 5 min |
| 2 | Test compile existing firmware | 10 min |
| 3 | Fix any v3.x compatibility issues | 1-2 hours |
| 4 | Update `ESPNOW_MAX_PAYLOAD` constant | 5 min |
| 5 | Remove multi-packet batching code | 30 min |
| 6 | Test with hardware | 1 hour |

**Total Estimated Effort**: 3-4 hours

### What Changes in Firmware

**Before (v2.x / v1.0)**:
```cpp
#define ESPNOW_MAX_PAYLOAD 250  // v1.0 limit
// Complex multi-packet batching logic...
```

**After (v3.x / v2.0)**:
```cpp
#define ESPNOW_MAX_PAYLOAD 1470  // v2.0 limit - 6× larger!
// Single packet per frame - simple!
```

---

## 4. Capacity Comparison: v1.0 vs v2.0

### Current v1.0 Capacity (250 bytes max)
```
Header:           8 bytes
Available data: 242 bytes
Bytes per sensor sample: 25 bytes

| Sensors | Samples/Packet | Full 4-Sample Batch? |
|---------|----------------|----------------------|
| 1       | 9              | ✓ (4 samples fit)    |
| 2       | 4              | ✓ (exactly 4)        |
| 3       | 3              | ✗ (needs 2 packets)  |
| 6       | 1              | ✗ (needs 4 packets)  |
| 9       | 1              | ✗ (needs 4 packets)  |
```

### Theoretical v2.0 Capacity (1470 bytes max)
```
Header:           8 bytes
Available data: 1462 bytes
Bytes per sensor sample: 25 bytes

| Sensors | Samples/Packet | Full 4-Sample Batch? |
|---------|----------------|----------------------|
| 1       | 58             | ✓ (4 samples fit)    |
| 2       | 29             | ✓ (4 samples fit)    |
| 3       | 19             | ✓ (4 samples fit)    |
| 6       | 9              | ✓ (4 samples fit!)   |
| 9       | 6              | ✓ (4 samples fit!)   |
| 14      | 4              | ✓ (exactly 4)        |
| 15+     | 3              | ✗ (multiple packets) |
```

**Impact**: With v2.0, ALL practical configurations (up to 14 sensors/node) would fit in a single packet!

---

## 5. Why v2.0 Solves Everything

### Current Pain Points (v1.0)
1. ❌ 6-sensor nodes need 4 packets per frame
2. ❌ Timing collisions with beacon
3. ❌ Complex adaptive batching logic
4. ❌ Reduced effective sample rate

### v2.0 Solution
1. ✅ 6-sensor node: 600 bytes << 1470 bytes limit
2. ✅ Single packet per frame, guaranteed
3. ✅ Simple, predictable timing
4. ✅ Full 200Hz sample rate preserved

### The Math
```
6 sensors × 4 samples × 25 bytes = 600 bytes
600 bytes + 8 byte header = 608 bytes
608 bytes << 1470 byte v2.0 limit ✓

Even 9 sensors fits:
9 sensors × 4 samples × 25 bytes = 900 bytes
900 + 8 = 908 bytes << 1470 bytes ✓
```

---

## 6. Recommended Strategy

### Immediate Action (This Week)
🚀 **Upgrade to Arduino-ESP32 v3.x and implement v2.0**
1. Update board package in Arduino IDE to v3.3.6+
2. Test compile - fix any compatibility issues
3. Update `ESPNOW_MAX_PAYLOAD` to 1470
4. Simplify SyncManager to single-packet sends
5. Test with hardware

### Why Wait No Longer?
- v3.3.6 is **stable** (released January 2026)
- ESP-IDF v5.5.2 is mature
- v2.0 eliminates ALL batching complexity
- Single packet = simpler timing = more reliable

---

## 7. v2.0 Migration Checklist (For Future Reference)

When v2.0 becomes available via Arduino framework:

### Firmware Changes Required

#### TDMAProtocol.h
```cpp
// Change from:
#define ESPNOW_MAX_PAYLOAD 250

// To:
#ifdef ESP_NOW_MAX_DATA_LEN_V2
  #define ESPNOW_MAX_PAYLOAD ESP_NOW_MAX_DATA_LEN_V2  // 1470 bytes
#else
  #define ESPNOW_MAX_PAYLOAD ESP_NOW_MAX_DATA_LEN     // 250 bytes fallback
#endif
```

#### SyncManager (Node)
```cpp
// Remove multi-packet loop - always single packet
void sendTDMAData() {
    uint8_t packet[ESPNOW_MAX_PAYLOAD];  // Now 1470 bytes
    // ... build packet ...
    
    // Always single send - no loop needed
    esp_now_send(gatewayMac, packet, totalPacketSize);
}
```

#### SyncManager (Gateway)
- No changes needed - receiver handles any packet size

### Web App Changes
- No changes needed - parser already handles variable sample counts

### Testing Required
1. Verify all nodes upgrade to v2.0-capable firmware
2. Test mixed v1.0/v2.0 environment (v2.0 must receive both)
3. Measure actual throughput improvement
4. Validate timing margins

---

## 8. Alternative Optimizations (For v1.0)

While waiting for v2.0, these optimizations are already in place or recommended:

### Already Implemented
- ✅ Adaptive `hasBufferedData()` based on sensor count
- ✅ dt smoothing in web app for variable rates

### Recommended Additions
1. **Packet-level timestamps**: Move timestamp from per-sensor to packet header
   - Saves: 4 bytes × sensors per sample
   - Impact: 6-sensor batch drops from 600 to 504 bytes (3 packets instead of 4)

2. **Compact data format**: Remove gyro (derive from quaternion delta)
   - Saves: 6 bytes per sample per sensor
   - Impact: 6-sensor batch drops to 312 bytes (2 packets instead of 4)

---

## 9. Decision Matrix

| Criteria | v1.0 + Batching | ESP-IDF Migration | Wait for v3.x |
|----------|-----------------|-------------------|---------------|
| Development Effort | ✅ Low (done) | ❌ Very High | ✅ Low |
| Risk | ✅ None | ⚠️ High | ✅ Low |
| Capacity | ⚠️ Limited | ✅ Full v2.0 | ✅ Full v2.0 |
| Time to Deploy | ✅ Now | ❌ 4-8 weeks | ⏳ 6-12 months |
| Library Compatibility | ✅ All work | ⚠️ Must replace | ⏳ Testing needed |

**Recommendation**: Continue with v1.0 adaptive batching now; plan v3.x migration when stable.

---

## 10. References

### Official ESP-NOW Documentation
- **Stable (v5.5.2)**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/network/esp_now.html
- **v5.1.4**: https://docs.espressif.com/projects/esp-idf/en/v5.1.4/esp32/api-reference/network/esp_now.html
- **Header File**: https://github.com/espressif/esp-idf/blob/master/components/esp_wifi/include/esp_now.h

### Arduino-ESP32
- **Repository**: https://github.com/espressif/arduino-esp32
- **v2.x Branch**: Based on ESP-IDF v4.4.x (v1.0 only)
- **v3.x Development**: Based on ESP-IDF v5.x (v2.0 capable)

---

## Appendix: API Differences

### ESP-IDF v4.4.7 (Arduino v2.0.17) - v1.0 Only
```c
#define ESP_NOW_MAX_DATA_LEN 250

// No version distinction in API
esp_err_t esp_now_send(const uint8_t *peer_addr, const uint8_t *data, size_t len);
// len must be <= 250
```

### ESP-IDF v5.5.2 (Stable) - v1.0 + v2.0
```c
#define ESP_NOW_MAX_DATA_LEN      250   // v1.0 limit
#define ESP_NOW_MAX_DATA_LEN_V2   1470  // v2.0 limit

// Version query API
esp_err_t esp_now_get_version(uint32_t *version);

// Same send API, but len can be up to 1470 for v2.0 peers
esp_err_t esp_now_send(const uint8_t *peer_addr, const uint8_t *data, size_t len);
```
