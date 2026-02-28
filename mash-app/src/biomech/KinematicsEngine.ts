import * as THREE from "three";
import {
  useDeviceRegistry,
  deviceQuaternionCache,
} from "../store/useDeviceRegistry";
import { useTareStore } from "../store/useTareStore";
import { useJointAnglesStore } from "../store/useJointAnglesStore";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";

type SerializedJointTare = {
  flexion: number;
  abduction: number;
  rotation: number;
};

type SerializedTareState = {
  mountingTare: [number, number, number, number];
  headingTare: [number, number, number, number];
  frameAlignment?: [number, number, number, number];
  jointTare: SerializedJointTare;
  mountingTareTime: number;
  headingTareTime: number;
  frameAlignmentTime?: number;
  jointTareTime: number;
};

type KinematicsWorkerInput = {
  type: "process";
  requestId: number;
  sensorData: Array<[string, [number, number, number, number]]>;
  tareStates: Array<[string, SerializedTareState]>;
};

type KinematicsWorkerMessage =
  | {
      type: "result";
      requestId: number;
      segmentQuaternions: Array<[string, [number, number, number, number]]>;
    }
  | {
      type: "error";
      requestId: number;
      error: string;
    };

/**
 * KinematicsEngine
 *
 * Real-time processor that runs alongside the rendering loop.
 * It:
 * 1. Reads raw IMU quaternions from DeviceRegistry (Live check) or injected data (Playback)
 * 2. Applies calibration offsets (from TareStore - UNIFIED with SkeletonModel)
 * 3. Builds a map of clinically accurate Segment orientations
 * 4. Pushes results to JointAnglesStore (which handles angle calculation + min/max tracking)
 */
class KinematicsEngineClass {
  private isRunning = false;
  private animationFrameId: number | null = null;
  private mode: "LIVE" | "PLAYBACK" = "LIVE";
  private worker: Worker | null = null;
  private workerBusy = false;
  private pendingPayload: KinematicsWorkerInput | null = null;
  private requestId = 0;
  private lastAppliedRequestId = 0;

  // Throttling to avoid overloading React state updates
  private lastUpdate = 0;
  private UPDATE_INTERVAL = 33; // ~30Hz (sufficient for UI)

  // Playback Data Injection (Frame buffer)
  private playbackData: Map<string, [number, number, number, number]> | null =
    null;

  /**
   * Start the engine in LIVE mode (pulls from DeviceRegistry)
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.mode = "LIVE";
    this.playbackData = null;

    // Notify store tracking started
    useJointAnglesStore.getState().startTracking();

    this.ensureWorker();

    this.loop();
    console.debug("[KinematicsEngine] Started (LIVE Mode)");
  }

  /**
   * Set engine to PLAYBACK mode.
   * In this mode, the loop() is paused and processFrame() must be called manually
   * or triggered by injectPlaybackData().
   */
  enablePlaybackMode() {
    this.mode = "PLAYBACK";
    // Ensure tracking is active so charts update
    useJointAnglesStore.getState().startTracking();
    console.debug("[KinematicsEngine] Switched to PLAYBACK Mode");
  }

  disablePlaybackMode() {
    this.mode = "LIVE";
    this.playbackData = null;
    console.debug("[KinematicsEngine] Switched to LIVE Mode");
  }

  stop() {
    this.isRunning = false;
    this.mode = "LIVE";
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Notify store tracking stopped
    useJointAnglesStore.getState().stopTracking();
    this.teardownWorker();
    console.debug("[KinematicsEngine] Stopped");
  }

  /**
   * Injects a frame of data from PlaybackStore and triggers processing immediately.
   * @param frameData Map of SegmentID -> Quaternion [w, x, y, z]
   */
  injectPlaybackData(frameData: Map<string, [number, number, number, number]>) {
    if (this.mode !== "PLAYBACK") {
      // Log mode mismatch (throttled)
      if (!(window as any)._kinematicsModeMismatchLogged) {
        console.warn(
          `[KinematicsEngine] injectPlaybackData called but mode is ${this.mode}`,
        );
        (window as any)._kinematicsModeMismatchLogged = true;
      }
      return;
    }

    // Debug log (throttled to every 2 seconds)
    const now = performance.now();
    if (
      !(window as any)._lastPlaybackInjectLog ||
      now - (window as any)._lastPlaybackInjectLog > 2000
    ) {
      console.debug(
        `[KinematicsEngine] Injecting playback data:`,
        Array.from(frameData.entries())
          .map(([seg, q]) => `${seg}:[${q.map((v) => v.toFixed(3)).join(",")}]`)
          .join(" | "),
      );
      (window as any)._lastPlaybackInjectLog = now;
    }

    this.playbackData = frameData;

    // Process immediately (synchronous with playback tick)
    // No throttling needed as PlaybackStore controls the tick rate
    this.processFrame();
  }

  private loop = () => {
    if (!this.isRunning || this.mode === "PLAYBACK") return;

    const now = performance.now();
    if (now - this.lastUpdate > this.UPDATE_INTERVAL) {
      this.processFrame();
      this.lastUpdate = now;
    }

    this.animationFrameId = requestAnimationFrame(this.loop);
  };

