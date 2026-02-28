# Gateway → Web App Data Pipeline: Detailed Engineering Analysis

**Date:** 2026-02-09  
**Scope:** Data stream from Gateway firmware output through to web app state stores  
**Assumption:** Node → Gateway path (ESP-NOW TDMA) is functioning correctly

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        ESP32-S3 GATEWAY (Dual-Core)                     │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ CORE 0 (WiFi/Protocol)                                             │ │
│  │                                                                     │ │
│  │  ESP-NOW Callback ──► espNowRxQueue ──────────────────┐            │ │
│  │  (OnDataRecv)          (16 slots, 512B each)          │            │ │
│  │                                                        │            │ │
│  │  ProtocolTask (1ms cadence)                            │            │ │
│  │   ├─ TDMA Beacon TX (20ms / 50Hz)                     │            │ │
│  │   ├─ SyncFrameBuffer.update() (expire stale slots)    │            │ │
│  │   ├─ SyncFrameBuffer.hasCompleteFrame()               │            │ │
│  │   └─ enqueueSerialFrame(0x25/0x27) ──► serialTxQueue  │            │ │
│  │                                         (16 slots)     │            │ │
│  │  SerialTxTask                                          │            │ │
│  │   └─ Serial.write(length-prefixed frame) ──► USB CDC  │            │ │
│  └──────────────────────────────────────────────────────┘ │            │ │
│                                                            │            │ │
│  ┌──────────────────────────────────────────────────────┐ │            │ │
│  │ CORE 1 (Data Ingestion)                              │◄┘            │ │
│  │                                                       │              │ │
│  │  DataIngestionTask                                    │              │ │
│  │   ├─ Dequeue from espNowRxQueue                       │              │ │
│  │   ├─ Decode 0x23 (TDMA batched) → addSample()        │              │ │
│  │   └─ Decode 0x26 (node delta) → reconstruct → add()  │              │ │
│  │                                                       │              │ │
│  │   SyncFrameBuffer                                     │              │ │
│  │    ├─ 64 timestamp slots (PSRAM-backed circular buf)  │              │ │
│  │    ├─ 20 max sensors × 24 bytes/sensor                │              │ │
│  │    ├─ 2500µs timestamp tolerance                      │              │ │
│  │    ├─ 35ms stale slot timeout (forceEmit)             │              │ │
│  │    └─ Delta compression: 0x25 keyframe / 0x27 delta   │              │ │
│  └──────────────────────────────────────────────────────┘              │ │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                      USB CDC @ 921600 baud
                    (length-prefixed binary stream)
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         WEB APPLICATION (Browser)                        │
│                                                                          │
│  ┌─────────────────────────────┐   ┌──────────────────────────────────┐ │
│  │ CONNECTION LAYER            │   │ ALTERNATIVE: BLE PATH            │ │
│  │                             │   │                                  │ │
│  │ SerialConnection            │   │ BLEConnection                    │ │
│  │  ├─ Web Serial API          │   │  ├─ Web Bluetooth API            │ │
│  │  ├─ 65536 byte buffer       │   │  ├─ GATT notifications          │ │
│  │  ├─ handleChunk()           │   │  ├─ characteristicvaluechanged   │ │
│  │  └─ Stream reassembly       │   │  └─ Stream reassembly            │ │
│  └────────────┬────────────────┘   └──────────────┬───────────────────┘ │
│               │                                    │                     │
│               └──────────┬─────────────────────────┘                     │
│                          ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ FRAME EXTRACTION LAYER (identical in both connections)              │ │
│  │  ├─ Length-prefix parsing: [len_lo][len_hi][frame_data...]          │ │
│  │  ├─ Packet type validation (0x04, 0x05, 0x06, 0x25, 0x27)         │ │
│  │  ├─ Resync on corruption (byte-shift, max 64 attempts)            │ │
│  │  └─ Buffer overflow guard (6× MAX_FRAME_LEN → truncate)           │ │
│  └────────────┬────────────────────────────────────────────────────────┘ │
│               ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ IMUParser.parseSingleFrame()                                       │ │
│  │  ├─ 0x25: Absolute SyncFrame → IMUDataPacket[]                    │ │
│  │  ├─ 0x27: Delta SyncFrame → reconstruct → IMUDataPacket[]        │ │
│  │  ├─ 0x04: Environmental → EnvironmentalDataPacket                 │ │
│  │  ├─ 0x05: NodeInfo → NodeInfoPacket                               │ │
│  │  └─ 0x06: JSON → JSONPacket                                       │ │
│  └────────────┬────────────────────────────────────────────────────────┘ │
│               ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ DISPATCH / ROUTING (BLEConnection / SerialConnection)              │ │
│  │  ├─ Environmental → useOptionalSensorsStore                        │ │
│  │  ├─ NodeInfo → ConnectionData callback                             │ │
│  │  ├─ JSON → window CustomEvent + ConnectionData callback            │ │
│  │  └─ IMU packets → prefixed w/ deviceId → _onData() callback       │ │
│  └────────────┬────────────────────────────────────────────────────────┘ │
│               ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ useDeviceStore (connectionManager.onData callback)                  │ │
│  │  ├─ LiveGapFill.processPacket() — frame gap interpolation          │ │
│  │  ├─ VisualizationThrottler.recordDataFrame()                       │ │
│  │  ├─ useRecordingStore.recordFrame() — always 200Hz                 │ │
│  │  ├─ ActivityEngine.push() — activity detection at full rate        │ │
│  │  ├─ useDeviceRegistry.handleRealDeviceData() — VQF + caches       │ │
│  │  └─ useNetworkStore.updateFromPacket() — topology updates          │ │
│  └────────────┬────────────────────────────────────────────────────────┘ │
│               ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ useDeviceRegistry.handleRealDeviceData()                            │ │
│  │  ├─ NodeInfo handling (sensor registration, heartbeat)              │ │
│  │  ├─ dt calculation (firmware timestamps + EMA jitter smoothing)     │ │
│  │  ├─ SampleRateMonitor.recordSample()                                │ │
│  │  ├─ Axis correction (configurable permutation + sign)               │ │
│  │  ├─ Scale correction (per-sensor)                                   │ │
│  │  ├─ Low-pass filter (optional EMA pre-filter)                       │ │
│  │  ├─ VQF fusion (accel+gyro → quaternion, per-device instance)       │ │
│  │  ├─ Tare/mounting offset application (quat multiplication)          │ │
│  │  ├─ ZUPT stationary detection (gyro threshold)                      │ │
│  │  ├─ Uncertainty tracking (research quality)                         │ │
│  │  └─ High-freq cache writes:                                         │ │
│  │      ├─ deviceQuaternionCache (Map<string, [w,x,y,z]>)             │ │
│  │      ├─ deviceAccelCache (Map<string, [x,y,z]>)                    │ │
│  │      ├─ deviceGyroCache (Map<string, [x,y,z]>)                     │ │
│  │      ├─ deviceRawAccelCache / deviceRawGyroCache                   │ │
│  │      └─ deviceStatsCache (Map<string, {hz, lastUpdate}>)           │ │
│  └────────────┬────────────────────────────────────────────────────────┘ │
│               ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ VISUALIZATION LAYER                                                 │ │
│  │  getSensorData() — single source of truth                           │ │
│  │   ├─ Playback mode: reads from usePlaybackStore                     │ │
│  │   └─ Live mode: reads from deviceQuaternionCache (mutable, no       │ │
│  │      React re-renders at 200Hz — polled by useFrame in Three.js)    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Stage-by-Stage Detail

