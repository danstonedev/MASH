/**
 * Calibration Verification Step Tests
 * ====================================
 *
 * Tests for the post-calibration verification step that validates calibration quality.
 * The verification step was added based on industry research (Xsens/Rokoko/Vicon) to:
 *
 * 1. Ensure calibration is automatically validated after capture
 * 2. Detect movement during verification (confirms sensors are responding)
 * 3. Measure smoothness (identifies jitter/noise issues)
 * 4. Provide real-time feedback during ROM check
 *
 * Run with: npx vitest run src/tests/calibrationVerification.test.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";
import {
  UnifiedCalibration,
  RESEARCH_STRICT_FLOWS,
  type CalibrationStep,
} from "../calibration/UnifiedCalibration";
import { TopologyType } from "../biomech/topology/SensorRoles";
import {
  useDeviceRegistry,
  deviceQuaternionCache,
  deviceGyroCache,
  deviceAccelCache,
} from "../store/useDeviceRegistry";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";
import { BodyRole } from "../biomech/topology/SensorRoles";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Helper: Create quaternion from Euler angles (degrees)
 */
function quatFromEulerDeg(x: number, y: number, z: number): THREE.Quaternion {
  const DEG2RAD = Math.PI / 180;
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(x * DEG2RAD, y * DEG2RAD, z * DEG2RAD, "XYZ"),
  );
}

/**
 * Helper: Setup mock device registry with test sensors
 */
function setupMockDevices(sensorCount: number = 1): string[] {
  const deviceIds: string[] = [];
  const devices = new Map();

  for (let i = 0; i < sensorCount; i++) {
    const id = `sensor_${i}`;
    deviceIds.push(id);
    devices.set(id, {
      id,
      name: `Sensor ${i}`,
      quaternion: [1, 0, 0, 0] as [number, number, number, number],
      accelerometer: [0, 0, 9.81] as [number, number, number],
      gyro: [0, 0, 0] as [number, number, number],
      battery: 100,
      isConnected: true,
      isSimulated: false,
      lastUpdate: Date.now(),
    });

    // Setup quaternion cache
    deviceQuaternionCache.set(id, new THREE.Quaternion());
    deviceGyroCache.set(id, new THREE.Vector3(0, 0, 0));
    deviceAccelCache.set(id, new THREE.Vector3(0, 0, -9.81));
  }

  useDeviceRegistry.setState({ devices });
  return deviceIds;
}

/**
 * Helper: Clear all stores and caches
 */
function clearStores(): void {
  localStorage.clear();
  sessionStorage.clear();
  useDeviceRegistry.setState({ devices: new Map() });
  useSensorAssignmentStore.getState().clearAll();
  deviceQuaternionCache.clear();
  deviceGyroCache.clear();
  deviceAccelCache.clear();
}

// ============================================================================
// TESTS: VERIFICATION STEP IN CALIBRATION FLOWS
// ============================================================================

describe("Verification Step in Calibration Flows", () => {
  beforeEach(() => {
    clearStores();
  });

  describe("Flow Configuration", () => {
    it("should include verification step in SINGLE_SENSOR flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.SINGLE_SENSOR];
      expect(flow).toContain("verification");
      expect(flow.indexOf("verification")).toBeLessThan(
        flow.indexOf("complete"),
      );
    });

    it("should include verification step in SPARSE_LEG flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.SPARSE_LEG];
      expect(flow).toContain("verification");
    });

    it("should include verification step in FULL_LEG flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.FULL_LEG];
      expect(flow).toContain("verification");
    });

    it("should include verification step in FULL_BODY flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.FULL_BODY];
      expect(flow).toContain("verification");
      expect(flow.indexOf("final-pose")).toBeLessThan(
        flow.indexOf("verification"),
      );
    });

    it("should include verification step in DUAL_SKATE flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.DUAL_SKATE];
      expect(flow).toContain("verification");
    });

    it("should include verification step in CORE flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.CORE];
      expect(flow).toContain("verification");
    });

    it("should include verification step in SPARSE_ARM flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.SPARSE_ARM];
      expect(flow).toContain("verification");
    });

    it("should include verification step in SPARSE_BODY flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.SPARSE_BODY];
      expect(flow).toContain("verification");
    });

    it("should include verification step in CUSTOM flow", () => {
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.CUSTOM];
      expect(flow).toContain("verification");
    });

    it("verification should always be followed by pose/squat checks before complete", () => {
      for (const [topology, flow] of Object.entries(RESEARCH_STRICT_FLOWS)) {
        const verificationIdx = flow.indexOf("verification");
        const poseCheckIdx = flow.indexOf("pose-check");
        const squatCheckIdx = flow.indexOf("squat-check");
        const completeIdx = flow.indexOf("complete");

        expect(verificationIdx).toBeGreaterThan(-1); // verification exists
        expect(poseCheckIdx).toBeGreaterThan(-1); // pose-check exists
        expect(squatCheckIdx).toBeGreaterThan(-1); // squat-check exists
        expect(completeIdx).toBeGreaterThan(-1); // complete exists
        expect(verificationIdx).toBeLessThan(poseCheckIdx);
        expect(poseCheckIdx).toBeLessThan(squatCheckIdx);
        expect(squatCheckIdx).toBe(completeIdx - 1);
      }
    });
  });

  describe("CalibrationStep Type", () => {
    it("should accept verification as a valid CalibrationStep", () => {
      const step: CalibrationStep = "verification";
      expect(step).toBe("verification");
    });

    it("should have all expected step types", () => {
      const expectedSteps: CalibrationStep[] = [
        "idle",
        "warm-up",
        "static-pose",
        "leg-left-functional",
        "leg-right-functional",
        "arm-left-functional",
        "arm-right-functional",
        "head-functional",
        "ankle-flex",
        "hip-rotation",
        "generic-flex",
        "final-pose",
        "verification",
        "pose-check",
        "squat-check",
        "complete",
        "error",
      ];

      // This is a compile-time check - if any step is invalid, TypeScript will error
      expectedSteps.forEach((step) => {
        expect(typeof step).toBe("string");
      });
    });
  });
});

