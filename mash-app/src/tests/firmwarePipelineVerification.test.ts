/**
 * FIRMWARE PIPELINE VERIFICATION TEST
 *
 * This test simulates the EXACT transforms applied by firmware and verifies
 * the complete pipeline produces correct orientations for known physical scenarios.
 *
 * Transform Chain:
 * 1. ICM20649 raw sensor (Z-up frame)
 * 2. ICM20649_Research.cpp: Z-up → Y-up transform
 * 3. SensorManager.cpp: Hardware mounting correction [-X, +Y, +Z]
 * 4. SyncManager.cpp: int16 encoding (×100 accel, ×900 gyro)
 * 5. IMUParser.ts: Decoding
 * 6. VQF.ts: Sensor fusion → Quaternion
 * 7. OrientationProcessor: Tare/Calibration → World Quaternion
 * 8. applyToBone: Set bone.quaternion for visualization
 *
 * IMPORTANT: This tests both LIVE and PLAYBACK paths.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { VQF } from "../lib/fusion/VQF";
import { OrientationProcessor } from "../components/visualization/skeleton/OrientationProcessor";
import type { TareState } from "../calibration/taringPipeline";

// ============================================================================
// FIRMWARE TRANSFORM SIMULATION
// These must EXACTLY match the C++ code
// ============================================================================

/**
 * Simulates ICM20649_Research.cpp coordinate transform
 * Z-up → Y-up with chirality preservation
 */
function icm20649Transform(sensor: {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
}) {
  // From ICM20649_Research.cpp:
  // frame->ax_g = ax_sensor;      // X stays X
  // frame->ay_g = az_sensor;      // Sensor Z → THREE Y (up)
  // frame->az_g = -ay_sensor;     // Sensor Y → THREE -Z (chirality)
  //
  // frame->gx_rad = gx_sensor;    // X stays X
  // frame->gy_rad = gz_sensor;    // Sensor Z → THREE Y
  // frame->gz_rad = -gy_sensor;   // Sensor Y → THREE -Z (chirality)

  return {
    ax_g: sensor.ax,
    ay_g: sensor.az,
    az_g: -sensor.ay,
    gx_rad: sensor.gx,
    gy_rad: sensor.gz,
    gz_rad: -sensor.gy,
  };
}

/**
 * Simulates SensorManager.cpp coordinate transform
 * Hardware mounting correction: [-X, +Y, +Z]
 * Note: This is NOT a true 180° rotation, but matches VQF pitch convention
 */
function sensorManagerTransform(
  icmOutput: ReturnType<typeof icm20649Transform>,
) {
  // From SensorManager.cpp (UPDATED):
  // float ax_yup = -ax_raw_g * 9.81f;  // X inverted
  // float ay_yup = +ay_raw_g * 9.81f;  // Y preserved
  // float az_yup = +az_raw_g * 9.81f;  // Z PRESERVED (was inverted)
  //
  // float gx_yup = -gx_raw;  // X inverted
  // float gy_yup = +gy_raw;  // Y preserved
  // float gz_yup = +gz_raw;  // Z PRESERVED (was inverted)

  return {
    accelX: -icmOutput.ax_g * 9.81,
    accelY: +icmOutput.ay_g * 9.81,
    accelZ: +icmOutput.az_g * 9.81, // Z preserved now
    gyroX: -icmOutput.gx_rad,
    gyroY: +icmOutput.gy_rad,
    gyroZ: +icmOutput.gz_rad, // Z preserved now
  };
}

/**
 * Simulates SyncManager.cpp int16 encoding
 */
function syncManagerEncode(
  sensorData: ReturnType<typeof sensorManagerTransform>,
) {
  return {
    ax_int16: Math.round(sensorData.accelX * 100),
    ay_int16: Math.round(sensorData.accelY * 100),
    az_int16: Math.round(sensorData.accelZ * 100),
    gx_int16: Math.round(sensorData.gyroX * 900),
    gy_int16: Math.round(sensorData.gyroY * 900),
    gz_int16: Math.round(sensorData.gyroZ * 900),
  };
}

/**
 * Simulates IMUParser.ts decoding
 */
function imuParserDecode(encoded: ReturnType<typeof syncManagerEncode>) {
  return {
    accelerometer: [
      encoded.ax_int16 / 100,
      encoded.ay_int16 / 100,
      encoded.az_int16 / 100,
    ] as [number, number, number],
    gyro: [
      encoded.gx_int16 / 900,
      encoded.gy_int16 / 900,
      encoded.gz_int16 / 900,
    ] as [number, number, number],
  };
}

/**
 * Complete firmware pipeline simulation
 */
