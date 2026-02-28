---
description: Critical review of the sensor calibration, fusion, and alignment pipeline for best practices compliance
---

# Sensor Calibration & Fusion Pipeline - Critical Code Review

This workflow guides a comprehensive technical review of the ESP32 IMU firmware's calibration, fusion, and alignment systems. The review should validate implementation correctness, identify deviations from best practices, and provide actionable recommendations.

---

## Pre-Review: Establish Context

1. **Locate and catalog all relevant source files** in the firmware codebase:
   - Sensor drivers (ICM-20649, MMC5603, BMP390)
   - Calibration routines (magnetometer hard/soft iron, gyro bias)
   - Sensor fusion implementation (Madgwick/AHRS)
   - Taring/boresighting logic
   - Vertical velocity estimation (Kalman filter)
   - BLE transmission of fused data

2. **Document the current architecture** by reading each file's outline and understanding the data flow from raw sensor reads → calibration → fusion → output.

---

## Section 1: Low-Level Sensor Calibration Review

### 1.1 Magnetometer (MMC5603) Calibration

**Claimed Implementation:**
- Set/Reset degaussing pulse every ~50 samples
- Hard Iron offset subtraction
- Soft Iron ellipsoid fit matrix correction

**Review Checklist:**
- [ ] Verify Set/Reset pulse is actually implemented and triggered at correct intervals
- [ ] Check if pulse timing follows MMC5603 datasheet recommendations (pulse width, recovery time)
- [ ] Confirm hard iron offsets are stored and applied correctly (subtraction before soft iron)
- [ ] Verify soft iron matrix is a proper 3x3 transformation applied AFTER hard iron subtraction
- [ ] Check if calibration coefficients are persisted (NVS/EEPROM) or require recalibration on boot
- [ ] Assess calibration sample collection procedure (sphere/ellipsoid coverage)

**Best Practice Questions:**
1. Is the ellipsoid fit performed on-device or offline? (Offline is typically more robust)
2. Is there outlier rejection during calibration sample collection?
3. Does the code handle magnetic disturbance detection during runtime?
4. Is temperature compensation considered for magnetometer drift?

### 1.2 Gyroscope (ICM-20649) Calibration

**Claimed Implementation:**
- Quiet period bias sampling at startup
- Bias subtraction from all runtime readings

**Review Checklist:**
- [ ] Verify startup bias sampling requires/enforces stationary condition
- [ ] Check sample count during bias estimation (recommend 500-2000 samples)
- [ ] Confirm bias is calculated as mean, not median (or justify if different)
- [ ] Verify bias subtraction occurs BEFORE fusion algorithm ingestion
- [ ] Check if gyroscope scale factor calibration is implemented (often overlooked)
- [ ] Assess if bias is re-estimated periodically or only at startup

**Best Practice Questions:**
1. Is there motion detection to abort/restart bias calibration if device moves during startup?
2. Is gyro bias temperature-dependent? If so, is temperature compensation implemented?
3. Is the gyro FSR (Full Scale Range) appropriately set for expected motion dynamics?
4. Are there checks for gyro saturation during high-speed movements?

### 1.3 Accelerometer Calibration

**Note:** Accelerometer calibration was not mentioned in the summary.

**Review Checklist:**
- [ ] Determine if accelerometer bias/offset calibration exists
- [ ] Check for accelerometer scale factor calibration (6-position tumble calibration)
- [ ] Verify accelerometer cross-axis sensitivity correction if applicable
- [ ] Assess if accelerometer is used raw or if any corrections are applied

**Best Practice Flag:**
> [!WARNING]
> If accelerometer calibration is missing, this is a significant gap. Accelerometer errors directly impact gravity compensation and the Kalman filter for vertical velocity.

---

## Section 2: Sensor Fusion (AHRS) Review

### 2.1 Madgwick Filter Implementation

**Claimed Implementation:**
- Gradient descent Madgwick filter
- Fuses accelerometer, gyroscope, magnetometer
- Outputs orientation quaternion in NED frame
- Runs on ESP32 Core 1

