/**
 * Data Cleaning Pipeline Tests
 *
 * These tests verify the firmware-level data cleaning logic that should be
 * applied to IMU sensor data before it reaches the client. The tests simulate
 * the firmware processing pipeline and ensure:
 *
 * 1. Outlier Rejection - Physically impossible readings are rejected
 * 2. Coordinate Transform - Z-up (sensor) → Y-up (Three.js)
 * 3. Bias Correction - Subtract calibration offsets
 * 4. Scale Correction - Apply accelerometer scale factor
 * 5. Continuous Calibration - Learn biases/scale when stationary
 */

import { describe, it, expect, beforeEach } from "vitest";

// ============================================================================
// Simulate Firmware Data Cleaning Logic
// ============================================================================

interface CalibrationData {
  accelOffsetX: number;
  accelOffsetY: number;
  accelOffsetZ: number;
  accelScale: number;
  gyroOffsetX: number;
  gyroOffsetY: number;
  gyroOffsetZ: number;
  isCalibrated: boolean;
  outlierCount: number;
}

interface IMUData {
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  timestamp: number;
}

interface RawSensorReading {
  ax_raw: number; // m/s² in sensor frame (Z-up)
  ay_raw: number;
  az_raw: number;
  gx_raw: number; // rad/s in sensor frame (Z-up)
  gy_raw: number;
  gz_raw: number;
}

// Constants matching firmware
const MAX_ACCEL_MS2 = 294.3; // ~30g
const MAX_GYRO_RADS = 35.0; // ~2000 dps
const MAX_OUTLIER_COUNT = 5;
const GYRO_LEARN_RATE = 0.01;
const ACCEL_SCALE_LEARN_RATE = 0.001;
const ACCEL_BIAS_LEARN_RATE = 0.005;
const FLAT_THRESHOLD = 0.5;
const GRAVITY = 9.81;

/**
 * Simulates the firmware data cleaning pipeline
 */
function processReading(
  raw: RawSensorReading,
  calibration: CalibrationData,
  previousData: IMUData | null,
): { data: IMUData | null; calibration: CalibrationData; isOutlier: boolean } {
  // STEP 2: Outlier Rejection
  const isOutlier =
    Math.abs(raw.ax_raw) > MAX_ACCEL_MS2 ||
    Math.abs(raw.ay_raw) > MAX_ACCEL_MS2 ||
    Math.abs(raw.az_raw) > MAX_ACCEL_MS2 ||
    Math.abs(raw.gx_raw) > MAX_GYRO_RADS ||
    Math.abs(raw.gy_raw) > MAX_GYRO_RADS ||
    Math.abs(raw.gz_raw) > MAX_GYRO_RADS ||
    Number.isNaN(raw.ax_raw) ||
    Number.isNaN(raw.ay_raw) ||
    Number.isNaN(raw.az_raw) ||
    Number.isNaN(raw.gx_raw) ||
    Number.isNaN(raw.gy_raw) ||
    Number.isNaN(raw.gz_raw);

  if (isOutlier) {
    calibration.outlierCount++;
    return {
      data: previousData, // Keep previous good reading
      calibration,
      isOutlier: true,
    };
  }

  // Reset outlier count on good reading
  calibration.outlierCount = 0;

  // STEP 3: Coordinate Transform (Z-up → Y-up)
  // Mapping: X→X, Z→Y, Y→-Z
  const ax_yup = raw.ax_raw;
  const ay_yup = raw.az_raw; // Z → Y
  const az_yup = -raw.ay_raw; // Y → -Z
  const gx_yup = raw.gx_raw;
  const gy_yup = raw.gz_raw; // Z → Y
  const gz_yup = -raw.gy_raw; // Y → -Z

  // STEP 4: Bias and Scale Correction
  let data: IMUData;
  if (calibration.isCalibrated) {
    const ax_biased = ax_yup - calibration.accelOffsetX;
    const ay_biased = ay_yup - calibration.accelOffsetY;
    const az_biased = az_yup - calibration.accelOffsetZ;

    data = {
      accelX: ax_biased * calibration.accelScale,
      accelY: ay_biased * calibration.accelScale,
      accelZ: az_biased * calibration.accelScale,
      gyroX: gx_yup - calibration.gyroOffsetX,
      gyroY: gy_yup - calibration.gyroOffsetY,
      gyroZ: gz_yup - calibration.gyroOffsetZ,
      timestamp: Date.now(),
    };
  } else {
    data = {
      accelX: ax_yup,
      accelY: ay_yup,
      accelZ: az_yup,
      gyroX: gx_yup,
      gyroY: gy_yup,
      gyroZ: gz_yup,
      timestamp: Date.now(),
    };
  }

  return { data, calibration, isOutlier: false };
}

