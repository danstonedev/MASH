# Expert Review Final Synthesis: Research-Grade Time Synchronization

## Executive Summary

Five expert perspectives have analyzed the proposed time synchronization architecture for the IMU Connect system. This document synthesizes their findings into a prioritized, actionable implementation plan.

### Critical Consensus Findings

| Finding | Source | Impact | Priority |
|---------|--------|--------|----------|
| **One-way sync is fundamentally flawed** | All experts | Fatal | P0 |
| **No hardware timestamping = 50-500µs jitter** | Network, Real-time | Critical | P0 |
| **No drift estimation = unbounded error accumulation** | Signal Processing | Critical | P0 |
| **Exponential smoothing too slow (600ms to converge)** | Real-time, Signal | High | P1 |
| **<50µs target is unrealistic for ESP32** | Biomechanics, Network | Medium | P2 |

### Revised Accuracy Specification

Based on expert consensus:

| Metric | Original Target | **Revised Target** | Achievable? |
|--------|----------------|-------------------|-------------|
| Inter-sensor sync | <50µs | **<500µs typical, <100µs best-case** | ✅ Yes |
| Sync convergence | Not specified | **<100ms to 95%** | ✅ Yes |
| Drift tracking | None | **±2ppm accuracy** | ✅ Yes |
| Time since last sync | Not specified | **<5 seconds** | ✅ Yes |

### Application Suitability

| Application | <100µs (Best) | <500µs (Typical) | <2ms (Degraded) |
|-------------|---------------|------------------|-----------------|
| Clinical gait analysis | ✅ | ✅ | ✅ |
| Rehabilitation assessment | ✅ | ✅ | ✅ |
| Posture/balance monitoring | ✅ | ✅ | ✅ |
| Ergonomics evaluation | ✅ | ✅ | ✅ |
| Sprint biomechanics | ✅ | ⚠️ | ❌ |
| Throwing/impact analysis | ✅ | ❌ | ❌ |

**Honest positioning:** This system is **research-viable for clinical and rehabilitation applications**, not high-speed sports analysis.

---

## Expert Review Summary

### 1. Embedded Systems Expert (ESP Timer Analysis)

**Key Findings:**
- ESP32 `gptimer` provides 1µs resolution, 64-bit counter, ISR dispatch capability
- Hardware timers can achieve <1µs timestamp jitter at ISR level
- TSF (Timing Synchronization Function) timestamp available via `esp_wifi_get_tsf_time()`

**Recommendations:**
- Use hardware timer with ISR-level callback for sync timestamps
- Leverage TSF for MAC-layer timing (already synchronized by Wi-Fi subsystem)
- 64-bit timestamps prevent wraparound issues

### 2. Network Protocol Expert

**Critical Flaws Identified:**

1. **RTT/2 assumption is problematic**
   - ESP-NOW has asymmetric delays (TX processing ≠ RX processing)
   - Wi-Fi channel conditions create variable propagation
   - Error: ±50-200µs from asymmetry alone

2. **Missing hardware timestamping**
   - Software timestamps have 50-200µs jitter from:
     - Wi-Fi task callback delay
     - FreeRTOS scheduling
     - ISR latency
   
3. **Missing skew (drift) compensation**
   - Offset-only correction requires continuous sync exchanges
   - 20ppm drift = 20µs/sec accumulating error
   - **Fatal flaw** - without drift tracking, sync degrades rapidly

**Recommended Protocol Enhancement:**

```
PTP-Lite v2 Protocol:
1. Beacon includes gateway TSF timestamp (hardware-level)
2. Node captures local TSF on reception
3. Node sends DELAY_REQ with its TSF
4. Gateway responds with DELAY_RESP including both timestamps
5. Node computes: offset = ((T2-T1) + (T3-T4))/2, RTT = (T4-T1) - (T3-T2)
6. Kalman filter tracks offset + drift rate
```

**Achievable Accuracy:** ~±24µs RSS (with hardware timestamps + drift compensation)

### 3. Biomechanics Research Expert

