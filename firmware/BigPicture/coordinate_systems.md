# IMU Coordinate System & Handedness

## Overview
This document defines the coordinate system conventions used in the IMU Connect firmware and frontend.

## The "Handedness" Issue (Solved Jan 2026)
We encountered a critical issue where the 3D model would pitch "Down" when the device was tilted "Up", and then slowly correct itself as the accelerometer (gravity) took over.

### Root Cause
The physical ICM-20649 sensor is mounted with a **180° Yaw offset** (Facing Backwards).
- **Transformation:** Rotation of 180° around the Y-axis.
- **Mapping:**
    - $X' = -X$ (Inverted)
    - $Y' = Y$ (Normal)
    - $Z' = -Z$ (Inverted)

This created a conflict where the Gyro would initially rotate incorrectly (if not mapped) or correctly (if mapped partially), but the Accelerometer would always "correct" it back to the wrong gravity vector if it wasn't also rotated 180°.

### The Fix (Firmware Level)
We applied a full "Virtual Rotation" of 180° Yaw to **BOTH** the Accelerometer and Gyroscope in `firmware/MASH_Node/SensorManager.cpp`.

**Code Location:** `SensorManager::readFrame()` / Unit Conversion block.

```cpp
// FIX: Apply 180-degree Yaw Rotation to entire frame (Accel + Gyro)
// Accel: X and Z are inverted. Y is preserved (Gravity).
float ax_yup = -ax_raw_g * 9.81f;
float ay_yup =  ay_raw_g * 9.81f;
float az_yup = -az_raw_g * 9.81f;

// Gyro: X and Z are inverted. Y (Yaw) is preserved.
float gx_yup = -gx_raw; 
float gy_yup =  gy_raw; 
float gz_yup = -gz_raw; 
```

## Coordinate Frame Definitions

### Firmware Frame (Sensor Local)
- **X:** Right (after fix)
- **Y:** Up (aligned with connector logic)
- **Z:** Forward (after fix)
- **Units:** Accel in $m/s^2$ (default 9.81 on Earth), Gyro in $rad/s$.

### Frontend Frame (Three.js / VQF)
The web application uses the **Right-Handed Y-Up** system standard in Three.js.
- **+Y:** World Up
- **+Z:** Toward Camera (or World Forward depending on camera)
- **+X:** World Right

The VQF filter expects data in a standard ENU (East-North-Up) or compatible frame. Our firmware now emits data compatible with VQF's default expectations for a sensor laid flat or mounted vertically, provided the initial quaternion aligns the sensor frame to the world frame.

## Calibration
Because we have fixed the handedness at the source, `IMUParser.ts` does **not** need to perform any axis swaps. It receives "Clean" physics data.
