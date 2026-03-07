# Firmware Modification Request: Add Accel/Gyro to Quaternion Packet

**To:** Firmware Developer (Arduino Agent)
**From:** Web Client Developer (Antigravity)
**Date:** 2025-12-15
**Priority:** High

---

## Background

The current **0x02 Quaternion Packet** only contains orientation data (W, X, Y, Z as int16). We need to add raw accelerometer and gyroscope readings to enable:
1. **Live telemetry display** (acceleration in m/s², angular velocity in °/s)
2. **Impact detection** (sudden acceleration spikes)
3. **Speed skating analytics** (push-off force estimation, blade angle vs. acceleration correlation)

---

## Current Packet Format (0x02)

```
Header: [0x02] [SensorCount]
Per Sensor (9 bytes): [ID:1] [W:2] [X:2] [Y:2] [Z:2]
```

**Total per sensor:** 9 bytes
**Scaling:** `Int16 / 16384.0` for quaternion components

---

## Proposed Packet Format (0x03) - Extended Quaternion

```
Header: [0x03] [SensorCount]
Per Sensor (21 bytes):
  [ID:1]
  [W:2] [X:2] [Y:2] [Z:2]  // Quaternion (int16, /16384)
  [Ax:2] [Ay:2] [Az:2]     // Accelerometer (int16, raw or /16384 = g's)
  [Gx:2] [Gy:2] [Gz:2]     // Gyroscope (int16, raw or /16.4 = °/s)
```

**Total per sensor:** 21 bytes (was 9)

### Scaling Recommendations

| Field | Type | Scaling | Units | Notes |
|-------|------|---------|-------|-------|
| Quaternion (W,X,Y,Z) | int16 | ÷ 16384 | unitless | Keep existing |
| Accel (Ax,Ay,Az) | int16 | ÷ 2048 | g | Standard for ±16g range |
| Gyro (Gx,Gy,Gz) | int16 | ÷ 16.4 | °/s | Standard for ±2000°/s range |

> **Note:** If using LSB values directly from MPU-6050/ICM-20948, the scaling factors are built-in. Just send raw int16 sensor readings.

---

## Bandwidth Calculation

| Config | Bytes/Sensor | @ 120Hz | @ 2 Sensors |
|--------|--------------|---------|-------------|
| Current (0x02) | 9 | 1080 B/s | 2160 B/s |
| Proposed (0x03) | 21 | 2520 B/s | 5040 B/s |

**BLE Theoretical Max:** ~23 KB/s (with connection interval optimization)
**Verdict:** ✅ Well within limits, even at 120Hz with 2 sensors.

---

## Client-Side Changes (I Will Handle)

1. **Parser Update:** Add `0x03` case to `IMUParser.ts`
2. **Device Registry:** Store accel/gyro in device state
3. **Telemetry HUD:** Display live values
4. **Telemetry Chart:** Plot accel/gyro time series

---

## Implementation Request

Please implement **one** of these options:

### Option A: New Packet Type (Preferred)
- Keep **0x02** as-is for backward compatibility
- Add new **0x03** packet type with extended data
- Add command: `{"cmd": "SET_OUTPUT_MODE", "mode": "quaternion_extended"}`

### Option B: Modify Existing 0x02
- Extend the 0x02 packet to include accel/gyro
- May break existing clients (but we control both ends)

---

## Questions for Firmware Developer

1. **Sensor Data Availability:** Are raw accel/gyro values already being read on each fusion loop iteration? (They should be, for Madgwick input)

2. **Timing:** Can you include accel/gyro without impacting the 120Hz rate?

3. **Preferred Scaling:** Would you prefer to send:
   - Raw sensor LSB values (I'll scale client-side)
   - Pre-scaled floating point (uses more bandwidth)
   - Fixed-point scaled int16 (best balance)

4. **ETA:** Rough estimate for implementation?

---

## Next Steps

1. **You:** Confirm feasibility and preferred approach
2. **You:** Implement and deploy firmware update
3. **Me:** Update parser and UI to consume new data
4. **Test:** Verify end-to-end data flow

---

Let me know if you have questions or want to discuss alternatives!

🔧 Ready when you are.
