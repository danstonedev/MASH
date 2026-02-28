/**
 * Forward Kinematics Solver
 * =========================
 *
 * Chain-driven skeleton solver for research-grade motion capture.
 * Instead of setting each bone independently from its sensor,
 * this solver propagates rotations through the kinematic chain.
 *
 * Key benefits:
 * 1. Bones stay connected (no dislocated joints)
 * 2. SARA/SCoRE constraints enforced at each joint
 * 3. Parent motion affects child position
 *
 * @module ForwardKinematics
 */

import * as THREE from "three";
import { getDriftMonitor } from "../calibration/DriftMonitor";
import { JOINT_DEFINITIONS, JCS_EULER_ORDERS } from "./jointAngles";
import { SEGMENT_TO_BONE } from "./boneMapping"; // Determine segment from bone name? No, need reverse map or store segment on bone.

// ============================================================================
// TYPES
// ============================================================================

/**
 * Joint types in the kinematic model.
 */
export type JointType = "hinge" | "ball" | "fixed" | "free";

/**
 * A joint constraint from SARA or SCoRE calibration.
 */
export interface JointConstraint {
  type: JointType;

  /** For hinge joints: axis from SARA */
  hingeAxis?: THREE.Vector3;

  /** For ball joints: center from SCoRE */
  jointCenter?: THREE.Vector3;

  /** Range of motion limits [min, max] in radians */
  limits?: {
    x?: [number, number];
    y?: [number, number];
    z?: [number, number];
  };

  /** Confidence from calibration algorithm */
  confidence: number;
}

/**
 * A bone in the kinematic chain.
 */
export interface KinematicBone {
  /** Unique bone identifier */
  id: string;

  /** Display name */
  name: string;

  /** Parent bone ID (null for root) */
  parentId: string | null;

  /** Child bone IDs */
  childIds: string[];

  /** Offset from parent joint in parent's local space */
  offsetFromParent: THREE.Vector3;

  /** Current world position */
  worldPosition: THREE.Vector3;

  /** Current world rotation */
  worldRotation: THREE.Quaternion;

  /** Sensor ID assigned to this bone (if any) */
  sensorId?: string;

  /** Calibration offset for this sensor-bone pair */
  calibrationOffset?: THREE.Quaternion;

  /** Joint constraint with parent */
  jointConstraint?: JointConstraint;
}

/**
 * The complete kinematic chain.
 */
export interface KinematicChain {
  /** Root bone ID (usually pelvis) */
  rootId: string;

  /** All bones indexed by ID */
  bones: Map<string, KinematicBone>;

  /** Traversal order (topologically sorted, root first) */
  traversalOrder: string[];
}

/**
 * Configuration for FK solver.
 */
export interface FKSolverConfig {
  /** Apply SARA hinge constraints */
  enforceHingeConstraints: boolean;

  /** Apply SCoRE joint center offsets */
  useJointCenters: boolean;

  /** Apply anatomical ROM limits */
  enforceROMLimits: boolean;

  /** Smoothing factor for constraint application [0-1] */
  constraintSoftness: number;

  /** Global scale factor for skeleton (default 1.0 = ~1.80m) */
  skeletonScale: number;
}

// ============================================================================
// DEFAULT SKELETON DEFINITION
// ============================================================================

/**
 * Default human skeleton structure.
 * Offsets are approximate in mm (model units).
 */
export const DEFAULT_SKELETON_STRUCTURE: Record<
  string,
  {
    parent: string | null;
    offset: [number, number, number];
    jointType: JointType;
  }