### Stage 1: Gateway SyncFrameBuffer → Serial Output

**Source files:** `MASH_Gateway.ino`, `SyncFrameBuffer.h/.cpp`

| Aspect | Detail |
|--------|--------|
| **Input** | `addSample()` called from DataIngestionTask (Core 1) with decoded node data |
| **Synchronization** | Spinlock (`portMUX_TYPE`) for cross-core safety between DataIngestionTask writes (Core 1) and ProtocolTask reads (Core 0) |
| **Frame assembly** | 64-slot circular buffer in PSRAM. Each slot keyed by timestamp (2500µs tolerance). A slot is "complete" when ALL active sensors have data |
| **Timeout policy** | Slots older than 35ms are force-emitted as partial frames (flags indicate incomplete) |
| **Output packets** | 0x25 (absolute, 24 bytes/sensor) every 10th frame; 0x27 (delta, 14 bytes/sensor) for intervening frames |
| **Enqueue** | `enqueueSerialFrame()` wraps with 2-byte LE length prefix: `[len_lo][len_hi][frame_data]` then pushes to `serialTxQueue` (FreeRTOS queue, 16 slots) |
| **Flow control** | OPP-7: webapp can send `PAUSE`/`RESUME` commands. When paused, data frames are dropped (command responses still flow) |

