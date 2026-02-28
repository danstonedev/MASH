/**
 * OrientationPipeline - PhD-Level Complete Orientation Transformation
 * ====================================================================
 *
 * This module provides the COMPLETE transformation pipeline from raw sensor
 * quaternion to clinical-grade joint angles. Every transformation level is
 * explicitly documented and applied in sequence.
 *
 * TRANSFORMATION HIERARCHY:
 *
 *   Level 0: Coordinate Frame Conversion (IMU → Three.js)
 *       q_threejs = firmwareToThreeQuat(q_raw)
 *
 *   Level 1: Mounting Tare (Sensor → Bone alignment)
 *       q_bone = q_threejs × q_mounting
 *       Corrects for how the sensor is physically attached to the limb
 *
 *   Level 2: Heading Tare (Boresighting)
 *       q_world = q_heading⁻¹ × q_bone
 *       Removes yaw offset so user's forward = world forward
 *
 *   Level 3: Joint Tare (Clinical Zero)
 *       θ_clinical = θ_measured - θ_offset
 *       Defines current posture as the clinical reference
 *
 * USAGE:
 *   const result = transformOrientation(rawQuat, tareState);
 *   bone.quaternion.copy(result.q_world);
 *
 * @module OrientationPipeline
 */

import * as THREE from "three";
// NOTE: firmwareToThreeQuat removed - firmware now sends Y-up frame directly
import type {
  TareState,
  JointAngleOffsets,
} from "../../calibration/taringPipeline";
import {
  applyMountingTare,
  applyHeadingTare,
  applyJointTare,
  applyFrameAlignment,
} from "../../calibration/taringPipeline";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Complete result from orientation pipeline
 */
export interface OrientationResult {
  /** Level 0: Raw quaternion converted to Three.js frame */
  q_sensor: THREE.Quaternion;

  /** Level 1: After mounting tare (bone-aligned) */
  q_bone: THREE.Quaternion;

  /** Level 2: After heading tare (world-aligned) */
  q_world: THREE.Quaternion;

  /** Euler angles from q_world (XYZ order) */
  eulerAngles: THREE.Euler;

  /** Level 3: Clinical joint angles (if parent provided) */
  jointAngles?: {
    flexion: number;
    abduction: number;
    rotation: number;
  };

  /** Debug info about which levels were applied */
  appliedLevels: {
    mountingTare: boolean;
    headingTare: boolean;
    jointTare: boolean;
  };
}

/**
 * Options for orientation transformation
 */
export interface OrientationOptions {
  /** Parent segment quaternion for computing relative joint angles */
  parentQuat?: THREE.Quaternion;

  /** Parent segment's tare state for proper joint angle computation */
  parentTareState?: TareState;

  /** If true, apply soft anatomical constraints */
  applyConstraints?: boolean;

  /** If true, reflect the X-axis of the sensor quaternion (Fixes Reversed Pitch) */
  reflectX?: boolean;
}

// ============================================================================
// DEFAULT TARE STATE
// ============================================================================

/**
 * Identity tare state (no corrections applied)
 */
export function createIdentityTareState(): TareState {
  return {
    mountingTare: new THREE.Quaternion(),
    headingTare: new THREE.Quaternion(),
    jointTare: { flexion: 0, abduction: 0, rotation: 0 },
    mountingTareTime: 0,
    headingTareTime: 0,
    jointTareTime: 0,
  };
}

// ============================================================================
// THROTTLED DEBUG LOGGING
// ============================================================================

/**
 * Per-segment throttle tracker for pipeline debug logs.
 * Enable via browser console: window.__TARE_DEBUG = true
 * Filter in console with: [Pipeline]
 */

// ============================================================================
// MAIN TRANSFORMATION FUNCTION
// ============================================================================

/**
 * Transform raw sensor quaternion through complete orientation pipeline.
 *
 * @param rawQuat Raw quaternion from sensor [w, x, y, z] or [x, y, z, w]
 * @param tareState Tare state for this segment (or null for identity)
 * @param options Additional transformation options
 * @returns Complete orientation result with all levels
 */