> = {
  // Root
  pelvis: { parent: null, offset: [0, 0, 0], jointType: "free" },

  // Spine chain
  torso: { parent: "pelvis", offset: [0, 250, 0], jointType: "ball" },
  head: { parent: "torso", offset: [0, 300, 0], jointType: "ball" },

  // Left leg
  thigh_l: { parent: "pelvis", offset: [-100, -50, 0], jointType: "ball" },
  tibia_l: { parent: "thigh_l", offset: [0, -450, 0], jointType: "hinge" },
  foot_l: { parent: "tibia_l", offset: [0, -400, 50], jointType: "hinge" },

  // Right leg
  thigh_r: { parent: "pelvis", offset: [100, -50, 0], jointType: "ball" },
  tibia_r: { parent: "thigh_r", offset: [0, -450, 0], jointType: "hinge" },
  foot_r: { parent: "tibia_r", offset: [0, -400, 50], jointType: "hinge" },

  // Left arm
  upper_arm_l: { parent: "torso", offset: [-200, 200, 0], jointType: "ball" },
  forearm_l: {
    parent: "upper_arm_l",
    offset: [0, -300, 0],
    jointType: "hinge",
  },
  hand_l: { parent: "forearm_l", offset: [0, -250, 0], jointType: "hinge" },

  // Right arm
  upper_arm_r: { parent: "torso", offset: [200, 200, 0], jointType: "ball" },
  forearm_r: {
    parent: "upper_arm_r",
    offset: [0, -300, 0],
    jointType: "hinge",
  },
  hand_r: { parent: "forearm_r", offset: [0, -250, 0], jointType: "hinge" },
};

// ============================================================================
// FK SOLVER CLASS
// ============================================================================

/**
 * Forward Kinematics solver for chain-driven skeleton.
 */
export class FKSolver {
  private chain: KinematicChain;
  private config: FKSolverConfig;

  constructor(config: Partial<FKSolverConfig> = {}) {
    this.config = {
      enforceHingeConstraints: false,
      useJointCenters: true,
      enforceROMLimits: false,
      constraintSoftness: 0.85,
      skeletonScale: 1.0,
      ...config,
    };

    this.chain = this.buildDefaultChain();
  }

  /**
   * Update skeleton scale and rebuild chain.
   * @param scale Scale factor (e.g. 1.0 = default, 0.5 = half size)
   */
  setScale(scale: number): void {
    this.config.skeletonScale = scale;
    // Rebuild chain with new scale
    const oldBones = this.chain.bones;
    this.chain = this.buildDefaultChain();

    // Restore sensor assignments
    for (const [id, bone] of oldBones) {
      if (bone.sensorId && bone.calibrationOffset) {
        this.assignSensor(id, bone.sensorId, bone.calibrationOffset);
      }
    }
  }

  /**
   * Build the default kinematic chain from skeleton structure.
   */
  private buildDefaultChain(): KinematicChain {
    const bones = new Map<string, KinematicBone>();
    const scale = this.config.skeletonScale;

    // First pass: create all bones
    for (const [id, def] of Object.entries(DEFAULT_SKELETON_STRUCTURE)) {
      // Scale the default offset
      const scaledOffset = new THREE.Vector3(...def.offset).multiplyScalar(
        scale,
      );

      bones.set(id, {
        id,
        name: id.replace("_", " "),
        parentId: def.parent,
        childIds: [],
        offsetFromParent: scaledOffset,
        worldPosition: new THREE.Vector3(),
        worldRotation: new THREE.Quaternion(),
        jointConstraint: {
          type: def.jointType,
          confidence: 0,
        },
      });
    }

    // Second pass: link children
    for (const bone of bones.values()) {
      if (bone.parentId) {
        const parent = bones.get(bone.parentId);
        if (parent) {
          parent.childIds.push(bone.id);
        }
      }
    }

    // Compute traversal order (BFS from root)
    const traversalOrder = this.computeTraversalOrder(bones, "pelvis");

    return {
      rootId: "pelvis",
      bones,
      traversalOrder,
    };
  }

  /**
   * Compute topological traversal order (parent before children).
   */
  private computeTraversalOrder(
    bones: Map<string, KinematicBone>,
    rootId: string,
  ): string[] {
    const order: string[] = [];
    const queue = [rootId];

    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);

