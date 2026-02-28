/**
 * Sensor Mounting Store
 * =====================
 *
 * Stores per-sensor mounting rotations to correct for physical sensor orientation.
 *
 * When a sensor is mounted at an angle (e.g., 45° rotated on the shin), this
 * rotation offset is applied BEFORE the calibration offset to align the sensor's
 * coordinate frame with the expected anatomical orientation.
 *
 * Flow:
 *   sensor_raw → mounting_rotation → firmwareToThreeQuat → calibration_offset → bone
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as THREE from "three";

// ============================================================================
// TYPES
// ============================================================================

export interface MountingRotation {
  /** Euler angles in degrees for easier UI editing */
  eulerDegrees: [number, number, number];
  /** Pre-computed quaternion */
  quaternion: THREE.Quaternion;
  /** When this was set */
  setAt: number;
  /** Optional notes */
  notes?: string;
}

interface MountingRotationState {
  /** Per-sensor mounting rotations */
  rotations: Map<string, MountingRotation>;

  // Actions
  setMountingRotation: (
    sensorId: string,
    eulerDegrees: [number, number, number],
    notes?: string,
  ) => void;
  clearMountingRotation: (sensorId: string) => void;
  clearAll: () => void;

  // Getters
  getMountingRotation: (sensorId: string) => THREE.Quaternion | null;
  getMountingEuler: (sensorId: string) => [number, number, number] | null;
}

// ============================================================================
// STORE IMPLEMENTATION
// ============================================================================

export const useMountingRotationStore = create<MountingRotationState>()(
  persist(
    (set, get) => ({
      rotations: new Map(),

      setMountingRotation: (sensorId, eulerDegrees, notes) => {
        const euler = new THREE.Euler(
          eulerDegrees[0] * (Math.PI / 180),
          eulerDegrees[1] * (Math.PI / 180),
          eulerDegrees[2] * (Math.PI / 180),
          "XYZ",
        );
        const quaternion = new THREE.Quaternion().setFromEuler(euler);

        set((state) => {
          const newRotations = new Map(state.rotations);
          newRotations.set(sensorId, {
            eulerDegrees,
            quaternion,
            setAt: Date.now(),
            notes,
          });
          return { rotations: newRotations };
        });

        console.debug(
          `[MountingStore] Set mounting rotation for ${sensorId}: [${eulerDegrees.join(", ")}]°`,
        );
      },

      clearMountingRotation: (sensorId) => {
        set((state) => {
          const newRotations = new Map(state.rotations);
          newRotations.delete(sensorId);
          return { rotations: newRotations };
        });
      },

      clearAll: () => {
        set({ rotations: new Map() });
      },

      getMountingRotation: (sensorId) => {
        const rotation = get().rotations.get(sensorId);
        return rotation ? rotation.quaternion.clone() : null;
      },

      getMountingEuler: (sensorId) => {
        const rotation = get().rotations.get(sensorId);
        return rotation ? rotation.eulerDegrees : null;
      },
    }),
    {
      name: "imu-mounting-rotations",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        rotations: Array.from(state.rotations.entries()).map(([k, v]) => ({
          sensorId: k,
          eulerDegrees: v.eulerDegrees,
          notes: v.notes,
          setAt: v.setAt,
        })),
      }),
      merge: (persisted: unknown, current) => {
        const typed = persisted as
          | {
              rotations?: {
                sensorId: string;
                eulerDegrees: [number, number, number];
                notes?: string;
                setAt: number;
              }[];
            }
          | undefined;
        if (!typed || !typed.rotations) return current;

        const rotations = new Map<string, MountingRotation>();
        for (const item of typed.rotations) {
          const euler = new THREE.Euler(
            item.eulerDegrees[0] * (Math.PI / 180),
            item.eulerDegrees[1] * (Math.PI / 180),
            item.eulerDegrees[2] * (Math.PI / 180),
            "XYZ",
          );
          rotations.set(item.sensorId, {
            eulerDegrees: item.eulerDegrees,
            quaternion: new THREE.Quaternion().setFromEuler(euler),
            setAt: item.setAt,
            notes: item.notes,
          });
        }

        return { ...current, rotations };
      },
    },
  ),
);

// Mounting presets removed - calibration handles orientation automatically
