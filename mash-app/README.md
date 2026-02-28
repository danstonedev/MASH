# IMU Connect

Real-time biomechanical motion capture using ESP32-based IMU sensors with Three.js visualization.

## Features

- **Multi-Sensor Support**: Up to 8 IMUs per node via TCA9548A multiplexer
- **Gateway/Node Architecture**: ESP-NOW mesh networking with BLE bridge
- **3D Visualization**: Mixamo skeleton with real-time quaternion-based animation
- **PhD-Level Calibration**: 3-level taring pipeline (Mounting → Heading → Joint)
- **Sensor Fusion**: On-board Madgwick filter with adaptive gating

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173 and connect to your IMU device via Web Bluetooth.

## Architecture

```
ESP32 Nodes (IMU Sensors)
     ↓ ESP-NOW
ESP32 Gateway
     ↓ BLE/WiFi
Web Application (React + Three.js)
```

## Key Components

| Component | Description |
|-----------|-------------|
| Device Registry | Manages sensor connections and data routing |
| Calibration Store | T-pose capture and offset calculation |
| Orientation Processor | Quaternion pipeline with ROM constraints |
| Skeleton Model | Three.js bone hierarchy rendering |

## Packet Formats

| ID | Name | Description |
|----|------|-------------|
| 0x01 | Raw IMU | Float32 accel/gyro (29 bytes/sensor) |
| 0x02 | Quaternion | Compact int16 quaternions (9 bytes/sensor) |
| 0x03 | Extended | Quaternion + accel + gyro int16 (21 bytes/sensor) |
| 0x04 | Environmental | Magnetometer + barometer data |
| 0x05 | Node Info | Sensor topology discovery |

## Sample Rates

- **50 Hz** - Low power mode
- **100 Hz** - Research standard (default)
- **200 Hz** - Sport mode (high dynamics)

## Documentation

- [Calibration Guide](docs/CalibrationGuide.md)
- [Firmware Architecture](../ESP32_App/BigPicture/architecture.md)
- [Packet Definitions](../ESP32_App/BigPicture/packets.md)

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite
- **3D**: Three.js, React Three Fiber
- **State**: Zustand
- **Firmware**: ESP32-S3, Arduino IDE

## License

MIT