**Review Checklist:**
- [ ] Verify Madgwick implementation source (original Madgwick, or modified?)
- [ ] Check beta (filter gain) value and assess if it's appropriate for application dynamics
- [ ] Confirm gyroscope data is in radians/sec (common error: using deg/sec)
- [ ] Verify sensor data normalization before fusion (accel and mag must be unit vectors)
- [ ] Check quaternion normalization after each filter update
- [ ] Confirm sensor axes are aligned before fusion (common pitfall: axis sign/order mismatches)
- [ ] Verify the filter runs at a consistent sample rate (jitter impacts performance)
- [ ] Check for proper handling of mag-free mode when magnetic disturbances detected

**Best Practice Questions:**
1. What is the configured sample rate? (Recommend 100-400Hz for body tracking)
2. Is beta tunable at runtime? (Useful for different motion profiles)
3. Is there magnetic disturbance detection/rejection?
4. Does the implementation use the 6DOF fallback when magnetometer is unreliable?
5. Is gyroscope bias estimated within the filter, or only at startup?

### 2.2 Coordinate Frame Consistency

**Review Checklist:**
- [ ] Document the sensor-native coordinate systems for all three sensors
- [ ] Verify explicit transformation to a common intermediate frame
- [ ] Confirm final output is actually NED (North-East-Down) as claimed
- [ ] Check if the 3D visualization expects NED or a different convention

**Critical Questions:**
1. Are all three sensors mounted with consistent axis alignments on the PCB?
2. Is there a documented axis remapping table in the code?
3. Does the taring system account for any axis swaps/negations?

---

## Section 3: Boresighting / Tare System Review

### 3.1 Tare Quaternion Calculation

**Claimed Implementation:**
- Capture current orientation q_sensor at T-pose
- Compute tare quaternion: q_tare = conjugate(q_sensor)
- Apply at runtime: q_model = q_tare ⊗ q_sensor

**Review Checklist:**
- [ ] Verify conjugate calculation is correct: q* = (w, -x, -y, -z)
- [ ] Confirm quaternion multiplication order (this is critical and often wrong)
- [ ] Check if tare is stored persistently or lost on reboot
- [ ] Verify tare can be triggered remotely (BLE command) and from device button
- [ ] Assess if multiple tare presets are supported (different poses/use cases)

**Best Practice Questions:**
1. Is the multiplication order documented? q_tare ⊗ q_sensor vs q_sensor ⊗ q_tare produce different results
2. Does the tare capture average multiple samples or just a single frame?
3. Is there user feedback (LED, audio) when tare is captured?
4. Can tare be reset to identity without recalibrating?

### 3.2 Multi-Sensor Tare Synchronization

**Review Checklist:**
- [ ] If multiple sensors are used, is tare triggered simultaneously across all nodes?
- [ ] Is there a synchronized tare command from the gateway?
- [ ] Are individual sensor tares handled independently or as a coordinated system?

---

## Section 4: Vertical Velocity Estimation Review

### 4.1 Gravity Compensation

**Claimed Implementation:**
- Use orientation quaternion to rotate and subtract gravity vector

