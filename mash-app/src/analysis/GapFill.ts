import * as THREE from "three";
import { dataManager } from "../lib/db";
import type { RecordedFrame, RecordingSession } from "../lib/db";

export type GapFillMethod = "slerp-linear";

export interface GapFillOptions {
  /** Target frame rate for frameNumber deltas (default: 200Hz) */
  frameRateHz?: number;
  /** Only fill gaps up to this duration (default: 100ms) */
  maxFillGapMs?: number;
  /** Skip filling gaps that start/end are missing quaternion/accel (default: true) */
  requireEndpoints?: boolean;
}

export interface GapFillSummary {
  sessionId?: string;
  frameRateHz: number;
  framePeriodMs: number;
  maxFillGapMs: number;
  sensors: Array<{
    sensorId: number;
    filledFrames: number;
    filledGaps: number;
    skippedGaps: number;
    skippedFrames: number;
    longestFilledGapMs: number;
  }>;
  totalFilledFrames: number;
  totalFilledGaps: number;
  totalSkippedGaps: number;
}

export interface GapFilledFrame extends RecordedFrame {
  /** True if this frame was synthesized */
  __filled?: true;
  __fill?: {
    method: GapFillMethod;
    prevFrameNumber: number;
    nextFrameNumber: number;
    alpha: number;
  };
}

export interface GapFillResult {
  frames: GapFilledFrame[];
  summary: GapFillSummary;
}

const _qPrev = new THREE.Quaternion();
const _qNext = new THREE.Quaternion();
const _qOut = new THREE.Quaternion();

function downloadJSON(obj: unknown, filename: string): void {
  const json = JSON.stringify(obj, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getFrameNumber(frame: RecordedFrame): number {
  if (typeof frame.frameNumber === "number") return frame.frameNumber;
  // Fall back to timestamp-based pseudo index (ms). This is less precise but keeps function usable.
  return Math.round(frame.timestamp);
}

function groupBySensor(frames: RecordedFrame[]): Map<number, RecordedFrame[]> {
  const m = new Map<number, RecordedFrame[]>();
  for (const f of frames) {
    const sid = f.sensorId ?? 0;
    const arr = m.get(sid);
    if (arr) arr.push(f);
    else m.set(sid, [f]);
  }
  return m;
}

function fillSensorFrames(
  sensorId: number,
  sensorFrames: RecordedFrame[],
  options: Required<GapFillOptions>,
  framePeriodMs: number,
): { frames: GapFilledFrame[]; stats: GapFillSummary["sensors"][number] } {
  const sorted = [...sensorFrames].sort((a, b) => getFrameNumber(a) - getFrameNumber(b));

  let filledFrames = 0;
  let filledGaps = 0;
  let skippedGaps = 0;
  let skippedFrames = 0;
  let longestFilledGapMs = 0;

  const out: GapFilledFrame[] = [];

  if (sorted.length === 0) {
    return {
      frames: out,
      stats: {
        sensorId,
        filledFrames,
        filledGaps,
        skippedGaps,
        skippedFrames,
        longestFilledGapMs,
      },
    };
  }

  out.push(sorted[0] as GapFilledFrame);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];

    const prevFn = getFrameNumber(prev);
    const nextFn = getFrameNumber(next);
    const deltaFrames = nextFn - prevFn;

    if (deltaFrames <= 1) {
      out.push(next as GapFilledFrame);
      continue;
    }

    const gapMissingFrames = deltaFrames - 1;
    const gapDurationMs = gapMissingFrames * framePeriodMs;

    const canFillDuration = gapDurationMs <= options.maxFillGapMs;
    const hasEndpoints =
      !!prev.quaternion &&
      !!next.quaternion &&
      !!prev.accelerometer &&
      !!next.accelerometer;

    const canFill = canFillDuration && (!options.requireEndpoints || hasEndpoints);

    if (!canFill) {
      skippedGaps++;
      skippedFrames += gapMissingFrames;
      out.push(next as GapFilledFrame);
      continue;
    }

    filledGaps++;
    longestFilledGapMs = Math.max(longestFilledGapMs, gapDurationMs);

    // Prepare quaternions
    _qPrev.set(prev.quaternion[1], prev.quaternion[2], prev.quaternion[3], prev.quaternion[0]);
    _qNext.set(next.quaternion[1], next.quaternion[2], next.quaternion[3], next.quaternion[0]);

    // Hemisphere check for shortest path
    if (_qPrev.dot(_qNext) < 0) {
      _qNext.x = -_qNext.x;
      _qNext.y = -_qNext.y;
      _qNext.z = -_qNext.z;
      _qNext.w = -_qNext.w;
    }

    // Fill missing frames
    for (let k = 1; k <= gapMissingFrames; k++) {
      const alpha = k / (gapMissingFrames + 1);
      _qOut.copy(_qPrev).slerp(_qNext, alpha);

      const ts = prev.timestamp + k * framePeriodMs;

      const ax = prev.accelerometer[0] + (next.accelerometer[0] - prev.accelerometer[0]) * alpha;
      const ay = prev.accelerometer[1] + (next.accelerometer[1] - prev.accelerometer[1]) * alpha;
      const az = prev.accelerometer[2] + (next.accelerometer[2] - prev.accelerometer[2]) * alpha;

      const gPrev = prev.gyro ?? [0, 0, 0];
      const gNext = next.gyro ?? [0, 0, 0];
      const gx = gPrev[0] + (gNext[0] - gPrev[0]) * alpha;
      const gy = gPrev[1] + (gNext[1] - gPrev[1]) * alpha;
      const gz = gPrev[2] + (gNext[2] - gPrev[2]) * alpha;

      const filled: GapFilledFrame = {
        // Preserve identifiers
        sessionId: prev.sessionId,
        systemTime: prev.systemTime,
        sensorId: prev.sensorId,
        segment: prev.segment,
        sensorName: prev.sensorName,

        // Filled timing
        timestamp: ts,
        frameNumber: prevFn + k,

        // Filled signals
        quaternion: [_qOut.w, _qOut.x, _qOut.y, _qOut.z],
        accelerometer: [ax, ay, az],
        gyro: [gx, gy, gz],
        battery: prev.battery,

        // Metadata
        format: prev.format,
        syncQuality: prev.syncQuality,

        __filled: true,
        __fill: {
          method: "slerp-linear",
          prevFrameNumber: prevFn,
          nextFrameNumber: nextFn,
          alpha,
        },
      };

      out.push(filled);
      filledFrames++;
    }

    out.push(next as GapFilledFrame);
  }

  return {
    frames: out,
    stats: {
      sensorId,
      filledFrames,
      filledGaps,
      skippedGaps,
      skippedFrames,
      longestFilledGapMs,
    },
  };
}

