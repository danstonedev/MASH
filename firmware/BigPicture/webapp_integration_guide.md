# Web App Integration Guide — Firmware V2 Changes

## Summary for Web App Developer

The firmware is adding support for **optional sensors** (magnetometer, barometer) with **auto-detection**. The data stream will include new fields when these sensors are present. The web app must be updated to:

1. Parse the **0x03 packet format** (currently missing)
2. Handle **new fields in GET_STATUS** response
3. Optionally display magnetometer and barometer data

---

## Critical: Missing 0x03 Parser

The firmware default is `OUTPUT_QUATERNION_EXTENDED` (0x03), but **CustomESP32Device.ts only parses 0x01 and 0x02**!

### Current Format 0x03 (Firmware)
```
[0x03] [count] [timestamp(4)] [per sensor: id(1) + quat(8) + accel(6) + gyro(6)]
```

### Recommended Fix in `CustomESP32Device.ts`

Add after line 107:

```typescript
// --- FORMAT D (0x03 Extended Quaternion): quat + accel + gyro ---
// [PacketID(1)=0x03] [Count(1)] [Timestamp(4)] [ID(1) quat(8) accel(6) gyro(6)]...
if (len >= 6 && data.getUint8(0) === 0x03) {
    const sensorCount = data.getUint8(1);
    const timestamp = data.getUint32(2, true);
    let offset = 6;
    const stride = 21; // 1 + 8 + 6 + 6

    for (let i = 0; i < sensorCount; i++) {
        if (offset + stride > len) break;

        const id = data.getUint8(offset);
        
        // Quat as int16 / 16384
        const w = data.getInt16(offset + 1, true) / 16384.0;
        const x = data.getInt16(offset + 3, true) / 16384.0;
        const y = data.getInt16(offset + 5, true) / 16384.0;
        const z = data.getInt16(offset + 7, true) / 16384.0;
        
        // Accel as int16 / 100 (m/s²)
        const ax = data.getInt16(offset + 9, true) / 100.0;
        const ay = data.getInt16(offset + 11, true) / 100.0;
        const az = data.getInt16(offset + 13, true) / 100.0;
        
        // Gyro as int16 / 100 (rad/s)
        const gx = data.getInt16(offset + 15, true) / 100.0;
        const gy = data.getInt16(offset + 17, true) / 100.0;
        const gz = data.getInt16(offset + 19, true) / 100.0;

        packets.push({
            sensorId: id,
            quaternion: [w, x, y, z],
            accelerometer: [ax, ay, az],
            gyro: [gx, gy, gz],
            battery: 50, // Not in packet
            timestamp: timestamp
        });

        offset += stride;
    }
    return packets;
}
```

---

## GET_STATUS Response Changes

### Current Response
```json
{
  "sensorCount": 3,
  "isStreaming": true,
  "calibratedCount": 2,
  "calibration": [true, true, false]
}
```

### New Response (V2)
```json
{
  "sensorCount": 3,
  "isStreaming": true,
  "calibratedCount": 2,
  "calibration": [true, true, false],
  "hasMagnetometer": true,
  "hasBarometer": true,
  "magnetometer": {"x": 12.3, "y": -4.5, "z": 38.2},
  "barometer": {"pressure": 1013.25, "temperature": 24.5, "altitude": 45.2}
}
```

### Handling in Web App

Update any code parsing GET_STATUS to handle new optional fields:

```typescript
interface DeviceStatus {
  sensorCount: number;
  isStreaming: boolean;
  calibratedCount: number;
  calibration: boolean[];
  // New optional fields
  hasMagnetometer?: boolean;
  hasBarometer?: boolean;
  magnetometer?: { x: number; y: number; z: number };
  barometer?: { pressure: number; temperature: number; altitude: number };
}
```

---

## UI Suggestions

### Status Panel Additions
When `hasMagnetometer: true`:
- Show magnetometer icon
- Optionally display heading/compass

When `hasBarometer: true`:
- Show barometer icon
- Display altitude (useful for jump detection)

### Graceful Degradation
The web app should work identically when these sensors are absent. Only show UI elements if `hasMagnetometer === true` etc.

---

## Binary Packet Summary

| Format ID | Header | Per-Sensor Data | Notes |
|-----------|--------|-----------------|-------|
| 0x01 | [id][count] | id(1) + ts(4) + accel(12) + gyro(12) = 29B | Raw float32 |
| 0x02 | [id][count] | id(1) + quat(8) = 9B | Compact quaternion |
| **0x03** | [id][count][ts(4)] | id(1) + quat(8) + accel(6) + gyro(6) = 21B | **Default, extended** |

---

## No Data Stream Changes for Optional Sensors

Magnetometer and barometer data are **NOT** in the BLE data stream—they're only in `GET_STATUS` responses (polled, not streamed). This keeps the high-frequency IMU stream unchanged.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/ble/CustomESP32Device.ts` | Add 0x03 parser (critical!) |
| `src/lib/ble/DeviceInterface.ts` | Add optional `magnetometer`, `barometer` to status type if needed |
| Status display components | Show mag/baro data when available |
