/// <reference lib="webworker" />

import type {
  RecordedEnvFrame,
  RecordedFrame,
  RecordingSession,
} from "../lib/db";
import { buildC3DArtifact } from "../lib/export/C3DExporter";
import { buildBVHArtifact } from "../lib/export/BVHExporter";
import { buildOpenSimStoArtifact } from "../lib/export/OpenSimExporter";
import {
  serializeRecordingCsvChunked,
  serializeSessionJsonChunked,
} from "../lib/export/chunkedSerialization";
import { EXPORT_PROGRESS_STAGE } from "../lib/export/formatExportStage";

type ExportFormat = "csv" | "json";
type PlaybackExportFormat = "csv" | "c3d" | "bvh" | "opensim";
type JsonSchema = "legacy" | "full";

interface ExportSessionRequest {
  sessionId: string;
  format: ExportFormat;
  jsonSchema?: JsonSchema;
  filename?: string;
}

interface ExportPlaybackRequest {
  format: PlaybackExportFormat;
  sessionName: string;
  frameRate: number;
  frames: RecordedFrame[];
  includeAnalog?: boolean;
  filename?: string;
}

interface ExportArtifact {
  content: BlobPart;
  filename: string;
  mimeType: string;
}

type ExportWorkerInput =
  | {
      kind: "session";
      request: ExportSessionRequest;
      session: RecordingSession;
      imuFrames: RecordedFrame[];
      envFrames: RecordedEnvFrame[];
    }
  | {
      kind: "playback";
      request: ExportPlaybackRequest;
    };

function postProgress(progress: number, stage: string) {
  self.postMessage({ type: "progress", progress, stage });
}

self.onmessage = (event: MessageEvent<ExportWorkerInput>) => {
  try {
    postProgress(5, EXPORT_PROGRESS_STAGE.START);

    const artifact =
      event.data.kind === "session"
        ? buildSessionArtifact(event.data)
        : buildPlaybackArtifact(event.data.request);

    postProgress(100, EXPORT_PROGRESS_STAGE.DONE);

    if (artifact.content instanceof ArrayBuffer) {
      self.postMessage({ type: "done", artifact }, [artifact.content]);
    } else {
      self.postMessage({ type: "done", artifact });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ type: "error", error: message });
  }
};

function buildSessionArtifact(input: {
  request: ExportSessionRequest;
  session: RecordingSession;
  imuFrames: RecordedFrame[];
  envFrames: RecordedEnvFrame[];
}): ExportArtifact {
  const { request, session, imuFrames, envFrames } = input;
  postProgress(20, EXPORT_PROGRESS_STAGE.NORMALIZE);

  if (request.format === "csv") {
    const csv = serializeRecordingCsvChunked({
      session,
      frames: imuFrames,
      onProgress: ({ processed, total }) => {
        postProgress(
          progressFromChunk(processed, total, 60, 95),
          EXPORT_PROGRESS_STAGE.SERIALIZE_CSV,
        );
      },
    });
    if (!csv) {
      throw new Error("CSV generation returned empty output");
    }

    return {
      content: csv,
      filename: request.filename || `${session.id}.csv`,
      mimeType: "text/csv",
    };
  }

  const jsonSchema = request.jsonSchema || "legacy";
  const jsonContent = serializeSessionJsonChunked({
    session,
    imuFrames,
    envFrames,
    jsonSchema,
    onProgress: ({ phase, processed, total }) => {
      postProgress(
        progressFromChunk(
          processed,
          total,
          phase === "imu" ? 60 : 80,
          phase === "imu" ? 80 : 95,
        ),
        phase === "imu"
          ? EXPORT_PROGRESS_STAGE.SERIALIZE_JSON_IMU
          : EXPORT_PROGRESS_STAGE.SERIALIZE_JSON_ENV,
      );
    },
  });

  return {
    content: jsonContent,
    filename: request.filename || `${session.id}.json`,
    mimeType: "application/json",
  };
}

function buildPlaybackArtifact(request: ExportPlaybackRequest): ExportArtifact {
  postProgress(20, EXPORT_PROGRESS_STAGE.NORMALIZE);

  if (request.format === "csv") {
    const frameCount = request.frames.length;
    const startTime = request.frames[0].timestamp;
    const endTime = request.frames[frameCount - 1].timestamp;
    const sensorIds = new Set(request.frames.map((frame) => frame.sensorId));

    const syntheticSession: RecordingSession = {
      id: `playback-${Date.now()}`,
      name: request.sessionName,
      startTime,
      endTime,
      sensorCount: sensorIds.size,
      sampleRate: request.frameRate,
    };

    const csv = serializeRecordingCsvChunked({
      session: syntheticSession,
      frames: request.frames,
      onProgress: ({ processed, total }) => {
        postProgress(
          progressFromChunk(processed, total, 60, 95),
          EXPORT_PROGRESS_STAGE.SERIALIZE_CSV,
        );
      },
    });
    if (!csv) {
      throw new Error("CSV generation returned empty output");
    }

    return {
      content: csv,
      filename: request.filename || `${request.sessionName}.csv`,
      mimeType: "text/csv",
    };
  }

  if (request.format === "c3d") {
    postProgress(60, EXPORT_PROGRESS_STAGE.SERIALIZE_C3D);
    const artifact = buildC3DArtifact(
      request.frames,
      {
        sessionName: request.sessionName,
        frameRate: request.frameRate,
        includeAnalog: request.includeAnalog,
      },
      request.filename,
    );

    return {
      content: artifact.content,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    };
  }

  if (request.format === "bvh") {
    postProgress(60, EXPORT_PROGRESS_STAGE.SERIALIZE_BVH);
    const artifact = buildBVHArtifact(
      request.frames,
      {
        sessionName: request.sessionName,
        frameRate: request.frameRate,
      },
      request.filename,
    );

    return {
      content: artifact.content,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    };
  }

  postProgress(60, EXPORT_PROGRESS_STAGE.SERIALIZE_OPENSIM);
  const artifact = buildOpenSimStoArtifact(
    request.frames,
    {
      sessionName: request.sessionName,
      dataRate: request.frameRate,
    },
    request.filename,
  );

  return {
    content: artifact.content,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
  };
}

function progressFromChunk(
  processed: number,
  total: number,
  rangeStart: number,
  rangeEnd: number,
): number {
  if (total <= 0) {
    return rangeEnd;
  }

  const ratio = Math.min(1, Math.max(0, processed / total));
  return rangeStart + (rangeEnd - rangeStart) * ratio;
}

export {};
