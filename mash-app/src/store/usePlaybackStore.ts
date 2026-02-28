/**
 * Session Playback Store
 * =======================
 *
 * Manages playback of recorded sessions with full video-player-style controls:
 * - Play/Pause with spacebar
 * - Frame-by-frame stepping (arrow keys)
 * - Speed control (0.25x - 4x)
 * - Timeline scrubbing
 * - A-B looping
 */

import { create } from "zustand";
import * as THREE from "three";
import {
  db,
  dataManager,
  type RecordedFrame,
  type RecordingSession,
  type SerializedCalibrationOffset,
} from "../lib/db";
import { getTareStore } from "./StoreRegistry";
import { KinematicsEngine } from "../biomech/KinematicsEngine";
import { useSensorAssignmentStore } from "./useSensorAssignmentStore";
import {
  preparePlaybackSession,
  type PackedSensorTimeline,
  type PreparePlaybackSessionResult,
} from "../lib/playback/preparePlaybackSession";

// ============================================================================
// TYPES
// ============================================================================

export interface PlaybackState {
  // Session data
  sessionId: string | null;
  sessionName: string | null;
  frames: RecordedFrame[];
  framesBySensor: Map<number, RecordedFrame[]>;
  packedTimelinesBySensor: Map<number, PackedSensorTimeline>;
  duration: number; // Total duration in ms
  sensorIds: number[]; // List of sensors in session
  sensorMapping: Record<number, string>; // ID -> Segment mapping
  calibrationOffsets: SerializedCalibrationOffset[]; // Stored calibration for playback

  // Playback state
  isLoadingSession: boolean;
  isPlaying: boolean;
  currentTime: number; // Current position in ms
  playbackSpeed: number; // 0.25, 0.5, 1, 2, 4

  // A-B Loop
  loopStart: number | null;
  loopEnd: number | null;
  isLooping: boolean;

  // Frame info
  frameRate: number; // Detected sample rate
  totalFrames: number;
  currentFrameIndex: number;

  // Actions
  loadSession: (sessionId: string) => Promise<boolean>;
  unloadSession: () => void;

  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  stop: () => void;

  seek: (time: number) => void;
  seekPercent: (percent: number) => void;
  stepForward: () => void;
  stepBackward: () => void;

  setSpeed: (speed: number) => void;

  setLoopStart: (time: number) => void;
  setLoopEnd: (time: number) => void;
  setLoop: (start: number, end: number) => void;
  clearLoop: () => void;
  toggleLooping: () => void;

  // Frame access for SkeletonModel
  getFrameAtTime: (sensorId: number) => RecordedFrame | null;
  getInterpolatedFrame: (
    sensorId: number,
  ) => { quaternion: THREE.Quaternion; gyro: number[] } | null;
  getQuaternionAtTime: (sensorId: number) => THREE.Quaternion | null;
  getCalibrationOffset: (
    segmentId: string,
  ) => SerializedCalibrationOffset | null;

  // Playback tick (called from animation loop)
  tick: (deltaTime: number) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4];
const DEFAULT_FRAME_RATE = 60; // Hz
const PACKED_TIMELINE_MEMORY_THINNING = true;
const PACKED_THINNING_FRAME_THRESHOLD = 50000;

// ============================================================================
// STORE
// ============================================================================

// Guard against double-tick from React StrictMode (two component instances)
let lastTickTime = 0;

// ============================================================================
// OBJECT POOL (Performance: Avoids creating new objects every frame)
// ============================================================================
// Reusable objects for interpolation to reduce GC pressure during playback.
// WARNING: These are shared - consumer must use result immediately or clone!
const _poolQPrev = new THREE.Quaternion();
const _poolQNext = new THREE.Quaternion();
const _poolQResult = new THREE.Quaternion();
const _poolGyroResult: [number, number, number] = [0, 0, 0];

