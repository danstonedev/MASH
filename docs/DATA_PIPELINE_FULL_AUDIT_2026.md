# MASH Data Pipeline — Complete Audit & Edge Case Analysis

> **⚠️ PARTIALLY OUTDATED (March 2026):** TDMA protocol cleanup renamed `TDMANodeDeltaPacket` → `TDMANodeDataPacket`, `decodeNodeDelta()` → `decodeNodeData()`, removed `TDMADataPacket` (0x23), V3 structs, and delta compression code paths. All nodes now use `TDMA_PACKET_NODE_DATA` (0x26) exclusively with keyframe-only data. See `TDMAProtocol.h` for current definitions.

**Date**: 2026 Session  
**Scope**: ICM20649 sensor → SensorManager → SyncTransfer → ESP-NOW → Gateway callback → DataIngestionTask → SyncFrameBuffer → USB Serial → Webapp parser → Zustand stores → Rendering

## Resolution Status

All identified edge cases and simplification opportunities have been implemented:

| ID | Description | Status |
|----|-------------|--------|
| EC-1 | `sensorChannels[8]` hardcode | ✅ Fixed → `sensorChannels[MAX_SENSORS]` + IMUParser.ts updated |
| EC-2 | `registeredNodes[]` race condition | ✅ Fixed → portMUX spinlock added (7 sites) |
| EC-6 | SyncFrames bypass PAUSE/RESUME | ✅ Resolved by SIMP-1 (queue path respects pause) |
| EC-13 | `TDMA_MAX_SENSORS_PER_NODE=58` | ✅ Fixed → reduced to 4 |
| SIMP-1 | Unify serial writes to single queue | ✅ Done → `sendFramedPacketDirect` removed, SyncFrames via `enqueueSerialFrame` |
| SIMP-2 | Remove dead 0x23 handler | ✅ Done → ~115 lines removed from ESP-NOW callback + DataIngestionTask |
| SIMP-3 | Remove delta compression remnants | ✅ Done → delta decode path removed, dead params cleaned from `buildTDMAPacket` |
| SIMP-4 | Consolidate MAX_SENSORS definitions | ✅ Done (via EC-13) |
| SIMP-5 | Wrap verbose diagnostics | ✅ Done → `#if SYNC_DEBUG` (default 0) around 3 diagnostic blocks |
| SIMP-6 | Deprecate ESPNowDataPacket | ✅ Done → deprecation comment added (cross-project deps prevent removal) |
| SIMP-7 | Simplify buildAbsoluteFrame | ✅ Done → 3-branch logic consolidated to 2 (forceEmit + active-filter) |

---

## 1. Complete Data Pipeline Map

### Stage 1: Sensor Read (Node — Core 1, SensorTask)

**File**: `firmware/MASH_Node/SensorManager.cpp`

```
ICM20649 (I2C @ 0x68/0x69 on Wire/Wire1)
  ↓  readSensorData() — raw accel/gyro in g units
  ↓  Phase 1: Batch read into rawFrames[] (burst I2C, all sensors)
  ↓  Phase 2: Process each sensor:
  ↓    1. Outlier rejection (>10g clamp, spike filter)
  ↓    2. Hardware mount transform: [-X, +Y, -Z]
  ↓    3. Convert accel g → m/s² (×9.81)
  ↓    4. Apply calibration offsets + scale
  ↓    5. Adaptive calibration learning (at rest)
  ↓  Store into sensorData[i] (IMUData struct)
  ↓    sensorData[i].sensorId = i (local 0-based index)
```

**Key arrays** (all sized `MAX_SENSORS = 4`):
- `ICM20649_Research sensors[4]` — I2C driver instances
- `IMUData sensorData[4]` — latest processed data
- `CalibrationData calibration[4]` — per-sensor cal data
- `int8_t sensorChannels[4]` — I2C address mapping

**Data format at this stage**: Floating-point IMUData (accel m/s², gyro rad/s, quaternion from DMP)

### Stage 2: TDMA Packet Building (Node — SyncTransfer.cpp)

**File**: `firmware/MASH_Node/SyncTransfer.cpp`

