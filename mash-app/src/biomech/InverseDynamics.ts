/**
 * Inverse Dynamics Engine - Ground Reaction Force Estimation
 * ===========================================================
 *
 * Estimates Ground Reaction Forces (GRFs) from IMU data using Newton-Euler
 * inverse dynamics. This enables gait analysis without force plates.
 *
 * Physical Basis:
 *   F_GRF = m_total × a_CoM + m_total × g
 *
 * Where:
 *   - F_GRF is the sum of ground reaction forces on both feet
 *   - m_total is the total body mass
 *   - a_CoM is the center of mass acceleration (from pelvis IMU)
 *   - g is gravitational acceleration [0, -9.81, 0]
 *
 * Key Assumptions:
 *   1. Pelvis acceleration ≈ Center of Mass acceleration
 *   2. Body is treated as a single rigid segment for total GRF
 *   3. Double support phase uses smooth transition assumption
 *
 * References:
 *   - Karatsidis et al. (2017) - IMU-based GRF estimation
 *   - Ren et al. (2008) - Whole body inverse dynamics
 *
 * @module InverseDynamics
 */

import * as THREE from "three";

// ============================================================================
// CONSTANTS
// ============================================================================

const GRAVITY = new THREE.Vector3(0, -9.81, 0); // m/s²

// Standard body segment mass percentages (De Leva, 1996)
const SEGMENT_MASS_PERCENTAGE: Record<string, number> = {
  pelvis: 0.142, // Including lower trunk
  torso: 0.302, // Upper trunk + head
  head: 0.069,
  thigh_r: 0.1,
  thigh_l: 0.1,
  tibia_r: 0.043,
  tibia_l: 0.043,
  foot_r: 0.014,
  foot_l: 0.014,
  upper_arm_r: 0.027,
  upper_arm_l: 0.027,
  forearm_r: 0.023,
  forearm_l: 0.023,
  hand_r: 0.006,
  hand_l: 0.006,
};

// Segment moment of inertia coefficients (relative to segment mass × length²)
const SEGMENT_INERTIA_COEFF: Record<
  string,
  { x: number; y: number; z: number }
> = {
  pelvis: { x: 0.105, y: 0.095, z: 0.085 },
  torso: { x: 0.15, y: 0.14, z: 0.1 },
  thigh_r: { x: 0.245, y: 0.245, z: 0.08 },
  thigh_l: { x: 0.245, y: 0.245, z: 0.08 },
  tibia_r: { x: 0.255, y: 0.255, z: 0.065 },
  tibia_l: { x: 0.255, y: 0.255, z: 0.065 },
  foot_r: { x: 0.15, y: 0.12, z: 0.03 },
  foot_l: { x: 0.15, y: 0.12, z: 0.03 },
};

// ============================================================================
// TYPES
// ============================================================================

export interface AnthropometricModel {
  totalMass: number; // kg
  height: number; // m
  segmentMasses: Map<string, number>; // kg per segment
  segmentLengths: Map<string, number>; // m per segment
  segmentInertias: Map<string, THREE.Vector3>; // kg·m² per segment
}

export interface GRFEstimate {
  timestamp: number;

  // Total GRF (sum of both feet)
  totalForce: THREE.Vector3; // Newtons [Fx, Fy, Fz]

  // Normalized to body weight
  normalizedForce: THREE.Vector3; // BW units

  // Per-foot estimates (during single support)
  leftFootForce?: THREE.Vector3;
  rightFootForce?: THREE.Vector3;

  // Gait phase
  phase: GaitPhase;
  supportLeg: "left" | "right" | "double" | "flight";

  // Quality metrics
  confidence: number; // 0-1
}

export type GaitPhase =
  | "loading_response" // 0-10% of gait cycle
  | "mid_stance" // 10-30%
  | "terminal_stance" // 30-50%
  | "pre_swing" // 50-60%
  | "initial_swing" // 60-73%
  | "mid_swing" // 73-87%
  | "terminal_swing" // 87-100%
  | "unknown";