async function preparePlaybackInWorker(
  frames: RecordedFrame[],
  session: RecordingSession,
): Promise<PreparePlaybackSessionResult> {
  if (typeof Worker === "undefined") {
    throw new Error("Worker is not available in this environment");
  }

  const worker = new Worker(
    new URL("../workers/playbackPreparationWorker.ts", import.meta.url),
    { type: "module" },
  );

  return await new Promise<PreparePlaybackSessionResult>((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (data?.ok) {
        cleanup();
        resolve(data.result as PreparePlaybackSessionResult);
      } else {
        cleanup();
        reject(new Error(data?.error || "Playback worker failed"));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Playback worker crashed"));
    };

    worker.postMessage({
      frames,
      sessionStartTime: session.startTime,
      sessionEndTime: session.endTime,
      defaultFrameRate: DEFAULT_FRAME_RATE,
    });
  });
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  // Initial state
  sessionId: null,
  sessionName: null,
  frames: [],
  framesBySensor: new Map(),
  packedTimelinesBySensor: new Map(),
  duration: 0,
  sensorIds: [],
  sensorMapping: {},
  calibrationOffsets: [],

  isLoadingSession: false,
  isPlaying: false,
  currentTime: 0,
  playbackSpeed: 1,

  loopStart: null,
  loopEnd: null,
  isLooping: false,

  frameRate: DEFAULT_FRAME_RATE,
  totalFrames: 0,
  currentFrameIndex: 0,

  // ========================================================================
  // SESSION LOADING
  // ========================================================================

  loadSession: async (sessionId: string) => {
    console.debug(`[Playback] Loading session: ${sessionId}`);
    set({ isLoadingSession: true });

    try {
      const t0 = performance.now();

      // Fetch session metadata
      const session = await dataManager.getSession(sessionId);
      const tAfterSessionFetch = performance.now();

      if (!session) {
        console.error(`[Playback] Session not found: ${sessionId}`);
        return false;
      }

      // Load all frames for this session
      const frames = await dataManager.exportSessionData(sessionId);
      const tAfterFramesFetch = performance.now();

      if (frames.length === 0) {
        console.warn(`[Playback] No frames in session: ${sessionId}`);
        return false;
      }

      let prepared: PreparePlaybackSessionResult;
      let workerUsed = true;
      try {
        prepared = await preparePlaybackInWorker(frames, session);
      } catch (workerError) {
        workerUsed = false;
        console.warn(
          "[Playback] Worker preparation failed, falling back to main thread:",
          workerError,
        );
        prepared = preparePlaybackSession({
          frames,
          sessionStartTime: session.startTime,
          sessionEndTime: session.endTime,
          defaultFrameRate: DEFAULT_FRAME_RATE,
        });
      }
      const tAfterPrepare = performance.now();

      const preparedFrames = prepared.frames;
      const duration = prepared.duration;
      const frameRate = prepared.frameRate;
      const sensorIds = prepared.sensorIds;

      const framesBySensor = new Map<number, RecordedFrame[]>();
      for (const [sensorIdStr, sensorFrames] of Object.entries(
        prepared.groupedFramesBySensor,
      )) {
        framesBySensor.set(Number(sensorIdStr), sensorFrames);
      }

      const packedTimelinesBySensor = new Map<number, PackedSensorTimeline>();
      for (const [sensorIdStr, timeline] of Object.entries(
        prepared.packedTimelinesBySensor,
      )) {
        packedTimelinesBySensor.set(Number(sensorIdStr), timeline);
      }

      const shouldUsePackedOnly =
        PACKED_TIMELINE_MEMORY_THINNING &&
        packedTimelinesBySensor.size > 0 &&
        preparedFrames.length >= PACKED_THINNING_FRAME_THRESHOLD;

      const framesForStore = shouldUsePackedOnly ? [] : preparedFrames;
      const framesBySensorForStore = shouldUsePackedOnly
        ? new Map<number, RecordedFrame[]>()
        : framesBySensor;

      if (shouldUsePackedOnly) {
        console.info(
          `[Playback] Memory thinning enabled: using packed timelines only for ${preparedFrames.length} frames (${packedTimelinesBySensor.size} sensors)`,
        );
      }

      console.debug(
        `[Playback] Loaded ${preparedFrames.length} frames, ${framesBySensor.size} sensors, ${(duration / 1000).toFixed(1)}s @ ${frameRate}Hz`,
      );

      // Extract sensor mapping - check top-level first (new schema), then config (legacy)
      const sensorMapping = session.sensorMapping || {};

      // Extract calibration offsets for playback
      const calibrationOffsets = session.calibrationOffsets || [];
      console.debug(`[Playback] Session metadata:`);
      console.debug(
        `  - Sensor mapping: ${Object.keys(sensorMapping).length} sensors`,
      );
      Object.entries(sensorMapping).forEach(([id, seg]) => {
        console.debug(`    Sensor ${id} -> ${seg}`);
      });
      console.debug(
        `  - Calibration offsets: ${calibrationOffsets.length} segments`,
      );
      calibrationOffsets.forEach((o) => {
        console.debug(
          `    ${o.segmentId}: [${o.offset.map((n: number) => n.toFixed(4)).join(", ")}] q=${o.quality}`,
        );
      });

      // Load tare states for full orientation pipeline
      // FIX: Always reset TareStore first to avoid mixing live/recorded state
      try {
        const tareStore = getTareStore();
        tareStore.getState().resetAll();

        if (session.tareStates && session.tareStates.length > 0) {
          console.debug(
            `  - Tare states: ${session.tareStates.length} segments`,
          );
          tareStore.getState().deserialize(session.tareStates);
          console.debug(
            `[Playback] Loaded ${session.tareStates.length} tare states into TareStore`,
          );
        }
        // NOTE: Legacy calibrationOffset migration removed - old recordings
        // with broken orientation math are not supported. Re-record.
      } catch (e) {
        console.warn(
          "[Playback] TareStore not available or failed to load:",
          e,
        );
      }

      // =====================================================================
      // HEAL ON LOAD: Fix incorrect metadata (Hz, SensorCount, Duration)
      // =====================================================================
      // Heal the DB so the session list shows correct values.
      // Duration is based on actual data span (systemTime), not button presses.
      const correctEndTime = session.startTime + duration;
      const shouldHeal =
        session.sampleRate !== frameRate ||
        session.sensorCount !== sensorIds.length ||
        Math.abs((session.endTime ?? 0) - correctEndTime) > 100;

      if (shouldHeal) {
        console.debug(
          `[Playback] Healing session metadata: ${session.sampleRate}Hz -> ${frameRate}Hz, ` +
            `${session.sensorCount} -> ${sensorIds.length} sensors, ` +
            `endTime ${session.endTime} -> ${correctEndTime} (duration ${(duration / 1000).toFixed(2)}s)`,
        );
        await db.sessions.update(sessionId, {
          sampleRate: frameRate,
          sensorCount: sensorIds.length,
          endTime: correctEndTime,
        });
      }
      const tAfterHeal = performance.now();

      set({
        sessionId,
        sessionName: session.name,
        frames: framesForStore,
        framesBySensor: framesBySensorForStore,
        packedTimelinesBySensor,
        duration,
        sensorIds,
        sensorMapping,
        calibrationOffsets,
        frameRate,
        totalFrames: preparedFrames.length,
        currentTime: 0,
        currentFrameIndex: 0,
        isPlaying: false,
        loopStart: null,
        loopEnd: null,
        isLooping: false,
      });

      // Enable Kinematics Playback Mode
      KinematicsEngine.enablePlaybackMode();

      const tAfterCommit = performance.now();
      const totalMs = tAfterCommit - t0;
      const fetchSessionMs = tAfterSessionFetch - t0;
      const fetchFramesMs = tAfterFramesFetch - tAfterSessionFetch;
      const prepareMs = tAfterPrepare - tAfterFramesFetch;
      const healMs = tAfterHeal - tAfterPrepare;
      const commitMs = tAfterCommit - tAfterHeal;

      console.info(
        `[PlaybackPerf] session=${sessionId} total=${totalMs.toFixed(1)}ms ` +
          `fetchSession=${fetchSessionMs.toFixed(1)}ms fetchFrames=${fetchFramesMs.toFixed(1)}ms ` +
          `prepare=${prepareMs.toFixed(1)}ms(${workerUsed ? "worker" : "main"}) ` +
          `heal=${healMs.toFixed(1)}ms commit=${commitMs.toFixed(1)}ms ` +
          `frames=${preparedFrames.length} sensors=${sensorIds.length} duration=${(duration / 1000).toFixed(2)}s rate=${frameRate}Hz`,
      );

      set({ isLoadingSession: false });

      return true;
    } catch (err) {
      console.error("[Playback] Failed to load session:", err);
      set({ isLoadingSession: false });
      return false;
    }
  },

  unloadSession: () => {
    // Disable Kinematics Playback Mode
    KinematicsEngine.disablePlaybackMode();

    set({
      sessionId: null,
      sessionName: null,
      frames: [],
      framesBySensor: new Map(),
      packedTimelinesBySensor: new Map(),
      duration: 0,
      sensorIds: [],
      sensorMapping: {},
      calibrationOffsets: [],
      isLoadingSession: false,
      isPlaying: false,
      currentTime: 0,
      currentFrameIndex: 0,
      loopStart: null,
      loopEnd: null,
    });
  },

  // ========================================================================
  // PLAYBACK CONTROLS
  // ========================================================================

  play: () => {
    const { currentTime, duration, isLooping } = get();
    // If at the end and not looping, seek to start before playing (replay)
    if (!isLooping && duration > 0 && currentTime >= duration - 1) {
      set({ currentTime: 0, isPlaying: true });
    } else {
      set({ isPlaying: true });
    }
  },

  pause: () => set({ isPlaying: false }),

  togglePlayPause: () => {
    const { isPlaying, currentTime, duration, isLooping } = get();
    if (isPlaying) {
      set({ isPlaying: false });
    } else {
      // If at the end and not looping, seek to start before playing (replay)
      if (!isLooping && duration > 0 && currentTime >= duration - 1) {
        set({ currentTime: 0, isPlaying: true });
      } else {
        set({ isPlaying: true });
      }
    }
  },

  stop: () => set({ isPlaying: false, currentTime: 0, currentFrameIndex: 0 }),

  seek: (time: number) => {
    const { duration } = get();
    const clampedTime = Math.max(0, Math.min(duration, time));
    set({ currentTime: clampedTime });
  },

  seekPercent: (percent: number) => {
    const { duration } = get();
    const clampedPercent = Math.max(0, Math.min(1, percent));
    set({ currentTime: duration * clampedPercent });
  },

  stepForward: () => {
    const { currentTime, duration, frameRate } = get();
    const frameDuration = 1000 / frameRate;
    const newTime = Math.min(duration, currentTime + frameDuration);
    set({ currentTime: newTime, isPlaying: false });
  },

  stepBackward: () => {
    const { currentTime, frameRate } = get();
    const frameDuration = 1000 / frameRate;
    const newTime = Math.max(0, currentTime - frameDuration);
    set({ currentTime: newTime, isPlaying: false });
  },

  setSpeed: (speed: number) => {
    // Allow any speed between 0.01 and 10 (relaxed validation for slider)
    const clampedSpeed = Math.max(0.01, Math.min(10, speed));
    set({ playbackSpeed: clampedSpeed });
  },

  // ========================================================================
  // A-B LOOPING
  // ========================================================================

  setLoopStart: (time: number) => set({ loopStart: time }),

  setLoopEnd: (time: number) => set({ loopEnd: time }),

  setLoop: (start: number, end: number) => {
    set({ loopStart: start, loopEnd: end, isLooping: true });
  },

  clearLoop: () => {
    set({ loopStart: null, loopEnd: null, isLooping: false });
  },

  toggleLooping: () => set((state) => ({ isLooping: !state.isLooping })),

  // ========================================================================
  // FRAME ACCESS
  // ========================================================================

  // ========================================================================
  // FRAME ACCESS
  // ========================================================================

  getFrameAtTime: (sensorId: number) => {
    // Legacy: kept for simple access, but consumers should prefer interpolation
    const { packedTimelinesBySensor, framesBySensor, currentTime } = get();

    const packed = packedTimelinesBySensor.get(sensorId);
    if (packed && packed.timestamps.length > 0) {
      const ts = packed.timestamps;
      const qs = packed.quaternions;
      const as = packed.accelerometer;
      const gs = packed.gyro;
      const targetTimestamp = currentTime;

      let idx = 0;
      if (targetTimestamp <= ts[0]) {
        idx = 0;
      } else {
        const lastIdx = ts.length - 1;
        if (targetTimestamp >= ts[lastIdx]) {
          idx = lastIdx;
        } else {
          let left = 0;
          let right = lastIdx;

          while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (ts[mid] < targetTimestamp) {
              left = mid + 1;
            } else {
              right = mid;
            }
          }
          idx = left;
        }
      }

      const qOff = idx * 4;
      const aOff = idx * 3;
      const gOff = idx * 3;

      return {
        sensorId,
        timestamp: ts[idx],
        quaternion: [qs[qOff + 0], qs[qOff + 1], qs[qOff + 2], qs[qOff + 3]],
        accelerometer: [as[aOff + 0], as[aOff + 1], as[aOff + 2]],
        gyro: [gs[gOff + 0], gs[gOff + 1], gs[gOff + 2]],
      } as unknown as RecordedFrame;
    }

    const sensorFrames = framesBySensor.get(sensorId);
    if (!sensorFrames || sensorFrames.length === 0) return null;

    // Binary search for closest frame (Nearest Neighbor)
    const targetTimestamp = currentTime;

    let left = 0;
    let right = sensorFrames.length - 1;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (sensorFrames[mid].timestamp < targetTimestamp) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    return sensorFrames[left];
  },

  getInterpolatedFrame: (
    sensorId: number,
  ): { quaternion: THREE.Quaternion; gyro: number[] } | null => {
    const { packedTimelinesBySensor, framesBySensor, currentTime } = get();

    const packed = packedTimelinesBySensor.get(sensorId);
    if (packed && packed.timestamps.length > 0) {
      const ts = packed.timestamps;
      const qs = packed.quaternions;
      const gs = packed.gyro;
      const targetTimestamp = currentTime;

      if (targetTimestamp <= ts[0]) {
        _poolQResult.set(qs[1], qs[2], qs[3], qs[0]);
        _poolGyroResult[0] = gs[0] ?? 0;
        _poolGyroResult[1] = gs[1] ?? 0;
        _poolGyroResult[2] = gs[2] ?? 0;
        return { quaternion: _poolQResult, gyro: _poolGyroResult };
      }

      const lastIdx = ts.length - 1;
      if (targetTimestamp >= ts[lastIdx]) {
        const qOff = lastIdx * 4;
        const gOff = lastIdx * 3;
        _poolQResult.set(qs[qOff + 1], qs[qOff + 2], qs[qOff + 3], qs[qOff]);
        _poolGyroResult[0] = gs[gOff + 0] ?? 0;
        _poolGyroResult[1] = gs[gOff + 1] ?? 0;
        _poolGyroResult[2] = gs[gOff + 2] ?? 0;
        return { quaternion: _poolQResult, gyro: _poolGyroResult };
      }

      let left = 0;
      let right = lastIdx;

      while (left < right) {
        const mid = Math.floor((left + right) / 2);
        if (ts[mid] < targetTimestamp) {
          left = mid + 1;
        } else {
          right = mid;
        }
      }

      const nextIdx = left;
      const prevIdx = Math.max(0, nextIdx - 1);
      const prevT = ts[prevIdx];
      const nextT = ts[nextIdx];
      const dt = nextT - prevT;
      const alpha = dt > 0.001 ? (targetTimestamp - prevT) / dt : 0;

      const pq = prevIdx * 4;
      const nq = nextIdx * 4;
      _poolQPrev.set(qs[pq + 1], qs[pq + 2], qs[pq + 3], qs[pq + 0]);
      _poolQNext.set(qs[nq + 1], qs[nq + 2], qs[nq + 3], qs[nq + 0]);

      if (_poolQPrev.dot(_poolQNext) < 0) {
        _poolQNext.x = -_poolQNext.x;
        _poolQNext.y = -_poolQNext.y;
        _poolQNext.z = -_poolQNext.z;
        _poolQNext.w = -_poolQNext.w;
      }

      _poolQResult.copy(_poolQPrev).slerp(_poolQNext, alpha);

      const pg = prevIdx * 3;
      const ng = nextIdx * 3;
      const gPrev0 = gs[pg + 0] ?? 0;
      const gPrev1 = gs[pg + 1] ?? 0;
      const gPrev2 = gs[pg + 2] ?? 0;
      const gNext0 = gs[ng + 0] ?? 0;
      const gNext1 = gs[ng + 1] ?? 0;
      const gNext2 = gs[ng + 2] ?? 0;
      _poolGyroResult[0] = gPrev0 + (gNext0 - gPrev0) * alpha;
      _poolGyroResult[1] = gPrev1 + (gNext1 - gPrev1) * alpha;
      _poolGyroResult[2] = gPrev2 + (gNext2 - gPrev2) * alpha;

      return { quaternion: _poolQResult, gyro: _poolGyroResult };
    }

    const sensorFrames = framesBySensor.get(sensorId);

    if (!sensorFrames || sensorFrames.length === 0) return null;

    const targetTimestamp = currentTime;

    // 1. Find surrounding frames (prev and next)
    // Binary search for 'next' frame (first frame >= target time)
    let left = 0;
    let right = sensorFrames.length - 1;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (sensorFrames[mid].timestamp < targetTimestamp) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    const nextFrame = sensorFrames[left];
    const nextIdx = left;

    // If target is before first frame
    if (targetTimestamp <= sensorFrames[0].timestamp) {
      const [w, x, y, z] = sensorFrames[0].quaternion;
      return {
        quaternion: new THREE.Quaternion(x, y, z, w),
        gyro: sensorFrames[0].gyro || [0, 0, 0],
      };
    }

    // If target is after last frame
    if (targetTimestamp >= sensorFrames[sensorFrames.length - 1].timestamp) {
      const last = sensorFrames[sensorFrames.length - 1];
      const [w, x, y, z] = last.quaternion;
      return {
        quaternion: new THREE.Quaternion(x, y, z, w),
        gyro: last.gyro || [0, 0, 0],
      };
    }

    // Normal case: interpolate between prev and next
    const prevFrame = sensorFrames[nextIdx - 1];

    // Safety check (shouldn't happen given bounds checks above)
    if (!prevFrame) {
      const [w, x, y, z] = nextFrame.quaternion;
      return {
        quaternion: new THREE.Quaternion(x, y, z, w),
        gyro: nextFrame.gyro || [0, 0, 0],
      };
    }

    // 2. Calculate Alpha
    const dt = nextFrame.timestamp - prevFrame.timestamp;

    // Prevent divide by zero if duplicate timestamps
    const alpha = dt > 0.001 ? (targetTimestamp - prevFrame.timestamp) / dt : 0;

    // 3. SLERP (Using pooled objects to avoid GC pressure)
    _poolQPrev.set(
      prevFrame.quaternion[1], // x
      prevFrame.quaternion[2], // y
      prevFrame.quaternion[3], // z
      prevFrame.quaternion[0], // w
    );

    _poolQNext.set(
      nextFrame.quaternion[1], // x
      nextFrame.quaternion[2], // y
      nextFrame.quaternion[3], // z
      nextFrame.quaternion[0], // w
    );

    // Hemisphere check for shortest path (SLERP standard)
    if (_poolQPrev.dot(_poolQNext) < 0) {
      _poolQNext.x = -_poolQNext.x;
      _poolQNext.y = -_poolQNext.y;
      _poolQNext.z = -_poolQNext.z;
      _poolQNext.w = -_poolQNext.w;
    }

    // SLERP into result pool
    _poolQResult.copy(_poolQPrev).slerp(_poolQNext, alpha);

    // Interpolate gyro (Linear) - using pooled array
    const gPrev = prevFrame.gyro || [0, 0, 0];
    const gNext = nextFrame.gyro || [0, 0, 0];
    _poolGyroResult[0] = gPrev[0] + (gNext[0] - gPrev[0]) * alpha;
    _poolGyroResult[1] = gPrev[1] + (gNext[1] - gPrev[1]) * alpha;
    _poolGyroResult[2] = gPrev[2] + (gNext[2] - gPrev[2]) * alpha;

    // WARNING: Consumer must clone if they need to persist the result!
    return { quaternion: _poolQResult, gyro: _poolGyroResult };
  },

  getQuaternionAtTime: (sensorId: number) => {
    // Use interpolated fetcher
    const result = get().getInterpolatedFrame(sensorId);
    return result ? result.quaternion : null;
  },

  getCalibrationOffset: (segmentId: string) => {
    const offsets = get().calibrationOffsets;
    return (
      offsets.find(
        (o) => o.segmentId.toLowerCase() === segmentId.toLowerCase(),
      ) || null
    );
  },

  // ========================================================================
  // TICK (Called from animation loop)
  // ========================================================================

  tick: (deltaTime: number) => {
    const {
      isPlaying,
      currentTime,
      duration,
      playbackSpeed,
      loopStart,
      loopEnd,
      isLooping,
    } = get();

    if (!isPlaying || duration === 0) return;

    // Guard against double-tick removed - handle in component if needed
    // const now = performance.now();
    // if (now - lastTickTime < 5) return;
    // lastTickTime = now;

    let newTime = currentTime + deltaTime * 1000 * playbackSpeed;

    // ... (rest of tick method)

    // Handle looping
    const effectiveLoopStart = loopStart ?? 0;
    const effectiveLoopEnd = loopEnd ?? duration;

    if (isLooping) {
      if (newTime >= effectiveLoopEnd) {
        // Wrap around
        newTime = effectiveLoopStart + (newTime - effectiveLoopEnd);

        // Sanity check (prevent infinite loops if duration is 0)
        if (newTime >= effectiveLoopEnd) newTime = effectiveLoopStart;
      }
    } else if (newTime >= duration) {
      // End of session
      newTime = duration;
      set({ isPlaying: false });
    }

    set({ currentTime: newTime });

    // ======================================================================
    // PUSH TO KINEMATICS ENGINE (Unified Pipeline)
    // ======================================================================
    // We construct a map of SegmentID -> Quaternion for the current time
    // and inject it into the engine to drive JointAngles and L2/L3 tares.
    // ======================================================================
    const { sensorIds, sensorMapping } = get();
    const playbackFrameData = new Map<
      string,
      [number, number, number, number]
    >();

    // Check if session has empty sensorMapping - use live assignments as fallback
    const hasSessionMapping = Object.keys(sensorMapping).length > 0;
    const assignmentStore = useSensorAssignmentStore.getState();

    // Debug: Log once per playback session
    if (!(window as any)._playbackMappingLogged) {
      console.debug(
        `[Playback Pipeline] Session sensorMapping:`,
        sensorMapping,
      );
      console.debug(`[Playback Pipeline] Session sensorIds:`, sensorIds);
      console.debug(
        `[Playback Pipeline] Has session mapping: ${hasSessionMapping}`,
      );
      console.debug(
        `[Playback Pipeline] Live assignments:`,
        Array.from(assignmentStore.assignments.entries()).map(
          ([id, a]) => `${id}->${a.segmentId}`,
        ),
      );
      (window as any)._playbackMappingLogged = true;
    }

    sensorIds.forEach((sensorId) => {
      // Try session mapping first, then fall back to live assignments
      let segment = sensorMapping[sensorId];

      if (!segment && !hasSessionMapping) {
        // FALLBACK: Session has no mapping, search live assignments by numeric ID suffix
        // This handles device IDs like "USB 239a:8143_190" matching numeric sensor ID 190
        const fallbackSegment = assignmentStore.getSegmentByNumericId(sensorId);
        if (fallbackSegment) segment = fallbackSegment;

        // Log fallback usage (throttled - only once per sensor)
        if (
          segment &&
          !(window as any)[`_playbackFallbackLogged_${sensorId}`]
        ) {
          console.debug(
            `[Playback] Using live assignment fallback: sensor ${sensorId} -> ${segment}`,
          );
          (window as any)[`_playbackFallbackLogged_${sensorId}`] = true;
        }
      }

      if (segment) {
        // Use interpolated data for smoothness
        const result = get().getInterpolatedFrame(sensorId);

        if (result) {
          const { quaternion } = result;
          // Convert THREE.Quaternion to array [w, x, y, z]
          playbackFrameData.set(segment, [
            quaternion.w,
            quaternion.x,
            quaternion.y,
            quaternion.z,
          ]);
        }
      } else {
        // Log unmapped sensor (throttled)
        if (!(window as any)[`_playbackUnmappedLogged_${sensorId}`]) {
          console.warn(
            `[Playback] Sensor ${sensorId} could not be mapped to a segment`,
          );
          (window as any)[`_playbackUnmappedLogged_${sensorId}`] = true;
        }
      }
    });

    // Diagnostic: Log if no data to inject
    if (playbackFrameData.size === 0 && sensorIds.length > 0) {
      if (!(window as any)._playbackNoDataLogged) {
        console.error(
          `[Playback] No segment data to inject! ${sensorIds.length} sensors, 0 mapped`,
        );
        console.error(
          `[Playback] Check sensor assignments and session sensorMapping`,
        );
        (window as any)._playbackNoDataLogged = true;
      }
    }

    if (playbackFrameData.size > 0) {
      // Inject into pipeline
      // This will trigger 'processFrame' synchronously in the engine
      // ensuring JointAnglesStore is updated for this exact frame.
      KinematicsEngine.injectPlaybackData(playbackFrameData);
    }
  },
}));