```
sensorData[0..N] (from SensorManager)
  ↓  sendTDMAData() — called at 50Hz (once per TDMA slot)
  ↓    1. Lock mutex, snapshot batchBuffer[4 samples][N sensors] (~50µs)
  ↓    2. Release mutex (SensorTask can continue reading sensors)
  ↓    3. buildTDMAPacket() — encode snapshot into binary
  ↓       Header (TDMANodeDeltaPacket): type=0x26, nodeId, frameNumber,
  ↓         sampleCount(4), sensorCount(N), flags=ALL_KEYFRAME
  ↓       Body: sampleCount × sensorCount × TDMABatchedSensorData (25 bytes each)
  ↓         [4-byte timestamp_us][int16 q[4]][int16 a[3]][int16 g[3]]
  ↓       Trailer: SyncQualityFlags (if PTP_V2) + CRC8
  ↓    4. ESP-NOW send (up to 1470 bytes)
```

**Quantization at this stage**:
- Quaternion: float → int16 × 16384
- Accel: float m/s² → int16 × 100
- Gyro: float rad/s → int16 × 900

**Packet size**: For 3 sensors × 4 samples = 10 header + (12 × 25) + 1 CRC = 311 bytes

### Stage 3: ESP-NOW Receive (Gateway — WiFi Callback, Core 0)

**File**: `firmware/MASH_Gateway/MASH_Gateway.ino` (lines 1154-1240)

```
ESP-NOW WiFi callback (high priority ~23)
  ↓  Detect packet type from byte[0]: 0x23 or 0x26
  ↓  updateNodeLastHeard(nodeId) — lightweight timestamp
  ↓  Copy raw bytes into EspNowRxPacket (1024 byte buffer)
  ↓  xQueueSend(espNowRxQueue) — non-blocking (drop if full)
  ↓  Total callback time: ~5µs
```

**Queue**: `espNowRxQueue` — 24 entries × 1026 bytes = ~24KB  
**Drop path**: If queue full → `espNowRxDropCount++` (silent loss)

### Stage 4: Data Ingestion (Gateway — Core 1, DataIngestionTask)

**File**: `firmware/MASH_Gateway/GatewayTasks.ino` (lines 470-650)

```
DataIngestionTask (xQueueReceive blocks with 10ms timeout)
  ↓  Read packet type byte
  ↓
  ├── 0x23 (Legacy Absolute, TDMADataPacket):
  │     Extract sensorCount, sampleCount, frameNumber, nodeId
  │     Detect V2 format (len > basic header + sampleCount × sensorCount × 25)
  │     Loop: for each sampleIdx × sensorIdx:
  │       compactId = syncManager.getCompactSensorId(nodeId, sensorIdx)
  │       syncFrameBuffer.addSample(compactId, nodeId, sensorIdx, ts, frameNum, q, a, g)
  │
  └── 0x26 (Node Delta, TDMANodeDeltaPacket) — PRIMARY PATH:
        decodeNodeDelta() → decodedSamples[4][MAX_SENSORS]
        Loop: for each sampleIdx × sensorIdx:
          compactId = syncManager.getCompactSensorId(nodeId, sensorIdx)
          syncFrameBuffer.addSample(compactId, nodeId, sensorIdx, ts, frameNum, q, a, g)
```

**Key**: `getCompactSensorId()` sorts registered nodes by nodeId, assigns sequential IDs starting at 1.  
Node 3 with 2 sensors → compact IDs 1, 2  
Node 43 with 3 sensors → compact IDs 3, 4, 5  
Node 190 with 1 sensor → compact ID 6  
...etc.

### Stage 5: Sync Frame Assembly (Gateway — SyncFrameBuffer.cpp)

**File**: `firmware/MASH_Gateway/SyncFrameBuffer.cpp`