**Key constants:**
- `SYNC_MAX_SENSORS`: 20
- `SYNC_TIMESTAMP_SLOTS`: 64 (320ms buffering at 200Hz)
- `SYNC_SLOT_TIMEOUT_MS`: 35ms
- `SYNC_TIMESTAMP_TOLERANCE_US`: 2500µs
- `SYNC_DELTA_KEYFRAME_INTERVAL`: 10 (every 50ms)

### Stage 2: SerialTxTask → USB CDC

**Source file:** `MASH_Gateway.ino` (line ~1007)

| Aspect | Detail |
|--------|--------|
| **Core** | Core 0, priority 2 |
| **Drain rate** | Receives from queue with 5ms timeout; effectively up to 200 frames/sec |
| **Thread safety** | FreeRTOS mutex (`serialWriteMutex`) guards `Serial.write()` across cores |
| **Baud rate** | 921600 bps (set in `setup()`) — theoretical max ~90 KB/s |
| **Frame format** | `[len_lo][len_hi][packet_type][...payload...]` written atomically |
| **Buffer** | 512-byte max frame (fits 20-sensor absolute SyncFrame at 490 bytes + overhead) |
| **Overflow detection** | Counter-based: warns at 10 drops/5s, critical at 50 drops/5s |

**Potential bottleneck:** At 200Hz with 13+ sensors using 0x25 (322 bytes + 2 len prefix = 324 bytes), throughput = 64.8 KB/s. This is ~72% of the 90 KB/s theoretical USB CDC limit. With delta compression (90% delta), effective throughput drops to ~40 KB/s — healthy margin.

### Stage 3: Web App — Serial/BLE Transport Ingestion

**Source files:** `SerialConnection.ts`, `BLEConnection.ts`

Both connections implement identical stream reassembly logic:

| Aspect | Detail |
|--------|--------|
| **Serial** | Web Serial API at 921600 baud, 65536-byte OS buffer |
| **BLE** | Web Bluetooth GATT notifications on `CHAR_IMU_DATA`, MTU up to 512 |
| **Stream buffer** | Dynamically growing `Uint8Array` — chunks appended, consumed frames removed |
| **Frame extraction** | Length-prefix parsing: `frameLen = buf[offset] | (buf[offset+1] << 8)` |
| **Validation** | 3-level: (1) length bounds [3, 1024], (2) complete data available, (3) packet type in valid set `{0x04, 0x05, 0x06, 0x25, 0x27}` |
| **Resync** | On invalid data, shifts 1 byte forward, up to 64 attempts before truncating buffer to last 512 bytes |
| **Overflow guard** | Buffer > 6144 bytes → truncated to last 2048 bytes |

**Difference between Serial and BLE paths:**
- Serial receives raw USB bytes in contiguous chunks
- BLE receives fragmented GATT notifications that may split a frame across multiple events
- Both converge to the same frame extraction loop and IMUParser

### Stage 4: IMUParser — Binary → Typed Objects

**Source file:** `IMUParser.ts`

#### 0x25 Absolute SyncFrame

| Field | Offset | Size | Scale | Unit |
|-------|--------|------|-------|------|
| type | 0 | 1 | — | 0x25 |
| frameNumber | 1 | 4 (u32 LE) | — | monotonic |
| timestampUs | 5 | 4 (u32 LE) | — | µs |
| sensorCount | 9 | 1 | — | count |
| **Per sensor (24 bytes):** | | | | |
| sensorId | +0 | 1 | — | — |
| q[w,x,y,z] | +1 | 8 (4×i16 LE) | ÷16384 | unit quat |
| a[x,y,z] | +9 | 6 (3×i16 LE) | ÷100 | m/s² |
| g[x,y,z] | +15 | 6 (3×i16 LE) | ÷900 | rad/s |
| flags | +21 | 1 | bit 0=valid | — |
| reserved | +22 | 2 | — | padding |

- Invalid sensors (flag bit 0 = 0) are **skipped** — no `IMUDataPacket` emitted
- Raw int16 values saved to `_deltaPrevSamples` Map for 0x27 reconstruction
- `frameCompleteness` metadata attached: `{validCount, expectedCount, isComplete}`

#### 0x27 Delta SyncFrame

