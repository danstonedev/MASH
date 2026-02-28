import { useRef, useEffect, useState, useMemo } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import * as THREE from "three";
import { getSensorData } from "../../hooks/useSensorData";
import {
  useDeviceRegistry,
  deviceQuaternionCache,
} from "../../store/useDeviceRegistry";
import { useCalibrationStore } from "../../store/useCalibrationStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useDeviceStore } from "../../store/useDeviceStore";
import { useTareStore } from "../../store/useTareStore";
import { useSensorAssignmentStore } from "../../store/useSensorAssignmentStore";
import { useMountingRotationStore } from "../../store/useMountingRotationStore";
import { useJointAnglesStore } from "../../store/useJointAnglesStore";

import { useTelemetryStore } from "../../store/useTelemetryStore";
import { useAnimations } from "@react-three/drei";
import { autoCalEngine } from "../../calibration/AutoCalEngine";
import { firmwareToThreeQuat } from "../../lib/math/conventions";
import { BoneTarget } from "./BoneTarget";
import { BodyRole } from "../../biomech/topology/SensorRoles";
import { fkSolver } from "../../biomech/ForwardKinematics";
import { getDriftMonitor } from "../../calibration/DriftMonitor";
import {
  SEGMENT_TO_BONE,
  BONE_TARGET_OFFSETS,
} from "../../biomech/boneMapping";
import { getSegmentDepth } from "../../biomech/segmentRegistry";

// Extracted, testable modules
import { orientationProcessor } from "./skeleton/OrientationProcessor";
import { floorGrounder } from "./skeleton/FloorGrounder";
import { footContactDetector } from "./skeleton/FootContactDetector";
import {
  extractBonesFromModel,
  computeTargetPose,
  logBonePositions,
} from "./skeleton/SkeletonLoader";

import {
  getSmoother,
  arrayToThreeQuat,
  copyToArray,
  clearAllSmoothers,
} from "../../lib/math/QuaternionPool";

// Adaptive frame rate throttling (200Hz data → 60Hz visualization)
import { visualizationThrottler } from "../../lib/visualization/VisualizationThrottler";

/**
 * Loads a Mixamo GLB model and drives its bones using simulator data.
 * Uses OpenSense-style calibration when available.
 *
 * ADAPTIVE VISUALIZATION:
 * - Data arrives at 200Hz (research-grade)
 * - Visualization renders at adaptive 30-120Hz (default 60Hz)
 * - Recording always captures full 200Hz
 */
