/**
 * OrientationProcessor - Sensor-to-Bone Orientation Pipeline (Rebuilt)
 * =====================================================================
 *
 * "Start Fresh" Engine.
 *
 * PRINCIPLE: GLOBAL STABILITY
 * Calculate everything in World Space first, then convert to Local Space at the very end.
 *
 * Pipeline:
 * 1. INPUT: Raw Sensor Quaternion (Sensor Frame)
 * 2. CONVERT: To World Frame (Three.js Right-Handed)
 * 3. DELTA: Calculate rotation relative to Calibration Pose (T-Pose)
 *    Q_delta = Q_current * inv(Q_calibration)
 * 4. TARGET: Apply Delta to Bone's Neutral World Orientation
 *    Q_target_world = Q_neutral_world * Q_delta
 * 5. COHERENCE: Cross-sensor heading coherence (when parent sensor available)
 *    Constrains relative yaw to joint ROM — parent acts as heading reference
 * 6. LOCAL: Convert to Local Space for Three.js Bone hierarchy
 *    Q_local = inv(Q_parent_world) * Q_target_world
 *
 * @module skeleton/OrientationProcessor
 */

import * as THREE from "three";
import { isIdentity } from "../../../lib/math/QuaternionPool";
import type { TareState } from "../../../calibration/taringPipeline";
import {
  JOINT_DEFINITIONS,
  JCS_EULER_ORDERS,
  type JointDefinition,
} from "../../../biomech/jointAngles";
import { SEGMENT_DEFINITIONS } from "../../../biomech/segmentRegistry";
import { transformOrientation } from "../../../lib/math/OrientationPipeline";

// ============================================================================
// SEGMENT TO JOINT MAPPING
// ============================================================================

/**
 * Maps segment IDs to their corresponding joint definitions.
 * Used for ROM constraint enforcement.
 */
const SEGMENT_TO_JOINT: Record<string, string> = {
  // Lower body - child segment maps to joint
  thigh_l: "hip_l",
  thigh_r: "hip_r",
  tibia_l: "knee_l",
  tibia_r: "knee_r",
  foot_l: "ankle_l",
  foot_r: "ankle_r",
  // Upper body
  upper_arm_l: "shoulder_l",
  upper_arm_r: "shoulder_r",
  forearm_l: "elbow_l",
  forearm_r: "elbow_r",
  // Spine
  torso: "lumbar",
  // Head — cervical ROM: flex [-60°,70°], side-bend [-45°,45°], rotation [-80°,80°]
  head: "cervical",
};

// ============================================================================
// FOOT CORRECTION
// ============================================================================

/**
 * Correction rotation for foot segments.
 * The model's foot bones have a neutral pose that's 90° pitched forward (toes down).
 * We apply a -90° X rotation to correct this and display feet flat in T-pose.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface OrientationPipelineOptions {
  /** Enable debug logging */
  enableLogging: boolean;
  /** Mounting rotation quaternion (physical sensor alignment) */
  mountingRotation?: THREE.Quaternion;
  /** Calibration offset quaternion (T-Pose alignment) */
  calibrationOffset?: THREE.Quaternion;
}

export interface OrientationResult {
  /** Final orientation quaternion in world frame (for debug/visualization) */
  worldQuat: THREE.Quaternion;
  /** Whether anatomical constraints were applied */
  wasConstrained: boolean;
  /** Debug info for logging */
  debugInfo?: {
    rawEuler: THREE.Euler;
    constrainedEuler: THREE.Euler;
  };
}

// ============================================================================
// ORIENTATION PROCESSOR CLASS
// ============================================================================

export class OrientationProcessor {
  private debugSegment: string | null = null;
  private logCounter: number = 0;

  // =========================================================================
  // OBJECT POOLS (Reusable instances to prevent GC churn)
  // =========================================================================
  private _tempQuat1 = new THREE.Quaternion();
  private _tempQuat2 = new THREE.Quaternion(); // For ROM delta calculation
  private _tempEuler = new THREE.Euler();
  private _parentWorld = new THREE.Quaternion();
  private _parentInv = new THREE.Quaternion();

  // Reusable result object to avoid allocating { worldQuat: ... } every frame
  // WARNING: Consumer must use immediately or clone!
  private _reusableResult: OrientationResult = {
    worldQuat: new THREE.Quaternion(),
    wasConstrained: false,
  };

  // =========================================================================
  // CROSS-SENSOR HEADING COHERENCE
  // =========================================================================
  // Caches each segment's world quaternion after processQuaternion so that
  // child segments can check their heading relative to parent.
  // =========================================================================

