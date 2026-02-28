# Research-Grade Time Synchronization Architecture

## Executive Summary

After comprehensive audit of the current IMU Connect data pipeline, **the system has fundamental architectural flaws** that prevent achieving research-grade temporal accuracy. The current one-way synchronization protocol, absence of clock drift compensation, and loose coupling between firmware and webapp time domains introduce **±0.5-2.0ms inter-sensor timing errors** — unacceptable for biomechanics research where <100µs is required.

This document proposes a **complete architectural redesign** to achieve <50µs inter-sensor synchronization.

---

## Part 1: Current Architecture Problems

### 1.1 Critical Flaw: One-Way Time Sync (No RTT Measurement)

**Location:** `firmware/MASH_Node/SyncManager.cpp:handleTDMABeacon()`

```cpp
// CURRENT (BROKEN):
int32_t newOffset = beacon->gatewayTimeUs - localTime;
// This assumes INSTANT transmission — but ESP-NOW takes 200-800µs!
```

**Impact:**
- Every Node has a **systematic bias** equal to one-way transmission delay
- This bias is **consistent within a Node** but **variable between Nodes**
- Result: **±300-800µs inter-sensor error** (before any drift)

**Why It Matters:**
- At 200Hz sampling, 800µs error = 16% of one sample period (5ms)
- During fast movements (gait, sports), this causes visible phase misalignment
- Calculated joint angles become unreliable

### 1.2 Critical Flaw: No Clock Drift Estimation

**Current:** Only offset correction via exponential smoothing (α=0.1)

```cpp
smoothedOffset = (int32_t)(0.1 * newOffset + 0.9 * smoothedOffset);
```

**Problem:** ESP32 crystals have ±40ppm tolerance:
- 40ppm = 40µs error per second of free-running time
- If 5 beacons are missed (100ms), drift = 4µs
- If 50 beacons missed (1 second), drift = 40µs
- **No prediction between beacons** — drift accumulates silently

### 1.3 High-Severity Flaw: Exponential Smoothing Lag

With α=0.1, time constant τ = 1/α = 10 beacons
- 63% convergence: 10 beacons × 20ms = 200ms
- 95% convergence: 30 beacons × 20ms = **600ms**

**Impact:** After any sync disruption (RF interference, channel switch, power state change), timestamps are **incorrect for 600ms+**.

### 1.4 Medium-Severity Flaw: 32-bit Timestamp Wraparound

`timestampUs` is `uint32_t`: wraps at 2³² µs = **71.6 minutes**

**Impact:** Recording sessions >70 minutes will have **discontinuous timestamps** with no recovery mechanism.

### 1.5 Medium-Severity Flaw: Mixed Time Domains in Webapp

**Location:** `imu-connect/src/lib/stores/recordingStore.ts`

```typescript
// Falls back to browser time if firmware timestamp unavailable
const hwTimestamp = packet.timestampUs ?? packet.timestamp;
// packet.timestamp is Date.now() — DIFFERENT TIME DOMAIN!
```

**Impact:** Any dropped packets or parsing errors inject browser time into firmware-synchronized recordings, corrupting temporal alignment.

### 1.6 Missing: Per-Sample Sync Quality Metadata

The `SyncQuality` enum exists but is **never transmitted**:

```cpp
enum SyncQuality : uint8_t {
  SYNC_QUALITY_NONE = 0,
  SYNC_QUALITY_POOR = 1,
  SYNC_QUALITY_OK = 2,
  SYNC_QUALITY_GOOD = 4,
  SYNC_QUALITY_EXCELLENT = 7
};
```

**Impact:** Webapp cannot distinguish:
- Data captured during stable sync
- Data captured during sync recovery
- Data captured with stale offset

Research pipelines need this to flag/exclude questionable data.

---

## Part 2: Proposed Architecture — "Precision Timing Protocol" (PTP-Lite)

### 2.1 Design Goals

