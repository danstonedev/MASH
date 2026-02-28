# IMUConnectCore Library

Shared core library for IMU Connect Gateway and Node firmware.

## Overview

This library contains common code shared between the Gateway and Node firmware variants:

- **ConfigBase.h** - Shared configuration constants (pins, sensor settings, BLE UUIDs, etc.)
- **TDMAProtocol.h** - TDMA protocol definitions, packet structures, and helper functions
- **Quaternion.h** - Quaternion data structure for orientation representation
- **PacketTypes.h** - ESP-NOW packet type definitions

## Installation

### Arduino IDE

1. Copy the `IMUConnectCore` folder to your Arduino libraries folder:
   - Windows: `Documents\Arduino\libraries\`
   - macOS: `~/Documents/Arduino/libraries/`
   - Linux: `~/Arduino/libraries/`

2. Restart Arduino IDE

3. The library should appear under `Sketch > Include Library > IMUConnectCore`

## Usage

### Include All Components

```cpp
#include <IMUConnectCore.h>
```

### Include Individual Components

```cpp
#include <ConfigBase.h>
#include <TDMAProtocol.h>
#include <Quaternion.h>
#include <PacketTypes.h>
```

## Key Features

### Multi-Sensor Packet Size Management

The library includes comprehensive documentation and helper functions for managing ESP-NOW packet sizes with varying sensor counts:

```cpp
// Calculate max samples that fit in one ESP-NOW packet
uint8_t maxSamples = calculateMaxSamplesPerPacket(sensorCount);

// Calculate packets needed per TDMA frame (4 samples at 200Hz)
uint8_t packetsNeeded = calculatePacketsPerFrame(sensorCount);

// Calculate slot width for a node
uint16_t slotWidth = calculateSlotWidth(sensorCount);
```

### Sensor Count Limits

| Sensors | Max Samples/Packet | Packets/Frame |
| ------- | ------------------ | ------------- |
| 1-2     | 4 (capped)         | 1             |
| 3       | 3                  | 2             |
| 4-5     | 2                  | 2             |
| 6-11    | 1                  | 4             |
| 12+     | N/A                | UNSUPPORTED   |

### Quaternion Operations

```cpp
Quaternion q(1.0f, 0.0f, 0.0f, 0.0f);  // Identity quaternion
q.normalize();                          // Normalize to unit length

// Convert to int16 for transmission
int16_t w = q.wInt16();  // Scaled by 16384

// Reconstruct from int16
Quaternion q2 = Quaternion::fromInt16(w, x, y, z);
```

## Migration Guide

The existing Gateway and Node firmware have local copies of these files. To migrate:

1. Install this library
2. Remove local copies of:
   - `TDMAProtocol.h` (use `#include <TDMAProtocol.h>`)
   - `Quaternion.h` (use `#include <Quaternion.h>`)
3. Update `Config.h` to include `ConfigBase.h` and only override project-specific values

## Version History

- **1.0.0** - Initial release
  - Consolidated TDMAProtocol.h from Gateway/Node
  - Consolidated Quaternion.h from Gateway/Node
  - Created ConfigBase.h with shared constants
  - Created PacketTypes.h with ESP-NOW packet definitions
  - Added multi-sensor packet size documentation and helpers
  - Added 6ms minimum slot width for 200Hz sample alignment