**Review Checklist:**
- [ ] Verify gravity vector rotation: g_world = q ⊗ [0,0,1] ⊗ q*
- [ ] Confirm subtraction yields linear acceleration in world frame
- [ ] Check units consistency (m/s², g's, raw ADC?)
- [ ] Verify this happens AFTER sensor calibration corrections

**Best Practice Questions:**
1. Is gravity magnitude assumed to be exactly 1.0g or measured/calibrated?
2. Is there high-pass filtering on linear acceleration to remove residual bias?
3. How is coordinate frame handled? (sensor frame vs world frame subtraction)

### 4.2 Kalman Filter Design

**Claimed Implementation:**
- 2-state Kalman filter (position, velocity)
- Fuses vertical acceleration with barometric altitude

**Review Checklist:**
- [ ] Document the state vector: [altitude, vertical_velocity] or different?
- [ ] Verify process model (constant acceleration? constant velocity?)
- [ ] Check measurement model for acceleration (double integration considerations)
- [ ] Check measurement model for barometer (direct altitude observation)
- [ ] Assess Q (process noise) and R (measurement noise) tuning
- [ ] Verify filter runs at appropriate rate (barometer is much slower than IMU)
- [ ] Check for height hold / zero velocity updates when stationary

**Best Practice Questions:**
1. Is the filter implemented with complementary timing for async sensor updates?
2. Is barometer altitude temperature/pressure compensated before fusion?
3. Is there vertical velocity damping when motion is detected as stationary?
4. How are units handled? (meters, cm, raw pressure?)
5. Is the Kalman gain converging to reasonable steady-state values?

---

## Section 5: System-Level Review

### 5.1 Timing and Synchronization

**Review Checklist:**
- [ ] Document IMU sample rate and verify it's consistent
- [ ] Check for timestamp handling in sensor fusion
- [ ] Verify BLE transmission doesn't block sensor acquisition
- [ ] Assess Core 0 vs Core 1 task distribution
- [ ] Check for priority inversion or mutex contention

### 5.2 Data Integrity

**Review Checklist:**
- [ ] Verify no data races between sensor reading and fusion tasks
- [ ] Check for proper handling of sensor communication failures
- [ ] Assess watchdog/error recovery mechanisms
- [ ] Verify BLE packet format matches web app parser expectations

### 5.3 Numerical Stability

**Review Checklist:**
- [ ] Check for potential float underflow/overflow
- [ ] Verify quaternion renormalization frequency
- [ ] Assess if single-precision float is sufficient for all calculations
- [ ] Check for division by zero guards

---

## Post-Review: Generate Report

After completing the review, produce a structured report with:

1. **Validation Summary**: What is correctly implemented per best practices
2. **Issues Found**: Specific code locations with problems
3. **Recommendations**: Prioritized improvements (Critical/High/Medium/Low)
4. **Missing Features**: What best practices are not implemented at all
5. **Questions for Developer**: Clarifications needed before final assessment

---

## Reference: Best Practice Standards

These are the gold-standard expectations for each component:

### Magnetometer Calibration
- Hard iron: 3-element offset vector (b_x, b_y, b_z)
- Soft iron: 3x3 transformation matrix (ideally symmetric positive definite)
- Application order: subtract hard iron FIRST, then multiply by soft iron inverse
- Set/Reset: Follow MMC5603 timing specs exactly
- Sample collection: Full sphere coverage with outlier rejection

### Gyroscope Calibration
- Bias: Stationary average over 1-2 seconds (500+ samples at 500Hz)
- Motion rejection: Abort if significant motion detected during bias sampling
- Temperature: Consider storing bias vs temperature curve for high-precision apps
- Runtime: Some AHRS filters estimate gyro bias online (Madgwick does not by default)

### Accelerometer Calibration
- Bias: 6-position tumble calibration (±X, ±Y, ±Z orientations)
- Scale: Should be close to 1.0 for factory-calibrated sensors, but verify
- Cross-axis: Usually negligible for consumer IMUs, but check datasheet

### Madgwick Filter
- Beta: Typically 0.01-0.5 depending on application (lower = trust gyro more)
- Sample rate: 100Hz minimum, 200-400Hz recommended for dynamic motions
- Magnetic rejection: Implement 6DOF fallback when |mag - expected| > threshold
- Gyro units: MUST be radians/second

### Taring
- Multiplication order: q_output = q_tare ⊗ q_sensor (world-frame rotation)
- Stability: Average 10-50 samples during capture for noise reduction
- Identity: q_tare = (1, 0, 0, 0) when untared

### Vertical Velocity Kalman Filter
- States: Minimum [altitude, velocity], consider [altitude, velocity, accel_bias]
- Process noise: Model accelerometer walk, barometer drift
- Measurement noise: Accelerometer ~0.01-0.1 m/s², barometer ~0.5-2.0 m
- Update rate: IMU prediction at full rate, barometer correction at baro rate

---

// turbo-all
