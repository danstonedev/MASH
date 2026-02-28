# IMU Orientation Pipeline - Authoritative Reference

**Version**: 3.0  
**Date**: February 2026  
**Status**: ✅ VERIFIED - Chirality consolidated in firmware (right-handed frame)

---

## Overview

This document is the **single source of truth** for the IMU orientation pipeline.
All code comments in firmware files reference this document.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE ORIENTATION PIPELINE                             │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  FIRMWARE (C++)                                                              │
│  ─────────────                                                               │
│  1. ICM20649_Research.cpp   [X, Z, -Y]        Z-up → Y-up transform          │
│  2. SensorManager.cpp       [-X, +Y, -Z]      Hardware mounting correction   │
│  3. SyncManager.cpp         ×100/×900         int16 encoding                 │
│                                                                              │
│  WEBAPP (TypeScript)                                                         │
│  ──────────────────                                                          │
│  4. IMUParser.ts            ÷100/÷900         Decode to m/s² and rad/s       │
│  5. VQF.ts                  Sensor Fusion     Accel+Gyro → Quaternion        │
│  6. OrientationProcessor    Tare/Calibrate    Apply mounting & heading tare  │
│  7. applyToBone             Visualization     Set bone.quaternion            │
│                                                                              │
│  Transform 1: [X, Z, -Y]         Transform 2: [-X, +Y, -Z]                   │
│  (Axis swap + chirality)         (Mounting, true 180° yaw rotation)           │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Stage 1: ICM20649_Research.cpp

**Purpose**: Convert sensor's native Z-up frame to Y-up frame

**Input** (ICM20649 native Z-up):
- X = Right
- Y = Forward  
- Z = Up (where gravity points when flat)

**Transform**: `[X, Z, -Y]` with chirality preservation

```cpp
// Accelerometer
ax_yup = ax_sensor       // X → X (Right stays Right)
ay_yup = az_sensor       // Z → Y (Up becomes Up)
az_yup = -ay_sensor      // Y → -Z (Forward becomes Back, preserves chirality)

// Gyroscope (IDENTICAL transform - rigid body rule)
gx_yup = gx_sensor       // X → X
gy_yup = gz_sensor       // Z → Y
gz_yup = -gy_sensor      // Y → -Z (preserves chirality)
```

**Output**: Y-up right-handed frame
- X = Right
- Y = Up
- Z = Back

**Verification**: When sensor is flat, gravity reads [0, +1G, 0]

---

## Stage 2: SensorManager.cpp

**Purpose**: Correct for hardware mounting (sensor faces backwards on body)

**Input**: Y-up data from ICM20649_Research

**Transform**: `[-X, +Y, -Z]` (hardware mounting correction)

```cpp
// Accelerometer (units: m/s²)
ax_final = -ax_yup × 9.81    // X inverted (left-right flip)
ay_final = +ay_yup × 9.81    // Y preserved (gravity direction)
az_final = -az_yup × 9.81    // Z inverted (true 180° yaw)

// Gyroscope (units: rad/s, IDENTICAL signs)
gx_final = -gx_yup           // X inverted
gy_final = +gy_yup           // Y preserved
gz_final = -gz_yup           // Z inverted
```

**Why -Z (true 180° yaw rotation)?**  
The physical mounting is a pure 180° rotation about Y-axis.  
A 180° Y-rotation negates both X and Z: `[-X, +Y, -Z]`.  
Determinant = +1 (right-handed), which VQF and Three.js require.  
The previous `+Z` produced det=-1 (left-handed), requiring a web app fix.

**Output**: Body-frame data in right-handed Y-up frame
- When flat: accel = [0, +9.81, 0]
- When pitched down: accel shifts toward -Z
- When rolled right: accel shifts toward +X

---

## Stage 3: Encoding/Decoding

**SyncManager.cpp Encoding** (firmware → WebSocket):
```cpp
int16 = accel_m_s2 × 100    // ±327 m/s² range
int16 = gyro_rad_s × 900    // ±36.4 rad/s range
int16 = quat × 16384        // Full precision quaternion
```

**IMUParser.ts Decoding** (WebSocket → TypeScript):
```typescript
accel_m_s2 = int16 / 100
gyro_rad_s = int16 / 900
```

**No transforms in this stage** - values pass through unchanged.

---

## Stage 4: VQF Sensor Fusion

**Input Assumptions**:
- `accel[1] ≈ +9.81` when sensor is flat (gravity on +Y)
- Gyro rotation follows right-hand rule in Y-up frame

**Key Behavior**:
```
Physical Motion    → Accel Change → VQF Interprets → Euler Angle
Pitch DOWN         → -Z gravity   → Negative pitch  → Euler X < 0
Pitch UP           → +Z gravity   → Positive pitch  → Euler X > 0
Roll RIGHT         → +X gravity   → Negative roll   → Euler Z < 0
```

