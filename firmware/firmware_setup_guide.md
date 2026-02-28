# IMU Connect Firmware Setup Guide

This guide explains the hybrid firmware architecture and how to flash each device type.

## Firmware Variants

| Folder | Role | Use Case |
|--------|------|----------|
| `IMUConnect/` | **Standalone** | Single device → BLE/WiFi to PC |
| `MASH_Gateway/` | **Gateway** | Receives ESP-NOW from Nodes → forwards to PC via BLE |
| `MASH_Node/` | **Node** | Reads sensors → sends to Gateway via ESP-NOW |

---

## Directory Structure

```
firmware/
├── IMUConnect/              # Standalone firmware (legacy)
│   └── IMUConnect.ino
│
├── MASH_Gateway/      # Gateway-only (NO sensors)
│   └── MASH_Gateway.ino
│
├── MASH_Node/         # Node (reads sensors, ESP-NOW to Gateway)
│   └── MASH_Node.ino
│
└── libraries/
    └── IMUConnectCore/      # Shared library (auto-installed)
        └── src/
            ├── ConfigBase.h
            ├── TDMAProtocol.h
            ├── Quaternion.h
            └── PacketTypes.h
```

---

## Required Libraries

Install these via Arduino IDE Library Manager or Arduino CLI:

```
Adafruit NeoPixel
ArduinoJson
Adafruit ICM20649
Adafruit BMP3XX Library
Adafruit MMC56x3
WebSockets
```

**For ESP32 Core 3.x compatibility**, install these from GitHub (mathieucarbou forks):
- AsyncTCP: https://github.com/mathieucarbou/AsyncTCP
- ESPAsyncWebServer: https://github.com/mathieucarbou/ESPAsyncWebServer

---

## Flashing Instructions

### 1. Gateway Device
1. Open `MASH_Gateway/MASH_Gateway.ino` in Arduino IDE
2. Select Board: **Adafruit QT Py ESP32-S3**
3. Click **Upload**
4. Device will advertise as `IMU-Connect_Gateway`
5. LED: **Purple** when ready

### 2. Node Device(s)
1. Open `MASH_Node/MASH_Node.ino`
2. **IMPORTANT**: Edit `SENSOR_ID_OFFSET` at the top:
   - Node 1: `#define SENSOR_ID_OFFSET 0`
   - Node 2: `#define SENSOR_ID_OFFSET 8`
   - Node 3: `#define SENSOR_ID_OFFSET 16`
3. Upload to device
4. Device will advertise as `IMU-Connect_Node_X` (for calibration)
5. LED: **Cyan** when ready, **Green** when streaming

### 3. Standalone Device (Original Use)
1. Open `IMUConnect/IMUConnect.ino`
2. Upload - behaves like original firmware
3. LED: **Blue** when ready

---

## Shared Library (IMUConnectCore)

The shared library is automatically installed to your Arduino libraries folder. It contains:

- **TDMAProtocol.h** - TDMA timing, packet structures, helper functions
- **Quaternion.h** - Quaternion data structure for orientations
- **ConfigBase.h** - Shared constants (pins, BLE UUIDs, timing)
- **PacketTypes.h** - ESP-NOW packet definitions

The library is located at:
- Source: `firmware/libraries/IMUConnectCore/`
- Installed: `Documents/Arduino/libraries/IMUConnectCore/`

---

## Quick Reference

| Role | Advertises As | LED Color | Sensors |
|------|---------------|-----------|---------|
| Standalone | `IMU-Connect` | Blue → Green | Yes |
| Gateway | `IMU-Connect_Gateway` | Purple | No |
| Node | `IMU-Connect_Node_X` | Cyan → Green | Yes |
