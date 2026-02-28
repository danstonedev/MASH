/**
 * KineticChain
 * ============
 *
 * Represents a connected chain of body segments (e.g., Leg, Arm, Spine)
 * for analysis purposes.
 *
 * Features:
 * - Aggregates sensor data for the entire chain (Energy, Dominant Axis)
 * - Tracks end-effector contact state (using ContactDetector)
 * - Computes chain-level metrics (e.g., "Leg Extension", "Arm Swing")
 *
 * @module analysis/KineticChain
 */

import * as THREE from "three";
import { ContactDetector } from "./ContactDetector";

// ============================================================================
// TYPES
// ============================================================================

export type ChainType = "leg_l" | "leg_r" | "arm_l" | "arm_r" | "core";

export interface ChainMetrics {
  /** Total kinetic energy of the chain (variance of acceleration) */
  energy: number;
  /** Is the end effector (foot/hand) in contact? */
  isContact: boolean;
  /** Contact confidence */
  contactConfidence: number;
  /** Dominant movement axis (e.g., Vertical vs Forward) */
  dominantAxis: THREE.Vector3;
  /** Average flexion of the primary joint (knee/elbow) in degrees */
  flexionAngle: number;
  /** Acceleration of the root segment (Pelvis/One-limb attachment) - COM Proxy */
  rootAccel: THREE.Vector3;
  /** Orientation of the root segment - For Form analysis */
  rootQuat: THREE.Quaternion;
}

export interface SegmentData {
  id: string; // deviceId
  role: "root" | "joint" | "effector"; // e.g. Thigh(root), Tibia(joint), Foot(effector)
  accel: THREE.Vector3;
  gyro: THREE.Vector3;
  quat: THREE.Quaternion;
}

// ============================================================================
// KINETIC CHAIN CLASS
// ============================================================================

export class KineticChain {
  public readonly type: ChainType;
  private segments: Map<string, "root" | "joint" | "effector"> = new Map();
  private contactDetector: ContactDetector;

  // State
  private metrics: ChainMetrics;

  constructor(type: ChainType) {
    this.type = type;
    this.contactDetector = new ContactDetector();
    this.metrics = {
      energy: 0,
      isContact: false,
      contactConfidence: 0,
      dominantAxis: new THREE.Vector3(0, 1, 0),
      flexionAngle: 0,
      rootAccel: new THREE.Vector3(),
      rootQuat: new THREE.Quaternion(),
    };
  }

  /**
   * Add a segment to this chain
   * @param deviceId Sensor ID
   * @param role structural role in the chain
   */
  addSegment(deviceId: string, role: "root" | "joint" | "effector") {
    this.segments.set(deviceId, role);
  }

  /**
   * Update chain state with new sensor data
   * @param data Map of all available sensor data for this frame
   * @param timestamp Current time
   */
  update(
    data: Map<
      string,
      { accel: THREE.Vector3; gyro: THREE.Vector3; quat: THREE.Quaternion }
    >,
    timestamp: number,
  ): ChainMetrics {
    let totalEnergy = 0;
    let segmentCount = 0;
    let effectorData = null;
    let rootData = null;

    // 1. Process each segment in the chain
    this.segments.forEach((role, deviceId) => {
      const sensor = data.get(deviceId);
      if (!sensor) return;

      // Energy Calculation (Magnitude of Gyro + Variance of Accel approx)
      // Simplified: Instantaneous Gyro Magnitude is a good proxy for "Movement Intensity"
      const energy = sensor.gyro.length();
      totalEnergy += energy;
      segmentCount++;

      // Role specific logic
      if (role === "effector") {
        effectorData = sensor;
      } else if (role === "root") {
        rootData = sensor;
      }
    });

    // 2. Update Contact Detection (End Effector only)
    if (effectorData) {
      const ed = effectorData as { accel: THREE.Vector3; gyro: THREE.Vector3 };
      const contactState = this.contactDetector.update(
        [ed.accel.x, ed.accel.y, ed.accel.z],
        [ed.gyro.x, ed.gyro.y, ed.gyro.z],
        timestamp,
      );

      this.metrics.isContact = contactState.isContact;
      this.metrics.contactConfidence = contactState.confidence;
    } else if (this.type === "core") {
      // Core usually no "contact" in the same sense, unless sitting detection?
      // For now, core contact = false
      this.metrics.isContact = false;
    }

    // 3. Update Root Data (COM Proxy)
    if (rootData) {
      this.metrics.rootAccel.copy((rootData as any).accel);
      this.metrics.rootQuat.copy((rootData as any).quat);
    } else if (segmentCount > 0 && !rootData) {
      // Fallback?
    }

    // 4. Aggregate Metrics
    this.metrics.energy = segmentCount > 0 ? totalEnergy / segmentCount : 0;

    // ML-Ready Feature: We could buffer these metrics here for internal ML inference later

    return { ...this.metrics };
  }

  getConfig(): { type: ChainType; segmentCount: number } {
    return { type: this.type, segmentCount: this.segments.size };
  }

  getMetrics(): ChainMetrics {
    return { ...this.metrics };
  }

  reset() {
    this.contactDetector.reset();
    this.metrics = {
      energy: 0,
      isContact: false,
      contactConfidence: 0,
      dominantAxis: new THREE.Vector3(0, 1, 0),
      flexionAngle: 0,
      rootAccel: new THREE.Vector3(),
      rootQuat: new THREE.Quaternion(),
    };
  }
}
