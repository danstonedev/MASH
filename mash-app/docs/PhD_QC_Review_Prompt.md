# PhD-Level Biomechanics QC Review Prompt

**Document Version:** 1.0  
**Date:** 2025-12-22  
**System:** IMU Connect - Wearable Motion Capture Platform

---

## Overview for Reviewer

You are reviewing an open-source IMU-based motion capture system designed for research-grade biomechanical analysis. The system consists of:

- **Hardware:** ESP32-S3 + ICM-20649 (High-G 6-DOF IMU) + MMC5603 (Magnetometer) + BMP390 (Barometer)
- **Firmware:** C++ sensor fusion with BLE/ESP-NOW transmission
- **Web Application:** React/TypeScript/Three.js for real-time 3D visualization

Your task is to evaluate the mathematical validity, biomechanical correctness, and clinical defensibility of the implementation against current research standards.

---

## Section 1: Convention Verification

### 1.1 Coordinate Frame Definitions

**Reference:** Wu et al. (2002, 2005) ISB recommendations for joint coordinate systems.

Review the following file and verify:
- `src/lib/math/conventions.ts`

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is the global frame explicitly defined (ENU/NED/Y-up)? | Yes, Y-up Three.js | ☐ | |
| Is gravity direction and magnitude documented? | [0, -9.81, 0] m/s² | ☐ | |
| Is the rotation convention stated (R_GS = sensor→global)? | Yes | ☐ | |
| Is there a single authoritative source for these conventions? | Yes | ☐ | |

### 1.2 Quaternion Convention

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is quaternion storage order documented ([w,x,y,z] vs [x,y,z,w])? | Yes | ☐ | |
| Is the rotation direction convention clear (active vs passive)? | Active | ☐ | |
| Is the S→G frame transform formula documented? | v_G = R_GS × v_S | ☐ | |

---

## Section 2: Sensor Fusion Validation

### 2.1 Filter Architecture

**Reference:** Madgwick, S. (2010). "An efficient orientation filter for inertial and inertial/magnetic sensor arrays."

Review: `MASH_Node/MadgwickFilter.cpp` and `src/lib/math/Madgwick.ts`

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is integration on SO(3) manifold (exp map) or linear? | Manifold (exp map) | ☐ | |
| Is quaternion normalization explicit after each update? | Yes | ☐ | |
| Is gyro bias modeled or estimated? | Yes | ☐ | |
| Is accelerometer update direction-only (normalized)? | Yes | ☐ | |

### 2.2 Dynamic Motion Handling

**Reference:** Kok, M., Hol, J. D., & Schön, T. B. (2017). "Using inertial sensors for position and orientation estimation."

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is there adaptive gain (β) based on acceleration magnitude? | Yes | ☐ | |
| During high-g events (>2g), does filter reduce accel trust? | Yes | ☐ | |
| Is the gating function smooth (not hard threshold)? | Yes | ☐ | |
| Is the gating formula documented and justified? | Yes | ☐ | |

### 2.3 Numerical Stability

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is small-angle approximation used for ‖ω‖ < ε? | Yes | ☐ | |
| Is there gimbal lock mitigation in angle extraction? | N/A (uses quaternions) | ☐ | |
| Are NaN checks present for edge cases? | Should be | ☐ | |

---

## Section 3: Calibration Pipeline

### 3.1 Static Calibration (T-Pose/N-Pose)

**Reference:** Palermo, E., et al. (2014). "Experimental evaluation of accuracy and repeatability of a novel body-to-sensor calibration procedure for inertial sensor-based gait analysis."

Review: `src/calibration/taringPipeline.ts`, `src/calibration/calibrationMath.ts`

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is sensor-to-segment alignment (R_SB) computed? | Yes | ☐ | |
| Is the taring hierarchy clear (Mounting→Heading→Joint)? | Yes | ☐ | |
| Can the system distinguish Level 1/2/3 tares? | Yes | ☐ | |
| Is stillness validation performed during capture? | Yes | ☐ | |

### 3.2 Functional Calibration

**Reference:** Seel, T., Raisch, J., & Schauer, T. (2014). "IMU-based joint angle measurement for gait analysis."

Review: `src/calibration/functionalCalibration.ts`

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is PCA used to estimate joint hinge axis? | Yes | ☐ | |
| Is the method reference documented (Seel et al.)? | Should be | ☐ | |
| Is a quality metric provided (variance explained)? | Yes | ☐ | |
| Is there guidance for minimum motion requirements? | Should be | ☐ | |

### 3.3 Gyroscope Bias Estimation

**Reference:** Tedaldi, D., Pretto, A., & Menegatti, E. (2014). "A robust and easy to implement method for IMU calibration."

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is gyro bias estimated during static initialization? | Yes | ☐ | |
| Is sample count sufficient (≥1000 samples recommended)? | Check | ☐ | |
| Is motion rejection implemented during bias capture? | Yes | ☐ | |

---

## Section 4: Joint Kinematics

### 4.1 Relative Rotation Computation

**Reference:** Grood, E. S., & Suntay, W. J. (1983). "A joint coordinate system for the clinical description of three-dimensional motions."