| Field | Offset | Size | Scale |
|-------|--------|------|-------|
| type | 0 | 1 | 0x27 |
| frameNumber | 1 | 4 (u32 LE) | — |
| timestampUs | 5 | 4 (u32 LE) | — |
| sensorCount | 9 | 1 | — |
| flags | 10 | 1 | bitfield |
| **Per sensor (14 bytes):** | | | |
| sensorId | +0 | 1 | — |
| dq[w,x,y,z] | +1 | 4 (4×i8) | delta to prev |
| a[x,y,z] | +5 | 6 (3×i16 LE) | ÷100 (absolute) |
| dg[x,y,z] | +11 | 3 (3×i8) | delta to prev |

- **Requires prior 0x25 keyframe** — if `_deltaPrevSamples` has no entry for a sensorId, that sensor is skipped with a console warning
- Reconstructed absolute values: `qwRaw = prev.qw + dqw`, then `/16384.0`
- `_deltaPrevSamples` updated after reconstruction for the next frame
- **Reset on disconnect** (`IMUParser.resetDeltaState()`) to prevent stale delta corruption on reconnect

**Critical observation:** If a 0x25 keyframe is lost (BLE corruption / serial drop), ALL subsequent 0x27 delta frames for those sensors will be skipped until the next keyframe arrives (every 50ms). This creates a periodic ~50ms data gap risk.

### Stage 5: Connection → Store Dispatch

**Source files:** `BLEConnection.ts` / `SerialConnection.ts` → `ConnectionManager.ts` → `useDeviceStore.ts`

The connection class routes parsed packets:

| Packet Type | Route |
|-------------|-------|
| Environmental (has `barometer` or `magnetometer`) | `useOptionalSensorsStore.updateFromStatus()` |
| NodeInfo (has `nodeName`) | Enhanced with `gatewayName`, forwarded as `ConnectionData` |
| JSON (has `type`, `success`, etc.) | Dispatched as `ble-json-packet` CustomEvent + forwarded |
| IMU (has `quaternion`) | Prefixed with `deviceId` = `"${deviceName}_${sensorId}"`, forwarded as batch |

The `deviceId` prefixing is the critical identity step: e.g., `"MASH Gateway_3"` for sensor ID 3.

### Stage 6: useDeviceStore — Central Orchestration

**Source file:** `useDeviceStore.ts`

For each `IMUDataPacket`, the store performs this pipeline:

1. **LiveGapFill** — Detects frame number gaps and interpolates missing frames
2. **VisualizationThrottler** — Records data frame timestamp for rate stats
3. **Recording** — `useRecordingStore.recordFrame()` at full 200Hz (research-grade)
4. **Activity Detection** — `ActivityEngine.push()` at full rate
5. **Device Registry** — `handleRealDeviceData()` for fusion + cache
6. **Network Topology** — `useNetworkStore.updateFromPacket()`

### Stage 7: useDeviceRegistry.handleRealDeviceData — Fusion Pipeline

**Source file:** `useDeviceRegistry.ts` (line ~504)

This is the heaviest processing stage:

```
IMUDataPacket
    │
    ├─ NodeInfo handling (register new sensors, reset calibration)
    │
    ├─ dt calculation
    │   ├─ Firmware timestamp (µs → ms): preferred source of truth
    │   ├─ EMA smoothing (α=0.3) to filter BLE/serial jitter
    │   ├─ Clamp: [2ms, 50ms] → [20Hz, 500Hz]
    │   └─ SampleRateMonitor.recordSample()
    │
    ├─ RAW cache write (deviceRawAccelCache, deviceRawGyroCache)
    │
    ├─ Axis correction (configurable per-device)
    │   └─ permutation + sign: accel[i] = raw[map[i]] × sign[i]
    │
    ├─ Scale correction (per-device multiplier)
    │
    ├─ Low-pass filter (optional EMA, configurable cutoff Hz)
    │
    ├─ VQF fusion (per-device instance)
    │   ├─ Input: corrected accel + gyro + dt
    │   ├─ Output: quaternion [w,x,y,z]
    │   ├─ Config: tauAcc=1.0, tauMag=9.0, restThAcc=0.2, restThGyro=0.05
    │   └─ OR: firmware quaternion pass-through if VQF disabled
    │
    ├─ Mounting offset / Tare (quaternion × offset)
    │
    ├─ ZUPT stationary detection (gyro magnitude < threshold → hold quat)
    │
    ├─ Uncertainty tracking (UncertaintyTracker per device)
    │
    └─ Cache writes (non-reactive, bypass React state):
        ├─ deviceQuaternionCache.set(deviceId, [w,x,y,z])
        ├─ deviceAccelCache.set(deviceId, [ax,ay,az])
        ├─ deviceGyroCache.set(deviceId, [gx,gy,gz])
        └─ deviceStatsCache.set(deviceId, {hz, lastUpdate})
```

