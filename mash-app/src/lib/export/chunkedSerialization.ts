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

function getEffectiveSensorCount(
  frames: RecordedFrame[],
  fallbackSensorCount: number,
): number {
  const uniqueSensors = new Set<number>();
  for (const frame of frames) {
    if (Number.isFinite(frame.sensorId)) {
      uniqueSensors.add(frame.sensorId);
    }
  }

  return uniqueSensors.size > 0
    ? uniqueSensors.size
    : Math.max(1, fallbackSensorCount || 1);
}

// ============================================================================
// Sync-trim: clip to the contiguous range of fully-synchronized frames
// ============================================================================
// During ramp-up nodes join one by one, and during ramp-down they leave one
// by one. This trims both ends so every exported packet belongs to a
// frameNumber where ALL session sensors are present.
//
// Returns a new (possibly smaller) array — the input is not mutated.
// ============================================================================

export interface SyncTrimResult {
  frames: RecordedFrame[];
  /** frameNumbers trimmed from the start */
  trimmedStartFrames: number;
  /** frameNumbers trimmed from the end */
  trimmedEndFrames: number;
  /** Total individual packets removed */
  trimmedPackets: number;
  /** True if any trimming was performed */
  wasTrimmed: boolean;
}

export function trimToFullSensorFrames(
  frames: RecordedFrame[],
): SyncTrimResult {
  if (frames.length === 0) {
    return {
      frames: [],
      trimmedStartFrames: 0,
      trimmedEndFrames: 0,
      trimmedPackets: 0,
      wasTrimmed: false,
    };
  }

  // 1. Discover all sensors
  const allSensors = new Set<number>();
  for (const f of frames) {
    if (Number.isFinite(f.sensorId)) allSensors.add(f.sensorId!);
  }
  const expectedCount = allSensors.size;
  if (expectedCount <= 1) {
    return {
      frames,
      trimmedStartFrames: 0,
      trimmedEndFrames: 0,
      trimmedPackets: 0,
      wasTrimmed: false,
    };
  }

  // 2. Group by frameNumber and count sensors per frame
  const frameSensorCounts = new Map<number, number>();
  for (const f of frames) {
    const fn = f.frameNumber;
    if (typeof fn !== "number" || !Number.isFinite(fn)) continue;
    frameSensorCounts.set(fn, (frameSensorCounts.get(fn) ?? 0) + 1);
  }

  const sortedFNs = Array.from(frameSensorCounts.keys()).sort((a, b) => a - b);

  // 3. Find first complete frame from the start
  let startIdx = 0;
  while (
    startIdx < sortedFNs.length &&
    frameSensorCounts.get(sortedFNs[startIdx])! < expectedCount
  ) {
    startIdx++;
  }

  // 4. Find last complete frame from the end
  let endIdx = sortedFNs.length - 1;
  while (
    endIdx >= startIdx &&
    frameSensorCounts.get(sortedFNs[endIdx])! < expectedCount
  ) {
    endIdx--;
  }

  // No complete frames at all — return empty
  if (startIdx > endIdx) {
    return {
      frames: [],
      trimmedStartFrames: sortedFNs.length,
      trimmedEndFrames: 0,
      trimmedPackets: frames.length,
      wasTrimmed: true,
    };
  }

  const trimmedStartFrames = startIdx;
  const trimmedEndFrames = sortedFNs.length - 1 - endIdx;

  if (trimmedStartFrames === 0 && trimmedEndFrames === 0) {
    return {
      frames,
      trimmedStartFrames: 0,
      trimmedEndFrames: 0,
      trimmedPackets: 0,
      wasTrimmed: false,
    };
  }

  const firstFN = sortedFNs[startIdx];
  const lastFN = sortedFNs[endIdx];

  const trimmed = frames.filter((f) => {
    const fn = f.frameNumber;
    return typeof fn === "number" && fn >= firstFN && fn <= lastFN;
  });

  return {
    frames: trimmed,
    trimmedStartFrames,
    trimmedEndFrames,
    trimmedPackets: frames.length - trimmed.length,
    wasTrimmed: true,
  };
}