      const bone = bones.get(id);
      if (bone) {
        queue.push(...bone.childIds);
      }
    }

    return order;
  }

  /**
   * Update sensor assignment for a bone.
   */
  assignSensor(
    boneId: string,
    sensorId: string,
    calibrationOffset: THREE.Quaternion,
  ): void {
    const bone = this.chain.bones.get(boneId.toUpperCase());
    if (bone) {
      bone.sensorId = sensorId;
      bone.calibrationOffset = calibrationOffset.clone();
    }
  }

  /**
   * Set a SARA-derived hinge axis constraint for a joint.
   * The jointId corresponds to the distal bone (e.g., 'tibia_l' for knee_l).
   *
   * @param boneId The distal (child) bone ID
   * @param hingeAxis The hinge axis in parent bone's local frame
   * @param confidence SARA confidence (0-1)
   */
  setHingeConstraint(
    boneId: string,
    hingeAxis: THREE.Vector3,
    confidence: number,
  ): void {
    const bone = this.chain.bones.get(boneId.toUpperCase());
    if (bone) {
      bone.jointConstraint = {
        type: "hinge",
        hingeAxis: hingeAxis.clone().normalize(),
        confidence,
      };
      console.debug(
        `[FK] Set hinge constraint on ${boneId}: axis=[${hingeAxis
          .toArray()
          .map((v) => v.toFixed(3))
          .join(", ")}], conf=${(confidence * 100).toFixed(1)}%`,
      );
    }
  }

  /**
   * Map of sensor ID to Mounting Rotation quaternion.
   */
  private mountingRotations = new Map<string, THREE.Quaternion>();

  /**
   * Map of segment name to Tare State (level 1 & 2).
   */
  private tareStates = new Map<
    string,
    { mounting: THREE.Quaternion; heading: THREE.Quaternion }
  >();

  /**
   * Set mounting rotation for a sensor.
   */
  setMountingRotation(sensorId: string, rotation: THREE.Quaternion) {
    this.mountingRotations.set(sensorId, rotation);
  }

  /**
   * Set tare state for a segment.
   */
  setTareState(
    segment: string,
    mounting: THREE.Quaternion,
    heading: THREE.Quaternion,
  ) {
    this.tareStates.set(segment, { mounting, heading });
  }

  /**
   * Main FK update: propagate sensor data through chain.
   *
   * @param sensorData Map of sensorId → RAW sensor quaternion (Firmware Frame)
   * @param rootPosition World position of root bone
   */
  update(
    sensorData: Map<string, THREE.Quaternion>,
    rootPosition: THREE.Vector3 = new THREE.Vector3(0, 100, 0),
  ): void {
    // Process bones in traversal order (root first)
    for (const boneId of this.chain.traversalOrder) {
      const bone = this.chain.bones.get(boneId);
      if (!bone) continue;

      // Get parent world transform
      let parentWorldPos = rootPosition.clone();
      let parentWorldRot = new THREE.Quaternion(); // Identity

      if (bone.parentId) {
        const parent = this.chain.bones.get(bone.parentId);
        if (parent) {
          parentWorldPos = parent.worldPosition.clone();
          parentWorldRot = parent.worldRotation.clone();
        }
      }

      // Compute bone world position (Standard FK)
      const rotatedOffset = bone.offsetFromParent
        .clone()
        .applyQuaternion(parentWorldRot);
      bone.worldPosition.copy(parentWorldPos.clone().add(rotatedOffset));

      // Compute bone world rotation
      if (bone.sensorId && sensorData.has(bone.sensorId)) {
        // 1. Get RAW Sensor Quaternion
        const rawQuat = sensorData.get(bone.sensorId)!; // [w,x,y,z] form, but ThreeJS object

        // 2. Convert to ThreeJS World Frame (Hardware -> World)
        // Assuming input is already converted via firmwareToThreeQuat before passing here?
        // NO, let's assume input is ThreeJS frame for consistency with Map<string, THREE.Quaternion> signature.
        // Caller must ensure firmwareToThreeQuat is called if coming from raw array.
        let qWorld = rawQuat.clone();

        // 3. Apply Mounting Rotation (Physical Placement)
        const mountingRot = this.mountingRotations.get(bone.sensorId);
        if (mountingRot) {
          qWorld.multiply(mountingRot);
        }

        // 4. Apply Tare (Boresight/Heading)
        const tare = this.tareStates.get(bone.id.toLowerCase()); // bone ID usually matches segment?
        // Need to map Bone ID to Segment ID properly if they differ.
        // Using bone.id directly for now (e.g. THIGH_L).
        // NOTE: Tare is typically stored by SEGMENT name (thigh_l).
        // Bone names are THIGH_L. Case insensitive lookup needed.

        // Correction: Tare Level 1 (Mounting Tare - Software Alignment)
        // NOTE: If TareStore has a mounting tare, use it and skip calibrationOffset
        // to avoid applying the same correction twice.
        if (tare && tare.mounting && tare.mounting.lengthSq() > 0.99) {
          // TareStore has valid mounting tare - use it exclusively
          qWorld.multiply(tare.mounting);
        } else if (bone.calibrationOffset) {
          // 5. Fallback: Apply Calibration Offset (T-Pose) if no tare
          qWorld.multiply(bone.calibrationOffset);
        }

        // 6. Apply Drift Correction (Yaw)
        const driftMonitor = getDriftMonitor(bone.sensorId);
        const yawCorrectionDeg = driftMonitor.getYawCorrection();
        if (Math.abs(yawCorrectionDeg) > 0.01) {
          const yawCorrection = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            yawCorrectionDeg * (Math.PI / 180),
          );
          qWorld = yawCorrection.multiply(qWorld);
        }

        // 7. Apply Tare Level 2 (Heading Reset)
        if (tare && tare.heading) {
          const headingInv = tare.heading.clone().invert();
          qWorld = headingInv.multiply(qWorld);
        }

        // 8. Constraint Enforcement (FK Logic)
        if (bone.parentId) {
          // Compute Local Rotation relative to Parent
          // Q_World = Q_Parent * Q_Local  =>  Q_Local = inv(Q_Parent) * Q_World
          const parentInv = parentWorldRot.clone().invert();
          let qLocal = parentInv.multiply(qWorld);

          // Apply ROM Constraints
          const segmentId = this.findSegmentForBone(bone.id);
          if (this.config.enforceROMLimits && segmentId) {
            const { constrained, wasConstrained } =
              this.applyDetailedConstraints(qLocal, segmentId);
            if (wasConstrained) {
              qLocal = constrained;
            }
          } else if (
            this.config.enforceHingeConstraints &&
            bone.jointConstraint?.type === "hinge" &&
            bone.jointConstraint.hingeAxis
          ) {
            // Fallback to legacy Hinge Constraint if no detailed ROM
            qLocal = this.constrainToHinge(
              qLocal,
              bone.jointConstraint.hingeAxis,
              parentWorldRot,
            );
          }

          // Reconstruct World Rotation
          bone.worldRotation.copy(parentWorldRot.clone().multiply(qLocal));
        } else {
          // Root Bone (No parent constraints)
          bone.worldRotation.copy(qWorld);
        }
      } else {
        // No sensor - inherit parent rotation + Rest Pose (Arms Down)
        // If just parentRot (Identity Local), arms point UP (Mixamo Y-axis).
        // We need to apply the specific local rest rotation for this bone.
        const restRot = this.getRestRotation(bone.id);
        const qLocal = restRot.clone();
        bone.worldRotation.copy(parentWorldRot.clone().multiply(qLocal));
      }
    }
  }

  /**
   * Find segment ID for a bone ID.
   * Helper since we don't store segment explicitely on bone yet.
   */
  private findSegmentForBone(boneId: string): string | null {
    // SEGMENT_TO_BONE is Segment -> Bone.
    // We need Bone -> Segment.
    // This is slow, ideally cache it.
    const entries = Object.entries(SEGMENT_TO_BONE);
    const found = entries.find(([_, bId]) => bId === boneId);
    return found ? found[0] : null;
  }

  /**
   * Apply detailed ROM constraints from jointAngles.ts
   */
  private applyDetailedConstraints(
    localQuat: THREE.Quaternion,
    segmentId: string,
  ): { constrained: THREE.Quaternion; wasConstrained: boolean } {
    // Find joint definition where this segment is the CHILD
    // e.g. segment='thigh_l' -> joint='hip_l'
    const jointEntry = Object.entries(JOINT_DEFINITIONS).find(
      ([_, def]) => def.childSegment === segmentId,
    );
    if (!jointEntry) return { constrained: localQuat, wasConstrained: false };

    const [jointId, jointDef] = jointEntry;
    const DEG2RAD = Math.PI / 180;

    // Use ISB-compliant Euler order from JCS_EULER_ORDERS (no string matching)
    const eulerOrder = JCS_EULER_ORDERS[jointId] || "ZXY";

    const euler = new THREE.Euler().setFromQuaternion(
      localQuat,
      eulerOrder as THREE.EulerOrder,
    );
    let wasConstrained = false;

    const clamp = (val: number, min: number, max: number) =>
      Math.min(max, Math.max(min, val));

    // Helper to extract indices based on order
    let fIdx = "z",
      aIdx = "x",
      rIdx = "y"; // ZXY default
    if (eulerOrder === "XZY") {
      fIdx = "x";
      aIdx = "z";
      rIdx = "y";
    }
    if (eulerOrder === "YXZ") {
      fIdx = "y";
      aIdx = "x";
      rIdx = "z";
    }

    // Extract angles
    const flexion = (euler as any)[fIdx];
    const abduction = (euler as any)[aIdx];
    const rotation = (euler as any)[rIdx];

    // Clamp (Angles in Radians, Ranges in Degrees)
    const cFlexion = clamp(
      flexion,
      jointDef.flexionRange[0] * DEG2RAD,
      jointDef.flexionRange[1] * DEG2RAD,
    );
    const cAbduction = clamp(
      abduction,
      jointDef.abductionRange[0] * DEG2RAD,
      jointDef.abductionRange[1] * DEG2RAD,
    );
    const cRotation = clamp(
      rotation,
      jointDef.rotationRange[0] * DEG2RAD,
      jointDef.rotationRange[1] * DEG2RAD,
    );

    if (
      Math.abs(cFlexion - flexion) > 0.001 ||
      Math.abs(cAbduction - abduction) > 0.001 ||
      Math.abs(cRotation - rotation) > 0.001
    ) {
      wasConstrained = true;
      // Reconstruct
      if (eulerOrder === "ZXY")
        euler.set(cAbduction, cRotation, cFlexion, "ZXY");
      else if (eulerOrder === "XZY")
        euler.set(cFlexion, cRotation, cAbduction, "XZY");
      else if (eulerOrder === "YXZ")
        euler.set(cAbduction, cFlexion, cRotation, "YXZ");
    }

    const constrained = new THREE.Quaternion().setFromEuler(euler);
    return { constrained, wasConstrained };
  }

  /**
   * Constrain rotation to a hinge axis.
   */
  private constrainToHinge(
    rotation: THREE.Quaternion,
    hingeAxis: THREE.Vector3,
    parentRot: THREE.Quaternion,
  ): THREE.Quaternion {
    // Transform hinge axis to world space
    const worldAxis = hingeAxis.clone().applyQuaternion(parentRot);

    // Decompose rotation into twist (around hinge) and swing (away from hinge)
    const { twist } = this.decomposeSwingTwist(rotation, worldAxis);

    // Use only the twist component (rotation around hinge axis)
    const softness = this.config.constraintSoftness;
    return rotation.clone().slerp(twist, 1 - softness);
  }

  /**
   * Decompose a quaternion into swing and twist components.
   */
  private decomposeSwingTwist(
    q: THREE.Quaternion,
    axis: THREE.Vector3,
  ): { swing: THREE.Quaternion; twist: THREE.Quaternion } {
    const ra = new THREE.Vector3(q.x, q.y, q.z);
    const proj = axis.clone().multiplyScalar(ra.dot(axis));

    const twist = new THREE.Quaternion(proj.x, proj.y, proj.z, q.w).normalize();
    const swing = q.clone().multiply(twist.clone().invert());

    return { swing, twist };
  }

  /**
   * Get a bone's current world transform.
   */
  getBoneTransform(
    boneId: string,
  ): { position: THREE.Vector3; rotation: THREE.Quaternion } | null {
    const bone = this.chain.bones.get(boneId.toUpperCase());
    if (!bone) return null;

    return {
      position: bone.worldPosition.clone(),
      rotation: bone.worldRotation.clone(),
    };
  }

  /**
   * Get all bone transforms for rendering.
   */
  getAllTransforms(): Map<
    string,
    { position: THREE.Vector3; rotation: THREE.Quaternion }
  > {
    const transforms = new Map();

    for (const [id, bone] of this.chain.bones) {
      transforms.set(id, {
        position: bone.worldPosition.clone(),
        rotation: bone.worldRotation.clone(),
      });
    }

    return transforms;
  }

  /**
   * Check which bones have sensors assigned.
   */
  getAssignedBones(): string[] {
    return Array.from(this.chain.bones.entries())
      .filter(([_, bone]) => bone.sensorId)
      .map(([id, _]) => id);
  }

  /**
   * Get chain structure for debugging.
   */
  getChainInfo(): { rootId: string; boneCount: number; assignedCount: number } {
    return {
      rootId: this.chain.rootId,
      boneCount: this.chain.bones.size,
      assignedCount: this.getAssignedBones().length,
    };
  }

  /**
   * Get sensor ID assigned to a segment.
   */
  getSegmentSensor(segmentId: string): string | undefined {
    const bone = this.chain.bones.get(segmentId.toUpperCase());
    return bone?.sensorId;
  }

  /**
   * Helper: Get Rest Rotation (Local) for a bone to achieve "Arms Down" / Neutral pose.
   * This compensates for Mixamo's "Y-Axis along bone" convention.
   */
  private getRestRotation(boneId: string): THREE.Quaternion {
    const q = new THREE.Quaternion();

    // Definitions for Mixamo Rig (assuming Y-axis along bone)
    // Parent frame is usually Y-Up.

    if (boneId.includes("UPPER_ARM")) {
      // Arms down: Rotate -180 around Z? Or just use T-Pose (-90)?
      // T-Pose targets use (0,0,-90) or similar.
      // Let's assume T-Pose (Arms Out) for now as it's cleaner than Soldier.
      // Or better: Soldier (Arms Down).
      // T-Pose (Arms X-axis): -90 Z.
      // Solder (Arms -Y axis): -180 Z.
      // Let's try T-Pose as neutral for now.
      q.setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2)); // -90 deg Z
      if (boneId.includes("_R"))
        q.setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)); // +90 deg Z for Right?
    } else if (boneId.includes("FOREARM")) {
      // Forearm aligned with Upper Arm. Identity.
    } else if (boneId.includes("THIGH")) {
      // Legs down. Identity usually works if Pelvis is Y-Down?
      // No, Pelvis is Y-Up (World). Thigh needs to point Down (-Y).
      // So 180 deg around Z or X.
      q.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
    }

    return q;
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

/** Global FK solver instance */
export const fkSolver = new FKSolver();