function simulateFirmwarePipeline(sensorRaw: {
  ax: number;
  ay: number;
  az: number; // in G
  gx: number;
  gy: number;
  gz: number; // in rad/s
}) {
  const step1 = icm20649Transform(sensorRaw);
  const step2 = sensorManagerTransform(step1);
  const step3 = syncManagerEncode(step2);
  const step4 = imuParserDecode(step3);
  return {
    icm20649Output: step1,
    sensorManagerOutput: step2,
    encoded: step3,
    decoded: step4,
  };
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

describe("Firmware Pipeline Verification", () => {
  describe("Transform Chain Verification", () => {
    it("Flat on table: gravity should be +Y in final output", () => {
      // ICM20649 raw: Flat on table means gravity on +Z (sensor Z-up convention)
      const sensorRaw = {
        ax: 0,
        ay: 0,
        az: 1.0, // 1G on +Z
        gx: 0,
        gy: 0,
        gz: 0,
      };

      const result = simulateFirmwarePipeline(sensorRaw);

      // After full pipeline, gravity should be on +Y
      expect(result.decoded.accelerometer[0]).toBeCloseTo(0, 1); // X ≈ 0
      expect(result.decoded.accelerometer[1]).toBeCloseTo(9.81, 1); // Y ≈ +9.81
      expect(result.decoded.accelerometer[2]).toBeCloseTo(0, 1); // Z ≈ 0

      console.log("Flat test - Final accel:", result.decoded.accelerometer);
    });

    it("Pitched nose-down 90°: gravity should shift from +Y to +Z", () => {
      // Sensor pitched so gravity is now on sensor -Y (nose down in Z-up frame)
      // With [-X, +Y, +Z] transform, pitch-down gives +Z (correct for VQF)
      const sensorRaw = {
        ax: 0,
        ay: -1.0,
        az: 0, // Gravity on -Y (pitched forward)
        gx: 0,
        gy: 0,
        gz: 0,
      };

      const result = simulateFirmwarePipeline(sensorRaw);

      console.log(
        "Pitch down 90° - Final accel:",
        result.decoded.accelerometer,
      );

      expect(result.decoded.accelerometer[0]).toBeCloseTo(0, 1); // X ≈ 0
      expect(result.decoded.accelerometer[1]).toBeCloseTo(0, 1); // Y ≈ 0
      expect(result.decoded.accelerometer[2]).toBeCloseTo(9.81, 1); // Z ≈ +9.81
    });

    it("Pitched nose-up 90°: gravity should shift from +Y to -Z", () => {
      // Sensor pitched back so gravity is on sensor +Y
      const sensorRaw = {
        ax: 0,
        ay: 1.0,
        az: 0, // Gravity on +Y (pitched back)
        gx: 0,
        gy: 0,
        gz: 0,
      };

      const result = simulateFirmwarePipeline(sensorRaw);

      console.log("Pitch up 90° - Final accel:", result.decoded.accelerometer);

      expect(result.decoded.accelerometer[0]).toBeCloseTo(0, 1); // X ≈ 0
      expect(result.decoded.accelerometer[1]).toBeCloseTo(0, 1); // Y ≈ 0
      expect(result.decoded.accelerometer[2]).toBeCloseTo(-9.81, 1); // Z ≈ -9.81
    });

    it("Rolled right 90°: gravity should shift from +Y to -X", () => {
      // Sensor rolled right so gravity is on sensor -X
      const sensorRaw = {
        ax: -1.0,
        ay: 0,
        az: 0, // Gravity on -X (rolled right)
        gx: 0,
        gy: 0,
        gz: 0,
      };

      const result = simulateFirmwarePipeline(sensorRaw);

      console.log(
        "Roll right 90° - Final accel:",
        result.decoded.accelerometer,
      );

      // 180° Y-rotation inverts X, so -X becomes +X
      expect(result.decoded.accelerometer[0]).toBeCloseTo(9.81, 1); // X ≈ +9.81
      expect(result.decoded.accelerometer[1]).toBeCloseTo(0, 1); // Y ≈ 0
      expect(result.decoded.accelerometer[2]).toBeCloseTo(0, 1); // Z ≈ 0
    });
  });

  describe("Gyro-Accel Frame Consistency (Critical)", () => {
    it("Pitch rotation: gyro X should cause accel to shift Y→Z", () => {
      // When gyro indicates pitch-down rotation (positive gx in sensor frame),
      // the resulting orientation change should move gravity from Y toward Z

      const vqf = new VQF({ tauAcc: 0.5 }); // Fast correction for testing

      // Start flat
      vqf.initFromAccel([0, 9.81, 0]);

      // Get initial orientation
      const q0 = vqf.getQuaternion().clone();
      const euler0 = new THREE.Euler().setFromQuaternion(q0, "XYZ");

      // Apply pitch-down rotation via gyro
      // In Y-up right-handed: pitch down = negative X rotation
      const pitchRate = -0.5; // rad/s, negative = pitch down
      const dt = 0.1; // 100ms

      for (let i = 0; i < 10; i++) {
        // Gyro says we're rotating, accel still shows gravity on Y (lag)
        vqf.update(dt, [pitchRate, 0, 0], [0, 9.81, 0]);
      }

      const q1 = vqf.getQuaternion();
      const euler1 = new THREE.Euler().setFromQuaternion(q1, "XYZ");

      // Should have accumulated ~0.5 rad (28.6°) of pitch
      const pitchChange = euler1.x - euler0.x;

      console.log("Pitch test:");
      console.log(
        "  Initial euler X:",
        ((euler0.x * 180) / Math.PI).toFixed(1),
        "°",
      );
      console.log(
        "  Final euler X:",
        ((euler1.x * 180) / Math.PI).toFixed(1),
        "°",
      );
      console.log(
        "  Pitch change:",
        ((pitchChange * 180) / Math.PI).toFixed(1),
        "°",
      );

      // Pitch should have decreased (negative rotation around X)
      expect(pitchChange).toBeLessThan(-0.3); // At least 17° change
    });

    it("Accel correction should work WITH gyro, not against it", () => {
      const vqf = new VQF({ tauAcc: 1.0 });

      // Initialize with sensor tilted 30° forward (pitched down)
      // Physics: When pitched down, gravity shifts toward BACK of sensor (+Z in final frame)
      // After 180° Y-rotation: back becomes -Z in sensor frame before rotation
      // But wait - let's think in terms of what VQF sees AFTER all transforms:
      // Pitched DOWN means gravity has +Z component (toward back)
      const tilt30 = Math.PI / 6; // 30°
      const gravityY = 9.81 * Math.cos(tilt30); // ~8.5
      const gravityZ = 9.81 * Math.sin(tilt30); // ~+4.9 (positive Z for pitch down)

      vqf.initFromAccel([0, gravityY, gravityZ]);

      const q0 = vqf.getQuaternion().clone();
      const euler0 = new THREE.Euler().setFromQuaternion(q0, "XYZ");

      console.log("Initial state (30° pitched down):");
      console.log("  Accel input:", [
        0,
        gravityY.toFixed(2),
        gravityZ.toFixed(2),
      ]);
      console.log("  Euler X:", ((euler0.x * 180) / Math.PI).toFixed(1), "°");

      // Now feed CONSISTENT data: gyro says we're stationary, accel confirms tilt
      const dt = 0.01;
      for (let i = 0; i < 100; i++) {
        vqf.update(dt, [0, 0, 0], [0, gravityY, gravityZ]);
      }

      const q1 = vqf.getQuaternion();
      const euler1 = new THREE.Euler().setFromQuaternion(q1, "XYZ");

      console.log("After 1s stationary:");
      console.log("  Euler X:", ((euler1.x * 180) / Math.PI).toFixed(1), "°");

      // Orientation should STAY at ~-30° pitch (negative = pitched forward/down)
      const pitchDeg = (euler1.x * 180) / Math.PI;
      expect(Math.abs(pitchDeg - -30)).toBeLessThan(10); // Within 10° of expected
    });

    it("CRITICAL: Verify accel and gyro agree on coordinate frame", () => {
      // This is THE key test.
      // If we pitch the sensor down physically:
      // - Accel should show gravity shifting from +Y toward +Z
      // - Gyro should show rotation that ALSO moves +Y toward +Z

      // Simulate physical pitch-down motion
      const vqf = new VQF({ tauAcc: 0.5 });
      vqf.initFromAccel([0, 9.81, 0]); // Start flat

      const dt = 0.02; // 50Hz
      const pitchRateRadS = -0.5; // Pitching down at ~29°/s

      const frames: { pitch: number; accelY: number; accelZ: number }[] = [];

      for (let t = 0; t < 1.0; t += dt) {
        // Calculate current pitch angle (accumulating rotation)
        const currentPitch = pitchRateRadS * t;

        // Physical gravity vector for this pitch angle
        // Pitch down = rotation around -X, gravity moves from +Y toward +Z
        const gravityY = 9.81 * Math.cos(-currentPitch);
        const gravityZ = 9.81 * Math.sin(-currentPitch);

        // Feed PHYSICALLY CONSISTENT gyro and accel
        vqf.update(dt, [pitchRateRadS, 0, 0], [0, gravityY, gravityZ]);

        const q = vqf.getQuaternion();
        const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");

        if (Math.floor(t * 10) !== Math.floor((t - dt) * 10)) {
          frames.push({
            pitch: (euler.x * 180) / Math.PI,
            accelY: gravityY,
            accelZ: gravityZ,
          });
        }
      }

      console.log("Physical pitch-down simulation:");
      frames.forEach((f, i) => {
        console.log(
          `  ${i * 100}ms: pitch=${f.pitch.toFixed(1)}° accel=[0, ${f.accelY.toFixed(1)}, ${f.accelZ.toFixed(1)}]`,
        );
      });

      // Final pitch should be close to the accumulated rotation (~28.6°)
      const finalQ = vqf.getQuaternion();
      const finalEuler = new THREE.Euler().setFromQuaternion(finalQ, "XYZ");
      const finalPitchDeg = (finalEuler.x * 180) / Math.PI;

      console.log(
        "Final pitch:",
        finalPitchDeg.toFixed(1),
        "° (expected ~-28.6°)",
      );

      // Should be within 5° of expected (gyro and accel agreeing)
      expect(Math.abs(finalPitchDeg - -28.6)).toBeLessThan(5);
    });
  });

  describe("Full Pipeline with VQF Integration", () => {
    it("Simulated sensor flat → VQF should produce identity quaternion", () => {
      // Raw ICM20649 data for flat sensor
      const sensorRaw = { ax: 0, ay: 0, az: 1.0, gx: 0, gy: 0, gz: 0 };
      const pipeline = simulateFirmwarePipeline(sensorRaw);

      const vqf = new VQF();
      vqf.initFromAccel(pipeline.decoded.accelerometer);

      // Run a few updates with stationary data
      for (let i = 0; i < 10; i++) {
        vqf.update(0.02, pipeline.decoded.gyro, pipeline.decoded.accelerometer);
      }

      const q = vqf.getQuaternion();
      const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");

      console.log("Flat sensor VQF result:");
      console.log(
        "  Quaternion:",
        [q.w, q.x, q.y, q.z].map((v) => v.toFixed(3)),
      );
      console.log(
        "  Euler (deg):",
        [euler.x, euler.y, euler.z].map((v) =>
          ((v * 180) / Math.PI).toFixed(1),
        ),
      );

      // Should be near identity (all euler angles ~0)
      expect(Math.abs(euler.x)).toBeLessThan(0.1); // < 6°
      expect(Math.abs(euler.y)).toBeLessThan(0.1);
      expect(Math.abs(euler.z)).toBeLessThan(0.1);
    });

    it("Simulated sensor pitched 45° down → VQF should show -45° pitch (CORRECTED)", () => {
      // With the CORRECTED transform [-X, +Y, +Z], pitch-down produces POSITIVE Z.
      // VQF interprets positive Z as pitch-DOWN (negative Euler X).
      // This is now CORRECT!

      // Raw ICM20649 when sensor pitched down 45°:
      // Gravity measured = [0, -sin(45°), +cos(45°)] = [0, -0.707, +0.707]
      const angle = Math.PI / 4; // 45°
      const sensorRaw = {
        ax: 0,
        ay: -Math.sin(angle), // -0.707
        az: Math.cos(angle), // +0.707
        gx: 0,
        gy: 0,
        gz: 0,
      };

      const pipeline = simulateFirmwarePipeline(sensorRaw);

      console.log(
        "45° pitch DOWN raw → decoded accel:",
        pipeline.decoded.accelerometer,
      );
      console.log("With [-X, +Y, +Z]: Z should be POSITIVE for pitch-down");

      const vqf = new VQF();
      vqf.initFromAccel(pipeline.decoded.accelerometer);

      const q = vqf.getQuaternion();
      const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");

      console.log("VQF result:");
      console.log(
        "  Euler (deg):",
        [euler.x, euler.y, euler.z].map((v) =>
          ((v * 180) / Math.PI).toFixed(1),
        ),
      );

      // CORRECTED: pitch-DOWN should produce NEGATIVE Euler X
      const pitchDeg = (euler.x * 180) / Math.PI;
      expect(Math.abs(pitchDeg - -45)).toBeLessThan(10);
    });
  });
});

describe("Debug: Print Full Transform Chain", () => {
  it("Trace all transforms for flat sensor", () => {
    const sensorRaw = { ax: 0, ay: 0, az: 1.0, gx: 0, gy: 0, gz: 0 };

    console.log("\n=== FLAT SENSOR TRANSFORM CHAIN ===");
    console.log("1. ICM20649 Raw (Z-up):");
    console.log("   Accel:", [sensorRaw.ax, sensorRaw.ay, sensorRaw.az]);
    console.log("   Gyro:", [sensorRaw.gx, sensorRaw.gy, sensorRaw.gz]);

    const step1 = icm20649Transform(sensorRaw);
    console.log("\n2. After ICM20649_Research (Z→Y swap):");
    console.log("   Accel (g):", [step1.ax_g, step1.ay_g, step1.az_g]);
    console.log("   Gyro (rad/s):", [step1.gx_rad, step1.gy_rad, step1.gz_rad]);

    const step2 = sensorManagerTransform(step1);
    console.log("\n3. After SensorManager (180° Y-rotation):");
    console.log("   Accel (m/s²):", [step2.accelX, step2.accelY, step2.accelZ]);
    console.log("   Gyro (rad/s):", [step2.gyroX, step2.gyroY, step2.gyroZ]);

    const step3 = syncManagerEncode(step2);
    console.log("\n4. After SyncManager (int16 encoding):");
    console.log("   Accel (×100):", [
      step3.ax_int16,
      step3.ay_int16,
      step3.az_int16,
    ]);
    console.log("   Gyro (×900):", [
      step3.gx_int16,
      step3.gy_int16,
      step3.gz_int16,
    ]);

    const step4 = imuParserDecode(step3);
    console.log("\n5. After IMUParser (decoded):");
    console.log("   Accel (m/s²):", step4.accelerometer);
    console.log("   Gyro (rad/s):", step4.gyro);

    expect(step4.accelerometer[1]).toBeCloseTo(9.81, 1);
  });

  it("Trace all transforms for pitched sensor", () => {
    // Pitched 45° nose-down: gravity on sensor -Y and +Z
    const angle = Math.PI / 4;
    const sensorRaw = {
      ax: 0,
      ay: -Math.sin(angle), // ~-0.707
      az: Math.cos(angle), // ~0.707
      gx: 0,
      gy: 0,
      gz: 0,
    };

    console.log("\n=== 45° PITCHED SENSOR TRANSFORM CHAIN ===");
    console.log("1. ICM20649 Raw (Z-up, pitched 45° forward):");
    console.log("   Accel:", [
      sensorRaw.ax.toFixed(3),
      sensorRaw.ay.toFixed(3),
      sensorRaw.az.toFixed(3),
    ]);

    const step1 = icm20649Transform(sensorRaw);
    console.log("\n2. After ICM20649_Research:");
    console.log("   Accel (g):", [
      step1.ax_g.toFixed(3),
      step1.ay_g.toFixed(3),
      step1.az_g.toFixed(3),
    ]);

    const step2 = sensorManagerTransform(step1);
    console.log("\n3. After SensorManager:");
    console.log("   Accel (m/s²):", [
      step2.accelX.toFixed(2),
      step2.accelY.toFixed(2),
      step2.accelZ.toFixed(2),
    ]);

    const step4 = imuParserDecode(syncManagerEncode(step2));
    console.log("\n5. Final decoded:");
    console.log(
      "   Accel (m/s²):",
      step4.accelerometer.map((v) => v.toFixed(2)),
    );

    // Verify: 45° pitch should have gravity split between Y and Z
    const mag = Math.sqrt(
      step4.accelerometer[0] ** 2 +
        step4.accelerometer[1] ** 2 +
        step4.accelerometer[2] ** 2,
    );
    console.log("   Magnitude:", mag.toFixed(2), "(should be ~9.81)");

    expect(mag).toBeCloseTo(9.81, 0);
  });
});

// ============================================================================
// VISUALIZATION PIPELINE TESTS
// Tests the full pipeline from VQF quaternion through to bone visualization
// ============================================================================

describe("Visualization Pipeline (OrientationProcessor + Bone)", () => {
  /**
   * Helper to create a simple skeleton bone hierarchy for testing
   */
  function createTestSkeleton() {
    // Create a simple pelvis -> thigh hierarchy
    const pelvis = new THREE.Bone();
    pelvis.name = "pelvis";

    const thigh_r = new THREE.Bone();
    thigh_r.name = "thigh_r";
    pelvis.add(thigh_r);

    // Position thigh below pelvis (like real skeleton)
    thigh_r.position.set(0.1, -0.1, 0);

    // Update matrices
    pelvis.updateMatrixWorld(true);

    return { pelvis, thigh_r };
  }

  /**
   * Helper to create a TareState for testing
   */
  function createTareState(
    mountingQuat?: THREE.Quaternion,
    headingQuat?: THREE.Quaternion,
  ): TareState {
    return {
      mountingTare: mountingQuat || new THREE.Quaternion(),
      headingTare: headingQuat || new THREE.Quaternion(),
      jointTare: { flexion: 0, abduction: 0, rotation: 0 },
      mountingTareTime: Date.now(),
      headingTareTime: Date.now(),
      jointTareTime: Date.now(),
    };
  }

  describe("Live Visualization Path", () => {
    it("Flat sensor → VQF → OrientationProcessor → Bone should show upright", () => {
      // Step 1: Simulate flat sensor through firmware pipeline
      const sensorRaw = { ax: 0, ay: 0, az: 1.0, gx: 0, gy: 0, gz: 0 };
      const pipeline = simulateFirmwarePipeline(sensorRaw);

      // Step 2: VQF produces quaternion
      const vqf = new VQF();
      vqf.initFromAccel(pipeline.decoded.accelerometer);
      const q = vqf.getQuaternion();

      // Step 3: OrientationProcessor processes for visualization
      const processor = new OrientationProcessor();
      const quatArray: [number, number, number, number] = [q.w, q.x, q.y, q.z];

      // With no calibration, output should be ~identity
      const result = processor.processQuaternion(quatArray, "pelvis", null);

      expect(result).not.toBeNull();
      if (result) {
        const euler = new THREE.Euler().setFromQuaternion(
          result.worldQuat,
          "XYZ",
        );
        const pitchDeg = (euler.x * 180) / Math.PI;
        const yawDeg = (euler.y * 180) / Math.PI;
        const rollDeg = (euler.z * 180) / Math.PI;

        console.log("Live flat sensor → bone euler:", {
          pitchDeg,
          yawDeg,
          rollDeg,
        });

        // Should be near identity (upright)
        expect(Math.abs(pitchDeg)).toBeLessThan(5);
        expect(Math.abs(rollDeg)).toBeLessThan(5);
      }
    });

    it("Pitched sensor → VQF → OrientationProcessor → Bone should show tilted forward", () => {
      // Step 1: Simulate 45° pitched sensor
      const angle = Math.PI / 4;
      const sensorRaw = {
        ax: 0,
        ay: -Math.sin(angle),
        az: Math.cos(angle),
        gx: 0,
        gy: 0,
        gz: 0,
      };
      const pipeline = simulateFirmwarePipeline(sensorRaw);

      // Step 2: VQF produces quaternion
      const vqf = new VQF();
      vqf.initFromAccel(pipeline.decoded.accelerometer);
      const q = vqf.getQuaternion();

      // Step 3: OrientationProcessor processes for visualization
      const processor = new OrientationProcessor();
      const quatArray: [number, number, number, number] = [q.w, q.x, q.y, q.z];

      const result = processor.processQuaternion(quatArray, "pelvis", null);

      expect(result).not.toBeNull();
      if (result) {
        const euler = new THREE.Euler().setFromQuaternion(
          result.worldQuat,
          "XYZ",
        );
        const pitchDeg = (euler.x * 180) / Math.PI;

        console.log(
          "Live pitched sensor → bone pitch:",
          pitchDeg.toFixed(1),
          "° (expected ~-45°)",
        );

        // Should show ~-45° pitch (tilted forward)
        expect(Math.abs(pitchDeg - -45)).toBeLessThan(10);
      }
    });

    it("Calibrated sensor: mounting tare should zero out initial orientation", () => {
      // Step 1: Simulate sensor mounted at 30° offset
      const mountingAngle = Math.PI / 6; // 30°
      const sensorRaw = {
        ax: 0,
        ay: -Math.sin(mountingAngle),
        az: Math.cos(mountingAngle),
        gx: 0,
        gy: 0,
        gz: 0,
      };
      const pipeline = simulateFirmwarePipeline(sensorRaw);

      // Step 2: VQF produces quaternion (shows 30° tilt)
      const vqf = new VQF();
      vqf.initFromAccel(pipeline.decoded.accelerometer);
      const sensorQuat = vqf.getQuaternion();

      // Step 3: Compute mounting tare using CORRECT formula:
      // q_mount = inv(q_sensor) × q_target
      // For target = identity (upright), q_mount = inv(q_sensor)
      // Then q_bone = q_sensor × q_mount = q_sensor × inv(q_sensor) = identity
      const targetBoneQuat = new THREE.Quaternion(); // identity = upright
      const mountingTare = sensorQuat.clone().invert().multiply(targetBoneQuat);

      const tareState = createTareState(mountingTare);
      tareState.mountingTareTime = Date.now(); // Mark as captured

      // Step 4: Process with calibration
      const processor = new OrientationProcessor();
      const quatArray: [number, number, number, number] = [
        sensorQuat.w,
        sensorQuat.x,
        sensorQuat.y,
        sensorQuat.z,
      ];

      const result = processor.processQuaternion(
        quatArray,
        "pelvis",
        tareState,
      );

      expect(result).not.toBeNull();
      if (result) {
        const euler = new THREE.Euler().setFromQuaternion(
          result.worldQuat,
          "XYZ",
        );
        const pitchDeg = (euler.x * 180) / Math.PI;

        console.log(
          "Calibrated sensor → bone pitch:",
          pitchDeg.toFixed(1),
          "° (expected ~0°)",
        );

        // Should be near zero (mounting tare nullified the offset)
        expect(Math.abs(pitchDeg)).toBeLessThan(5);
      }
    });

    it("applyToBone: world quaternion should be applied to bone correctly", () => {
      const { pelvis } = createTestSkeleton();
      const processor = new OrientationProcessor();

      // Create a 45° pitch quaternion
      const pitchQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-Math.PI / 4, 0, 0, "XYZ"),
      );

      // Apply to bone
      processor.applyToBone(pelvis, pitchQuat);

      // Verify bone orientation
      const worldQuat = new THREE.Quaternion();
      pelvis.getWorldQuaternion(worldQuat);

      const euler = new THREE.Euler().setFromQuaternion(worldQuat, "XYZ");
      const pitchDeg = (euler.x * 180) / Math.PI;

      console.log(
        "applyToBone result:",
        pitchDeg.toFixed(1),
        "° (expected ~-45°)",
      );

      expect(Math.abs(pitchDeg - -45)).toBeLessThan(5);
    });
  });

  describe("Playback Visualization Path", () => {
    it("Recorded quaternion playback should produce same result as live", () => {
      // Simulate what gets recorded: the VQF quaternion output
      const angle = Math.PI / 4;
      const sensorRaw = {
        ax: 0,
        ay: -Math.sin(angle),
        az: Math.cos(angle),
        gx: 0,
        gy: 0,
        gz: 0,
      };
      const pipeline = simulateFirmwarePipeline(sensorRaw);

      const vqf = new VQF();
      vqf.initFromAccel(pipeline.decoded.accelerometer);
      const recordedQuat = vqf.getQuaternion();

      // Simulate playback: use the stored quaternion directly
      const processor = new OrientationProcessor();
      const quatArray: [number, number, number, number] = [
        recordedQuat.w,
        recordedQuat.x,
        recordedQuat.y,
        recordedQuat.z,
      ];

      // Playback path (same as live path for quaternion data)
      const liveResult = processor.processQuaternion(quatArray, "pelvis", null);

      // Create a "new" processor to simulate playback session
      const playbackProcessor = new OrientationProcessor();
      const playbackResult = playbackProcessor.processQuaternion(
        quatArray,
        "pelvis",
        null,
      );

      expect(liveResult).not.toBeNull();
      expect(playbackResult).not.toBeNull();

      if (liveResult && playbackResult) {
        // Results should be identical
        const liveEuler = new THREE.Euler().setFromQuaternion(
          liveResult.worldQuat,
          "XYZ",
        );
        const playbackEuler = new THREE.Euler().setFromQuaternion(
          playbackResult.worldQuat,
          "XYZ",
        );

        console.log(
          "Live pitch:",
          ((liveEuler.x * 180) / Math.PI).toFixed(1),
          "°",
        );
        console.log(
          "Playback pitch:",
          ((playbackEuler.x * 180) / Math.PI).toFixed(1),
          "°",
        );

        expect(Math.abs(liveEuler.x - playbackEuler.x)).toBeLessThan(0.01);
        expect(Math.abs(liveEuler.y - playbackEuler.y)).toBeLessThan(0.01);
        expect(Math.abs(liveEuler.z - playbackEuler.z)).toBeLessThan(0.01);
      }
    });

    it("Playback with stored calibration should apply correctly", () => {
      // Scenario: User calibrated at 30° tilt, then moved to 45° tilt.
      // Expected result: Output shows 15° relative motion (45° - 30°)

      // Step 1: Simulate calibration capture at 30° tilt
      const calibrationQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-Math.PI / 6, 0, 0, "XYZ"), // 30° pitch at calibration
      );

      // Step 2: Compute mounting tare using CORRECT formula:
      // q_mount = inv(q_sensor_at_cal) × q_target (identity for upright)
      const targetBoneQuat = new THREE.Quaternion(); // identity
      const mountingTare = calibrationQuat
        .clone()
        .invert()
        .multiply(targetBoneQuat);

      const storedTareState = createTareState(mountingTare);
      storedTareState.mountingTareTime = Date.now();

      // Step 3: Record sensor quaternion at 45° tilt (15° more than calibration)
      const recordedQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-Math.PI / 4, 0, 0, "XYZ"), // 45° total pitch
      );

      // Playback with stored calibration
      const processor = new OrientationProcessor();
      const quatArray: [number, number, number, number] = [
        recordedQuat.w,
        recordedQuat.x,
        recordedQuat.y,
        recordedQuat.z,
      ];

      const result = processor.processQuaternion(
        quatArray,
        "pelvis",
        storedTareState,
      );

      expect(result).not.toBeNull();
      if (result) {
        const euler = new THREE.Euler().setFromQuaternion(
          result.worldQuat,
          "XYZ",
        );
        const pitchDeg = (euler.x * 180) / Math.PI;

        console.log(
          "Playback with calibration:",
          pitchDeg.toFixed(1),
          "° (expected ~-15°)",
        );

        // Should show ~-15° (45° sensor - 30° calibrated offset = 15° relative motion)
        expect(Math.abs(pitchDeg - -15)).toBeLessThan(5);
      }
    });
  });

  describe("Full Pipeline Integration (Sensor → Screen)", () => {
    it("FULL PIPELINE: Raw sensor → firmware → VQF → processor → bone", () => {
      console.log("\n=== FULL PIPELINE TEST ===");

      // STAGE 1: Physical sensor (Z-up) - pitched 45° forward
      const angle = Math.PI / 4;
      const sensorRaw = {
        ax: 0,
        ay: -Math.sin(angle), // -0.707
        az: Math.cos(angle), // +0.707
        gx: 0,
        gy: 0,
        gz: 0,
      };
      console.log("1. Sensor raw (Z-up):", sensorRaw);

      // STAGE 2: Firmware transforms
      const pipeline = simulateFirmwarePipeline(sensorRaw);
      console.log("2. After firmware:", pipeline.decoded.accelerometer);

      // STAGE 3: VQF sensor fusion
      const vqf = new VQF();
      vqf.initFromAccel(pipeline.decoded.accelerometer);
      const vqfQuat = vqf.getQuaternion();
      console.log(
        "3. VQF quaternion:",
        [vqfQuat.w, vqfQuat.x, vqfQuat.y, vqfQuat.z].map((v) => v.toFixed(3)),
      );

      // STAGE 4: OrientationProcessor
      const processor = new OrientationProcessor();
      const quatArray: [number, number, number, number] = [
        vqfQuat.w,
        vqfQuat.x,
        vqfQuat.y,
        vqfQuat.z,
      ];
      const result = processor.processQuaternion(quatArray, "pelvis", null);

      expect(result).not.toBeNull();
      if (result) {
        console.log(
          "4. Processor output:",
          [
            result.worldQuat.w,
            result.worldQuat.x,
            result.worldQuat.y,
            result.worldQuat.z,
          ].map((v) => v.toFixed(3)),
        );

        // STAGE 5: Apply to bone
        const { pelvis } = createTestSkeleton();
        processor.applyToBone(pelvis, result.worldQuat);

        // Verify final bone orientation
        const worldQuat = new THREE.Quaternion();
        pelvis.getWorldQuaternion(worldQuat);
        const euler = new THREE.Euler().setFromQuaternion(worldQuat, "XYZ");
        const pitchDeg = (euler.x * 180) / Math.PI;

        console.log("5. Bone world euler:", {
          pitch: pitchDeg.toFixed(1) + "°",
          yaw: ((euler.y * 180) / Math.PI).toFixed(1) + "°",
          roll: ((euler.z * 180) / Math.PI).toFixed(1) + "°",
        });
        console.log("   Expected: ~-45° pitch (model tilted forward)");

        // FINAL ASSERTION: Physical 45° pitch forward → Model shows -45° pitch
        expect(Math.abs(pitchDeg - -45)).toBeLessThan(10);
      }
    });

    it("FULL PIPELINE: Verify pitch direction matches physical expectation", () => {
      // Physical test: When I pitch the sensor FORWARD (nose down),
      // the 3D model should ALSO pitch forward (head goes down).

      const testCases = [
        { name: "Flat", ay: 0, az: 1.0, expectedPitch: 0 },
        {
          name: "45° Forward",
          ay: -Math.sin(Math.PI / 4),
          az: Math.cos(Math.PI / 4),
          expectedPitch: -45,
        },
        {
          name: "45° Backward",
          ay: Math.sin(Math.PI / 4),
          az: Math.cos(Math.PI / 4),
          expectedPitch: 45,
        },
      ];

      const processor = new OrientationProcessor();

      for (const test of testCases) {
        const sensorRaw = {
          ax: 0,
          ay: test.ay,
          az: test.az,
          gx: 0,
          gy: 0,
          gz: 0,
        };
        const pipeline = simulateFirmwarePipeline(sensorRaw);

        const vqf = new VQF();
        vqf.initFromAccel(pipeline.decoded.accelerometer);
        const q = vqf.getQuaternion();

        const result = processor.processQuaternion(
          [q.w, q.x, q.y, q.z],
          "pelvis",
          null,
        );

        expect(result).not.toBeNull();
        if (result) {
          const euler = new THREE.Euler().setFromQuaternion(
            result.worldQuat,
            "XYZ",
          );
          const pitchDeg = (euler.x * 180) / Math.PI;

          console.log(
            `${test.name}: pitch = ${pitchDeg.toFixed(1)}° (expected ${test.expectedPitch}°)`,
          );

          expect(Math.abs(pitchDeg - test.expectedPitch)).toBeLessThan(10);
        }
      }
    });
  });
});
