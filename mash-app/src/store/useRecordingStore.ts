/**
 * Session Recording Store - Records IMU data streams for later export/analysis.
 *
 * Features:
 * - Start/Stop recording with timestamps
 * - Multi-sensor data capture with segment mapping
 * - Calibration offsets stored for playback reconstruction
 * - CSV export with comprehensive metadata (per biomechanics best practices)
 * - Session metadata (duration, sample rate, sensor info)
 */

import { create } from "zustand";
import type {
  IMUDataPacket,
  EnvironmentalDataPacket,
} from "../lib/ble/DeviceInterface";
import {
  dataManager,
  type RecordingSession as DBRecordingSession,
  type RecordedFrame,
  type SerializedCalibrationOffset,
} from "../lib/db";
import { buildRecordingCsv } from "../lib/export/buildRecordingCsv";
import { useDeviceRegistry } from "./useDeviceRegistry";
import { useCalibrationStore } from "./useCalibrationStore";
import { useSensorAssignmentStore } from "./useSensorAssignmentStore";
import {
  sensorIntegrityMonitor,
  IntegrityFlag,
} from "../lib/diagnostics/SensorIntegrityMonitor";

export interface RecordingSession extends DBRecordingSession {
  // We keep frames out of the store state to avoid React overhead
}

interface RecordingState {
  // Current recording
  isRecording: boolean;
  isPaused: boolean;
  currentSession: RecordingSession | null;
  recordingStartTime: number | null;
  firmwareTimestampBase: number | null; // First firmware timestamp (frameNumber)
  lastFrameNumber: number | null; // Last firmware timestamp (frameNumber)

  // Pending session (stopped but not yet finalized)
  pendingSession: RecordingSession | null;
  showMetadataDialog: boolean;

  // Athlete selection
  selectedAthleteId: string | null;

  // Stats (updated periodically, not per-frame)
  frameCount: number;
  duration: number;

  // Actions
  setSelectedAthlete: (athleteId: string | null) => void;
  startRecording: (name?: string, athleteId?: string) => Promise<void>;
  stopRecording: () => Promise<RecordingSession | null>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  recordFrame: (packet: IMUDataPacket) => void;
  recordEnvFrame: (packet: EnvironmentalDataPacket) => void;

  // Post-recording metadata
  finalizeSession: (metadata: {
    name?: string;
    athleteId?: string | null;
    activityType?: string;
    notes?: string;
    metrics?: any; // Pass the summary object
  }) => Promise<void>;
  discardPendingSession: () => Promise<void>;
  closeMetadataDialog: () => void;

  // Export
  exportToCSV: () => Promise<string | null>;
  downloadCSV: (filename?: string) => Promise<void>;

  // Management
  clearCurrentSession: () => void;
}

async function buildCsvInWorker(
  session: RecordingSession,
  frames: RecordedFrame[],
): Promise<string | null> {
  if (typeof Worker === "undefined") {
    throw new Error("Worker is not available in this environment");
  }

  const worker = new Worker(
    new URL("../workers/csvExportWorker.ts", import.meta.url),
    {
      type: "module",
    },
  );

  return await new Promise<string | null>((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (data?.ok) {
        cleanup();
        resolve((data.csv as string | null) ?? null);
      } else {
        cleanup();
        reject(new Error(data?.error || "CSV export worker failed"));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "CSV export worker crashed"));
    };

    worker.postMessage({ session, frames });
  });
}

/**
 * Capture current calibration offsets for storage with session.
 * This is critical for accurate playback reconstruction.
 */
function captureCalibrationOffsets(): SerializedCalibrationOffset[] {
  const calibrationState = useCalibrationStore.getState();
  const offsets: SerializedCalibrationOffset[] = [];

  calibrationState.sensorOffsets.forEach((data, segmentId) => {
    offsets.push({
      segmentId,
      offset: [data.offset.w, data.offset.x, data.offset.y, data.offset.z],
      alignmentQuaternion: data.alignmentQuaternion
        ? [
            data.alignmentQuaternion.w,
            data.alignmentQuaternion.x,
            data.alignmentQuaternion.y,
            data.alignmentQuaternion.z,
          ]
        : undefined,
      headingCorrection: data.headingCorrection
        ? [
            data.headingCorrection.w,
            data.headingCorrection.x,
            data.headingCorrection.y,
            data.headingCorrection.z,
          ]
        : undefined,
      quality: data.quality,
      method: data.method,
      capturedAt: data.capturedAt,
    });
  });

  return offsets;
}

/**
 * Capture current tare states for storage with session.
 * This enables full 3-level orientation pipeline during playback.
 */
function captureTareStates(): {
  segmentId: string;
  mountingTare: [number, number, number, number];
  headingTare: [number, number, number, number];
  jointTare: { flexion: number; abduction: number; rotation: number };
  mountingTareTime: number;
  headingTareTime: number;
  jointTareTime: number;
}[] {
  // Access useTareStore via StoreRegistry to avoid circular dependency
  try {
    return getTareStore().getState().serialize();
  } catch {
    // Store not registered yet
    return [];
  }
}

