# 🚀 IMU Connect System Optimization Master Plan

> **⚠️ PARTIALLY OUTDATED (March 2026):** Delta compression (Section 6), `TDMADataPacketV3`, `TDMA_PACKET_DATA_V3` (0x24), and related V3 structures were never implemented and have been removed from the codebase. All nodes use `TDMANodeDataPacket` (0x26) with keyframe-only data. See `TDMAProtocol.h` for current definitions.

**Version:** 1.0  
**Date:** February 3, 2026  
**Status:** PLANNING PHASE

---

## 📋 Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Audit](#2-current-state-audit)
3. [Packet Format Consolidation](#3-packet-format-consolidation)
4. [Bottleneck Analysis](#4-bottleneck-analysis)
5. [Instrumentation Plan](#5-instrumentation-plan)
6. [Delta Compression Implementation](#6-delta-compression-implementation)
7. [Implementation Phases](#7-implementation-phases)
8. [Validation Criteria](#8-validation-criteria)

---

## 1. Executive Summary

### Goals
1. **Eliminate legacy packet formats** - Single unified format (0x24)
2. **Measure actual data characteristics** - Instrument delta distributions
3. **Implement delta compression** - Reduce bandwidth by 20-35%
4. **Identify true bottlenecks** - Data-driven optimization
5. **Maximize BLE throughput** - 2M PHY, optimal parameters

### Expected Outcomes
| Metric | Current | Target | Method |
|--------|---------|--------|--------|
| BLE Throughput | ~60 KB/s | ~120 KB/s | 2M PHY + DLE |
| Packet Size (6 sensors) | 316 bytes | ~220 bytes | Delta compression |
| Effective Sample Rate | 100 Hz | 150+ Hz | Bandwidth savings |
| Packet Types in Use | 6+ | 2 | Consolidation |

---

## 2. Current State Audit

### 2.1 Packet Types Currently Defined

#### ESP-NOW Packets (Node → Gateway)

| Type | Hex | File | Status | Usage |
|------|-----|------|--------|-------|
| Sync Pulse | 0x01 | SyncManager.cpp | ⚠️ LEGACY | PTP replaced this |
| IMU Compressed | 0x02 | SyncManager.cpp:265 | ⚠️ LEGACY | Never sent anymore |
| Legacy Batched | 0x03 | MASH_Gateway.ino:691 | ❌ REJECTED | Explicitly rejected |
| Environmental | 0x04 | SyncManager.cpp:305/330 | ✅ ACTIVE | Mag/Baro data |
| Node Info | 0x05 | SyncManager.cpp:337/362 | ✅ ACTIVE | Discovery |
| Radio Mode | 0x06 | SyncManager.cpp:437 | ✅ ACTIVE | BLE on/off |
| Mag Calib | 0x07 | PacketTypes.h | ✅ ACTIVE | Calibration progress |
| CMD Forward | 0x08 | SyncManager.cpp:462 | ✅ ACTIVE | Command relay |
| TDMA Beacon | 0x20 | TDMAProtocol.h | ✅ ACTIVE | Sync beacons |
| TDMA Schedule | 0x21 | TDMAProtocol.h | ✅ ACTIVE | Slot assignments |
| TDMA Register | 0x22 | TDMAProtocol.h | ✅ ACTIVE | Node registration |
| **TDMA Data** | **0x23** | TDMAProtocol.h | ✅ **PRIMARY** | IMU data stream |
| DELAY_REQ | 0x30 | TDMAProtocol.h | ✅ ACTIVE | PTP sync |
| DELAY_RESP | 0x31 | TDMAProtocol.h | ✅ ACTIVE | PTP sync |

#### BLE Packets (Gateway → WebApp)

| Type | Hex | Parser | Status | Notes |
|------|-----|--------|--------|-------|
| Legacy Single | 0x01 | IMUParser.ts:137 | ⚠️ DEAD CODE | 20-byte format |
| Quaternion Only | 0x02 | IMUParser.ts:211 | ⚠️ DEAD CODE | No gyro/accel |
| Quaternion Ext | 0x03 | IMUParser.ts:239 | ⚠️ DEAD CODE | Replaced by 0x23 |
| Environmental | 0x04 | IMUParser.ts:118 | ✅ ACTIVE | Forwarded raw |
| Node Info | 0x05 | IMUParser.ts:127 | ✅ ACTIVE | Forwarded raw |
| **TDMA Batched** | **0x23** | IMUParser.ts:293 | ✅ **PRIMARY** | All IMU data |

### 2.2 Packet Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        CURRENT PACKET FLOW                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  [NODE]                    [GATEWAY]                     [WEBAPP]            │
│                                                                              │
│  ┌─────────────┐          ┌─────────────┐               ┌─────────────┐     │
│  │ 0x23 TDMA   │──ESP-NOW─▶│ Decimate    │───BLE 0x23──▶│ IMUParser   │     │
│  │ (4 samples) │          │ 4→2 samples │               │ parseTDMA() │     │
│  └─────────────┘          └─────────────┘               └─────────────┘     │
│                                                                              │
│  ┌─────────────┐          ┌─────────────┐               ┌─────────────┐     │
│  │ 0x04 Enviro │──ESP-NOW─▶│ Forward raw │───BLE 0x04──▶│ parseEnviro │     │
│  └─────────────┘          └─────────────┘               └─────────────┘     │
│                                                                              │
│  ┌─────────────┐          ┌─────────────┐               ┌─────────────┐     │
│  │ 0x05 NodeInf│──ESP-NOW─▶│ Forward raw │───BLE 0x05──▶│ parseNodeInf│     │
│  └─────────────┘          └─────────────┘               └─────────────┘     │
│                                                                              │
│  DEAD CODE PATHS (parsers exist but never triggered):                       │
│  • 0x01 Legacy (20 bytes) - Parser at IMUParser.ts:137                      │
│  • 0x02 Quat Only - Parser at IMUParser.ts:211                              │
│  • 0x03 Quat Extended - Parser at IMUParser.ts:239                          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Current Data Rates

| Stage | Data Rate | Calculation |
|-------|-----------|-------------|
| Node IMU sampling | 200 Hz | Internal ICM20649 rate |
| TDMA frame rate | 50 Hz | 4 samples batched per frame |
| Samples per frame | 4 | 200 / 50 = 4 |
| Bytes per sample | 25 | TDMABatchedSensorData |
| Bytes per sensor per frame | 100 | 4 × 25 |
| Single node (6 sensors) | 600 B/frame | 6 × 100 |
| 8 nodes × 50 Hz | 240 KB/s | 8 × 600 × 50 |
| After decimation (4→2) | **120 KB/s** | 50% reduction |
| BLE 1M PHY capacity | ~80 KB/s | Practical limit |
| **Current bottleneck** | **BLE TX** | 120 > 80 KB/s |

---

## 3. Packet Format Consolidation

### 3.1 Target State: Two Packet Types Only

| Type | Hex | Name | Direction | Purpose |
|------|-----|------|-----------|---------|
| **0x24** | 0x24 | TDMA_DATA_V3 | Node→Gateway→WebApp | All IMU data (with delta) |
| 0x05 | 0x05 | NODE_INFO | Node→Gateway→WebApp | Discovery/status |

**Everything else becomes internal protocol (not visible to WebApp):**
- TDMA Beacons (0x20) - Gateway only
- TDMA Schedule (0x21) - Gateway↔Node only
- DELAY_REQ/RESP (0x30/0x31) - Gateway↔Node only
- Environmental (0x04) - Embedded in 0x24 or separate low-rate stream

### 3.2 New Unified Packet Format (0x24)

```cpp
// ============================================================================
// TDMA_PACKET_DATA_V3 (0x24) - Unified IMU Data Format
// ============================================================================
// Features:
// - Self-describing (flags indicate compression mode)
// - Keyframe + delta architecture for recovery
// - Optional environmental data embedding
// - Sync quality metadata (from V2)
// ============================================================================

struct __attribute__((packed)) TDMADataPacketV3 {
    uint8_t type;               // 0x24
    uint8_t nodeId;             // Node identifier
    uint32_t frameNumber;       // TDMA frame number
    uint8_t flags;              // See below
    uint8_t sampleCount;        // 1-4 samples
    uint8_t sensorCount;        // 1-8 sensors
    
    // Flags byte breakdown:
    // Bit 0: hasEnviro (environmental data appended)
    // Bit 1: isDelta (0=absolute keyframe, 1=delta from previous)
    // Bit 2-3: compressionLevel (0=none, 1=quat-only, 2=full)
    // Bit 4-5: syncConfidence (0=uncertain, 1=low, 2=med, 3=high)
    // Bit 6-7: reserved
    
    // SyncQuality (always present in V3)
    int16_t offsetUncertaintyUs;  // Sync uncertainty estimate
    int16_t driftPpm;             // Clock drift in PPM
    uint16_t syncAgeMs;           // Time since last PTP exchange
    
    // Payload follows (variable based on flags)
    // See section 3.3 for payload formats
};

// Size: 14 bytes header (vs 8 for V1, 15 for V2)
```

### 3.3 Payload Formats

#### Absolute Payload (isDelta=0, compressionLevel=0)
```cpp
struct __attribute__((packed)) AbsoluteSensorData {
    uint8_t sensorId;       // 1 byte
    uint32_t timestampUs;   // 4 bytes - synchronized timestamp
    int16_t q[4];           // 8 bytes - quaternion (w,x,y,z) × 16384
    int16_t a[3];           // 6 bytes - accel (x,y,z) × 100 m/s²
    int16_t g[3];           // 6 bytes - gyro (x,y,z) × 900 rad/s
};
// Total: 25 bytes per sensor per sample (unchanged)
```

#### Delta Payload (isDelta=1, compressionLevel=1)
```cpp
struct __attribute__((packed)) DeltaSensorData {
    uint8_t sensorId;       // 1 byte
    uint16_t timestampDeltaUs; // 2 bytes - delta from previous (max 65ms)
    int8_t dq[4];           // 4 bytes - quaternion delta × 16384 (±0.0078)
    int16_t a[3];           // 6 bytes - accel absolute (impacts need precision)
    int8_t dg[3];           // 3 bytes - gyro delta × 900 (±0.14 rad/s)
};
// Total: 16 bytes per sensor per sample (36% reduction!)
```

### 3.4 Packet Size Comparison

| Configuration | V1 Absolute | V3 Absolute | V3 Delta | V3 Mixed* |
|---------------|-------------|-------------|----------|-----------|
| Header | 8 B | 14 B | 14 B | 14 B |
| 6 sensors × 1 sample | 150 B | 150 B | 96 B | 123 B |
| 6 sensors × 2 samples | 300 B | 300 B | 192 B | 246 B |
| CRC | 1 B | 1 B | 1 B | 1 B |
| **Total (2 samples)** | **309 B** | **315 B** | **207 B** | **261 B** |
| **Savings** | baseline | -2% | **33%** | **16%** |

*Mixed = Sample 0 absolute keyframe, Sample 1 delta

---

## 4. Bottleneck Analysis

### 4.1 Current System Rate-Limiting Factors

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     RATE LIMITING FACTOR ANALYSIS                            │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STAGE              CAPACITY        CURRENT LOAD     UTILIZATION  BOTTLENECK │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  1. IMU Sampling    4000 Hz         200 Hz           5%           ✅ OK      │
│     (per sensor)    (ICM20649)      (configured)                             │
│                                                                              │
│  2. Node CPU        240 MHz         ~30%             30%          ✅ OK      │
│     (ESP32-S3)      (dual core)     (filtering)                              │
│                                                                              │
│  3. ESP-NOW TX      1 Mbps          120 KB/s         ~12%         ✅ OK      │
│     (per node)      (theoretical)   (6 sensors)                              │
│                                                                              │
│  4. ESP-NOW RX      250 KB/s        240 KB/s         96%          ⚠️ NEAR   │
│     (Gateway)       (8 nodes)       (8 nodes)                     LIMIT     │
│                                                                              │
│  5. Gateway CPU     240 MHz         ~40%             40%          ✅ OK      │
│     (ESP32-S3)      (dual core)     (bridging)                               │
│                                                                              │
│  6. BLE TX Queue    64 × 700 B      ~50 frames       ~80%         ⚠️ STRESS │
│     (Gateway)       = 44.8 KB       buffered                                 │
│                                                                              │
│  7. BLE PHY         1M: 80 KB/s     120 KB/s         150%         ❌ OVER!  │
│     (Gateway→App)   2M: 160 KB/s                     75%          ⚠️ w/2M   │
│                                                                              │
│  8. WebApp Parse    ~500 KB/s       ~60 KB/s         12%          ✅ OK      │
│     (JavaScript)    (measured)      (after BLE)                              │
│                                                                              │
│  9. WebApp Render   60 fps          60 fps           100%         ✅ OK      │
│     (Three.js)      (target)        (achieved)                               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

LEGEND:
  ✅ OK       = <70% utilization, plenty of headroom
  ⚠️ NEAR    = 70-95% utilization, monitor closely
  ⚠️ STRESS  = >95% utilization, may drop under load
  ❌ OVER!   = >100% utilization, active data loss
```

### 4.2 The BLE Bottleneck Deep Dive

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    BLE THROUGHPUT BREAKDOWN                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  BLE 1M PHY Theoretical Maximum:                                            │
│  ├─ Raw bit rate: 1 Mbps = 125 KB/s                                        │
│  ├─ Protocol overhead: ~30-40%                                              │
│  │   ├─ Preamble: 1 byte per packet                                        │
│  │   ├─ Access address: 4 bytes                                            │
│  │   ├─ Header: 2 bytes                                                    │
│  │   ├─ MIC (encryption): 4 bytes                                          │
│  │   ├─ CRC: 3 bytes                                                       │
│  │   └─ IFS (inter-frame spacing): 150 µs                                  │
│  └─ Practical throughput: ~75-90 KB/s                                      │
│                                                                              │
│  BLE 2M PHY Theoretical Maximum:                                            │
│  ├─ Raw bit rate: 2 Mbps = 250 KB/s                                        │
│  ├─ Same overhead (but faster)                                              │
│  └─ Practical throughput: ~150-180 KB/s                                    │
│                                                                              │
│  Connection Interval Impact:                                                 │
│  ├─ Current: Auto-negotiated (~15-30ms typical)                            │
│  ├─ Optimal: 7.5ms (minimum allowed)                                       │
│  ├─ Packets per interval: ~6 notifications max                             │
│  └─ 7.5ms interval = 133 opportunities/sec × 512 MTU = 68 KB/s             │
│                                                                              │
│  Our Current Settings:                                                       │
│  ├─ MTU: 512 bytes (good)                                                  │
│  ├─ PHY: 1M (auto-negotiates, not forced to 2M)                            │
│  ├─ Connection interval: Not explicitly set                                 │
│  ├─ DLE (Data Length Extension): Not explicitly enabled                    │
│  └─ Batching: 10ms interval (100 batches/sec)                              │
│                                                                              │
│  ACHIEVABLE WITH OPTIMIZATION:                                              │
│  ├─ Force 2M PHY: +100% throughput                                         │
│  ├─ Enable DLE (251 bytes): Better packing                                 │
│  ├─ 7.5ms connection interval: More opportunities                          │
│  └─ Combined: ~150 KB/s practical throughput                               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Bandwidth Budget

| Node Config | Raw Data | After Decimation | With Delta | Fits in BLE? |
|-------------|----------|------------------|------------|--------------|
| 1 node × 6 sensors | 30 KB/s | 15 KB/s | 10 KB/s | ✅ 1M PHY |
| 2 nodes × 6 sensors | 60 KB/s | 30 KB/s | 20 KB/s | ✅ 1M PHY |
| 4 nodes × 6 sensors | 120 KB/s | 60 KB/s | 40 KB/s | ✅ 1M PHY |
| 8 nodes × 6 sensors | 240 KB/s | 120 KB/s | 80 KB/s | ⚠️ 1M tight |
| 8 nodes × 6 sensors | 240 KB/s | 120 KB/s | 80 KB/s | ✅ 2M PHY |

---

## 5. Instrumentation Plan

### 5.1 Phase 0: Measure Before Optimizing

Before implementing delta compression, we need actual data on:
1. **Quaternion delta distribution** - How big are typical deltas?
2. **Gyro delta distribution** - Can we use int8 or need int16?
3. **Overflow frequency** - How often would deltas exceed int8 range?
4. **Packet loss rate** - Critical for keyframe strategy

### 5.2 Instrumentation Points

#### A. Node-Side Instrumentation (C++)
```cpp
// Add to SyncManager.cpp - TDMA data transmission

struct DeltaStats {
    uint32_t totalSamples;
    uint32_t quatOverflows;      // |delta| > 127
    uint32_t gyroOverflows;
    int16_t maxQuatDelta;        // Largest seen
    int16_t maxGyroDelta;
    uint32_t histogram[16];       // Delta magnitude buckets
};
static DeltaStats deltaStats = {};

void logDeltaDistribution(TDMABatchedSensorData* curr, TDMABatchedSensorData* prev) {
    deltaStats.totalSamples++;
    
    for (int i = 0; i < 4; i++) {
        int16_t dq = curr->q[i] - prev->q[i];
        if (abs(dq) > deltaStats.maxQuatDelta) deltaStats.maxQuatDelta = abs(dq);
        if (abs(dq) > 127) deltaStats.quatOverflows++;
        
        // Histogram: bucket by magnitude (0-7, 8-15, 16-31, etc.)
        int bucket = 0;
        int mag = abs(dq);
        while (mag > 0 && bucket < 15) { mag >>= 1; bucket++; }
        deltaStats.histogram[bucket]++;
    }
    
    // Log every 10 seconds
    static uint32_t lastLog = 0;
    if (millis() - lastLog > 10000) {
        float overflowRate = (float)deltaStats.quatOverflows / (deltaStats.totalSamples * 4) * 100;
        Serial.printf("[DELTA STATS] samples=%lu, quatOverflow=%.2f%%, maxDelta=%d\n",
            deltaStats.totalSamples, overflowRate, deltaStats.maxQuatDelta);
        Serial.printf("[HISTOGRAM] ");
        for (int i = 0; i < 16; i++) Serial.printf("%lu ", deltaStats.histogram[i]);
        Serial.println();
        lastLog = millis();
    }
}
```

#### B. Gateway-Side Instrumentation (C++)
```cpp
// Add to MASH_Gateway.ino - data callback

struct GatewayStats {
    uint32_t packetsReceived;
    uint32_t packetsDropped;
    uint32_t bytesReceived;
    uint32_t bytesTransmitted;
    uint32_t decimationSavings;
    uint32_t crcFailures;
    float avgQueueDepth;
};
static GatewayStats gwStats = {};

void logGatewayThroughput() {
    static uint32_t lastLog = 0;
    if (millis() - lastLog > 5000) {
        float rxRate = gwStats.bytesReceived / 5.0 / 1024.0;  // KB/s
        float txRate = gwStats.bytesTransmitted / 5.0 / 1024.0;
        float dropRate = (float)gwStats.packetsDropped / gwStats.packetsReceived * 100;
        
        Serial.printf("[GW THROUGHPUT] RX=%.1f KB/s, TX=%.1f KB/s, drops=%.1f%%\n",
            rxRate, txRate, dropRate);
        Serial.printf("[GW QUEUE] avg depth=%.1f, free=%d/%d\n",
            gwStats.avgQueueDepth, uxQueueSpacesAvailable(bleTxQueue), BLE_TX_QUEUE_SIZE);
        
        // Reset counters
        gwStats.packetsReceived = 0;
        gwStats.packetsDropped = 0;
        gwStats.bytesReceived = 0;
        gwStats.bytesTransmitted = 0;
        lastLog = millis();
    }
}
```

#### C. WebApp-Side Instrumentation (TypeScript)
```typescript
// Add to IMUParser.ts

interface ParseStats {
  packetsReceived: number;
  bytesReceived: number;
  crcPassed: number;
  crcFailed: number;
  formatV1Count: number;
  formatV2Count: number;
  formatV3Count: number;
  avgLatencyMs: number;
  jitterMs: number;
}

const parseStats: ParseStats = {
  packetsReceived: 0,
  bytesReceived: 0,
  crcPassed: 0,
  crcFailed: 0,
  formatV1Count: 0,
  formatV2Count: 0,
  formatV3Count: 0,
  avgLatencyMs: 0,
  jitterMs: 0,
};

// Export for dashboard display
export function getParseStats(): ParseStats {
  return { ...parseStats };
}

// Call from parseTDMAPacket
function recordPacketStats(packet: IMUDataPacket, arrivalTime: number) {
  parseStats.packetsReceived++;
  
  // Calculate latency (arrival time - packet timestamp)
  const latencyMs = (arrivalTime - packet.timestamp / 1000);
  parseStats.avgLatencyMs = parseStats.avgLatencyMs * 0.95 + latencyMs * 0.05;
}
```

### 5.3 Dashboard Additions

Add to WebApp settings panel:
```
┌─────────────────────────────────────────────────────────────────┐
│  📊 PIPELINE DIAGNOSTICS                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  THROUGHPUT                                                     │
│  ├─ BLE RX:        [====████████░░░░] 62.4 KB/s (78% capacity) │
│  ├─ Packets/sec:   412                                         │
│  └─ Samples/sec:   824 (2 per packet)                          │
│                                                                 │
│  INTEGRITY                                                      │
│  ├─ CRC Pass Rate: 99.7%                                       │
│  ├─ Parse Errors:  0.1%                                        │
│  └─ Dropped:       2.4%                                        │
│                                                                 │
│  LATENCY                                                        │
│  ├─ End-to-End:    23.4 ms (avg)                               │
│  ├─ Jitter:        ±4.2 ms                                     │
│  └─ Max Observed:  67 ms                                       │
│                                                                 │
│  DELTA COMPRESSION (when enabled)                               │
│  ├─ Overflow Rate: 0.3%                                        │
│  ├─ Avg Savings:   31.2%                                       │
│  └─ Keyframes:     1 per packet                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Delta Compression Implementation

### 6.1 Architecture Decision: Where to Compress?

| Option | Location | Pros | Cons |
|--------|----------|------|------|
| **A. Node-side** | Node SyncManager | Reduces ESP-NOW traffic too | Complex, all nodes need update |
| **B. Gateway-side** | Gateway decimation | Single point of change | Doesn't reduce ESP-NOW |
| C. WebApp-side | IMUParser | Simplest to iterate | Doesn't reduce any RF traffic |

**Recommendation: Option A (Node-side)** for maximum benefit, but **start with Option B** for faster iteration.

### 6.2 Gateway-Side Implementation (Phase 1)

```cpp
// Add to MASH_Gateway.ino

// Previous sample buffer for delta calculation (per node × per sensor)
static TDMABatchedSensorData prevSamples[TDMA_MAX_NODES][MAX_SENSORS_PER_NODE];
static bool hasPrevSample[TDMA_MAX_NODES][MAX_SENSORS_PER_NODE] = {};

void encodeWithDelta(
    const uint8_t* rawPacket, 
    size_t rawLen,
    uint8_t* outPacket,
    size_t* outLen
) {
    TDMADataPacket* header = (TDMADataPacket*)rawPacket;
    uint8_t nodeId = header->nodeId;
    uint8_t sampleCount = header->sampleCount;
    uint8_t sensorCount = header->sensorCount;
    
    // Build V3 header
    TDMADataPacketV3 v3Header;
    v3Header.type = 0x24;
    v3Header.nodeId = nodeId;
    v3Header.frameNumber = header->frameNumber;
    v3Header.sampleCount = sampleCount;
    v3Header.sensorCount = sensorCount;
    v3Header.flags = 0;  // Will be set below
    
    // Copy header to output
    memcpy(outPacket, &v3Header, sizeof(v3Header));
    size_t outOffset = sizeof(v3Header);
    
    // Process each sample
    const uint8_t* srcData = rawPacket + sizeof(TDMADataPacket);
    
    for (uint8_t s = 0; s < sampleCount; s++) {
        bool isKeyframe = (s == 0);  // First sample is always keyframe
        
        for (uint8_t i = 0; i < sensorCount; i++) {
            TDMABatchedSensorData* curr = (TDMABatchedSensorData*)(srcData);
            srcData += sizeof(TDMABatchedSensorData);
            
            uint8_t sensorSlot = i;  // Assuming sequential sensor IDs
            
            if (isKeyframe || !hasPrevSample[nodeId][sensorSlot]) {
                // Absolute encoding
                memcpy(outPacket + outOffset, curr, sizeof(TDMABatchedSensorData));
                outOffset += sizeof(TDMABatchedSensorData);
            } else {
                // Delta encoding
                TDMABatchedSensorData* prev = &prevSamples[nodeId][sensorSlot];
                DeltaSensorData delta;
                
                delta.sensorId = curr->sensorId;
                delta.timestampDeltaUs = (uint16_t)(curr->timestampUs - prev->timestampUs);
                
                // Quaternion delta with overflow check
                bool overflow = false;
                for (int q = 0; q < 4; q++) {
                    int16_t dq = curr->q[q] - prev->q[q];
                    if (dq < -127 || dq > 127) overflow = true;
                    delta.dq[q] = (int8_t)dq;
                }
                
                // Accel stays absolute (impacts)
                memcpy(delta.a, curr->a, sizeof(delta.a));
                
                // Gyro delta
                for (int g = 0; g < 3; g++) {
                    int16_t dg = curr->g[g] - prev->g[g];
                    if (dg < -127 || dg > 127) overflow = true;
                    delta.dg[g] = (int8_t)dg;
                }
                
                if (overflow) {
                    // Fallback to absolute
                    memcpy(outPacket + outOffset, curr, sizeof(TDMABatchedSensorData));
                    outOffset += sizeof(TDMABatchedSensorData);
                    // Set per-sample overflow flag in packet
                } else {
                    memcpy(outPacket + outOffset, &delta, sizeof(DeltaSensorData));
                    outOffset += sizeof(DeltaSensorData);
                }
            }
            
            // Save for next delta
            prevSamples[nodeId][sensorSlot] = *curr;
            hasPrevSample[nodeId][sensorSlot] = true;
        }
    }
    
    // Add CRC
    outPacket[outOffset] = calculateCRC8(outPacket, outOffset);
    *outLen = outOffset + 1;
}
```

### 6.3 WebApp Decoder Implementation

```typescript
// Add to IMUParser.ts

interface DeltaSensorData {
  sensorId: number;
  timestampDeltaUs: number;
  dq: [number, number, number, number];
  a: [number, number, number];
  dg: [number, number, number];
}

// State for delta reconstruction
const prevSamples: Map<number, IMUDataPacket> = new Map();

function decodeDeltaPacket(
  delta: DeltaSensorData,
  prev: IMUDataPacket
): IMUDataPacket {
  return {
    sensorId: delta.sensorId,
    timestamp: prev.timestamp + delta.timestampDeltaUs,
    timestampUs: prev.timestampUs! + delta.timestampDeltaUs,
    quaternion: [
      prev.quaternion[0] + delta.dq[0] / 16384.0,
      prev.quaternion[1] + delta.dq[1] / 16384.0,
      prev.quaternion[2] + delta.dq[2] / 16384.0,
      prev.quaternion[3] + delta.dq[3] / 16384.0,
    ],
    accelerometer: [
      delta.a[0] / 100.0,
      delta.a[1] / 100.0,
      delta.a[2] / 100.0,
    ],
    gyro: [
      prev.gyro![0] + delta.dg[0] / 900.0,
      prev.gyro![1] + delta.dg[1] / 900.0,
      prev.gyro![2] + delta.dg[2] / 900.0,
    ],
    format: '0x24-delta',
  };
}

function parseTDMAv3Packet(data: DataView): IMUDataPacket[] {
  const packets: IMUDataPacket[] = [];
  
  // Parse V3 header
  const nodeId = data.getUint8(1);
  const frameNumber = data.getUint32(2, true);
  const flags = data.getUint8(6);
  const sampleCount = data.getUint8(7);
  const sensorCount = data.getUint8(8);
  
  // Sync quality (always present in V3)
  const offsetUncertainty = data.getInt16(9, true);
  const driftPpm = data.getInt16(11, true);
  const syncAge = data.getUint16(13, true);
  
  const isDelta = (flags & 0x02) !== 0;
  const compressionLevel = (flags >> 2) & 0x03;
  
  let offset = 15;  // After V3 header
  
  for (let s = 0; s < sampleCount; s++) {
    const isKeyframe = (s === 0);  // First sample always absolute
    
    for (let i = 0; i < sensorCount; i++) {
      if (isKeyframe || !isDelta) {
        // Absolute sample (25 bytes)
        const packet = parseAbsoluteSample(data, offset);
        packets.push(packet);
        prevSamples.set(packet.sensorId, packet);
        offset += 25;
      } else {
        // Delta sample (16 bytes)
        const sensorId = data.getUint8(offset);
        const prev = prevSamples.get(sensorId);
        
        if (prev) {
          const delta = parseDeltaSample(data, offset);
          const packet = decodeDeltaPacket(delta, prev);
          packets.push(packet);
          prevSamples.set(sensorId, packet);
        } else {
          console.warn(`[V3] Missing previous sample for sensor ${sensorId}, skipping delta`);
        }
        offset += 16;
      }
    }
  }
  
  return packets;
}
```

---

## 7. Implementation Phases

### Phase 0: Instrumentation (1-2 days)
- [ ] Add delta distribution logging to Node firmware
- [ ] Add throughput logging to Gateway firmware
- [ ] Add statistics display to WebApp
- [ ] Collect 24 hours of real-world data
- [ ] Analyze delta distributions and overflow rates

### Phase 1: BLE Optimization (1 day)
- [ ] Force BLE 2M PHY on Gateway
- [ ] Enable Data Length Extension (DLE)
- [ ] Set optimal connection parameters (7.5ms interval)
- [ ] Verify throughput improvement

### Phase 2: Legacy Cleanup (2-3 days)
- [ ] Remove 0x01, 0x02, 0x03 parsers from IMUParser.ts
- [ ] Remove dead code paths in Gateway callback
- [ ] Update BLEParsing.test.ts to only expect 0x23/0x24/0x04/0x05
- [ ] Run full test suite

### Phase 3: Packet Format V3 (3-5 days)
- [ ] Define TDMADataPacketV3 structure
- [ ] Implement Gateway-side delta encoding
- [ ] Implement WebApp V3 decoder
- [ ] Add format negotiation (V2 fallback)
- [ ] Update CRC to cover new format

### Phase 4: Node-Side Compression (5-7 days)
- [ ] Port delta encoding to Node firmware
- [ ] Test with single node
- [ ] Roll out to all nodes
- [ ] Verify ESP-NOW bandwidth reduction

### Phase 5: Validation & Tuning (2-3 days)
- [ ] Run full-system stress tests
- [ ] Verify no data corruption
- [ ] Tune keyframe frequency
- [ ] Measure actual bandwidth savings
- [ ] Document final performance metrics

---

## 8. Validation Criteria

### 8.1 Success Metrics

| Metric | Current | Target | Validation Method |
|--------|---------|--------|-------------------|
| BLE throughput | 60 KB/s | 120+ KB/s | Gateway logging |
| Packet size (6 sensors × 2 samples) | 316 B | <250 B | Wireshark |
| Delta overflow rate | N/A | <1% | Node logging |
| End-to-end latency | ~25ms | <30ms | WebApp stats |
| Packet loss rate | ~2-5% | <1% | CRC tracking |
| CPU usage (Gateway) | 40% | <50% | FreeRTOS stats |

### 8.2 Regression Tests

- [ ] All existing unit tests pass
- [ ] BLEParsing.test.ts updated and passing
- [ ] virtual_stress.test.ts passing with V3 packets
- [ ] No visual glitches in 3D avatar rendering
- [ ] Calibration flow still works
- [ ] OTA update still works
- [ ] Multi-node (8 nodes) stress test passes

### 8.3 Rollback Plan

If issues arise:
1. Gateway can send V2 format (set flag in config)
2. WebApp parser supports V1, V2, V3 (auto-detect)
3. Node firmware unchanged until Phase 4 validated
4. Feature flags in both firmware and WebApp

---

## 📎 Appendix A: File Change Summary

### Firmware Changes

| File | Changes |
|------|---------|
| `TDMAProtocol.h` | Add V3 structures, delta structures |
| `MASH_Gateway.ino` | Add delta encoder, stats logging |
| `BLEManager.cpp` | Force 2M PHY, set connection params |
| `SyncManager.cpp` (Node) | Add delta stats, optional delta encode |

### WebApp Changes

| File | Changes |
|------|---------|
| `IMUParser.ts` | Remove legacy parsers, add V3 parser, add delta decoder |
| `CustomESP32Device.ts` | Update packet type handling |
| `BLEParsing.test.ts` | Update expected packet types |
| `DeviceInterface.ts` | Add V3 packet interface |
| `components/DiagnosticsPanel.tsx` | New stats display |

---

## 📎 Appendix B: Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Delta overflow storm | Low | Medium | Adaptive keyframe insertion |
| BLE 2M PHY not supported | Low | Low | Fallback to 1M PHY |
| WebApp state desync | Medium | High | Periodic keyframes, CRC validation |
| Performance regression | Low | Medium | Extensive benchmarking |
| Breaking existing recordings | Medium | Low | Version field in packets |

---

**Next Action:** Proceed with Phase 0 (Instrumentation) to gather real-world delta distribution data before implementing compression.
