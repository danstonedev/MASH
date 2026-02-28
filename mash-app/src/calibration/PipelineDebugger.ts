/**
 * Pipeline Debugger
 * =================
 *
 * Diagnostic tool for debugging the IMU → Visualization pipeline.
 * Logs key transformation stages and validates coordinate frame assumptions.
 */

import * as THREE from "three";
import { firmwareToThreeQuat } from "../lib/math/conventions";
import { getTposeTarget } from "./tposeTargets";

// ============================================================================
// TYPES
// ============================================================================

export interface PipelineDebugData {
  timestamp: number;
  segmentId: string;

  // Raw from firmware (before any conversion)
  rawQuat: [number, number, number, number]; // [w, x, y, z]
  rawAccel: [number, number, number]; // m/s²
  rawGyro: [number, number, number]; // rad/s

  // After firmwareToThreeQuat conversion
  worldQuat: THREE.Quaternion;

  // Gravity vector computed from accelerometer
  gravityWorld: THREE.Vector3;
  gravityExpected: THREE.Vector3; // Should be [0, -1, 0] in Three.js

  // After calibration offset
  calibratedQuat: THREE.Quaternion | null;
  calibrationOffset: THREE.Quaternion | null;

  // T-pose target comparison
  tposeTarget: THREE.Quaternion;
  angleToTarget: number; // degrees

  // Validation flags
  gravityAligned: boolean;
  quaternionNormalized: boolean;
}

// ============================================================================
// PIPELINE DEBUGGER
// ============================================================================

class PipelineDebugger {
  private enabled = false;
  private logBuffer: PipelineDebugData[] = [];
  private maxBufferSize = 100;
  private logInterval = 60; // Log every N frames per segment
  private frameCounters = new Map<string, number>();

  /**
   * Enable/disable debugging
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`[PipelineDebugger] ${enabled ? "ENABLED" : "DISABLED"}`);

    if (enabled) {
      console.log("=".repeat(60));
      console.log("PIPELINE DEBUG MODE - Logging orientation transformations");
      console.log("=".repeat(60));
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Log a quaternion as Euler angles (degrees) for human readability
   */
  private quatToEulerStr(q: THREE.Quaternion): string {
    const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");
    const x = THREE.MathUtils.radToDeg(euler.x).toFixed(1);
    const y = THREE.MathUtils.radToDeg(euler.y).toFixed(1);
    const z = THREE.MathUtils.radToDeg(euler.z).toFixed(1);
    return `[X:${x}°, Y:${y}°, Z:${z}°]`;
  }

  /**
   * Compute gravity direction from accelerometer in Three.js world frame
   */
  private computeGravityFromAccel(
    accel: [number, number, number],
    worldQuat: THREE.Quaternion,
  ): THREE.Vector3 {
    // Raw accelerometer in sensor frame
    const accelSensor = new THREE.Vector3(accel[0], accel[1], accel[2]);

    // Normalize to get direction
    const accelNorm = accelSensor.clone().normalize();

    // Transform to world frame using quaternion
    // The quaternion rotates sensor→world, so apply it to the accel vector
    const accelWorld = accelNorm.clone().applyQuaternion(worldQuat);

    // In Three.js, gravity points down (-Y). If stationary, accel should
    // point in the opposite direction (+Y) because we measure reaction force.
    // So if accel_world ≈ [0, 1, 0], we're correctly aligned.
    return accelWorld;
  }

