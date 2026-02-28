# OpenSim Expert Code Review: IMU Connect
## White Glove Inspection Report

**Review Date**: February 1, 2026  
**Reviewer Perspective**: OpenSim/Biomechanics Expert (Stanford NCSRR)  
**Codebase**: IMU Connect - Real-time IMU Motion Capture System

---

## Status: Issues Addressed ✅

The following high-priority issues have been resolved:

| Issue | Status | Implementation |
|-------|--------|----------------|
| Euler Order Configuration | ✅ Fixed | Uses `JCS_EULER_ORDERS` lookup instead of string matching |
| Gimbal Lock Detection | ✅ Added | `detectGimbalLock()` with warning/critical thresholds |
| VQF Gain Too Slow | ✅ Fixed | Adaptive gain: 5% at rest → 0.5% during motion |
| Calibration Quality | ✅ Added | `assessCalibrationQuality()` with stillness/pose/gravity scores |
| Multi-Sample Calibration | ✅ Added | `computeMountingTareRobust()` with spherical mean |
| STA Filtering | ✅ Added | `STAFilter` class with 6Hz default, zero-phase batch mode |

---

## Executive Summary

This review examines the IMU Connect codebase through the lens of biomechanical accuracy, clinical validity, and OpenSim compatibility. The system demonstrates **solid foundational architecture** with proper coordinate system handling and quaternion math. However, several issues require attention before clinical or research use.

### Overall Assessment: **B+ (Good with Notable Concerns)**

| Category | Grade | Notes |
|----------|-------|-------|
| Coordinate Systems | A- | Correct Y-up convention, proper handedness |
| Quaternion Math | A | Correct conventions, proper normalization |
| Calibration Pipeline | B+ | Good 3-level hierarchy, needs motion artifact filtering |
| Joint Angle Decomposition | B | Euler order issues for some joints |
| OpenSim Compatibility | C+ | Not directly exportable, needs adaptation layer |
| Sensor Fusion (VQF) | B- | Conservative gains cause slow convergence |

---

## 1. Coordinate System Analysis

### ✅ CORRECT: Y-Up World Frame
```typescript
// VQF.ts
private _worldUp = new THREE.Vector3(0, 1, 0);
```
The system correctly uses Y-up (Three.js standard), which can be transformed to OpenSim's Y-up convention directly.

### ✅ CORRECT: Firmware Transform Chain
```cpp
// ICM20649_Research.cpp - Transform 1: Z-up → Y-up
frame->ax_g = ax_sensor;      // X → X
frame->ay_g = az_sensor;      // Z → Y  
frame->az_g = -ay_sensor;     // Y → -Z (chirality preservation)

// SensorManager.cpp - Transform 2: Mounting correction
float ax_yup = -ax_raw_g * 9.81f;  // X inverted
float ay_yup = +ay_raw_g * 9.81f;  // Y preserved
float az_yup = +az_raw_g * 9.81f;  // Z preserved
```

**Assessment**: The two-stage transform correctly converts ICM20649's Z-up coordinate system to Y-up while preserving right-handedness. The rigid body constraint (accel and gyro use identical transforms) is properly maintained.

### ⚠️ CONCERN: No Explicit OpenSim Frame Mapping
OpenSim uses a specific body-segment coordinate system (ISB recommendations):
- X: Anterior (forward)
- Y: Superior (up along limb)
- Z: Right (lateral)

**Recommendation**: Add an explicit `toOpenSimFrame()` function:
```typescript
// Suggested addition to OrientationPipeline.ts
export function toOpenSimFrame(threeQuat: THREE.Quaternion): THREE.Quaternion {
    // Three.js: +X right, +Y up, +Z forward (towards camera)
    // OpenSim:  +X forward, +Y up, +Z right
    // This is a 90° rotation around Y
    const frameRotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), 
        Math.PI / 2
    );
    return frameRotation.clone().multiply(threeQuat);
}
```

---

## 2. Quaternion Conventions