export interface JointMoment {
  segment: string;
  moment: THREE.Vector3; // Nm [Mx, My, Mz]
  force: THREE.Vector3; // N [Fx, Fy, Fz]
}

// ============================================================================
// ANTHROPOMETRIC MODEL
// ============================================================================

/**
 * Create an anthropometric model from height and weight.
 * Uses De Leva (1996) segment proportions for adults.
 */
export function createAnthropometricModel(
  height: number, // cm
  weight: number, // kg
  gender: "male" | "female" = "male",
): AnthropometricModel {
  const heightM = height / 100; // Convert to meters

  // Gender-specific segment length proportions
  const lengthRatios: Record<string, number> =
    gender === "male"
      ? {
          pelvis: 0.105,
          torso: 0.288,
          thigh_r: 0.245,
          thigh_l: 0.245,
          tibia_r: 0.246,
          tibia_l: 0.246,
          foot_r: 0.152,
          foot_l: 0.152,
          arm_r: 0.186,
          arm_l: 0.186,
          forearm_r: 0.146,
          forearm_l: 0.146,
          hand_r: 0.108,
          hand_l: 0.108,
        }
      : {
          pelvis: 0.111,
          torso: 0.28,
          thigh_r: 0.249,
          thigh_l: 0.249,
          tibia_r: 0.257,
          tibia_l: 0.257,
          foot_r: 0.143,
          foot_l: 0.143,
          arm_r: 0.173,
          arm_l: 0.173,
          forearm_r: 0.138,
          forearm_l: 0.138,
          hand_r: 0.1,
          hand_l: 0.1,
        };

  // Calculate segment masses
  const segmentMasses = new Map<string, number>();
  Object.entries(SEGMENT_MASS_PERCENTAGE).forEach(([seg, pct]) => {
    segmentMasses.set(seg, weight * pct);
  });

  // Calculate segment lengths
  const segmentLengths = new Map<string, number>();
  Object.entries(lengthRatios).forEach(([seg, ratio]) => {
    segmentLengths.set(seg, heightM * ratio);
  });

  // Calculate segment moments of inertia
  const segmentInertias = new Map<string, THREE.Vector3>();
  Object.entries(SEGMENT_INERTIA_COEFF).forEach(([seg, coeffs]) => {
    const mass = segmentMasses.get(seg) || 0;
    const length = segmentLengths.get(seg) || 0;
    const ml2 = mass * length * length;

    segmentInertias.set(
      seg,
      new THREE.Vector3(ml2 * coeffs.x, ml2 * coeffs.y, ml2 * coeffs.z),
    );
  });

  return {
    totalMass: weight,
    height: heightM,
    segmentMasses,
    segmentLengths,
    segmentInertias,
  };
}

// ============================================================================
// INVERSE DYNAMICS ENGINE
// ============================================================================

export class InverseDynamicsEngine {
  private model: AnthropometricModel;
  private grfHistory: GRFEstimate[] = [];
  private lastTimestamp: number = 0;

  // Gait event detection thresholds
  private heelStrikeThreshold = 15; // m/s² - accel spike
  private toeOffThreshold = 8; // m/s² - accel drop
  private flightThreshold = 0.3; // BW - vertical force threshold

  constructor(model: AnthropometricModel) {
    this.model = model;
  }

  /**
   * Update anthropometric model (e.g., when athlete changes).
   */
  setModel(model: AnthropometricModel) {
    this.model = model;
  }