/**
 * Simulates continuous calibration learning
 */
function learnCalibration(
  raw: RawSensorReading,
  data: IMUData,
  calibration: CalibrationData,
  stationaryFrames: number,
): CalibrationData {
  // Only learn if stationary for sufficient time
  if (stationaryFrames <= 60) return calibration;

  // Transform raw to Y-up for learning
  const gx_yup = raw.gx_raw;
  const gy_yup = raw.gz_raw;
  const gz_yup = -raw.gy_raw;
  const ax_yup = raw.ax_raw;
  const az_yup = -raw.ay_raw;

  // 5a: Gyro bias learning
  calibration.gyroOffsetX =
    (1 - GYRO_LEARN_RATE) * calibration.gyroOffsetX + GYRO_LEARN_RATE * gx_yup;
  calibration.gyroOffsetY =
    (1 - GYRO_LEARN_RATE) * calibration.gyroOffsetY + GYRO_LEARN_RATE * gy_yup;
  calibration.gyroOffsetZ =
    (1 - GYRO_LEARN_RATE) * calibration.gyroOffsetZ + GYRO_LEARN_RATE * gz_yup;

  // 5b: Accel scale learning
  const ax_biased = ax_yup - calibration.accelOffsetX;
  const ay_biased = raw.az_raw - calibration.accelOffsetY;
  const az_biased = az_yup - calibration.accelOffsetZ;
  const rawMag = Math.sqrt(ax_biased ** 2 + ay_biased ** 2 + az_biased ** 2);

  if (rawMag > 0.1) {
    const idealScale = GRAVITY / rawMag;
    calibration.accelScale =
      (1 - ACCEL_SCALE_LEARN_RATE) * calibration.accelScale +
      ACCEL_SCALE_LEARN_RATE * idealScale;

    // Clamp to ±10%
    calibration.accelScale = Math.max(
      0.9,
      Math.min(1.1, calibration.accelScale),
    );
  }

  // 5c: Accel bias learning (only when flat)
  if (Math.abs(data.accelY - GRAVITY) < FLAT_THRESHOLD) {
    calibration.accelOffsetX =
      (1 - ACCEL_BIAS_LEARN_RATE) * calibration.accelOffsetX +
      ACCEL_BIAS_LEARN_RATE * ax_yup;
    calibration.accelOffsetZ =
      (1 - ACCEL_BIAS_LEARN_RATE) * calibration.accelOffsetZ +
      ACCEL_BIAS_LEARN_RATE * az_yup;
  }

  return calibration;
}

/**
 * Check if sensor is stationary
 */
function isStationary(
  data: IMUData,
  zuptGyroThresh = 0.05,
  zuptAccelThresh = 0.5,
): boolean {
  const gyroMag = Math.sqrt(
    data.gyroX ** 2 + data.gyroY ** 2 + data.gyroZ ** 2,
  );
  const accelMag = Math.sqrt(
    data.accelX ** 2 + data.accelY ** 2 + data.accelZ ** 2,
  );
  const accelDiff = Math.abs(accelMag - GRAVITY);

  return gyroMag < zuptGyroThresh && accelDiff < zuptAccelThresh;
}

// ============================================================================
// Tests
// ============================================================================

