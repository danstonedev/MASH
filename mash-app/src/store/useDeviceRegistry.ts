/**
 * Device Registry: Zustand store for managing multiple IMU devices.
 * Supports both real BLE devices and simulated data.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
// import type { SegmentId } from '../biomech/segmentRegistry'; // Unused
import { BODY_TEMPLATES, type TemplateId } from "../biomech/bodyTemplates";
import { IMUSimulator, type SimulatedIMUData } from "../biomech/IMUSimulator";
import {
  registerSensorId,
  getSensorDisplayNameWithNode,
  getSensorDisplayName,
  resetSensorRegistry,
} from "../lib/sensorDisplayName";
// VQF Params
export interface VQFParams {
  /** Time constant for accelerometer updates (s). Lower = trust accel more. Default 3.0 */
  tauAcc: number;
  /** Time constant for magnetometer updates (s). Default 9.0 */
  tauMag: number;
  /** Acceleration threshold for rest detection (m/s^2). Default 0.2 */
  restThAcc: number;
  /** Gyroscope threshold for rest detection (rad/s). Default 0.05 (~3 deg/s) */
  restThGyro: number;
}

export interface AxisConfig {
  /** Mapping of logical axes [x, y, z] to raw sensor index [0, 1, 2] */
  map: [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
  /** Sign inversion for each logical axis (+1 or -1) */
  sign: [1 | -1, 1 | -1, 1 | -1];
}

// import * as THREE from "three"; // REMOVED UNUSED
import { useNetworkStore } from "./useNetworkStore";
import type { IMUDataPacket } from "../lib/ble/DeviceInterface";
import {
  STALE_THRESHOLD_MS,
  OFFLINE_THRESHOLD_MS,
} from "../lib/connection/SyncedSampleStats";

// constant removed
import { VQF } from "../lib/fusion/VQF";

const filterRegistry = new Map<string, VQF>();
const lastTimestamps = new Map<string, number>();

// ============================================================================
// PERFORMANCE: Module-level diagnostic throttle state
// ============================================================================
// Replaces per-packet `window[key]` lookups (slow property access on global)
// with typed Map lookups for all throttled diagnostic logging.
// ============================================================================
const smoothedDtCache = new Map<string, number>();

// ── dt monitoring: track clamp events and timestamp rollover ────────────
let _dtClampMinCount = 0; // dt clamped to lower bound (0.002s)
let _dtClampMaxCount = 0; // dt clamped to upper bound (0.05s)
let _dtRolloverCount = 0; // firmware timestamp went backwards
/** Expose dt diagnostics for pipeline inspector */
export function getDtDiagnostics() {
  return {
    clampMin: _dtClampMinCount,
    clampMax: _dtClampMaxCount,
    rollover: _dtRolloverCount,
  };
}
export function resetDtDiagnostics() {
  _dtClampMinCount = 0;
  _dtClampMaxCount = 0;
  _dtRolloverCount = 0;
}

// ── VQF divergence detection ────────────────────────────────────────────
// Periodically sample VQF diagnostics per device and flag sustained tilt error.
const VQF_DIAG_INTERVAL = 50; // sample every ~50 packets (~250ms at 200Hz)
const VQF_DIVERGENCE_THRESHOLD_DEG = 15;
const VQF_DIVERGENCE_SUSTAIN_MS = 2000;

interface VqfDivergenceState {
  lastErrorDeg: number;
  maxErrorDeg: number;
  updateCount: number;
  /** Timestamp when lastErrorDeg first exceeded threshold continuously */
  overThresholdSince: number | null;
  isDiverged: boolean;
}
const _vqfDiagState = new Map<string, VqfDivergenceState>();
const _vqfDiagCounter = new Map<string, number>();

/** Get VQF divergence status for all active devices */
export function getVqfDiagnostics(): Map<string, VqfDivergenceState> {
  return _vqfDiagState;
}

/** Get VQF divergence for a single device */
export function getVqfDiagnosticsForDevice(
  deviceId: string,
): VqfDivergenceState | undefined {
  return _vqfDiagState.get(deviceId);
}

// ── Accel/gyro value-range monitoring ───────────────────────────────────
// Flags sensors that persistently report extreme values (stuck at rail,
// broken accelerometer, gyro near saturation).
const ACCEL_MAG_MIN = 1.0; // m/s² — below this means sensor is likely dead
const ACCEL_MAG_MAX = 50.0; // m/s² — above this for extended time = problem
const GYRO_MAG_WARN = 15.0; // rad/s (~860°/s) — near ICM20649 ±1000°/s saturation
const RANGE_CHECK_INTERVAL = 100; // check every ~100 packets per device

interface RangeViolation {
  accelOutOfRange: number; // count of samples where accel magnitude outside [1, 50]
  gyroNearSaturation: number; // count of samples where gyro magnitude > 15 rad/s
  totalChecked: number;
}
const _rangeViolations = new Map<string, RangeViolation>();
const _rangeCheckCounter = new Map<string, number>();

/** Get per-device range violation stats */
export function getRangeViolations(): Map<string, RangeViolation> {
  return _rangeViolations;
}

const diagFirstPacket = new Set<string>();
const diagRawLogTime = new Map<string, number>();
const diagZuptLogTime = new Map<string, number>();
const diagVqfProbeTime = new Map<string, number>();
const diagAxisLogTime = new Map<string, number>();
const diagPathCount = new Map<string, number>();
const diagNodeInfoLogTime = new Map<string, number>();
const unexpectedRegistrySensorLogTime = new Map<number, number>();

// Diagnostic log intervals (ms) — increase to reduce console overhead
const DIAG_RAW_INTERVAL = 10000; // Was 5000ms, now 10s
const DIAG_ZUPT_INTERVAL = 10000; // Was 5000ms, now 10s
const DIAG_VQF_PROBE_INTERVAL = 5000; // Was 2000ms, now 5s
const DIAG_AXIS_INTERVAL = 10000; // Was 5000ms, now 10s

// ============================================================================
// LOW-PASS FILTER (Exponential Moving Average)
// ============================================================================
interface LowPassState {
  accel: [number, number, number];
  gyro: [number, number, number];
}
const lowPassCache = new Map<string, LowPassState>();

/**
 * Apply exponential moving average low-pass filter
 * @param current Current reading
 * @param previous Previous filtered value
 * @param alpha Smoothing factor (0-1). Higher = more responsive, more noise
 */
function applyLowPass(
  current: [number, number, number],
  previous: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [
    alpha * current[0] + (1 - alpha) * previous[0],
    alpha * current[1] + (1 - alpha) * previous[1],
    alpha * current[2] + (1 - alpha) * previous[2],
  ];
}

/**
 * Calculate alpha from cutoff frequency and sample rate
 * For EMA: alpha = 1 - e^(-2π * fc / fs)
 * Simplified: alpha ≈ 2π * fc * dt / (2π * fc * dt + 1)
 */
function cutoffToAlpha(cutoffHz: number, sampleRateHz: number): number {
  if (cutoffHz <= 0 || sampleRateHz <= 0) return 1.0; // Bypass
  const dt = 1.0 / sampleRateHz;
  const rc = 1.0 / (2 * Math.PI * cutoffHz);
  return dt / (rc + dt);
}

// High-frequency data caches (mutable, non-reactive)
// These bypass React state for 120Hz updates
export const deviceQuaternionCache = new Map<
  string,
  [number, number, number, number]
>();
export const deviceAccelCache = new Map<string, [number, number, number]>();
// deviceStatsCache exported below
export const deviceGyroCache = new Map<string, [number, number, number]>();
// NEW: Truly Raw Cache (Before Axis/Scale)
export const deviceRawAccelCache = new Map<string, [number, number, number]>();
export const deviceRawGyroCache = new Map<string, [number, number, number]>();
export const deviceStatsCache = new Map<
  string,
  { hz: number; lastUpdate: number; sampleCount?: number; windowStart?: number }
>();

// DEBUG: Expose caches to window for troubleshooting
if (typeof window !== "undefined") {
  (window as any).__deviceQuaternionCache = deviceQuaternionCache;
  (window as any).__deviceStatsCache = deviceStatsCache;
}

// === UNCERTAINTY TRACKING (Research Quality) ===
import { UncertaintyTracker, type DriftMetrics } from "../lib/math/uncertainty";

/** Uncertainty tracker per device (for research-quality output) */
const uncertaintyTrackers = new Map<string, UncertaintyTracker>();

/** Get uncertainty for a device in degrees [roll, pitch, yaw] */
export function getDeviceUncertaintyDeg(
  deviceId: string,
): [number, number, number] | null {
  const tracker = uncertaintyTrackers.get(deviceId);
  return tracker ? tracker.getUncertaintyDegrees() : null;
}

/** Get drift metrics for a device */
export function getDeviceDriftMetrics(deviceId: string): DriftMetrics | null {
  const tracker = uncertaintyTrackers.get(deviceId);
  return tracker ? tracker.getDriftMetrics() : null;
}

/** Get quality score for a device (0-1) */
export function getDeviceQualityScore(deviceId: string): number {
  const tracker = uncertaintyTrackers.get(deviceId);
  return tracker ? tracker.getQualityScore() : 0;
}

export interface DeviceData {
  id: string;
  name: string;
  // segment: SegmentId | null; // REMOVED: Managed by useSensorAssignmentStore
  segment?: string; // Optional segment ID for visualization
  quaternion: [number, number, number, number];
  accelerometer: [number, number, number];
  gyro: [number, number, number];
  battery: number;
  isConnected: boolean;
  connectionHealth: "active" | "stale" | "offline";
  isSimulated: boolean;
  lastUpdate: number;
  lastTapTime?: number; // Timestamp of last detected tap (High G event)
  isStationary?: boolean; // New: True if device is holding still
  format?: string; // Detection: Packet format ID
}

// Sensor Transform: Offset from bone origin
export interface SensorTransform {
  position: [number, number, number]; // [x, y, z] relative to bone
  rotation: [number, number, number]; // [x, y, z] Euler angles relative to bone
}

interface DeviceRegistryState {
  // State
  devices: Map<string, DeviceData>;
  sensorTransforms: Record<string, SensorTransform>; // deviceId -> Transform (Record for JSON persistence)
  activeTemplate: TemplateId;
  isSimulatorRunning: boolean;
  viewMode: "full_body" | "skate";
  isPlacementMode: boolean; // Toggles gizmo visibility
  placementType: "translate" | "rotate"; // New: Toggle between move and rotate
  // REMOVED: useClientSideFusion
  zuptThreshold: number; // Gyro threshold (deg/s) for Stationary Detection (ZUPT)
  // VQF Config
  vqfConfig: VQFParams;
  setVQFConfig: (params: Partial<VQFParams>) => void;

