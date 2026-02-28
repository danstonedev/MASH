# Packet Definitions — IMU Connect Protocol

## Purpose
Define the binary and JSON packet formats used for communication between firmware and web app.

---

## BLE Packet Formats

### Format 0x01 — Raw IMU Data
Original format for raw accelerometer + gyroscope data.

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| `format` | uint8 | 1 | 0x01 |
| `sensorCount` | uint8 | 1 | Number of sensors in packet |
| **Per Sensor:** |  |  |  |
| `sensorId` | uint8 | 1 | Sensor index (0-7) |
| `timestamp` | uint32 | 4 | Milliseconds since boot |
| `accelX` | float32 | 4 | m/s² |
| `accelY` | float32 | 4 | m/s² |
| `accelZ` | float32 | 4 | m/s² |
| `gyroX` | float32 | 4 | rad/s |
| `gyroY` | float32 | 4 | rad/s |
| `gyroZ` | float32 | 4 | rad/s |

**Per-sensor size**: 25 bytes
**Max MTU**: 512 bytes → ~20 sensors

---

### Format 0x02 — Quaternion Only
Compact quaternion output from on-board fusion.

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| `format` | uint8 | 1 | 0x02 |
| `sensorCount` | uint8 | 1 | Number of sensors |
| **Per Sensor:** |  |  |  |
| `sensorId` | uint8 | 1 | Sensor index |
| `timestamp` | uint32 | 4 | Milliseconds |
| `qW` | float32 | 4 | Quaternion W |
| `qX` | float32 | 4 | Quaternion X |
| `qY` | float32 | 4 | Quaternion Y |
| `qZ` | float32 | 4 | Quaternion Z |

**Per-sensor size**: 21 bytes

---

### Format 0x03 — Quaternion Extended (Default)
Full quaternion + raw data for calibration and debugging.

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| `format` | uint8 | 1 | 0x03 |
| `sensorCount` | uint8 | 1 | Number of sensors |
| **Per Sensor:** |  |  |  |
| `sensorId` | uint8 | 1 | Sensor index |
| `timestamp` | uint32 | 4 | Milliseconds |
| `qW` | float32 | 4 | Quaternion W |
| `qX` | float32 | 4 | Quaternion X |
| `qY` | float32 | 4 | Quaternion Y |
| `qZ` | float32 | 4 | Quaternion Z |
| `accelX` | float32 | 4 | m/s² |
| `accelY` | float32 | 4 | m/s² |
| `accelZ` | float32 | 4 | m/s² |
| `gyroX` | float32 | 4 | rad/s (optional) |
| `gyroY` | float32 | 4 | rad/s (optional) |
| `gyroZ` | float32 | 4 | rad/s (optional) |

**Per-sensor size**: 45 bytes

---

## JSON Command Protocol

### Command Format
All commands are JSON objects with a `cmd` field:

```json
{"cmd": "COMMAND_NAME", "param1": value1, ...}
```

### Response Format

**Success:**
```json
{"success": true, "message": "Description"}
```

**Error:**
```json
{"success": false, "error": "Error description"}
```

---

### Available Commands

| Command | Parameters | Description |
|---------|------------|-------------|
| `START` | — | Begin data streaming |
| `STOP` | — | Stop data streaming |
| `SET_RATE` | `rate`: 30/60/120 | Set sample rate (Hz) |
| `SET_ACCEL_RANGE` | `range`: 4/8/16/30 | Accel range (±g) |
| `SET_GYRO_RANGE` | `range`: 500/1000/2000/4000 | Gyro range (±dps) |
| `GET_STATUS` | — | Get device status |
| `CALIBRATE` | `sensor`: 0-7 | Calibrate sensor |
| `GET_CALIBRATION` | `sensor`: 0-7 | Get calibration data |
| `SET_OUTPUT_MODE` | `mode`: raw/quaternion/quaternion_extended | Output format |
| `SET_FILTER_BETA` | `beta`: 0.01-1.0 | Madgwick gain |
| `SET_NAME` | `name`: string | Set device name |
| `SET_SYNC_ROLE` | `role`: master/slave/auto | ESP-NOW sync role |
| `SET_WIFI` | `ssid`, `password` | Configure WiFi |
| `SWITCH_MODE` | `mode`: ble/wifi | Switch connectivity |

---

### GET_STATUS Response

```json
{
    "type": "status",
    "sensorCount": 3,
    "isStreaming": true,
    "sampleRate": 120,
    "mode": "ble",
    "outputMode": "quaternion_extended",
    "wifiConnected": false,
    "calibratedCount": 2,
    "calibration": [true, true, false]
}
```

---

### GET_CALIBRATION Response

```json
{
    "type": "calibration",
    "sensorId": 0,
    "isCalibrated": true,
    "accelOffset": {"x": 0.05, "y": -0.02, "z": 0.15},
    "gyroOffset": {"x": 0.001, "y": -0.003, "z": 0.002}
}
```

---

## ESP-NOW Packet Format (Multi-Node)

### IMU_FRAME Packet

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| `node_id` | uint8 | 1 | Node identifier (A=0, B=1, C=2, D=3) |
| `packet_type` | uint8 | 1 | 0x10 = IMU_FRAME |
| `sample_index` | uint16 | 2 | Frame counter |
| `t_local_usec` | uint64 | 8 | Synchronized timestamp (μs) |
| `n_imus` | uint8 | 1 | Number of IMUs in packet |
| `flags` | uint8 | 1 | Bit flags (TBD) |
| **Per IMU:** |  |  |  |
| `slot` | uint8 | 1 | IMU slot on multiplexer |
| `ax`, `ay`, `az` | int16 ×3 | 6 | Accel (raw ADC units) |
| `gx`, `gy`, `gz` | int16 ×3 | 6 | Gyro (raw ADC units) |

### SYNC_BEACON Packet

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| `packet_type` | uint8 | 1 | 0x20 = SYNC_BEACON |
| `hub_time_usec` | uint64 | 8 | Hub's local time |
| `frame_counter` | uint32 | 4 | Monotonic counter |
| `flags` | uint8 | 1 | Sync status flags |

---

## Quaternion Convention

**Firmware (IMU)**: `[w, x, y, z]` — scalar-first
**Three.js**: `Quaternion(x, y, z, w)` — scalar-last

**Coordinate Conversion** (IMU → Three.js):
```typescript
// IMU: X-right, Y-forward, Z-up
// Three.js: X-right, Y-up, Z-forward (towards camera)
const [w, x, y, z] = cached;
const threeQuat = new THREE.Quaternion(x, z, -y, w);
```
