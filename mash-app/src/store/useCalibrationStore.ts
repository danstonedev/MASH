import { create } from "zustand";
import { persist } from "zustand/middleware";
import * as THREE from "three";
// Re-export runtime correction engines for use in SkeletonModel.useFrame
export { autoCalEngine } from "../calibration/AutoCalEngine";
export { calibrationLogger } from "../calibration/CalibrationLogger";

type SegmentId = string;
export type CalibrationMode = "research_strict";

/** Post-calibration report with timing, quality, and diagnostic data */
export interface CalibrationReport {
  timestamp: number;
  totalDurationMs: number;
  steps: {
    name: string;
    durationMs: number;
    status: "completed" | "timeout" | "skipped";
  }[];
  nodSamples: number;
  shakeSamples: number;
  pcaConfidence: number;
  pcaConfidenceLabel: string;
  hasBiasCorrection: boolean;
  gyroBias: { x: number; y: number; z: number } | null;
  axisAlignment: { w: number; x: number; y: number; z: number };
  frameAlignment: { w: number; x: number; y: number; z: number };
  headingTare: { w: number; x: number; y: number; z: number };
  mountingTare: { w: number; x: number; y: number; z: number };
  sensorId: string | null;
  success: boolean;
  failureReason: string | null;
}

export interface CalibrationData {
  segmentId: string;
  offset: THREE.Quaternion;
  alignmentQuaternion?: THREE.Quaternion; // Rotation to align sensor axis to bone axis
  headingCorrection?: THREE.Quaternion; // Heading correction from N-pose (dual-pose mode)
  capturedQuaternion: THREE.Quaternion;
  capturedAt: number;
  quality: number; // 0-100 quality score
  method: "single-pose" | "dual-pose" | "functional";
}

// Serializable version for persistence
// IMPORTANT: Arrays use [w, x, y, z] order (Xsens/BVH convention)
interface SerializedCalibrationData {
  segmentId: string;
  offset: [number, number, number, number]; // [w, x, y, z] - industry standard
  alignmentQuaternion?: [number, number, number, number];
  headingCorrection?: [number, number, number, number];
  capturedQuaternion: [number, number, number, number];
  capturedAt: number;
  quality: number;
  method: "single-pose" | "dual-pose" | "functional";
}

interface CalibrationState {
  showModal: boolean;
  status: "idle" | "countdown" | "capturing" | "walking" | "error" | "success";
  error: string | null;
  countdown: number;

  // Calibration mode (research-strict default)
  calibrationMode: CalibrationMode;

  // Multi-pose state
  calibrationStep: "idle" | "t-pose" | "walking" | "n-pose" | "calibrated";

  // Cervical Calibration state (Single-Sensor)
  cervicalStep:
    | "idle"
    | "stationary_start"
    | "rom_nod"
    | "rom_shake"
    | "rom_tilt"
    | "stationary_end"
    | "calculating"
    | "verification";

  sensorOffsets: Map<SegmentId, CalibrationData>;
  targetNeutralPose: Map<SegmentId, THREE.Quaternion>;

  // Post-calibration report
  calibrationReport: CalibrationReport | null;
  setCalibrationReport: (report: CalibrationReport | null) => void;

  // Quality tracking
  overallQuality: number; // Average quality across all calibrated sensors
  setOverallQuality: (quality: number) => void;

  setShowModal: (show: boolean) => void;
  setCalibrationMode: (mode: CalibrationMode) => void;

  // Actions
  setCalibrationStep: (
    step: "idle" | "t-pose" | "walking" | "n-pose" | "calibrated",
  ) => void;
  setCervicalStep: (
    step:
      | "idle"
      | "stationary_start"
      | "rom_nod"
      | "rom_shake"
      | "rom_tilt"
      | "stationary_end"
      | "calculating"
      | "verification",
  ) => void;

  // Subject Scaling
  subjectHeight: number; // in cm
  setSubjectHeight: (heightCm: number) => void;