/**
 * Capture current sensor-to-segment mapping from assignment store.
 */
function captureSensorMapping(): Record<number, string> {
  const devices = useDeviceRegistry.getState().devices;
  const { getSegmentForSensor } = useSensorAssignmentStore.getState();
  const mapping: Record<number, string> = {};

  devices.forEach((device, id) => {
    const segment = getSegmentForSensor(device.id);
    if (segment) {
      // Device IDs can be:
      // - "sensor_204" → extract 204
      // - "USB 239a:8143_190" → extract 190 (trailing number after underscore)
      // We need the TRAILING numeric suffix, not all digits concatenated
      const idStr = String(id);
      const match = idStr.match(/(\d+)$/); // Match trailing digits
      const sensorId = match ? parseInt(match[1], 10) : NaN;

      if (!isNaN(sensorId) && sensorId >= 0) {
        mapping[sensorId] = segment;
        console.debug(
          `[captureSensorMapping] ${id} -> numeric ${sensorId} -> ${segment}`,
        );
      }
    }
  });

  console.debug(
    `[captureSensorMapping] Registry has ${devices.size} devices, extracted ${
      Object.keys(mapping).length
    } mappings`,
  );
  return mapping;
}

// ============================================================
// RECORDING SYNC DIAGNOSTIC STATE
// Tracks per-frameNumber sensor composition in real time
// ============================================================
let _recSyncDiag: {
  frameSensors: Map<number, Set<number>>;
  totalFrames: number;
  fullFrames: number;
  lastReport: number;
  allSensorIds: Set<number>;
} | null = null;

// ============================================================
// RECORDING BATCH BUFFER (Performance Optimization)
// ============================================================
// Instead of 1 IDB transaction + 1 Zustand set() per packet (~1000/sec),
// accumulate frames and flush in batches every 50ms (~20/sec).
// This reduces IDB transaction overhead by ~50× and Zustand set() by ~200×.
// ============================================================
const _pendingFrames: RecordedFrame[] = [];
let _batchFlushTimer: ReturnType<typeof setInterval> | null = null;
let _batchFrameCount = 0; // running count between UI updates
let _lastUIUpdate = 0;
const BATCH_FLUSH_INTERVAL_MS = 50; // 20 flushes/sec — each contains ~50 frames at 1000 pkt/s
const UI_UPDATE_INTERVAL_MS = 200; // 5 UI updates/sec for frameCount/duration

// ============================================================
// COMPLETE-FRAME GATING (Data Quality)
// ============================================================
// When the user presses Record, we may catch the tail end of a sync frame
// that's mid-delivery (some sensors already dispatched before isRecording
// flipped to true). Similarly, when the user stops, we may have captured
// only a partial leading edge of the last sync frame.
//
// To guarantee every recorded frame has ALL sensors, we:
//   START: Skip all packets sharing the very first frameNumber we see
//          (it's potentially partial). Recording begins at the next FN.
//   STOP:  Before the final IDB flush, trim all packets sharing the
//          last frameNumber in the pending buffer (potentially partial).
//
// Cost: at most 1 sync frame (~5ms) lost at each boundary — negligible
// compared to typical multi-minute recordings.
// ============================================================
let _startGateFrameNumber: number | null = null; // first FN seen — skip it
let _startGateOpen = false; // true once the first partial frame is past
let _startGateSkipped = 0; // count of packets skipped by start gate

// ============================================================
// DUPLICATE PACKET DETECTION (Data Quality - Issue #2)
// ============================================================
// Track (frameNumber, sensorId) pairs seen within the current batch
// window. If the same pair appears twice (USB retransmission, parser
// glitch), drop the duplicate to avoid double-counting in playback.
// Reset every batch flush to keep memory bounded.
// ============================================================
const _seenPackets = new Set<string>(); // "FN:SID" keys
let _duplicatesDropped = 0;

// ============================================================
// PAUSE/RESUME TRIM TRACKING (Data Quality - Issue #1)
// ============================================================
let _pauseTrimDropped = 0;

// ============================================================
// STOP TRIM TRACKING (Data Quality)
// ============================================================
let _stopTrimDropped = 0;

// ============================================================
// VISIBILITY CHANGE HANDLER (Data Quality - Issue #4)
// ============================================================
// When the browser tab goes hidden, setInterval gets throttled to
// ~1s+. Flush the pending buffer immediately to prevent data loss
// if the browser decides to kill the tab.
// ============================================================
let _visibilityHandler: (() => void) | null = null;

// ============================================================
// EPOCH TRACKING (handles firmware SyncFrameBuffer resets)
// ============================================================
// When the gateway resets outputFrameNumber (e.g. new node join),
// we anchor the new epoch to the current wall-clock position so
// frame-derived timestamps remain monotonically increasing.
// ============================================================
let _epochBaseWallClock = 0; // wall-clock ms at start of current epoch
let _epochBaseFN = 0; // frameNumber at start of current epoch