  /** Cache of world quaternions per segment, updated each frame */
  private _worldQuatCache = new Map<string, THREE.Quaternion>();

  // Pool objects for heading coherence math
  private _cohParentTwist = new THREE.Quaternion();
  private _cohChildTwist = new THREE.Quaternion();
  private _cohRelative = new THREE.Quaternion();
  private _cohCorrected = new THREE.Quaternion();
  private _cohIdentity = new THREE.Quaternion(0, 0, 0, 1);

  private _cohLogCounter = 0;

  /** Heading coherence strength: how aggressively to pull child yaw toward
   *  parent-relative limit. 0.3 = soft, 0.7 = firm, 1.0 = hard clamp. */
  private static readonly COH_STRENGTH = 0.5;

  /** Margin in radians outside the ROM before coherence kicks in.
   *  Small margin prevents fighting at boundary during normal motion. */
  private static readonly COH_MARGIN = 5 * (Math.PI / 180); // 5°

  /**
   * Cache a segment's world quaternion for cross-sensor heading coherence.
   * Call this AFTER enforceHeadingCoherence() so children see the corrected
   * parent heading, and BEFORE applyToBone().
   */
  cacheWorldQuat(segmentId: string, worldQuat: THREE.Quaternion): void {
    let cached = this._worldQuatCache.get(segmentId);
    if (!cached) {
      cached = new THREE.Quaternion();
      this._worldQuatCache.set(segmentId, cached);
    }
    cached.copy(worldQuat);
  }

