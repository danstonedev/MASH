/**
 * SCoRE (Symmetrical Centre of Rotation Estimation)
 * SARA (Symmetrical Axis of Rotation Approach)
 *
 * Functional joint calibration using gyroscope and quaternion data.
 *
 * NOTE: This thin wrapper delegates to the research-grade implementations
 * in ScoreAnalysis.ts. Do NOT add new algorithm logic here.
 */

import * as THREE from "three";
import { estimateHingeAxis } from "./ScoreAnalysis";

// ============================================================================
// Types
// ============================================================================

export interface SARAResult {
  axisWorld: THREE.Vector3;
  /** Hinge axis in proximal segment local frame (use this for FK/constraint application) */
  axisInProximal: THREE.Vector3;
  /** Hinge axis in distal segment local frame */
  axisInDistal: THREE.Vector3;
  confidence: number;
  jointId: string;
}

export interface JointPair {
  jointId: string;
  proximalSegment: string;
  distalSegment: string;
  /**
   * 'hinge' = single-axis rotation (knee, elbow, ankle).
   * 'ball'  = 3-DOF ball-and-socket (hip, shoulder).
   * SARACalibrator.compute() is only valid for hinge joints.
   */
  jointType: "hinge" | "ball";
}

// ============================================================================
// Constants
// ============================================================================

export const JOINT_PAIRS: JointPair[] = [
  {
    jointId: "hip_l",
    proximalSegment: "pelvis",
    distalSegment: "thigh_l",
    jointType: "ball",
  },
  {
    jointId: "hip_r",
    proximalSegment: "pelvis",
    distalSegment: "thigh_r",
    jointType: "ball",
  },
  {
    jointId: "knee_l",
    proximalSegment: "thigh_l",
    distalSegment: "tibia_l",
    jointType: "hinge",
  },
  {
    jointId: "knee_r",
    proximalSegment: "thigh_r",
    distalSegment: "tibia_r",
    jointType: "hinge",
  },
  {
    jointId: "ankle_l",
    proximalSegment: "tibia_l",
    distalSegment: "foot_l",
    jointType: "hinge",
  },
  {
    jointId: "ankle_r",
    proximalSegment: "tibia_r",
    distalSegment: "foot_r",
    jointType: "hinge",
  },
  {
    jointId: "shoulder_l",
    proximalSegment: "torso",
    distalSegment: "upper_arm_l",
    jointType: "ball",
  },
  {
    jointId: "shoulder_r",
    proximalSegment: "torso",
    distalSegment: "upper_arm_r",
    jointType: "ball",
  },
  {
    jointId: "elbow_l",
    proximalSegment: "upper_arm_l",
    distalSegment: "forearm_l",
    jointType: "hinge",
  },
  {
    jointId: "elbow_r",
    proximalSegment: "upper_arm_r",
    distalSegment: "forearm_r",
    jointType: "hinge",
  },
];

// ============================================================================
// SARA Calibrator
// ============================================================================

export class SARACalibrator {
  private jointId: string;
  private frames: {
    proximalGyro: THREE.Vector3;
    distalGyro: THREE.Vector3;
    proximalQuat: THREE.Quaternion;
    distalQuat: THREE.Quaternion;
  }[] = [];

  constructor(jointId: string) {
    this.jointId = jointId;
  }

  addFrame(
    proximalGyro: THREE.Vector3,
    distalGyro: THREE.Vector3,
    proximalQuat: THREE.Quaternion,
    distalQuat: THREE.Quaternion,
  ): void {
    this.frames.push({ proximalGyro, distalGyro, proximalQuat, distalQuat });
  }

  compute(): SARAResult | null {
    if (this.frames.length < 30) return null;

    // Guard: SARA is only valid for hinge joints. Ball-and-socket joints (hip,
    // shoulder) have 3 DOF so the outer-product matrix has no dominant eigenvector
    // and the returned axis is meaningless.
    // The jointType field in JOINT_PAIRS marks which pairs are safe to call this on.
    // Callers should check jointType before calling compute().

    // Delegate to the research-grade SARA implementation in ScoreAnalysis.ts.
    // estimateHingeAxis uses the weighted outer-product accumulation method
    // (Ehrig et al. 2007): finds the eigenvector that maximises
    //   Σ (ω_proximal ⊗ ω_proximalᵀ + ω_distal ⊗ ω_distalᵀ)
    // This is the correct approach — NOT magnitude-weighted averaging of
    // gyro difference vectors, which converges to near-zero for a perfect hinge.
    const result = estimateHingeAxis({
      proximalGyro: this.frames.map((f) => f.proximalGyro),
      distalGyro: this.frames.map((f) => f.distalGyro),
      proximalOrientations: this.frames.map((f) => f.proximalQuat),
      distalOrientations: this.frames.map((f) => f.distalQuat),
    });

    if (!result) return null;

    return {
      axisWorld: result.axisWorld,
      axisInProximal: result.axisInProximal,
      axisInDistal: result.axisInDistal,
      confidence: result.confidence,
      jointId: this.jointId,
    };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export function findCalibrableJoints(segments: string[]): JointPair[] {
  return JOINT_PAIRS.filter(
    (jp) =>
      segments.includes(jp.proximalSegment) &&
      segments.includes(jp.distalSegment),
  );
}