export function serializeRecordingCsvChunked({
  session,
  frames: rawFrames,
  chunkSize = DEFAULT_EXPORT_CHUNK_SIZE,
  onProgress,
}: SerializeRecordingCsvChunkedInput): string | null {
  if (!rawFrames || rawFrames.length === 0) {
    return null;
  }

  // Sync-trim: clip leading/trailing partial-sensor frames
  const trim = trimToFullSensorFrames(rawFrames);
  const frames = trim.frames;
  if (frames.length === 0) return null;

  const durationSec = session.endTime
    ? (session.endTime - session.startTime) / 1000
    : frames.length > 0
      ? frames[frames.length - 1].timestamp / 1000
      : 0;

  const sensorCount = getEffectiveSensorCount(frames, session.sensorCount || 1);

  const sampleRate =
    session.sampleRate ||
    (durationSec > 0
      ? Math.round(frames.length / sensorCount / durationSec)
      : 0);

  const firstFrameNumber = getFirstFrameNumber(frames);

  const lines: string[] = [];
  lines.push("# IMU Connect Session Export");
  lines.push(`# Session: ${session.name}`);
  lines.push(`# Date: ${new Date(session.startTime).toISOString()}`);
  lines.push(`# Duration: ${durationSec.toFixed(2)}s`);
  lines.push(`# Sample Rate: ${sampleRate} Hz`);
  lines.push(`# Frames: ${frames.length}`);
  lines.push(`# Sensors: ${session.sensorCount}`);
  if (trim.wasTrimmed) {
    lines.push(
      `# Sync Trim: removed ${trim.trimmedStartFrames} start / ${trim.trimmedEndFrames} end frames (${trim.trimmedPackets} packets)`,
    );
  }
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

  lines.push("# Timing Columns:");
  lines.push(
    "#   gateway_time_* = gateway-aligned sync timeline reconstructed during recording",
  );
  lines.push(
    "#   system_arrival_time_* = recorder wall-clock when the packet was persisted",
  );
  lines.push(
    "#   sync_time_* = frame-number-relative sync timeline (0 ms at first exported sync frame)",
  );
  lines.push("#");

  lines.push(
    [
      "gateway_time_s",
      "gateway_time_ms",
      "system_arrival_time_s",
      "system_arrival_time_ms",
      "sync_time_s",
      "sync_time_ms",
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

// ============================================================================
// Synchronised-frame (wide) CSV — one row per gateway sync frame
// ============================================================================
// Standard motion-capture export format: each row = one `frameNumber` with
// every sensor's quaternion, accelerometer, and gyroscope pivoted into columns.
// This makes it trivially easy to verify that all sensors are time-aligned and
// matches the output conventions of Vicon, Xsens, and OptiTrack.
// ============================================================================

interface SyncCsvChunkedInput {
  session: RecordingSession;
  frames: RecordedFrame[];
  onProgress?: (progress: CsvChunkProgress) => void;
}

export interface SyncFrameSummary {
  totalSyncFrames: number;
  fullySyncedFrames: number;
  partialFrames: number;
  syncPercent: number;
  sensorIds: number[];
  sensorSegments: Record<number, string>;
}

export function serializeSyncFrameCsvChunked({
  session,
  frames: rawFrames,
  onProgress,
}: SyncCsvChunkedInput): { csv: string | null; summary: SyncFrameSummary } {
  const emptySummary: SyncFrameSummary = {
    totalSyncFrames: 0,
    fullySyncedFrames: 0,
    partialFrames: 0,
    syncPercent: 0,
    sensorIds: [],
    sensorSegments: {},
  };

  if (!rawFrames || rawFrames.length === 0) {
    return { csv: null, summary: emptySummary };
  }

  // Sync-trim: clip leading/trailing partial-sensor frames
  const trim = trimToFullSensorFrames(rawFrames);
  const frames = trim.frames;
  if (frames.length === 0) {
    return { csv: null, summary: emptySummary };
  }

  // 1. Discover all sensors and their segments
  const sensorSegments = new Map<number, string>();
  for (const f of frames) {
    const sid = f.sensorId ?? 0;
    if (!sensorSegments.has(sid)) {
      sensorSegments.set(sid, f.segment || `sensor_${sid}`);
    }
  }
  const sensorIds = Array.from(sensorSegments.keys()).sort((a, b) => a - b);
  const sensorCount = sensorIds.length;

  // 2. Group packets by frameNumber → one sync frame per group
  const syncFrames = new Map<
    number,
    {
      timestamp: number;
      systemTime: number;
      sensors: Map<number, RecordedFrame>;
    }
  >();

  for (const f of frames) {
    const fn =
      typeof f.frameNumber === "number" && Number.isFinite(f.frameNumber)
        ? f.frameNumber
        : -1;
    if (fn < 0) continue;

    if (!syncFrames.has(fn)) {
      syncFrames.set(fn, {
        timestamp: f.timestamp,
        systemTime:
          typeof f.systemTime === "number" ? f.systemTime : f.timestamp,
        sensors: new Map(),
      });
    }
    const group = syncFrames.get(fn)!;
    // Keep the first occurrence per sensor per frame (dedup)
    if (!group.sensors.has(f.sensorId ?? 0)) {
      group.sensors.set(f.sensorId ?? 0, f);
    }
  }

  // Sort by frameNumber
  const sortedFrameNumbers = Array.from(syncFrames.keys()).sort(
    (a, b) => a - b,
  );
  const totalSyncFrames = sortedFrameNumbers.length;
  const firstFN = sortedFrameNumbers[0];

  // 3. Count fully-synced frames
  let fullySyncedFrames = 0;
  for (const fn of sortedFrameNumbers) {
    if (syncFrames.get(fn)!.sensors.size >= sensorCount) {
      fullySyncedFrames++;
    }
  }
  const partialFrames = totalSyncFrames - fullySyncedFrames;
  const syncPercent =
    totalSyncFrames > 0
      ? Math.round((fullySyncedFrames / totalSyncFrames) * 1000) / 10
      : 0;

  // 4. Duration / rate
  const durationSec = session.endTime
    ? (session.endTime - session.startTime) / 1000
    : totalSyncFrames > 0
      ? (sortedFrameNumbers[totalSyncFrames - 1] - firstFN) * 0.005
      : 0;
  const sampleRate =
    session.sampleRate ||
    (durationSec > 0 ? Math.round(totalSyncFrames / durationSec) : 200);

  // 5. Build header
  const lines: string[] = [];
  lines.push("# IMU Connect Synchronised Frame Export");
  lines.push(`# Session: ${session.name}`);
  lines.push(`# Date: ${new Date(session.startTime).toISOString()}`);
  lines.push(`# Duration: ${durationSec.toFixed(2)}s`);
  lines.push(`# Sample Rate: ${sampleRate} Hz`);
  lines.push(`# Sync Frames: ${totalSyncFrames}`);
  lines.push(`# Sensors: ${sensorCount}`);
  lines.push(
    `# Fully Synchronised: ${fullySyncedFrames} / ${totalSyncFrames} (${syncPercent}%)`,
  );
  if (trim.wasTrimmed) {
    lines.push(
      `# Sync Trim: removed ${trim.trimmedStartFrames} start / ${trim.trimmedEndFrames} end frames (${trim.trimmedPackets} packets)`,
    );
  }
  lines.push("#");
  lines.push("# Format: One row per gateway sync frame (frameNumber).");
  lines.push("#         Each sensor's data appears in fixed column positions.");
  lines.push("#         Empty cells = sensor not present in that sync frame.");
  lines.push("#");

  if (session.sensorMapping && Object.keys(session.sensorMapping).length > 0) {
    lines.push("# Sensor Mapping:");
    Object.entries(session.sensorMapping).forEach(([id, segment]) => {
      lines.push(`#   ${id}=${segment}`);
    });
    lines.push("#");
  }

  // Column header: time cols + per-sensor data cols
  const headerCols: string[] = [
    "frame_number",
    "relative_frame",
    "gateway_time_s",
    "gateway_time_ms",
    "sensors_present",
    "is_complete",
  ];
  for (const sid of sensorIds) {
    const seg = sensorSegments.get(sid) || `s${sid}`;
    headerCols.push(
      `${seg}_qw`,
      `${seg}_qx`,
      `${seg}_qy`,
      `${seg}_qz`,
      `${seg}_ax`,
      `${seg}_ay`,
      `${seg}_az`,
      `${seg}_gx`,
      `${seg}_gy`,
      `${seg}_gz`,
    );
  }
  lines.push(headerCols.join(","));

  // 6. Build data rows — one per sync frame
  const total = totalSyncFrames;
  let processed = 0;
  const BATCH = 500;

  for (let batchStart = 0; batchStart < total; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH, total);
    for (let i = batchStart; i < batchEnd; i++) {
      const fn = sortedFrameNumbers[i];
      const group = syncFrames.get(fn)!;
      const relFrame = fn - firstFN;
      const cols: string[] = [
        String(fn),
        String(relFrame),
        (group.timestamp / 1000).toFixed(4),
        group.timestamp.toFixed(1),
        String(group.sensors.size),
        group.sensors.size >= sensorCount ? "1" : "0",
      ];

      for (const sid of sensorIds) {
        const f = group.sensors.get(sid);
        if (f) {
          cols.push(
            f.quaternion[0].toFixed(6),
            f.quaternion[1].toFixed(6),
            f.quaternion[2].toFixed(6),
            f.quaternion[3].toFixed(6),
            f.accelerometer[0].toFixed(4),
            f.accelerometer[1].toFixed(4),
            f.accelerometer[2].toFixed(4),
            f.gyro ? f.gyro[0].toFixed(4) : "0",
            f.gyro ? f.gyro[1].toFixed(4) : "0",
            f.gyro ? f.gyro[2].toFixed(4) : "0",
          );
        } else {
          // 10 empty cells for missing sensor
          cols.push("", "", "", "", "", "", "", "", "", "");
        }
      }

      lines.push(cols.join(","));
    }
    processed = batchEnd;
    onProgress?.({ processed, total });
  }

  const summary: SyncFrameSummary = {
    totalSyncFrames,
    fullySyncedFrames,
    partialFrames,
    syncPercent,
    sensorIds,
    sensorSegments: Object.fromEntries(sensorSegments),
  };

  return { csv: lines.join("\n"), summary };
}

export function serializeSessionJsonChunked({
  session,
  imuFrames: rawImuFrames,
  envFrames,
  jsonSchema,
  chunkSize = DEFAULT_EXPORT_CHUNK_SIZE,
  onProgress,
}: SerializeSessionJsonChunkedInput): string {
  if (jsonSchema === "legacy") {
    const imu = stringifyArrayChunked(
      rawImuFrames,
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
    : rawImuFrames.length > 0
      ? rawImuFrames[rawImuFrames.length - 1].timestamp
      : 0;

  // Sync-trim: clip leading/trailing partial-sensor frames
  const trim = trimToFullSensorFrames(rawImuFrames);
  const imuFrames = trim.frames;

  const sensorCount = getEffectiveSensorCount(
    imuFrames,
    session.sensorCount || 1,
  );

  const sampleRate =
    session.sampleRate ||
    (durationMs > 0
      ? Math.round(imuFrames.length / sensorCount / (durationMs / 1000))
      : 0);
  const firstFrameNumber = getFirstFrameNumber(imuFrames);

  const imu = stringifyArrayChunked(
    imuFrames,
    chunkSize,
    (frame) => ({
      t: frame.timestamp,
      st: frame.systemTime,
      fn: frame.frameNumber,
      rf: getRelativeFrame(frame, firstFrameNumber),
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
  )},"data":{"imuFrameCount":${imuFrames.length},"envFrameCount":${envFrames.length},"syncTrim":${JSON.stringify(trim.wasTrimmed ? { trimmedStartFrames: trim.trimmedStartFrames, trimmedEndFrames: trim.trimmedEndFrames, trimmedPackets: trim.trimmedPackets } : null)},"imuFrames":${imu},"envFrames":${env}}}`;
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
  const gatewayTimeMs = frame.timestamp;
  const systemArrivalTimeMs =
    typeof frame.systemTime === "number" && Number.isFinite(frame.systemTime)
      ? frame.systemTime
      : gatewayTimeMs;
  const relativeFrame = getRelativeFrame(frame, firstFrameNumber);
  const syncTimeMs = relativeFrame * 5.0;

  return [
    (gatewayTimeMs / 1000).toFixed(4),
    gatewayTimeMs.toFixed(1),
    (systemArrivalTimeMs / 1000).toFixed(4),
    systemArrivalTimeMs.toFixed(1),
    (syncTimeMs / 1000).toFixed(4),
    syncTimeMs.toFixed(1),
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

function getFirstFrameNumber(frames: RecordedFrame[]): number {
  return frames.reduce(
    (min, frame) =>
      typeof frame.frameNumber === "number" && frame.frameNumber < min
        ? frame.frameNumber
        : min,
    Infinity,
  );
}

function getRelativeFrame(
  frame: RecordedFrame,
  firstFrameNumber: number,
): number {
  return typeof frame.frameNumber === "number" && firstFrameNumber !== Infinity
    ? frame.frameNumber - firstFrameNumber
    : 0;
}
