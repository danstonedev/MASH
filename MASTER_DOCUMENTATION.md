# IMU Connect - Master Documentation

> [!IMPORTANT]
> This document serves as the single source of truth for the IMU Connect system. It supersedes `firmware_spec.md` and `prompt_for_developer.md`.

## 1. System Overview

**IMU Connect** is a high-performance biomechanics streaming platform designed for real-time motion capture using ESP32-S3 hardware.

### Architecture
The system follows a star topology with a central Gateway bridging wireless Nodes to the Web Dashboard.

```mermaid
graph TD
    Node1[Node 1\n(Right Leg)] -->|ESP-NOW| Gateway[Gateway\n(Base Station)]
    Node2[Node 2\n(Left Leg)] -->|ESP-NOW| Gateway
    Node3[Node 3\n(Pelvis)] -->|ESP-NOW| Gateway
    Gateway -->|USB Serial (Web Serial)| WebApp[Web Dashboard\n(React + Three.js)]
```

*   **Nodes**: Read sensor data (ICM-20948/42688 + BMP390), perform sensor fusion (Madgwick), and broadcast via ESP-NOW.
*   **Gateway**: Aggregates packets from all nodes and forwards them to the PC via USB Serial (Web Serial).
*   **Web App**: Visualizes data in real-time using a Skeletal Model (Inverse/Forward Kinematics) and standardizes data flow via `useDeviceStore`.

---

## 2. Firmware Specification

### 2.1 Communication Protocol
*   **Transport**: USB Serial (Web Serial)
*   **Framing**: Length-prefixed frames `[len_lo][len_hi][frame...]` streamed over USB
*   **Commands**: Newline-delimited JSON sent from Web App to Gateway
*   **Responses**: JSON frames (`0x06`) in the same stream

### 2.2 Data Packet Format (Production)
The system uses **SyncFrame packets (0x25/0x27)** for synchronized multi-sensor data. Legacy BLE packet formats are deprecated.

> [!NOTE]
> The legacy BLE/NUS section and 0x03 packet format are retained here for reference only.

| Offset | Field | Type | Scaling / value |
| :--- | :--- | :--- | :--- |
| 0 | Packet Header | `uint8` | `0x03` (Extended Data) |
| 1 | Node ID | `uint8` | `0..255` (Derived from MAC) |
| 2-3 | Quaternion W | `int16` | Value / 16384.0 |
| 4-5 | Quaternion X | `int16` | Value / 16384.0 |
| 6-7 | Quaternion Y | `int16` | Value / 16384.0 |
| 8-9 | Quaternion Z | `int16` | Value / 16384.0 |
| 10-11 | Accel X | `int16` | Value / 100.0 (m/s²) |
| 12-13 | Accel Y | `int16` | Value / 100.0 |
| 14-15 | Accel Z | `int16` | Value / 100.0 |
| 16-17 | Gyro X | `int16` | Value / 100.0 (Rad/s typically) |
| 18-19 | Gyro Y | `int16` | Value / 100.0 |
| 20-21 | Gyro Z | `int16` | Value / 100.0 |
| 22-25 | Timestamp | `uint32` | Milliseconds |

> [!WARNING]
> **Unit Mismatch Note**: Firmware sends Gyro in Rad/s * 100. Web App `CustomESP32Device` interprets as raw float. `IMUParser` (legacy) converts to Deg/s. Ensure visualization expects Radians.

---

## 3. Deployment Guide

### 3.1 Flashing the Firmware
The codebase handles three roles using the defined `#define DEVICE_ROLE` macro.

#### Gateway Device
1.  Open `MASH_Gateway/MASH_Gateway.ino`.
2.  Target: **Adafruit QT Py ESP32-S3**.
3.  Flash.
4.  LED should turn **Purple**. Advertises as `IMU-Connect_Gateway`.

#### Node Device
1.  Open `MASH_Node/MASH_Node.ino`.
2.  Flash.
3.  LED should turn **Cyan** (Standby) or **Green** (Streaming).
4.  **Auto-ID**: Node ID is automatically derived from the last byte of the MAC address. No manual configuration needed.

### 3.2 Web Application
1.  **Install**: `npm install`
2.  **Run**: `npm run dev`
3.  **Build**: `npm run build`

---

## 4. Troubleshooting

| Issue | Probable Cause | Fix |
| :--- | :--- | :--- |
| **Drift / Spinning** | Magnetometer interference or Gyro Bias | Place device on flat surface for 10s on boot (Auto-Cal runs). |
| **No Data (Web)** | Wrong BLE Service UUID or device not connected | Check `useDeviceStore` connection state. Ensure Gateway LED is Purple. |
| **Nodes not Syncing** | WiFi Channel Mismatch | Gateway syncs ESP-NOW channel to WiFi channel. Ensure Nodes are on same channel (set in `Config.h`). |

## 5. Development Resources

*   **Deep Dive Audit**: See `.gemini/antigravity/brain/<id>/AUDIT_REPORT.md` for detailed code analysis and math verification.
*   **Workflow**: All artifacts located in `.gemini/antigravity/brain/`.