```
addSample(compactSensorId, rawNodeId, localSensorIndex, timestampUs, ...)
  ↓  Discard during epoch settling (50ms after epoch change)
  ↓  Normalize timestamp: round to nearest 5ms boundary relative to sync epoch
  ↓  Validate sensorId against expectedSensorIds[] list
  ↓  findOrCreateSlot(normalizedTs) — find existing or allocate from 64-slot circular buffer
  ↓  Store sample in slot.sensors[sensorIndex] (with rawNodeId, localSensorIndex)
  ↓  Increment slot.sensorsPresent
  ↓
update() (called ~1ms from ProtocolTask)
  ↓  expireStaleSlots() — slots older than 55ms get forceEmit=true
  ↓  Recompute effectiveSensorCount every 1s (inactive = not seen for 2s)
  ↓
hasCompleteFrame() — slot.sensorsPresent >= effectiveSensorCount OR forceEmit
  ↓
getCompleteFrame() → buildAbsoluteFrame()
  ↓  Copy slot data under spinlock, release lock
  ↓  Build 0x25 packet:
  ↓    Header (10 bytes): type=0x25, frameNumber(u32), timestampUs(u32), sensorCount(u8)
  ↓    Per sensor (24 bytes): sensorId, q[4], a[3], g[3], flags, reserved[2]
  ↓      reserved[0] = rawNodeId (physical identity!)
  ↓      reserved[1] = localSensorIndex
  ↓    CRC-8 trailing byte
  ↓  Belt-and-suspenders: also raw-writes sensorCount at byte[9]
```

**Buffer**: 64 slots × 20 sensors × sizeof(SyncSensorSample) in PSRAM (~30KB)  
**Slot matching**: Timestamps within 2500µs tolerance are merged into same slot

### Stage 6: USB Serial Output (Gateway — ProtocolTask → sendFramedPacketDirect)

**File**: `firmware/MASH_Gateway/MASH_Gateway.ino` (lines 414-440) and `GatewayTasks.ino` (lines 770-780)

```
ProtocolTask (Core 0, 1ms wake cadence)
  ↓  syncFrameBuffer.update()
  ↓  while (hasCompleteFrame()):
  ↓    getCompleteFrame(syncFramePacket, 512)
  ↓    sendFramedPacketDirect(syncFramePacket, frameLen)
  ↓      Acquire serialWriteMutex
  ↓      Write 2-byte length prefix (little-endian)
  ↓      Write payload via writeUsbFifoDirect() (64-byte USB FIFO chunks, 30ms timeout)
  ↓      Release serialWriteMutex
```

**Transport**: USB CDC at 921600 baud (but USB Serial/JTAG is actually 12 Mbit/s native)  
**Wire format**: `[len_lo][len_hi][0x25 packet...]` — length-prefixed binary framing  
**IMPORTANT**: SyncFrames use `sendFramedPacketDirect` (bypasses SerialTxTask queue). JSON/command responses use `enqueueSerialFrame` → SerialTxTask queue. Both share `serialWriteMutex`.

### Stage 7: Webapp Serial Parsing (SerialConnection.ts → IMUParser.ts)

**File**: `mash-app/src/lib/connection/SerialConnection.ts`

```
Web Serial API (readable stream, 921600 baud)
  ↓  Ring buffer accumulation
  ↓  extractFrames(): read [len_lo][len_hi], extract len bytes
  ↓  pendingFrames[] queue
  ↓
processPendingFrames() (queueMicrotask, batched)
  ↓  Budget: 10ms per tick, max PARSE_MAX_FRAMES_PER_TICK
  ↓  IMUParser.parseSingleFrame(frame)
  ↓
dispatchParsedPackets()
  ↓  For each IMUDataPacket:
  ↓    deviceId = makeDeviceKey(rawNodeId, localSensorIndex)
  ↓      → "node_<rawNodeId>_s<localSensorIndex>"  (e.g., "node_43_s0")
  ↓    Append { deviceId, sourceGateway } to packet
  ↓  Call _onData(prefixedPackets) → ConnectionManager → useDeviceStore
```

**IMUParser 0x25 handling**:
1. Read header: frameNumber(u32), timestampUs(u32), sensorCount(u8)
2. Infer sensorCount from frame length (primary) — immune to byte[9] corruption
3. CRC-8 validation if `payload % 24 === 1`
4. For each sensor: validate quaternion magnitude ∈ [0.8, 1.2]
5. Extract rawNodeId from reserved[0], localSensorIndex from reserved[1]
6. Build IMUDataPacket with physical identity

### Stage 8: Webapp State Management (Zustand stores)