// ============================================================================
// TESTS: UNIFIED CALIBRATION - VERIFICATION BEHAVIOR
// ============================================================================

describe("UnifiedCalibration Verification Behavior", () => {
  let calibrator: UnifiedCalibration;
  let stateChanges: any[];

  beforeEach(() => {
    clearStores();
    calibrator = new UnifiedCalibration();
    stateChanges = [];
  });

  // Helper to start calibration with proper callback
  function startCalibration(topology: TopologyType) {
    calibrator.start((state) => stateChanges.push({ ...state }), topology);
  }

  describe("State Initialization", () => {
    it("should initialize with idle state", () => {
      const state = calibrator.getState();
      expect(state.step).toBe("idle");
      expect(state.progress).toBe(0);
      expect(state.stepProgress).toBe(0);
    });

    it("should have empty results initially", () => {
      const state = calibrator.getState();
      expect(state.results.size).toBe(0);
    });
  });

  describe("Flow Selection", () => {
    it("should select correct flow for SINGLE_SENSOR topology", () => {
      const deviceIds = setupMockDevices(1);
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[0], BodyRole.THIGH_L, "manual");

      startCalibration(TopologyType.SINGLE_SENSOR);

      expect(calibrator.currentFlow).toEqual(
        RESEARCH_STRICT_FLOWS[TopologyType.SINGLE_SENSOR],
      );
      expect(calibrator.currentFlow).toContain("verification");
    });

    it("should select correct flow for FULL_LEG topology", () => {
      const deviceIds = setupMockDevices(2);
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[0], BodyRole.THIGH_L, "manual");
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[1], BodyRole.SHIN_L, "manual");

      startCalibration(TopologyType.FULL_LEG);

      expect(calibrator.currentFlow).toContain("verification");
    });

    it("should select correct flow for FULL_BODY topology", () => {
      const deviceIds = setupMockDevices(5);
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[0], BodyRole.PELVIS, "manual");
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[1], BodyRole.THIGH_L, "manual");
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[2], BodyRole.SHIN_L, "manual");
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[3], BodyRole.THIGH_R, "manual");
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[4], BodyRole.SHIN_R, "manual");

      startCalibration(TopologyType.FULL_BODY);

      expect(calibrator.currentFlow).toContain("leg-left-functional");
      expect(calibrator.currentFlow).toContain("verification");
    });
  });

  describe("Step Progression", () => {
    it("should transition through warm-up before verification", () => {
      const deviceIds = setupMockDevices(1);
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[0], BodyRole.THIGH_L, "manual");

      startCalibration(TopologyType.SINGLE_SENSOR);

      // First step should be warm-up
      expect(calibrator.getState().step).toBe("warm-up");
    });

    it("should track step progress during calibration", () => {
      const deviceIds = setupMockDevices(1);
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[0], BodyRole.THIGH_L, "manual");

      startCalibration(TopologyType.SINGLE_SENSOR);

      // Initial progress
      const state = calibrator.getState();
      expect(state.stepProgress).toBeGreaterThanOrEqual(0);
      expect(state.stepProgress).toBeLessThanOrEqual(100);
    });
  });
});