| Metric | Current | Target |
|--------|---------|--------|
| Inter-sensor sync error | ±0.5-2.0ms | **<50µs** |
| Timestamp wraparound | 71 minutes | **>24 hours** |
| Sync recovery time | 600ms+ | **<100ms** |
| Quality visibility | None | **Per-sample quality flag** |

### 2.2 Core Innovation: Two-Way Time Sync with RTT Measurement

Inspired by IEEE 1588 PTP (Precision Time Protocol), but optimized for ESP-NOW.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                    TWO-WAY TIME SYNC PROTOCOL                                  │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  T1 ────────────────────────────────────────────────────────────────────────►  │
│  │     Gateway sends Beacon                                                    │
│  │     [type=0x20, frameNumber, T1=gatewayTimeUs, reqSync=nodeId]             │
│  │                                                                             │
│  │                   ┌───────────────────────────────────┐                    │
│  │                   │  Node receives at T2 (local time) │                    │
│  │                   │  Node records T2 internally       │                    │
│  │                   └───────────────────────────────────┘                    │
│  │                                                                             │
│  T2 ◄──────────────────────────────────────────────────────────────────────── │
│  │     Node sends Sync Response (in its TDMA slot)                            │
│  │     [type=0x25, nodeId, T1_echo, T2, T3=sendTime]                          │
│  │                                                                             │
│  │                   ┌───────────────────────────────────┐                    │
│  │                   │  Gateway receives at T4          │                    │
│  │                   │  Gateway computes:                │                    │
│  │                   │   RTT = (T4-T1) - (T3-T2)        │                    │
│  │                   │   OneWayDelay = RTT / 2           │                    │
│  │                   │   NodeOffset = T2 - (T1 + OWD)   │                    │
│  │                   └───────────────────────────────────┘                    │
│  T4                                                                            │
│                                                                                │
│  Gateway sends Offset Correction to Node:                                      │
│  [type=0x26, nodeId, correctedOffset, syncQuality]                            │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Benefits:**
- Eliminates systematic one-way delay error
- Provides actual measured sync quality per Node
- Gateway has authoritative offset for each Node

### 2.3 New Packet Types

```cpp
// Sync Response (Node → Gateway) — NEW
#define TDMA_PACKET_SYNC_RESPONSE 0x25

struct __attribute__((packed)) TDMASyncResponsePacket {
  uint8_t type;           // 0x25
  uint8_t nodeId;         // Responding node
  uint32_t T1_echo;       // Echoed gatewayTimeUs from beacon
  uint32_t T2;            // Node's local time when beacon received
  uint32_t T3;            // Node's local time when this response sent
  uint16_t driftPpm;      // Measured clock drift (±32767 ppm)
  uint8_t syncQuality;    // Node's self-assessed quality
};

// Offset Correction (Gateway → Node) — NEW
#define TDMA_PACKET_OFFSET_CORRECTION 0x26

struct __attribute__((packed)) TDMAOffsetCorrectionPacket {
  uint8_t type;             // 0x26
  uint8_t nodeId;           // Target node
  int32_t correctedOffset;  // Authoritative offset (Gateway's calculation)
  uint16_t measuredRtt;     // RTT in microseconds (for Node diagnostics)
  uint8_t syncQuality;      // Gateway's assessment (0-7 scale)
};
```

### 2.4 Clock Drift Estimation and Prediction

Each Node maintains a drift estimator:

```cpp
class DriftEstimator {
  // Circular buffer of (timestamp, offset) pairs
  static const int HISTORY_SIZE = 10;
  struct Sample {
    uint32_t timestamp;  // millis()
    int32_t offset;      // Measured offset at that time
  };
  Sample history[HISTORY_SIZE];
  int historyIndex = 0;
  int historyCount = 0;
  
  // Linear regression output
  float driftRatePpm = 0.0f;  // Parts per million
  
public:
  void addSample(uint32_t timestamp, int32_t offset) {
    history[historyIndex] = {timestamp, offset};
    historyIndex = (historyIndex + 1) % HISTORY_SIZE;
    if (historyCount < HISTORY_SIZE) historyCount++;
    
    // Compute drift rate via linear regression
    if (historyCount >= 3) {
      computeDriftRate();
    }
  }
  
  // Predict offset at future time (for inter-beacon interpolation)
  int32_t predictOffset(uint32_t futureTimestamp, int32_t lastKnownOffset, 
                        uint32_t lastKnownTimestamp) const {
    int32_t elapsed = futureTimestamp - lastKnownTimestamp;
    int32_t driftCorrection = (int32_t)(elapsed * driftRatePpm / 1000000.0f);
    return lastKnownOffset + driftCorrection;
  }
  
private:
  void computeDriftRate() {
    // Simple linear regression: offset = a + b*time
    // driftRatePpm = b * 1000000
    // (Implementation: least squares fit)
  }
};
```

### 2.5 Adaptive Smoothing Factor

Replace fixed α=0.1 with adaptive smoothing:

```cpp
float computeAdaptiveSmoothingFactor(int32_t offsetDelta, 
                                      uint32_t beaconsSinceSync,
                                      bool inRecovery) {
  // After initial sync or recovery: aggressive update
  if (beaconsSinceSync < 5 || inRecovery) {
    return 0.5f;  // Fast convergence
  }
  
  // If offset jumped significantly, trust new measurement more
  if (abs(offsetDelta) > 500) {  // >500µs jump
    return 0.3f;  // Medium convergence
  }
  
  // Stable operation: smooth heavily to filter noise
  return 0.05f;  // Slow convergence, low jitter
}
```

### 2.6 Extended Timestamps (64-bit or Wraparound Counter)

**Option A: 48-bit Timestamps (Recommended)**

Add `uint16_t timestampHigh` to packet header:

```cpp
struct __attribute__((packed)) TDMADataPacketV2 {
  uint8_t type;           // 0x23
  uint8_t nodeId;
  uint32_t frameNumber;
  uint8_t sampleCount;
  uint8_t sensorCount;
  uint16_t timestampHigh; // Upper 16 bits of 48-bit timestamp
  // ... data follows
};

// Full timestamp = (timestampHigh << 32) | sample.timestampUs
// 48-bit @ 1µs = 281,474,976 seconds = ~8.9 years
```

**Option B: Wrap Counter**

Include wrap counter in beacon:

```cpp
struct TDMABeaconPacketV2 {
  // ... existing fields ...
  uint8_t wrapCounter;  // Increments every 71.6 minutes
};
```

### 2.7 Per-Sample Sync Quality in Data Packets

Modify `TDMABatchedSensorData` to include quality:

```cpp
struct __attribute__((packed)) TDMABatchedSensorDataV2 {
  uint8_t sensorId;
  uint32_t timestampUs;
  int16_t q[4];
  int16_t a[3];
  int16_t g[3];
  uint8_t syncQuality;  // NEW: 0=NONE, 1=POOR, 2=OK, 4=GOOD, 7=EXCELLENT
};
// 26 bytes (was 25)
```

Quality criteria:
- **EXCELLENT (7):** RTT measured within last 200ms, RTT < 500µs, drift < 10ppm
- **GOOD (4):** RTT measured within last 1s, drift < 20ppm
- **OK (2):** Using extrapolated offset (no recent RTT), drift < 40ppm
- **POOR (1):** Beacon received but no RTT data, using smoothed offset
- **NONE (0):** No beacon for >1s, using dead-reckoning only

---

## Part 3: Webapp-Side Data Pipeline Redesign

### 3.1 Unified Time Domain

**Principle:** ALL timestamps MUST be in firmware time domain. Browser time is NEVER mixed.

```typescript
// NEW: RecordedFrame interface
interface RecordedFrame {
  firmwareTimestampUs: bigint;  // 64-bit, firmware domain ONLY
  frameNumber: number;           // TDMA frame number
  syncQuality: SyncQuality;      // Per-frame quality flag
  sensors: Map<number, SensorSample>;
  
  // Computed fields (not stored)
  get relativeTimeSec(): number {
    return Number(this.firmwareTimestampUs - sessionStartUs) / 1_000_000;
  }
}

// NEVER do this:
// timestampUs: packet.timestampUs ?? Date.now() * 1000  // FORBIDDEN
```