export function transformOrientation(
  rawQuat: [number, number, number, number],
  tareState: TareState | null | undefined,
  options: OrientationOptions = {},
  segmentId: string = "unknown",
): OrientationResult {
  const state = tareState || createIdentityTareState();

  const appliedLevels = {
    coordinateConversion: false,
    mountingTare: false,
    headingTare: false,
    jointTare: false,
  };

  // ========================================================================
  // INPUT VALIDATION
  // ========================================================================
  // Check for NaN values in input quaternion - return identity if invalid
  if (rawQuat.some((v) => isNaN(v) || !isFinite(v))) {
    console.warn(
      "[OrientationPipeline] Invalid input quaternion (NaN/Infinity detected)",
    );
    return {
      q_sensor: new THREE.Quaternion(),
      q_bone: new THREE.Quaternion(),
      q_world: new THREE.Quaternion(),
      eulerAngles: new THREE.Euler(),
      appliedLevels,
    };
  }

  // ========================================================================
  // LEVEL 0: Array → THREE.Quaternion Format Conversion
  // ========================================================================
  // Firmware outputs Y-up quaternions (converted at sensor read time).
  // NO coordinate conversion here - just array format to THREE object.
  // Input: [w, x, y, z] array
  // Output: THREE.Quaternion(x, y, z, w) object
  const [w, x, y, z] = rawQuat;
  let q_sensor = new THREE.Quaternion(x, y, z, w);

  // VISUAL FRAME MAPPING (Hardware Adaptation)
  // The Firmware sends consistent Rigid Body Physics data.
  // We apply any final visual frame adjustments here if necessary.
  // currently 1:1 map
  // q_sensor.x = -q_sensor.x;
  // q_sensor.y = -q_sensor.y;

  // REFLECTION (Chirality Fix)
  // If needed, reflect the X-axis to fix Pitch Reversal without affecting Face/Roll
  if (options.reflectX) {
    // Reflecting X-axis of rotation: x -> -x
    q_sensor.x = -q_sensor.x;
  }

  // ========================================================================
  // LEVEL 1: Mounting Tare (Sensor → Bone) - APPLIED FIRST
  // ========================================================================
  // Corrects for physical sensor placement on the limb
  // q_bone = q_sensor × q_mounting
  // This must be applied BEFORE frame alignment so we zero in sensor frame first

  let q_bone: THREE.Quaternion;

  if (state.mountingTareTime > 0) {
    // Mounting tare has been captured - apply in sensor frame
    q_bone = applyMountingTare(q_sensor, state.mountingTare);
    appliedLevels.mountingTare = true;
  } else {
    // No mounting tare - pass through
    q_bone = q_sensor.clone();
  }

  // ========================================================================
  // Frame Alignment (Sensor Axes → Anatomical Axes) - APPLIED SECOND
  // ========================================================================
  // Applies RIGHT multiplication: q_aligned = q_bone × frameAlignment
  //
  // For cervical calibration, frameAlignment = inv(R) where R = PCA axis alignment.
  // Combined with headingTare providing R × inv(q_cal) from the left, this implements
  // the full similarity transform: q_world = R × inv(q_cal) × q_sensor × inv(R)
  //
  // At neutral pose: q_world = R × inv(q_cal) × q_cal × inv(R) = identity ✓

  if (
    state.frameAlignment &&
    state.frameAlignmentTime &&
    state.frameAlignmentTime > 0
  ) {
    q_bone = applyFrameAlignment(q_bone, state.frameAlignment);
  }

  // ========================================================================
  // LEVEL 2: Heading Tare (Boresighting)
  // ========================================================================
  // Removes yaw offset so user's forward direction = world forward
  // q_world = q_heading⁻¹ × q_bone

  let q_world: THREE.Quaternion;

  if (state.headingTareTime > 0) {
    // Heading tare has been captured
    q_world = applyHeadingTare(q_bone, state.headingTare);
    appliedLevels.headingTare = true;
  } else {
    // No heading tare - pass through
    q_world = q_bone.clone();
  }

  // ========================================================================
  // EULER ANGLES
  // ========================================================================
  const eulerAngles = new THREE.Euler().setFromQuaternion(q_world, "XYZ");

  // ========================================================================
  // LEVEL 3: Joint Angles (Clinical Zero)
  // ========================================================================
  // Computes relative rotation between parent and child, then subtracts offset
  // θ_clinical = θ_measured - θ_offset

  let jointAngles:
    | { flexion: number; abduction: number; rotation: number }
    | undefined;

  if (options.parentQuat) {
    // Get parent's world quaternion
    let parentWorld = options.parentQuat.clone();

    // If parent has a tare state, apply it
    if (
      options.parentTareState &&
      options.parentTareState.headingTareTime > 0
    ) {
      parentWorld = applyHeadingTare(
        parentWorld,
        options.parentTareState.headingTare,
      );
    }

    // Compute relative rotation: q_rel = q_parent⁻¹ × q_child
    const parentInv = parentWorld.clone().invert();
    const q_relative = parentInv.multiply(q_world.clone());

    // Decompose to Euler angles in anatomical order (XYZ = Flex/Abd/Rot)
    const relEuler = new THREE.Euler().setFromQuaternion(q_relative, "XYZ");

    // Convert to degrees
    const measuredAngles: JointAngleOffsets = {
      flexion: relEuler.x * (180 / Math.PI),
      abduction: relEuler.z * (180 / Math.PI),
      rotation: relEuler.y * (180 / Math.PI),
    };

    // Apply Level 3 tare (clinical zero offset)
    if (state.jointTareTime > 0) {
      jointAngles = applyJointTare(measuredAngles, state.jointTare);
      appliedLevels.jointTare = true;
    } else {
      jointAngles = measuredAngles;
    }
  }

  return {
    q_sensor,
    q_bone,
    q_world,
    eulerAngles,
    jointAngles,
    appliedLevels,
  };
}