```
IMUDataPacket[] with deviceId
  ↓  useDeviceStore → latestPacketRef (non-reactive for 60Hz)
  ↓  useNetworkStore → per-node topology/health tracking
  ↓  useDeviceRegistry → sensor assignment + naming
  ↓  useRecordingStore → recording buffer
  ↓  VisualizationThrottler → 60fps UI updates
  ↓  3D rendering / chart panels
```

---

## 2. All Data Transformation Points

| Stage | Transform | Precision Loss? |
|-------|-----------|-----------------|
| ICM20649 → SensorManager | Raw 16-bit → float g → mount transform → m/s² → calibration | Minimal (float math) |
| SensorManager → TDMAPacket | Quat: float → int16 × 16384 | ±0.00003 per component |
| SensorManager → TDMAPacket | Accel: float m/s² → int16 × 100 | ±0.005 m/s² |
| SensorManager → TDMAPacket | Gyro: float rad/s → int16 × 900 | ±0.0006 rad/s |
| TDMAPacket → SyncFrame 0x25 | Direct memcpy of int16 values | None |
| SyncFrame → Webapp | int16/16384 → float, int16/100 → float, int16/900 → float | JavaScript float64 ≈ lossless |

---

## 3. Edge Cases & Failure Modes

### CRITICAL — Active Risks

#### EC-1: `ESPNowNodeInfoPacket.sensorChannels[8]` — Hardcoded Size Mismatch
- **File**: [SharedConfig.h](firmware/shared/SharedConfig.h) line 298
- **Issue**: `sensorChannels[8]` is hardcoded while `MAX_SENSORS = 4`. This is a **registration packet** struct — used when nodes register with the gateway.
- **Impact**: The array is larger than needed (wastes 4 bytes per registration packet), but not a buffer overflow because the array is within the struct. However, any code indexing into `sensorChannels[i]` with `i >= 4` is reading stale/zero data. The node writes at most `MAX_SENSORS` channels.
- **Risk**: LOW. No actual overflow, just dead bytes in registration packets.
- **Recommendation**: Change to `sensorChannels[MAX_SENSORS]` for consistency. Update firmware and webapp `parseNodeInfoPacket()` which hardcodes `for (let i = 0; i < 8; i++)`.

#### EC-2: Race Between Node Registration and Frame Assembly
- **Scenario**: A node re-registers (e.g., after dropout). `getCompactSensorId()` is called by DataIngestionTask on Core 1. `handleNodeRegistration()` modifies `registeredNodes[]` from the WiFi callback on Core 0. No lock protects `registeredNodes[]` during read by `getCompactSensorId()`.
- **Impact**: Torn read of `registeredNodes[i]` could produce wrong compact IDs for 1-2 frames. These would be rejected by SyncFrameBuffer (`Unknown sensor` warning) — NOT a crash, but a data gap.
- **Risk**: MEDIUM. Happens at every node drop/rejoin. The 50ms epoch settling period may mask most occurrences.
- **Recommendation**: Add a `portMUX_TYPE` spinlock protecting registeredNodes[] reads in `getCompactSensorId()` and writes in `handleNodeRegistration()`. OR accept the rare frame drop and document it.

#### EC-3: `sensorCount=0` Node → Compact Base Collision Prevention
- **Code**: `getCompactSensorId()` and `getExpectedSensorIds()` both use `effectiveCount = max(sensorCount, 1)`.
- **Issue**: S3-FIX correctly treats `sensorCount=0` as 1. But if a node registers with 0 sensors and then later reports data for sensor index 0, `getCompactSensorId()` returns a valid compact ID. If that node then discovers it actually has 2 sensors and starts sending data for index 1, `getCompactSensorId()` returns 0 (failure) because `localSensorIndex >= effectiveCount`. The node must RE-REGISTER with updated sensorCount.
- **Risk**: LOW. Sensor discovery happens before registration in current firmware flow. Only possible if a sensor comes online late (hardware failure recovery).