### 3.2 Frame-Based Alignment (Not Time-Based)

Current approach tries to align by timestamp matching. This fails when clocks drift.

**New Approach:** Align by TDMA frame number (authoritative sequence):

```typescript
class FrameAligner {
  private frames: Map<number, AlignedFrame> = new Map();
  
  ingestPacket(packet: TDMADataPacket): void {
    const frameNum = packet.frameNumber;
    
    if (!this.frames.has(frameNum)) {
      this.frames.set(frameNum, {
        frameNumber: frameNum,
        baseTimestampUs: packet.timestampUs,
        sensors: new Map(),
        complete: false,
        syncQuality: SyncQuality.NONE,
      });
    }
    
    const frame = this.frames.get(frameNum)!;
    
    // Add sensor data to this frame
    for (const sample of packet.samples) {
      frame.sensors.set(sample.sensorId, sample);
      // Track lowest (best) sync quality for the frame
      frame.syncQuality = Math.min(frame.syncQuality, sample.syncQuality);
    }
    
    // Check if frame is complete (all expected sensors present)
    if (frame.sensors.size >= this.expectedSensorCount) {
      frame.complete = true;
      this.emitCompleteFrame(frame);
    }
  }
}
```

### 3.3 Gap Detection and Interpolation

```typescript
class GapDetector {
  private lastFrameNumber: number = -1;
  
  checkFrame(frame: AlignedFrame): GapReport {
    if (this.lastFrameNumber === -1) {
      this.lastFrameNumber = frame.frameNumber;
      return { hasGap: false, missingFrames: 0 };
    }
    
    const expectedNext = this.lastFrameNumber + 1;
    const gap = frame.frameNumber - expectedNext;
    
    this.lastFrameNumber = frame.frameNumber;
    
    if (gap > 0) {
      return {
        hasGap: true,
        missingFrames: gap,
        missingRange: [expectedNext, frame.frameNumber - 1],
      };
    }
    
    return { hasGap: false, missingFrames: 0 };
  }
}

// Interpolation for missing frames (optional, configurable)
class FrameInterpolator {
  interpolate(before: AlignedFrame, after: AlignedFrame, 
              targetFrame: number): AlignedFrame {
    const t = (targetFrame - before.frameNumber) / 
              (after.frameNumber - before.frameNumber);
    
    const interpolated: AlignedFrame = {
      frameNumber: targetFrame,
      baseTimestampUs: this.lerpBigInt(before.baseTimestampUs, 
                                        after.baseTimestampUs, t),
      sensors: new Map(),
      complete: true,
      syncQuality: SyncQuality.INTERPOLATED, // Special flag
    };
    
    // Interpolate each sensor's quaternion via SLERP
    for (const [sensorId, beforeSample] of before.sensors) {
      const afterSample = after.sensors.get(sensorId);
      if (afterSample) {
        interpolated.sensors.set(sensorId, {
          sensorId,
          quaternion: this.slerp(beforeSample.quaternion, 
                                  afterSample.quaternion, t),
          accel: this.lerp3(beforeSample.accel, afterSample.accel, t),
          gyro: this.lerp3(beforeSample.gyro, afterSample.gyro, t),
          syncQuality: SyncQuality.INTERPOLATED,
        });
      }
    }
    
    return interpolated;
  }
}
```

### 3.4 Data Quality Metrics Store