  /**
   * Cross-sensor heading coherence.
   *
   * For a child segment with a tracked parent, extracts the relative yaw
   * (twist around Y) between them. If it exceeds the joint's rotation ROM,
   * the excess is attributed to drift rather than real motion, and the child's
   * yaw is pulled back toward the ROM boundary.
   *
   * This transforms the parent sensor into a "virtual magnetometer" for yaw,
   * solving the single-sensor heading ambiguity for all child segments.
   *
   * Modifies worldQuat IN PLACE.
   *
   * @param segmentId The child segment (e.g. "head")
   * @param worldQuat The child's world quaternion — modified in place if corrected
   * @returns true if a correction was applied
   */
  enforceHeadingCoherence(
    segmentId: string,
    worldQuat: THREE.Quaternion,
  ): boolean {
    // Look up kinematic parent from SEGMENT_DEFINITIONS (sensor hierarchy).
    // NOTE: For the head, parent = "torso" (the nearest sensor), NOT "spine_upper"
    // (the anatomical joint parent from JOINT_DEFINITIONS). This is intentional:
    // SEGMENT_DEFINITIONS tracks sensor-to-sensor kinematic chains, while
    // JOINT_DEFINITIONS tracks anatomical joints for ISB angle decomposition.
    // Heading coherence needs the parent *sensor* quat, not a sub-segment.
    const segDef = SEGMENT_DEFINITIONS[segmentId];
    if (!segDef?.parent) return false;

    // Check if parent has a cached world quat (i.e., parent sensor is active)
    const parentWorldQuat = this._worldQuatCache.get(segDef.parent);
    if (!parentWorldQuat) return false;

    // Find the joint definition for this child→parent relationship.
    // ROM limits come from the anatomical joint (e.g., cervical yaw ±80°).
    const jointId = SEGMENT_TO_JOINT[segmentId];
    if (!jointId) return false;
    const jointDef = JOINT_DEFINITIONS[jointId];
    if (!jointDef) return false;

    // Joint rotation range = yaw ROM (transverse plane)
    const DEG2RAD = Math.PI / 180;
    const rotMin = jointDef.rotationRange[0] * DEG2RAD;
    const rotMax = jointDef.rotationRange[1] * DEG2RAD;

    // ── Extract yaw twist (around Y) from parent world quat ──
    const pLen = Math.sqrt(
      parentWorldQuat.w * parentWorldQuat.w +
        parentWorldQuat.y * parentWorldQuat.y,
    );
    if (pLen < 0.0001) return false;
    this._cohParentTwist.set(
      0,
      parentWorldQuat.y / pLen,
      0,
      parentWorldQuat.w / pLen,
    );
    if (this._cohParentTwist.w < 0) {
      this._cohParentTwist.x *= -1;
      this._cohParentTwist.y *= -1;
      this._cohParentTwist.z *= -1;
      this._cohParentTwist.w *= -1;
    }

    // ── Extract yaw twist from child world quat ──
    const cLen = Math.sqrt(
      worldQuat.w * worldQuat.w + worldQuat.y * worldQuat.y,
    );
    if (cLen < 0.0001) return false;
    this._cohChildTwist.set(0, worldQuat.y / cLen, 0, worldQuat.w / cLen);
    if (this._cohChildTwist.w < 0) {
      this._cohChildTwist.x *= -1;
      this._cohChildTwist.y *= -1;
      this._cohChildTwist.z *= -1;
      this._cohChildTwist.w *= -1;
    }

    // ── Relative yaw: child relative to parent ──
    // relativeYaw = inv(parentTwist) × childTwist
    this._cohRelative
      .copy(this._cohParentTwist)
      .invert()
      .multiply(this._cohChildTwist);
    if (this._cohRelative.w < 0) {
      this._cohRelative.x *= -1;
      this._cohRelative.y *= -1;
      this._cohRelative.z *= -1;
      this._cohRelative.w *= -1;
    }

    // Convert to signed angle (around Y axis)
    const relativeYawAngle =
      2 * Math.atan2(this._cohRelative.y, this._cohRelative.w);

    // Check if yaw is within ROM + margin
    const lowerBound = rotMin - OrientationProcessor.COH_MARGIN;
    const upperBound = rotMax + OrientationProcessor.COH_MARGIN;

    if (relativeYawAngle >= lowerBound && relativeYawAngle <= upperBound) {
      return false; // Within limits — no correction needed
    }

    // ── Clamp to nearest ROM boundary ──
    const clampedYaw = relativeYawAngle < lowerBound ? rotMin : rotMax;

    // Build corrected relative yaw quaternion
    const halfClamped = clampedYaw / 2;
    this._cohCorrected.set(0, Math.sin(halfClamped), 0, Math.cos(halfClamped));

    // New child yaw = parent yaw × clamped relative yaw
    // correctedChildTwist = parentTwist × correctedRelative
    this._cohCorrected.premultiply(this._cohParentTwist);
    if (this._cohCorrected.w < 0) {
      this._cohCorrected.x *= -1;
      this._cohCorrected.y *= -1;
      this._cohCorrected.z *= -1;
      this._cohCorrected.w *= -1;
    }

    // ── Re-compose: replace child's yaw twist, keep its tilt (swing) ──
    // swing = quat × inv(twist) — the non-yaw part of the child's orientation
    // corrected = swing × correctedTwist
    // We use: corrected = worldQuat × inv(childTwist) × correctedTwist
    //       = worldQuat × (inv(childTwist) × correctedTwist)

    // yawDelta = inv(childTwist) × correctedTwist
    const yawDelta = this._cohRelative; // reuse pool
    yawDelta.copy(this._cohChildTwist).invert().multiply(this._cohCorrected);

    // Soft application: SLERP toward correction
    yawDelta.slerp(this._cohIdentity, 1 - OrientationProcessor.COH_STRENGTH);

    // Apply: correctedWorld = yawDelta × worldQuat
    // (premultiply because yaw correction is in world frame)
    worldQuat.premultiply(yawDelta).normalize();

    // Diagnostic logging (throttled)
    this._cohLogCounter++;
    if (this._cohLogCounter % 600 === 0) {
      const r2d = 180 / Math.PI;
      console.debug(
        `[HeadingCoherence] ${segmentId}: relYaw=${(relativeYawAngle * r2d).toFixed(1)}° ` +
          `ROM=[${jointDef.rotationRange[0]},${jointDef.rotationRange[1]}]° → ` +
          `clamped=${(clampedYaw * r2d).toFixed(1)}°`,
      );
    }

    return true;
  }

  /** Clear cached world quaternions (call at start of each frame if needed) */
  clearWorldQuatCache(): void {
    // Don't delete entries — just let them go stale; they're overwritten each frame
    // Only segments with active sensors will have fresh data
  }

  /**
   * Enable debug logging for a specific segment.
   * @param segmentId Segment ID (e.g. 'thigh_r') or null to disable.
   */
  setDebugSegment(segmentId: string | null) {
    this.debugSegment = segmentId;
    console.debug(`[OrientationProcessor] Debugging enabled for: ${segmentId}`);
  }

  /**
   * Helper to log Euler angles in degrees
   */
  private logEuler(label: string, q: THREE.Quaternion) {
    const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
    const r2d = (rad: number) => ((rad * 180) / Math.PI).toFixed(1);
    console.debug(`[${label}] R:${r2d(e.x)} P:${r2d(e.y)} Y:${r2d(e.z)}`);
  }

