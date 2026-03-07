import type { RecordedFrame } from "../db";

export interface PreparePlaybackSessionInput {
  frames: RecordedFrame[];
  sessionStartTime: number;
  sessionEndTime?: number;
  defaultFrameRate?: number;
  recordedSampleRate?: number;
}

export interface PackedSensorTimeline {
  timestamps: Float32Array;
  quaternions: Float32Array; // [w,x,y,z] flattened per frame
  accelerometer: Float32Array; // [ax,ay,az] flattened per frame
  gyro: Float32Array; // [gx,gy,gz] flattened per frame
  frameNumbers?: Uint32Array;
}

export interface PreparePlaybackSessionResult {
  frames: RecordedFrame[];
  groupedFramesBySensor: Record<string, RecordedFrame[]>;
  packedTimelinesBySensor: Record<string, PackedSensorTimeline>;
  sensorIds: number[];
  duration: number;
  frameRate: number;
}

export function preparePlaybackSession(
  input: PreparePlaybackSessionInput,
): PreparePlaybackSessionResult {
  const {
    frames,
    sessionStartTime,
    sessionEndTime,
    defaultFrameRate = 60,
    recordedSampleRate,
  } = input;

  const copiedFrames = frames.slice();

  const groupedFramesBySensor: Record<string, RecordedFrame[]> = {};
  const packedTimelinesBySensor: Record<string, PackedSensorTimeline> = {};
  const sensorSet = new Set<number>();

  for (const frame of copiedFrames) {
    const sensorId = frame.sensorId ?? 0;
    sensorSet.add(sensorId);
    const key = String(sensorId);
    if (!groupedFramesBySensor[key]) groupedFramesBySensor[key] = [];
    groupedFramesBySensor[key].push(frame);
  }

  // =========================================================================
  // TIMESTAMP STRATEGY: prefer frame-number-derived timestamps (5ms spacing)
  // =========================================================================
  // The recording store already writes:
  //   frame.timestamp = epochBaseWallClock + (frameNumber - epochBaseFN) * 5
  // These are clean 5ms-spaced timestamps anchored to the gateway's 200Hz
  // TDMA clock. We normalise them so the session starts at t=0 and derive
  // duration from the frame-number span — no wall-clock jitter.
  //
  // Fallback: if frames lack frame numbers, use systemTime (wall-clock).
  // =========================================================================

  // Detect whether frames carry valid frame numbers
  let minFrameNumber = Infinity;
  let maxFrameNumber = -Infinity;
  for (const frame of copiedFrames) {
    if (
      typeof frame.frameNumber === "number" &&
      Number.isFinite(frame.frameNumber)
    ) {
      if (frame.frameNumber < minFrameNumber)
        minFrameNumber = frame.frameNumber;
      if (frame.frameNumber > maxFrameNumber)
        maxFrameNumber = frame.frameNumber;
    }
  }
  const hasFrameNumberSpan =
    minFrameNumber < Infinity && maxFrameNumber > minFrameNumber;

  let minSystemTime = Infinity;
  let maxSystemTime = -Infinity;
  for (const frame of copiedFrames) {
    if (
      typeof frame.systemTime === "number" &&
      Number.isFinite(frame.systemTime)
    ) {
      if (frame.systemTime < minSystemTime) minSystemTime = frame.systemTime;
      if (frame.systemTime > maxSystemTime) maxSystemTime = frame.systemTime;
    }
  }
  const hasSystemTimeSpan =
    minSystemTime < Infinity && maxSystemTime > minSystemTime;

  const sessionWallClockMs =
    typeof sessionEndTime === "number" && sessionEndTime > sessionStartTime
      ? sessionEndTime - sessionStartTime
      : 0;

  const FRAME_PERIOD_MS = 5; // 200Hz gateway clock
  let duration = 0;

  if (hasFrameNumberSpan) {
    // Best path: derive duration and per-frame timestamps from frame numbers.
    // This gives perfectly uniform 5ms spacing with zero jitter.
    const frameSpan = maxFrameNumber - minFrameNumber;
    duration = frameSpan * FRAME_PERIOD_MS;

    // Normalise each frame's timestamp to session-relative milliseconds.
    // Frames already carry epoch-aware timestamps from the recording store,
    // but we re-derive from frameNumber to guarantee zero drift and to
    // handle legacy sessions where timestamps might have been overwritten.
    for (const frame of copiedFrames) {
      if (
        typeof frame.frameNumber === "number" &&
        Number.isFinite(frame.frameNumber)
      ) {
        frame.timestamp =
          (frame.frameNumber - minFrameNumber) * FRAME_PERIOD_MS;
      }
    }
  } else if (hasSystemTimeSpan) {
    // Fallback: no frame numbers — use wall-clock systemTime.
    duration = maxSystemTime - minSystemTime;
    const baseSystemTime = minSystemTime;
    for (const frame of copiedFrames) {
      if (
        typeof frame.systemTime === "number" &&
        Number.isFinite(frame.systemTime)
      ) {
        frame.timestamp = frame.systemTime - baseSystemTime;
      }
    }
  } else if (sessionWallClockMs > 0) {
    duration = sessionWallClockMs;
  } else {
    const firstTimestamp = copiedFrames[0]?.timestamp ?? 0;
    const lastTimestamp = copiedFrames[copiedFrames.length - 1]?.timestamp ?? 0;
    duration =
      lastTimestamp > firstTimestamp ? lastTimestamp - firstTimestamp : 0;
  }

  for (const key of Object.keys(groupedFramesBySensor)) {
    groupedFramesBySensor[key].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      const afn =
        typeof a.frameNumber === "number"
          ? a.frameNumber
          : Number.MAX_SAFE_INTEGER;
      const bfn =
        typeof b.frameNumber === "number"
          ? b.frameNumber
          : Number.MAX_SAFE_INTEGER;
      return afn - bfn;
    });
  }

  for (const key of Object.keys(groupedFramesBySensor)) {
    const sensorFrames = groupedFramesBySensor[key];
    const n = sensorFrames.length;

    const timestamps = new Float32Array(n);
    const quaternions = new Float32Array(n * 4);
    const accelerometer = new Float32Array(n * 3);
    const gyro = new Float32Array(n * 3);

    let hasFrameNumbers = false;
    const frameNumbers = new Uint32Array(n);

    for (let i = 0; i < n; i++) {
      const frame = sensorFrames[i];
      timestamps[i] = frame.timestamp;

      const q = frame.quaternion || [1, 0, 0, 0];
      quaternions[i * 4 + 0] = q[0] ?? 1;
      quaternions[i * 4 + 1] = q[1] ?? 0;
      quaternions[i * 4 + 2] = q[2] ?? 0;
      quaternions[i * 4 + 3] = q[3] ?? 0;

      const g = frame.gyro || [0, 0, 0];
      gyro[i * 3 + 0] = g[0] ?? 0;
      gyro[i * 3 + 1] = g[1] ?? 0;
      gyro[i * 3 + 2] = g[2] ?? 0;

      const a = frame.accelerometer || [0, 0, 0];
      accelerometer[i * 3 + 0] = a[0] ?? 0;
      accelerometer[i * 3 + 1] = a[1] ?? 0;
      accelerometer[i * 3 + 2] = a[2] ?? 0;

      if (
        typeof frame.frameNumber === "number" &&
        Number.isFinite(frame.frameNumber)
      ) {
        frameNumbers[i] = frame.frameNumber;
        hasFrameNumbers = true;
      }
    }

    packedTimelinesBySensor[key] = {
      timestamps,
      quaternions,
      accelerometer,
      gyro,
      frameNumbers: hasFrameNumbers ? frameNumbers : undefined,
    };
  }

  let frameRate = defaultFrameRate;
  const packetLocalTransport = copiedFrames.some((frame) => {
    const expectedCount = Number(frame.frameCompleteness?.expectedCount ?? 0);
    return expectedCount > 0 && expectedCount < sensorSet.size;
  });
  if (duration > 0 && sensorSet.size > 0) {
    const durationSec = duration / 1000;
    let bestUniqueFrameNumbers = 0;

    for (const key of Object.keys(groupedFramesBySensor)) {
      const sensorFrames = groupedFramesBySensor[key];
      const uniqueFrameNumbers = new Set<number>();
      for (const frame of sensorFrames) {
        if (
          typeof frame.frameNumber === "number" &&
          Number.isFinite(frame.frameNumber)
        ) {
          uniqueFrameNumbers.add(frame.frameNumber);
        }
      }
      if (uniqueFrameNumbers.size > bestUniqueFrameNumbers) {
        bestUniqueFrameNumbers = uniqueFrameNumbers.size;
      }
    }

    if (
      packetLocalTransport &&
      typeof recordedSampleRate === "number" &&
      Number.isFinite(recordedSampleRate) &&
      recordedSampleRate > 0
    ) {
      frameRate = Math.round(recordedSampleRate);
    } else if (bestUniqueFrameNumbers >= 2) {
      frameRate = Math.round((bestUniqueFrameNumbers - 1) / durationSec);
    } else {
      let maxSensorFrames = 0;
      for (const key of Object.keys(groupedFramesBySensor)) {
        const sensorFrames = groupedFramesBySensor[key];
        if (sensorFrames.length > maxSensorFrames)
          maxSensorFrames = sensorFrames.length;
      }
      frameRate = Math.round((maxSensorFrames / duration) * 1000);
    }
  }

  frameRate = Math.max(1, Math.min(1000, frameRate));

  return {
    frames: copiedFrames,
    groupedFramesBySensor,
    packedTimelinesBySensor,
    sensorIds: Array.from(sensorSet).sort((a, b) => a - b),
    duration,
    frameRate,
  };
}
