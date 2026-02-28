/**
 * SkeletonLoader - GLTF Model Loading and Bone Extraction
 * ========================================================
 *
 * Extracted from SkeletonModel.tsx for testability and reusability.
 *
 * This module handles:
 *   - Extracting bones from a Three.js model
 *   - Capturing neutral (T-pose) quaternions
 *   - Computing world-space target poses for calibration
 *
 * @module skeleton/SkeletonLoader
 */

import * as THREE from "three";

// ============================================================================
// TYPES
// ============================================================================

export interface SkeletonBones {
  /** Map of bone name → bone object */
  bonesMap: Map<string, THREE.Bone>;
  /** Map of bone name → neutral (T-pose) quaternion in local space */
  neutralQuats: Map<string, THREE.Quaternion>;
}

export interface TargetPoseOptions {
  /** Segment ID to bone name mapping */
  segmentToBone: Record<string, string>;
  /** Whether to log debug info */
  enableLogging?: boolean;
}

// ============================================================================
// EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Extract all bones and their neutral quaternions from a Three.js model.
 *
 * This traverses the model hierarchy and captures:
 * - All Bone objects by name
 * - Their initial (T-pose) quaternions
 *
 * @param model - The Three.js model (typically cloned from GLTF)
 * @param enableLogging - Whether to log foot bone info for debugging
 * @returns Bones map and neutral quaternions
 */
export function extractBonesFromModel(
  model: THREE.Object3D,
  enableLogging: boolean = false,
): SkeletonBones {
  const bonesMap = new Map<string, THREE.Bone>();
  const neutralQuats = new Map<string, THREE.Quaternion>();

  model.traverse((object) => {
    if (object instanceof THREE.Bone) {
      bonesMap.set(object.name, object);

      // Store initial T-pose rotation
      neutralQuats.set(object.name, object.quaternion.clone());

      // Debug logging for foot bones removed (per-bone spam)
    }
  });

  if (enableLogging) {
    console.debug(`[SkeletonLoader] Extracted ${bonesMap.size} bones`);

    // Log hierarchy for pelvis and children
    const pelvis = bonesMap.get("mixamorig1Hips");
    if (pelvis) {
      console.debug(`[SkeletonLoader] Pelvis hierarchy:`);
      pelvis.children.forEach((child) => {
        console.debug(
          `  - ${pelvis.name} → ${child.name} (isBone: ${child instanceof THREE.Bone})`,
        );
      });
    }
  }

  return { bonesMap, neutralQuats };
}

/**
 * Compute world-space target quaternions for calibration.
 *
 * The calibration system needs world-frame orientations since sensors
 * deliver world-frame data. This function computes the world quaternion
 * for each segment's bone.
 *
 * @param bonesMap - Map of bone name → bone object
 * @param options - Segment mapping and logging options
 * @returns Map of segment ID → world quaternion
 */
export function computeTargetPose(
  bonesMap: Map<string, THREE.Bone>,
  options: TargetPoseOptions,
): Map<string, THREE.Quaternion> {
  const { segmentToBone, enableLogging = false } = options;
  const poseMap = new Map<string, THREE.Quaternion>();

  Object.entries(segmentToBone).forEach(([segmentId, boneName]) => {
    const bone = bonesMap.get(boneName);
    if (bone) {
      // Use WORLD bone quaternion (T-pose orientation in world space)
      const worldQuat = new THREE.Quaternion();
      bone.getWorldQuaternion(worldQuat);
      poseMap.set(segmentId, worldQuat);

      if (enableLogging) {
        // Per-bone target pose logging removed (excessive per-segment spam)
      }
    }
  });

  return poseMap;
}

/**
 * Log bone world positions for debugging.
 *
 * @param bonesMap - Map of bone name → bone object
 * @param boneTargetOffsets - Configuration with boneName for each role
 */
export function logBonePositions(
  bonesMap: Map<string, THREE.Bone>,
  boneTargetOffsets: Record<string, { boneName: string; offset: number[] }>,
): void {
  Object.entries(boneTargetOffsets).forEach(([role, config]) => {
    const bone = bonesMap.get(config.boneName);
    if (bone) {
      const worldPos = new THREE.Vector3();
      bone.getWorldPosition(worldPos);
      // Bone position logging removed (per-bone spam)
    }
  });
}

/**
 * Get a specific bone by segment ID.
 *
 * @param bonesMap - Map of bone name → bone object
 * @param segment - Segment ID (e.g., 'pelvis', 'thigh_l')
 * @param segmentToBone - Segment to bone name mapping
 * @returns The bone, or undefined if not found
 */
export function getBoneForSegment(
  bonesMap: Map<string, THREE.Bone>,
  segment: string,
  segmentToBone: Record<string, string>,
): THREE.Bone | undefined {
  const boneName = segmentToBone[segment];
  return boneName ? bonesMap.get(boneName) : undefined;
}