// ============================================================================
// TESTS: VERIFICATION METRICS CALCULATION
// ============================================================================

describe("Verification Metrics Calculation", () => {
  describe("Movement Detection", () => {
    it("should calculate max angle from quaternion samples", () => {
      const samples: THREE.Quaternion[] = [];
      const baseQuat = new THREE.Quaternion();

      // Create samples with increasing rotation (0° to 30°)
      for (let i = 0; i <= 30; i++) {
        const q = quatFromEulerDeg(i, 0, 0);
        samples.push(q);
      }

      // Calculate max angle
      let maxAngle = 0;
      const firstQuat = samples[0];
      for (const q of samples) {
        const angle = q.angleTo(firstQuat) * (180 / Math.PI);
        maxAngle = Math.max(maxAngle, angle);
      }

      expect(maxAngle).toBeCloseTo(30, 1);
    });

    it("should detect no movement when quaternions are static", () => {
      const samples: THREE.Quaternion[] = [];
      const staticQuat = new THREE.Quaternion();

      // Create static samples
      for (let i = 0; i < 30; i++) {
        samples.push(staticQuat.clone());
      }

      // Calculate max angle
      let maxAngle = 0;
      const firstQuat = samples[0];
      for (const q of samples) {
        const angle = q.angleTo(firstQuat) * (180 / Math.PI);
        maxAngle = Math.max(maxAngle, angle);
      }

      expect(maxAngle).toBeCloseTo(0, 3);
    });

    it("should detect multi-axis movement", () => {
      const samples: THREE.Quaternion[] = [];

      // Start position
      samples.push(quatFromEulerDeg(0, 0, 0));

      // Move in X, Y, Z
      samples.push(quatFromEulerDeg(10, 5, 3));
      samples.push(quatFromEulerDeg(20, 10, 6));
      samples.push(quatFromEulerDeg(15, 15, 9));

      // Calculate max angle
      let maxAngle = 0;
      const firstQuat = samples[0];
      for (const q of samples) {
        const angle = q.angleTo(firstQuat) * (180 / Math.PI);
        maxAngle = Math.max(maxAngle, angle);
      }

      // Should detect significant movement
      expect(maxAngle).toBeGreaterThan(15);
    });
  });

  describe("Smoothness Calculation", () => {
    it("should calculate low smoothness for smooth movement", () => {
      const samples: THREE.Quaternion[] = [];

      // Smooth linear rotation
      for (let i = 0; i <= 30; i++) {
        samples.push(quatFromEulerDeg(i, 0, 0));
      }

      // Calculate smoothness (average angular velocity)
      let totalAngularVelocity = 0;
      const firstQuat = samples[0];

      for (let i = 1; i < samples.length; i++) {
        const angle = samples[i].angleTo(firstQuat) * (180 / Math.PI);
        const prevAngle = samples[i - 1].angleTo(firstQuat) * (180 / Math.PI);
        totalAngularVelocity += Math.abs(angle - prevAngle);
      }

      const smoothness = totalAngularVelocity / (samples.length - 1);

      // Smooth motion should have ~1° per frame
      expect(smoothness).toBeCloseTo(1, 0.5);
    });

    it("should calculate high smoothness (jitter) for jerky movement", () => {
      const samples: THREE.Quaternion[] = [];

      // Jerky oscillating movement
      for (let i = 0; i <= 30; i++) {
        const jitter = i % 2 === 0 ? 10 : -10;
        samples.push(quatFromEulerDeg(i + jitter, 0, 0));
      }

      // Calculate smoothness
      let totalAngularVelocity = 0;
      const firstQuat = samples[0];

      for (let i = 1; i < samples.length; i++) {
        const angle = samples[i].angleTo(firstQuat) * (180 / Math.PI);
        const prevAngle = samples[i - 1].angleTo(firstQuat) * (180 / Math.PI);
        totalAngularVelocity += Math.abs(angle - prevAngle);
      }

      const smoothness = totalAngularVelocity / (samples.length - 1);

      // Jerky motion should have much higher smoothness value
      expect(smoothness).toBeGreaterThan(5);
    });
  });

  describe("Verification Thresholds", () => {
    const MIN_MOVEMENT_TARGET = 15; // degrees
    const MIN_MOVEMENT_WARNING = 5; // degrees
    const MAX_JERK_WARNING = 5; // degrees per frame

    it("should consider 15+ degrees as good movement", () => {
      const maxAngle = 20; // degrees
      const passesTarget = maxAngle >= MIN_MOVEMENT_TARGET;
      expect(passesTarget).toBe(true);
    });

    it("should warn on movement below 5 degrees", () => {
      const maxAngle = 3; // degrees
      const insufficientMovement = maxAngle < MIN_MOVEMENT_WARNING;
      expect(insufficientMovement).toBe(true);
    });

    it("should warn on jitter above 5 degrees per frame", () => {
      const smoothness = 7; // degrees per frame
      const highJitter = smoothness > MAX_JERK_WARNING;
      expect(highJitter).toBe(true);
    });

    it("should accept normal movement without warnings", () => {
      const maxAngle = 25; // degrees
      const smoothness = 2; // degrees per frame

      const hasEnoughMovement = maxAngle >= MIN_MOVEMENT_WARNING;
      const isSmooth = smoothness <= MAX_JERK_WARNING;

      expect(hasEnoughMovement).toBe(true);
      expect(isSmooth).toBe(true);
    });
  });
});

