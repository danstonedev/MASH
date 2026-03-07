import type { IMUDataPacket } from "../lib/protocol/DeviceInterface";

export interface RecordingFrameDiagnostics {
  frameSensors: Map<number, Set<number>>;
  frameExpectedCounts: Map<number, number>;
  totalFrames: number;
  completeFrames: number;
  lastReport: number;
  allSensorIds: Set<number>;
}

export function createRecordingFrameDiagnostics(
  now: number,
): RecordingFrameDiagnostics {
  return {
    frameSensors: new Map(),
    frameExpectedCounts: new Map(),
    totalFrames: 0,
    completeFrames: 0,
    lastReport: now,
    allSensorIds: new Set(),
  };
}

export function updateRecordingFrameDiagnostics(
  diag: RecordingFrameDiagnostics,
  packet: IMUDataPacket,
  now: number,
): RecordingFrameDiagnostics {
  const frameNumber = packet.frameNumber;
  if (frameNumber === undefined) {
    return diag;
  }

  const sensorId = packet.sensorId ?? 0;
  if (!diag.frameSensors.has(frameNumber)) {
    diag.frameSensors.set(frameNumber, new Set());
    diag.totalFrames++;
  }

  const sensorSet = diag.frameSensors.get(frameNumber)!;
  const advertisedExpectedCount = Math.max(
    0,
    Number(packet.frameCompleteness?.expectedCount ?? 0),
  );
  const fallbackExpectedCount = Math.max(
    diag.allSensorIds.size,
    sensorSet.size,
    1,
  );
  const nextExpectedCount = Math.max(
    diag.frameExpectedCounts.get(frameNumber) ?? 0,
    advertisedExpectedCount > 0
      ? advertisedExpectedCount
      : fallbackExpectedCount,
  );
  const wasComplete =
    sensorSet.size >= nextExpectedCount && nextExpectedCount > 0;

  sensorSet.add(sensorId);
  diag.allSensorIds.add(sensorId);
  diag.frameExpectedCounts.set(frameNumber, nextExpectedCount);

  const isComplete =
    sensorSet.size >= nextExpectedCount && nextExpectedCount > 0;
  if (!wasComplete && isComplete) {
    diag.completeFrames++;
  }

  if (now - diag.lastReport > 5000) {
    diag.frameSensors.clear();
    diag.frameExpectedCounts.clear();
    diag.lastReport = now;
  }

  return diag;
}