**Timing Requirements Validated:**

| Application | Frequency Range | Required Sync | This System |
|-------------|----------------|---------------|-------------|
| Walking gait | 0.8-2 Hz | <2ms | ✅ Exceeds |
| Running gait | 2-4 Hz | <1ms | ✅ Exceeds |
| Balance/posture | 0.1-1 Hz | <5ms | ✅ Exceeds |
| Throwing mechanics | 10-50 Hz | <100µs | ⚠️ Marginal |
| Impact events | >100 Hz | <50µs | ❌ Not achievable |

**Critical Insight:** The system's realistic <500µs sync is **excellent for 95% of clinical research applications**.

**Recommendations:**
- Market as "clinical-grade" not "research-grade" to set appropriate expectations
- Document supported vs unsupported applications clearly
- Provide sync quality metadata so researchers can filter data appropriately

### 4. Real-Time Systems Expert

**Jitter Budget Analysis:**

| Source | Current | Achievable | Method |
|--------|---------|------------|--------|
| Timestamp capture | ±200-500µs | ±10-20µs | ISR-level hardware timer |
| FreeRTOS scheduling | ±100-300µs | ±5-10µs | Core pinning, priority tuning |
| ESP-NOW TX variability | ±50-200µs | ±30-50µs | TSF timestamps |
| Smoothing response | 500-2000ms lag | ±50-100µs | Kalman filter |
| **Total RSS** | **±600-2300µs** | **±60-110µs** | - |

**Critical Issues:**
1. ESP-NOW callback runs in Wi-Fi task context (priority 23), not ISR
2. Sensor task (priority ~5) gets preempted during I²C reads
3. With 9 sensors at 400kHz I²C, worst-case read = 6.2ms > 5ms period!

**Recommendations:**
1. **Core isolation:** Pin sensor task to Core 1, protocol to Core 0
2. **Raise sensor priority to 24** (above Wi-Fi task)
3. **Use ICM20649 FIFO mode** or stagger reads
4. **Hardware timer for timestamping** with ISR-level capture

### 5. Signal Processing Expert

**Algorithm Recommendation: Two-State Kalman Filter**

Why Kalman over Linear Regression:
- Optimal for linear Gaussian systems (clock drift is linear + noise)
- Provides uncertainty estimates (critical for confidence flagging)
- Recursive: O(1) per update vs O(N) for regression
- Naturally handles varying measurement quality

**State Model:**
```
State: [θ (offset), θ̇ (drift)]
Measurement: RTT-derived offset
Process noise: Q = f(crystal jitter, drift wander)
Measurement noise: R = f(RTT variance)
```

**Outlier Detection:** MAD-based Modified Z-Score
- Threshold: |Z| > 3.5 for rejection
- Down-weight marginal measurements (2.5 < |Z| < 3.5)
- Asymmetric thresholds for RTT (high spikes more likely)

**Convergence Improvement:**
- Current exponential smoothing: 600ms to 95% convergence
- Kalman filter: **50-100ms to 95% convergence**

**Post-Processing Cross-Correlation:**
- Can achieve sub-sample alignment using IMU magnitude correlation
- Requires motion (walking/running) - doesn't work during static periods
- Expected improvement: ±2ms → ±200µs for suitable signals

---

## Prioritized Implementation Plan

### Phase 0: Foundation (Required for all improvements)

**Duration:** 1 week

1. **Add TSF timestamping to beacon protocol**
   - Gateway: Include `esp_wifi_get_tsf_time()` in beacon
   - Node: Capture local TSF on beacon reception
   - Impact: Eliminates 50-200µs software timestamp jitter

2. **Implement two-way sync handshake**
   - Add DELAY_REQ/DELAY_RESP message types to TDMAProtocol.h
   - Compute proper RTT and asymmetry-corrected offset
   - Impact: Eliminates one-way sync bias (±100-500µs improvement)

### Phase 1: Core Filter Replacement

**Duration:** 1-2 weeks