// ============================================================================
// BATCH TRANSFORMATION
// ============================================================================

/**
 * Transform multiple sensors at once, building a complete skeleton state.
 *
 * @param sensorData Map of segmentId → raw quaternion
 * @param tareStates Map of segmentId → tare state
 * @param parentMap Map of segmentId → parentSegmentId for joint angle computation
 * @returns Map of segmentId → OrientationResult
 */
export function transformSkeleton(
  sensorData: Map<string, [number, number, number, number]>,
  tareStates: Map<string, TareState>,
  parentMap?: Map<string, string>,
): Map<string, OrientationResult> {
  const results = new Map<string, OrientationResult>();

  // First pass: compute all bone/world orientations
  sensorData.forEach((rawQuat, segmentId) => {
    const tareState = tareStates.get(segmentId);
    const result = transformOrientation(rawQuat, tareState, {}, segmentId);
    results.set(segmentId, result);
  });

  // Second pass: compute joint angles using parent data
  if (parentMap) {
    sensorData.forEach((rawQuat, segmentId) => {
      const parentId = parentMap.get(segmentId);
      if (!parentId) return;

      const parentResult = results.get(parentId);
      if (!parentResult) return;

      // Re-compute with parent info for joint angles
      const tareState = tareStates.get(segmentId);
      const parentTareState = tareStates.get(parentId);

      const result = transformOrientation(
        rawQuat,
        tareState,
        {
          parentQuat: parentResult.q_bone, // Use bone (after L1) for relative
          parentTareState,
        },
        segmentId,
      );

      results.set(segmentId, result);
    });
  }

  return results;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if a tare state has any corrections applied.
 */
export function hasTareCorrections(
  state: TareState | null | undefined,
): boolean {
  if (!state) return false;
  return (
    state.mountingTareTime > 0 ||
    state.headingTareTime > 0 ||
    state.jointTareTime > 0
  );
}

/**
 * Get human-readable description of applied levels.
 */
export function describeTareState(state: TareState | null | undefined): string {
  if (!state) return "No tare state";

  const levels: string[] = [];
  if (state.mountingTareTime > 0) levels.push("L1:Mounting");
  if (state.headingTareTime > 0) levels.push("L2:Heading");
  if (state.jointTareTime > 0) levels.push("L3:Joint");

  return levels.length > 0 ? levels.join(" + ") : "Identity (no corrections)";
}
