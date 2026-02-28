/**
 * Animation ROM Cache - Pre-computes joint angles for each animation.
 * Since animation loops are deterministic, we sample once and cache forever.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  calculateAllJointAngles,
  type JointAngles,
} from "../biomech/jointAngles";

// Bone names for joint angle extraction
const SEGMENT_TO_BONE: Record<string, string> = {
  pelvis: "mixamorig1Hips",
  thigh_l: "mixamorig1LeftUpLeg",
  thigh_r: "mixamorig1RightUpLeg",
  tibia_l: "mixamorig1LeftLeg",
  tibia_r: "mixamorig1RightLeg",
  foot_l: "mixamorig1LeftFoot",
  foot_r: "mixamorig1RightFoot",
};

export interface CachedROMFrame {
  time: number; // Normalized 0-1
  joints: Record<string, JointAngles>;
}

export interface AnimationROMCache {
  animationId: string;
  duration: number;
  fps: number;
  frames: CachedROMFrame[];
}

// In-memory cache
const romCacheMap = new Map<string, AnimationROMCache>();

/**
 * Pre-compute ROM data for an animation by stepping through it offline.
 */
export async function precomputeAnimationROM(
  animationId: string,
  animationFile: string,
  fps: number = 30,
): Promise<AnimationROMCache> {
  // Check cache first
  if (romCacheMap.has(animationId)) {
    return romCacheMap.get(animationId)!;
  }

  console.debug(`[ROMCache] Pre-computing: ${animationId}`);

  // Load base model and animation
  const loader = new GLTFLoader();

  const [baseGltf, animGltf] = await Promise.all([
    new Promise<any>((resolve, reject) =>
      loader.load("/models/Neutral_Model.glb", resolve, undefined, reject),
    ),
    new Promise<any>((resolve, reject) =>
      loader.load(animationFile, resolve, undefined, reject),
    ),
  ]);

  if (!animGltf.animations?.length) {
    throw new Error(`No animations in ${animationFile}`);
  }

  const clip = animGltf.animations[0];
  const duration = clip.duration;
  const numFrames = Math.ceil(duration * fps);

  // Build bone map
  const boneMap = new Map<string, THREE.Bone>();
  baseGltf.scene.traverse((obj: THREE.Object3D) => {
    if (obj instanceof THREE.Bone) {
      boneMap.set(obj.name, obj);
    }
  });

  // Create mixer and action
  const mixer = new THREE.AnimationMixer(baseGltf.scene);
  const action = mixer.clipAction(clip);
  action.play();

  // Sample each frame
  const frames: CachedROMFrame[] = [];

  for (let i = 0; i <= numFrames; i++) {
    const t = (i / numFrames) * duration;
    const normalizedTime = i / numFrames;

    // Advance mixer to this time
    mixer.setTime(t);
    mixer.update(0);

    // Extract bone quaternions
    const segmentQuats = new Map<string, THREE.Quaternion>();
    for (const [segment, boneName] of Object.entries(SEGMENT_TO_BONE)) {
      const bone = boneMap.get(boneName);
      if (bone) {
        const worldQuat = new THREE.Quaternion();
        bone.getWorldQuaternion(worldQuat);
        segmentQuats.set(segment, worldQuat);
      }
    }

    // Calculate joint angles
    const jointAnglesMap = calculateAllJointAngles(segmentQuats);

    // Convert Map to plain object for storage
    const jointAngles: Record<string, JointAngles> = {};
    jointAnglesMap.forEach((angles, jointId) => {
      jointAngles[jointId] = angles;
    });

    frames.push({
      time: normalizedTime,
      joints: jointAngles,
    });
  }

  const cache: AnimationROMCache = {
    animationId,
    duration,
    fps,
    frames,
  };

  romCacheMap.set(animationId, cache);
  console.debug(
    `[ROMCache] Cached ${animationId}: ${frames.length} frames @ ${fps}fps`,
  );

  return cache;
}

/**
 * Get ROM data for a specific time in a cached animation.
 * Uses linear interpolation between frames.
 */
export function getCachedROMAtTime(
  cache: AnimationROMCache,
  normalizedTime: number,
): Record<string, JointAngles> {
  // Clamp and wrap
  const t = normalizedTime % 1;

  // Find surrounding frames
  const frameIndex = t * (cache.frames.length - 1);
  const lowerIdx = Math.floor(frameIndex);
  const upperIdx = Math.min(lowerIdx + 1, cache.frames.length - 1);
  const blend = frameIndex - lowerIdx;

  const lowerFrame = cache.frames[lowerIdx];
  const upperFrame = cache.frames[upperIdx];

  // Interpolate between frames
  const result: Record<string, JointAngles> = {};

  for (const jointId of Object.keys(lowerFrame.joints)) {
    const lower = lowerFrame.joints[jointId];
    const upper = upperFrame.joints[jointId];

    result[jointId] = {
      flexion: lower.flexion + (upper.flexion - lower.flexion) * blend,
      abduction: lower.abduction + (upper.abduction - lower.abduction) * blend,
      rotation: lower.rotation + (upper.rotation - lower.rotation) * blend,
    };
  }

  return result;
}

/**
 * Check if an animation is cached.
 */
export function isAnimationCached(animationId: string): boolean {
  return romCacheMap.has(animationId);
}

/**
 * Get cached ROM data (or undefined if not cached).
 */
export function getAnimationCache(
  animationId: string,
): AnimationROMCache | undefined {
  return romCacheMap.get(animationId);
}
