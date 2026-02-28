import * as THREE from "three";
import { FKSolver } from "../ForwardKinematics";
import { calculateJointAngle, type JointAngles } from "../jointAngles";

/**
 * Kinematic Validation Framework
 * ==============================
 *
 * Validates the Forward Kinematics solver against external "Ground Truth" data
 * (e.g., from OpenSim, Xsens, or optical motion capture).
 */

export interface ValidationFrame {
  timestamp: number;
  inputs: {
    [segmentId: string]: THREE.Quaternion; // Assessment: Sensor World Quaternions (after calibration/alignment)
  };
  expectedOutputs: {
    [jointName: string]: {
      flexion: number;
      abduction: number;
      rotation: number;
    };
  };
}

export interface ValidationDataset {
  name: string;
  description: string;
  frames: ValidationFrame[];
}

export interface ValidationResult {
  testName: string;
  passed: boolean;
  mae: { [jointName: string]: number }; // Mean Absolute Error per joint
  maxError: { [jointName: string]: number };
  details: string[];
}

export class KinematicValidator {
  private solver: FKSolver;

  constructor(solver: FKSolver) {
    this.solver = solver;
  }

  /**
   * Run validation using an external dataset
   */
  runDatasetTest(dataset: ValidationDataset): ValidationResult {
    const details: string[] = [];
    let passed = true;
    const totalError: { [joint: string]: number } = {};
    const maxError: { [joint: string]: number } = {};
    const frameCount = dataset.frames.length;

    details.push(
      `Running validation on dataset: ${dataset.name} (${frameCount} frames)`,
    );

    // Initialize error tracking
    // (Assuming we track all joints present in the first frame)

    for (const frame of dataset.frames) {
      // 1. Update Solver with Inputs
      // We assume inputs are already correctly mapped to segments
      const inputMap = new Map<string, THREE.Quaternion>();
      for (const [segId, quat] of Object.entries(frame.inputs)) {
        // Ensure we handle plain objects or THREE.Quaternions
        const q = new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w);
        inputMap.set(segId, q);

        // IMPORTANT: We must ensure the solver has these sensors assigned
        // For validation, we might need to "force" assignment if not already done.
        // Here we assume the setup is done or we do it efficiently.
        // For simplicity in this test harness, we re-assign if missing.
        if (!this.solver.getSegmentSensor(segId)) {
          // assigning a dummy sensor ID matching the segment for simplicity
          this.solver.assignSensor(
            segId,
            `SENSOR_${segId}`,
            new THREE.Quaternion(),
          );
        }
      }

      this.solver.update(inputMap);

      // 2. Compare Outputs
      for (const [jointName, expected] of Object.entries(
        frame.expectedOutputs,
      )) {
        // Get Calculated Angles
        // We need to know which bones correspond to this joint.
        // FKSolver doesn't directly output "knee_l" angles in a map,
        // we calculate them on demand or via getJointAngles().

        // We need a map from JointName -> [ParentSeg, ChildSeg]
        // For now, let's hardcode the lookup or use a helper
        const angles = this.getCalculatedJointAngle(jointName);

        if (angles) {
          const errFlex = Math.abs(angles.flexion - expected.flexion);
          const errAbd = Math.abs(angles.abduction - expected.abduction);
          const errRot = Math.abs(angles.rotation - expected.rotation);

          const totalJointError = errFlex + errAbd + errRot;

          if (!totalError[jointName]) totalError[jointName] = 0;
          if (!maxError[jointName]) maxError[jointName] = 0;

          totalError[jointName] += totalJointError;
          maxError[jointName] = Math.max(maxError[jointName], totalJointError);
        } else {
          details.push(`WARNING: Could not calculate angles for ${jointName}`);
        }
      }
    }

    // 3. Summarize Results
    const mae: { [joint: string]: number } = {};
    const ERROR_THRESHOLD_DEG = 5.0; // Fail if MAE > 5 degrees

    for (const joint of Object.keys(totalError)) {
      mae[joint] = totalError[joint] / frameCount;
      if (mae[joint] > ERROR_THRESHOLD_DEG) {
        passed = false;
        details.push(
          `FAIL: ${joint} MAE ${mae[joint].toFixed(2)}° exceeds limit ${ERROR_THRESHOLD_DEG}°`,
        );
      } else {
        details.push(
          `PASS: ${joint} MAE ${mae[joint].toFixed(2)}° (Max ${maxError[joint].toFixed(2)}°)`,
        );
      }
    }

    return {
      testName: `Dataset: ${dataset.name}`,
      passed,
      mae,
      maxError,
      details,
    };
  }

  /**
   * Helper to compute angle for a named joint using the solver's current state
   */
  private getCalculatedJointAngle(jointName: string): JointAngles | null {
    // Map common ISB joint names to our Segment IDs
    // This mapping needs to be robust.
    // Example: "knee_r" -> Thigh_R, Tibia_R

    let parentSeg = "";
    let childSeg = "";
    let axis = "";

    switch (jointName.toLowerCase()) {
      case "knee_r":
        parentSeg = "THIGH_R";
        childSeg = "TIBIA_R";
        break;
      case "knee_l":
        parentSeg = "THIGH_L";
        childSeg = "TIBIA_L";
        break;
      case "hip_r":
        parentSeg = "PELVIS";
        childSeg = "THIGH_R";
        break;
      case "hip_l":
        parentSeg = "PELVIS";
        childSeg = "THIGH_L";
        break;
      case "ankle_r":
        parentSeg = "TIBIA_R";
        childSeg = "FOOT_R";
        break;
      case "ankle_l":
        parentSeg = "TIBIA_L";
        childSeg = "FOOT_L";
        break;
      // Add other joints as needed
      default:
        return null;
    }

    const pTrans = this.solver.getBoneTransform(parentSeg);
    const cTrans = this.solver.getBoneTransform(childSeg);

    if (pTrans && cTrans) {
      return calculateJointAngle(
        pTrans.rotation,
        cTrans.rotation,
        jointName.toLowerCase(),
      );
    }
    return null;
  }
}
