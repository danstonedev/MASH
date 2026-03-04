# MASH — Motion Analysis Sensor Hub

Real-time biomechanical motion capture using ESP32-based IMU sensors with Three.js visualization.

## Features

- **Multi-Sensor Support**: Up to 8 IMUs per node via TCA9548A multiplexer
- **Gateway/Node Architecture**: ESP-NOW TDMA mesh networking with USB serial bridge
- **3D Visualization**: Mixamo skeleton with real-time quaternion-based animation
- **PhD-Level Calibration**: 3-level taring pipeline (Mounting → Heading → Joint)
- **Sensor Fusion**: On-board VQF (Versatile Quaternion-based Filter) with adaptive gating

## Quick Start

```bash
cd mash-app
npm install
npm run dev
```

Open http://localhost:5173 and connect to your Gateway via WebSerial (USB).

## Architecture

```
ESP32-S3 Nodes (IMU Sensors)
     ↓ ESP-NOW (TDMA 50Hz)
ESP32-S3 Gateway
     ↓ USB Serial (WebSerial API)
Web Application (React + Three.js)
```

## Key Components

| Component | Description |
|-----------|-------------|
| Device Registry | Manages sensor connections and data routing |
| Calibration Store | Unified calibration with quality scoring |
| Orientation Processor | Quaternion pipeline with ROM constraints |
| Skeleton Model | Three.js bone hierarchy rendering |
| Kinematics Engine | Joint angle computation via forward kinematics |

## Packet Formats

| ID | Name | Description |
|----|------|-------------|
| 0x01 | Raw IMU | Float32 accel/gyro (29 bytes/sensor) |
| 0x02 | Quaternion | Compact int16 quaternions (9 bytes/sensor) |
| 0x03 | Extended | Quaternion + accel + gyro int16 (21 bytes/sensor) |
| 0x04 | Environmental | Magnetometer + barometer data |
| 0x05 | Node Info | Sensor topology discovery |
| 0x25 | Sync Frame | Timestamped frame with physical identity |

## Sample Rates

- **50 Hz** — TDMA frame rate (on-air)
- **200 Hz** — On-board sampling (4-sample batching)

## Documentation

- [Firmware Setup Guide](firmware/firmware_setup_guide.md)
- [TDMA Protocol Audit](docs/TDMA_PROTOCOL_AUDIT.md)
- [Calibration Strategy](docs/CALIBRATION_STRATEGY.md)
- [Sync Architecture](docs/SYNC_FRAME_ARCHITECTURE_ANALYSIS.md)

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite
- **3D**: Three.js, React Three Fiber
- **State**: Zustand (persisted)
- **Firmware**: ESP32-S3, Arduino, ESP-NOW
- **Deployment**: Azure Static Web Apps

## License

MIT
