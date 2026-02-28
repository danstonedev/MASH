import type { RecordedEnvFrame, RecordedFrame, RecordingSession } from "../db";

export const DEFAULT_EXPORT_CHUNK_SIZE = 2000;

interface CsvChunkProgress {
  processed: number;
  total: number;
}

interface JsonChunkProgress {
  phase: "imu" | "env";
  processed: number;
  total: number;
}

interface SerializeRecordingCsvChunkedInput {
  session: RecordingSession;
  frames: RecordedFrame[];
  chunkSize?: number;
  onProgress?: (progress: CsvChunkProgress) => void;
}

interface SerializeSessionJsonChunkedInput {
  session: RecordingSession;
  imuFrames: RecordedFrame[];
  envFrames: RecordedEnvFrame[];
  jsonSchema: "legacy" | "full";
  chunkSize?: number;
  onProgress?: (progress: JsonChunkProgress) => void;
}

export function serializeRecordingCsvChunked({
  session,
  frames,
  chunkSize = DEFAULT_EXPORT_CHUNK_SIZE,
  onProgress,
}: SerializeRecordingCsvChunkedInput): string | null {
  if (!frames || frames.length === 0) {
    return null;
  }

  const durationSec = session.endTime
    ? (session.endTime - session.startTime) / 1000
    : frames.length > 0
      ? frames[frames.length - 1].timestamp / 1000
      : 0;

  const sampleRate =
    session.sampleRate ||
    (durationSec > 0
      ? Math.round(frames.length / (session.sensorCount || 1) / durationSec)
      : 0);

  const firstFrameNumber = frames.reduce(
    (min, frame) =>
      frame.frameNumber !== undefined && frame.frameNumber < min
        ? frame.frameNumber
        : min,
    Infinity,
  );

  const lines: string[] = [];
  lines.push("# IMU Connect Session Export");
  lines.push(`# Session: ${session.name}`);
  lines.push(`# Date: ${new Date(session.startTime).toISOString()}`);
  lines.push(`# Duration: ${durationSec.toFixed(2)}s`);
  lines.push(`# Sample Rate: ${sampleRate} Hz`);
  lines.push(`# Frames: ${frames.length}`);
  lines.push(`# Sensors: ${session.sensorCount}`);
  lines.push("#");

  if (session.sensorMapping && Object.keys(session.sensorMapping).length > 0) {
    lines.push("# Sensor Mapping:");
    Object.entries(session.sensorMapping).forEach(([id, segment]) => {
      lines.push(`#   ${id}=${segment}`);
    });
    lines.push("#");
  }

  if (session.calibrationOffsets && session.calibrationOffsets.length > 0) {
    lines.push("# Calibration Offsets (quaternion w,x,y,z):");
    session.calibrationOffsets.forEach((offset) => {
      lines.push(
        `#   ${offset.segmentId}: ${offset.offset
          .map((value) => value.toFixed(6))
          .join(",")}`,
      );
    });
    lines.push("#");
  }

  lines.push(
    [
      "arrival_time_s",
      "arrival_time_ms",
      "hardware_time_s",
      "hardware_time_ms",
      "frame_number",
      "relative_frame",
      "sensor_id",
      "segment",
      "qw",
      "qx",
      "qy",
      "qz",
      "ax (m/s^2)",
      "ay (m/s^2)",
      "az (m/s^2)",
      "gx (rad/s)",
      "gy (rad/s)",
      "gz (rad/s)",
      "battery",
    ].join(","),
  );

  const total = frames.length;
  let processed = 0;
  for (let index = 0; index < total; index += chunkSize) {
    const end = Math.min(index + chunkSize, total);
    for (let i = index; i < end; i += 1) {
      lines.push(formatCsvFrameLine(frames[i], firstFrameNumber));
    }
    processed = end;
    onProgress?.({ processed, total });
  }

  return lines.join("\n");
}