### ✅ CORRECT: Scalar-First Input Convention
```typescript
// OrientationPipeline.ts
const [w, x, y, z] = rawQuat;
const q_sensor = new THREE.Quaternion(x, y, z, w);
```
Firmware sends `[w, x, y, z]`, correctly converted to Three.js's internal `(x, y, z, w)` format.

### ✅ CORRECT: Normalization Handling
```typescript
// OrientationProcessor.ts
const magnitude = Math.sqrt(quatArray[0]**2 + quatArray[1]**2 + quatArray[2]**2 + quatArray[3]**2);
if (magnitude < 0.9 || magnitude > 1.1) {
    // Auto-normalize
}
```
Good tolerance range (±10%) with automatic correction.

### ✅ CORRECT: Hemisphere Consistency
```typescript
// OrientationProcessor.ts
if (bone.quaternion.dot(this._tempQuat1) < 0) {
    this._tempQuat1.x = -this._tempQuat1.x;
    // ... negate all components
}
```
Proper handling of quaternion double-cover to prevent 360° flips.

### ⚠️ MINOR: Hemisphere Check Location
The hemisphere check is applied after all transformations. For maximum smoothness, consider applying it incrementally after each transformation stage.

---

## 3. Calibration Pipeline (Critical Section)

### ✅ EXCELLENT: Three-Level Tare Hierarchy
```typescript
// taringPipeline.ts
// Level 1: Mounting Tare - q_mount = inv(q_sensor) × q_target
// Level 2: Heading Tare - q_world = inv(q_heading) × q_bone  
// Level 3: Joint Tare - θ_clinical = θ_measured - θ_offset
```

This is **textbook correct**. The mathematical formulation matches ISB recommendations and standard OpenSim workflows. The separation of concerns (sensor alignment → world alignment → clinical zero) is exactly right.

### ⚠️ CONCERN: No Motion Artifact Filtering During Calibration

```typescript
// computeMountingTare() accepts instantaneous quaternion
export function computeMountingTare(
    sensorQuat: THREE.Quaternion,
    targetBoneQuat: THREE.Quaternion
): TareResult {
```

**Problem**: Taking a single sample during calibration is susceptible to:
1. Transient motion artifacts
2. Sensor noise
3. User micro-movements

**Recommendation**: Implement temporal averaging with stillness detection:
```typescript
export function computeMountingTareRobust(
    samples: THREE.Quaternion[],  // At least 30 samples (~0.5s at 60Hz)
    targetBoneQuat: THREE.Quaternion
): TareResult {
    // 1. Check stillness (quaternion variance < threshold)
    const variance = computeQuaternionVariance(samples);
    if (variance > 0.001) {
        return { success: false, message: 'Motion detected during calibration' };
    }
    
    // 2. Compute mean quaternion (spherical average)
    const meanQuat = sphericalMean(samples);
    
    // 3. Proceed with tare computation
    return computeMountingTare(meanQuat, targetBoneQuat);
}
```

### ⚠️ CONCERN: Calibration Quality Scoring
```typescript
// Current implementation always returns quality: 1.0
return {
    success: true,
    quality: 1.0,  // ← Always maximum
    message: 'Mounting tare computed successfully'
};
```

**Problem**: No actual quality assessment. OpenSim users expect calibration quality metrics.

**Recommendation**: Implement proper quality scoring:
```typescript
function assessCalibrationQuality(
    samples: THREE.Quaternion[],
    expectedPose: THREE.Quaternion
): number {
    // Factors:
    // 1. Stillness (low variance = good)
    // 2. Proximity to expected pose (close = good)
    // 3. Gravity alignment (accel magnitude near 1G = good)
    
    const variancePenalty = Math.exp(-variance / 0.0001);  // 0-1
    const posePenalty = Math.exp(-angularError / 0.1);     // 0-1
    return variancePenalty * posePenalty;
}
```

---

## 4. Joint Angle Decomposition (Major Concern)

