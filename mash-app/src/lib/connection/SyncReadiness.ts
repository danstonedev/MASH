/**
 * SyncReadiness — Pre-streaming verification for Gateway/Node synchronization.
 *
 * After the webapp sends START to the Gateway, this class polls GET_SYNC_STATUS
 * to verify that TDMA discovery is complete, nodes are registered and alive,
 * SyncFrameBuffer is initialized, and data is flowing with acceptable quality.
 *
 * The webapp should wait for `ready === true` before trusting incoming IMU data
 * for recording, calibration, or analysis.
 *
 * Readiness phases:
 *   connecting → discovering → syncing → verifying → ready
 *                                                   ↘ timeout (if stuck)
 */

import { connectionManager } from "./ConnectionManager";

// ============================================================================
// Types
// ============================================================================

export type SyncPhase =
  | "idle"
  | "connecting"
  | "discovering"
  | "syncing"
  | "verifying"
  | "ready"
  | "timeout"
  | "error";

export interface SyncNodeInfo {
  nodeId: number;
  name: string;
  sensorCount: number;
  hasMag: boolean;
  hasBaro: boolean;
  lastHeardMs: number;
  alive: boolean;
  mac: string;
  compactBase?: number; // Gateway-assigned compact sensor base ID (matches 0x25 SyncFrame IDs)
}

export interface SyncBufferMetrics {
  initialized: boolean;
  expectedSensors: number;
  completedFrames: number;
  trulyComplete: number;
  partialRecovery: number;
  dropped: number;
  incomplete: number;
  trueSyncRate: number;
}

export interface SyncReadinessState {
  phase: SyncPhase;
  tdmaState: string;
  nodeCount: number;
  nodes: SyncNodeInfo[];
  syncBuffer: SyncBufferMetrics;
  ready: boolean;
  readySource: "none" | "sync_status" | "imu_fallback";
  failureReason?: string;
  failureReasons: string[];
  readiness: {
    tdmaRunning: boolean;
    hasAliveNodes: boolean;
    bufferReady: boolean;
    syncQualityOk: boolean;
    syncRate: number;
  };
  elapsedMs: number;
  pollCount: number;
}

export type SyncReadinessListener = (state: SyncReadinessState) => void;

// ============================================================================
// Constants
// ============================================================================

/** How often to poll GET_SYNC_STATUS (ms) */
const POLL_INTERVAL_MS = 500;

/** Maximum time to wait for readiness before declaring timeout (ms) */
const READINESS_TIMEOUT_MS = 15000;

/** Minimum number of ready polls before confirming (prevents flicker) */
const READY_CONFIRM_COUNT = 2;

/** Use IMU flow as fallback only if sync_status is stale/missing this long (ms) */
const STATUS_STALE_MS = 2000;

/** Prevent fallback from firing during initial discovery warm-up */
const FALLBACK_MIN_ELAPSED_MS = 2500;

/** Require at least this many polls before fallback can resolve readiness */
const FALLBACK_MIN_POLLS = 4;

/**
 * Smart retry: if TDMA is RUNNING with alive nodes but no completed frames
 * after this duration, trigger a deferred sync reset to unstick the pipeline.
 */
const SMART_RETRY_MS = 8000;

// ============================================================================
// SyncReadiness Class
// ============================================================================

export class SyncReadiness {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private pollCount = 0;
  private readyCount = 0;
  private imuFlowCount = 0;
  private imuFlowSensorIds = new Set<number>();
  private readyResolvedBy: "none" | "sync_status" | "imu_fallback" = "none";
  private lastSyncStatusAtMs = 0;
  private smartRetryFired = false;
  private listeners: SyncReadinessListener[] = [];
  private _state: SyncReadinessState;
  private _resolveReady: (() => void) | null = null;
  private _rejectReady: ((reason: string) => void) | null = null;

  constructor() {
    this._state = this.defaultState();
  }