  /**
   * Estimate GRF from pelvis IMU acceleration.
   *
   * @param pelvisAccel Linear acceleration in m/s² (gravity removed)
   * @param pelvisQuat Pelvis orientation quaternion
   * @param footAccelL Left foot acceleration (optional, for gait detection)
   * @param footAccelR Right foot acceleration (optional, for gait detection)
   * @param timestamp Frame timestamp in ms
   */
  estimateGRF(
    pelvisAccel: THREE.Vector3,
    pelvisQuat: THREE.Quaternion,
    timestamp: number,
    footAccelL?: THREE.Vector3,
    footAccelR?: THREE.Vector3,
  ): GRFEstimate {
    // Store timestamp for future velocity/derivative calculations
    const _dt = (timestamp - this.lastTimestamp) / 1000; // Reserved for future use
    void _dt; // Suppress unused warning
    this.lastTimestamp = timestamp;

    // Step 1: Transform pelvis accel to world frame
    const accelWorld = pelvisAccel.clone().applyQuaternion(pelvisQuat);

    // Step 2: Apply Newton's second law
    // F_GRF = m × a_pelvis + m × g
    const totalMass = this.model.totalMass;
    const gravityForce = GRAVITY.clone().multiplyScalar(-totalMass); // Upward reaction
    const inertialForce = accelWorld.clone().multiplyScalar(totalMass);

    const totalForce = gravityForce.add(inertialForce);

    // Step 3: Normalize to body weight
    const bodyWeight = totalMass * 9.81;
    const normalizedForce = totalForce.clone().divideScalar(bodyWeight);

    // Step 4: Detect gait phase from foot accelerations
    const phase = this.detectGaitPhase(
      footAccelL,
      footAccelR,
      normalizedForce.y,
    );
    const supportLeg = this.detectSupportLeg(
      footAccelL,
      footAccelR,
      normalizedForce,
    );

    // Step 5: Distribute force to feet during double support
    let leftFootForce: THREE.Vector3 | undefined;
    let rightFootForce: THREE.Vector3 | undefined;

    if (supportLeg === "left") {
      leftFootForce = totalForce.clone();
    } else if (supportLeg === "right") {
      rightFootForce = totalForce.clone();
    } else if (supportLeg === "double") {
      // Smooth transition assumption: linear distribution based on phase
      const ratio = this.getDoubleSupportRatio(phase);
      leftFootForce = totalForce.clone().multiplyScalar(ratio);
      rightFootForce = totalForce.clone().multiplyScalar(1 - ratio);
    }

    // Step 6: Calculate confidence
    const confidence = this.calculateConfidence(normalizedForce, supportLeg);

    // Store for history
    const estimate: GRFEstimate = {
      timestamp,
      totalForce,
      normalizedForce,
      leftFootForce,
      rightFootForce,
      phase,
      supportLeg,
      confidence,
    };

    this.grfHistory.push(estimate);
    if (this.grfHistory.length > 1000) {
      this.grfHistory.shift(); // Keep rolling buffer
    }

    return estimate;
  }

  /**
   * Detect current gait phase from acceleration patterns.
   */
  private detectGaitPhase(
    _footL?: THREE.Vector3,
    _footR?: THREE.Vector3,
    verticalForce?: number,
  ): GaitPhase {
    // Foot accelerations reserved for future heel strike detection
    void _footL;
    void _footR;
    // Simplified phase detection based on vertical GRF
    if (verticalForce === undefined) return "unknown";

    if (verticalForce < this.flightThreshold) {
      return "initial_swing"; // Flight phase
    } else if (verticalForce > 1.3) {
      return "loading_response"; // High impact = heel strike
    } else if (verticalForce > 1.0) {
      return "mid_stance";
    } else {
      return "terminal_stance";
    }
  }

  /**
   * Detect which leg is in contact with ground.
   */
  private detectSupportLeg(
    footL?: THREE.Vector3,
    footR?: THREE.Vector3,
    force?: THREE.Vector3,
  ): "left" | "right" | "double" | "flight" {
    if (!force) return "double";

    const verticalForce = force.y;

    // Flight detection
    if (verticalForce < this.flightThreshold) {
      return "flight";
    }

    // If we have foot accelerations, use them
    if (footL && footR) {
      const leftMag = footL.length();
      const rightMag = footR.length();

      // High acceleration indicates swing phase
      if (
        leftMag > this.heelStrikeThreshold &&
        rightMag < this.toeOffThreshold
      ) {
        return "right"; // Left is swinging
      } else if (
        rightMag > this.heelStrikeThreshold &&
        leftMag < this.toeOffThreshold
      ) {
        return "left"; // Right is swinging
      }
    }

    return "double"; // Default to double support
  }