  // Heading Reset
  headingResetOffset: number; // Radians to rotate the entire model (Y-axis)
  setHeadingResetOffset: (offset: number) => void;

  // DEPRECATED: Legacy T-pose methods removed - use UnifiedCalibration from CalibrationPanel
  // captureTPose: () => void;
  // captureNPose: () => void;

  applyUnifiedResults: (
    results: Map<
      string,
      {
        segmentId: string;
        offset: THREE.Quaternion;
        quality: number;
        method: string;
      }
    >,
  ) => void;

  // Legacy / Shared / Helpers
  startCalibration: () => void;
  cancelCalibration: () => void;
  setTargetNeutralPose: (pose: Map<SegmentId, THREE.Quaternion>) => void;
  getOffset: (segmentId: SegmentId) => THREE.Quaternion | undefined;
  getCalibration: (segmentId: SegmentId) => CalibrationData | undefined;
  getQuality: (segmentId: SegmentId) => number | undefined;
  reset: () => void;
  isCalibrated: () => boolean;

  // Industry-grade: Stale calibration detection (Xsens warns after 24h)
  isCalibrationStale: () => boolean;
  getCalibrationAgeHours: () => number | null;
}

// Helper: Quaternion to array [w, x, y, z] - INDUSTRY STANDARD (Xsens/BVH)
const quatToArray = (q: THREE.Quaternion): [number, number, number, number] => [
  q.w,
  q.x,
  q.y,
  q.z,
];

// Helper: Array [w, x, y, z] to Quaternion
const arrayToQuat = (
  arr: [number, number, number, number],
): THREE.Quaternion => {
  const [w, x, y, z] = arr;
  return new THREE.Quaternion(x, y, z, w);
};

// Migration helper: Detect and convert old [x,y,z,w] format
const migrateQuatArray = (
  arr: [number, number, number, number],
): [number, number, number, number] => {
  // Old format had w in position 3, new format has w in position 0
  // Heuristic: If arr[3] is close to 1 and arr[0-2] are small, it's old format
  const [a, b, c, d] = arr;
  const isOldFormat =
    Math.abs(d) > 0.7 && Math.abs(a) + Math.abs(b) + Math.abs(c) < 1.5;
  if (isOldFormat) {
    console.debug(
      "[CalibrationStore] Migrating quaternion from [x,y,z,w] to [w,x,y,z]",
    );
    return [d, a, b, c]; // [x,y,z,w] -> [w,x,y,z]
  }
  return arr;
};

// Serialize CalibrationData for storage
const serializeCalibData = (
  data: CalibrationData,
): SerializedCalibrationData => ({
  segmentId: data.segmentId,
  offset: quatToArray(data.offset),
  alignmentQuaternion: data.alignmentQuaternion
    ? quatToArray(data.alignmentQuaternion)
    : undefined,
  headingCorrection: data.headingCorrection
    ? quatToArray(data.headingCorrection)
    : undefined,
  capturedQuaternion: quatToArray(data.capturedQuaternion),
  capturedAt: data.capturedAt,
  quality: data.quality,
  method: data.method,
});

// Deserialize CalibrationData from storage (with migration for old format)
const deserializeCalibData = (
  data: SerializedCalibrationData,
): CalibrationData => ({
  segmentId: data.segmentId,
  offset: arrayToQuat(migrateQuatArray(data.offset)),
  alignmentQuaternion: data.alignmentQuaternion
    ? arrayToQuat(migrateQuatArray(data.alignmentQuaternion))
    : undefined,
  headingCorrection: data.headingCorrection
    ? arrayToQuat(migrateQuatArray(data.headingCorrection))
    : undefined,
  capturedQuaternion: arrayToQuat(migrateQuatArray(data.capturedQuaternion)),
  capturedAt: data.capturedAt,
  quality: data.quality ?? 100, // Default for legacy data
  method: data.method ?? "single-pose",
});