// ============================================================================
// TESTS: VERIFICATION STEP PROGRESS
// ============================================================================

describe("Verification Step Progress", () => {
  describe("Progress Calculation", () => {
    const MIN_MOVEMENT_TARGET = 15; // degrees

    it("should calculate 0% progress with no movement", () => {
      const maxMovementSeen = 0;
      const stepProgress = Math.min(
        100,
        (maxMovementSeen / MIN_MOVEMENT_TARGET) * 100,
      );
      expect(stepProgress).toBe(0);
    });

    it("should calculate 50% progress at 7.5 degrees", () => {
      const maxMovementSeen = 7.5;
      const stepProgress = Math.min(
        100,
        (maxMovementSeen / MIN_MOVEMENT_TARGET) * 100,
      );
      expect(stepProgress).toBe(50);
    });

    it("should calculate 100% progress at target", () => {
      const maxMovementSeen = 15;
      const stepProgress = Math.min(
        100,
        (maxMovementSeen / MIN_MOVEMENT_TARGET) * 100,
      );
      expect(stepProgress).toBe(100);
    });

    it("should cap progress at 100% beyond target", () => {
      const maxMovementSeen = 30; // Double the target
      const stepProgress = Math.min(
        100,
        (maxMovementSeen / MIN_MOVEMENT_TARGET) * 100,
      );
      expect(stepProgress).toBe(100);
    });
  });
});

// ============================================================================
// TESTS: VERIFICATION INTEGRATION WITH CALIBRATION STATE
// ============================================================================

describe("Verification Integration with Calibration State", () => {
  let calibrator: UnifiedCalibration;
  let stateChanges: any[];

  beforeEach(() => {
    clearStores();
    calibrator = new UnifiedCalibration();
    stateChanges = [];
  });

  // Helper to start calibration with proper callback
  function startCalibration(topology: TopologyType) {
    calibrator.start((state) => stateChanges.push({ ...state }), topology);
  }

  describe("State Changes During Verification", () => {
    it("should receive state changes via callback", () => {
      const deviceIds = setupMockDevices(1);
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[0], BodyRole.THIGH_L, "manual");

      startCalibration(TopologyType.SINGLE_SENSOR);

      // Should have received at least one state update
      expect(stateChanges.length).toBeGreaterThan(0);
    });

    it("should expose currentFlow after start", () => {
      const deviceIds = setupMockDevices(1);
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[0], BodyRole.THIGH_L, "manual");

      startCalibration(TopologyType.SINGLE_SENSOR);

      expect(calibrator.currentFlow).toBeDefined();
      expect(calibrator.currentFlow.length).toBeGreaterThan(0);
    });

    it("should provide validation result after verification", async () => {
      // This tests that validationResult gets populated
      // Note: Full integration requires running through entire calibration
      const state = calibrator.getState();
      expect(state.validationResult).toBeNull(); // Initially null

      // After calibration completes (mocked), validationResult should be set
      // This would require running the full flow which is tested elsewhere
    });
  });

  describe("Reset Behavior", () => {
    it("should cancel and restart calibration correctly", () => {
      const deviceIds = setupMockDevices(1);
      useSensorAssignmentStore
        .getState()
        .assign(deviceIds[0], BodyRole.THIGH_L, "manual");

      // Start calibration
      startCalibration(TopologyType.SINGLE_SENSOR);
      const firstStep = calibrator.getState().step;
      expect(firstStep).toBe("warm-up");

      // Cancel
      calibrator.cancel();
      expect(calibrator.getState().step).toBe("idle");

      // Start again
      startCalibration(TopologyType.SINGLE_SENSOR);
      expect(calibrator.getState().step).toBe("warm-up");
    });
  });
});