  processQuaternion(
    quatArray: [number, number, number, number],
    segment: string,
    tareState: TareState | null,
    options: Partial<OrientationPipelineOptions> = {},
  ): OrientationResult | null {
    const isDebug = this.debugSegment === segment;
    if (isDebug) {
      this.logCounter++;
      if (this.logCounter % 60 !== 0 && this.logCounter % 60 !== 1) {
        // Throttle
      }
    }

    const shouldLog = isDebug && this.logCounter % 60 === 0;

    // =====================================================================
    // INPUT VALIDATION
    // =====================================================================
    // Check for NaN or Infinity values
    if (quatArray.some((v) => isNaN(v) || !isFinite(v))) {
      if (shouldLog) {
        console.warn(
          `[OrientationProcessor] Invalid input for ${segment}: NaN/Infinity detected`,
        );
      }
      return null;
    }

    // Check for valid quaternion magnitude (should be ~1.0)
    const magnitude = Math.sqrt(
      quatArray[0] ** 2 +
        quatArray[1] ** 2 +
        quatArray[2] ** 2 +
        quatArray[3] ** 2,
    );
    if (magnitude < 0.9 || magnitude > 1.1) {
      if (shouldLog) {
        console.warn(
          `[OrientationProcessor] Unnormalized quaternion for ${segment}: |q|=${magnitude.toFixed(4)}`,
        );
      }
      // Auto-normalize to prevent drift
      const invMag = 1 / magnitude;
      quatArray = [
        quatArray[0] * invMag,
        quatArray[1] * invMag,
        quatArray[2] * invMag,
        quatArray[3] * invMag,
      ];
    }

    // Use reusable result container
    const result = this._reusableResult;
    result.wasConstrained = false;

    // =====================================================================
    // STEP 1-4: Consolidated Pipeline (Coordinate Switch + Mounting + Heading)
    // =====================================================================
    // Use the Unified Pipeline to ensure consistent math across the entire app.
    // This handles:
    // 1. Coordinate Conversion (Raw -> ThreeJS)
    // 2. Mounting Tare (L1)
    // 3. Heading Tare (L2) - CORRECTED math (Inverse multiplication)

    // Process through unified pipeline (using static import from top of file)
    const pipelineResult = transformOrientation(
      quatArray,
      tareState,
      {
        // If calibration offset exists, we could handle it here or post-multiply
        // For safety, we'll apply calibration offset manually after pipeline if needed below
      },
      segment,
    );

    // Extract the properly tared world quaternion
    result.worldQuat.copy(pipelineResult.q_world);

    if (shouldLog) {
      this.logEuler("pipeline.q_world", result.worldQuat);
      console.debug(
        `[OrientationProcessor] Applied levels:`,
        pipelineResult.appliedLevels,
      );
    }

    // NOTE: Legacy calibrationOffset support was removed. Old recordings with
    // broken orientation math are not supported - re-record with the fixed system.

    // =====================================================================
    // OUTPUT VALIDATION
    // =====================================================================
    // Ensure output is valid quaternion (catches any numerical instability)
    if (
      isNaN(result.worldQuat.w) ||
      isNaN(result.worldQuat.x) ||
      isNaN(result.worldQuat.y) ||
      isNaN(result.worldQuat.z)
    ) {
      console.error(
        `[OrientationProcessor] Output NaN detected for ${segment} - resetting to identity`,
      );
      result.worldQuat.set(0, 0, 0, 1);
    }

    // Re-normalize to prevent drift over time
    result.worldQuat.normalize();

    if (shouldLog) {
      console.groupEnd();
    }

    return result;
  }