function _startBatchFlush(
  get: () => RecordingState,
  set: (partial: Partial<RecordingState>) => void,
) {
  if (_batchFlushTimer) return;
  _lastUIUpdate = Date.now();
  _batchFrameCount = 0;
  _batchFlushTimer = setInterval(() => {
    // Flush pending frames to IndexedDB in a single transaction
    if (_pendingFrames.length > 0) {
      const batch = _pendingFrames.splice(0);
      // Clear duplicate detection set each flush (memory bounded)
      _seenPackets.clear();
      dataManager
        .bulkSaveFrames(batch)
        .catch((e) => console.error("[Recording] Batch DB Write Error:", e));
    }

    // Throttled UI update for frameCount + duration
    const now = Date.now();
    if (now - _lastUIUpdate >= UI_UPDATE_INTERVAL_MS) {
      const { recordingStartTime, isRecording } = get();
      if (isRecording && recordingStartTime) {
        set({
          frameCount: _batchFrameCount,
          duration: now - recordingStartTime,
        });
      }
      _lastUIUpdate = now;
    }
  }, BATCH_FLUSH_INTERVAL_MS);

  // Issue #4: Flush immediately when tab goes hidden to prevent data loss
  _visibilityHandler = () => {
    if (document.visibilityState === "hidden" && _pendingFrames.length > 0) {
      console.debug(
        `[Recording] Tab hidden — emergency flush of ${_pendingFrames.length} pending frames`,
      );
      const batch = _pendingFrames.splice(0);
      _seenPackets.clear();
      dataManager
        .bulkSaveFrames(batch)
        .catch((e) => console.error("[Recording] Visibility flush error:", e));
    }
  };
  document.addEventListener("visibilitychange", _visibilityHandler);
}