### ⚠️ CRITICAL: Inconsistent Euler Orders

```typescript
// jointAngles.ts
// Hip uses ZXY (Grood & Suntay convention)
hip_l: { /* ... */ }

// But OrientationProcessor.ts has:
let eulerOrder = jointDef.name.includes("Shoulder") ? "YXZ" : "ZXY";
if (jointDef.name.includes("Knee")) {
    eulerOrder = "XZY";
}
```

**Problem**: The Euler order selection is based on string matching (`name.includes()`), which is fragile and doesn't align with ISB recommendations.

### ISB Standard Euler Orders

| Joint | ISB Recommendation | Your Code | Status |
|-------|-------------------|-----------|--------|
| Hip | ZXY | ZXY | ✅ |
| Knee | ZXY (but XZY avoids gimbal lock at 90°) | XZY | ⚠️ Acceptable |
| Ankle | ZXY | ZXY | ✅ |
| Shoulder | YXZ (varies by convention) | YXZ | ✅ |
| Spine | XZY | ZXY | ❌ Incorrect |

**Recommendation**: Create explicit joint-specific Euler order configuration:
```typescript
export const ISB_EULER_ORDERS: Record<string, THREE.EulerOrder> = {
    hip_l: 'ZXY',
    hip_r: 'ZXY',
    knee_l: 'ZXY',     // ISB standard (not XZY)
    knee_r: 'ZXY',
    ankle_l: 'ZXY',
    ankle_r: 'ZXY',
    shoulder_l: 'YXZ', // Shoulder varies by convention
    shoulder_r: 'YXZ',
    lumbar: 'XZY',     // Spine uses different convention
    cervical: 'XZY',
};
```

### ⚠️ CRITICAL: Gimbal Lock Not Handled

```typescript
// No gimbal lock detection in current code
const relEuler = new THREE.Euler().setFromQuaternion(q_relative, "XYZ");
```

**Problem**: Euler angles suffer from gimbal lock at ±90° in the second rotation. The knee flexing to 90° will cause mathematical singularity.

**Recommendation**: Add gimbal lock detection and warning:
```typescript
function decomposeWithGimbalCheck(
    quat: THREE.Quaternion, 
    order: THREE.EulerOrder
): { euler: THREE.Euler; gimbalLock: boolean } {
    const euler = new THREE.Euler().setFromQuaternion(quat, order);
    
    // Check middle axis proximity to ±90°
    const middleIndex = order === 'XYZ' ? 1 : 
                        order === 'ZXY' ? 0 : 1;
    const middleAngle = [euler.x, euler.y, euler.z][middleIndex];
    const gimbalLock = Math.abs(Math.abs(middleAngle) - Math.PI/2) < 0.1; // Within 6°
    
    return { euler, gimbalLock };
}
```

---

## 5. Sensor Fusion (VQF) Analysis

### ⚠️ CONCERN: Very Conservative Correction Gain

```typescript
// VQF.ts
const adaptiveGain = 0.005; // 0.5% correction per frame
```

**Problem**: At 60 Hz, this means:
- Time to correct 10° error: ~70 frames (~1.2 seconds)
- Time to correct 45° error: ~300 frames (~5 seconds)

This is **too slow** for clinical applications where users move between poses quickly.

**OpenSim Comparison**: Xsens Awinda uses adaptive gains of 0.01-0.05 depending on motion state.

**Recommendation**: Implement adaptive gain based on motion state:
```typescript
// Dynamic gain based on stillness
const baseGain = 0.005;
const restGain = 0.05;  // 10x faster when stationary
const adaptiveGain = this.restDetected ? restGain : baseGain;
```

### ⚠️ CONCERN: Gyro Bias Estimation Too Slow

```typescript
const biasAlpha = 0.01; // Learning rate per update
```

**Problem**: At 60 Hz, gyro bias takes ~500 frames (8+ seconds) to converge. MEMS gyro bias can drift significantly in this time.

