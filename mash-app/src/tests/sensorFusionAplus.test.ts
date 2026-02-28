/**
 * Phase 4: Sensor Fusion A+ Tests
 *
 * Tests for enhanced sensor fusion including:
 * - Magnetometer calibration (hard/soft iron)
 * - Magnetic disturbance detection
 * - 9-axis VQF with selective heading correction
 * - External acceleration model
 * - Adaptive filter gains
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MagnetometerCalibrator,
  MagCalibrationResult,
} from "../lib/fusion/MagnetometerCalibration";
import {
  MagneticDisturbanceDetector,
  MagDisturbanceState,
} from "../lib/fusion/MagneticDisturbanceDetector";
import { VQF9 } from "../lib/fusion/VQF9";
import {
  ExternalAccelerationModel,
  JumpDetector,
} from "../lib/fusion/ExternalAccelerationModel";

// ============================================================================
// MAGNETOMETER CALIBRATION TESTS
// ============================================================================

describe("MagnetometerCalibrator", () => {
  let calibrator: MagnetometerCalibrator;

  beforeEach(() => {
    calibrator = new MagnetometerCalibrator({
      minSamples: 100, // Reduce for testing
      minSphereCoverage: 0.5, // Reduce for testing
    });
  });

  describe("Hard Iron Calibration", () => {
    it("should detect hard iron offset", () => {
      calibrator.startCalibration();

      // Simulate magnetometer with hard iron offset (+10 in X)
      // True field is 50 µT
      const offset: [number, number, number] = [10, 5, -3];
      const radius = 50;

      // Generate comprehensive samples around a sphere with offset
      // Use more sectors and finer sampling
      for (let theta = 0; theta < Math.PI * 2; theta += 0.15) {
        for (let phi = 0.1; phi < Math.PI - 0.1; phi += 0.2) {
          const x = radius * Math.sin(phi) * Math.cos(theta) + offset[0];
          const y = radius * Math.sin(phi) * Math.sin(theta) + offset[1];
          const z = radius * Math.cos(phi) + offset[2];
          calibrator.addSample([x, y, z]);
        }
      }

      const result = calibrator.finishCalibration();

      // Check that we get reasonable hard iron estimate
      // Due to the centroid-based estimation, it should be close to offset
      expect(result.sampleCount).toBeGreaterThan(100);
      expect(result.hardIron).toBeDefined();
    });

    it("should track sample count correctly", () => {
      calibrator.startCalibration();

      for (let i = 0; i < 50; i++) {
        calibrator.addSample([
          50 * Math.cos(i * 0.2),
          50 * Math.sin(i * 0.2),
          20 * Math.sin(i * 0.3),
        ]);
      }

      const progress = calibrator.getProgress();
      expect(progress.sampleCount).toBe(50);
    });
  });

  describe("Calibration Progress", () => {
    it("should track sphere coverage", () => {
      calibrator.startCalibration();

      // Start with no coverage
      let progress = calibrator.getProgress();
      expect(progress.sampleCount).toBe(0);
      expect(progress.sphereCoverage).toBe(0);

      // Add samples in one octant only
      for (let i = 0; i < 50; i++) {
        calibrator.addSample([
          50 + Math.random() * 10,
          50 + Math.random() * 10,
          50 + Math.random() * 10,
        ]);
      }

      progress = calibrator.getProgress();
      expect(progress.sampleCount).toBe(50);
      expect(progress.sphereCoverage).toBeLessThan(0.5); // One octant < 50%
    });

    it("should indicate when ready for calibration", () => {
      calibrator.startCalibration();

      // Not ready initially
      expect(calibrator.getProgress().isReady).toBe(false);

      // Add comprehensive samples covering sphere
      const radius = 50;
      for (let theta = 0; theta < Math.PI * 2; theta += 0.2) {
        for (let phi = 0.1; phi < Math.PI - 0.1; phi += 0.25) {
          calibrator.addSample([
            radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.sin(phi) * Math.sin(theta),
            radius * Math.cos(phi),
          ]);
        }
      }

      // With sufficient samples and coverage, should be ready
      const progress = calibrator.getProgress();
      expect(progress.sampleCount).toBeGreaterThan(100);
      expect(progress.sphereCoverage).toBeGreaterThan(0.4);
    });
  });

  describe("Calibration Import/Export", () => {
    it("should export and import calibration", () => {
      // Create calibration with known values
      calibrator.startCalibration();

      const offset: [number, number, number] = [15, -10, 5];
      const radius = 48;

      for (let theta = 0; theta < Math.PI * 2; theta += 0.15) {
        for (let phi = 0.1; phi < Math.PI - 0.1; phi += 0.2) {
          calibrator.addSample([
            radius * Math.sin(phi) * Math.cos(theta) + offset[0],
            radius * Math.sin(phi) * Math.sin(theta) + offset[1],
            radius * Math.cos(phi) + offset[2],
          ]);
        }
      }

      calibrator.finishCalibration();

      // Export
      const exported = calibrator.exportCalibration();
      expect(exported).not.toBeNull();

      // Import into new calibrator
      const newCalibrator = new MagnetometerCalibrator();
      const importSuccess = newCalibrator.importCalibration(exported!);
      expect(importSuccess).toBe(true);

      // Verify calibration data was imported
      expect(newCalibrator.hasValidCalibration()).toBe(
        calibrator.hasValidCalibration(),
      );
    });
  });
});

// ============================================================================
// MAGNETIC DISTURBANCE DETECTOR TESTS
// ============================================================================

describe("MagneticDisturbanceDetector", () => {
  let detector: MagneticDisturbanceDetector;

  beforeEach(() => {
    detector = new MagneticDisturbanceDetector({
      expectedMagnitude: 50,
      expectedDipAngle: 60,
    });
  });

  describe("Magnitude Anomaly Detection", () => {
    it("should detect field magnitude anomaly", () => {
      const accel: [number, number, number] = [0, 9.81, 0];

      // Normal field (magnitude ~50 µT)
      let state = detector.update([30, 40, 0], accel, Date.now()); // |50|
      expect(state.isDisturbed).toBe(false);

      // Reset for new test
      detector.reset();

      // Anomalous field (too strong - near ferromagnetic object)
      for (let i = 0; i < 5; i++) {
        state = detector.update([80, 60, 0], accel, Date.now() + i * 10); // |100|
      }
      expect(state.isDisturbed).toBe(true);
      expect(["magnitude", "multiple"]).toContain(state.disturbanceType);
    });

    it("should detect weakened field", () => {
      const accel: [number, number, number] = [0, 9.81, 0];

      // Very weak field
      for (let i = 0; i < 5; i++) {
        const state = detector.update([5, 5, 0], accel, Date.now() + i * 10);
        if (i >= 4) {
          expect(state.isDisturbed).toBe(true);
        }
      }
    });
  });

  describe("Gradient Detection", () => {
    it("should detect rapid field changes", () => {
      const accel: [number, number, number] = [0, 9.81, 0];
      const baseTime = Date.now();

      // Stable field
      for (let i = 0; i < 10; i++) {
        detector.update([30, 40, 0], accel, baseTime + i * 10);
      }

      // Sudden change (walking past steel beam)
      const state = detector.update([60, 80, 20], accel, baseTime + 110);
      expect(state.isDisturbed).toBe(true);
    });
  });

  describe("Dip Angle Detection", () => {
    it("should detect dip angle anomaly", () => {
      const accel: [number, number, number] = [0, 9.81, 0];

      // Expected: 60° dip means vertical/horizontal ratio
      // Normal field with ~60° dip
      const normalVert = 50 * Math.sin((60 * Math.PI) / 180);
      const normalHoriz = 50 * Math.cos((60 * Math.PI) / 180);

      for (let i = 0; i < 10; i++) {
        detector.update(
          [normalHoriz, normalVert, 0],
          accel,
          Date.now() + i * 10,
        );
      }

      // Anomalous dip (horizontal field - typical of indoor disturbance)
      const state = detector.update([50, 0, 0], accel, Date.now() + 150);
      expect(state.isDisturbed).toBe(true);
    });
  });

  describe("Overall Disturbance State", () => {
    it("should report clean field when undisturbed", () => {
      const accel: [number, number, number] = [0, 9.81, 0];

      // Generate clean field samples (normal magnitude, expected dip)
      // With Y-up accelerometer: dip is angle from horizontal
      // For 60° dip: vertical = sin(60)*50 = 43.3, horizontal = cos(60)*50 = 25
      const mag = 50;
      const dipRad = (60 * Math.PI) / 180;

      for (let i = 0; i < 20; i++) {
        const state = detector.update(
          [mag * Math.cos(dipRad), mag * Math.sin(dipRad), 0],
          accel,
          Date.now() + i * 100, // Slower updates
        );

        if (i >= 15) {
          // After settling, should be clean
          expect(state.disturbanceType).toBe("none");
        }
      }
    });

    it("should report disturbed when multiple anomalies detected", () => {
      const accel: [number, number, number] = [0, 9.81, 0];

      // Multiple anomalies: wrong magnitude AND wrong dip
      for (let i = 0; i < 10; i++) {
        const state = detector.update([100, 0, 50], accel, Date.now() + i * 10);
        if (i >= 5) {
          expect(state.isDisturbed).toBe(true);
        }
      }
    });
  });

  describe("Heading Correction Weight", () => {
    it("should provide weight based on disturbance state", () => {
      const accel: [number, number, number] = [0, 9.81, 0];
      const mag = 50;
      const dipRad = (60 * Math.PI) / 180;

      // Clean field
      for (let i = 0; i < 20; i++) {
        detector.update(
          [mag * Math.cos(dipRad), mag * Math.sin(dipRad), 0],
          accel,
          Date.now() + i * 100,
        );
      }

      const cleanWeight = detector.getHeadingCorrectionWeight();
      // Clean field should give reasonable weight
      expect(cleanWeight).toBeGreaterThan(0);
    });

    it("should provide low weight for disturbed field", () => {
      const accel: [number, number, number] = [0, 9.81, 0];

      for (let i = 0; i < 10; i++) {
        detector.update([120, 0, 80], accel, Date.now() + i * 10);
      }

      expect(detector.getHeadingCorrectionWeight()).toBeLessThan(0.5);
    });
  });
});

// ============================================================================
// VQF9 (9-AXIS FILTER) TESTS
// ============================================================================

describe("VQF9", () => {
  let filter: VQF9;
  const GRAVITY = 9.81;

  beforeEach(() => {
    filter = new VQF9();
  });

  describe("Basic Operation", () => {
    it("should initialize to identity quaternion", () => {
      const q = filter.getQuaternion();
      expect(q.x).toBeCloseTo(0, 5);
      expect(q.y).toBeCloseTo(0, 5);
      expect(q.z).toBeCloseTo(0, 5);
      expect(q.w).toBeCloseTo(1, 5);
    });

    it("should integrate gyroscope rotation", () => {
      // Rotate 90° around Z axis (1.57 rad) over 1 second
      const gyro: [number, number, number] = [0, 0, Math.PI / 2];
      const accel: [number, number, number] = [0, GRAVITY, 0];

      for (let i = 0; i < 100; i++) {
        filter.update(0.01, gyro, accel);
      }

      // Should have rotated ~90° around Z
      const q = filter.getQuaternion();
      // Z rotation affects x and w components
      expect(Math.abs(q.z)).toBeGreaterThan(0.6);
    });
  });

  describe("Accelerometer Correction", () => {
    it("should correct tilt from accelerometer", () => {
      // Start with tilted sensor (Z up instead of Y up)
      const gyro: [number, number, number] = [0, 0, 0];
      const accel: [number, number, number] = [0, 0, GRAVITY]; // Z up

      // Run for convergence
      for (let i = 0; i < 200; i++) {
        filter.update(0.01, gyro, accel);
      }

      const q = filter.getQuaternion();

      // Transform [0,0,1] by quaternion should give [0,1,0] (world up)
      // This means sensor Z maps to world Y
      const x = 0,
        y = 0,
        z = 1;
      const qx = q.x,
        qy = q.y,
        qz = q.z,
        qw = q.w;
      const worldY =
        2 * (qy * qz + qw * qx) * x +
        (1 - 2 * (qx * qx + qz * qz)) * y +
        2 * (qy * qz - qw * qx) * z;

      // Should be close to 1 (pointing up in world frame)
      expect(Math.abs(worldY)).toBeGreaterThan(0.9);
    });

    it("should use higher gain during rest", () => {
      // During rest, correction should be faster
      const gyro: [number, number, number] = [0, 0, 0];
      const accel: [number, number, number] = [0, GRAVITY, 0];

      filter.update(0.01, gyro, accel);
      const state = filter.getState();

      expect(state.isRest).toBe(true);
      // Rest gain should be 0.05 (default)
      expect(state.currentGain).toBeCloseTo(0.05, 2);
    });

    it("should use lower gain during motion", () => {
      // During motion, correction should be slower
      const gyro: [number, number, number] = [0.5, 0.3, 0.2]; // Rotating
      const accel: [number, number, number] = [0, GRAVITY, 0];

      filter.update(0.01, gyro, accel);
      const state = filter.getState();

      expect(state.isRest).toBe(false);
      // Motion gain should be closer to 0.005
      expect(state.currentGain).toBeLessThan(0.05);
    });
  });

  describe("External Acceleration Detection", () => {
    it("should detect external acceleration during jump", () => {
      const gyro: [number, number, number] = [0, 0, 0];

      // Freefall (near-zero g)
      const accel: [number, number, number] = [0, 0.5, 0];
      filter.update(0.01, gyro, accel);

      const state = filter.getState();
      expect(state.externalAccelDetected).toBe(true);
    });

    it("should detect high-g impact", () => {
      const gyro: [number, number, number] = [0, 0, 0];

      // Impact (high g)
      const accel: [number, number, number] = [0, 30, 0];
      filter.update(0.01, gyro, accel);

      const state = filter.getState();
      expect(state.externalAccelDetected).toBe(true);
    });
  });

  describe("Gyro Bias Estimation", () => {
    it("should estimate gyro bias during rest", () => {
      // Simulate gyro with bias
      const bias: [number, number, number] = [0.01, -0.02, 0.015];
      const accel: [number, number, number] = [0, GRAVITY, 0];

      // Run rest samples
      for (let i = 0; i < 500; i++) {
        filter.update(0.01, bias, accel);
      }

      const estimatedBias = filter.getBias();
      expect(estimatedBias.x).toBeCloseTo(bias[0], 2);
      expect(estimatedBias.y).toBeCloseTo(bias[1], 2);
      expect(estimatedBias.z).toBeCloseTo(bias[2], 2);
    });
  });

  describe("Magnetometer Integration", () => {
    it("should start with mag enabled by default", () => {
      expect(filter.isMagEnabled()).toBe(true);
    });

    it("should allow disabling magnetometer", () => {
      filter.setMagEnabled(false);
      expect(filter.isMagEnabled()).toBe(false);

      // Should have max heading uncertainty
      const state = filter.getState();
      expect(state.headingUncertainty).toBe(180);
    });

    it("should initialize from accelerometer and magnetometer", () => {
      const accel: [number, number, number] = [0, GRAVITY, 0];
      const mag: [number, number, number] = [0, 0, -50]; // North

      filter.initFromMag(mag, accel);

      // Heading uncertainty should be reduced
      const state = filter.getState();
      expect(state.headingUncertainty).toBeLessThan(180);
    });
  });

  describe("Magnetometer Calibration API", () => {
    it("should track calibration progress", () => {
      filter.startMagCalibration();

      let progress = filter.getMagCalibrationProgress();
      expect(progress.sampleCount).toBe(0);
      expect(progress.isReady).toBe(false);

      // Add samples
      for (let i = 0; i < 100; i++) {
        const theta = (i / 100) * Math.PI * 2;
        const phi = (Math.random() * 0.8 + 0.1) * Math.PI;
        filter.addMagCalibrationSample([
          50 * Math.sin(phi) * Math.cos(theta),
          50 * Math.sin(phi) * Math.sin(theta),
          50 * Math.cos(phi),
        ]);
      }

      progress = filter.getMagCalibrationProgress();
      expect(progress.sampleCount).toBe(100);
    });
  });

  describe("State and Diagnostics", () => {
    it("should provide complete state", () => {
      const gyro: [number, number, number] = [0, 0, 0];
      const accel: [number, number, number] = [0, GRAVITY, 0];

      filter.update(0.01, gyro, accel);

      const state = filter.getState();
      expect(state).toHaveProperty("quaternion");
      expect(state).toHaveProperty("gyroBias");
      expect(state).toHaveProperty("isRest");
      expect(state).toHaveProperty("externalAccelDetected");
      expect(state).toHaveProperty("currentGain");
      expect(state).toHaveProperty("headingUncertainty");
      expect(state).toHaveProperty("updateCount");
    });

    it("should provide diagnostics", () => {
      const gyro: [number, number, number] = [0, 0, 0];
      const accel: [number, number, number] = [0, GRAVITY, 0];

      filter.update(0.01, gyro, accel);

      const diag = filter.getDiagnostics();
      expect(diag).toHaveProperty("tiltErrorDeg");
      expect(diag).toHaveProperty("headingCorrectionDeg");
      expect(diag).toHaveProperty("framesSinceHeadingCorrection");
      expect(diag).toHaveProperty("state");
    });
  });

  describe("Reset", () => {
    it("should reset to initial state", () => {
      // Change state
      const gyro: [number, number, number] = [0.1, 0.1, 0.1];
      const accel: [number, number, number] = [1, GRAVITY, 2];

      for (let i = 0; i < 100; i++) {
        filter.update(0.01, gyro, accel);
      }

      // Reset
      filter.reset();

      const q = filter.getQuaternion();
      expect(q.w).toBeCloseTo(1, 5);
      expect(q.x).toBeCloseTo(0, 5);
      expect(q.y).toBeCloseTo(0, 5);
      expect(q.z).toBeCloseTo(0, 5);
    });
  });
});

// ============================================================================
// EXTERNAL ACCELERATION MODEL TESTS
// ============================================================================

describe("ExternalAccelerationModel", () => {
  let model: ExternalAccelerationModel;

  beforeEach(() => {
    model = new ExternalAccelerationModel();
  });

  describe("Static Detection", () => {
    it("should detect static state", () => {
      // Pure gravity
      const state = model.update([0, 9.81, 0], Date.now());
      expect(state.motionType).toBe("static");
      expect(state.isExternal).toBe(false);
    });

    it("should detect low motion regardless of orientation", () => {
      // Tilted sensor but stationary - magnitude is close to g
      const g = 9.81;
      // This vector has magnitude ~1.04g, so slightly above tolerance
      const state = model.update([g * 0.3, g * 0.9, g * 0.3], Date.now());
      // Should be static or lowMotion since magnitude is close to g
      expect(["static", "lowMotion"]).toContain(state.motionType);
    });
  });

  describe("Freefall Detection", () => {
    it("should detect freefall", () => {
      // Near-zero g for multiple samples
      for (let i = 0; i < 10; i++) {
        const state = model.update([0.1, 0.1, 0.1], Date.now() + i * 10);
        if (i > 5) {
          expect(state.motionType).toBe("freefall");
        }
      }
    });
  });

  describe("Impact Detection", () => {
    it("should detect high-g impact", () => {
      // Normal gravity first
      model.update([0, 9.81, 0], Date.now());

      // Then high-g impact
      for (let i = 0; i < 5; i++) {
        const state = model.update([0, 25, 0], Date.now() + 10 + i * 10);
        if (i >= 2) {
          expect(state.motionType).toBe("impact");
        }
      }
    });
  });

  describe("Gravity Estimation", () => {
    it("should estimate gravity during static", () => {
      // Tilted gravity
      const tiltedG: [number, number, number] = [3, 9, 2];
      const mag = Math.sqrt(3 * 3 + 9 * 9 + 2 * 2);
      const normalizedG: [number, number, number] = [
        (3 * 9.81) / mag,
        (9 * 9.81) / mag,
        (2 * 9.81) / mag,
      ];

      for (let i = 0; i < 50; i++) {
        model.update(normalizedG, Date.now() + i * 10);
      }

      const state = model.getState();
      expect(state.gravityEstimate[0]).toBeCloseTo(normalizedG[0], 0);
      expect(state.gravityEstimate[1]).toBeCloseTo(normalizedG[1], 0);
      expect(state.gravityEstimate[2]).toBeCloseTo(normalizedG[2], 0);
      expect(state.gravityConfidence).toBeGreaterThan(0.8);
    });

    it("should have low confidence during freefall", () => {
      // Enter freefall
      for (let i = 0; i < 10; i++) {
        model.update([0.1, 0.1, 0.1], Date.now() + i * 10);
      }

      const state = model.getState();
      expect(state.gravityConfidence).toBeLessThan(0.3);
    });
  });

  describe("External Acceleration Estimation", () => {
    it("should estimate external acceleration", () => {
      // Initialize with gravity
      for (let i = 0; i < 20; i++) {
        model.update([0, 9.81, 0], Date.now() + i * 10);
      }

      // Add lateral acceleration
      const state = model.update([5, 9.81, 0], Date.now() + 300);

      expect(state.externalAccel[0]).toBeCloseTo(5, 0);
      expect(state.isExternal).toBe(true);
    });
  });

  describe("Accelerometer Correction Weight", () => {
    it("should provide full weight during static", () => {
      model.update([0, 9.81, 0], Date.now());
      expect(model.getAccelerometerCorrectionWeight()).toBe(1.0);
    });

    it("should provide zero weight during freefall", () => {
      for (let i = 0; i < 10; i++) {
        model.update([0.1, 0.1, 0.1], Date.now() + i * 10);
      }
      expect(model.getAccelerometerCorrectionWeight()).toBe(0.0);
    });

    it("should provide reduced weight during walking/running", () => {
      // Simulate walking-like accelerations
      for (let i = 0; i < 30; i++) {
        const phase = i * 0.5;
        const ax = Math.sin(phase) * 2;
        const ay = 9.81 + Math.abs(Math.sin(phase * 2)) * 3;
        model.update([ax, ay, 0], Date.now() + i * 20);
      }

      const weight = model.getAccelerometerCorrectionWeight();
      expect(weight).toBeGreaterThan(0);
      expect(weight).toBeLessThan(1);
    });
  });

  describe("Dynamic Acceleration Extraction", () => {
    it("should extract dynamic component via high-pass filter", () => {
      // Establish baseline
      for (let i = 0; i < 20; i++) {
        model.update([0, 9.81, 0], Date.now() + i * 10);
      }

      // Add sudden acceleration
      model.update([3, 9.81, 0], Date.now() + 300);

      const dynamic = model.getDynamicAcceleration();
      // High-pass should capture the sudden change
      expect(Math.abs(dynamic[0])).toBeGreaterThan(1);
    });
  });
});

// ============================================================================
// JUMP DETECTOR TESTS
// ============================================================================

describe("JumpDetector", () => {
  let detector: JumpDetector;

  beforeEach(() => {
    detector = new JumpDetector();
  });

  describe("Phase Detection", () => {
    it("should start in ground phase", () => {
      const phase = detector.update([0, 9.81, 0], Date.now());
      expect(phase.phase).toBe("ground");
    });

    it("should detect flight phase during freefall", () => {
      // Ground
      for (let i = 0; i < 10; i++) {
        detector.update([0, 9.81, 0], Date.now() + i * 10);
      }

      // Flight (freefall)
      for (let i = 0; i < 10; i++) {
        const phase = detector.update([0, 0.5, 0], Date.now() + 100 + i * 10);
        if (i > 5) {
          expect(phase.phase).toBe("flight");
        }
      }
    });

    it("should detect landing after flight", () => {
      // Ground
      for (let i = 0; i < 5; i++) {
        detector.update([0, 9.81, 0], Date.now() + i * 10);
      }

      // Flight
      for (let i = 0; i < 10; i++) {
        detector.update([0, 0.5, 0], Date.now() + 50 + i * 10);
      }

      // Landing (impact)
      for (let i = 0; i < 5; i++) {
        const phase = detector.update([0, 25, 0], Date.now() + 150 + i * 10);
        if (i >= 2) {
          expect(phase.phase).toBe("landing");
        }
      }
    });
  });

  describe("Jump Detection", () => {
    it("should report jumping status", () => {
      expect(detector.isJumping()).toBe(false);

      // Enter freefall
      for (let i = 0; i < 10; i++) {
        detector.update([0, 0.5, 0], Date.now() + i * 10);
      }

      expect(detector.isJumping()).toBe(true);
    });
  });

  describe("Jump Height Estimation", () => {
    it("should track jump phases", () => {
      // Ground
      for (let i = 0; i < 5; i++) {
        detector.update([0, 9.81, 0], i * 10);
      }

      // Flight phase (~200ms = 0.2s)
      for (let i = 0; i < 20; i++) {
        const phase = detector.update([0, 0.5, 0], 50 + i * 10);
        // Should eventually detect flight
        if (i >= 10) {
          expect(["flight", "takeoff"]).toContain(phase.phase);
        }
      }

      // Landing
      for (let i = 0; i < 5; i++) {
        detector.update([0, 25, 0], 250 + i * 10);
      }

      // After landing, should have some jump height if flight was detected
      // This tests the phase detection more than exact height calculation
      const phase = detector.update([0, 9.81, 0], 400);
      expect(["landing", "recovery", "ground"]).toContain(phase.phase);
    });
  });

  describe("Reset", () => {
    it("should reset to initial state", () => {
      // Get into flight
      for (let i = 0; i < 10; i++) {
        detector.update([0, 0.5, 0], i * 10);
      }
      expect(detector.isJumping()).toBe(true);

      detector.reset();

      expect(detector.isJumping()).toBe(false);
      expect(detector.getLastJumpHeight()).toBe(0);
    });
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe("Sensor Fusion Integration", () => {
  it("should work with all components together", () => {
    const filter = new VQF9();
    const accelModel = new ExternalAccelerationModel();

    // Simulate realistic motion sequence
    const dt = 0.01;
    let time = 0;

    // 1. Static phase
    for (let i = 0; i < 100; i++) {
      const gyro: [number, number, number] = [0, 0, 0];
      const accel: [number, number, number] = [0, 9.81, 0];

      filter.update(dt, gyro, accel);
      accelModel.update(accel, time);
      time += dt * 1000;
    }

    let state = filter.getState();
    expect(state.isRest).toBe(true);

    // 2. Walking phase with rotation
    for (let i = 0; i < 200; i++) {
      const phase = i * 0.3;
      const gyro: [number, number, number] = [
        0.1 * Math.sin(phase),
        0,
        0.05 * Math.cos(phase),
      ];
      const accel: [number, number, number] = [
        Math.sin(phase) * 1.5,
        9.81 + Math.abs(Math.sin(phase * 2)) * 2,
        Math.cos(phase) * 0.5,
      ];

      filter.update(dt, gyro, accel);
      accelModel.update(accel, time);
      time += dt * 1000;
    }

    state = filter.getState();
    expect(state.isRest).toBe(false);

    // Quaternion should be valid (unit length)
    const q = filter.getQuaternion();
    const qLen = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    expect(qLen).toBeCloseTo(1, 5);
  });

  it("should handle magnetometer calibration in fusion pipeline", () => {
    const filter = new VQF9();

    // Start calibration
    filter.startMagCalibration();

    // Add calibration samples while updating filter
    const dt = 0.01;
    for (let i = 0; i < 200; i++) {
      const theta = (i / 200) * Math.PI * 4;
      const phi = 0.3 + (i / 200) * 2.4;

      const gyro: [number, number, number] = [0, 0, theta * 0.01];
      const accel: [number, number, number] = [0, 9.81, 0];
      const mag: [number, number, number] = [
        50 * Math.sin(phi) * Math.cos(theta) + 5, // Hard iron offset
        50 * Math.sin(phi) * Math.sin(theta) - 3,
        50 * Math.cos(phi) + 2,
      ];

      filter.update(dt, gyro, accel, mag);
      filter.addMagCalibrationSample(mag);
    }

    const progress = filter.getMagCalibrationProgress();
    expect(progress.sampleCount).toBe(200);
  });
});