  /** Subscribe to readiness state changes */
  onStateChange(listener: SyncReadinessListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Get current state */
  get state(): SyncReadinessState {
    return this._state;
  }

  /**
   * Start readiness verification polling.
   * Returns a promise that resolves when the system is ready,
   * or rejects on timeout/error.
   */
  async waitForReady(): Promise<SyncReadinessState> {
    this.stop(); // Clean up any previous run

    this.startTime = Date.now();
    this.pollCount = 0;
    this.readyCount = 0;
    this.imuFlowCount = 0;
    this.imuFlowSensorIds.clear();
    this.readyResolvedBy = "none";
    this.lastSyncStatusAtMs = 0;
    this.smartRetryFired = false;
    this.updateState({ phase: "connecting" });

    return new Promise<SyncReadinessState>((resolve, reject) => {
      this._resolveReady = () => resolve(this._state);
      this._rejectReady = (reason: string) => reject(new Error(reason));

      this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
      // First poll immediately
      this.poll();
    });
  }

  /** Stop polling */
  stop(clearPendingCallbacks = true): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (clearPendingCallbacks) {
      this._resolveReady = null;
      this._rejectReady = null;
    }
  }

  private resolveReady(): void {
    const resolve = this._resolveReady;
    this.stop(false);
    this._resolveReady = null;
    this._rejectReady = null;
    resolve?.();
  }

  private rejectReady(reason: string): void {
    const reject = this._rejectReady;
    this.stop(false);
    this._resolveReady = null;
    this._rejectReady = null;
    reject?.(reason);
  }

  /** Reset to idle state */
  reset(): void {
    this.stop();
    this.imuFlowCount = 0;
    this.imuFlowSensorIds.clear();
    this.readyResolvedBy = "none";
    this.lastSyncStatusAtMs = 0;
    this._state = this.defaultState();
    this.emit();
  }