```typescript
interface SessionQualityMetrics {
  totalFrames: number;
  completeFrames: number;           // All sensors present
  incompleteFrames: number;         // Some sensors missing
  droppedFrames: number;            // Detected gaps
  interpolatedFrames: number;       // Filled via interpolation
  
  syncQualityDistribution: {
    excellent: number;  // 7
    good: number;       // 4
    ok: number;         // 2
    poor: number;       // 1
    none: number;       // 0
  };
  
  maxConsecutiveGap: number;        // Longest gap in frames
  meanSyncQuality: number;          // 0.0-7.0 scale
  
  // Per-sensor metrics
  sensorMetrics: Map<number, {
    sampleCount: number;
    dropRate: number;               // 0.0-1.0
    meanSyncQuality: number;
  }>;
}
```

---

## Part 4: Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

1. **Extended Timestamps**
   - Add `timestampHigh` to `TDMADataPacket`
   - Update parser to reconstruct 48-bit timestamps
   - Test with 2+ hour recordings

2. **Sync Quality Transmission**
   - Add `syncQuality` field to `TDMABatchedSensorData`
   - Node computes quality based on beacon age and offset stability
   - Webapp stores and displays per-sample quality

3. **Webapp Time Domain Enforcement**
   - Remove all `Date.now()` fallbacks
   - Add strict validation that rejects mixed time domains
   - Update recording store to use `bigint` timestamps

### Phase 2: Two-Way Sync Protocol (Week 3-4)

4. **Sync Response Packet**
   - Define `TDMASyncResponsePacket` (0x25)
   - Node sends response during TDMA slot (round-robin selection)
   - Gateway receives and processes response

5. **RTT Measurement and Offset Correction**
   - Gateway computes RTT for each Node
   - Gateway sends `TDMAOffsetCorrectionPacket` (0x26)
   - Node applies corrected offset

6. **Testing: Inter-Node Sync Verification**
   - Create test harness with reference clock
   - Measure actual inter-sensor timing
   - Target: <50µs verified via oscilloscope

### Phase 3: Drift Compensation (Week 5-6)

7. **Drift Estimator**
   - Implement linear regression drift calculator
   - Add inter-beacon prediction
   - Test with intentionally-drifted crystals

8. **Adaptive Smoothing**
   - Replace fixed α=0.1 with adaptive algorithm
   - Test recovery scenarios (RF interference, channel switch)
   - Target: <100ms sync recovery time

### Phase 4: Data Pipeline Hardening (Week 7-8)

9. **Frame-Based Alignment**
   - Replace time-based alignment with frame-number alignment
   - Implement gap detection
   - Add optional interpolation

10. **Quality Metrics Dashboard**
    - Build real-time quality metrics view
    - Add session quality summary in exports
    - Integrate with research data formats (C3D, HDF5)

---

## Part 5: Risk Analysis

### High Risk
- **ESP-NOW Asymmetric Delays:** If TX and RX delays differ significantly, RTT/2 assumption fails. Mitigation: Empirical calibration per Node type.

### Medium Risk
- **Beacon Collision During Sync Response:** If multiple Nodes respond simultaneously, responses collide. Mitigation: Round-robin selection based on frame number modulo.

### Low Risk
- **Increased Packet Overhead:** New fields add ~3 bytes/packet. At 50Hz with 4 sensors, this is negligible.

---

## Part 6: Validation Criteria

### Research-Grade Certification

The system achieves "Research-Grade" status when:

1. **Inter-sensor sync error < 100µs** (95th percentile)
   - Measured via oscilloscope on GPIO toggle at sample time
   - Verified across 3+ Nodes simultaneously

2. **No timestamp discontinuities** in sessions up to 8 hours

3. **Sync recovery < 100ms** after:
   - RF interference (tested with jammer)
   - Channel switch
   - Node power cycle

4. **Zero mixed time domain errors** in exported data

5. **Per-sample sync quality** available in all exports

6. **Gap rate < 0.1%** under normal operating conditions

---

## Appendix A: Current vs. Proposed Packet Comparison

| Packet | Current Size | Proposed Size | Change |
|--------|--------------|---------------|--------|
| Beacon | 12 bytes | 14 bytes | +2 (wrap counter + reserved) |
| Data Header | 8 bytes | 10 bytes | +2 (timestampHigh) |
| Sensor Sample | 25 bytes | 26 bytes | +1 (syncQuality) |
| Sync Response | N/A | 14 bytes | NEW |
| Offset Correction | N/A | 10 bytes | NEW |

