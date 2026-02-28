/**
 * GRF Store - Ground Reaction Force State Management
 * ===================================================
 *
 * Zustand store for managing GRF estimation state and integrating
 * with the InverseDynamics engine.
 */

import { create } from "zustand";
import * as THREE from "three";
import {
  InverseDynamicsEngine,
  createAnthropometricModel,
  type GRFEstimate,
  type GaitPhase,
} from "../biomech/InverseDynamics";

// ============================================================================
// TYPES
// ============================================================================

export interface GRFState {
  // Engine instance
  engine: InverseDynamicsEngine | null;

  // Current estimates
  currentGRF: GRFEstimate | null;

  // History for charting
  grfHistory: {
    time: number;
    vertical: number; // BW
    anteroPosterior: number; // BW
    medioLateral: number; // BW
    phase: GaitPhase;
  }[];

  // Peak metrics
  peakVertical: number; // BW
  loadingRate: number; // BW/s

  // Gait metrics
  currentPhase: GaitPhase;
  supportLeg: "left" | "right" | "double" | "flight";
  stepCount: number;

  // State flags
  isEnabled: boolean;

  // Actions
  initialize: (
    height: number,
    weight: number,
    gender?: "male" | "female",
  ) => void;
  updateFromSensor: (
    pelvisAccel: [number, number, number],
    pelvisQuat: [number, number, number, number],
    timestamp: number,
    footAccelL?: [number, number, number],
    footAccelR?: [number, number, number],
  ) => GRFEstimate | null;
  setEnabled: (enabled: boolean) => void;
  reset: () => void;
}

// ============================================================================
// STORE
// ============================================================================

export const useGRFStore = create<GRFState>((set, get) => ({
  engine: null,
  currentGRF: null,
  grfHistory: [],
  peakVertical: 0,
  loadingRate: 0,
  currentPhase: "unknown",
  supportLeg: "double",
  stepCount: 0,
  isEnabled: true,

  initialize: (height, weight, gender = "male") => {
    const model = createAnthropometricModel(height, weight, gender);
    const engine = new InverseDynamicsEngine(model);

    set({
      engine,
      grfHistory: [],
      peakVertical: 0,
      loadingRate: 0,
      stepCount: 0,
    });

    console.debug(
      `[GRFStore] Initialized with ${height}cm, ${weight}kg (${gender})`,
    );
  },

  updateFromSensor: (
    pelvisAccel,
    pelvisQuat,
    timestamp,
    footAccelL,
    footAccelR,
  ) => {
    const { engine, isEnabled, grfHistory, currentPhase } = get();
    if (!engine || !isEnabled) return null;

    // Convert arrays to THREE.js types
    const accel = new THREE.Vector3(...pelvisAccel);
    const quat = new THREE.Quaternion(
      pelvisQuat[1],
      pelvisQuat[2],
      pelvisQuat[3],
      pelvisQuat[0],
    );

    const footL = footAccelL ? new THREE.Vector3(...footAccelL) : undefined;
    const footR = footAccelR ? new THREE.Vector3(...footAccelR) : undefined;

    // Estimate GRF
    const estimate = engine.estimateGRF(accel, quat, timestamp, footL, footR);

    // Update history (keep last 500 samples ~ 5s at 100Hz)
    const newHistory = [
      ...grfHistory,
      {
        time: timestamp,
        vertical: estimate.normalizedForce.y,
        anteroPosterior: estimate.normalizedForce.z,
        medioLateral: estimate.normalizedForce.x,
        phase: estimate.phase,
      },
    ].slice(-500);

    // Detect step transitions
    let stepCount = get().stepCount;
    if (
      currentPhase === "initial_swing" &&
      estimate.phase === "loading_response"
    ) {
      stepCount++; // New heel strike
    }

    // Update peak if higher
    const peak = engine.getPeakVerticalGRF(2000);

    set({
      currentGRF: estimate,
      grfHistory: newHistory,
      currentPhase: estimate.phase,
      supportLeg: estimate.supportLeg,
      peakVertical: peak.peak,
      loadingRate: engine.getLoadingRate(),
      stepCount,
    });

    return estimate;
  },

  setEnabled: (enabled) => set({ isEnabled: enabled }),

  reset: () => {
    get().engine?.clearHistory();
    set({
      grfHistory: [],
      peakVertical: 0,
      loadingRate: 0,
      stepCount: 0,
      currentPhase: "unknown",
      supportLeg: "double",
    });
  },
}));

// ============================================================================
// AUTO-INITIALIZE
// ============================================================================

// Initialize with default values (will be updated when athlete is selected)
useGRFStore.getState().initialize(180, 75, "male");