  /**
   * Data-flow fallback: if trusted IMU packets are being accepted by the app,
   * treat that as proof of live sync and resolve readiness.
   */
  noteAcceptedImuPacket(sensorId?: number): void {
    if (this.startTime <= 0) return;

    const phase = this._state.phase;
    if (
      phase === "idle" ||
      phase === "ready" ||
      phase === "timeout" ||
      phase === "error"
    ) {
      return;
    }

    this.imuFlowCount++;
    if (typeof sensorId === "number" && Number.isFinite(sensorId)) {
      this.imuFlowSensorIds.add(sensorId);
    }

    const elapsed = Date.now() - this.startTime;
    if (
      elapsed < FALLBACK_MIN_ELAPSED_MS ||
      this.pollCount < FALLBACK_MIN_POLLS
    ) {
      return;
    }

    const statusStale =
      this.lastSyncStatusAtMs === 0 ||
      Date.now() - this.lastSyncStatusAtMs > STATUS_STALE_MS;

    if (!statusStale) {
      return;
    }

    if (this.imuFlowCount < 5) return;
    const uniqueSensors = this.imuFlowSensorIds.size;

    this.updateState({
      phase: "ready",
      ready: true,
      readySource: "imu_fallback",
      elapsedMs: elapsed,
      pollCount: this.pollCount,
      failureReason: undefined,
      failureReasons: [],
      readiness: {
        ...this._state.readiness,
        tdmaRunning: true,
        hasAliveNodes: true,
      },
    });

    this.readyResolvedBy = "imu_fallback";
    console.info(
      `[SyncReadiness] Ready source=imu_fallback packets=${this.imuFlowCount} sensors=${uniqueSensors} elapsedMs=${elapsed}`,
    );

    this.resolveReady();
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async poll(): Promise<void> {
    this.pollCount++;
    const elapsed = Date.now() - this.startTime;

    // Guard: if the connection was lost, stop polling immediately
    // rather than sending commands to a dead port.
    if (connectionManager.activeConnection.status === "disconnected") {
      this.rejectReady("Connection lost during sync verification");
      return;
    }

    // Timeout check
    if (elapsed > READINESS_TIMEOUT_MS) {
      const reasons = this.buildFailureReasons(this._state);
      const timeoutReason =
        reasons.length > 0
          ? `Sync readiness timeout after ${Math.round(elapsed / 1000)}s: ${reasons.join("; ")}`
          : `Sync readiness timeout after ${Math.round(elapsed / 1000)}s`;

      this.updateState({
        phase: "timeout",
        elapsedMs: elapsed,
        failureReason: timeoutReason,
        failureReasons: reasons,
      });
      console.warn(
        `[SyncReadiness] Timeout after ${elapsed}ms (${this.pollCount} polls)`,
      );
      this.rejectReady(timeoutReason);
      return;
    }

    try {
      // Send GET_SYNC_STATUS and wait for response via the JSON packet pipeline
      await connectionManager.sendCommand("GET_SYNC_STATUS");

      // The response will come back through onData as a JSONPacket with type="sync_status".
      // We handle it in handleSyncStatusResponse() which is called from useDeviceStore.
    } catch (err) {
      console.warn("[SyncReadiness] Poll error:", err);
      const message = err instanceof Error ? err.message : String(err);
      this.updateState({
        phase: "error",
        elapsedMs: elapsed,
        failureReason: `Sync status poll failed: ${message}`,
      });
    }
  }

  /**
   * Called externally when a sync_status JSON packet arrives from the Gateway.
   * This is the main state evaluation logic.
   */
  handleSyncStatusResponse(data: Record<string, any>): void {
    const elapsed = Date.now() - this.startTime;
    this.lastSyncStatusAtMs = Date.now();

    const nodes: SyncNodeInfo[] = (data.nodes || []).map((n: any) => ({
      nodeId: n.nodeId ?? 0,
      name: n.name ?? "",
      sensorCount: n.sensorCount ?? 0,
      hasMag: n.hasMag ?? false,
      hasBaro: n.hasBaro ?? false,
      lastHeardMs: n.lastHeardMs ?? 0,
      alive: n.alive ?? false,
      mac: n.mac ?? "",
      compactBase: n.compactBase ?? undefined,
    }));

    const syncBuffer: SyncBufferMetrics = {
      initialized: data.syncBuffer?.initialized ?? false,
      expectedSensors: data.syncBuffer?.expectedSensors ?? 0,
      completedFrames: data.syncBuffer?.completedFrames ?? 0,
      trulyComplete: data.syncBuffer?.trulyComplete ?? 0,
      partialRecovery: data.syncBuffer?.partialRecovery ?? 0,
      dropped: data.syncBuffer?.dropped ?? 0,
      incomplete: data.syncBuffer?.incomplete ?? 0,
      trueSyncRate: data.syncBuffer?.trueSyncRate ?? 0,
    };

    const readiness = {
      tdmaRunning: data.readiness?.tdmaRunning ?? false,
      hasAliveNodes: data.readiness?.hasAliveNodes ?? false,
      bufferReady: data.readiness?.bufferReady ?? false,
      syncQualityOk: data.readiness?.syncQualityOk ?? false,
      syncRate: data.readiness?.syncRate ?? 0,
    };

    const nodeCount = data.nodeCount ?? 0;

    // Warm-up compatibility mode:
    // When TDMA is running and completed frames are already flowing, do not
    // block readiness on trueSyncRate threshold. Early in startup, mixed node
    // timing can produce low trueSync even though usable data is present.
    const hasFlowingFrames =
      syncBuffer.initialized && syncBuffer.completedFrames > 0;
    const relaxedReady =
      readiness.tdmaRunning && nodeCount > 0 && hasFlowingFrames;

    const effectiveReady = (data.ready ?? false) || relaxedReady;

    // Determine phase from TDMA state (must be before buildFailureReasons)
    const tdmaState = data.tdmaState ?? "idle";

    const failureReasons = this.buildFailureReasons({
      ...this._state,
      tdmaState,
      nodeCount,
      nodes,
      syncBuffer,
      readiness,
    });

    let phase: SyncPhase = this._state.phase;

    if (tdmaState === "idle") {
      phase = "connecting";
    } else if (tdmaState === "discovery") {
      phase = "discovering";
    } else if (tdmaState === "sync") {
      phase = "syncing";
    } else if (tdmaState === "running") {
      if (effectiveReady) {
        this.readyCount++;
        // Require READY_CONFIRM_COUNT consecutive ready polls to confirm
        phase = this.readyCount >= READY_CONFIRM_COUNT ? "ready" : "verifying";
      } else {
        this.readyCount = 0;
        phase = "verifying";
      }
    }

    this.updateState({
      phase,
      tdmaState,
      nodeCount,
      nodes,
      syncBuffer,
      ready: phase === "ready",
      readySource: phase === "ready" ? "sync_status" : this._state.readySource,
      failureReason: phase === "ready" ? undefined : failureReasons[0],
      failureReasons,
      readiness,
      elapsedMs: elapsed,
      pollCount: this.pollCount,
    });

    // Smart retry: if TDMA is running with alive nodes but SyncFrameBuffer
    // has produced zero completed frames after SMART_RETRY_MS, fire a single
    // TRIGGER_SYNC_RESET to unstick the pipeline (e.g. buffer init race).
    if (
      !this.smartRetryFired &&
      elapsed > SMART_RETRY_MS &&
      readiness.tdmaRunning &&
      readiness.hasAliveNodes &&
      syncBuffer.completedFrames === 0
    ) {
      this.smartRetryFired = true;
      console.warn(
        `[SyncReadiness] Smart retry: TDMA running + alive nodes but 0 frames after ${Math.round(elapsed / 1000)}s — firing TRIGGER_SYNC_RESET`,
      );
      connectionManager
        .sendCommand("TRIGGER_SYNC_RESET")
        .catch((e) =>
          console.warn("[SyncReadiness] Smart retry send failed:", e),
        );
    }

    // Resolve promise when ready
    if (phase === "ready") {
      if (this.readyResolvedBy !== "sync_status") {
        this.readyResolvedBy = "sync_status";
        console.info(
          `[SyncReadiness] Ready source=sync_status polls=${this.pollCount} elapsedMs=${elapsed}`,
        );
      }
      console.debug(
        `[SyncReadiness] System ready in ${elapsed}ms (${this.pollCount} polls, ` +
          `${nodes.length} nodes, sync rate: ${syncBuffer.trueSyncRate.toFixed(1)}%)`,
      );
      this.resolveReady();
    }
  }

  private updateState(partial: Partial<SyncReadinessState>): void {
    this._state = { ...this._state, ...partial };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this._state);
      } catch (err) {
        console.error("[SyncReadiness] Listener error:", err);
      }
    }
  }

  private defaultState(): SyncReadinessState {
    return {
      phase: "idle",
      tdmaState: "idle",
      nodeCount: 0,
      nodes: [],
      syncBuffer: {
        initialized: false,
        expectedSensors: 0,
        completedFrames: 0,
        trulyComplete: 0,
        partialRecovery: 0,
        dropped: 0,
        incomplete: 0,
        trueSyncRate: 0,
      },
      ready: false,
      readySource: "none",
      failureReason: undefined,
      failureReasons: [],
      readiness: {
        tdmaRunning: false,
        hasAliveNodes: false,
        bufferReady: false,
        syncQualityOk: false,
        syncRate: 0,
      },
      elapsedMs: 0,
      pollCount: 0,
    };
  }

  private buildFailureReasons(state: SyncReadinessState): string[] {
    const reasons: string[] = [];

    if (!state.readiness.tdmaRunning) {
      reasons.push("TDMA is not running yet");
    }

    if (state.nodeCount === 0) {
      reasons.push("No nodes detected");
    } else if (!state.readiness.hasAliveNodes) {
      reasons.push("Nodes detected but none are alive (no recent data)");
    }

    const detectedSensorCount = state.nodes.reduce(
      (sum, node) => sum + (node.sensorCount || 0),
      0,
    );

    if (state.syncBuffer.expectedSensors <= 0) {
      reasons.push("No sensors registered in SyncFrameBuffer");
    } else {
      if (
        detectedSensorCount > 0 &&
        state.syncBuffer.expectedSensors !== detectedSensorCount
      ) {
        reasons.push(
          `Sensor count mismatch (nodes report ${detectedSensorCount}, SyncFrameBuffer expects ${state.syncBuffer.expectedSensors})`,
        );
      }

      if (!state.readiness.bufferReady) {
        reasons.push("No completed synchronized frames yet");
      }
    }

    if (!state.readiness.syncQualityOk) {
      if (state.syncBuffer.completedFrames > 0) {
        reasons.push(
          `Sync quality warming up (${state.readiness.syncRate.toFixed(1)}% true sync rate)`,
        );
      } else {
        reasons.push(
          `Sync quality below threshold (${state.readiness.syncRate.toFixed(1)}% true sync rate)`,
        );
      }
    }

    return reasons;
  }
}

/** Singleton instance */
export const syncReadiness = new SyncReadiness();