export function fillGaps(frames: RecordedFrame[], opts?: GapFillOptions): GapFillResult {
  const options: Required<GapFillOptions> = {
    frameRateHz: opts?.frameRateHz ?? 200,
    maxFillGapMs: opts?.maxFillGapMs ?? 100,
    requireEndpoints: opts?.requireEndpoints ?? true,
  };

  const framePeriodMs = 1000 / options.frameRateHz;

  const grouped = groupBySensor(frames);

  const perSensor: GapFillSummary["sensors"] = [];
  const allOut: GapFilledFrame[] = [];

  let totalFilledFrames = 0;
  let totalFilledGaps = 0;
  let totalSkippedGaps = 0;

  for (const [sensorId, sensorFrames] of grouped.entries()) {
    const { frames: filled, stats } = fillSensorFrames(
      sensorId,
      sensorFrames,
      options,
      framePeriodMs,
    );

    allOut.push(...filled);
    perSensor.push(stats);

    totalFilledFrames += stats.filledFrames;
    totalFilledGaps += stats.filledGaps;
    totalSkippedGaps += stats.skippedGaps;
  }

  // Keep a stable order for export (by sensorId then frameNumber)
  allOut.sort((a, b) => {
    const aSid = a.sensorId ?? 0;
    const bSid = b.sensorId ?? 0;
    if (aSid !== bSid) return aSid - bSid;
    return getFrameNumber(a) - getFrameNumber(b);
  });

  const summary: GapFillSummary = {
    frameRateHz: options.frameRateHz,
    framePeriodMs,
    maxFillGapMs: options.maxFillGapMs,
    sensors: perSensor.sort((a, b) => a.sensorId - b.sensorId),
    totalFilledFrames,
    totalFilledGaps,
    totalSkippedGaps,
  };

  return { frames: allOut, summary };
}

export async function exportGapFilledSession(sessionId: string, opts?: GapFillOptions): Promise<void> {
  const session = (await dataManager.getSession(sessionId)) as RecordingSession | undefined;
  const frames = await dataManager.exportSessionData(sessionId);

  const frameRateHz = opts?.frameRateHz ?? session?.sampleRate ?? 200;
  const result = fillGaps(frames, { ...opts, frameRateHz });
  result.summary.sessionId = sessionId;

  const safeName = (session?.name || sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  downloadJSON(
    {
      session: session || { id: sessionId },
      gapFill: result.summary,
      frames: result.frames,
    },
    `gap-filled-${safeName}-${ts}.json`,
  );
}

// Expose to window for zero-UI usage (DevTools-driven)
declare global {
  interface Window {
    __exportGapFilledSession?: (sessionId: string, opts?: GapFillOptions) => Promise<void>;
    __fillGaps?: (frames: RecordedFrame[], opts?: GapFillOptions) => GapFillResult;
  }
}

if (typeof window !== "undefined") {
  window.__exportGapFilledSession = exportGapFilledSession;
  window.__fillGaps = fillGaps;
}