3. **Replace exponential smoothing with Kalman filter**
   - 2-state model: offset + drift
   - Adaptive measurement noise based on RTT variance
   - Impact: Convergence 600ms → 100ms, drift tracking enabled

4. **Add outlier detection**
   - MAD-based detection with sliding window
   - Weighted updates for marginal measurements
   - Impact: Robust to Wi-Fi interference, channel hopping

### Phase 2: Real-Time Improvements

**Duration:** 1 week

5. **Core pinning and priority optimization**
   - Sensor task → Core 1, priority 24
   - Protocol task → Core 0
   - Impact: ±100-300µs scheduling jitter → ±5-10µs

6. **Sensor FIFO mode**
   - Enable ICM20649 FIFO buffering
   - Batch-read at lower frequency
   - Impact: WCET compliance, reduced jitter

### Phase 3: Webapp Integration

**Duration:** 1 week

7. **Sync quality metadata propagation**
   - Add to TDMABatchedSensorData: offsetUncertainty, driftPpm, lastSyncAgeMs
   - Webapp displays sync quality indicators
   - Impact: User visibility, data filtering capability

8. **Unified timeline with quality zones**
   - Color-code recordings by sync confidence
   - Allow filtering by quality threshold
   - Impact: Research data integrity

### Phase 4: Post-Processing (Optional)

**Duration:** 2 weeks (parallel development)

9. **Cross-correlation alignment tool**
   - Offline analysis of recorded sessions
   - Uses IMU magnitude for sub-sample alignment
   - Impact: ±500µs → ±50µs for motion segments

---

## Protocol Specification Updates

### TDMAProtocol.h Additions

```cpp
// New message types
enum class TDMAMessageType : uint8_t {
    BEACON = 0x01,
    DATA = 0x02,
    REGISTRATION_REQUEST = 0x03,
    REGISTRATION_RESPONSE = 0x04,
    // NEW: Two-way sync messages
    DELAY_REQ = 0x10,       // Node → Gateway: Request RTT measurement
    DELAY_RESP = 0x11,      // Gateway → Node: Response with timestamps
    SYNC_STATUS = 0x12      // Node → Gateway: Report sync quality
};

// Enhanced beacon packet
struct TDMABeaconPacketV2 {
    TDMAMessageType type;
    uint8_t frameNumber;
    uint64_t gatewayTsfUs;      // TSF timestamp (was gatewayTimeUs)
    uint32_t framePeriodUs;
    uint8_t activeNodeMask;
    uint8_t channelSequence[4];
    // NEW: Sync protocol version
    uint8_t syncProtocolVersion;  // 0x02 for PTP-Lite v2
    uint8_t reserved[3];
} __attribute__((packed));

// DELAY_REQ packet (Node → Gateway)
struct TDMADelayReqPacket {
    TDMAMessageType type;
    uint8_t nodeId;
    uint64_t nodeTsfUs;        // T1: Node TSF when sending
    uint32_t sequenceNumber;   // For matching responses
} __attribute__((packed));

// DELAY_RESP packet (Gateway → Node)
struct TDMADelayRespPacket {
    TDMAMessageType type;
    uint8_t nodeId;
    uint32_t sequenceNumber;
    uint64_t nodeT1;           // Echo back T1
    uint64_t gatewayT2;        // T2: Gateway TSF on DELAY_REQ receipt
    uint64_t gatewayT3;        // T3: Gateway TSF when sending response
    // Computed by node: T4 = local TSF on receipt
    // offset = ((T2-T1) + (T3-T4)) / 2
    // RTT = (T4-T1) - (T3-T2)
} __attribute__((packed));

// Sync quality metadata (per-sample or per-batch)
struct SyncQualityFlags {
    uint16_t offsetUncertaintyUs;  // 1-sigma uncertainty
    int16_t driftPpm;              // Estimated drift rate × 10
    uint16_t lastSyncAgeMs;        // Time since last two-way sync
    uint8_t confidence : 2;        // 0=uncertain, 1=low, 2=medium, 3=high
    uint8_t reserved : 6;
} __attribute__((packed));
```