**Critical Requirement**:
Accel and Gyro MUST be in the SAME coordinate frame.
If misaligned, accel correction will fight gyro integration → drift.

---

## Stage 6: OrientationProcessor (Calibration)

**File**: `imu-connect/src/components/visualization/skeleton/OrientationProcessor.ts`

### Mounting Tare (Level 1)
Corrects for how the sensor is physically attached to the limb.

**Capture**: `q_mount = inv(q_sensor) × q_target`
**Apply**: `q_bone = q_sensor × q_mount`

Result: When sensor is at calibration pose, output = target (usually identity/upright).

### Heading Tare (Level 2)
Removes yaw offset so user's forward = world forward.

**Apply**: `q_world = inv(q_heading) × q_bone`

---

## Stage 7: applyToBone (Visualization)

**File**: `imu-connect/src/components/visualization/skeleton/OrientationProcessor.ts`

### Live Path
```typescript
const result = processor.processQuaternion(quatArray, segmentName, tareState);
processor.applyToBone(bone, result.worldQuat);
```

### Playback Path
Same as live - stored quaternions + stored calibration produce identical results.

---

## Validation Tests

All 19 tests in `firmwarePipelineVerification.test.ts` pass:

### Firmware Tests (11)
| Test | Input (Sensor Raw) | Expected Output |
|------|-------------------|-----------------|
| Flat | `az=+1G` | `ay=+9.81` |
| Pitch Down 90° | `ay=-1G` | `az=-9.81` |
| Pitch Up 90° | `ay=+1G` | `az=+9.81` |
| Roll Right 90° | `ax=-1G` | `ax=+9.81` |
| VQF Flat | Firmware output | Identity quaternion |
| VQF Pitched 45° | Firmware output | -45° Euler X |

### Visualization Tests (8)
| Test | Scenario | Expected Result |
|------|----------|-----------------|
| Live flat | Sensor flat → bone | Upright (0° pitch) |
| Live pitched | Sensor 45° → bone | -45° pitch |
| Calibrated | 30° offset + tare | 0° output |
| applyToBone | Quaternion → bone | Correct world orientation |
| Playback same | Live vs playback | Identical results |
| Playback calibrated | Stored tare | Correct relative motion |
| Full pipeline | Sensor → screen | -45° pitch matches physical |
| Pitch direction | Forward/backward | Matches physical expectation |

---

## Combined Transform Matrix

For reference, the net effect of both transforms:

**From ICM20649 sensor to final output**:
```
Sensor X → -X (inverted by mounting)
Sensor Y → +Z (forward in sensor → pitch axis)
Sensor Z → +Y (up stays up)
```

This can be expressed as a single rotation matrix:
```
     [ -1   0   0 ]
R =  [  0   0   1 ]
     [  0   1   0 ]
```

`det(R) = +1` — confirms right-handed frame.

---

## Troubleshooting

### Symptom: Model drifts slowly when stationary
**Cause**: Accel and Gyro in different frames
**Fix**: Verify both use identical transforms (rigid body rule)

### Symptom: Pitch is inverted (pitch down → model pitches up)
**Cause**: Z-axis sign wrong
**Fix**: Check `az_final` uses `-az_yup` (true 180° yaw)

### Symptom: Roll is inverted
**Cause**: X-axis sign wrong
**Fix**: Check `ax_final` uses `-ax_yup` (sensor mounted backwards)

### Symptom: Yaw drifts continuously
**Cause**: Gyro Y-axis bias not converged
**Fix**: Allow 5-10 seconds of stillness for bias estimation

---

## Change Log

| Date | Change | Verified |
|------|--------|----------|
| 2026-02 | v3.0: Chirality consolidated in firmware: [-X,+Y,+Z]→[-X,+Y,-Z]. Web app fix removed. updateBatch()/getBatchedData() transform bug fixed. Dead update() deleted. | ✅ |
| 2025-02-01 | Added Stages 6-7 (OrientationProcessor, applyToBone), expanded tests to 19 | ✅ 19 tests pass |
| 2025-02-01 | Removed debug logging, consolidated as single source of truth | ✅ |
| 2025-01-31 | Changed SensorManager Z from `-Z` to `+Z` | ✅ 11 tests pass |
| 2025-01-31 | Fixed ICM20649 gyro chirality (Y negation) | ✅ |

---

**Files referencing this document:**
- `MASH_Node/ICM20649_Research.cpp` - Stage 1 transform
- `MASH_Node/SensorManager.cpp` - Stage 2 transform (updateOptimized)
- `MASH_Node/SensorCalibration.cpp` - Stage 2 transform (calibration)
- `imu-connect/src/tests/firmwarePipelineVerification.test.ts` - Verification tests
- `imu-connect/src/store/useDeviceRegistry.ts` - VQF fusion (no chirality fix needed)
