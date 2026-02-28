import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { VQF, DEFAULT_VQF_CONFIG } from "./VQF";

describe("VQF (Versatile Quaternion-based Filter)", () => {
  let vqf: VQF;

  beforeEach(() => {
    vqf = new VQF();
  });

  it("should initialize with identity quaternion", () => {
    const q = vqf.getQuaternion();
    expect(q.x).toBe(0);
    expect(q.y).toBe(0);
    expect(q.z).toBe(0);
    expect(q.w).toBe(1);
  });

  it("should initialize with zero bias", () => {
    const bias = vqf.getBias();
    expect(bias.x).toBe(0);
    expect(bias.y).toBe(0);
    expect(bias.z).toBe(0);
  });

  it("should integrate gyro rotation", () => {
    // Rotate around X axis at PI/2 rad/s for 1 second -> should be 90 degrees
    const gyro: [number, number, number] = [Math.PI / 2, 0, 0];
    const accel: [number, number, number] = [0, 0, 0]; // Disable accel correction (freefall/ignore) to test integration pure

    // Small steps
    const dt = 0.01;
    const steps = 100; // 1.0s total

    for (let i = 0; i < steps; i++) {
      vqf.update(dt, gyro, accel);
    }

    const q = vqf.getQuaternion();
    const euler = new THREE.Euler().setFromQuaternion(q);

    // Expected roughly 90 deg (1.57 rad) on X
    expect(Math.abs(euler.x - Math.PI / 2)).toBeLessThan(0.1);
  });

  it("should maintain orientation from gravity reference", () => {
    // Start at identity, provide gravity pointing in Y direction (flat sensor)
    const gyro: [number, number, number] = [0, 0, 0];
    const accel: [number, number, number] = [0, 9.81, 0]; // Y-up

    // Update several times
    for (let i = 0; i < 10; i++) {
      vqf.update(0.01, gyro, accel);
    }

    // Quaternion should remain close to identity (flat)
    const q = vqf.getQuaternion();
    expect(Math.abs(q.w - 1)).toBeLessThan(0.05);
    expect(Math.abs(q.x)).toBeLessThan(0.05);
    expect(Math.abs(q.y)).toBeLessThan(0.05);
    expect(Math.abs(q.z)).toBeLessThan(0.05);
  });

  it("should converge to tilted orientation from gravity", () => {
    // Sensor tilted 45 degrees forward - gravity vector shifted
    const gyro: [number, number, number] = [0, 0, 0];
    const cos45 = Math.cos(Math.PI / 4);
    const sin45 = Math.sin(Math.PI / 4);
    // Gravity in sensor frame when tilted 45° forward (pitch down)
    const accel: [number, number, number] = [0, 9.81 * cos45, 9.81 * sin45];

    // Initialize from accel first
    vqf.initFromAccel(accel);

    const q = vqf.getQuaternion();
    const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");

    // Should show approximately -45 degrees pitch
    expect((euler.x * 180) / Math.PI).toBeCloseTo(-45, 0);
  });

  it("should provide diagnostics", () => {
    // Just verify the diagnostics structure exists
    const diag = vqf.getDiagnostics();

    expect(diag).toHaveProperty("lastErrorDeg");
    expect(diag).toHaveProperty("maxErrorDeg");
    expect(diag).toHaveProperty("updateCount");
    expect(diag).toHaveProperty("bias");
    expect(diag).toHaveProperty("restDetected");
  });
});
