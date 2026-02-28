import type { RecordedFrame } from "../db";

export interface PreparePlaybackSessionInput {
  frames: RecordedFrame[];
  sessionStartTime: number;
  sessionEndTime?: number;
  defaultFrameRate?: number;
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
  const frameWallClockMs = hasSystemTimeSpan
    ? maxSystemTime - minSystemTime
    : 0;

  const firstTimestamp = copiedFrames[0]?.timestamp ?? 0;
  const lastTimestamp = copiedFrames[copiedFrames.length - 1]?.timestamp ?? 0;
  const frameTimestampSpan = lastTimestamp - firstTimestamp;

  const sessionWallClockMs =
    typeof sessionEndTime === "number" && sessionEndTime > sessionStartTime
      ? sessionEndTime - sessionStartTime
      : 0;

  let duration = 0;
  if (hasSystemTimeSpan) {
    duration = frameWallClockMs;

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
    duration = frameTimestampSpan > 0 ? frameTimestampSpan : 0;
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
  if (duration > 100 && sensorSet.size > 0) {
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

    if (bestUniqueFrameNumbers >= 2) {
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
