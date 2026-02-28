/**
 * Joint Angles Store - Real-time tracking of joint angles with min/max ROM.
 */

import { create } from "zustand";
import * as THREE from "three";
import type { JointAngles } from "../biomech/jointAngles";
import {
  JOINT_DEFINITIONS,
  calculateJointAngle,
  clampAngle,
} from "../biomech/jointAngles";

interface JointAngleData {
  current: JointAngles;
  min: JointAngles;
  max: JointAngles;
  lastUpdated: number;
}

interface JointAnglesState {
  // Current angles for each joint
  jointData: Map<string, JointAngleData>;

  // Current segment orientations (processed, World Space)
  segmentQuaternions: Map<string, THREE.Quaternion>;

  // Whether tracking is active
  isTracking: boolean;

  // Update counter to force React re-renders (Map changes don't trigger shallow equality)
  updateCounter: number;

  // Actions
  updateJointAngles: (
    segmentQuaternions: Map<string, THREE.Quaternion>,
  ) => void;
  resetMinMax: () => void;
  startTracking: () => void;
  stopTracking: () => void;

  // Getters
  getJointAngle: (jointId: string) => JointAngleData | null;
  getSegmentQuaternion: (segmentId: string) => THREE.Quaternion | null;
}

const createEmptyAngles = (): JointAngles => ({
  flexion: 0,
  abduction: 0,
  rotation: 0,
});

const createEmptyJointData = (): JointAngleData => ({
  current: createEmptyAngles(),
  min: { flexion: Infinity, abduction: Infinity, rotation: Infinity },
  max: { flexion: -Infinity, abduction: -Infinity, rotation: -Infinity },
  lastUpdated: 0,
});

export const useJointAnglesStore = create<JointAnglesState>((set, get) => ({
  jointData: new Map(),
  segmentQuaternions: new Map(),
  isTracking: false,
  updateCounter: 0,

  updateJointAngles: (segmentQuaternions: Map<string, THREE.Quaternion>) => {
    if (!get().isTracking) return;

    // Store the raw segment data for visualization consumers (SkeletonModel)
    // We clone the map to ensure reference stability if needed, or just replace it
    // Since KinematicsEngine creates a new Map each frame, we can just store it.

    const now = Date.now();
    const currentData = get().jointData;
    const newData = new Map<string, JointAngleData>();

    for (const [jointId, definition] of Object.entries(JOINT_DEFINITIONS)) {
      // Handle special 'world' parent (identity quaternion for global orientation)
      const parentQuat =
        definition.parentSegment === "world"
          ? new THREE.Quaternion() // Identity = world reference
          : segmentQuaternions.get(definition.parentSegment);
      const childQuat = segmentQuaternions.get(definition.childSegment);

      if (parentQuat && childQuat) {
        // Calculate joint angle using ISB JCS decomposition
        const angles = calculateJointAngle(parentQuat, childQuat, jointId);

        // Apply anatomical offsets if defined (correct for model bone orientations)
        if (definition.flexionOffset) {
          angles.flexion = angles.flexion + definition.flexionOffset;
        }
        if (definition.abductionOffset) {
          angles.abduction = angles.abduction + definition.abductionOffset;
        }
        if (definition.rotationOffset) {
          angles.rotation = angles.rotation + definition.rotationOffset;
        }

        // Clamp angles to ±180° range
        angles.flexion = clampAngle(angles.flexion);
        angles.abduction = clampAngle(angles.abduction);
        angles.rotation = clampAngle(angles.rotation);

        // Get existing data or create new
        const existing = currentData.get(jointId) || createEmptyJointData();

        // Update min/max
        const min: JointAngles = {
          flexion: Math.min(existing.min.flexion, angles.flexion),
          abduction: Math.min(existing.min.abduction, angles.abduction),
          rotation: Math.min(existing.min.rotation, angles.rotation),
        };

        const max: JointAngles = {
          flexion: Math.max(existing.max.flexion, angles.flexion),
          abduction: Math.max(existing.max.abduction, angles.abduction),
          rotation: Math.max(existing.max.rotation, angles.rotation),
        };

        newData.set(jointId, {
          current: angles,
          min,
          max,
          lastUpdated: now,
        });
      }
    }

    // Note: With T2 sensor, thoracic is measured directly (torso → spine_upper)
    // No estimation needed when SPINE_UPPER sensor is assigned

    // CRITICAL: Store raw segment quaternions for SkeletonModel playback consumption
    set({
      jointData: newData,
      segmentQuaternions: segmentQuaternions,
      updateCounter: get().updateCounter + 1,
    });
  },

  resetMinMax: () => {
    const currentData = get().jointData;
    const resetData = new Map<string, JointAngleData>();

    currentData.forEach((data, jointId) => {
      resetData.set(jointId, {
        ...data,
        min: { ...data.current },
        max: { ...data.current },
      });
    });

    set({ jointData: resetData });
    console.debug("[JointAngles] Min/Max reset");
  },

  startTracking: () => {
    set({ isTracking: true });
    console.debug("[JointAngles] Tracking started");
  },

  stopTracking: () => {
    set({ isTracking: false });
    console.debug("[JointAngles] Tracking stopped");
  },

  getJointAngle: (jointId: string): JointAngleData | null => {
    return get().jointData.get(jointId) || null;
  },

  getSegmentQuaternion: (segmentId: string) => {
    return get().segmentQuaternions.get(segmentId) || null;
  },
}));