### Stage 8: Visualization Consumption

**Source file:** `useSensorData.ts`

`getSensorData(deviceId)` is the single-source-of-truth function:

- **Live mode:** Reads directly from `deviceQuaternionCache`, `deviceAccelCache`, `deviceGyroCache` Maps — these are **mutable JS Maps**, not React state. No re-renders triggered. Three.js `useFrame` polls at 60fps.
- **Playback mode:** Reads from `usePlaybackStore.getInterpolatedFrame()` for smooth quaternion interpolation.

---

## 3. Wire Protocol Summary

```
USB Serial / BLE Stream:
  ┌────────┬────────┬─────────────────────────────────────────┐
  │ len_lo │ len_hi │ frame_data (len bytes)                  │
  │  1B    │  1B    │ [type][...payload...]                   │
  └────────┴────────┴─────────────────────────────────────────┘
  Repeated back-to-back in the byte stream.

Frame types:
  0x04  Environmental  (31 bytes)
  0x05  NodeInfo       (37 or 46 bytes)
  0x06  JSON           (1 + variable)
  0x25  SyncFrame      (10 + N×24 bytes)
  0x27  SyncDelta      (11 + N×14 bytes)
```

---

## 4. Identified Risks & Observations

### 4.1 Delta State Loss (Medium Risk)
If a 0x25 keyframe packet is dropped (serial buffer overflow, BLE corruption), all subsequent 0x27 delta packets for affected sensors are silently skipped until the next keyframe (50ms later at the 10-frame interval). This creates a data gap. The gateway does send keyframes every 10 frames, so recovery is bounded, but 50ms of missing data at 200Hz = 10 lost samples.

**Mitigation:** The webapp could detect consecutive delta-skip warnings and request a keyframe via the `forceKeyframe()` mechanism. Currently no such feedback path exists from webapp → gateway for keyframe requests.

### 4.2 Stream Buffer Memory Growth (Low Risk)
Both `BLEConnection` and `SerialConnection` use dynamically-growing `Uint8Array` concatenation for their stream buffers. Under sustained high throughput, this creates GC pressure from repeated allocation/copy. The overflow guard caps at ~6KB, but the repeated slice/concat pattern is suboptimal.

