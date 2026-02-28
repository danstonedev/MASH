import type { RecordedEnvFrame, RecordedFrame, RecordingSession } from "./db";

export interface ParsedSessionImport {
  session: RecordingSession;
  imuFrames: RecordedFrame[];
  environmentalFrames: RecordedEnvFrame[];
}

export function parseSessionImportPayload(input: unknown): ParsedSessionImport {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid session file format");
  }

  const data = input as {
    metadata?: unknown;
    imu?: unknown;
    environmental?: unknown;
  };

  if (!data.metadata || !data.imu || !Array.isArray(data.imu)) {
    throw new Error("Invalid session file format");
  }

  const session = data.metadata as RecordingSession;
  const imuFrames = data.imu as RecordedFrame[];

  if (!session.id || !session.name || typeof session.startTime !== "number") {
    throw new Error("Invalid session metadata");
  }

  const environmentalFrames = Array.isArray(data.environmental)
    ? (data.environmental as RecordedEnvFrame[])
    : [];

  return {
    session,
    imuFrames,
    environmentalFrames,
  };
}
