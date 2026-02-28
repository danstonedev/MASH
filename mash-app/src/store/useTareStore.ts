/**
 * Tare State Store - Global Management of Orientation Tares
 * ===========================================================
 *
 * Manages the 3-level taring hierarchy for all body segments:
 *   Level 1: Mounting Tare (sensor → bone alignment)
 *   Level 2: Heading Tare (boresighting)
 *   Level 3: Joint Tare (clinical zero)
 *
 * This store is accessed during:
 *   - Calibration (to capture tares)
 *   - Rendering (to apply tares)
 *   - Recording (to serialize tares)
 *   - Playback (to deserialize/apply tares)
 *
 * @module useTareStore
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as THREE from "three";
import type { TareState } from "../calibration/taringPipeline";
import {
  createDefaultTareState,
  computeMountingTare,
  computeHeadingTare,
  computeJointTare,
} from "../calibration/taringPipeline";

// ... (retain types and interface definitions)
// To save space in the prompt, I am keeping lines 29-138 as original (implied context) but I will check if I can just wrap the implementation.
// The user tool `replace_file_content` will work best if I target the implementation block.

// ...

export interface SerializedTareState {
  segmentId: string;
  mountingTare: [number, number, number, number];
  headingTare: [number, number, number, number];
  frameAlignment?: [number, number, number, number];
  jointTare: { flexion: number; abduction: number; rotation: number };
  mountingTareTime: number;
  headingTareTime: number;
  frameAlignmentTime?: number;
  jointTareTime: number;
}

interface TareStoreState {
  tareStates: Map<string, TareState>;
  globalHeadingReference: THREE.Quaternion | null;

  captureMountingTare: (
    segmentId: string,
    sensorQuat: THREE.Quaternion,
    targetBoneQuat: THREE.Quaternion,
  ) => void;
  captureHeadingTare: (segmentId: string, boneQuat: THREE.Quaternion) => void;
  captureGlobalHeadingTare: (
    segmentQuats: Map<string, THREE.Quaternion>,
  ) => void;
  captureJointTare: (
    segmentId: string,
    currentAngles: { flexion: number; abduction: number; rotation: number },
  ) => void;
  captureGlobalJointTare: (
    segmentAngles: Map<
      string,
      { flexion: number; abduction: number; rotation: number }
    >,
  ) => void;
  applyCalibrationResults: (
    results: Map<
      string,
      {
        offset: THREE.Quaternion;
        mountingTare?: THREE.Quaternion;
        headingTare?: THREE.Quaternion;
      }
    >,
    globalHeadingOffset?: number,
  ) => void;
  resetAll: () => void;
  getTareState: (segmentId: string) => TareState;
  hasTares: () => boolean;
  resetLevel: (level: 1 | 2 | 3) => void;
  serialize: () => SerializedTareState[];
  deserialize: (data: SerializedTareState[]) => void;
}

// ============================================================================
// STORE IMPLEMENTATION
// ============================================================================

export const useTareStore = create<TareStoreState>()(
  persist(
    (set, get) => ({
      tareStates: new Map(),
      globalHeadingReference: null,

      // ========================================================================
      // LEVEL 1: MOUNTING TARE
      // ========================================================================

      captureMountingTare: (segmentId, sensorQuat, targetBoneQuat) => {
        const result = computeMountingTare(sensorQuat, targetBoneQuat);

        if (result.success) {
          const current =
            get().tareStates.get(segmentId) || createDefaultTareState();
          const updated: TareState = {
            ...current,
            mountingTare: result.tare.clone(),
            mountingTareTime: Date.now(),
          };

          set((state) => ({
            tareStates: new Map(state.tareStates).set(segmentId, updated),
          }));

          console.debug(`[TareStore] L1 Mounting captured for ${segmentId}`);
        }
      },

      // ========================================================================
      // LEVEL 2: HEADING TARE
      // ========================================================================

      captureHeadingTare: (segmentId, boneQuat) => {
        const result = computeHeadingTare(boneQuat);

        if (result.success) {
          const current =
            get().tareStates.get(segmentId) || createDefaultTareState();
          const updated: TareState = {
            ...current,
            headingTare: result.tare.clone(),
            headingTareTime: Date.now(),
          };

          set((state) => ({
            tareStates: new Map(state.tareStates).set(segmentId, updated),
          }));

          console.debug(
            `[TareStore] L2 Heading captured for ${segmentId}: ${result.message}`,
          );
        }
      },

      captureGlobalHeadingTare: (segmentQuats) => {
        const now = Date.now();
        const newStates = new Map(get().tareStates);

        // Use pelvis (or first available) as the reference for global heading
        let referenceQuat =
          segmentQuats.get("pelvis") || segmentQuats.values().next().value;

        if (!referenceQuat) {
          console.warn(
            "[TareStore] No segments available for global heading tare",
          );
          return;
        }

        // Compute heading from reference
        const refResult = computeHeadingTare(referenceQuat);
        set({ globalHeadingReference: refResult.tare.clone() });

        // Apply same heading tare to ALL segments (ensures consistent world frame)
        segmentQuats.forEach((_, segmentId) => {
          const current = newStates.get(segmentId) || createDefaultTareState();
          newStates.set(segmentId, {
            ...current,
            headingTare: refResult.tare.clone(),
            headingTareTime: now,
          });
        });

        set({ tareStates: newStates });
        console.debug(
          `[TareStore] L2 Global Heading captured for ${segmentQuats.size} segments: ${refResult.message}`,
        );
      },

      // ========================================================================
      // LEVEL 3: JOINT TARE
      // ========================================================================

      captureJointTare: (segmentId, currentAngles) => {
        const jointOffset = computeJointTare(currentAngles);
        const current =
          get().tareStates.get(segmentId) || createDefaultTareState();

        const updated: TareState = {
          ...current,
          jointTare: jointOffset,
          jointTareTime: Date.now(),
        };

        set((state) => ({
          tareStates: new Map(state.tareStates).set(segmentId, updated),
        }));

        console.debug(
          `[TareStore] L3 Joint captured for ${segmentId}: flex=${jointOffset.flexion.toFixed(1)}°, abd=${jointOffset.abduction.toFixed(1)}°`,
        );
      },

      captureGlobalJointTare: (segmentAngles) => {
        const now = Date.now();
        const newStates = new Map(get().tareStates);

        segmentAngles.forEach((angles, segmentId) => {
          const current = newStates.get(segmentId) || createDefaultTareState();
          const jointOffset = computeJointTare(angles);

          newStates.set(segmentId, {
            ...current,
            jointTare: jointOffset,
            jointTareTime: now,
          });
        });

        set({ tareStates: newStates });
        console.debug(
          `[TareStore] L3 Global Joint captured for ${segmentAngles.size} segments`,
        );
      },

      applyCalibrationResults: (results, globalHeadingOffset = 0) => {
        const now = Date.now();
        const newStates = new Map(get().tareStates);

        console.debug(
          `%c[TareStore] ═══ APPLYING CALIBRATION RESULTS ═══`,
          "color: #00ff88; font-weight: bold",
        );
        console.debug(
          `[TareStore] Segments: ${results.size}, globalHeadingOffset: ${globalHeadingOffset.toFixed(3)} rad`,
        );

        // 1. Apply per-segment mountingTare (Level 1) and optional headingTare (Level 2).
        //    If result carries an explicit headingTare (two-layer GramSchmidt path), use it.
        //    Otherwise fall back to the legacy single-offset path.
        results.forEach((data, segmentId) => {
          const current = newStates.get(segmentId) || createDefaultTareState();
          const mountingTare = (data.mountingTare ?? data.offset).clone();
          console.debug(
            `[TareStore] L1 ${segmentId}: mountingTare=[${mountingTare.w.toFixed(3)}, ${mountingTare.x.toFixed(3)}, ${mountingTare.y.toFixed(3)}, ${mountingTare.z.toFixed(3)}]`,
          );

          const updated: TareState = {
            ...current,
            mountingTare,
            mountingTareTime: now,
          };

          if (data.headingTare) {
            updated.headingTare = data.headingTare.clone();
            updated.headingTareTime = now;
            console.debug(
              `[TareStore] L2 ${segmentId}: headingTare=[${data.headingTare.w.toFixed(3)}, ${data.headingTare.x.toFixed(3)}, ${data.headingTare.y.toFixed(3)}, ${data.headingTare.z.toFixed(3)}]`,
            );
          }

          newStates.set(segmentId, updated);
        });

        // 2. Apply Global Heading Correction (legacy path only).
        //    Segments that already received a per-segment headingTare are NOT overridden.
        if (globalHeadingOffset !== 0) {
          const headingTareAngle = -globalHeadingOffset;
          const globalTare = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            headingTareAngle,
          );

          console.debug(
            `[TareStore] L2 Global Heading: angle=${((headingTareAngle * 180) / Math.PI).toFixed(1)}°`,
          );

          newStates.forEach((state, segmentId) => {
            if (!results.get(segmentId)?.headingTare) {
              state.headingTare = globalTare.clone();
              state.headingTareTime = now;
            }
          });

          set({ globalHeadingReference: globalTare });
        }

        set({ tareStates: newStates });
        console.debug(
          `[TareStore] Applied calibration results to ${results.size} segments`,
        );
      },

      resetAll: () => {
        set({
          tareStates: new Map(),
          globalHeadingReference: null,
        });
        console.debug("[TareStore] Reset all tare states");
      },

      // ========================================================================
      // STATE ACCESS
      // ========================================================================

      getTareState: (segmentId) => {
        return get().tareStates.get(segmentId) || createDefaultTareState();
      },

      hasTares: () => {
        const states = get().tareStates;
        for (const state of states.values()) {
          if (
            state.mountingTareTime > 0 ||
            state.headingTareTime > 0 ||
            state.jointTareTime > 0
          ) {
            return true;
          }
        }
        return false;
      },

      resetLevel: (level) => {
        const newStates = new Map(get().tareStates);

        newStates.forEach((state, segmentId) => {
          const updated: TareState = { ...state };

          switch (level) {
            case 1:
              updated.mountingTare = new THREE.Quaternion();
              updated.mountingTareTime = 0;
              break;
            case 2:
              updated.headingTare = new THREE.Quaternion();
              updated.headingTareTime = 0;
              break;
            case 3:
              updated.jointTare = { flexion: 0, abduction: 0, rotation: 0 };
              updated.jointTareTime = 0;
              break;
          }

          newStates.set(segmentId, updated);
        });

        set({ tareStates: newStates });
        console.debug(`[TareStore] Level ${level} tares reset`);
      },

      // ========================================================================
      // SERIALIZATION
      // ========================================================================

      serialize: () => {
        const states = get().tareStates;
        const result: SerializedTareState[] = [];

        states.forEach((state, segmentId) => {
          const entry: SerializedTareState = {
            segmentId,
            mountingTare: [
              state.mountingTare.w,
              state.mountingTare.x,
              state.mountingTare.y,
              state.mountingTare.z,
            ],
            headingTare: [
              state.headingTare.w,
              state.headingTare.x,
              state.headingTare.y,
              state.headingTare.z,
            ],
            jointTare: { ...state.jointTare },
            mountingTareTime: state.mountingTareTime,
            headingTareTime: state.headingTareTime,
            jointTareTime: state.jointTareTime,
          };
          // Persist frameAlignment if present (cervical PCA calibration)
          if (
            state.frameAlignment &&
            state.frameAlignmentTime &&
            state.frameAlignmentTime > 0
          ) {
            entry.frameAlignment = [
              state.frameAlignment.w,
              state.frameAlignment.x,
              state.frameAlignment.y,
              state.frameAlignment.z,
            ];
            entry.frameAlignmentTime = state.frameAlignmentTime;
          }
          result.push(entry);
        });

        return result;
      },

      deserialize: (data) => {
        const newStates = new Map<string, TareState>();

        data.forEach((item) => {
          const state: TareState = {
            mountingTare: new THREE.Quaternion(
              item.mountingTare[1], // x
              item.mountingTare[2], // y
              item.mountingTare[3], // z
              item.mountingTare[0], // w
            ),
            headingTare: new THREE.Quaternion(
              item.headingTare[1],
              item.headingTare[2],
              item.headingTare[3],
              item.headingTare[0],
            ),
            jointTare: { ...item.jointTare },
            mountingTareTime: item.mountingTareTime,
            headingTareTime: item.headingTareTime,
            jointTareTime: item.jointTareTime,
          };
          // Restore frameAlignment if persisted
          if (item.frameAlignment) {
            state.frameAlignment = new THREE.Quaternion(
              item.frameAlignment[1],
              item.frameAlignment[2],
              item.frameAlignment[3],
              item.frameAlignment[0],
            );
            state.frameAlignmentTime = item.frameAlignmentTime || 0;
          }
          newStates.set(item.segmentId, state);
        });

        set({ tareStates: newStates });
        console.debug(`[TareStore] Deserialized ${data.length} tare states`);
      },
    }),
    {
      name: "tare-storage",
      storage: createJSONStorage(() => localStorage),

      // Custom serialization: Store as { serialized: SerializedTareState[] }
      partialize: (state) => ({
        serialized: state.serialize(),
      }),

      // Custom hydration: Convert { serialized } back to full state
      merge: (persistedState: any, currentState) => {
        if (persistedState && Array.isArray(persistedState.serialized)) {
          // Reconstruct Map and Quaternions from serialized data
          const newStates = new Map<string, TareState>();

          persistedState.serialized.forEach((item: SerializedTareState) => {
            const state: TareState = {
              mountingTare: new THREE.Quaternion(
                item.mountingTare[1],
                item.mountingTare[2],
                item.mountingTare[3],
                item.mountingTare[0],
              ),
              headingTare: new THREE.Quaternion(
                item.headingTare[1],
                item.headingTare[2],
                item.headingTare[3],
                item.headingTare[0],
              ),
              jointTare: { ...item.jointTare },
              mountingTareTime: item.mountingTareTime,
              headingTareTime: item.headingTareTime,
              jointTareTime: item.jointTareTime,
            };
            // Restore frameAlignment if persisted
            if (item.frameAlignment) {
              state.frameAlignment = new THREE.Quaternion(
                item.frameAlignment[1],
                item.frameAlignment[2],
                item.frameAlignment[3],
                item.frameAlignment[0],
              );
              state.frameAlignmentTime = item.frameAlignmentTime || 0;
            }
            newStates.set(item.segmentId, state);
          });

          return {
            ...currentState,
            tareStates: newStates,
          };
        }
        return currentState;
      },

      onRehydrateStorage: (state) => {
        return (rehydratedState, error) => {
          if (error) console.error("[TareStore] Hydration error", error);
          else {
            const count = rehydratedState?.tareStates?.size || 0;
            console.debug(`[TareStore] Rehydrated with ${count} segments`);
          }
        };
      },
    },
  ),
);

// Register with StoreRegistry for cross-store access (replaces window hack)
import { registerTareStore } from "./StoreRegistry";
registerTareStore(useTareStore);
