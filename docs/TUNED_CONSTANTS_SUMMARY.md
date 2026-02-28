# Tuned Firmware Constants (Feb 04 2026)

Following the calibration of the hardware timing (P99 Analysis) and the topology switch to **4 Sensors per Node**, the following constants have been optimized for stability and 200Hz performance.

## 1. Topology Constraints
| Parameter | Value | Reason |
| :--- | :--- | :--- |
| **Max Sensors** | **4** | Reduces per-node I2C processing load from ~6.9ms to ~3.2ms, fitting comfortably within the 20ms TDMA frame. |
| **Max Nodes** | **4** | Allows full coverage (16 sensors total) within a single RF channel. |
| **Frame Rate** | **50 Hz** (Radio) | Carries 200Hz Data (4-sample batching). 20ms Frame Period. |

## 2. TDMA Slot Tuning (`TDMAProtocol.h`)
The previous 8ms slot width (designed for 8 sensors/node) was too large for multi-node setups, causing frame overruns.

| Constant | Old Value | New Value | Notes |
| :--- | :--- | :--- | :--- |
| `TDMA_SLOT_MIN_WIDTH_US` | 8000 (8ms) | **2500 (2.5ms)** | Allows 4 nodes to fit in a 20ms frame (4x2.5=10ms utilized). |
| `TDMA_SLOT_BASE_US` | 800 | **200** | Airtime scaling per sensor is minimal with ESP-NOW. |
| `TDMA_SLOT_OVERHEAD_US` | 2000 | **1000** | Revised based on actual packet build/ack measurement (~0us reported, safe margin added). |

## 3. Predicted Performance
- **Airtime per Node (4 sensors):** ~1000µs (estimated).
- **Allocated Slot:** 2500µs.
- **Margin:** ~1500µs per node.
- **I2C Blocking Time (Local):** ~3200µs (runs asynchronously to other nodes' slots).
- **Frame Utilization:** ~50% (10ms used / 20ms total).

## 4. Required Actions
1. **Flash Gateway:** Critical to update the Scheduler logic.
2. **Flash All Nodes:** Critical to apply the new Slot/Pipelining logic.