  /**
   * Calculate force distribution ratio during double support.
   * Uses smooth transition assumption.
   */
  private getDoubleSupportRatio(phase: GaitPhase): number {
    // During loading response: weight shifting to landing foot
    // During pre-swing: weight shifting to stance foot
    switch (phase) {
      case "loading_response":
        return 0.7;
      case "pre_swing":
        return 0.3;
      default:
        return 0.5;
    }
  }

  /**
   * Calculate confidence score for the GRF estimate.
   */
  private calculateConfidence(force: THREE.Vector3, support: string): number {
    let confidence = 1.0;

    // Reduce confidence for unrealistic vertical forces
    if (force.y < 0 || force.y > 3) {
      confidence *= 0.5;
    }

    // Reduce confidence during flight/double support (indeterminate)
    if (support === "double") {
      confidence *= 0.7;
    } else if (support === "flight") {
      confidence *= 0.6;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Get peak vertical GRF over recent history.
   */
  getPeakVerticalGRF(windowMs: number = 1000): { peak: number; time: number } {
    const now = this.grfHistory[this.grfHistory.length - 1]?.timestamp || 0;
    const windowStart = now - windowMs;

    let peak = 0;
    let peakTime = 0;

    for (let i = this.grfHistory.length - 1; i >= 0; i--) {
      const est = this.grfHistory[i];
      if (est.timestamp < windowStart) break;

      if (est.normalizedForce.y > peak) {
        peak = est.normalizedForce.y;
        peakTime = est.timestamp;
      }
    }

    return { peak, time: peakTime };
  }

  /**
   * Get average loading rate (dF/dt) during heel strike.
   */
  getLoadingRate(): number {
    // Find recent loading response phases
    const loadingPhases = this.grfHistory.filter(
      (e) => e.phase === "loading_response",
    );
    if (loadingPhases.length < 2) return 0;

    // Calculate average dF/dt
    let totalRate = 0;
    let count = 0;

    for (let i = 1; i < loadingPhases.length; i++) {
      const prev = loadingPhases[i - 1];
      const curr = loadingPhases[i];
      const dt = (curr.timestamp - prev.timestamp) / 1000;
      if (dt > 0 && dt < 0.1) {
        // Within 100ms
        const dF = curr.normalizedForce.y - prev.normalizedForce.y;
        totalRate += dF / dt;
        count++;
      }
    }

    return count > 0 ? totalRate / count : 0;
  }

  /**
   * Get the current GRF history for visualization.
   */
  getHistory(): GRFEstimate[] {
    return [...this.grfHistory];
  }

  /**
   * Clear history buffer.
   */
  clearHistory() {
    this.grfHistory = [];
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Remove gravity from raw accelerometer reading.
 */
export function removeGravity(
  rawAccel: THREE.Vector3,
  orientation: THREE.Quaternion,
): THREE.Vector3 {
  // Gravity in world frame
  const gravityWorld = new THREE.Vector3(0, -9.81, 0);

  // Rotate gravity to sensor frame
  const gravityLocal = gravityWorld
    .clone()
    .applyQuaternion(orientation.clone().invert());

  // Subtract gravity from raw accelerometer
  return rawAccel.clone().sub(gravityLocal);
}

/**
 * Create a singleton instance for the application.
 */
let _inverseDynamicsInstance: InverseDynamicsEngine | null = null;

export function getInverseDynamicsEngine(): InverseDynamicsEngine {
  if (!_inverseDynamicsInstance) {
    // Default model for 180cm, 75kg male
    const defaultModel = createAnthropometricModel(180, 75, "male");
    _inverseDynamicsInstance = new InverseDynamicsEngine(defaultModel);
  }
  return _inverseDynamicsInstance;
}

/**
 * Update the singleton with new anthropometric data.
 */
export function updateInverseDynamicsModel(
  height: number,
  weight: number,
  gender: "male" | "female" = "male",
) {
  const model = createAnthropometricModel(height, weight, gender);
  getInverseDynamicsEngine().setModel(model);
}