### Bandwidth Impact

At 50Hz with 4 sensors:
- Current: 8 + (4 × 25) + 1 = 109 bytes/frame → 5,450 bytes/sec
- Proposed: 10 + (4 × 26) + 1 = 115 bytes/frame → 5,750 bytes/sec
- **Increase: ~5.5%** (negligible vs. 1470-byte ESP-NOW limit)

---

## Appendix B: Migration Strategy

### Backward Compatibility

1. New Nodes send `TDMASyncResponsePacket` only when Gateway version supports it
2. Old Gateways ignore unknown packet types (0x25, 0x26)
3. Webapp checks for `syncQuality` field; defaults to UNKNOWN if absent
4. Version handshake in beacon `flags` field indicates protocol version

### Rollout Sequence

1. Deploy webapp changes first (tolerant of old/new firmware)
2. Update Gateway firmware (enables two-way sync)
3. Update Node firmware (enables drift compensation)
4. Enable per-sample quality in exports

---

## Appendix C: Alternative Approaches Considered

### C.1 Hardware PPS (Pulse-Per-Second) Sync

**Description:** Use GPIO pin for hardware-level synchronization pulse.

**Pros:**
- Nanosecond-level accuracy possible
- No protocol overhead

**Cons:**
- Requires wired connection between Gateway and all Nodes
- Not practical for wearable IMU systems
- **Rejected:** Incompatible with wireless architecture

### C.2 GPS Time Reference

**Description:** Each Node has GPS module for absolute time.

**Pros:**
- UTC-aligned timestamps
- No gateway dependency

**Cons:**
- GPS modules add cost, size, power consumption
- Poor indoor reception
- **Rejected:** Too expensive and impractical for body-worn sensors

### C.3 NTP-Style Sync (4-Message Exchange)

**Description:** Full IEEE 1588-style 4-message sync (Sync, Follow-up, Delay-Request, Delay-Response).

**Pros:**
- Most accurate software-only approach
- Well-documented algorithm

**Cons:**
- 4 messages per sync cycle is expensive at 50Hz
- Increases TDMA slot complexity
- **Partially adopted:** Our PTP-Lite uses 2-message exchange, sufficient for <100µs accuracy

### C.4 Broadcast Sync with Statistical Filtering

**Description:** Keep one-way sync but use statistical analysis to correct bias.

**Pros:**
- Minimal protocol changes
- Backward compatible

**Cons:**
- Cannot eliminate systematic bias without RTT measurement
- Post-hoc correction is unreliable
- **Rejected:** Fundamental limitation of one-way sync

---

## Appendix D: Reference Materials

1. **IEEE 1588-2019** - Precision Time Protocol standard
2. **ESP-NOW Programming Guide** - Espressif documentation
3. **Crystal Oscillator Aging and Stability** - Application Note AN-1002
4. **Biomechanics Data Standards** - ISB/C3D file format specifications
5. **Vicon System Timing Specifications** - Reference for gold-standard accuracy

---

## Conclusion

The current architecture cannot achieve research-grade timing. The proposed "PTP-Lite" protocol fundamentally changes how synchronization works:

- **Two-way measurement** eliminates systematic bias
- **Drift estimation** maintains accuracy between beacons
- **Quality metadata** enables post-hoc data filtering
- **Frame-based alignment** provides deterministic sensor alignment

Implementation requires significant firmware changes but is essential for any serious biomechanics, sports science, or clinical research application.

**Estimated effort:** 6-8 weeks for full implementation and validation.

**Alternative:** Accept current ±2ms accuracy and document as "consumer-grade" motion capture. This is **NOT recommended** for research applications.

---

*Document Version: 2.0*  
*Last Updated: February 2, 2026*  
*Author: System Architecture Analysis*
