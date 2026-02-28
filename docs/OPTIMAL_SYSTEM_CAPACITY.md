# IMU Connect - Optimal System Capacity Analysis

## Executive Summary

This document defines the **maximum achievable capacity** of the IMU Connect system given the hardware constraints of ESP-NOW v2.0 and BLE 5.0. The analysis identifies BLE throughput as the primary bottleneck and provides optimal configurations for different use cases.

---

## Hardware Constraints (Fixed)

| Constraint | Value | Source |
|------------|-------|--------|
| ESP-NOW v2.0 max packet | 1470 bytes | ESP-IDF v5.5+ |
| ESP-NOW practical throughput | ~100 KB/s | WiFi 1 Mbps + overhead |
| BLE 5.0 2M PHY throughput | **~65 KB/s sustained** | Connection overhead |
| BLE minimum interval | 7.5ms | BLE spec (133 events/sec) |
| BLE MTU (negotiated) | 512 bytes | ESP32-S3 config |
| TDMA frame period | 20ms | Firmware constant |
| IMU sample rate | 200 Hz | 5ms between samples |
| TSF sync accuracy | ~100µs | WiFi hardware clock |

---

## Bottleneck Analysis

```
                    ┌─────────────┐
                    │   IMU I2C   │  400 KB/s capacity
                    │   ~28 KB/s  │  7% utilized
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  ESP-NOW    │  100 KB/s capacity
                    │   ~36 KB/s  │  36% utilized
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  BLE 5.0    │  65 KB/s capacity ◄── BOTTLENECK
                    │   ~64 KB/s  │  99% utilized
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Web App   │
                    └─────────────┘
```

**The BLE link is the hard ceiling.** No amount of TDMA restructuring, longer batching, or packet splitting changes this fundamental constraint.

---

## Optimal Configuration: Standard Mode

### 13 Sensors @ 200Hz (No Compression)

```
┌────────────────────────────────────────────────────────────┐
│                    OPTIMAL STANDARD                        │
├────────────────────────────────────────────────────────────┤
│  Nodes:           4                                        │
│  Sensors:         13 total (3, 3, 4, 3 per node)          │
│  Sample Rate:     200 Hz synchronized                      │
│  TDMA Frame:      20ms (50 Hz beacon)                      │
│  Samples/Frame:   4 per sensor                             │
│  Latency:         25-35ms end-to-end                       │
│  BLE Utilization: 96% (62 KB/s of 65 KB/s)                │
│  Headroom:        ~5% for retries                          │
└────────────────────────────────────────────────────────────┘
```

#### Data Budget
```
Per-sensor data rate:
  24 bytes × 200 Hz = 4,800 bytes/sec

BLE capacity:
  65,000 bytes/sec ÷ 4,800 = 13.5 sensors

With 5% safety margin:
  61,750 ÷ 4,800 = 12.8 → 13 sensors
```

#### Recommended Node Layout
| Node | Location | Sensors | Packet Size |
|------|----------|---------|-------------|
| 1 | Torso | 4 | 408 bytes |
| 2 | Pelvis | 3 | 308 bytes |
| 3 | Left Leg | 3 | 308 bytes |
| 4 | Right Leg | 3 | 308 bytes |
| **Total** | | **13** | **1,332 bytes/frame** |

---

## Optimal Configuration: Compressed Mode

### 20 Sensors @ 200Hz (With Delta Compression)

```
┌────────────────────────────────────────────────────────────┐
│                   OPTIMAL COMPRESSED                       │
├────────────────────────────────────────────────────────────┤
│  Nodes:           5                                        │
│  Sensors:         20 total (4 per node)                    │
│  Sample Rate:     200 Hz synchronized                      │
│  TDMA Frame:      20ms (50 Hz beacon)                      │
│  Samples/Frame:   4 per sensor                             │
│  Latency:         25-35ms end-to-end                       │
│  BLE Utilization: 92% (60 KB/s of 65 KB/s)                │
│  Headroom:        ~8% for retries                          │
└────────────────────────────────────────────────────────────┘
```

#### Data Budget (Compressed)
```
Per-sensor data rate (delta):
  15 bytes × 200 Hz = 3,000 bytes/sec

BLE capacity:
  65,000 bytes/sec ÷ 3,000 = 21.6 sensors

With 8% safety margin:
  59,800 ÷ 3,000 = 19.9 → 20 sensors
```

#### Recommended Node Layout
| Node | Location | Sensors | Packet Size |
|------|----------|---------|-------------|
| 1 | Torso | 4 | 248 bytes |
| 2 | Pelvis | 4 | 248 bytes |
| 3 | Left Thigh | 4 | 248 bytes |
| 4 | Left Shank | 4 | 248 bytes |
| 5 | Right Leg | 4 | 248 bytes |
| **Total** | | **20** | **1,240 bytes/frame** |

---