describe("Data Cleaning Pipeline", () => {
  let calibration: CalibrationData;

  beforeEach(() => {
    calibration = {
      accelOffsetX: 0,
      accelOffsetY: 0,
      accelOffsetZ: 0,
      accelScale: 1.0,
      gyroOffsetX: 0,
      gyroOffsetY: 0,
      gyroOffsetZ: 0,
      isCalibrated: true,
      outlierCount: 0,
    };
  });

  describe("Outlier Rejection", () => {
    it("should reject readings exceeding max accel range", () => {
      const raw: RawSensorReading = {
        ax_raw: 300, // > 294.3 (30g)
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);
      expect(result.isOutlier).toBe(true);
      expect(result.calibration.outlierCount).toBe(1);
    });

    it("should reject readings exceeding max gyro range", () => {
      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 40, // > 35 rad/s
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);
      expect(result.isOutlier).toBe(true);
    });

    it("should reject NaN values", () => {
      const raw: RawSensorReading = {
        ax_raw: NaN,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);
      expect(result.isOutlier).toBe(true);
    });

    it("should accept valid readings", () => {
      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0.01,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);
      expect(result.isOutlier).toBe(false);
      expect(result.data).not.toBeNull();
    });

    it("should preserve previous data on outlier", () => {
      const previousData: IMUData = {
        accelX: 0,
        accelY: 9.81,
        accelZ: 0,
        gyroX: 0,
        gyroY: 0,
        gyroZ: 0,
        timestamp: 1000,
      };

      const raw: RawSensorReading = {
        ax_raw: 500, // Outlier
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, previousData);
      expect(result.isOutlier).toBe(true);
      expect(result.data).toEqual(previousData);
    });

    it("should track consecutive outliers", () => {
      const raw: RawSensorReading = {
        ax_raw: 500,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      // Process multiple outliers
      let cal = { ...calibration };
      for (let i = 0; i < 5; i++) {
        const result = processReading(raw, cal, null);
        cal = result.calibration;
      }

      expect(cal.outlierCount).toBe(5);
    });

    it("should reset outlier count on good reading", () => {
      calibration.outlierCount = 3;

      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);
      expect(result.calibration.outlierCount).toBe(0);
    });
  });

  describe("Coordinate Transform (Z-up → Y-up)", () => {
    it("should transform gravity correctly for flat sensor", () => {
      // Sensor flat on table: Z-up frame has gravity on +Z
      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 0,
        az_raw: 9.81, // Gravity on Z in sensor frame
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);

      // After transform: gravity should be on +Y (Three.js up)
      expect(result.data!.accelX).toBeCloseTo(0, 2);
      expect(result.data!.accelY).toBeCloseTo(9.81, 2); // Z→Y
      expect(result.data!.accelZ).toBeCloseTo(0, 2); // Y→-Z (0 stays 0)
    });

    it("should transform tilted sensor correctly", () => {
      // Sensor tilted 45° forward: gravity split between Y and Z in sensor frame
      const tilt = Math.PI / 4;
      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 9.81 * Math.sin(tilt), // ~6.94
        az_raw: 9.81 * Math.cos(tilt), // ~6.94
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);

      // Y-up frame: Y should be sensor Z, Z should be -sensor Y
      expect(result.data!.accelX).toBeCloseTo(0, 2);
      expect(result.data!.accelY).toBeCloseTo(9.81 * Math.cos(tilt), 2);
      expect(result.data!.accelZ).toBeCloseTo(-9.81 * Math.sin(tilt), 2);
    });

    it("should transform gyro readings correctly", () => {
      // Rotation around sensor Z-axis
      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 1.0, // Rotation around Z (sensor up)
      };

      const result = processReading(raw, calibration, null);

      // After transform: rotation around Y (webapp up)
      expect(result.data!.gyroX).toBeCloseTo(0, 4);
      expect(result.data!.gyroY).toBeCloseTo(1.0, 4); // Z→Y
      expect(result.data!.gyroZ).toBeCloseTo(0, 4);
    });
  });

  describe("Bias Correction", () => {
    it("should subtract calibrated bias offsets", () => {
      calibration.accelOffsetX = 0.1;
      calibration.accelOffsetY = -0.05;
      calibration.accelOffsetZ = 0.02;
      calibration.gyroOffsetX = 0.001;
      calibration.gyroOffsetY = -0.002;
      calibration.gyroOffsetZ = 0.0005;

      const raw: RawSensorReading = {
        ax_raw: 0.1, // Should become 0 after bias
        ay_raw: 0,
        az_raw: 9.81 - 0.05, // After transform: ay_yup = az_raw
        gx_raw: 0.001,
        gy_raw: 0.0005, // Will become -gz_yup
        gz_raw: -0.002, // Will become gy_yup
      };

      const result = processReading(raw, calibration, null);

      expect(result.data!.accelX).toBeCloseTo(0, 3);
      expect(result.data!.gyroX).toBeCloseTo(0, 4);
    });

    it("should not apply bias when not calibrated", () => {
      calibration.isCalibrated = false;
      calibration.accelOffsetX = 0.5; // This should be ignored

      const raw: RawSensorReading = {
        ax_raw: 0.2,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);

      // Should pass through without bias subtraction
      expect(result.data!.accelX).toBeCloseTo(0.2, 3);
    });
  });

  describe("Scale Correction", () => {
    it("should apply accelerometer scale factor", () => {
      calibration.accelScale = 1.05; // 5% scale correction

      const raw: RawSensorReading = {
        ax_raw: 1.0,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);

      expect(result.data!.accelX).toBeCloseTo(1.0 * 1.05, 3);
      expect(result.data!.accelY).toBeCloseTo(9.81 * 1.05, 2);
    });
  });

  describe("Stationary Detection", () => {
    it("should detect stationary state with low motion", () => {
      const data: IMUData = {
        accelX: 0,
        accelY: 9.81,
        accelZ: 0,
        gyroX: 0.01,
        gyroY: 0.01,
        gyroZ: 0.01,
        timestamp: 0,
      };

      expect(isStationary(data)).toBe(true);
    });

    it("should detect motion with high gyro", () => {
      const data: IMUData = {
        accelX: 0,
        accelY: 9.81,
        accelZ: 0,
        gyroX: 0.1, // Above threshold
        gyroY: 0,
        gyroZ: 0,
        timestamp: 0,
      };

      expect(isStationary(data)).toBe(false);
    });

    it("should detect motion with acceleration deviation", () => {
      const data: IMUData = {
        accelX: 5.0, // Significant added acceleration
        accelY: 9.81,
        accelZ: 0,
        gyroX: 0,
        gyroY: 0,
        gyroZ: 0,
        timestamp: 0,
      };

      // Magnitude is sqrt(5² + 9.81²) ≈ 11.0, diff from 9.81 > 0.5 threshold
      expect(isStationary(data)).toBe(false);
    });
  });

  describe("Continuous Calibration Learning", () => {
    it("should learn gyro bias when stationary", () => {
      const initialCalibration = { ...calibration, gyroOffsetX: 0 };

      // Simulate gyro with small bias
      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0.01, // Small gyro reading (should be zero when stationary)
        gy_raw: 0,
        gz_raw: 0,
      };

      const { data } = processReading(raw, initialCalibration, null);
      const learned = learnCalibration(raw, data!, initialCalibration, 100);

      // Should have learned some of the bias
      expect(learned.gyroOffsetX).toBeGreaterThan(0);
      expect(learned.gyroOffsetX).toBeLessThan(0.01);
    });

    it("should learn accel scale factor toward 1g", () => {
      // Sensor reads slightly high
      const initialCalibration = { ...calibration, accelScale: 1.0 };

      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 0,
        az_raw: 10.0, // Reading 10 instead of 9.81
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const { data } = processReading(raw, initialCalibration, null);
      const learned = learnCalibration(raw, data!, initialCalibration, 100);

      // Scale should move toward 9.81/10.0 = 0.981
      expect(learned.accelScale).toBeLessThan(1.0);
    });

    it("should clamp scale factor to ±10%", () => {
      const initialCalibration = { ...calibration, accelScale: 0.88 };

      // Even with extreme reading, scale should clamp
      const raw: RawSensorReading = {
        ax_raw: 0,
        ay_raw: 0,
        az_raw: 15.0, // Very high reading
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const { data } = processReading(raw, initialCalibration, null);
      const learned = learnCalibration(raw, data!, initialCalibration, 100);

      expect(learned.accelScale).toBeGreaterThanOrEqual(0.9);
      expect(learned.accelScale).toBeLessThanOrEqual(1.1);
    });

    it("should not learn when not stationary long enough", () => {
      const initialCalibration = { ...calibration };

      const raw: RawSensorReading = {
        ax_raw: 0.5,
        ay_raw: 0,
        az_raw: 9.81,
        gx_raw: 0.01,
        gy_raw: 0,
        gz_raw: 0,
      };

      const { data } = processReading(raw, initialCalibration, null);

      // Only 30 frames - not enough
      const learned = learnCalibration(raw, data!, initialCalibration, 30);

      // Should be unchanged
      expect(learned.accelOffsetX).toBe(0);
      expect(learned.gyroOffsetX).toBe(0);
    });

    it("should learn X/Z bias only when sensor is flat", () => {
      // Flat sensor: Y accel ≈ 9.81
      const flatCalibration = {
        ...calibration,
        accelOffsetX: 0,
        accelOffsetZ: 0,
      };

      const raw: RawSensorReading = {
        ax_raw: 0.1, // Small X bias
        ay_raw: 0,
        az_raw: 9.81, // Flat (becomes Y after transform)
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const { data } = processReading(raw, flatCalibration, null);
      const learned = learnCalibration(raw, data!, flatCalibration, 100);

      // Should have learned X bias
      expect(learned.accelOffsetX).toBeGreaterThan(0);
    });
  });

  describe("End-to-End Pipeline", () => {
    it("should produce correct gravity vector after full pipeline", () => {
      // Simulate a sensor that has slight biases
      calibration.accelOffsetX = 0.1;
      calibration.accelOffsetZ = -0.05;
      calibration.accelScale = 0.98; // Reads 2% low

      // Raw reading from flat sensor (Z-up frame)
      const raw: RawSensorReading = {
        ax_raw: 0.1, // Matches bias, should zero out
        ay_raw: 0.05, // Will become -Z, small error
        az_raw: 10.0, // Slightly high reading, will be scaled
        gx_raw: 0,
        gy_raw: 0,
        gz_raw: 0,
      };

      const result = processReading(raw, calibration, null);

      // After full correction:
      // X: (0.1 - 0.1) * 0.98 = 0
      // Y: (10.0 - 0) * 0.98 = 9.8 (from Z)
      // Z: (-0.05 - (-0.05)) * 0.98 = 0 (from -Y)
      expect(result.data!.accelX).toBeCloseTo(0, 2);
      expect(result.data!.accelY).toBeCloseTo(9.8, 1);
      expect(result.data!.accelZ).toBeCloseTo(0, 2);
    });

    it("should handle 100 frames of simulated data", () => {
      // Simulate 100 frames of slightly noisy stationary data
      let stationaryCount = 0;
      let cal = { ...calibration, gyroOffsetX: 0 };
      let lastData: IMUData | null = null;

      for (let frame = 0; frame < 100; frame++) {
        // Add small noise
        const noise = () => (Math.random() - 0.5) * 0.02;

        const raw: RawSensorReading = {
          ax_raw: 0 + noise(),
          ay_raw: 0 + noise(),
          az_raw: 9.81 + noise(),
          gx_raw: 0.005 + noise() * 0.01, // Small gyro bias
          gy_raw: 0 + noise() * 0.01,
          gz_raw: 0 + noise() * 0.01,
        };

        const result = processReading(raw, cal, lastData);

        if (!result.isOutlier && result.data) {
          lastData = result.data;

          if (isStationary(result.data)) {
            stationaryCount++;
          } else {
            stationaryCount = 0;
          }

          cal = learnCalibration(
            raw,
            result.data,
            result.calibration,
            stationaryCount,
          );
        }
      }

      // After 100 frames, should have learned some gyro bias
      expect(cal.gyroOffsetX).toBeGreaterThan(0);

      // Final data should still be reasonable
      expect(lastData).not.toBeNull();
      const mag = Math.sqrt(
        lastData!.accelX ** 2 + lastData!.accelY ** 2 + lastData!.accelZ ** 2,
      );
      expect(mag).toBeCloseTo(9.81, 0); // Within 1 m/s²
    });
  });
});