  /**
   * Full pipeline analysis for one sensor frame
   */
  analyze(
    segmentId: string,
    rawQuat: [number, number, number, number],
    rawAccel: [number, number, number],
    rawGyro: [number, number, number],
    calibrationOffset: THREE.Quaternion | null,
  ): PipelineDebugData | null {
    if (!this.enabled) return null;

    // Rate limit: only log every N frames per segment
    const count = (this.frameCounters.get(segmentId) || 0) + 1;
    this.frameCounters.set(segmentId, count);
    if (count % this.logInterval !== 0) return null;

    // =====================================================================
    // STEP 1: Check raw quaternion normalization
    // =====================================================================
    const [w, x, y, z] = rawQuat;
    const norm = Math.sqrt(w * w + x * x + y * y + z * z);
    const quaternionNormalized = Math.abs(norm - 1.0) < 0.01;

    // =====================================================================
    // STEP 2: Convert to Three.js world frame
    // =====================================================================
    const worldQuat = firmwareToThreeQuat(rawQuat);

    // =====================================================================
    // STEP 3: Compute gravity direction
    // =====================================================================
    const gravityWorld = this.computeGravityFromAccel(rawAccel, worldQuat);
    const gravityExpected = new THREE.Vector3(0, 1, 0); // Accel reaction force
    const gravityDot = gravityWorld.dot(gravityExpected);
    const gravityAligned = gravityDot > 0.9; // Should be close to 1 if stationary and correct

    // =====================================================================
    // STEP 4: Apply calibration offset
    // =====================================================================
    let calibratedQuat: THREE.Quaternion | null = null;
    if (calibrationOffset) {
      calibratedQuat = worldQuat.clone().multiply(calibrationOffset);
    }

    // =====================================================================
    // STEP 5: Compare to T-pose target
    // =====================================================================
    const tposeTarget = getTposeTarget(segmentId);
    const quatToCompare = calibratedQuat || worldQuat;
    const angleToTarget =
      (2 * Math.acos(Math.abs(quatToCompare.dot(tposeTarget))) * 180) / Math.PI;

    const data: PipelineDebugData = {
      timestamp: Date.now(),
      segmentId,
      rawQuat,
      rawAccel,
      rawGyro,
      worldQuat,
      gravityWorld,
      gravityExpected,
      calibratedQuat,
      calibrationOffset,
      tposeTarget,
      angleToTarget,
      gravityAligned,
      quaternionNormalized,
    };

    // Log to console
    this.logToConsole(data);

    // Store in buffer
    this.logBuffer.push(data);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    return data;
  }

  private logToConsole(data: PipelineDebugData): void {
    console.group(`[Pipeline] ${data.segmentId}`);

    // Raw quaternion
    console.log(
      `1. RAW [w,x,y,z]: [${data.rawQuat.map((v) => v.toFixed(3)).join(", ")}] (norm=${data.quaternionNormalized ? "✓" : "❌"})`,
    );

    // After imuToThreeJS
    console.log(
      `2. WORLD (after imuToThreeJS): ${this.quatToEulerStr(data.worldQuat)}`,
    );

    // Gravity check
    const grav = data.gravityWorld;
    console.log(
      `3. GRAVITY (from accel): [${grav.x.toFixed(2)}, ${grav.y.toFixed(2)}, ${grav.z.toFixed(2)}] ${data.gravityAligned ? "✓ aligned" : "❌ MISALIGNED!"}`,
    );

    // After calibration
    if (data.calibratedQuat) {
      console.log(`4. CALIBRATED: ${this.quatToEulerStr(data.calibratedQuat)}`);
    } else {
      console.log(`4. CALIBRATED: [no offset applied]`);
    }

    // T-pose comparison
    console.log(`5. T-POSE TARGET: ${this.quatToEulerStr(data.tposeTarget)}`);
    console.log(
      `6. ANGLE TO TARGET: ${data.angleToTarget.toFixed(1)}° ${data.angleToTarget < 15 ? "✓" : "⚠️"}`,
    );

    console.groupEnd();
  }

  /**
   * Get recent debug data for UI display
   */
  getRecentData(): PipelineDebugData[] {
    return [...this.logBuffer];
  }

  /**
   * Clear buffer and counters
   */
  reset(): void {
    this.logBuffer = [];
    this.frameCounters.clear();
  }
}

// Singleton instance
export const pipelineDebugger = new PipelineDebugger();

// ============================================================================
// QUICK DIAGNOSTIC COMMANDS
// ============================================================================

/**
 * Enable debug mode - call from browser console:
 * window.enablePipelineDebug()
 */
(window as any).enablePipelineDebug = () => {
  pipelineDebugger.setEnabled(true);
};

/**
 * Disable debug mode
 */
(window as any).disablePipelineDebug = () => {
  pipelineDebugger.setEnabled(false);
};

/**
 * Print T-pose targets
 */
(window as any).printTposeTargets = () => {
  console.log("=".repeat(60));
  console.log("T-POSE TARGETS (expected sensor orientation):");
  console.log("=".repeat(60));

  const segments = [
    "pelvis",
    "thigh_l",
    "thigh_r",
    "tibia_l",
    "tibia_r",
    "foot_l",
    "foot_r",
  ];
  segments.forEach((seg) => {
    const target = getTposeTarget(seg);
    const euler = new THREE.Euler().setFromQuaternion(target, "XYZ");
    console.log(
      `${seg.padEnd(10)}: [X:${((euler.x * 180) / Math.PI).toFixed(0)}°, Y:${((euler.y * 180) / Math.PI).toFixed(0)}°, Z:${((euler.z * 180) / Math.PI).toFixed(0)}°]`,
    );
  });
};

console.log(
  "[PipelineDebugger] Loaded. Use window.enablePipelineDebug() to start debugging.",
);