## TDMA Frame Schedule (Optimal)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        20ms TDMA FRAME                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  0.0ms   ┌──────────┐                                                   │
│          │ BEACON   │ 500µs - Gateway broadcasts timing reference       │
│  0.5ms   └──────────┘                                                   │
│          ┌──────────┐                                                   │
│          │   GAP    │ 500µs - Gateway switches to RX mode               │
│  1.0ms   └──────────┘                                                   │
│          ┌──────────────────────────────────────────────────────────┐   │
│          │                    NODE SLOTS                            │   │
│          │                                                          │   │
│          │  Node 1: 1.0 - 4.5ms   (3.5ms slot, ~400 bytes)         │   │
│          │  Node 2: 4.5 - 8.0ms   (3.5ms slot, ~400 bytes)         │   │
│          │  Node 3: 8.0 - 11.5ms  (3.5ms slot, ~400 bytes)         │   │
│          │  Node 4: 11.5 - 15.0ms (3.5ms slot, ~400 bytes)         │   │
│          │  [Node 5: 15.0 - 18.5ms if compressed mode]             │   │
│          │                                                          │   │
│ 15.0ms   └──────────────────────────────────────────────────────────┘   │
│          ┌──────────────────────────────────────────────────────────┐   │
│          │              GATEWAY PROCESSING                          │   │
│          │  - Parse ESP-NOW packets (~200µs each)                   │   │
│          │  - SyncFrameBuffer assembly (~100µs × 4 timestamps)      │   │
│          │  - Build 0x25 SyncFrame packets                          │   │
│ 18.0ms   └──────────────────────────────────────────────────────────┘   │
│          ┌──────────────────────────────────────────────────────────┐   │
│          │                GUARD TIME (2ms)                          │   │
│          │  Buffer for jitter, retries, and overflow                │   │
│ 20.0ms   └──────────────────────────────────────────────────────────┘   │
│                                                                         │
│ ─────────────────────── NEXT FRAME ─────────────────────────────────────│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## BLE Transmission (Interleaved with TDMA)

BLE operates independently from TDMA at 7.5ms intervals:

```
TDMA Frames:
|◄────── Frame 0 ──────►|◄────── Frame 1 ──────►|◄────── Frame 2 ──────►|
0ms                    20ms                    40ms                    60ms

BLE Connection Events (7.5ms interval):
↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓
0   7.5   15  22.5   30  37.5   45  52.5   60  67.5   75  82.5  ...

SyncFrame Emissions (4 per TDMA frame):
    ●●    ●●          ●●    ●●          ●●    ●●
  (t1,t2)(t3,t4)    (t5,t6)(t7,t8)    (t9,t10)...
```

### BLE Packet Distribution
- 4 timestamps generated per 20ms TDMA frame
- ~2.6 BLE events per 20ms frame
- 1-2 SyncFrame notifications per BLE event
- Each SyncFrame: 11 + (sensors × 24) bytes

---

## Capacity Comparison Table

| Mode | Nodes | Sensors | Rate | Latency | BLE Load | Use Case |
|------|-------|---------|------|---------|----------|----------|
| **Standard** | **4** | **13** | **200 Hz** | **30ms** | **96%** | **Default** |
| Compressed | 5 | 20 | 200 Hz | 30ms | 92% | Full body |
| Conservative | 3 | 9 | 200 Hz | 25ms | 67% | Reliable |
| High-latency | 6 | 18 | 100 Hz | 60ms | 55% | Many sensors |

---

## Why Not More?

### Explored Alternatives (All Hit BLE Wall)

| Idea | Result |
|------|--------|
| Longer TDMA frames (40ms, 100ms) | Same BLE throughput, just higher latency |
| Split BLE packets per timestamp | Same total bytes, more overhead |
| Staggered node transmission | Helps TDMA, doesn't help BLE |
| Multiple notifications per event | Already doing 1-2, max ~3 reliable |

### To Exceed Current Limits

| Option | Capacity | Trade-off |
|--------|----------|-----------|
| WiFi instead of BLE | 60+ sensors | Requires router, no mobile |
| Dual Gateway (2× BLE) | 26 sensors | 2× hardware cost |
| USB tether | 100+ sensors | Wired connection |
| Accept 100 Hz | 26 sensors | Lower temporal resolution |

---

## Implementation Checklist

### Standard Mode (13 sensors)
- [x] 20ms TDMA frame period
- [x] 4 samples per frame (200 Hz)
- [x] 4 node slots (3.5ms each)
- [x] SyncFrameBuffer with 24-byte sensor data
- [x] BLE 7.5ms connection interval
- [ ] Verify 13 sensors sustained throughput

### Compressed Mode (20 sensors)
- [ ] Implement delta compression (0x26 format)
- [ ] Update web app parser
- [ ] Add 5th node slot to TDMA schedule
- [ ] Verify 20 sensors sustained throughput

---

## Quick Reference

```
┌─────────────────────────────────────────────────────────┐
│                   SYSTEM LIMITS                         │
├─────────────────────────────────────────────────────────┤
│  Max Sensors (standard):     13 @ 200 Hz               │
│  Max Sensors (compressed):   20 @ 200 Hz               │
│  Max Nodes:                  5 (TDMA timing)           │
│  Min Latency:                25ms                      │
│  Bottleneck:                 BLE 5.0 (65 KB/s)         │
└─────────────────────────────────────────────────────────┘
```

---

*Document Version: 1.0*  
*Analysis Date: February 2026*  
*Hardware: ESP32-S3 + ICM-20649 + BLE 5.0*