export const useCalibrationStore = create<CalibrationState>()(
  persist(
    (set, get) => ({
      showModal: false,
      status: "idle",
      error: null,
      countdown: 3,

      calibrationMode: "research_strict",
      calibrationStep: "idle",
      cervicalStep: "idle",

      sensorOffsets: new Map(),
      targetNeutralPose: new Map(),
      calibrationReport: null,
      setCalibrationReport: (report) => set({ calibrationReport: report }),
      overallQuality: 0,
      setOverallQuality: (quality) => set({ overallQuality: quality }),

      setShowModal: (show) => set({ showModal: show }),
      setCalibrationMode: (mode) => set({ calibrationMode: mode }),

      setCalibrationStep: (step) => set({ calibrationStep: step }),
      setCervicalStep: (step) => set({ cervicalStep: step }),

      subjectHeight: 175, // Default 175cm
      setSubjectHeight: (height) => set({ subjectHeight: height }),

      headingResetOffset: 0,
      setHeadingResetOffset: (offset) => set({ headingResetOffset: offset }),

      setTargetNeutralPose: (pose) => set({ targetNeutralPose: pose }),

      startCalibration: () => {
        // CLEAN SLATE: Clear any stale calibration before starting new one
        get().reset();
        set({ status: "countdown", countdown: 3 });
      },

      cancelCalibration: () => {
        set({ status: "idle", showModal: false, calibrationStep: "idle" });
      },

      isCalibrated: () => {
        const state = get();
        return (
          state.calibrationStep === "calibrated" ||
          state.cervicalStep === "verification"
        );
      },

      // Apply results from UnifiedCalibration
      applyUnifiedResults: (results) => {
        const offsets = new Map<SegmentId, CalibrationData>();
        const now = Date.now();
        let totalQuality = 0;
        let count = 0;

        results.forEach((result, segmentId) => {
          offsets.set(segmentId, {
            segmentId,
            offset: result.offset,
            capturedQuaternion: new THREE.Quaternion(),
            capturedAt: now,
            quality: result.quality,
            method:
              result.method === "pca-refined" ? "functional" : "single-pose",
          });
          totalQuality += result.quality;
          count++;
        });

        const overallQuality = count > 0 ? totalQuality / count : 0;

        set({
          sensorOffsets: offsets,
          calibrationStep: "calibrated",
          status: "success",
          overallQuality: overallQuality / 100, // Normalize to 0-1
        });

        console.debug(
          `[CalibrationStore] Applied unified results: ${count} sensors, quality: ${overallQuality.toFixed(0)}%`,
        );
      },

      // LEGACY METHODS REMOVED - Use UnifiedCalibration instead
      // captureNPose, captureForwardPose, calculateCalibration, captureCalibration
      // are no longer available. CalibrationPanel uses UnifiedCalibration directly.

      getOffset: (segmentId: SegmentId) => {
        return get().sensorOffsets.get(segmentId)?.offset;
      },

      getCalibration: (segmentId: SegmentId) => {
        return get().sensorOffsets.get(segmentId);
      },

      getQuality: (segmentId: SegmentId) => {
        return get().sensorOffsets.get(segmentId)?.quality;
      },

      reset: () => {
        // CLEAR ALL PERSISTED DATA: Prevents stale offsets from being restored
        localStorage.removeItem("imu-connect-calibration");
        localStorage.removeItem("imu-mounting-rotations");
        console.debug(
          "[CalibrationStore] Cleared all persisted calibration and mounting data",
        );

        set({
          calibrationStep: "idle",
          cervicalStep: "idle",
          calibrationMode: "research_strict",
          sensorOffsets: new Map(),
          status: "idle",
          overallQuality: 0,
          calibrationReport: null,
        });
      },

      // Industry-grade: Xsens/Perception Neuron warn when calibration > 24h old
      isCalibrationStale: () => {
        const ageHours = get().getCalibrationAgeHours();
        if (ageHours === null) return false;
        const isStale = ageHours > 24;
        if (isStale) {
          console.warn(
            `[CalibrationStore] Calibration is ${ageHours.toFixed(1)} hours old - consider recalibrating`,
          );
        }
        return isStale;
      },

      getCalibrationAgeHours: () => {
        const offsets = get().sensorOffsets;
        if (offsets.size === 0) return null;

        // Find oldest calibration timestamp
        let oldestTime = Date.now();
        offsets.forEach((data) => {
          if (data.capturedAt && data.capturedAt < oldestTime) {
            oldestTime = data.capturedAt;
          }
        });

        return (Date.now() - oldestTime) / (1000 * 60 * 60); // Hours
      },
    }),
    {
      name: "imu-connect-calibration",
      // Custom storage with serialization for THREE.Quaternion and Map
      storage: {
        getItem: (name: string) => {
          const str = localStorage.getItem(name);
          if (!str) return null;

          try {
            const parsed = JSON.parse(str);
            const offsets = new Map<string, CalibrationData>();

            if (parsed.state?.sensorOffsets) {
              Object.entries(parsed.state.sensorOffsets).forEach(
                ([key, value]) => {
                  offsets.set(
                    key,
                    deserializeCalibData(value as SerializedCalibrationData),
                  );
                },
              );
            }

            const normalizeCalibrationMode = (
              persistedMode: unknown,
            ): CalibrationMode => {
              if (persistedMode === "research_strict") return "research_strict";
              // Legacy migration
              if (
                persistedMode === "operational_fast" ||
                persistedMode === "quick" ||
                persistedMode === "full" ||
                persistedMode === "pca"
              ) {
                return "research_strict";
              }
              return "research_strict";
            };

            return {
              state: {
                calibrationStep: parsed.state?.calibrationStep || "idle",
                calibrationMode: normalizeCalibrationMode(
                  parsed.state?.calibrationMode,
                ),
                sensorOffsets: offsets,
                overallQuality: parsed.state?.overallQuality || 0,
              },
              version: parsed.version,
            };
          } catch {
            return null;
          }
        },
        setItem: (
          name: string,
          value: { state: Partial<CalibrationState>; version?: number },
        ) => {
          const serializedOffsets: Record<string, SerializedCalibrationData> =
            {};
          const offsets = value.state.sensorOffsets;

          if (offsets instanceof Map) {
            offsets.forEach((v, k) => {
              serializedOffsets[k] = serializeCalibData(v);
            });
          }

          const toStore = {
            state: {
              calibrationStep: value.state.calibrationStep,
              calibrationMode: value.state.calibrationMode,
              sensorOffsets: serializedOffsets,
              overallQuality: value.state.overallQuality,
            },
            version: value.version,
          };

          localStorage.setItem(name, JSON.stringify(toStore));
        },
        removeItem: (name: string) => localStorage.removeItem(name),
      },
      // Only persist calibration offsets and step (not transient UI state)
      partialize: (state) => ({
        calibrationStep: state.calibrationStep,
        calibrationMode: state.calibrationMode,
        sensorOffsets: state.sensorOffsets,
        overallQuality: state.overallQuality,
        subjectHeight: state.subjectHeight,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as
          | Partial<CalibrationState>
          | undefined;
        return {
          ...currentState,
          showModal: false, // NEVER persist modal open state across sessions
          calibrationStep:
            persisted?.calibrationStep || currentState.calibrationStep,
          calibrationMode:
            persisted?.calibrationMode || currentState.calibrationMode,
          sensorOffsets:
            persisted?.sensorOffsets instanceof Map &&
            persisted.sensorOffsets.size > 0
              ? persisted.sensorOffsets
              : currentState.sensorOffsets,
          overallQuality: persisted?.overallQuality || 0,
          subjectHeight: persisted?.subjectHeight || currentState.subjectHeight,
        };
      },
    },
  ),
);

// Register with StoreRegistry for cross-store access
import { registerCalibrationStore } from "./StoreRegistry";
registerCalibrationStore(useCalibrationStore as any);