#### EC-4: Compact ID Instability During Topology Changes
- **Scenario**: Node 43 drops, all compact IDs after it shift up. Node 43 rejoins, IDs shift back. During the gap, the wrong compact IDs are mapped.
- **Current mitigation**: S2-FIX sorts by nodeId, so IDs are stable AS LONG AS the same set of nodes is registered. But during the dropout window, `getCompactSensorId()` produces different results for all subsequent nodes.
- **Impact**: SyncFrameBuffer gets `Unknown sensor` warnings. `setExpectedSensors()` is called with the new ID list. Any in-flight frames in old slots with old IDs get discarded.
- **Risk**: MEDIUM. Mitigated by rawNodeId/localSensorIndex physical identity in the webapp (makeDeviceKey doesn't use compact IDs). But the SyncFrameBuffer internally indexes by compact ID position, so a shift means data loss for 1-2 frames.
- **Recommendation**: This is fundamentally the right design. The rawNodeId/localSensorIndex physical identity in reserved bytes means the webapp handles it correctly. The 1-2 frame loss during re-registration is acceptable.

#### EC-5: SyncFrameBuffer Slot Exhaustion Under Heavy Jitter
- **Config**: 64 slots, 55ms timeout, 200Hz = new slot every 5ms.
- **Normal**: 64 × 5ms = 320ms of buffering. Slots complete in ~5-20ms and are recycled.
- **Worst case**: If sync is bad (multiple nodes producing different normalized timestamps), each sample creates a NEW slot. 6 nodes × 4 samples × unique timestamps = 24 new slots per TDMA cycle. At 50Hz, that's 24 slots every 20ms = 64 slots fill in ~53ms.
- **Impact**: `findOrCreateSlot` recycles oldest incomplete slot → `incompleteFrameCount++`. Data is lost.
- **Risk**: MEDIUM-LOW. The v10 epoch-relative rounding should prevent this in normal operation. Only happens if sync epoch is wrong or a node's clock drifts significantly.

#### EC-6: Serial Backpressure / USB CDC Stall
- **`sendFramedPacketDirect()`** calls `writeUsbFifoDirect()` which has a 30ms timeout and writes in 64-byte chunks. If the USB host (webapp) is slow to drain, `usb_serial_jtag_ll_txfifo_writable()` returns false.
- **Impact**: The 30ms timeout means a stalled USB could block ProtocolTask for 30ms, missing beacon timing (20ms period). Beacon jitter would degrade sync.
- **Risk**: MEDIUM. The webapp has PAUSE/RESUME flow control, but `sendFramedPacketDirect` does NOT check `serialTxPaused`. Only `enqueueSerialFrame` (for the SerialTxTask queue) would respect pause.
- **Recommendation**: Either (a) route SyncFrames through the SerialTxTask queue too (adds 2-5ms latency but respects flow control), or (b) add `serialTxPaused` check before `sendFramedPacketDirect()` in ProtocolTask.

### MODERATE — Defensive Concerns

#### EC-7: `decodeNodeDelta` Stack Allocation with MAX_SENSORS
- **Code** (GatewayTasks.ino, ~line 580): 
  ```cpp
  TDMABatchedSensorData decodedSamples[TDMA_SAMPLES_PER_FRAME][MAX_SENSORS];
  ```
- `TDMA_SAMPLES_PER_FRAME=4`, `MAX_SENSORS=4`, each 25 bytes = 400 bytes on stack.
- **Issue**: If a packet arrives claiming `sensorCount > MAX_SENSORS`, `decodeNodeDelta()` checks `sensorCount > maxSensors` and returns 0. This is correct.
- **Risk**: LOW. Bounds check is present.

#### EC-8: SyncFrame Header Corruption at Byte[9]
- **Observed**: Header `sensorCount` byte at offset 9 gets corrupted on some hardware (values 0, 1, 254, 255).
- **Root cause**: Potentially USB CDC byte-level corruption or compiler packed-struct issue.
- **Current mitigation**: IMUParser infers sensorCount from frame length (primary path). Header byte is fallback only. CRC-8 catches multi-byte corruption.
- **Belt-and-suspenders**: `buildAbsoluteFrame()` also raw-writes `outputBuffer[9] = includedCount` after struct access.
- **Risk**: LOW with current mitigations. The frame-length inference is robust.

#### EC-9: `effectiveSensorCount` Volatility
- **Issue**: `effectiveSensorCount` is declared `volatile` but written in `expireStaleSlots()` (under spinlock) and read in `isSlotComplete()` (under spinlock). The `volatile` is redundant when spinlocks are used — spinlocks provide memory barriers. Not harmful, but misleading.
- **Secondary issue**: If a sensor goes offline, `effectiveSensorCount` drops. All subsequent frames are "complete" with fewer sensors → lower frame quality. The webapp doesn't know the frame should have had more sensors.
- **Recommendation**: Include `effectiveSensorCount` in a diagnostic field so the webapp can track when the gateway downgrades expectations.

#### EC-10: Epoch Settling Period (50ms) Data Loss
- Every SYNC_RESET (start streaming, recording, calibration) causes a `triggerSyncReset()` which changes the epoch. The `addSample()` function discards ALL samples for 50ms after epoch change.
- At 200Hz × 15 sensors = 3000 samples/second → 150 samples lost per epoch change.
- **Risk**: LOW. Only happens at state transitions, not during steady-state streaming.

### LOW — Cosmetic / Future Concerns

#### EC-11: Two Serial Write Paths (Queue vs Direct)
- **SyncFrames (0x25)**: Written via `sendFramedPacketDirect()` from ProtocolTask, holding `serialWriteMutex`.
- **JSON responses**: Written via `enqueueSerialFrame()` → SerialTxTask queue, also holding `serialWriteMutex`.
- When a JSON frame is being batch-written by SerialTxTask, ProtocolTask will block waiting for `serialWriteMutex`. At 200Hz, each SyncFrame write takes ~50-100µs (130 bytes at 12 Mbit/s USB). The mutex contention is <1% but adds unpredictable jitter.
- **Recommendation**: Consider routing ALL frames through the SerialTxTask queue for a single-writer model. This would eliminate mutex contention entirely.

#### EC-12: Webapp Parser Quaternion Magnitude Filter
- IMUParser rejects sensors with quaternion magnitude² outside [0.8, 1.2].
- If a sensor produces a genuinely unusual quaternion (e.g., during rapid movement where DMP integration error accumulates), valid data could be rejected.
- **Risk**: VERY LOW. DMP quaternions are unit-normalized by hardware.

#### EC-13: `TDMA_MAX_SENSORS_PER_NODE = 58` (TDMAProtocol.h)
- This constant is used for `calculateMaxSamplesPerPacket()` but is absurdly high for current hardware (max 4 sensors). It's not a bug, just a dead constant.
- **Recommendation**: Change to `MAX_SENSORS` or remove if unused elsewhere.

---

## 4. Simplification Opportunities

### SIMP-1: Unify Serial Write to Single Queue Model (MEDIUM EFFORT)
**Current**: Two paths — SyncFrames bypass queue with `sendFramedPacketDirect`, JSON uses `enqueueSerialFrame` + SerialTxTask.  
**Proposed**: Route ALL frames through SerialTxTask. Use priority flag for SyncFrames.  
**Benefit**: Eliminates `serialWriteMutex` contention, respects PAUSE/RESUME for all frame types, single point of backpressure management.  
**Risk**: Adds 2-5ms latency to SyncFrame emission (queue + batch drain). Mitigated by reducing SERIAL_BATCH_INTERVAL_MS.

### SIMP-2: Remove Dead 0x23 Handler (LOW EFFORT)
**Current**: DataIngestionTask handles both 0x23 (legacy absolute) and 0x26 (node delta) packets. All nodes send 0x26 exclusively (ALL_KEYFRAME flag). The 0x23 handler is dead code.  
**Proposed**: Remove the 0x23 branch in both the ESP-NOW callback and DataIngestionTask. Remove 0x23 logging/counters.  
**Benefit**: ~70 lines removed. Simpler code path. Eliminates confusion about which format is active.  
**Risk**: If any node firmware falls back to 0x23 (unlikely with ALL_KEYFRAME always set), packets would be silently dropped.

### SIMP-3: Remove Delta Compression Remnants in SyncTransfer.cpp (LOW EFFORT)
**Current**: `buildTDMAPacket()` always sets `flags = ALL_KEYFRAME`. Delta compression code paths in both `buildTDMAPacket()` and `decodeNodeDelta()` are never exercised.  
**Proposed**: Remove the delta encoding/decoding paths. Simplify both functions to absolute-only.  
**Benefit**: ~60 lines removed from node, ~40 from gateway decoder. Eliminates untested code that could silently corrupt data if flags are accidentally changed.

### SIMP-4: Consolidate `MAX_SENSORS` Definitions (LOW EFFORT)
**Current**: `MAX_SENSORS` is defined in both `SharedConfig.h` (=4) and `ConfigBase.h` (=4). `SYNC_MAX_SENSORS` (=20) in SyncFrameBuffer.h. `TDMA_MAX_SENSORS_PER_NODE` (=58) in TDMAProtocol.h.  
**Proposed**: Single `MAX_SENSORS_PER_NODE = 4` in SharedConfig.h. `SYNC_MAX_SENSORS = MAX_SENSORS_PER_NODE × TDMA_MAX_NODES` (=32). Remove `TDMA_MAX_SENSORS_PER_NODE`.  
**Benefit**: Fewer magic numbers. Changes propagate automatically. Less chance of mismatch.

### SIMP-5: Reduce Diagnostic Logging Verbosity (LOW EFFORT)
**Current**: SyncFrameBuffer.cpp has ~200 lines of diagnostic logging (drift tracking, frame rate monitoring, miss analysis, RX rates, sync quality). Much of this was written during debugging and is now stable.  
**Proposed**: Move detailed diagnostics behind a `#if SYNC_DEBUG` or runtime flag. Keep the 5-second SYNC QUALITY and FRAME RATE summaries.  
**Benefit**: Reduces CPU time in critical path. Reduces serial bandwidth used by debug logs. Cleaner serial output.

### SIMP-6: Remove `ESPNowDataPacket` Struct (LOW EFFORT)
**Current**: `ESPNowDataPacket` in SharedConfig.h is the legacy absolute format used by 0x23. It's no longer populated or sent by any node.  
**Proposed**: Remove the struct and `PACKET_TYPE_DATA = 0x03` define.  
**Benefit**: Eliminates confusion. Signals clearly that 0x26 is the only data format.

### SIMP-7: Simplify `buildAbsoluteFrame()` Active Sensor Logic (MEDIUM EFFORT)
**Current**: Complex logic with `includedIndices`, `forceEmit` branch, active-filtering branch, fallback branch, and pathological-state fallback. This is defensive code that handles edge cases during sensor churn.  
**Proposed**: After stabilization, simplify to: always include ALL sensors in expected list. Mark missing sensors with `flags = 0` (not valid). Webapp already handles invalid sensors by skipping them.  
**Benefit**: Simpler firmware code. Consistent frame size (webapp always knows how many sensor slots to expect). Diagnostic value of seeing "which sensor is missing" in each frame.

---

## 5. Reliability Assessment

### What's Working Well
1. **Physical identity (rawNodeId/localSensorIndex)** in reserved bytes is excellent. The webapp builds stable device keys that survive topology changes.
2. **CRC-8 end-to-end** catches USB serial corruption.
3. **Frame-length inference** for sensorCount makes the parser immune to header corruption.
4. **PSRAM-backed SyncFrameBuffer** with 64 slots provides generous jitter tolerance.
5. **Dual-core pipeline** (ESP-NOW callback → queue → Core 1 processing) eliminates WiFi stalls.
6. **NVS auto-clear** on firmware change eliminates stale topology problems.

### Remaining Reliability Gaps
1. **No lock on registeredNodes[]** — rare torn reads during re-registration (EC-2)
2. **Serial backpressure bypass** — SyncFrames ignore PAUSE/RESUME (EC-6)
3. **effectiveSensorCount degradation** — silent quality reduction when a sensor goes offline (EC-9)
4. **50ms epoch settling** — data loss on every state transition (EC-10)

### Verdict
The pipeline is **architecturally sound** for the current 6-node, 15-sensor configuration. The major stability risks are at the boundaries: (1) node registration/deregistration races, and (2) USB serial backpressure. Neither is catastrophic — they cause brief data gaps (1-2 frames) rather than crashes or corruption. The simplification opportunities (SIMP-1 through SIMP-7) would reduce code complexity by ~300 lines and eliminate several untested code paths.