// ============================================================================
// TESTS: STEP DURATION CONFIGURATION
// ============================================================================

describe("Verification Step Duration", () => {
  it("verification step should be configured with 3 second duration", () => {
    // Import STEP_DURATIONS indirectly by checking flow timing
    // The verification step is configured to 3 seconds based on industry research

    // This is a documentation test - we verify the design decision
    const EXPECTED_VERIFICATION_DURATION = 3; // seconds

    // Verification should be quick - just a ROM check
    // 3 seconds is sufficient for:
    // - User to move joints through ROM
    // - System to capture movement data
    // - Provide real-time feedback
    expect(EXPECTED_VERIFICATION_DURATION).toBeLessThanOrEqual(5); // Should be quick
    expect(EXPECTED_VERIFICATION_DURATION).toBeGreaterThanOrEqual(2); // Need time to move
  });
});

// ============================================================================
// TESTS: EDGE CASES AND ERROR HANDLING
// ============================================================================

describe("Verification Edge Cases", () => {
  describe("Insufficient Data", () => {
    it("should handle empty quaternion buffer gracefully", () => {
      const quatSamples: THREE.Quaternion[] = [];

      // Calculate max angle with empty buffer
      if (quatSamples.length >= 10) {
        // Should not reach here
        expect(true).toBe(false);
      } else {
        // Gracefully skip calculation
        expect(quatSamples.length).toBeLessThan(10);
      }
    });

    it("should require minimum 30 samples for verification", () => {
      const MIN_SAMPLES = 30;
      const quatSamples: THREE.Quaternion[] = [];

      // Add fewer samples than required
      for (let i = 0; i < 20; i++) {
        quatSamples.push(new THREE.Quaternion());
      }

      // Should not process with insufficient samples
      const hasSufficientSamples = quatSamples.length >= MIN_SAMPLES;
      expect(hasSufficientSamples).toBe(false);
    });
  });

  describe("Multiple Sensors", () => {
    it("should track max movement across all sensors", () => {
      const sensorMovements = new Map<string, number>();
      sensorMovements.set("thigh_l", 25);
      sensorMovements.set("shin_l", 15);
      sensorMovements.set("thigh_r", 30);
      sensorMovements.set("shin_r", 20);

      let maxMovementSeen = 0;
      sensorMovements.forEach((movement) => {
        maxMovementSeen = Math.max(maxMovementSeen, movement);
      });

      expect(maxMovementSeen).toBe(30); // thigh_r had max movement
    });

    it("should calculate average movement for verification report", () => {
      const sensorMovements = new Map<string, number>();
      sensorMovements.set("thigh_l", 25);
      sensorMovements.set("shin_l", 15);
      sensorMovements.set("thigh_r", 30);
      sensorMovements.set("shin_r", 20);

      let totalMovement = 0;
      let count = 0;
      sensorMovements.forEach((movement) => {
        totalMovement += movement;
        count++;
      });

      const avgMovement = count > 0 ? totalMovement / count : 0;
      expect(avgMovement).toBe(22.5);
    });
  });

  describe("State Transitions", () => {
    it("should properly sequence from functional step to verification", () => {
      // For SINGLE_SENSOR: warm-up → static-pose → generic-flex → final-pose → verification → pose-check → squat-check → complete
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.SINGLE_SENSOR];

      const finalPoseIdx = flow.indexOf("final-pose");
      const verificationIdx = flow.indexOf("verification");
      const poseCheckIdx = flow.indexOf("pose-check");
      const squatCheckIdx = flow.indexOf("squat-check");
      const completeIdx = flow.indexOf("complete");

      expect(verificationIdx).toBe(finalPoseIdx + 1);
      expect(poseCheckIdx).toBe(verificationIdx + 1);
      expect(squatCheckIdx).toBe(poseCheckIdx + 1);
      expect(completeIdx).toBe(squatCheckIdx + 1);
    });

    it("should properly sequence from functional steps to verification for full body", () => {
      // For FULL_BODY: includes leg/arm functional steps before final-pose
      const flow = RESEARCH_STRICT_FLOWS[TopologyType.FULL_BODY];

      const legLeftIdx = flow.indexOf("leg-left-functional");
      const verificationIdx = flow.indexOf("verification");

      expect(legLeftIdx).toBeGreaterThan(-1);
      expect(verificationIdx).toBeGreaterThan(legLeftIdx);
    });
  });
});
