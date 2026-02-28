# Calibration Protocol — V1

## Purpose

Define the complete calibration workflow for the biomechanics suit, from initial mounting validation through to runtime quaternion application.

---

## Calibration Layers

The system has **two calibration layers**:

| Layer                  | Location         | Purpose                                  |
| ---------------------- | ---------------- | ---------------------------------------- |
| **Sensor Calibration** | Firmware (ESP32) | Zero accel/gyro offsets at rest          |
| **Pose Calibration**   | Web App          | Align sensor frame to body segment frame |

---

## Layer 1: Sensor Calibration (Firmware)

### When to Run

- First power-on after mounting
- If drift is observed
- After physical adjustment of sensor position

### Procedure

1. Place device in known orientation (flat on table, Z-up)
2. Send command: `{"cmd": "CALIBRATE", "sensor": 0}`
3. Keep still for 1 second (100 samples)
4. Firmware calculates offsets:
   - `accelOffset = mean(samples) - [0, 0, 9.81]`
   - `gyroOffset = mean(samples)`
5. Offsets saved to NVS (persist across reboots)

### Verification

- Send `{"cmd": "GET_CALIBRATION", "sensor": 0}`
- Check offsets are reasonable (gyro < 0.1 rad/s, accel < 0.5 m/s²)
- GET_STATUS includes `calibratedCount` and per-sensor boolean

---

## Layer 2: Pose Calibration (Web App)

### Pose Calibration When to Run

- Every session before capture
- After changing sensor placement
- If skeleton visually misaligns

### T-Pose Calibration (Current Implementation)

```text
SUBJECT POSITION:
- Stand upright, arms at 45° (relaxed T)
- Face forward, feet shoulder-width apart
- Keep still for 3-second countdown

WHAT HAPPENS:
1. Web app captures sensor quaternions (q_sensor)
2. Web app has target bone quaternions (q_body) from skeleton neutral pose
3. Offset = inv(q_sensor) * q_body
4. At runtime: bone_rotation = sensor_quaternion * offset
```

### Calibration Steps (V1 Full Protocol)

| Step                          | Duration | Purpose                            |
| ----------------------------- | -------- | ---------------------------------- |
| 1. Mounting Validation        | 30s      | Verify sensors attached correctly  |
| 2. Static Calibration (T-Pose)| 5s       | Compute sensor-to-body offsets     |
| 3. Functional Calibration     | 20s      | Optional: hip/knee ROM validation  |
| 4. Magnetometer Calibration   | 15s      | Figure-8 motion for heading        |
| 5. Validation Movements       | 10s      | Squat/arm raise to verify          |

---

## Mounting Validation (Step 1)

Before calibration, verify:

- [ ] All sensors detected (GET_STATUS shows correct count)
- [ ] Segments assigned correctly in web app
- [ ] No loose connections (stable quaternion stream)
- [ ] Sensors oriented consistently (X-forward, Z-up when standing)

---

## Static Calibration (Step 2)

**Current Implementation**: Single T-Pose capture

```typescript
// From useCalibrationStore.ts
captureTPose() {
    // 1. Read sensor quaternions from cache
    // 2. Apply IMU→Three.js coordinate conversion
    // 3. Store as tPoseSensorData
    // 4. Immediately calculate offsets
}

calculateCalibration() {
    // offset = inv(q_sensor_tpose) * q_body_tpose
    // Save to sensorOffsets map
}
```

---

## Functional Calibration (Step 3) — Future

For joints with primary axes (hip flexion, knee flexion):

1. Perform slow ROM movement
2. Identify principal rotation axis
3. Align joint coordinate system

---

## Magnetometer Calibration (Step 4)

### Magnetometer Purpose

Magnetometers are affected by:

- **Hard Iron Distortion**: Constant magnetic fields from nearby ferrous materials (produces offset bias)
- **Soft Iron Distortion**: Field distortions from nearby conductive materials (produces scale/axis errors)

Calibration computes compensation values to correct for both effects.

### Magnetometer When to Run

- First power-on with magnetometer installed
- After changing sensor mounting location
- When compass heading is inaccurate
- If device enclosure changes

### Procedure (Figure-8 Motion)

1. Navigate to Settings → Magnetometer Calibration in web app
2. Select calibration duration (15s recommended)
3. Click "Start Calibration"
4. **Slowly** rotate the sensor in a figure-8 pattern:
   - Tilt forward/backward
   - Roll left/right  
   - Rotate around vertical axis
   - Cover ALL orientations over the calibration period
5. Keep moving until progress reaches 100%
6. Calibration data auto-saves to device NVS

### Firmware Implementation

```cpp
// SensorManager automatically tracks min/max values during calibration
// Hard iron offset = center of ellipsoid (average of min/max)
hardIronX = (maxX + minX) / 2.0f;
hardIronY = (maxY + minY) / 2.0f;
hardIronZ = (maxZ + minZ) / 2.0f;

// Soft iron scale = normalize axes to average radius
rangeX = (maxX - minX) / 2.0f;
avgRange = (rangeX + rangeY + rangeZ) / 3.0f;
softIronScaleX = avgRange / rangeX;
```

### Magnetometer Verification

- Send `{"cmd": "GET_MAG_CALIBRATION"}` to retrieve calibration data
- Check that hard iron offsets are reasonable (typically < 100 μT)
- Soft iron scales should be close to 1.0 (0.8 - 1.2 typical)
- Heading should be stable when sensor is stationary

### Magnetometer Commands

| Command                  | Parameters                     | Description                        |
| ------------------------ | ------------------------------ | ---------------------------------- |
| `CALIBRATE_MAG`          | `duration` (ms, default 15000) | Start magnetometer calibration     |
| `GET_MAG_CALIBRATION`    | none                           | Get calibration status and data    |
| `CLEAR_MAG_CALIBRATION`  | none                           | Clear saved calibration            |

### Magnetometer Troubleshooting

| Issue                       | Likely Cause         | Fix                                  |
| --------------------------- | -------------------- | ------------------------------------ |
| Calibration fails           | Not enough rotation  | Move slower, cover all axes          |
| Heading still drifts        | Nearby interference  | Move away from metal/electronics     |
| Scale factors very unequal  | Soft iron distortion | May need advanced ellipsoid fitting  |

---

## Validation Movements (Step 5)

Quick checks to verify calibration:

1. **Squat**: Knees should track correctly
2. **Arm Raise**: Arms should follow smoothly
3. **Hip Rotation**: Pelvis should rotate without leg artifacts

---

## Runtime Application

```typescript
// From SkeletonModel.tsx useFrame()
if (isCalibrated) {
    const offset = calibStore.getCalibration(segment)?.offset;
    if (offset) {
        boneQuaternion = sensorQuaternion.multiply(offset);
    }
}
```

---

## General Troubleshooting

| Issue                  | Likely Cause                  | Fix                              |
| ---------------------- | ----------------------------- | -------------------------------- |
| Model drifts slowly    | Gyro bias not zeroed          | Re-run firmware CALIBRATE        |
| Limb oriented wrong    | Sensor mounted differently    | Re-run T-Pose calibration        |
| Jumpy data             | Loose connection              | Check wiring, re-seat sensor     |
| Yaw drift              | No magnetometer               | Accept limitation or add mag     |