export function serializeSessionJsonChunked({
  session,
  imuFrames,
  envFrames,
  jsonSchema,
  chunkSize = DEFAULT_EXPORT_CHUNK_SIZE,
  onProgress,
}: SerializeSessionJsonChunkedInput): string {
  if (jsonSchema === "legacy") {
    const imu = stringifyArrayChunked(
      imuFrames,
      chunkSize,
      (frame) => frame,
      (processed, total) => onProgress?.({ phase: "imu", processed, total }),
    );
    const env = stringifyArrayChunked(
      envFrames,
      chunkSize,
      (frame) => frame,
      (processed, total) => onProgress?.({ phase: "env", processed, total }),
    );

    return `{"metadata":${JSON.stringify(session)},"imu":${imu},"environmental":${env}}`;
  }

  const durationMs = session.endTime
    ? session.endTime - session.startTime
    : imuFrames.length > 0
      ? imuFrames[imuFrames.length - 1].timestamp
      : 0;

  const sampleRate =
    session.sampleRate ||
    (durationMs > 0 ? Math.round(imuFrames.length / (durationMs / 1000)) : 0);

  const imu = stringifyArrayChunked(
    imuFrames,
    chunkSize,
    (frame) => ({
      t: frame.timestamp,
      s: frame.sensorId,
      seg: frame.segment,
      q: frame.quaternion,
      a: frame.accelerometer,
      g: frame.gyro,
      b: frame.battery,
    }),
    (processed, total) => onProgress?.({ phase: "imu", processed, total }),
  );

  const env = stringifyArrayChunked(
    envFrames,
    chunkSize,
    (frame) => ({
      t: frame.timestamp,
      baro: frame.barometer
        ? {
            p: frame.barometer.pressure,
            temp: frame.barometer.temperature,
            alt: frame.barometer.altitude,
          }
        : undefined,
      mag: frame.magnetometer
        ? {
            x: frame.magnetometer.x,
            y: frame.magnetometer.y,
            z: frame.magnetometer.z,
            h: frame.magnetometer.heading,
          }
        : undefined,
    }),
    (processed, total) => onProgress?.({ phase: "env", processed, total }),
  );

  return `{"exportVersion":"1.0.0","exportedAt":"${new Date().toISOString()}","session":${JSON.stringify(
    {
      id: session.id,
      name: session.name,
      startTime: session.startTime,
      startTimeISO: new Date(session.startTime).toISOString(),
      endTime: session.endTime,
      endTimeISO: session.endTime
        ? new Date(session.endTime).toISOString()
        : null,
      durationMs,
      durationSec: durationMs / 1000,
      sampleRate,
      sensorCount: session.sensorCount,
      athleteId: session.athleteId,
      notes: session.notes,
      tags: session.tags,
    },
  )},"sensorMapping":${JSON.stringify(session.sensorMapping || {})},"calibration":${JSON.stringify(
    {
      offsets: session.calibrationOffsets || [],
      method: session.calibrationOffsets?.[0]?.method || "unknown",
    },
  )},"environmentalConditions":${safeJsonValue(
    session.environmentalConditions,
  )},"data":{"imuFrameCount":${imuFrames.length},"envFrameCount":${envFrames.length},"imuFrames":${imu},"envFrames":${env}}}`;
}

function stringifyArrayChunked<TInput, TOutput>(
  source: TInput[],
  chunkSize: number,
  mapper: (value: TInput) => TOutput,
  onProgress?: (processed: number, total: number) => void,
): string {
  if (source.length === 0) {
    onProgress?.(0, 0);
    return "[]";
  }

  const chunks: string[] = [];
  const total = source.length;

  for (let index = 0; index < total; index += chunkSize) {
    const end = Math.min(index + chunkSize, total);
    const chunk = source
      .slice(index, end)
      .map((value) => JSON.stringify(mapper(value)))
      .join(",");
    chunks.push(chunk);
    onProgress?.(end, total);
  }

  return `[${chunks.join(",")}]`;
}

function formatCsvFrameLine(
  frame: RecordedFrame,
  firstFrameNumber: number,
): string {
  const relativeFrame =
    frame.frameNumber !== undefined && firstFrameNumber !== Infinity
      ? frame.frameNumber - firstFrameNumber
      : 0;
  const hardwareTimeMs = relativeFrame * 5.0;

  return [
    (frame.timestamp / 1000).toFixed(4),
    frame.timestamp.toFixed(1),
    (hardwareTimeMs / 1000).toFixed(4),
    hardwareTimeMs.toFixed(1),
    frame.frameNumber ?? "",
    relativeFrame,
    frame.sensorId ?? 0,
    frame.segment || "",
    frame.quaternion[0].toFixed(6),
    frame.quaternion[1].toFixed(6),
    frame.quaternion[2].toFixed(6),
    frame.quaternion[3].toFixed(6),
    frame.accelerometer[0].toFixed(4),
    frame.accelerometer[1].toFixed(4),
    frame.accelerometer[2].toFixed(4),
    frame.gyro ? frame.gyro[0].toFixed(4) : "0",
    frame.gyro ? frame.gyro[1].toFixed(4) : "0",
    frame.gyro ? frame.gyro[2].toFixed(4) : "0",
    frame.battery ?? 0,
  ].join(",");
}

function safeJsonValue(value: unknown): string {
  return value === undefined ? "null" : JSON.stringify(value);
}
