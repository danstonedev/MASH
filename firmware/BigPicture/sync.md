# Sync & Timing — ESP-NOW Multi-Node

## Purpose
Define the time synchronization strategy for the multi-node biomechanics suit to achieve sub-millisecond sample alignment.

---

## Principles
- **Local sampling**: Each node samples IMUs at its own rate
- **No shared hardware clock**: Nodes have independent oscillators
- **Smooth drift correction**: Avoid discontinuities in timestamps
- **Deterministic slot allocation**: TDMA prevents packet collisions

---

## Current State (Single Node)
The prototype uses a single ESP32 with local `millis()` timestamps. No sync needed.

```cpp
// SensorManager.cpp
sensorData[i].timestamp = syncManager.getAdjustedTime();
```

---

## V1 Multi-Node Sync Strategy

### Architecture
```
┌──────────────┐    ESP-NOW Beacon     ┌──────────────┐
│   Node A     │ ◄──────────────────── │   Node B     │
│   (Hub)      │ ──────────────────────► (Slave)     │
│              │                       └──────────────┘
│  20Hz Sync   │    ESP-NOW Beacon     ┌──────────────┐
│   Beacon     │ ◄──────────────────── │   Node C     │
└──────────────┘ ──────────────────────► (Slave)     │
       │                               └──────────────┘
       │         ESP-NOW Beacon        ┌──────────────┐
       │ ◄──────────────────────────── │   Node D     │
       └───────────────────────────────► (Slave)     │
                                       └──────────────┘
```

### Sync Beacon Packet
Broadcast by Hub (Node A) at 20 Hz:

| Field | Size | Description |
|-------|------|-------------|
| `hub_time_usec` | 8 bytes | Hub's local time in microseconds |
| `hub_frame_counter` | 4 bytes | Monotonic frame index |
| `flags` | 1 byte | Sync status flags |

### Slave Time Adjustment

On each beacon received:
```cpp
// SyncManager.cpp (slave side)
void onBeaconReceived(uint64_t hubTime, uint64_t localTime) {
    int64_t offset = hubTime - localTime;
    
    // Smooth correction (avoid jumps)
    if (abs(offset - currentOffset) < MAX_JUMP_US) {
        currentOffset = 0.99 * currentOffset + 0.01 * offset;
    } else {
        currentOffset = offset; // Hard reset
    }
}

uint64_t getAdjustedTime() {
    return micros() + currentOffset;
}
```

---

## TDMA Slot Allocation

To prevent packet collisions, each node transmits in a dedicated time slot after the beacon:

| Node | Slot Offset | Window |
|------|-------------|--------|
| A (Hub) | 0 ms | Beacon + own data |
| B | +0.5 ms | Data packet |
| C | +1.5 ms | Data packet |
| D | +2.5 ms | Data packet |

**Total cycle time**: ~4 ms (250 Hz theoretical max)

---

## Sampling Coordination

Each node samples IMUs independently at 120 Hz but timestamps use synchronized time:

```cpp
void SensorManager::update() {
    // Sample at local rate
    readAllIMUs();
    
    // Timestamp with adjusted time
    for (int i = 0; i < sensorCount; i++) {
        sensorData[i].timestamp = syncManager.getAdjustedTime();
    }
}
```

---

## Clock Drift Compensation

ESP32 crystal accuracy: ±40 ppm → ~3.5 ms/day drift

### Strategy
1. Beacon rate of 20 Hz provides continuous correction
2. Exponential smoothing prevents jitter
3. Frame counter allows detection of missed beacons

### Drift Estimation (Advanced)
```cpp
// Optional: Linear regression on recent beacon timestamps
// Estimate drift rate and predict corrected time between beacons
```

---

## Web App Alignment

The web app receives packets from all nodes. Alignment strategies:

| Strategy | Implementation |
|----------|----------------|
| **Interpolation** | Blend samples at render time based on timestamp |
| **Nearest neighbor** | Use most recent sample per segment |
| **Prediction** | Extrapolate with angular velocity |

Current implementation uses **high-frequency cache** (`deviceQuaternionCache`) updated at receive rate, read at render rate.

---

## Future: Gateway Aggregation

If using a gateway:
1. Gateway receives all ESP-NOW packets
2. Gateway re-timestamps to common base
3. Gateway batches and sends over BLE/WiFi
4. Web app receives single unified stream
