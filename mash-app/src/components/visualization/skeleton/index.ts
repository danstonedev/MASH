/**
 * Skeleton Module - Barrel Export
 * ================================
 * 
 * This module contains extracted, testable components from the
 * original monolithic SkeletonModel.tsx.
 * 
 * Components:
 * - SkeletonLoader: GLTF model loading and bone extraction
 * - OrientationProcessor: IMU quaternion → bone orientation pipeline
 * - FloorGrounder: Skeleton foot-to-floor contact logic
 */

// Bone loading and extraction
export {
    extractBonesFromModel,
    computeTargetPose,
    logBonePositions,
    getBoneForSegment
} from './SkeletonLoader';
export type { SkeletonBones, TargetPoseOptions } from './SkeletonLoader';

// Core processors
export { OrientationProcessor, orientationProcessor } from './OrientationProcessor';
export type {
    OrientationPipelineOptions,
    OrientationResult
} from './OrientationProcessor';

export { FloorGrounder, floorGrounder } from './FloorGrounder';
export type {
    GroundingResult,
    GroundingOptions
} from './FloorGrounder';