async function _stopBatchFlush(
  get: () => RecordingState,
  set: (partial: Partial<RecordingState>) => void,
) {
  if (_batchFlushTimer) {
    clearInterval(_batchFlushTimer);
    _batchFlushTimer = null;
  }

  // Remove visibility change listener (Issue #4)
  if (_visibilityHandler) {
    document.removeEventListener("visibilitychange", _visibilityHandler);
    _visibilityHandler = null;
  }

  // =========================================================================
  // STOP TRIM: Remove the last (potentially partial) sync frame
  // =========================================================================
  // When recording stops, the last frameNumber in _pendingFrames may be
  // incomplete (stop arrived mid-frame). Trim those packets before the
  // final flush so the last stored frame is guaranteed complete.
  //
  // NOTE: All sensors within a sync frame arrive in a single synchronous
  // USB parse loop, so the 50ms batch timer never splits a sync frame
  // across flushes. We only need to trim _pendingFrames, not IDB.
  // =========================================================================
  if (_pendingFrames.length > 0) {
    // Find the last frameNumber in the buffer
    let lastFN: number | undefined;
    for (let i = _pendingFrames.length - 1; i >= 0; i--) {
      if (_pendingFrames[i].frameNumber !== undefined) {
        lastFN = _pendingFrames[i].frameNumber;
        break;
      }
    }

    if (lastFN !== undefined) {
      // Count how many sensors we expect per frame
      const expectedSensors = _recSyncDiag?.allSensorIds?.size ?? 0;
      // Count how many sensors this trailing frame actually has
      const trailingCount = _pendingFrames.filter(
        (f) => f.frameNumber === lastFN,
      ).length;

      if (expectedSensors > 0 && trailingCount < expectedSensors) {
        // Partial frame — trim it
        const beforeLen = _pendingFrames.length;
        const trimmed = _pendingFrames.filter((f) => f.frameNumber !== lastFN);
        const dropped = beforeLen - trimmed.length;
        _pendingFrames.length = 0;
        _pendingFrames.push(...trimmed);
        _batchFrameCount -= dropped;
        _stopTrimDropped += dropped;
        console.debug(
          `[Recording] Stop trim: removed ${dropped} packets ` +
            `from partial frame FN=${lastFN} ` +
            `(had ${trailingCount}/${expectedSensors} sensors)`,
        );
      } else {
        console.debug(
          `[Recording] Stop trim: last frame FN=${lastFN} is complete ` +
            `(${trailingCount}/${expectedSensors} sensors) — no trim needed`,
        );
      }
    }
  }

  // Final flush of remaining frames (now guaranteed complete)
  if (_pendingFrames.length > 0) {
    const batch = _pendingFrames.splice(0);
    try {
      await dataManager.bulkSaveFrames(batch);
    } catch (e) {
      console.error("[Recording] Final batch DB Write Error:", e);
    }
  }
  // Final UI update with accurate count
  const { recordingStartTime } = get();
  if (recordingStartTime) {
    set({
      frameCount: _batchFrameCount,
      duration: Date.now() - recordingStartTime,
    });
  }
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  isRecording: false,
  isPaused: false,
  currentSession: null,
  recordingStartTime: null,
  firmwareTimestampBase: null,
  lastFrameNumber: null,
  pendingSession: null,
  showMetadataDialog: false,
  selectedAthleteId: null,
  frameCount: 0,
  duration: 0,

  setSelectedAthlete: (athleteId) => set({ selectedAthleteId: athleteId }),

  startRecording: async (name?: string, athleteId?: string) => {
    const sessionId = `session_${Date.now()}`;
    const sessionName = name || `Recording ${new Date().toLocaleTimeString()}`;
    const now = Date.now();
    const selectedAthlete = athleteId || get().selectedAthleteId;

    // Capture current calibration and sensor mapping for playback reconstruction
    const calibrationOffsets = captureCalibrationOffsets();
    const sensorMapping = captureSensorMapping();
    const tareStates = captureTareStates(); // NEW: Capture 3-level tare states
    const sensorCount = Object.keys(sensorMapping).length;

    // WARN if no sensors are mapped - playback won't work properly
    if (sensorCount === 0) {
      console.warn(
        "[Recording] WARNING: No sensors are assigned to body segments! " +
          "Playback will not show skeleton animation. " +
          "Assign sensors before recording for best results.",
      );
    } else {
      console.debug(
        `[Recording] Captured ${sensorCount} sensor mappings:`,
        Object.entries(sensorMapping)
          .map(([id, seg]) => `${id}->${seg}`)
          .join(", "),
      );
    }

    const session: RecordingSession = {
      id: sessionId,
      name: sessionName,
      startTime: now,
      sensorCount,
      athleteId: selectedAthlete || undefined,
      // Enhanced metadata for reconstruction
      sensorMapping,
      calibrationOffsets:
        calibrationOffsets.length > 0 ? calibrationOffsets : undefined,
      tareStates: tareStates.length > 0 ? tareStates : undefined, // NEW
    };

    // Save session metadata
    await dataManager.createSession(session);

    // Reset epoch tracking for new recording
    _epochBaseWallClock = 0;
    _epochBaseFN = 0;

    // Reset complete-frame gating for new recording
    _startGateFrameNumber = null;
    _startGateOpen = false;
    _startGateSkipped = 0;

    // Reset data quality counters for new recording
    _duplicatesDropped = 0;
    _pauseTrimDropped = 0;
    _stopTrimDropped = 0;
    _seenPackets.clear();

    // Reset sensor integrity monitor for new session
    sensorIntegrityMonitor.reset();

    set({
      isRecording: true,
      isPaused: false,
      recordingStartTime: now,
      firmwareTimestampBase: null,
      lastFrameNumber: null,
      frameCount: 0,
      duration: 0,
      currentSession: session,
    });

    // Start batched IDB flush timer
    _startBatchFlush(get, set);

    console.debug(`[Recording] Started session: ${sessionName}`);
    console.debug(
      `[Recording] Batched recording active (${BATCH_FLUSH_INTERVAL_MS}ms IDB flush, ${UI_UPDATE_INTERVAL_MS}ms UI update)`,
    );
    console.debug(
      `[Recording] Captured ${calibrationOffsets.length} calibration offsets, ${sensorCount} sensor mappings`,
    );

    // Detailed logging for debugging
    if (calibrationOffsets.length > 0) {
      console.debug(`[Recording] Calibration offsets captured:`);
      calibrationOffsets.forEach((o) => {
        console.debug(
          `  ${o.segmentId}: offset=[${o.offset
            .map((n) => n.toFixed(4))
            .join(", ")}] quality=${o.quality}`,
        );
      });
    } else {
      console.warn(
        `[Recording] ⚠️ NO CALIBRATION OFFSETS CAPTURED - playback will show raw poses!`,
      );
    }

    if (Object.keys(sensorMapping).length > 0) {
      console.debug(`[Recording] Sensor mapping captured:`);
      Object.entries(sensorMapping).forEach(([id, seg]) => {
        console.debug(`  Sensor ${id} -> ${seg}`);
      });
    } else {
      console.warn(
        `[Recording] ⚠️ NO SENSOR MAPPING CAPTURED - playback will use fallback!`,
      );
    }
  },

  stopRecording: async () => {
    const { currentSession, recordingStartTime, frameCount } = get();

    if (!currentSession) {
      console.warn("[Recording] No active session to stop");
      return null;
    }

    const endTime = Date.now();
    const durationMs = recordingStartTime ? endTime - recordingStartTime : 0;

    // Use _batchFrameCount for accurate total (store frameCount may lag due to throttled UI updates)
    const actualFrameCount = _batchFrameCount || frameCount;

    // Calculate per-sensor sample rate (not total-frames / duration)
    // actualFrameCount is the total number of individual sensor samples recorded.
    // Divide by the number of unique sensors to get per-sensor Hz.
    const uniqueSensors = _recSyncDiag?.allSensorIds?.size || 1;

    // Hz calculation: Use wall-clock duration (ground truth).
    // Frame-number spans are unreliable because the gateway can reset
    // outputFrameNumber mid-recording (epoch resets on new node join).
    let sampleRate = 0;
    if (durationMs > 0) {
      sampleRate = Math.round(
        actualFrameCount / uniqueSensors / (durationMs / 1000),
      );
      console.debug(
        `[Recording] Wall-clock Hz: ${sampleRate} (${actualFrameCount} samples / ${uniqueSensors} sensors / ${(durationMs / 1000).toFixed(2)}s)`,
      );
    }

    // Fix sensorCount: ALWAYS prefer the actual unique sensor count from data.
    // The initial sensorMapping may miss sensors that join mid-recording
    // (which triggers the firmware epoch reset).
    const actualSensorCount =
      uniqueSensors > 0 ? uniqueSensors : currentSession.sensorCount;

    console.debug(
      `[Recording] Rate calc: ${actualFrameCount} total samples / ${uniqueSensors} sensors / ` +
        `${(durationMs / 1000).toFixed(2)}s = ${sampleRate} Hz/sensor`,
    );

    // Get metrics from Engine
    // We need to access the engine instance. This assumes it's available globally or via hook.
    // Ideally useRecordingStore should depend on useMovementAnalysisStore, but that causes cyclic dep.
    // For now, we will assume we can pass metrics into stopRecording, OR we fetch them here if possible.
    // Let's modify finalizeSession to accept metrics, or capture them here.

    // BETTER APPROACH:
    // We update finalizeSession to allow users to attach the computed metrics.
    // OR we just grab the last known state from the Analysis Store if we can.

    // For this implementation, we will perform a 'best effort' to save what we have.

    // =========================================================================
    // Issue #5: Build data quality summary from recording diagnostics
    // =========================================================================
    const dataQuality = _recSyncDiag
      ? {
          totalFrames: _recSyncDiag.totalFrames,
          completeFrames: _recSyncDiag.fullFrames,
          completenessPercent:
            _recSyncDiag.totalFrames > 0
              ? Math.round(
                  (_recSyncDiag.fullFrames / _recSyncDiag.totalFrames) * 100,
                )
              : 0,
          sensorCount: _recSyncDiag.allSensorIds.size,
          duplicatesDropped: _duplicatesDropped,
          startGateDropped: _startGateSkipped,
          stopTrimDropped: _stopTrimDropped, // Will be updated after _stopBatchFlush
          pauseTrimDropped: _pauseTrimDropped,
          // Sensor integrity summary — anomalies detected during recording
          integrity: sensorIntegrityMonitor.getSerializableSummary(),
        }
      : undefined;

    const finalSession: RecordingSession = {
      ...currentSession,
      endTime,
      sampleRate,
      sensorCount: actualSensorCount,
      dataQuality,
      // Metrics will be added in finalizeSession
    };

    // Update session in DB with final metadata
    await dataManager.updateSession(currentSession.id, {
      endTime,
      sampleRate,
      sensorCount: actualSensorCount,
      dataQuality,
    });

    // Stop batched flush and write remaining frames (may update _stopTrimDropped)
    await _stopBatchFlush(get, set);

    // Update stop-trim count in dataQuality after flush (trim happens inside _stopBatchFlush)
    if (dataQuality && _stopTrimDropped > 0) {
      dataQuality.stopTrimDropped = _stopTrimDropped;
      finalSession.dataQuality = dataQuality;
      await dataManager.updateSession(currentSession.id, { dataQuality });
    }

    if (dataQuality) {
      console.debug(
        `[Recording] Data quality: ${dataQuality.completeFrames}/${dataQuality.totalFrames} complete frames ` +
          `(${dataQuality.completenessPercent}%), ` +
          `${dataQuality.duplicatesDropped} duplicates dropped, ` +
          `${dataQuality.startGateDropped} start-gated, ` +
          `${dataQuality.stopTrimDropped} stop-trimmed, ` +
          `${dataQuality.pauseTrimDropped} pause-trimmed`,
      );
      if (dataQuality.integrity && dataQuality.integrity.totalFlagged > 0) {
        console.warn(
          `[Recording] Sensor integrity: ${dataQuality.integrity.totalFlagged}/${dataQuality.integrity.totalChecked} packets flagged`,
          dataQuality.integrity.flagCounts,
        );
      } else if (dataQuality.integrity) {
        console.debug(
          `[Recording] Sensor integrity: all ${dataQuality.integrity.totalChecked} packets clean ✓`,
        );
      }
    }

    // Set as pending session and open metadata dialog
    _recSyncDiag = null; // Reset recording sync diagnostics
    set({
      isRecording: false,
      isPaused: false,
      currentSession: null,
      pendingSession: finalSession,
      showMetadataDialog: true,
      recordingStartTime: null,
      firmwareTimestampBase: null,
      lastFrameNumber: null,
      duration: durationMs,
    });

    console.debug(
      `[Recording] Stopped session ${currentSession.id}. ${actualFrameCount} frames @ ${sampleRate}Hz`,
    );
    console.debug(
      `[Recording] Session pending - waiting for user metadata before finalization`,
    );
    return finalSession;
  },

  pauseRecording: () => {
    const { isRecording, isPaused } = get();
    if (!isRecording || isPaused) return;

    // Issue #1: Trim partial trailing frame before pausing
    // Same logic as stop-trim but applied at pause boundary
    if (_pendingFrames.length > 0) {
      let lastFN: number | undefined;
      for (let i = _pendingFrames.length - 1; i >= 0; i--) {
        if (_pendingFrames[i].frameNumber !== undefined) {
          lastFN = _pendingFrames[i].frameNumber;
          break;
        }
      }
      if (lastFN !== undefined) {
        const expectedSensors = _recSyncDiag?.allSensorIds?.size ?? 0;
        const trailingCount = _pendingFrames.filter(
          (f) => f.frameNumber === lastFN,
        ).length;
        if (expectedSensors > 0 && trailingCount < expectedSensors) {
          const beforeLen = _pendingFrames.length;
          const trimmed = _pendingFrames.filter(
            (f) => f.frameNumber !== lastFN,
          );
          const dropped = beforeLen - trimmed.length;
          _pendingFrames.length = 0;
          _pendingFrames.push(...trimmed);
          _batchFrameCount -= dropped;
          _pauseTrimDropped += dropped;
          console.debug(
            `[Recording] Pause trim: removed ${dropped} packets ` +
              `from partial frame FN=${lastFN} ` +
              `(had ${trailingCount}/${expectedSensors} sensors)`,
          );
        }
      }

      // Flush remaining complete frames immediately
      if (_pendingFrames.length > 0) {
        const batch = _pendingFrames.splice(0);
        _seenPackets.clear();
        dataManager
          .bulkSaveFrames(batch)
          .catch((e) => console.error("[Recording] Pause flush error:", e));
      }
    }

    set({ isPaused: true });
    console.debug("[Recording] Paused active session");
  },

  resumeRecording: () => {
    const { isRecording, isPaused } = get();
    if (!isRecording || !isPaused) return;

    // Issue #1: Reset start gate so the first frame after resume is also gated
    // (we may catch the tail end of a sync frame that was mid-delivery)
    _startGateFrameNumber = null;
    _startGateOpen = false;
    _startGateSkipped = 0;
    _seenPackets.clear();

    set({ isPaused: false });
    console.debug("[Recording] Resumed active session (start gate re-armed)");
  },

  finalizeSession: async (metadata) => {
    const { pendingSession } = get();
    if (!pendingSession) {
      console.warn("[Recording] No pending session to finalize");
      return;
    }

    // Update session with user-provided metadata
    await dataManager.updateSession(pendingSession.id, {
      name: metadata.name || pendingSession.name,
      athleteId: metadata.athleteId || undefined,
      activityType: metadata.activityType,
      notes: metadata.notes,
      metrics: metadata.metrics, // Save the aggregated metrics
    });

    console.debug(
      `[Recording] Finalized session ${pendingSession.id} as "${
        metadata.name || pendingSession.name
      }"`,
    );

    set({
      pendingSession: null,
      showMetadataDialog: false,
      frameCount: 0,
      duration: 0,
    });
  },

  discardPendingSession: async () => {
    const { pendingSession } = get();
    if (!pendingSession) return;

    // Delete session and all frames from database
    await dataManager.deleteSession(pendingSession.id);
    console.debug(`[Recording] Discarded session ${pendingSession.id}`);

    set({
      pendingSession: null,
      showMetadataDialog: false,
      frameCount: 0,
      duration: 0,
    });
  },

  closeMetadataDialog: () => set({ showMetadataDialog: false }),

  recordFrame: (packet: IMUDataPacket) => {
    const { isRecording, isPaused, currentSession, recordingStartTime } = get();

    if (!isRecording || isPaused || !currentSession || !recordingStartTime)
      return;

    // =========================================================================
    // START GATE: Skip the first (potentially partial) sync frame
    // =========================================================================
    // When recording starts, we may be mid-way through a sync frame — some
    // sensors already dispatched before isRecording became true. Skip all
    // packets sharing the very first frameNumber to guarantee the first
    // recorded frame is complete.
    // =========================================================================
    if (!_startGateOpen) {
      if (packet.frameNumber === undefined) {
        // No frame number available — can't gate, allow through
        _startGateOpen = true;
      } else if (_startGateFrameNumber === null) {
        // First packet: remember this frameNumber and skip it
        _startGateFrameNumber = packet.frameNumber;
        _startGateSkipped++;
        return;
      } else if (packet.frameNumber === _startGateFrameNumber) {
        // Still the same initial frame — skip
        _startGateSkipped++;
        return;
      } else {
        // New frameNumber arrived — the partial first frame is behind us
        _startGateOpen = true;
        console.debug(
          `[Recording] Start gate: skipped ${_startGateSkipped} packets ` +
            `from partial frame FN=${_startGateFrameNumber}. ` +
            `Recording starts at FN=${packet.frameNumber}`,
        );
      }
    }

    const now = Date.now();
    const sensorId = packet.sensorId || 0;

    // =========================================================================
    // DUPLICATE DETECTION (Issue #2)
    // =========================================================================
    // If a USB retransmission or parser glitch sends the same
    // (frameNumber, sensorId) twice, skip the duplicate. The Set is
    // cleared every batch flush (~50ms) so memory stays bounded.
    // =========================================================================
    if (packet.frameNumber !== undefined) {
      const key = `${packet.frameNumber}:${sensorId}`;
      if (_seenPackets.has(key)) {
        _duplicatesDropped++;
        return;
      }
      _seenPackets.add(key);
    }

    // =========================================================================
    // TIMESTAMP STRATEGY — Wall-Clock Based (2026-02-XX Fix)
    // =========================================================================
    // Previously used frameNumber * 5ms, assuming the Gateway's outputFrameNumber
    // increments at exactly 200Hz. In practice, the SyncFrameBuffer can emit
    // frames at a different rate (observed ~388Hz with multi-node setups),
    // causing frame-number-derived timestamps to inflate duration by ~2×.
    //
    // Wall-clock (Date.now() - recordingStartTime) is the ground truth.
    // frameNumber is still preserved in each RecordedFrame for:
    //   - Gap detection (missing frame numbers = lost data)
    //   - Cross-sensor ordering (all sensors in a sync frame share a frameNumber)
    //   - Diagnostics
    //
    // USB batch jitter (~1-2ms) is small compared to the 5ms sample period
    // and does NOT affect playback quality since all sensors in a sync frame
    // arrive in the same USB transfer with nearly identical wall-clock times.
    // =========================================================================

    let { firmwareTimestampBase } = get();

    // Determine relative time in ms using wall-clock
    const relativeMs = now - recordingStartTime;

    // Track firmwareTimestampBase for diagnostics and gap analysis.
    // CRITICAL: Detect firmware epoch resets (SyncFrameBuffer::reset() sets
    // outputFrameNumber back to 0 when a new node registers mid-streaming).
    // Without this, all post-reset timestamps go negative.
    if (packet.frameNumber !== undefined) {
      if (firmwareTimestampBase === null || firmwareTimestampBase === -1) {
        firmwareTimestampBase = packet.frameNumber;
        _epochBaseWallClock = relativeMs;
        _epochBaseFN = packet.frameNumber;
        set({ firmwareTimestampBase, lastFrameNumber: packet.frameNumber });
        console.debug(
          `[Recording] Frame-number base set: ${firmwareTimestampBase} (wall-clock timing active)`,
        );
      } else {
        const lastFN = get().lastFrameNumber ?? firmwareTimestampBase;
        // Epoch reset detection: if frameNumber drops by more than 200
        // (1 second at 200Hz), the firmware has reset its outputFrameNumber.
        // Rebase so subsequent timestamps continue from the wall-clock position.
        if (packet.frameNumber < lastFN - 200) {
          _epochBaseWallClock = relativeMs;
          _epochBaseFN = packet.frameNumber;
          console.warn(
            `[Recording] EPOCH RESET detected: frameNumber ${lastFN} -> ${packet.frameNumber}. ` +
              `Rebasing at wall-clock ${relativeMs}ms`,
          );
        }
        set({ lastFrameNumber: packet.frameNumber });
      }
    } else if (firmwareTimestampBase === null) {
      firmwareTimestampBase = -1;
      set({ firmwareTimestampBase });
    }

    // =========================================================================
    // RECORDING SYNC DIAGNOSTIC
    // Track per-frameNumber sensor composition to detect partial frames
    // Issue #5: Aggregate completeness counters for session dataQuality
    // =========================================================================
    if (packet.frameNumber !== undefined) {
      if (!_recSyncDiag) {
        _recSyncDiag = {
          frameSensors: new Map(),
          totalFrames: 0,
          fullFrames: 0,
          lastReport: now,
          allSensorIds: new Set(),
        };
      }
      const fn = packet.frameNumber;
      const isNewFrame = !_recSyncDiag.frameSensors.has(fn);
      if (isNewFrame) {
        _recSyncDiag.frameSensors.set(fn, new Set());
        _recSyncDiag.totalFrames++;
      }
      const sensorSet = _recSyncDiag.frameSensors.get(fn)!;
      const wasFull =
        sensorSet.size === _recSyncDiag.allSensorIds.size && sensorSet.size > 0;
      sensorSet.add(sensorId);
      _recSyncDiag.allSensorIds.add(sensorId);

      // If this packet just completed the frame, count it
      const expectedSensors = _recSyncDiag.allSensorIds.size;
      if (
        !wasFull &&
        expectedSensors > 0 &&
        sensorSet.size === expectedSensors
      ) {
        _recSyncDiag.fullFrames++;
      }

      // Reset frameSensors window to prevent memory growth (keep counters)
      if (now - _recSyncDiag.lastReport > 5000) {
        _recSyncDiag.frameSensors.clear();
        _recSyncDiag.lastReport = now;
      }
    }
    // =========================================================================

    // Look up segment from session's sensor mapping
    const segment = currentSession.sensorMapping?.[sensorId];

    // Look up sensor name from registry (id must be string)
    const device = useDeviceRegistry.getState().devices.get(String(sensorId));
    const sensorName = device?.name;

    // =========================================================================
    // TIMESTAMP STRATEGY: Epoch-aware frame-number timing
    // =========================================================================
    // Frame numbers provide true 5ms spacing for smooth 200Hz playback.
    // But the gateway can reset outputFrameNumber mid-recording (e.g. when a
    // new node registers, triggering SyncFrameBuffer::reset()). We handle
    // this by tracking per-epoch bases: each epoch has a wall-clock anchor
    // (_epochBaseWallClock) and a frame-number anchor (_epochBaseFN).
    //
    // timestamp = epochBaseWallClock + (frameNumber - epochBaseFN) * 5
    //
    // This ensures timestamps are always monotonically increasing even across
    // firmware epoch resets.
    // =========================================================================
    let frameTimestamp = relativeMs; // Fallback to wall-clock
    if (
      packet.frameNumber !== undefined &&
      firmwareTimestampBase !== null &&
      firmwareTimestampBase >= 0
    ) {
      // Calculate precise timestamp relative to current epoch
      frameTimestamp =
        _epochBaseWallClock + (packet.frameNumber - _epochBaseFN) * 5;
    }

    // =========================================================================
    // SENSOR INTEGRITY CHECK — per-packet anomaly detection
    // =========================================================================
    const integrityResult = sensorIntegrityMonitor.check(packet);

    const frame: RecordedFrame = {
      sessionId: currentSession.id,
      timestamp: frameTimestamp, // Frame-number derived (5ms precision) or wall-clock fallback
      systemTime: now, // Keep wall-clock for absolute reference
      sensorId,
      frameNumber: packet.frameNumber, // Preserve sync frame sequence number
      quaternion: packet.quaternion,
      accelerometer: packet.accelerometer,
      gyro: packet.gyro,
      battery: packet.battery,
      // Enhanced fields for reconstruction
      segment,
      sensorName,
      // Issue #3: Persist frame completeness from firmware parser
      frameCompleteness: packet.frameCompleteness,
      // Integrity flags — only stored when anomalies detected (saves space)
      ...(integrityResult.flags !== IntegrityFlag.NONE && {
        integrityFlags: integrityResult.flags,
      }),
    };

    // Accumulate frame into batch buffer (flushed every 50ms by _batchFlushTimer)
    _pendingFrames.push(frame);
    _batchFrameCount++;
  },

  recordEnvFrame: (packet: EnvironmentalDataPacket) => {
    const { isRecording, isPaused, currentSession } = get();
    if (!isRecording || isPaused || !currentSession) return;

    dataManager
      .saveEnvFrame({
        sessionId: currentSession.id,
        ...packet,
      })
      .catch((e) => console.error("[Recording] Env DB Write Error:", e));
  },

  exportToCSV: async () => {
    const { currentSession } = get();

    if (!currentSession) {
      console.warn("[Recording] No active session to export");
      return null;
    }

    // Fetch all frames via DataManager
    const frames = await dataManager.exportSessionData(currentSession.id);

    if (frames.length === 0) {
      console.warn("[Recording] No data found for session", currentSession.id);
      return null;
    }

    const t0 = performance.now();
    try {
      const csv = await buildCsvInWorker(currentSession, frames);
      const t1 = performance.now();
      console.info(
        `[RecordingPerf] CSV export prepared in worker: ${(t1 - t0).toFixed(1)}ms (${frames.length} frames)`,
      );
      return csv;
    } catch (workerError) {
      console.warn(
        "[Recording] CSV worker failed, falling back to main thread:",
        workerError,
      );
      const csv = buildRecordingCsv({ session: currentSession, frames });
      const t1 = performance.now();
      console.info(
        `[RecordingPerf] CSV export prepared on main thread: ${(t1 - t0).toFixed(1)}ms (${frames.length} frames)`,
      );
      return csv;
    }
  },

  downloadCSV: async (filename?: string) => {
    const csv = await get().exportToCSV();

    if (!csv) {
      console.error("[Recording] No CSV data to download");
      return;
    }

    const { currentSession } = get();
    const defaultFilename = currentSession
      ? `${currentSession.name.replace(/[^a-zA-Z0-9]/g, "_")}_${
          new Date(currentSession.startTime).toISOString().split("T")[0]
        }.csv`
      : `imu_recording_${Date.now()}.csv`;

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename || defaultFilename;
    link.style.display = "none";

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
    console.debug(`[Recording] Downloaded: ${link.download}`);
  },

  clearCurrentSession: () => {
    set({
      isRecording: false,
      isPaused: false,
      currentSession: null,
      recordingStartTime: null,
      firmwareTimestampBase: null,
      lastFrameNumber: null,
      frameCount: 0,
      duration: 0,
    });
  },
}));

// Register with StoreRegistry for cross-store access
import { registerRecordingStore, getTareStore } from "./StoreRegistry";
registerRecordingStore(useRecordingStore);