  /**
   * Clamp an angle to a range, in radians.
   */
  private clampAngle(angle: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, angle));
  }

  /**
   * Apply ROM constraints to a local quaternion based on joint definition.
   * Uses ISB-compliant Euler orders per joint.
   *
   * SOFT CONSTRAINT MODE:
   * Instead of hard clamping (which causes discontinuities), we use a spring-like
   * soft constraint that gradually pulls angles back toward valid range.
   * This provides smoother motion while still preventing extreme poses.
   *
   * IN-PLACE MODIFICATION of localQuat to avoid allocation.
   */
  private applyROMConstraintsInPlace(
    localQuat: THREE.Quaternion,
    jointDef: JointDefinition,
    jointId: string,
    shouldLog: boolean,
  ): boolean {
    // Returns wasConstrained
    const DEG2RAD = Math.PI / 180;

    // Soft constraint parameters
    const SOFT_MARGIN = 10 * DEG2RAD; // Start applying spring force 10° before limit
    const SPRING_STIFFNESS = 0.3; // How aggressively to pull back (0-1)

    // Use ISB-compliant Euler order from JCS_EULER_ORDERS (no string matching)
    const eulerOrder = JCS_EULER_ORDERS[jointId] || "ZXY";

    // Use reusable Euler
    this._tempEuler.setFromQuaternion(
      localQuat,
      eulerOrder as THREE.EulerOrder,
    );

    let wasConstrained = false;

    // Save original for logging if needed
    let originalZ = 0;
    if (shouldLog) {
      originalZ = this._tempEuler.z;
    }

    // Map Euler axes to semantic angles based on order
    // ZXY: X=Flexion, Z=Abduction, Y=Rotation
    // XZY: X=Flexion (lateral for spine), Z=Abduction (axial), Y=Rotation (flex/ext)
    // YXZ: Y=Flexion, X=Abduction, Z=Rotation (Shoulder convention varies)

    let flexion = 0,
      abduction = 0,
      rotation = 0;

    if (eulerOrder === "ZXY" || eulerOrder === "XZY") {
      flexion = this._tempEuler.x;
      abduction = this._tempEuler.z;
      rotation = this._tempEuler.y;
    } else {
      // YXZ
      flexion = this._tempEuler.y;
      abduction = this._tempEuler.x;
      rotation = this._tempEuler.z;
    }

    // Apply SOFT constraints instead of hard clamping
    const clampedFlexion = this.softClampAngle(
      flexion,
      jointDef.flexionRange[0] * DEG2RAD,
      jointDef.flexionRange[1] * DEG2RAD,
      SOFT_MARGIN,
      SPRING_STIFFNESS,
    );
    const clampedAbduction = this.softClampAngle(
      abduction,
      jointDef.abductionRange[0] * DEG2RAD,
      jointDef.abductionRange[1] * DEG2RAD,
      SOFT_MARGIN,
      SPRING_STIFFNESS,
    );
    const clampedRotation = this.softClampAngle(
      rotation,
      jointDef.rotationRange[0] * DEG2RAD,
      jointDef.rotationRange[1] * DEG2RAD,
      SOFT_MARGIN,
      SPRING_STIFFNESS,
    );

    if (
      Math.abs(clampedFlexion - flexion) > 0.0001 ||
      Math.abs(clampedAbduction - abduction) > 0.0001 ||
      Math.abs(clampedRotation - rotation) > 0.0001
    ) {
      wasConstrained = true;

      // Write back to Euler
      if (eulerOrder === "ZXY" || eulerOrder === "XZY") {
        this._tempEuler.x = clampedFlexion;
        this._tempEuler.z = clampedAbduction;
        this._tempEuler.y = clampedRotation;
      } else {
        // YXZ
        this._tempEuler.y = clampedFlexion;
        this._tempEuler.x = clampedAbduction;
        this._tempEuler.z = clampedRotation;
      }

      // Update Quaternion from constrained Euler
      localQuat.setFromEuler(this._tempEuler);
    }

    if (wasConstrained && shouldLog) {
      const r2d = (rad: number) => ((rad * 180) / Math.PI).toFixed(1);
      console.debug(
        `[ROM] ${jointDef.name} soft constrained: Before F=${r2d(originalZ)}°`,
      );
    }

    return wasConstrained;
  }

  /**
   * Soft clamp angle using spring-like behavior.
   * Instead of hard clamping at the boundary, this function gradually
   * pulls the angle back toward the valid range, providing smooth motion.
   *
   * @param angle Current angle in radians
   * @param min Minimum valid angle in radians
   * @param max Maximum valid angle in radians
   * @param margin Soft zone margin (start pulling back before reaching limit)
   * @param stiffness Spring stiffness (0-1, higher = more aggressive)
   */
  private softClampAngle(
    angle: number,
    min: number,
    max: number,
    margin: number,
    stiffness: number,
  ): number {
    // Soft lower bound
    const softMin = min + margin;
    const softMax = max - margin;

    if (angle < softMin) {
      // In soft zone or past limit
      if (angle < min) {
        // Past hard limit - apply strong correction
        const overshoot = min - angle;
        return min - overshoot * (1 - stiffness);
      } else {
        // In soft zone - gentle pull toward soft boundary
        const depth = softMin - angle;
        const pullStrength = (depth / margin) * stiffness;
        return angle + depth * pullStrength;
      }
    } else if (angle > softMax) {
      // In soft zone or past limit
      if (angle > max) {
        // Past hard limit - apply strong correction
        const overshoot = angle - max;
        return max + overshoot * (1 - stiffness);
      } else {
        // In soft zone - gentle pull toward soft boundary
        const depth = angle - softMax;
        const pullStrength = (depth / margin) * stiffness;
        return angle - depth * pullStrength;
      }
    }

    return angle; // Within valid range
  }

  applyToBone(
    bone: THREE.Bone,
    processedQuat: THREE.Quaternion,
    neutralQuat?: THREE.Quaternion,
    segmentId?: string,
  ): void {
    const isDebug = this.debugSegment === segmentId;
    const shouldLog = isDebug && this.logCounter % 60 === 0;

    // Throttled tare-debug logging removed (was window.__TARE_DEBUG gated)

    if (!bone.parent) {
      // Root bone: World orientation is local orientation
      // Use temp to avoid modifying processedQuat input (though it's likely safe)
      this._tempQuat1.copy(processedQuat);

      // HEMISPHERE CHECK
      if (bone.quaternion.dot(this._tempQuat1) < 0) {
        this._tempQuat1.x = -this._tempQuat1.x;
        this._tempQuat1.y = -this._tempQuat1.y;
        this._tempQuat1.z = -this._tempQuat1.z;
        this._tempQuat1.w = -this._tempQuat1.w;
      }

      bone.quaternion.copy(this._tempQuat1);
      if (shouldLog) {
        this.logEuler("4. Root Final", this._tempQuat1);
        console.groupEnd();
      }
      return;
    }

    // Recalculate parent world properties safely
    // Force update of parent matrix to ensure we have the very latest transforms
    // (Solves issue where Hips update doesn't propagate to Thigh calculation in same frame)
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(this._parentWorld);

    // Calculate Parent Inverse
    this._parentInv.copy(this._parentWorld).invert();

    if (shouldLog) this.logEuler("4. ParentWorld", this._parentWorld);

    // Transform World orientation to Parent-Local Frame
    // local = parentInv * world
    // We use _tempQuat1 for localQuat
    this._tempQuat1.copy(this._parentInv).multiply(processedQuat);

    if (shouldLog)
      this.logEuler("5. LocalQuat (before constraints)", this._tempQuat1);

    // ROM CONSTRAINT ENFORCEMENT
    // Apply constraints to the DEVIATION from neutral pose, not absolute local quaternion.
    // This prevents A-pose (180°) from triggering constraint violations.
    if (segmentId && neutralQuat) {
      const jointId = SEGMENT_TO_JOINT[segmentId];
      if (jointId) {
        const jointDef = JOINT_DEFINITIONS[jointId];
        if (jointDef) {
          // Step 1: Compute delta from neutral pose
          // deltaQuat = localQuat * neutralQuat.inverse()
          this._tempQuat2.copy(neutralQuat).invert();
          this._tempQuat2.premultiply(this._tempQuat1); // tempQuat2 = localQuat * neutralInv

          // Step 2: Apply SOFT ROM constraints to the delta
          // Re-enabled with spring-based soft constraints for smoother motion
          const wasConstrained = this.applyROMConstraintsInPlace(
            this._tempQuat2,
            jointDef,
            jointId,
            shouldLog,
          );

          // Step 3: Recompose if constrained
          // constrainedLocal = constrainedDelta * neutralQuat
          if (wasConstrained) {
            this._tempQuat1.copy(this._tempQuat2).multiply(neutralQuat);
            if (shouldLog)
              this.logEuler(
                "5b. LocalQuat (after soft ROM constraints)",
                this._tempQuat1,
              );
          }
        }
      }
    }

    // HEMISPHERE CHECK
    if (bone.quaternion.dot(this._tempQuat1) < 0) {
      this._tempQuat1.x = -this._tempQuat1.x;
      this._tempQuat1.y = -this._tempQuat1.y;
      this._tempQuat1.z = -this._tempQuat1.z;
      this._tempQuat1.w = -this._tempQuat1.w;
    }

    if (shouldLog) this.logEuler("6. LocalQuat (final)", this._tempQuat1);

    // Final assignment
    bone.quaternion.copy(this._tempQuat1);
  }
}

export const orientationProcessor = new OrientationProcessor();

// Expose to window for console debugging (development only)
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).orientationProcessor =
    orientationProcessor;
}