### Kalman Filter Implementation (Node-side)

```cpp
class ClockSyncKalman {
public:
    struct State {
        float offsetUs = 0;       // Clock offset in microseconds
        float driftPpm = 0;       // Drift rate in ppm (µs/s)
        float P[4] = {1e8, 0, 0, 2500};  // Covariance [P00, P01, P10, P11]
        uint64_t lastSyncTsfUs = 0;
        bool initialized = false;
    };
    
    struct Config {
        float processNoiseOffset = 100.0f;    // µs²/s
        float processNoiseDrift = 0.01f;      // ppm²/s
        float minMeasurementNoise = 10000.0f; // µs² (100µs std min)
        float outlierThreshold = 3.5f;
    };
    
    void predict(float dtSeconds);
    bool update(float measuredOffsetUs, float rttUs);
    
    float getOffset() const { return state.offsetUs; }
    float getDrift() const { return state.driftPpm; }
    float getUncertainty() const { return sqrtf(state.P[0]); }
    
    int64_t localToSyncedTime(uint64_t localTsfUs) const;
    
private:
    State state;
    Config config;
    
    // Outlier detection
    static constexpr int RTT_HISTORY_SIZE = 20;
    float rttHistory[RTT_HISTORY_SIZE];
    int rttHistoryIndex = 0;
    int rttHistoryCount = 0;
    
    bool isOutlier(float rttUs);
    float estimateMeasurementNoise();
};
```

---

## Risk Assessment

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| TSF not available in ESP-NOW mode | Low | High | Fall back to `gptimer` ISR timestamps |
| Kalman filter numerical instability | Medium | Medium | Use Joseph-form covariance update |
| FIFO mode incompatible with streaming | Low | Medium | Maintain parallel non-FIFO path |
| Cross-correlation fails on low activity | High | Low | Graceful fallback to clock-only sync |

### Schedule Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Firmware OTA update issues | Medium | High | Extensive testing, rollback capability |
| Webapp backward compatibility | Low | Medium | Version negotiation in protocol |
| Multi-node testing complexity | High | Medium | Automated test harness |

---

## Success Metrics

### Phase 1 Completion Criteria
- [ ] Two-way sync implemented and tested with 1 node
- [ ] Kalman filter tracking offset to within ±500µs
- [ ] Drift estimation within ±5ppm of actual
- [ ] Convergence time <200ms (vs 600ms baseline)

### Phase 2 Completion Criteria  
- [ ] 8-node simultaneous operation stable
- [ ] No TDMA slot overruns under load
- [ ] Sync quality metadata visible in webapp
- [ ] Jitter reduced to <100µs RSS

### Final Acceptance Criteria
- [ ] 1-hour recording session with <1% packets above 1ms sync error
- [ ] No observable sync drift during 10-minute static test
- [ ] Cross-correlation post-processing achieves <100µs on walking data
- [ ] Documentation complete for supported applications

---

## Appendix: Expert Recommendations Summary

### Unanimous Recommendations (All 5 Experts)
1. Replace one-way sync with two-way RTT measurement
2. Add drift estimation (some form of tracking filter)
3. Use hardware-level timestamps where possible

### Majority Recommendations (3+ Experts)
4. Kalman filter preferred over linear regression
5. Core pinning for deterministic scheduling
6. MAD-based outlier detection
7. Revise accuracy claims to <500µs typical

### Individual Expert Contributions
- **Embedded:** TSF timestamp API details, 64-bit timer configuration
- **Network:** PTP-Lite v2 protocol specification, asymmetry analysis
- **Biomechanics:** Application suitability matrix, marketing guidance
- **Real-time:** WCET analysis, priority tuning, FIFO mode recommendation
- **Signal Processing:** Complete Kalman filter implementation, cross-correlation algorithm

---

*Document generated from multi-expert review session*
*Total expert perspectives: 5*
*Consensus achieved: Yes*
*Recommended for implementation: Yes*