  /**
   * core processing logic - Unified Pipeline
   */
  processFrame() {
    let sensorData: Map<string, [number, number, number, number]>;
    const tareStore = useTareStore.getState();
    const tareStates = new Map<string, SerializedTareState>();

    // 1. Source Data Selection
    if (this.mode === "LIVE") {
      sensorData = this.fetchLiveSensorData(tareStore, tareStates);
    } else {
      // PLAYBACK MODE
      if (!this.playbackData) return;
      sensorData = this.playbackData;

      // Hydrate tare states for all segments in playback data
      sensorData.forEach((_, segmentId) => {
        tareStates.set(
          segmentId,
          this.serializeTareState(tareStore, segmentId),
        );
      });
    }

    if (sensorData.size === 0) return;

    const payload: KinematicsWorkerInput = {
      type: "process",
      requestId: ++this.requestId,
      sensorData: Array.from(sensorData.entries()),
      tareStates: Array.from(tareStates.entries()),
    };

    this.dispatchToWorker(payload);
  }

  private fetchLiveSensorData(
    tareStore: ReturnType<typeof useTareStore.getState>,
    tareStates: Map<string, SerializedTareState>,
  ) {
    const sensorData = new Map<string, [number, number, number, number]>();
    const devices = useDeviceRegistry.getState().devices;

    devices.forEach((device) => {
      const { getSegmentForSensor } = useSensorAssignmentStore.getState();
      const segment = getSegmentForSensor(device.id);
      if (!segment || !device.isConnected) return;

      // Get Raw Quaternion
      const rawQuatArray =
        deviceQuaternionCache.get(device.id) || device.quaternion;

      // FIX: Pitch Reversal for Head (lowercase to match ROLE_TO_SEGMENT)
      if (segment === "head") {
        const corrected = [...rawQuatArray] as [number, number, number, number];
        corrected[1] = -corrected[1]; // x (Pitch flip)
        corrected[2] = -corrected[2]; // y (Yaw flip)
        sensorData.set(segment, corrected);
      } else {
        sensorData.set(segment, rawQuatArray);
      }

      tareStates.set(segment, this.serializeTareState(tareStore, segment));
    });

    return sensorData;
  }

  private serializeTareState(
    tareStore: ReturnType<typeof useTareStore.getState>,
    segmentId: string,
  ): SerializedTareState {
    const tareState = tareStore.getTareState(segmentId);
    return {
      mountingTare: [
        tareState.mountingTare.w,
        tareState.mountingTare.x,
        tareState.mountingTare.y,
        tareState.mountingTare.z,
      ],
      headingTare: [
        tareState.headingTare.w,
        tareState.headingTare.x,
        tareState.headingTare.y,
        tareState.headingTare.z,
      ],
      frameAlignment: tareState.frameAlignment
        ? [
            tareState.frameAlignment.w,
            tareState.frameAlignment.x,
            tareState.frameAlignment.y,
            tareState.frameAlignment.z,
          ]
        : undefined,
      jointTare: tareState.jointTare,
      mountingTareTime: tareState.mountingTareTime,
      headingTareTime: tareState.headingTareTime,
      frameAlignmentTime: tareState.frameAlignmentTime,
      jointTareTime: tareState.jointTareTime,
    };
  }

  private ensureWorker() {
    if (this.worker || typeof Worker === "undefined") return;

    this.worker = new Worker(
      new URL("../workers/kinematicsWorker.ts", import.meta.url),
      {
        type: "module",
      },
    );

    this.worker.onmessage = (event: MessageEvent<KinematicsWorkerMessage>) => {
      const data = event.data;
      this.workerBusy = false;

      if (data.type === "error") {
        console.warn("[KinematicsEngine] Worker error:", data.error);
      } else if (data.requestId >= this.lastAppliedRequestId) {
        this.lastAppliedRequestId = data.requestId;
        const segmentQuats = new Map<string, THREE.Quaternion>();
        data.segmentQuaternions.forEach(([segmentId, q]) => {
          const [w, x, y, z] = q;
          segmentQuats.set(segmentId, new THREE.Quaternion(x, y, z, w));
        });
        useJointAnglesStore.getState().updateJointAngles(segmentQuats);
      }

      if (this.pendingPayload) {
        const next = this.pendingPayload;
        this.pendingPayload = null;
        this.dispatchToWorker(next);
      }
    };

    this.worker.onerror = (event) => {
      this.workerBusy = false;
      console.error("[KinematicsEngine] Worker crashed:", event.message);
    };
  }

  private dispatchToWorker(payload: KinematicsWorkerInput) {
    this.ensureWorker();
    if (!this.worker) return;

    if (this.workerBusy) {
      this.pendingPayload = payload;
      return;
    }

    this.workerBusy = true;
    this.worker.postMessage(payload);
  }

  private teardownWorker() {
    this.workerBusy = false;
    this.pendingPayload = null;
    this.lastAppliedRequestId = 0;

    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }
}

export const KinematicsEngine = new KinematicsEngineClass();