**OpenSim Standard**: Xsens and commercial systems use initial calibration routines that estimate bias in 2-3 seconds of stillness.

**Recommendation**: Add dedicated bias estimation routine:
```typescript
initializeBias(accel: number[][], gyro: number[][], duration: number): void {
    // Average gyro over stillness period
    // Variance check to ensure stillness
    // Fast single-shot bias estimation
}
```

### ✅ CORRECT: Accelerometer Trust Gating

```typescript
const accelNearGravity = accelMag > 8.3 && accelMag < 11.3; // 9.81 ± 15%
const rotatingSlowly = gyroMag < 0.26;  // < 15°/s
if (accelNearGravity && rotatingSlowly) {
    // Apply correction
}
```

Good practice - only trusting accelerometer when conditions warrant.

---

## 6. ROM Constraints (Disabled)

```typescript
// OrientationProcessor.ts
/* PHASE 1 AUDIT: DISABLE LIMITS
const wasConstrained = this.applyROMConstraintsInPlace(
    this._tempQuat2,
    jointDef,
    shouldLog
);
*/
```

### Assessment

**For Research Use**: Correct to disable. ROM constraints can mask sensor errors and should not be used during validation.

**For Clinical Use**: ROM constraints should be re-enabled with proper implementation:

1. **Soft Constraints** (recommended): Use spring-like forces near limits
2. **Hard Constraints** (current): Clamp values at limits

**Recommendation**: Implement soft constraints:
```typescript
function applySoftROMConstraint(
    angle: number, 
    min: number, 
    max: number, 
    stiffness: number = 0.1
): number {
    if (angle < min) {
        return min + (angle - min) * Math.exp(-(min - angle) * stiffness);
    }
    if (angle > max) {
        return max + (angle - max) * Math.exp(-(angle - max) * stiffness);
    }
    return angle;
}
```

---

## 7. OpenSim Export Compatibility

### ❌ MISSING: OpenSim Export Format

The codebase has no direct path to OpenSim-compatible formats (.mot, .trc, .osim).

**Required for OpenSim Integration**:

1. **Motion File (.mot)**: Time-series of joint angles
```
time hip_flexion_r hip_adduction_r hip_rotation_r knee_angle_r ...
0.000 15.2 -2.1 5.3 22.1 ...
0.008 15.3 -2.0 5.4 22.3 ...
```

2. **Marker File (.trc)**: Virtual marker positions (if doing IK)
```
Frame# Time  RASIS.X RASIS.Y RASIS.Z LASIS.X ...
1      0.000 0.123   0.984   0.045   -0.121  ...
```

3. **Sensor Orientations (.sto)**: For IMU-based IK
```
time pelvis_imu_X pelvis_imu_Y pelvis_imu_Z pelvis_imu_W ...
0.000 0.0 0.0 0.0 1.0 ...
```

**Recommendation**: Add OpenSim export module:
```typescript
// Suggested: src/export/opensimExport.ts
export function exportToMOT(
    recording: Recording,
    jointAngles: Map<string, number[]>,
    filename: string
): void {
    // Header
    // Time column
    // Joint angle columns with OpenSim naming convention
}
```

### ⚠️ CONCERN: Joint Naming Convention

```typescript
// Your naming
const JOINT_DEFINITIONS = {
    hip_l: { /* ... */ },
    knee_l: { /* ... */ },
};

// OpenSim naming (gait2392 model)
// hip_flexion_l, hip_adduction_l, hip_rotation_l
// knee_angle_l
```

**Recommendation**: Add mapping to OpenSim names:
```typescript
export const OPENSIM_JOINT_MAPPING: Record<string, string[]> = {
    hip_l: ['hip_flexion_l', 'hip_adduction_l', 'hip_rotation_l'],
    knee_l: ['knee_angle_l', 'knee_adduction_l', 'knee_rotation_l'],
    ankle_l: ['ankle_angle_l', 'subtalar_angle_l'],
    // ...
};
```

---

## 8. Data Quality and Filtering