  // Axis Correction
  axisConfig: Record<string, AxisConfig>;
  setAxisConfig: (deviceId: string, config: AxisConfig) => void;
  // Scale Correction
  sensorScales: Record<string, number>;
  setSensorScale: (deviceId: string, scale: number) => void;

  ekfGyroNoise: number; // OLD - to purge later
  ekfAccelNoise: number; // OLD - to purge later

  // Low-Pass Filter (optional pre-filter for noise reduction during tuning)
  lowPassEnabled: boolean;
  lowPassCutoffHz: number; // Cutoff frequency in Hz (e.g., 5-30 Hz)
  setLowPassEnabled: (enabled: boolean) => void;
  setLowPassCutoffHz: (hz: number) => void;

  // Disconnection Tracking
  lastDisconnectedDeviceId: string | null;
  lastDisconnectTime: number | null;

  // Actions
  // REMOVED: setClientSideFusion
  setEKFConfig: (gyroNoise: number, accelNoise: number) => void;
  setZuptThreshold: (threshold: number) => void;
  pruneStaleDevices: () => void; // Remove devices inactive for > 5s
  setViewMode: (mode: "full_body" | "skate") => void;
  setPlacementMode: (enabled: boolean) => void;
  setPlacementType: (type: "translate" | "rotate") => void;
  updateSensorTransform: (
    deviceId: string,
    transform: Partial<SensorTransform>,
  ) => void;
  // BIAS CONTROL
  gyroBias: Record<string, { x: number; y: number; z: number }>;
  setGyroBias: (
    deviceId: string,
    bias: { x: number; y: number; z: number },
  ) => void;
  /** Seed the VQF filter's internal bias so it starts from calibrated value */
  seedVQFBias: (
    deviceId: string,
    bias: { x: number; y: number; z: number },
  ) => void;
  /** Set VQF heading anchor — captures current VQF quaternion as yaw reference */
  setVQFHeadingAnchor: (deviceId: string) => void;
  setTemplate: (templateId: TemplateId) => void;
  startSimulator: (pattern: "idle" | "walking" | "squatting") => void;
  stopSimulator: () => void;
  updateDevice: (data: SimulatedIMUData) => void;
  handleRealDeviceData: (data: any) => void;
  clear: () => void; // New: Clear all devices
  removeDevice: (deviceId: string) => void; // New: Remove specific device
  resetAxisConfig: (deviceId: string) => void;

  // Mounting Correction (Tare)
  mountingOffsets: Record<string, [number, number, number, number]>;
  setMountingOffset: (
    deviceId: string,
    offset: [number, number, number, number],
  ) => void;
  // Calculates and sets offset such that current orientation becomes Identity
  tareDevice: (deviceId: string) => void;