### 4.3 Dual Processing of Firmware Quaternion + VQF (Design Choice)
The firmware sends fused quaternions (from the IMU's DMP). The webapp's `handleRealDeviceData()` can either pass these through or re-fuse using VQF from raw accel+gyro. This is configurable but creates two divergent quaternion sources. Which path is active depends on `useClientSideFusion` (currently removed from the codebase, suggesting VQF is always active). If VQF is always running, the firmware-provided quaternion in 0x25/0x27 packets is **overwritten** by VQF output.

### 4.4 Serial TX Queue Depth (Monitored)
The `serialTxQueue` has 16 slots at 200Hz = 80ms buffer. If `ProtocolTask` emits frames faster than `SerialTxTask` can drain them (USB CDC backpressure), drops occur. The gateway monitors and reports these via `serialTxDropCount`, but there's no automatic backpressure to the SyncFrameBuffer — it keeps emitting.

### 4.5 Cross-Transport Parity
BLE and Serial paths share identical frame extraction and parsing logic, but differ in:
- BLE fragments across GATT notifications (requires stream reassembly from potentially small MTU chunks)
- Serial arrives in larger contiguous chunks from the OS USB driver
- Serial has flow control (`PAUSE`/`RESUME`); BLE does not

### 4.6 Timestamp Precision Chain
1. **Firmware:** `timestampUs` is `uint32_t` (µs) — wraps at ~71 minutes
2. **IMUParser:** Converts to seconds as `timestampUs / 1_000_000` (float64 — no precision loss at these magnitudes)
3. **DeviceRegistry:** Uses `timestampUs / 1000` (ms) for dt calculation — correct
4. **Note:** The `uint32_t` wrap at 4,294,967,295µs (~71.6 min) is not handled. Long recording sessions could see a timestamp discontinuity. At 200Hz this manifests as a single spurious `rawDt` spike, which the EMA smoothing (α=0.3) would dampen but not eliminate.

---

## 5. Data Throughput Budget

| Scenario | Sensors | Frame Size (0x25) | Frame Size (0x27) | Mixed Rate | USB Budget |
|----------|---------|-------------------|--------------------|------------|------------|
| 2 sensors | 2 | 58 B | 39 B | ~8.6 KB/s | 10% |
| 5 sensors | 5 | 130 B | 81 B | ~18.4 KB/s | 20% |
| 10 sensors | 10 | 250 B | 151 B | ~34.6 KB/s | 38% |
| 16 sensors | 16 | 394 B | 235 B | ~54.3 KB/s | 60% |
| 20 sensors | 20 | 490 B | 291 B | ~67.2 KB/s | 75% |

*Mixed rate assumes 90% delta (0x27) + 10% keyframe (0x25), 200 frames/sec, +2 bytes length prefix per frame*

**Budget headroom at 16 sensors: ~40%.** Adequate but leaves little margin for JSON status frames, environmental packets, and USB CDC protocol overhead.

---

## 6. Complete Packet Lifecycle Example (5-sensor system)

```
1. ProtocolTask detects complete SyncFrame slot
   → SyncFrameBuffer.getCompleteFrame()
   → Builds 0x27 delta packet: 11 + 5×14 = 81 bytes
   
2. enqueueSerialFrame(packet, 81)
   → Wraps: [0x51, 0x00, 0x27, ...payload...] = 83 bytes in SerialFrame
   → xQueueSend(serialTxQueue) 

3. SerialTxTask dequeues
   → Serial.write(83 bytes)
   → USB CDC transfers to host

4. SerialConnection.handleChunk(chunk)
   → Appended to streamBuffer
   → Frame extraction: len=81, packet_type=0x27 ✓
   → frame = streamBuffer.slice(offset+2, offset+83)

5. IMUParser.parseSingleFrame(frame)
   → Type 0x27: delta decode
   → For each of 5 sensors:
     → Reconstruct absolute quat from prev + delta
     → Scale accel (÷100), gyro (÷900)
     → Emit IMUDataPacket {sensorId, quaternion, accelerometer, gyro, ...}
   → Returns 5 IMUDataPackets

6. SerialConnection dispatch
   → Prefixes deviceId: "MASH Gateway_0" through "MASH Gateway_4"
   → Calls _onData([...5 packets...])

7. useDeviceStore.onData callback
   → For each packet:
     → LiveGapFill.processPacket()
     → useRecordingStore.recordFrame()
     → ActivityEngine.push()
     → useDeviceRegistry.handleRealDeviceData()
       → VQF fusion → quaternion
       → deviceQuaternionCache.set("MASH Gateway_3", [w,x,y,z])

8. Three.js useFrame (60fps)
   → getSensorData("MASH Gateway_3")
   → Reads deviceQuaternionCache.get("MASH Gateway_3")
   → Applies to 3D bone rotation
```

---

## 7. Key Files Reference

| Layer | File | Role |
|-------|------|------|
| Gateway | `MASH_Gateway.ino` | Main firmware: tasks, queues, ESP-NOW callback, serial output |
| Gateway | `SyncFrameBuffer.h/cpp` | Cross-node timestamp synchronization, delta compression |
| Gateway | `SyncManager.h/cpp` | TDMA beacon, node registration, ESP-NOW transport |
| Webapp | `SerialConnection.ts` | Web Serial API, stream reassembly, frame extraction |
| Webapp | `BLEConnection.ts` | Web Bluetooth API, GATT notifications, stream reassembly |
| Webapp | `IMUParser.ts` | Binary frame → typed packet parsing (0x25, 0x27, etc.) |
| Webapp | `ConnectionManager.ts` | Abstraction over BLE/Serial, routing proxy |
| Webapp | `useDeviceStore.ts` | Central dispatch: recording, gap fill, activity, registry |
| Webapp | `useDeviceRegistry.ts` | VQF fusion, axis correction, caches, device state |
| Webapp | `useSensorData.ts` | Visualization data source (live cache or playback) |
| Webapp | `SyncedSampleStats.ts` | Sample rate monitoring, sync completeness tracking |
| Webapp | `DataPipelineDebugger.ts` | Debug instrumentation across the pipeline |