Review: `src/biomech/jointAngles.ts`

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is relative rotation computed as q_rel = inv(q_parent) × q_child? | Yes | ☐ | |
| Is the order of multiplication correct (parent first)? | Yes | ☐ | |

### 4.2 Euler Decomposition (JCS)

**Reference:** Wu, G., et al. (2002). "ISB recommendation on definitions of joint coordinate system."

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Does knee use ZXY Euler sequence (Grood & Suntay)? | Yes | ☐ | |
| Is flexion on the floating axis (Z for ZXY)? | Yes | ☐ | |
| Is Euler order explicitly documented per joint? | Yes | ☐ | |
| Is angle "bleed" between axes controlled? | Check | ☐ | |

### 4.3 Anatomical Constraints

**Reference:** Dumas, R., et al. (2007). "Influence of the 3D inverse dynamic method on the joint forces and moments during gait."

Review: `src/calibration/anatomicalConstraints.ts`

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Are ROM limits based on published literature? | Yes (ISB) | ☐ | |
| Are constraints applied as soft (not hard) limits? | Yes | ☐ | |
| Are limits joint-specific and axis-aware? | Yes | ☐ | |

---

## Section 5: Temporal Synchronization

### 5.1 Multi-Sensor Timing

**Reference:** Roetenberg, D., Luinge, H., & Slycke, P. (2009). "Xsens MVN: Full 6DOF human motion tracking using miniature inertial sensors."

Review: `src/calibration/temporalSync.ts`

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Is timestamp source high-resolution (μs preferred)? | Check | ☐ | |
| Is SLERP used for inter-sample interpolation? | Yes | ☐ | |
| Is maximum interpolation gap defined? | Yes (100ms) | ☐ | |
| Is temporal spread diagnostic available? | Yes | ☐ | |

### 5.2 IMU Tearing Prevention

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Are all sensors synchronized to common render timestamp? | Yes | ☐ | |
| Is the synchronization integrated into render loop? | Check | ☐ | |

---

## Section 6: Validation Harness

### 6.1 Unit Tests

Review: `src/lib/math/so3.test.ts`

| Question | Expected | Verified? | Notes |
|----------|----------|:---------:|-------|
| Do ExpSO3/LogSO3 round-trip tests exist? | Yes | ☐ | |
| Is quaternion normalization invariant tested? | Yes | ☐ | |
| Is skew-symmetric matrix construction tested? | Yes | ☐ | |

### 6.2 Missing Validation (Gaps to Flag)

| Test Type | Present? | Priority |
|-----------|:--------:|----------|
| Synthetic hinge motion test | ☐ | High |
| Known-motion playback validation | ☐ | High |
| Optical/IMU comparison dataset | ☐ | Medium |
| Multi-day repeatability test | ☐ | Medium |

---

## Section 7: Documentation Quality

| Item | Present? | Notes |
|------|:--------:|-------|
| Coordinate frame definitions | ☐ | |
| Rotation convention (R_GS) | ☐ | |
| Calibration procedure guide | ☐ | |
| API documentation | ☐ | |
| Known limitations section | ☐ | |

---

## Section 8: Identified Risks & Recommendations

### 8.1 Critical Issues (Must Fix)

List any issues that would invalidate research conclusions:

1. _________________________________
2. _________________________________
3. _________________________________

### 8.2 Major Issues (Should Fix)

List issues affecting accuracy or reliability:

1. _________________________________
2. _________________________________
3. _________________________________

### 8.3 Minor Issues (Nice to Have)

List improvements for best practices:

1. _________________________________
2. _________________________________
3. _________________________________

---

## Section 9: Research Compliance Checklist

| Requirement | Status | Notes |
|-------------|:------:|-------|
| Suitable for publication-quality data | ☐ | |
| Comparison to gold standard documented | ☐ | |
| Error bounds quantified | ☐ | |
| Limitations acknowledged | ☐ | |
| Reproducible by independent researcher | ☐ | |

---

## Reviewer Information

**Reviewer Name:** _________________________________

**Affiliation:** _________________________________

**Date of Review:** _________________________________

**Signature:** _________________________________

---

## References Cited

1. Grood, E. S., & Suntay, W. J. (1983). A joint coordinate system for the clinical description of three-dimensional motions. *Journal of Biomechanical Engineering*, 105(2), 136-144.

2. Kok, M., Hol, J. D., & Schön, T. B. (2017). Using inertial sensors for position and orientation estimation. *Foundations and Trends in Signal Processing*, 11(1-2), 1-153.

3. Madgwick, S. O., Harrison, A. J., & Vaidyanathan, R. (2011). Estimation of IMU and MARG orientation using a gradient descent algorithm. *IEEE ICORR*, 1-7.

4. Seel, T., Raisch, J., & Schauer, T. (2014). IMU-based joint angle measurement for gait analysis. *Sensors*, 14(4), 6891-6909.

5. Wu, G., et al. (2002). ISB recommendation on definitions of joint coordinate system of various joints for the reporting of human joint motion—part I: ankle, hip, and spine. *Journal of Biomechanics*, 35(4), 543-548.

6. Wu, G., et al. (2005). ISB recommendation on definitions of joint coordinate systems of various joints for the reporting of human joint motion—Part II: shoulder, elbow, wrist and hand. *Journal of Biomechanics*, 38(5), 981-992.