  // Computed
  // REMOVED: getAssignedSegments
  // getAssignedSegments: () => SegmentId[];
  // REMOVED: getDeviceForSegment
  // getDeviceForSegment: (segment: SegmentId) => DeviceData | undefined;
}

// Track when each device was first seen (module-level, not persisted).
// Used to avoid firing disconnect alerts for phantom/garbage sensors.
const deviceFirstSeenTime = new Map<string, number>();
const ESTABLISHED_DEVICE_MIN_AGE_MS = 3000; // Device must exist 3s to be "real"

let _transientPruneCount = 0;
let _retainedStaleCount = 0;
let _lastStabilityLogMs = 0;

export function getRegistryStabilityDiagnostics() {
  return {
    transientPruned: _transientPruneCount,
    retainedStale: _retainedStaleCount,
  };
}

export function resetRegistryStabilityDiagnostics() {
  _transientPruneCount = 0;
  _retainedStaleCount = 0;
  _lastStabilityLogMs = 0;
}

export const useDeviceRegistry = create<DeviceRegistryState>()(
  persist(
    (set, get) => {
      // Internal variable for subscription cleanup (not exposed in state)
      let simulatorUnsubscribe: (() => void) | null = null;

      return {
        devices: new Map(),
        sensorTransforms: {}, // Empty record
        gyroBias: {},
        activeTemplate: "lower_body",
        isSimulatorRunning: false,
        viewMode: "full_body",
        isPlacementMode: false,
        placementType: "translate",
        // useClientSideFusion removed
        // Default zuptThreshold relaxed for subtle motion
        zuptThreshold: 2.5, // Increased to 2.5 to stop stubborn drift on left side
        // Default VQF Config
        // tauAcc: Lower = faster accel correction (snappier but noisier)
        // tauMag: Not used in 6-axis mode
        vqfConfig: {
          tauAcc: 1.0, // Reduced from 3.0 for faster visualization response
          tauMag: 9.0,
          restThAcc: 0.5, // Relaxed from 0.2 m/s² — allows rest detection under slight vibration
          restThGyro: 0.15, // Relaxed from 0.05 rad/s (~8.6°/s) — ensures rest detection triggers
          // even with residual gyro bias after firmware correction, enabling
          // VQF's internal bias learning to converge and stop heading drift.
        },
        setVQFConfig: (params) => {
          set((state) => {
            const newConfig = { ...state.vqfConfig, ...params };
            // Propagate to all active filters
            filterRegistry.forEach((filter) => {
              filter.setParams(newConfig);
            });
            return { vqfConfig: newConfig };
          });
        },
        axisConfig: {},
        setAxisConfig: (deviceId, config) => {
          console.debug(
            `[Registry] Setting Axis Config for ${deviceId}:`,
            config,
          );
          // Clear VQF so it reinits with new frame
          filterRegistry.delete(deviceId);

          set((state) => ({
            axisConfig: { ...state.axisConfig, [deviceId]: config },
          }));
        },
        resetAxisConfig: (deviceId) =>
          set((state) => {
            const newConfig = { ...state.axisConfig };
            delete newConfig[deviceId];
            return { axisConfig: newConfig };
          }),

        sensorScales: {},
        setSensorScale: (deviceId, scale) => {
          // Force filter re-init to snap to new gravity
          filterRegistry.delete(deviceId);
          set((state) => ({
            sensorScales: { ...state.sensorScales, [deviceId]: scale },
          }));
        },

        mountingOffsets: {}, // Initialize empty
        setMountingOffset: (deviceId, offset) =>
          set((state) => ({
            mountingOffsets: { ...state.mountingOffsets, [deviceId]: offset },
          })),

        /**
         * Tare device to current orientation.
         *
         * ⚠️  QUATERNION CONVENTION - DO NOT CHANGE WITHOUT READING THIS! ⚠️
         *
         * This uses the convention: tared = sensor × offset
         * where offset = conjugate(current_sensor)
         *
         * The multiplication order is CRITICAL:
         * - CORRECT: sensor × offset (local frame, preserves axes)
         * - WRONG: offset × sensor (world frame, swaps Y/Z when taring from vertical!)
         *
         * Tests: src/tests/quaternionConventions.test.ts (19 tests verify this)
         * Utility: src/lib/math/quaternionTare.ts (centralized implementation)
         */
        tareDevice: (deviceId) => {
          // 1. Get current orientation from high-freq cache (most recent)
          const currentQ = deviceQuaternionCache.get(deviceId);
          if (!currentQ) {
            console.warn("[Registry] Cannot tare: No data for " + deviceId);
            return;
          }

          // 2. Compute offset = conjugate(current)
          // See src/lib/math/quaternionTare.ts for centralized convention
          const [w, x, y, z] = currentQ;
          const invQ: [number, number, number, number] = [w, -x, -y, -z];

          console.debug(
            `[Registry] Taring ${deviceId}. Current: ${currentQ.map((v) => v.toFixed(3)).join(",")} -> Offset: ${invQ.map((v) => v.toFixed(3)).join(",")}`,
          );

          set((state) => ({
            mountingOffsets: { ...state.mountingOffsets, [deviceId]: invQ },
          }));
        },

        ekfGyroNoise: 0.004,
        ekfAccelNoise: 0.004,

        // Low-pass filter defaults (disabled by default, 10Hz cutoff when enabled)
        lowPassEnabled: false,
        lowPassCutoffHz: 10,
        setLowPassEnabled: (enabled) => {
          console.debug(
            `[Registry] Low-pass filter ${enabled ? "ENABLED" : "DISABLED"}`,
          );
          // Clear filter cache when toggling to reset state
          lowPassCache.clear();
          set({ lowPassEnabled: enabled });
        },
        setLowPassCutoffHz: (hz) => {
          console.debug(`[Registry] Low-pass cutoff set to ${hz} Hz`);
          set({ lowPassCutoffHz: hz });
        },

        lastDisconnectedDeviceId: null,
        lastDisconnectTime: null,

        // setClientSideFusion removed
        setEKFConfig: (gyroNoise, accelNoise) => {
          // Mapping legacy EKF slider params to VQF if needed,
          // or just ignoring if VQF doesn't need tuning.
          // For now, let's assume sliders adjust time constants slightly
          // Low Noise => Higher Tau (trust prediction more)
          // High Noise => Lower Tau (trust measurement more)
          // const multiplier = 1.0;

          /*
          ekfConfig = {
            gyroNoiseDensity: gyroNoise,
            accelNoiseDensity: accelNoise,
          };
          */
          set({ ekfGyroNoise: gyroNoise, ekfAccelNoise: accelNoise });
          // Force filter recreation
          filterRegistry.clear();
          lastTimestamps.clear();
        },
        setZuptThreshold: (threshold) => set({ zuptThreshold: threshold }),

        pruneStaleDevices: () => {
          set((state) => {
            const now = Date.now();
            const devices = new Map(state.devices);
            let changed = false;
            let lastDisconnectedDeviceId: string | null =
              state.lastDisconnectedDeviceId;
            let lastDisconnectTime: number | null = state.lastDisconnectTime;

            for (const [id, device] of devices.entries()) {
              // Use the high-frequency stats cache to determine true freshness.
              // The React state `lastUpdate` only refreshes every ~5s (heartbeat
              // optimization), so checking it alone creates a race condition where
              // healthy devices get falsely pruned between heartbeat updates.
              const statsLastUpdate =
                deviceStatsCache.get(id)?.lastUpdate ?? device.lastUpdate;
              const timeSinceData = now - statsLastUpdate;
              const nextHealth: DeviceData["connectionHealth"] =
                timeSinceData > OFFLINE_THRESHOLD_MS
                  ? "offline"
                  : timeSinceData > STALE_THRESHOLD_MS
                    ? "stale"
                    : "active";

              const isNewOfflineTransition =
                device.connectionHealth !== "offline" &&
                nextHealth === "offline";

              if (device.connectionHealth !== nextHealth) {
                devices.set(id, { ...device, connectionHealth: nextHealth });
                changed = true;
              }

              if (isNewOfflineTransition) {
                const firstSeen = deviceFirstSeenTime.get(id);
                const isEstablished =
                  firstSeen != null &&
                  now - firstSeen > ESTABLISHED_DEVICE_MIN_AGE_MS;
                if (isEstablished) {
                  lastDisconnectedDeviceId = id;
                  lastDisconnectTime = now;
                }
              }

              if (timeSinceData > 8000) {
                // STABILITY POLICY:
                // - Keep established devices in registry across transient stalls to
                //   avoid topology churn, VQF re-inits, and assignment flicker.
                // - Only prune short-lived phantom devices (never established).
                const firstSeen = deviceFirstSeenTime.get(id);
                const isEstablished =
                  firstSeen != null &&
                  now - firstSeen > ESTABLISHED_DEVICE_MIN_AGE_MS;

                if (!isEstablished) {
                  console.warn(
                    `[Registry] ⚠️ Pruning transient device: ${id} (Last data: ${(timeSinceData / 1000).toFixed(1)}s ago)`,
                  );
                  _transientPruneCount++;
                  devices.delete(id);
                  deviceQuaternionCache.delete(id);
                  deviceAccelCache.delete(id);
                  deviceGyroCache.delete(id);
                  deviceRawAccelCache.delete(id);
                  deviceRawGyroCache.delete(id);
                  deviceStatsCache.delete(id);
                  smoothedDtCache.delete(id);
                  lowPassCache.delete(id);
                  filterRegistry.delete(id);
                  lastTimestamps.delete(id);
                  uncertaintyTrackers.delete(id);
                  deviceFirstSeenTime.delete(id);
                  changed = true;
                } else {
                  _retainedStaleCount++;
                }
              }
            }

            if (now - _lastStabilityLogMs > 10000) {
              _lastStabilityLogMs = now;
              if (_transientPruneCount > 0 || _retainedStaleCount > 0) {
                console.info(
                  `[Registry] Stability diag: transientPruned=${_transientPruneCount}, retainedStale=${_retainedStaleCount}`,
                );
              }
            }
            return changed
              ? { devices, lastDisconnectedDeviceId, lastDisconnectTime }
              : {};
          });
        },
        setViewMode: (mode) => set({ viewMode: mode }),
        setPlacementMode: (enabled) => set({ isPlacementMode: enabled }),
        setPlacementType: (type) => set({ placementType: type }),

        updateSensorTransform: (deviceId, transform) => {
          set((state) => {
            const current = state.sensorTransforms[deviceId] || {
              position: [0, 0, 0],
              rotation: [0, 0, 0],
            };
            const updated = { ...current, ...transform };
            return {
              sensorTransforms: {
                ...state.sensorTransforms,
                [deviceId]: updated,
              },
            };
          });
        },
        setGyroBias: (deviceId, bias) =>
          set((state) => ({
            gyroBias: { ...state.gyroBias, [deviceId]: bias },
          })),

        seedVQFBias: (deviceId, bias) => {
          // VQF's internal bias is DISABLED (external bias subtracted before VQF).
          // This function now only stores the bias for external subtraction.
          // Do NOT set vqf.setBias() — that causes double-subtraction drift.
          console.debug(
            "[DeviceRegistry] Gyro bias stored for external subtraction:",
            deviceId,
            bias,
          );
        },

        /**
         * Set the heading anchor on a sensor's VQF filter.
         * Call after calibration completes — captures the current VQF quaternion
         * as the "zero heading" reference. During rest, VQF will gently correct
         * yaw drift toward this heading (acts as virtual magnetometer).
         */
        setVQFHeadingAnchor: (deviceId: string) => {
          const vqf = filterRegistry.get(deviceId);
          if (vqf) {
            const currentQuat = vqf.getQuaternion();
            vqf.setHeadingAnchor(currentQuat);
            console.debug(
              "[DeviceRegistry] Set VQF heading anchor for",
              deviceId,
            );
          } else {
            console.warn(
              "[DeviceRegistry] No VQF filter for heading anchor:",
              deviceId,
            );
          }
        },

        setTemplate: (templateId) => set({ activeTemplate: templateId }),

        startSimulator: (pattern) => {
          const template = BODY_TEMPLATES[get().activeTemplate];

          // Clean up existing subscription
          if (simulatorUnsubscribe) {
            simulatorUnsubscribe();
            simulatorUnsubscribe = null;
          }

          // Subscribe using correct API
          simulatorUnsubscribe = IMUSimulator.subscribe((data) => {
            get().updateDevice(data);
          });

          // Start simulator with Config object
          IMUSimulator.start({
            segments: template.segments,
            updateRate: 60,
            motionPattern: pattern,
          });

          set({ isSimulatorRunning: true });
        },

        stopSimulator: () => {
          if (simulatorUnsubscribe) {
            simulatorUnsubscribe();
            simulatorUnsubscribe = null;
          }
          IMUSimulator.stop();
          set({ isSimulatorRunning: false });
        },

        updateDevice: (data: SimulatedIMUData) => {
          set((state) => {
            const devices = new Map(state.devices);
            const now = Date.now();

            // Update high-freq cache
            deviceQuaternionCache.set(data.segmentId, data.quaternion);
            deviceAccelCache.set(data.segmentId, data.accelerometer);
            deviceGyroCache.set(data.segmentId, [0, 0, 0]);

            devices.set(data.segmentId, {
              id: data.segmentId,
              name: `Simulated ${data.segmentId}`,
              // segment: data.segmentId, // REMOVED
              quaternion: data.quaternion,
              accelerometer: data.accelerometer,
              gyro: [0, 0, 0],
              battery: data.battery,
              isConnected: true,
              connectionHealth: "active",
              isSimulated: true,
              lastUpdate: now,
            });

            return { devices };
          });
        },

        handleRealDeviceData: (data: any) => {
          set((state) => {
            const devices = new Map(state.devices);
            const now = Date.now();

            // === RECONNECT / NODE INFO HANDLER ===
            // Check if this is a NodeInfoPacket (reconnection event)
            const nodeInfo = data as any;
            if (
              nodeInfo.sensorCount !== undefined &&
              nodeInfo.sensorIdOffset !== undefined &&
              nodeInfo.gatewayName
            ) {
              const { sensorIdOffset, sensorCount, gatewayName } = nodeInfo;
              // Only log rarely to avoid spam (Node sends this every 5s)
              const now = Date.now();
              const lastLog = diagNodeInfoLogTime.get(nodeInfo.nodeName) || 0;
              if (now - lastLog > 10000) {
                console.debug(
                  `[Registry] Node Heartbeat: ${nodeInfo.nodeName} (Sensors ${sensorIdOffset}-${sensorIdOffset + sensorCount - 1}) via ${gatewayName}`,
                );
                diagNodeInfoLogTime.set(nodeInfo.nodeName, now);
              }

              set((state) => {
                const transforms = { ...state.sensorTransforms };
                let changed = false;

                for (let i = 0; i < sensorCount; i++) {
                  const sId = sensorIdOffset + i;
                  // Construct likely device IDs
                  const candidates = [
                    `${gatewayName}_${sId}`, // Standard Gateway format
                    `Sensor ${sId}`, // Direct connection or legacy
                    `sensor_${sId}`, // Store internal fallback
                  ];

                  candidates.forEach((candId) => {
                    // CRITICAL: Only reset calibration if the device is NEW to the registry (Reconnect/Reboot)
                    // If it's already in 'devices', this is just a heartbeat packet (sent every 5s)
                    const isAlreadyConnected = state.devices.has(candId);

                    if (
                      !isAlreadyConnected &&
                      transforms[candId] &&
                      (transforms[candId].rotation[0] !== 0 ||
                        transforms[candId].rotation[1] !== 0 ||
                        transforms[candId].rotation[2] !== 0)
                    ) {
                      console.debug(
                        `[Registry] New Connection Detected - Resetting calibration for: ${candId}`,
                      );
                      transforms[candId] = {
                        ...transforms[candId],
                        rotation: [0, 0, 0], // Reset rotation to align with new identity frame
                      };
                      changed = true;
                    }
                  });
                }

                return changed ? { sensorTransforms: transforms } : {};
              });
              return {}; // Done handling NodeInfo
            }

            const packetSensorId = Number((data as IMUDataPacket).sensorId);
            if (!Number.isFinite(packetSensorId)) {
              return {};
            }

            // NOTE: Expected-range gating is handled upstream in useDeviceStore.
            // Do not hard-reject here, otherwise provisionally accepted sensors
            // (while discovery is unlocked) get clipped from the UI despite being
            // accepted by the ingest pipeline.
            if (
              !useNetworkStore.getState().isExpectedSensorId(packetSensorId)
            ) {
              const last =
                unexpectedRegistrySensorLogTime.get(packetSensorId) || 0;
              if (now - last > 2000) {
                unexpectedRegistrySensorLogTime.set(packetSensorId, now);
                console.warn(
                  `[DeviceRegistry] Processing unexpected sensorId=${packetSensorId} (accepted upstream while discovery unlocked)`,
                );
              }
            }

            // Use deviceId if provided (multi-device support), fallback to sensorId string
            const deviceId = data.deviceId || `sensor_${packetSensorId}`;

            // NOTE: sensorId 0 is now VALID for multi-sensor multiplexer nodes
            // Ghost sensor filtering moved to IMUParser where CRC + sanity checks catch corrupted packets
            // A valid TDMA packet with sensorId=0 means channel 0 of a PCA9548A multiplexer
            // REMOVED: Ghost sensor filter for sensorId 0
            // The TDMA parser validates: CRC integrity, sequential IDs, accel magnitude
            // If sensorId=0 reaches here from format 0x23/0x24, it's legitimate

            // REMOVED: Gateway rejection filter
            // Gateways advertise via BLE for control/monitoring but don't send sensor data
            // Nodes send data directly via TDMA packets (type 0x23) which bypass this registry
            // If a Gateway accidentally sends sensor-like data, it will fail sensorId check anyway

            // ================================================================
            // DT CALCULATION WITH JITTER COMPENSATION
            // ================================================================
            // The firmware samples at 200Hz internally (5ms) but transmits at
            // 50Hz (20ms frames). Packets arrive in bursts over BLE causing
            // measured dt to vary wildly (10ms to 60ms observed).
            //
            // Strategy:
            // 1. Use firmware timestamps as the source of truth
            // 2. Apply exponential smoothing to filter jitter
            // 3. Clamp to reasonable bounds (2ms to 50ms = 20Hz to 500Hz)
            // ================================================================
            // FIX: data.timestamp is in SECONDS (timestampUs / 1_000_000 from IMUParser).
            // Convert to milliseconds using timestampUs / 1000 for correct SampleRateMonitor
            // reporting and rawDt calculation.
            const imuData = data as IMUDataPacket;
            const packetTime =
              imuData.timestampUs != null
                ? imuData.timestampUs / 1000 // µs → ms (preferred, avoids float precision)
                : imuData.timestamp * 1000; // s → ms (fallback)
            const lastTime = lastTimestamps.get(deviceId);

            // PIPELINE FIX: Removed SampleRateMonitor.recordSample() call.
            // SyncedSampleStats.perSensorHz is the canonical firmware-timestamp Hz.
            // SampleRateMonitor was a duplicate tracker with a different window (5s vs 2s).

            // Calculate raw dt from firmware timestamps
            let rawDt = 0.005; // Default 200Hz if first packet
            if (lastTime !== undefined && packetTime > lastTime) {
              rawDt = (packetTime - lastTime) / 1000; // Convert ms to seconds
            } else if (lastTime !== undefined && packetTime < lastTime) {
              // Firmware timestamp went backwards — uint32 rollover or reset
              _dtRolloverCount++;
            }

            // Apply exponential smoothing to filter jitter
            // smoothedDt tracks per-device to handle different sensors independently
            let smoothedDt = smoothedDtCache.get(deviceId) ?? rawDt;

            // Smoothing factor: 0.3 = responsive but filters spikes
            // Higher = more responsive, lower = smoother
            const alpha = 0.3;

            // Only smooth if rawDt is reasonable (not a huge gap or negative)
            if (rawDt > 0.001 && rawDt < 0.5) {
              smoothedDt = alpha * rawDt + (1 - alpha) * smoothedDt;
            }
            smoothedDtCache.set(deviceId, smoothedDt);

            // Use smoothed dt for VQF, but clamp to safe bounds
            // Min: 2ms (500Hz max) - protects against timestamp quantization issues
            // Max: 50ms (20Hz min) - protects against large gaps causing drift
            let dt = Math.max(0.002, Math.min(0.05, smoothedDt));

            // Track clamp events for diagnostic visibility
            if (smoothedDt < 0.002) _dtClampMinCount++;
            if (smoothedDt > 0.05) _dtClampMaxCount++;

            lastTimestamps.set(deviceId, packetTime);

            let quaternion: [number, number, number, number] = [1, 0, 0, 0];
            const realData = data as IMUDataPacket;
            const existing = devices.get(deviceId);

            // Use correct property names: accelerometer, not accel!
            let accel = realData.accelerometer;
            let gyro = realData.gyro;

            // CACHE RAW (Truly form Wire)
            if (accel) deviceRawAccelCache.set(deviceId, [...accel]);
            if (gyro) deviceRawGyroCache.set(deviceId, [...gyro]);

            // AXIS DATA CORRECTION
            const axisCfg = state.axisConfig[deviceId];
            if (axisCfg && accel && gyro) {
              const aRaw = [...accel];
              const gRaw = [...gyro];
              // Apply permutation and sign
              accel = [
                aRaw[axisCfg.map[0]] * axisCfg.sign[0],
                aRaw[axisCfg.map[1]] * axisCfg.sign[1],
                aRaw[axisCfg.map[2]] * axisCfg.sign[2],
              ];
              gyro = [
                gRaw[axisCfg.map[0]] * axisCfg.sign[0],
                gRaw[axisCfg.map[1]] * axisCfg.sign[1],
                gRaw[axisCfg.map[2]] * axisCfg.sign[2],
              ];
            }

            // SCALE CORRECTION
            const scale = state.sensorScales[deviceId] ?? 1.0;
            if (scale !== 1.0 && accel) {
              accel = [accel[0] * scale, accel[1] * scale, accel[2] * scale];
            }

            // ================================================================
            // LOW-PASS FILTER (Optional - for noise reduction during tuning)
            // ================================================================
            if (state.lowPassEnabled && accel && gyro) {
              const stats = deviceStatsCache.get(deviceId);
              const sampleRate = stats?.hz || 120; // Default to 120Hz
              const alpha = cutoffToAlpha(state.lowPassCutoffHz, sampleRate);

              // Get or initialize filter state
              let lpState = lowPassCache.get(deviceId);
              if (!lpState) {
                // Initialize with current values (no jump on first sample)
                lpState = {
                  accel: [...accel] as [number, number, number],
                  gyro: [...gyro] as [number, number, number],
                };
                lowPassCache.set(deviceId, lpState);
              }

              // Apply filter
              accel = applyLowPass(accel, lpState.accel, alpha);
              gyro = applyLowPass(gyro, lpState.gyro, alpha);

              // Store for next iteration
              lpState.accel = accel;
              lpState.gyro = gyro;
            }

            // NOTE: Chirality fix removed — firmware now sends correct
            // right-handed frame [-X, +Y, -Z] directly (det = +1).
            // See: firmware/BigPicture/ORIENTATION_PIPELINE.md

            // ── Accel/gyro range monitoring (throttled) ──────────────────
            if (accel && gyro) {
              const rc = (_rangeCheckCounter.get(deviceId) ?? 0) + 1;
              _rangeCheckCounter.set(deviceId, rc);
              if (rc % RANGE_CHECK_INTERVAL === 0) {
                const aMag = Math.sqrt(
                  accel[0] ** 2 + accel[1] ** 2 + accel[2] ** 2,
                );
                const gMag = Math.sqrt(
                  gyro[0] ** 2 + gyro[1] ** 2 + gyro[2] ** 2,
                );
                let rv = _rangeViolations.get(deviceId);
                if (!rv) {
                  rv = {
                    accelOutOfRange: 0,
                    gyroNearSaturation: 0,
                    totalChecked: 0,
                  };
                  _rangeViolations.set(deviceId, rv);
                }
                rv.totalChecked++;
                if (aMag < ACCEL_MAG_MIN || aMag > ACCEL_MAG_MAX)
                  rv.accelOutOfRange++;
                if (gMag > GYRO_MAG_WARN) rv.gyroNearSaturation++;
              }
            }

            // Process sensor fusion (EKF) ONLY if raw data is available
            const hasRaw =
              accel && gyro && accel.length >= 3 && gyro.length >= 3;

            // Ensure uncertainty tracker exists per device.
            if (!uncertaintyTrackers.has(deviceId)) {
              uncertaintyTrackers.set(deviceId, new UncertaintyTracker());
            }

            // Initialize VQF filter if new (Moved here to access corrected accel)
            if (!filterRegistry.has(deviceId)) {
              console.debug(
                `[Registry] Initializing VQF Filter for ${deviceId}`,
              );
              const newVQF = new VQF(get().vqfConfig);
              // Initialize orientation from current accelerometer to avoid convergence lag
              if (accel) {
                // Accel is already scaled and axis-corrected here
                newVQF.initFromAccel([accel[0], accel[1], accel[2]]);
              }
              filterRegistry.set(deviceId, newVQF);
            }
            // Client fusion disabled

            // Calculate Stationary Status GLOBALLY
            let isStationary = false;
            if (hasRaw) {
              // Gyro is stored as rad/s in IMUDataPacket.
              // hasRaw checks accel && gyro exist
              const gxRad = gyro![0],
                gyRad = gyro![1],
                gzRad = gyro![2];
              const ax = accel[0],
                ay = accel[1],
                az = accel[2];
              const accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
              const gyroMagRad = Math.sqrt(
                gxRad * gxRad + gyRad * gyRad + gzRad * gzRad,
              );
              const zuptThresholdRad = state.zuptThreshold * (Math.PI / 180);
              // Thresholds: Accel near 1G (9.81 +/- 0.5), Gyro quiet (< threshold)
              isStationary =
                Math.abs(accelMag - 9.81) < 8.0 &&
                gyroMagRad < zuptThresholdRad;
            }

            // DIAGNOSTIC: Log code path count for first 5 packets of each device
            const pathCount = (diagPathCount.get(deviceId) || 0) + 1;
            diagPathCount.set(deviceId, pathCount);

            if (realData.quaternion) {
              // Ignore firmware quaternion (Identity) and use VQF
              // UNLESS it's a simulated device or special case?
              // For now, always overwrite with VQF if we have raw data.
            }

            if (hasRaw) {
              const vqf = filterRegistry.get(deviceId);
              if (vqf && gyro && accel) {
                // Subtract external gyroBias BEFORE feeding to VQF.
                // VQF's internal bias learning is DISABLED to prevent
                // double-subtraction drift. Our captured bias (from calibration)
                // is the single source of truth for bias correction.
                const bias = state.gyroBias[deviceId];
                const gx = gyro[0] - (bias?.x ?? 0);
                const gy = gyro[1] - (bias?.y ?? 0);
                const gz = gyro[2] - (bias?.z ?? 0);

                // Update Filter
                const scale = (window as any)._GLOBAL_GYRO_SCALE || 1.0;
                vqf.update(
                  dt,
                  [gx * scale, gy * scale, gz * scale],
                  [accel[0], accel[1], accel[2]],
                );

                const qThree = vqf.getQuaternion();
                quaternion = [qThree.w, qThree.x, qThree.y, qThree.z];

                // ── VQF divergence sampling (throttled) ──────────────────
                const vqfCount = (_vqfDiagCounter.get(deviceId) ?? 0) + 1;
                _vqfDiagCounter.set(deviceId, vqfCount);
                if (vqfCount % VQF_DIAG_INTERVAL === 0) {
                  const diag = vqf.getDiagnostics();
                  const prev = _vqfDiagState.get(deviceId);
                  const nowMs = performance.now();
                  let overSince = prev?.overThresholdSince ?? null;
                  let isDiverged = prev?.isDiverged ?? false;

                  if (diag.lastErrorDeg > VQF_DIVERGENCE_THRESHOLD_DEG) {
                    if (overSince === null) overSince = nowMs;
                    isDiverged = nowMs - overSince >= VQF_DIVERGENCE_SUSTAIN_MS;
                  } else {
                    overSince = null;
                    isDiverged = false;
                  }

                  _vqfDiagState.set(deviceId, {
                    lastErrorDeg: diag.lastErrorDeg,
                    maxErrorDeg: diag.maxErrorDeg,
                    updateCount: diag.updateCount,
                    overThresholdSince: overSince,
                    isDiverged,
                  });
                }

                // Sync isStationary status from filter to registry
                // The filter has better context aware rest detection
                // isStationary = vqf.isRestDetected(); // TODO: Expose this getter in VQF
              }
            } else if (realData.quaternion) {
              // Fallback to firmware if no raw (shouldn't happen with new fw)
              quaternion = realData.quaternion;
            } else {
              const existing = devices.get(deviceId);
              quaternion = existing ? existing.quaternion : [1, 0, 0, 0];
            }

            // Update Uncertainty Tracker + Tap Detection
            if (accel && gyro) {
              const tracker = uncertaintyTrackers.get(deviceId);
              if (tracker) {
                // Use correct methods
                tracker.propagateGyro(dt);

                const ax = accel[0],
                  ay = accel[1],
                  az = accel[2];
                const mag = Math.sqrt(ax * ax + ay * ay + az * az);

                // Units are m/s^2 (approx 9.81 for 1G)
                if (Math.abs(mag - 9.81) < 2.0) {
                  // Stationary check (approx 1G)
                  tracker.applyAccelCorrection(0.1);
                }

                // Wire ZUPT: when sensor is stationary, reduce yaw drift uncertainty
                if (isStationary) {
                  tracker.applyZUPT(0.8);
                }
              }

              // TAP DETECTION (Identify Sensor)
              // Threshold: > 3G (~30 m/s^2) to avoid false positives from gravity/motion
              const ax = accel[0],
                ay = accel[1],
                az = accel[2];
              const mag = Math.sqrt(ax * ax + ay * ay + az * az);
              const lastTap = existing?.lastTapTime || 0;
              // Debounce: 500ms
              if (mag > 30.0 && now - lastTap > 500) {
                console.debug(
                  `[DeviceRegistry] Tap detected on ${deviceId} (Mag: ${mag.toFixed(
                    2,
                  )} m/s²)`,
                );
                // Trigger update with new tap time
                // We'll update it in the set() below
                // Mutating a local var to be used in next block
                (realData as any)._tapTimestamp = now;
              }

              // Update High-Frequency Caches
              deviceAccelCache.set(deviceId, accel);
              if (gyro) {
                deviceGyroCache.set(deviceId, gyro);
              }
            }

            // Always update quaternion cache if we have one
            if (quaternion) {
              deviceQuaternionCache.set(deviceId, quaternion);

              // CRITICAL FIX: Write VQF-calculated quaternion back to the packet
              // so that Recording and ActivityEngine use the FUSED data, not the raw (static) firmware data.
              if (data && typeof data === "object" && "quaternion" in data) {
                (data as IMUDataPacket).quaternion = quaternion;
              }
            }

            const isNew = !existing;

            // CRITICAL OPTIMIZATION:
            // Do NOT update React state for every motion packet.
            // The UI only needs to know about presence/battery/connection.
            // Motion data is handled via the caches (quaternions/accel) which components read via refs/reqAnimFrame.

            // Hz Calculation (Update Cache) - Must run BEFORE optimization return
            // Uses sample counting over 1-second windows for accurate Hz with batched arrivals
            // PIPELINE FIX: Skip gap-filled synthetic packets — only count real data
            {
              const isFilledPacket = !!(realData as any).__filled;
              const stats = deviceStatsCache.get(deviceId) || {
                hz: 0,
                lastUpdate: now,
                sampleCount: 0,
                windowStart: now,
              };

              // Count samples in current 1-second window (skip gap-filled packets)
              if (!isFilledPacket) {
                stats.sampleCount = (stats.sampleCount || 0) + 1;
              }

              const windowDuration = now - (stats.windowStart || now);
              if (windowDuration >= 1000) {
                // Window complete - calculate Hz from actual sample count
                const sampleCount = stats.sampleCount ?? 0;
                const measuredHz = (sampleCount * 1000) / windowDuration;
                // Apply smoothing to reduce jitter
                stats.hz =
                  stats.hz === 0
                    ? measuredHz
                    : stats.hz * 0.7 + measuredHz * 0.3;
                // Reset window
                stats.sampleCount = 0;
                stats.windowStart = now;
              }

              stats.lastUpdate = now;
              deviceStatsCache.set(deviceId, stats);
            }

            if (!isNew && existing.isConnected) {
              // Only update if battery changed significantly, it's been a while (heartbeat), OR A TAP OCCURRED
              const batteryChanged =
                realData.battery !== undefined &&
                Math.abs(realData.battery - existing.battery) > 1;
              const timeToHeartbeat = now - existing.lastUpdate > 5000; // 5 seconds
              const tapDetected =
                (realData as any)._tapTimestamp &&
                (realData as any)._tapTimestamp !== existing.lastTapTime;
              const stationaryChanged = existing.isStationary !== isStationary;

              if (
                !batteryChanged &&
                !timeToHeartbeat &&
                !tapDetected &&
                !stationaryChanged
              ) {
                return {}; // Skip state update, preventing re-renders
              }
            }

            // Track first-seen time for establish detection (phantom sensor filter)
            if (!deviceFirstSeenTime.has(deviceId)) {
              deviceFirstSeenTime.set(deviceId, now);
            }

            devices.set(deviceId, {
              id: deviceId,
              name: (() => {
                const existingName = existing?.name;

                const sensorId =
                  realData.sensorId !== undefined
                    ? Number(realData.sensorId)
                    : undefined;

                // Register raw sensor ID for sequential display mapping
                if (sensorId !== undefined) {
                  registerSensorId(sensorId);
                }

                const networkState = useNetworkStore.getState();

                const nodeName =
                  sensorId !== undefined
                    ? networkState.getNodeNameForSensor(sensorId)
                    : null;

                const nodeSensorCount =
                  sensorId !== undefined
                    ? networkState.getNodeSensorCount(sensorId)
                    : undefined;

                const relativeIndex =
                  sensorId !== undefined
                    ? networkState.getSensorRelativeIndex(sensorId)
                    : null;

                // For single-sensor nodes (sensorCount === 1), omit the
                // redundant "/ Sensor 1" suffix — the node label alone
                // identifies the device.  Only show relative sensor index
                // when a node hosts multiple sensors (mux).
                const sensorLabel =
                  relativeIndex !== null && relativeIndex >= 0
                    ? `Sensor ${relativeIndex + 1}`
                    : sensorId !== undefined
                      ? getSensorDisplayName(sensorId)
                      : `Sensor ${deviceId}`;

                const firmwareDerived = (() => {
                  if (!nodeName) return sensorLabel;
                  // Suppress Gateway/USB prefixes
                  if (
                    nodeName.includes("Gateway") ||
                    nodeName.includes("USB")
                  ) {
                    return sensorLabel;
                  }
                  // Single-sensor node: just show node name (no "/ Sensor 1")
                  if (nodeSensorCount === 1) {
                    return nodeName;
                  }
                  return `${nodeName} / ${sensorLabel}`;
                })();

                // If we already have a human-assigned name, keep it.
                // If it's still the generic default, upgrade it once we know the node name.
                // Generic patterns include:
                //   - "Sensor 43"
                //   - "IMU 5 / Sensor 43" (legacy default)
                //   - "IMU Gateway / Sensor 0" (legacy default)
                //   - "Node 5 / Sensor 43" (placeholder until node info arrives)
                //   - "Node 5" (single-sensor node placeholder)
                //   - "MASH Gateway / Sensor 0" (placeholder)
                const isGeneric =
                  typeof existingName === "string" &&
                  (/^Sensor\s+\d+$/.test(existingName) ||
                    /^IMU\s+(\d+|Gateway)\s*\/\s*Sensor\s+\d+$/.test(
                      existingName,
                    ) ||
                    /^Node\s+\d+\s*\/\s*Sensor\s+\d+$/.test(existingName) ||
                    /^Node\s+\d+$/.test(existingName) ||
                    /^MASH\s+Gateway\s*\/\s*Sensor\s+\d+$/.test(existingName));

                return !existingName || isGeneric
                  ? firmwareDerived
                  : existingName;
              })(),
              quaternion: quaternion,
              accelerometer: accel || [0, 0, 0],
              gyro: gyro || [0, 0, 0],
              battery: realData.battery || existing?.battery || 100,
              isConnected: true,
              connectionHealth: "active",
              isSimulated: false,
              lastUpdate: now,
              lastTapTime:
                (realData as any)._tapTimestamp || existing?.lastTapTime || 0,
              isStationary: isStationary,
              format: realData.format || existing?.format,
            });

            return { devices };
          });
        },

        // NEW ACTIONS
        clear: () => {
          console.debug("[DeviceRegistry] Clearing all devices");
          deviceAccelCache.clear();
          deviceGyroCache.clear();
          deviceQuaternionCache.clear();
          deviceRawAccelCache.clear();
          deviceRawGyroCache.clear();
          deviceStatsCache.clear();
          smoothedDtCache.clear();
          lowPassCache.clear();
          filterRegistry.clear();
          lastTimestamps.clear();
          uncertaintyTrackers.clear();
          deviceFirstSeenTime.clear();
          diagFirstPacket.clear();
          diagRawLogTime.clear();
          diagZuptLogTime.clear();
          diagVqfProbeTime.clear();
          diagAxisLogTime.clear();
          diagPathCount.clear();
          diagNodeInfoLogTime.clear();
          unexpectedRegistrySensorLogTime.clear();
          resetRegistryStabilityDiagnostics();
          resetSensorRegistry();
          set({ devices: new Map() });
        },

        removeDevice: (deviceId) => {
          // FIX #12: Clear high-frequency caches to prevent memory leak
          deviceQuaternionCache.delete(deviceId);
          deviceAccelCache.delete(deviceId);
          deviceGyroCache.delete(deviceId);
          deviceRawAccelCache.delete(deviceId);
          deviceRawGyroCache.delete(deviceId);
          deviceStatsCache.delete(deviceId);
          smoothedDtCache.delete(deviceId);
          lowPassCache.delete(deviceId);
          filterRegistry.delete(deviceId);
          lastTimestamps.delete(deviceId);
          uncertaintyTrackers.delete(deviceId);

          set((state) => {
            const devices = new Map(state.devices);
            devices.delete(deviceId);
            // Explicit removal DOES NOT trigger "Unexpected Disconnection" alert
            return { devices };
          });

          console.debug(
            `[DeviceRegistry] Manually removed device ${deviceId} and cleared caches`,
          );
        },
      };
    },
    {
      name: "device-registry-storage",
      storage: createJSONStorage(() => localStorage), // Switch to localStorage for better persistence
      partialize: (state) => ({
        activeTemplate: state.activeTemplate,
        sensorTransforms: state.sensorTransforms,
        zuptThreshold: state.zuptThreshold, // Persist threshold settings
        vqfConfig: state.vqfConfig, // Persist VQF tuning
        axisConfig: state.axisConfig, // Persist Axis Correction
        sensorScales: state.sensorScales, // Persist Scale Correction
        gyroBias: state.gyroBias, // Persist captured gyro bias across sessions
        // useClientSideFusion removed
        // Don't persist devices (they need to reconnect)
      }),
      onRehydrateStorage: () => {
        return (rehydratedState, error) => {
          if (error) {
            console.error("[DeviceRegistry] Hydration failed:", error);
          } else {
            console.debug("[DeviceRegistry] Rehydrated state:", {
              transformsCount: Object.keys(
                rehydratedState?.sensorTransforms || {},
              ).length,
              threshold: rehydratedState?.zuptThreshold,
            });
          }
        };
      },
    },
  ),
);