### ⚠️ MISSING: Soft Tissue Artifact (STA) Compensation

IMUs attached to skin move relative to bone due to muscle/fat wobble. This is a major source of error in optical and IMU motion capture.

**Current State**: No STA compensation detected.

**Recommendation**: Implement basic STA filtering:
```typescript
// Low-pass filter joint angles to reduce STA
// Typical STA is 2-10 Hz, joint motion is 0-6 Hz
const cutoffFreq = 6; // Hz
const filteredAngle = lowPassFilter(rawAngle, cutoffFreq, sampleRate);
```

### ⚠️ MISSING: Outlier Detection

No spike/outlier detection for corrupted sensor packets.

**Recommendation**:
```typescript
function detectOutlier(
    currentQuat: THREE.Quaternion,
    previousQuat: THREE.Quaternion,
    dt: number,
    maxAngularVelocity: number = 20 // rad/s (~1150°/s)
): boolean {
    const angle = currentQuat.angleTo(previousQuat);
    return (angle / dt) > maxAngularVelocity;
}
```

---

## 9. Test Coverage Assessment

### ✅ EXCELLENT: Pipeline Verification Tests
```typescript
// firmwarePipelineVerification.test.ts - 19 tests
// Covers: Firmware transforms, VQF, OrientationProcessor, applyToBone
```

Good coverage of the core pipeline.

### ⚠️ MISSING: Biomechanical Validation Tests

No tests that compare against known motion patterns:

1. **Pendulum Test**: Sensor on pendulum, verify period matches physics
2. **Goniometer Comparison**: Compare against manual goniometer readings
3. **Reference Dataset**: Compare against published IMU dataset (e.g., AMASS)

**Recommendation**: Add validation test suite:
```typescript
describe('Biomechanical Validation', () => {
    test('Knee flexion matches goniometer within 5°', () => {
        // Load reference data
        // Process through pipeline
        // Assert RMSE < 5°
    });
    
    test('Hip ROM matches clinical expectations', () => {
        // Full squat should show ~120° hip flexion
        // Full extension should show ~-20° hip flexion
    });
});
```

---

## 10. Critical Recommendations (Priority Order)

### 🔴 HIGH PRIORITY

1. **Fix Euler Order Configuration**: Replace string matching with explicit joint-specific configuration
2. **Add Gimbal Lock Detection**: Warn users when approaching singularity
3. **Increase VQF Gain**: Current 0.5% is too slow for clinical use
4. **Add Calibration Quality Metrics**: Replace hardcoded `quality: 1.0`

### 🟡 MEDIUM PRIORITY

5. **Add OpenSim Export**: .mot file format for joint angles
6. **Implement STA Filtering**: Low-pass filter at 6 Hz
7. **Add Multi-Sample Calibration**: Average 30+ samples with stillness check
8. **Fix Spine Euler Order**: Change from ZXY to XZY per ISB

### 🟢 LOW PRIORITY

9. **Add Outlier Detection**: Catch corrupted packets
10. **Add Reference Frame Mapping**: `toOpenSimFrame()` function
11. **Implement Soft ROM Constraints**: For clinical use mode
12. **Add Biomechanical Validation Tests**: Compare against reference data

---

## Conclusion

The IMU Connect codebase demonstrates **strong software engineering fundamentals** and **correct mathematical foundations**. The coordinate system handling and quaternion math are properly implemented, which is the most critical foundation.

However, for **clinical or research publication**, the following must be addressed:

1. Joint angle decomposition needs ISB-compliant Euler orders
2. Sensor fusion gains are too conservative
3. Calibration quality assessment is missing
4. No path to OpenSim-compatible export formats

With these improvements, the system would be suitable for:
- Biomechanical research studies
- Clinical gait analysis
- OpenSim inverse kinematics input
- Publication-quality motion data

**Estimated Effort for Full OpenSim Compatibility**: 40-60 hours of focused development

---

*Review conducted using OpenSim 4.x conventions and ISB biomechanics standards.*