export function SkeletonModel() {
  const groupRef = useRef<THREE.Group>(null!);
  const bonesRef = useRef<Map<string, THREE.Bone>>(new Map());
  const neutralQuatsRef = useRef<Map<string, THREE.Quaternion>>(new Map());

  // Smoothing now handled by QuaternionPool.getSmoother() registry

  // REUSABLE OBJECT POOL (Zero-Allocation Loop)
  const tempPool = useMemo(
    () => ({
      targetQuat: new THREE.Quaternion(),
      smoothedQuat: new THREE.Quaternion(),
      quatArray: [0, 0, 0, 1] as [number, number, number, number],
    }),
    [],
  );

  const [isReady, setIsReady] = useState(false);

  // Calib Store - show targets when connected and not yet calibrated
  const calibrationStep = useCalibrationStore((state) => state.calibrationStep);
  const cervicalStep = useCalibrationStore((state) => state.cervicalStep);
  const setTargetNeutralPose = useCalibrationStore(
    (state) => state.setTargetNeutralPose,
  );
  const isConnected = useDeviceStore((state) => state.isConnected);

  const { selectedSensorId } = useSensorAssignmentStore();

  // Show targets when:
  // 1. Connected to gateway AND model is ready AND not yet calibrated (body or cervical), OR
  // 2. A sensor is selected for assignment (allows re-assignment after calibration)
  const showTargets =
    isReady &&
    isConnected &&
    ((calibrationStep !== "calibrated" && cervicalStep !== "verification") ||
      selectedSensorId !== null);

  // FK Chain Mode - enables research-grade chain-driven skeleton
  // When enabled, bones propagate through kinematic chain (parent→child)
  // TEMPORARILY DISABLED: Testing direct bone-setting path with world→local fix
  const [useFKChain] = useState(false);

  // Track calibration state for one-time diagnostic logging
  const wasCalibrated = useRef(false);
  const pendingPostCalDeltaLogRef = useRef(false);
  const postCalDeltaRowsRef = useRef<
    Array<{
      segment: string;
      deltaDeg: number;
      rawEuler: string;
      calibratedEuler: string;
    }>
  >([]);

  // Drift monitor update throttle (per sensor) to avoid over-driving monitor state.
  // DriftMonitor is designed around ~10Hz updates rather than every render tick.
  const driftMonitorLastUpdateRef = useRef<Map<string, number>>(new Map());

  const gltf = useLoader(GLTFLoader, "/models/Neutral_Model.glb");

  // CRITICAL: Use SkeletonUtils.clone() for SkinnedMeshes!
  // Regular .clone() breaks the bone-to-mesh binding, causing bone rotations
  // to not affect the visible mesh.
  const model = useMemo(() => {
    const cloned = SkeletonUtils.clone(gltf.scene);
    return cloned;
  }, [gltf]);

  // FORCE STOP ANIMATIONS: Prevent any default animation from moving bones
  // Note: We use the gltf.scene directly since our groupRef might not be mounted yet
  const { actions } = useAnimations(gltf.animations || [], gltf.scene);
  useEffect(() => {
    Object.values(actions).forEach((action) => {
      if (action) {
        action.stop();
        action.enabled = false;
      }
    });
  }, [actions]);

  // Initialize Skeleton (via SkeletonLoader module)
  useEffect(() => {
    if (!model) return;

    // CRITICAL: Force matrix update to ensure World transforms are correct before extraction
    model.updateMatrixWorld(true);

    // Extract bones and neutral quaternions using SkeletonLoader
    const { bonesMap, neutralQuats } = extractBonesFromModel(model, true);

    // Copy to refs for use in animation loop
    bonesRef.current = bonesMap;
    neutralQuatsRef.current = neutralQuats;

    // Compute world-space target poses for calibration
    const poseMap = computeTargetPose(bonesMap, {
      segmentToBone: SEGMENT_TO_BONE,
      enableLogging: false,
    });
    setTargetNeutralPose(poseMap);

    console.debug(
      "[SkeletonModel] Bones loaded:",
      bonesMap.size,
      "bones. Setting isReady=true",
    );

    // Log bone positions for debugging
    logBonePositions(bonesMap, BONE_TARGET_OFFSETS);

    setIsReady(true);
  }, [model, setTargetNeutralPose]);

  // Track elapsed time for calculating frame delta (for playback timing)
  const lastElapsedTimeRef = useRef(0);

  // Get playback state for mode detection
  const playbackSessionId = usePlaybackStore((state) => state.sessionId);
  const isPlaybackMode = playbackSessionId !== null;

  // SYNCHRONOUS MODE TRACKING (Fixes "One Frame Swoop" artifact)
  // We must track mode changes inside useFrame to reset smoothers BEFORE
  // the first frame of math runs. useEffect is too slow (runs after paint).
  const prevModeRef = useRef(isPlaybackMode);

  useFrame((state, frameDelta) => {
    if (!isReady) return;

    // ADAPTIVE VISUALIZATION: Track render frame timing
    // Note: useFrame already runs at display refresh rate (60-144Hz)
    // The throttler tracks actual vs target FPS for diagnostics
    visualizationThrottler.recordRenderFrame();

    // SYNCHRONOUS RESET: Detect mode change immediately
    if (prevModeRef.current !== isPlaybackMode) {
      clearAllSmoothers();

      // RESET TIMING: Prevent "fast forward" on first frame
      // Set last elapsed time to NOW so the first delta is small/zero
      lastElapsedTimeRef.current = state.clock.elapsedTime;

      console.debug(
        `[SkeletonModel] Mode changed to ${
          isPlaybackMode ? "PLAYBACK" : "LIVE"
        } - Smoothers & Timing Reset (Sync)`,
      );
      prevModeRef.current = isPlaybackMode;
    }

    const boneMap = bonesRef.current;
    // const neutralQuats = neutralQuatsRef.current; // UNUSED? No, it's used in orientationProcessor.applyToBone via Ref, not local var
    // Access stores directly to avoid stale closures in loop
    const storeState = useCalibrationStore.getState();
    const deviceRegistry = useDeviceRegistry.getState();
    const playbackState = usePlaybackStore.getState(); // Get playback state

    // Unified assignment store
    const assignmentStore = useSensorAssignmentStore.getState();
    const headingResetOffset = storeState.headingResetOffset; // Read from calibration store

    // APPLY HEADING RESET (Global Y Rotation)
    if (groupRef.current) {
      groupRef.current.rotation.y = headingResetOffset;
    }

    // isPlaybackMode is now defined at component scope for sync reset tracking

    // NOTE: Playback tick is handled by PlaybackTicker component in ThreeView.tsx
    // Removed duplicate tick call here that was causing 2x playback speed

    let currentDevices: Map<string, any>; // Use generic map to support virtual devices

    if (isPlaybackMode) {
      // PLAYBACK MODE: Construct virtual devices from session sensors
      currentDevices = new Map();
      const sensorIds = playbackState.sensorIds;
      const sensorMapping = playbackState.sensorMapping || {};

      sensorIds.forEach((id) => {
        // Use session's stored sensor mapping (required for correct playback)
        // Fallback: If session has no mapping, try current live assignment by numeric ID
        // This handles device IDs like "USB 239a:8143_190" matching numeric sensor ID 190
        const segment =
          sensorMapping[id] || assignmentStore.getSegmentByNumericId(id);

        if (segment) {
          currentDevices.set(`Virtual-${id}`, {
            id: `IMU ${id}`,
            segment: segment,
            isConnected: true,
            quaternion: [1, 0, 0, 0], // Dummy, read from frame later
          });
        } else {
          // Old recording without mapping - can't reliably reconstruct
          console.warn(
            `[Playback] Sensor ${id} has no segment mapping in session (no match in sensorMapping or live assignments)`,
          );
        }
      });
    } else {
      // LIVE MODE: Use physical devices
      // Note: device object no longer has 'segment' - we must look it up in AssignmentStore
      currentDevices = deviceRegistry.devices;
    }

    // isCalibrated should be true for:
    // 1. Live mode with active calibration
    // 2. Playback mode (we assume if you're playing back, you want to see it)
    const isCalibrated =
      storeState.calibrationStep === "calibrated" ||
      storeState.cervicalStep === "verification" ||
      isPlaybackMode;

    // ONE-TIME calibration diagnostic: Log all offsets when first entering calibrated state
    if (isCalibrated && !wasCalibrated.current) {
      wasCalibrated.current = true;
      pendingPostCalDeltaLogRef.current = !isPlaybackMode;
      postCalDeltaRowsRef.current = [];
      // Reset head frame counter for fresh post-cal diagnostics
      (window as any).__headFrameCount = 0;
    } else if (!isCalibrated && wasCalibrated.current) {
      // Reset if calibration was reset
      wasCalibrated.current = false;
      pendingPostCalDeltaLogRef.current = false;
      postCalDeltaRowsRef.current = [];
    }

    // Debug logging every 5 seconds
    const frameCount = Math.floor(state.clock.elapsedTime * 60);
    const shouldLog = frameCount % 300 === 0;

    // =====================================================================
    // CALIBRATION FLOW DIAGNOSTIC - Logs every 5 seconds during calibration
    // =====================================================================
    if (shouldLog) {
      const calibStep = storeState.calibrationStep;
      console.debug(
        `[SkeletonModel] Frame ${frameCount}: calibrationStep="${calibStep}", devices=${currentDevices.size}, isCalibrated=${isCalibrated}`,
      );

      // Log cache status for first device
      const firstDevice = currentDevices.values().next().value;
      if (firstDevice) {
        const cacheQuat = (window as any).__deviceQuaternionCache?.get?.(
          firstDevice.id,
        );
        console.debug(
          `[SkeletonModel] Cache check for ${
            firstDevice.id
          }: quatInCache=${!!cacheQuat}`,
        );
      }
    }

    // Safety check - ensure devices is iterable
    if (!currentDevices || currentDevices.size === 0) {
      if (shouldLog)
        console.debug("[SkeletonModel] Early exit: No devices available");
      return;
    }

    // CRITICAL: Keep model in T-pose until calibration is complete.
    // Without this, the model will immediately contort to match the raw sensor orientation (often flat on a table),
    // causing user confusion before they have a chance to calibrate.
    if (!isCalibrated) {
      if (shouldLog) {
        console.debug(
          `[SkeletonModel] NOT CALIBRATED — calibrationStep="${storeState.calibrationStep}", ` +
            `cervicalStep="${storeState.cervicalStep}", playback=${isPlaybackMode}`,
        );
      }
      return; // Don't animate any bones before calibration
    }
    // Skip direct bone-setting when FK chain mode is active
    // FK mode handles all bone rotations via ForwardKinematics solver
    let bonesUpdated = 0; // DIAGNOSTIC counter
    if (!useFKChain) {
      // ── TOPOLOGICAL SORT ──────────────────────────────────────────────
      // Process parent segments before children so that:
      //   1. enforceHeadingCoherence reads the CORRECTED parent cache
      //   2. applyToBone's updateWorldMatrix sees fresh parent transforms
      // Convert Map → Array, resolve segment, sort by kinematic depth.
      const deviceArray = Array.from(currentDevices.values()).map((device) => {
        const segment = isPlaybackMode
          ? device.segment
          : assignmentStore.getSegmentForSensor(device.id);
        return { device, segment: segment as string | null };
      });
      deviceArray.sort(
        (a, b) =>
          getSegmentDepth(a.segment ?? "") - getSegmentDepth(b.segment ?? ""),
      );

      for (const { device, segment } of deviceArray) {
        if (!segment) {
          if (shouldLog)
            console.debug(
              `[SkeletonModel] Device ${device.id}: no segment assignment (assignments: ${assignmentStore.assignments.size})`,
            );
          continue;
        }

        const boneName = SEGMENT_TO_BONE[segment];
        if (!boneName) {
          if (shouldLog)
            console.debug(
              `[SkeletonModel] Segment "${segment}": no bone mapping`,
            );
          continue;
        }

        const bone = boneMap.get(boneName);
        if (!bone) {
          if (shouldLog)
            console.debug(`[SkeletonModel] Bone "${boneName}": not in boneMap`);
          continue;
        }

        // -------------------------------------------------------------------------
        // 2. FETCH DATA (Unified Path for Playback)
        // -------------------------------------------------------------------------

        if (isPlaybackMode) {
          // NEW UNIFIED PATH: Use processed segment quaternions from KinematicsEngine
          // These have L1 (Mounting), L2 (Heading), and L3 (Joint) tares ALREADY applied.
          const processedQuat = useJointAnglesStore
            .getState()
            .getSegmentQuaternion(segment);

          if (processedQuat) {
            const neutralQuat = neutralQuatsRef.current.get(boneName);

            // Cross-sensor heading coherence (playback mode)
            // enforceHeadingCoherence first (reads PARENT's cache), then cache
            // the corrected quat so CHILDREN see the post-correction heading.
            orientationProcessor.enforceHeadingCoherence(
              segment,
              processedQuat,
            );
            orientationProcessor.cacheWorldQuat(segment, processedQuat);

            // Apply directly to bone (handles parent-inverse and local/world conversion)
            orientationProcessor.applyToBone(
              bone,
              processedQuat,
              neutralQuat,
              segment,
            );

            // Log for diagnostics
            if (shouldLog && segment === "head") {
              const e = new THREE.Euler().setFromQuaternion(
                processedQuat,
                "XYZ",
              );
              console.debug(
                `[HeadMotion] Playback Body Quat: [${((e.x * 180) / Math.PI).toFixed(1)}, ${((e.y * 180) / Math.PI).toFixed(1)}, ${((e.z * 180) / Math.PI).toFixed(1)}]`,
              );
            }

            bonesUpdated++;
          }
          // Skip the legacy live-mode processing for this device
          continue;
        }

        // -------------------------------------------------------------------------
        // 3. FETCH DATA (Legacy Live Path)
        // -------------------------------------------------------------------------
        const sensorData = getSensorData(device.id);
        if (!sensorData) {
          if (shouldLog)
            console.debug(
              `[SkeletonModel] Device ${device.id}: no sensor data`,
            );
          continue;
        }

        // Track successful updates
        bonesUpdated++;

        // Destructure standardized data
        // Note: quatArray must be treated as immutable from the getter, so we copy if needed
        let { quaternion: quatArray } = sensorData;
        const { gyro } = sensorData;

        // Apply Mounting Tare (L1) - Legacy Live Mode Logic
        const mountingOffsetArr = deviceRegistry.mountingOffsets?.[device.id];
        if (mountingOffsetArr) {
          // Reuse temp pool for fast multiplication
          const qSensor = tempPool.targetQuat;
          arrayToThreeQuat(quatArray, qSensor);

          const qOffset = tempPool.smoothedQuat; // Borrow this temporarily
          arrayToThreeQuat(mountingOffsetArr, qOffset);

          // CORRECT: sensor × offset
          qSensor.multiply(qOffset);

          // Write back to temp array
          copyToArray(qSensor, tempPool.quatArray);
          quatArray = tempPool.quatArray;
        }

        // DIAGNOSTIC: Log raw cache value for first device once per second
        if (shouldLog && segment === "thigh_r") {
          const rawCache = (window as any).__deviceQuaternionCache?.get?.(
            device.id,
          );
          console.debug(
            `[SkeletonModel] RAW CACHE ${device.id}: [${
              rawCache?.map((v: number) => v.toFixed(3)).join(", ") || "null"
            }]`,
          );
          console.debug(
            `[SkeletonModel] getSensorData returned: [${quatArray
              .map((v) => v.toFixed(3))
              .join(", ")}]`,
          );
        }

        // -------------------------------------------------------------------------
        // 3. SMOOTHING (Pre-Process) - DISABLED FOR DEBUGGING
        // -------------------------------------------------------------------------

        // Convert to THREE.Quaternion (Reusing tempPool.targetQuat)
        arrayToThreeQuat(quatArray, tempPool.targetQuat);

        // SMOOTHING DISABLED: Pass through raw quaternion for debugging axis issues
        // TODO: Re-enable smoothing once axis mapping is confirmed correct
        tempPool.smoothedQuat.copy(tempPool.targetQuat);

        // Write smoothed result back to temp array for the processor
        copyToArray(tempPool.smoothedQuat, tempPool.quatArray);

        // DIAGNOSTIC: Log smoothing effect
        if (shouldLog && segment === "thigh_r") {
          console.debug(
            `[SkeletonModel] AFTER PROCESSING: [${tempPool.quatArray
              .map((v) => v.toFixed(3))
              .join(", ")}], mode=${isPlaybackMode ? "PLAYBACK" : "LIVE"}`,
          );
        }

        quatArray = tempPool.quatArray;

        // -------------------------------------------------------------------------
        // 4. ORIENTATION PIPELINE
        // -------------------------------------------------------------------------
        const tareState = useTareStore.getState().getTareState(segment);
        const mountingStore = useMountingRotationStore.getState();
        const mountingRot = mountingStore.getMountingRotation(device.id);

        // DIAGNOSTIC: Log tare state once per second
        if (shouldLog) {
          const hasTare = tareState && tareState.mountingTareTime > 0;
          console.debug(
            `[SkeletonModel] Segment "${segment}" tare: ${
              hasTare ? "HAS TARE" : "NO TARE (identity)"
            }`,
          );
        }

        const calibData = storeState.getCalibration(segment);
        const calibrationOffset = calibData ? calibData.offset : undefined;

        // DIAGNOSTIC CHECK for Opposite Direction
        if (shouldLog && segment === "head") {
          if (calibrationOffset) {
            const e = new THREE.Euler().setFromQuaternion(
              calibrationOffset,
              "XYZ",
            );
            console.debug(
              `[SkeletonModel] head Offset: [${calibrationOffset.toArray().map((v) => v.toFixed(3))}], Euler: ${e.x.toFixed(2)}, ${e.y.toFixed(2)}, ${e.z.toFixed(2)}`,
            );
          } else {
            console.debug(`[SkeletonModel] head Offset: MISSING`);
          }
        }

        const orientationResult = orientationProcessor.processQuaternion(
          quatArray,
          segment,
          tareState,
          {
            // Prevent Double Application: If Functional Cal (TareState) exists, ignore Manual Mounting.
            mountingRotation:
              tareState && tareState.mountingTareTime > 0
                ? undefined
                : mountingRot || undefined,
            // calibrationOffset: calibrationOffset, // REMOVED: Legacy double-application. TareState handles L1 Mounting Tare.
            enableLogging: shouldLog,
          },
        );

        if (orientationResult) {
          if (pendingPostCalDeltaLogRef.current && !isPlaybackMode) {
            const rawQuat = new THREE.Quaternion(
              quatArray[1],
              quatArray[2],
              quatArray[3],
              quatArray[0],
            );
            const deltaDeg =
              (rawQuat.angleTo(orientationResult.worldQuat) * 180) / Math.PI;

            const rawEuler = new THREE.Euler().setFromQuaternion(
              rawQuat,
              "XYZ",
            );
            const calibratedEuler = new THREE.Euler().setFromQuaternion(
              orientationResult.worldQuat,
              "XYZ",
            );

            postCalDeltaRowsRef.current.push({
              segment,
              deltaDeg,
              rawEuler: `${((rawEuler.x * 180) / Math.PI).toFixed(1)}, ${((rawEuler.y * 180) / Math.PI).toFixed(1)}, ${((rawEuler.z * 180) / Math.PI).toFixed(1)}`,
              calibratedEuler: `${((calibratedEuler.x * 180) / Math.PI).toFixed(1)}, ${((calibratedEuler.y * 180) / Math.PI).toFixed(1)}, ${((calibratedEuler.z * 180) / Math.PI).toFixed(1)}`,
            });
          }

          // ── CROSS-SENSOR HEADING COHERENCE ──
          // enforceHeadingCoherence first (reads PARENT's cached quat), then
          // cache the corrected quat so CHILD segments see the post-correction
          // heading. Previous order cached pre-correction values, causing
          // grandchildren to reference uncorrected parent headings.
          orientationProcessor.enforceHeadingCoherence(
            segment,
            orientationResult.worldQuat,
          );
          orientationProcessor.cacheWorldQuat(
            segment,
            orientationResult.worldQuat,
          );

          // Apply to Bone
          // Pass neutralQuat for ROM constraint calculation (constraints apply to deviation from rest)
          const neutralQuat = neutralQuatsRef.current.get(boneName);
          orientationProcessor.applyToBone(
            bone,
            orientationResult.worldQuat,
            neutralQuat,
            segment,
          );

          // HEAD MOTION DIAGNOSTIC (first 5 frames post-cal + every 10s)
          if (segment === "head") {
            const headFrameCount = (window as any).__headFrameCount || 0;
            if (wasCalibrated.current)
              (window as any).__headFrameCount = headFrameCount + 1;
            if (
              (wasCalibrated.current && headFrameCount < 5) ||
              (segment === "head" && shouldLog)
            ) {
              const e = new THREE.Euler().setFromQuaternion(
                orientationResult.worldQuat,
                "XYZ",
              );
              const boneE = new THREE.Euler().setFromQuaternion(
                bone.quaternion,
                "XYZ",
              );
              const rad2deg = 180 / Math.PI;
              console.debug(
                `[HeadMotion] #${headFrameCount} Raw:[${quatArray.map((v) => v.toFixed(3)).join(",")}] ` +
                  `World:[${(e.x * rad2deg).toFixed(1)},${(e.y * rad2deg).toFixed(1)},${(e.z * rad2deg).toFixed(1)}] ` +
                  `Bone:[${(boneE.x * rad2deg).toFixed(1)},${(boneE.y * rad2deg).toFixed(1)},${(boneE.z * rad2deg).toFixed(1)}]`,
              );
            }
          }

          // DIAGNOSTIC: Track foot/knee bone updates specifically
          if ((segment === "foot_l" || segment === "tibia_l") && shouldLog) {
            const e = new THREE.Euler().setFromQuaternion(
              bone.quaternion,
              "XYZ",
            );
            const rad2deg = 180 / Math.PI;
            console.debug(
              `[BoneTrack] ${segment} → ${boneName} → [${(e.x * rad2deg).toFixed(1)}°, ${(
                e.y * rad2deg
              ).toFixed(1)}°, ${(e.z * rad2deg).toFixed(1)}°]`,
            );
          }

          // Debug Logging for Hip Check
          if (boneName === "mixamorig1RightUpLeg" && shouldLog) {
            const e = new THREE.Euler().setFromQuaternion(
              bone.quaternion,
              "XYZ",
            );
            const rad2deg = 180 / Math.PI;
            console.debug(
              `[HipDebug] RightUpLeg: [${(e.x * rad2deg).toFixed(1)}, ${(
                e.y * rad2deg
              ).toFixed(1)}, ${(e.z * rad2deg).toFixed(1)}]`,
            );
          }
        }
      }

      // DIAGNOSTIC: Summary log
      if (shouldLog) {
        console.debug(
          `[SkeletonModel] Frame summary: ${bonesUpdated}/${currentDevices.size} bones updated`,
        );
      }

      if (pendingPostCalDeltaLogRef.current && !isPlaybackMode) {
        const rows = postCalDeltaRowsRef.current
          .slice()
          .sort((a, b) => b.deltaDeg - a.deltaDeg)
          .map((row) => ({
            Segment: row.segment,
            DeltaDeg: row.deltaDeg.toFixed(1),
            RawEulerXYZ: row.rawEuler,
            CalibratedEulerXYZ: row.calibratedEuler,
          }));

        if (rows.length > 0) {
          console.debug(
            "[PostCalDelta] First calibrated-frame segment deltas",
            rows,
          );
        }

        pendingPostCalDeltaLogRef.current = false;
        postCalDeltaRowsRef.current = [];
      }
    } // End of if (!useFKChain)

    // 1.5 Auto-Calibration Runtime Corrections
    const ENABLE_AUTO_CAL_ENGINE = false; // Disabled: causing model distortion
    if (ENABLE_AUTO_CAL_ENGINE && isCalibrated) {
      autoCalEngine.processFrame();
    }

    // 1.6 FK Chain Mode
    if (useFKChain && isCalibrated) {
      // Ensure DriftMonitor is actively updated before FK consumes yaw corrections.
      // Live mode only (playback uses virtual sensors and should not mutate monitor state).
      if (!isPlaybackMode) {
        const nowMs = Date.now();
        const DRIFT_MONITOR_UPDATE_INTERVAL_MS = 100;

        currentDevices.forEach((device) => {
          const segment = assignmentStore.getSegmentForSensor(device.id);
          if (!segment) return;
          if (!deviceQuaternionCache.get(device.id)) return;

          const lastUpdate =
            driftMonitorLastUpdateRef.current.get(device.id) || 0;
          if (nowMs - lastUpdate < DRIFT_MONITOR_UPDATE_INTERVAL_MS) return;

          getDriftMonitor(device.id).processFrame();
          driftMonitorLastUpdateRef.current.set(device.id, nowMs);
        });
      }

      const sensorDataForFK = new Map<string, THREE.Quaternion>();
      const mountingStore = useMountingRotationStore.getState();
      const tareStore = useTareStore.getState();

      currentDevices.forEach((device) => {
        const segment = isPlaybackMode
          ? device.segment
          : assignmentStore.getSegmentForSensor(device.id);

        if (!segment) return;

        const quatArray = deviceQuaternionCache.get(device.id);
        if (!quatArray) return;

        // 1. Pass Raw IMU Data (World Frame)
        const imuQuat = firmwareToThreeQuat(quatArray);
        // Note: We do NOT multiply by calibration offset here!
        // FKSolver does it internally now.
        sensorDataForFK.set(device.id, imuQuat); // Pass by SensorID, not Segment (FKSolver maps from SensorID)

        // 2. Inject Mounting Rotation
        const mountingRot = mountingStore.getMountingRotation(device.id);
        if (mountingRot) {
          fkSolver.setMountingRotation(device.id, mountingRot);
        }

        // 3. Inject Tare State
        const tareState = tareStore.getTareState(segment);
        if (tareState) {
          fkSolver.setTareState(
            segment,
            tareState.mountingTare,
            tareState.headingTare,
          );
        }

        // 4. Ensure Sensor Assignment in Solver
        const calibData = storeState.getCalibration(segment);
        if (calibData) {
          // FIXED: calibData declaration was accidentally removed in previous step
          // Update solver assignment map if needed
          // Note: FKSolver stores this in 'bones', which are persistent.
          // We should call assignSensor ONLY if needed, or rely on solver state.
          // For safety in this reactive loop, we can re-assign or check.
          // But assignSensor is cheap? No, it looks up map.
          // Let's assume solver is initialized. But wait, calibration might change.
          // Ideally we call assignSensor once when calibration changes.
          // For now, let's call it here to be safe (it just updates a ref).

          // FIXED: FKSolver expects internal Bone IDs (e.g. THIGH_L), not GLTF names.
          // The 'segment' variable is 'thigh_l', so toUpperCase() matches FKSolver keys.
          // MAPPING: thigh_l -> THIGH_L
          fkSolver.assignSensor(
            segment.toUpperCase(),
            device.id,
            calibData.offset,
          );
        }
      });

      fkSolver.update(sensorDataForFK, groupRef.current.position);
      const fkTransforms = fkSolver.getAllTransforms();
      fkTransforms.forEach((transform, segmentId) => {
        const boneName = SEGMENT_TO_BONE[segmentId.toLowerCase()];
        if (!boneName) return;
        const bone = boneMap.get(boneName);
        if (bone) {
          // Convert world-frame rotation to LOCAL space
          if (bone.parent) {
            const parentWorld = new THREE.Quaternion();
            bone.parent.getWorldQuaternion(parentWorld);
            const localQuat = parentWorld
              .clone()
              .invert()
              .multiply(transform.rotation);
            bone.quaternion.copy(localQuat);
          } else {
            bone.quaternion.copy(transform.rotation);
          }
        }
      });
    }

    // 2. Kinematic Grounding (via FloorGrounder module)
    if (!isCalibrated) {
      groupRef.current.position.y = 0;
      return;
    }

    // Update matrix world for accurate foot positions
    groupRef.current.position.y = 0;
    groupRef.current.updateMatrixWorld(true);

    // 2.1 ZUPT Foot Contact Detection
    // Process foot sensors to detect stance phase for improved grounding accuracy
    // Look for foot_l and foot_r sensor data
    const footLeftDevice = Array.from(currentDevices.values()).find((d) => {
      const seg = isPlaybackMode
        ? d.segment
        : assignmentStore.getSegmentForSensor(d.id);
      return seg === "foot_l";
    });
    const footRightDevice = Array.from(currentDevices.values()).find((d) => {
      const seg = isPlaybackMode
        ? d.segment
        : assignmentStore.getSegmentForSensor(d.id);
      return seg === "foot_r";
    });

    // Process left foot
    if (footLeftDevice) {
      const sensorData = getSensorData(footLeftDevice.id);
      if (sensorData) {
        const { acceleration: accel, gyro, isStationary } = sensorData;
        if (accel.length >= 3 && gyro.length >= 3) {
          footContactDetector.processFootSensor(
            "left",
            accel as [number, number, number],
            gyro as [number, number, number],
            frameDelta,
            isStationary, // TRUST THE EDGE
          );
        }
      }
    }

    // Process right foot
    if (footRightDevice) {
      const sensorData = getSensorData(footRightDevice.id);
      if (sensorData) {
        const { acceleration: accel, gyro, isStationary } = sensorData;
        if (accel.length >= 3 && gyro.length >= 3) {
          footContactDetector.processFootSensor(
            "right",
            accel as [number, number, number],
            gyro as [number, number, number],
            frameDelta,
            isStationary, // TRUST THE EDGE
          );
        }
      }
    }

    // Get foot bones (prefer toe bones for more accurate floor contact)
    const leftToe =
      boneMap.get("mixamorig1LeftToeBase") ||
      boneMap.get("mixamorig1LeftToe_End");
    const rightToe =
      boneMap.get("mixamorig1RightToeBase") ||
      boneMap.get("mixamorig1RightToe_End");
    const leftFoot = leftToe || boneMap.get(SEGMENT_TO_BONE["foot_l"]) || null;
    const rightFoot =
      rightToe || boneMap.get(SEGMENT_TO_BONE["foot_r"]) || null;

    // Compute grounding using FloorGrounder
    // Note: ZUPT contact info is available via footContactDetector.getGroundedFoot() if needed
    const groundingResult = floorGrounder.computeGroundOffset(
      leftFoot as THREE.Bone | null,
      rightFoot as THREE.Bone | null,
      groupRef.current.position,
    );

    // Apply to group with smooth interpolation
    floorGrounder.applyToGroup(groupRef.current, groundingResult);
  });

  const handleSurfaceClick = (e: any) => {
    if (!useDeviceRegistry.getState().isPlacementMode) return;
    const selectedId = useTelemetryStore.getState().selectedSensorId;
    if (!selectedId) return;

    e.stopPropagation();

    // Get segment from assignment store
    const { getSegmentForSensor } = useSensorAssignmentStore.getState();
    const segment = getSegmentForSensor(selectedId);
    if (!segment) return;

    const boneName = SEGMENT_TO_BONE[segment];
    const bone = bonesRef.current.get(boneName);

    if (bone) {
      const hitPoint = e.point.clone();
      const normal = e.face.normal.clone();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(
        e.object.matrixWorld,
      );
      const worldNormal = normal.applyMatrix3(normalMatrix).normalize();
      const localPos = bone.worldToLocal(hitPoint.clone());
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        worldNormal,
      );
      const boneWorldQuat = new THREE.Quaternion();
      bone.getWorldQuaternion(boneWorldQuat);
      const localQuat = boneWorldQuat.invert().multiply(alignQuat);
      const sensorUpLocal = new THREE.Vector3(0, 1, 0).applyQuaternion(
        localQuat,
      );
      const heightOffset = (0.015 * 60.0) / 2.0;
      localPos.add(sensorUpLocal.multiplyScalar(heightOffset));

      useDeviceRegistry.getState().updateSensorTransform(selectedId, {
        position: localPos.toArray(),
        rotation: new THREE.Euler().setFromQuaternion(localQuat).toArray() as [
          number,
          number,
          number,
        ],
      });
    }
  };

  // Selected ID from store
  // Selected ID from store
  // const selectedId = useTelemetryStore(state => state.selectedSensorId);
  // const isPlacementMode = useDeviceRegistry(state => state.isPlacementMode);
  // const placementType = useDeviceRegistry(state => state.placementType);
  // const updateSensorTransform = useDeviceRegistry(state => state.updateSensorTransform);

  return (
    <group ref={groupRef} position={[0, 0, 0]} scale={[1, 1, 1]}>
      {/* Model Geometry */}
      <primitive object={model} onClick={handleSurfaceClick} />

      {/* Visual Targets (Interactive Spheres on bones) */}
      {showTargets &&
        Object.entries(BONE_TARGET_OFFSETS).map(([role, config]) => (
          <BoneTarget
            key={role}
            role={role as BodyRole}
            bone={bonesRef.current.get(config.boneName) || null}
            offset={new THREE.Vector3(...config.offset)}
          />
        ))}
    </group>
  );
}
