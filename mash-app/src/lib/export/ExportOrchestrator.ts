import {
  dataManager,
  type RecordedEnvFrame,
  type RecordedFrame,
  type RecordingSession,
} from "../db";
import { downloadBlobPart } from "./download";
import { buildC3DArtifact } from "./C3DExporter";
import { buildBVHArtifact } from "./BVHExporter";
import { buildOpenSimStoArtifact } from "./OpenSimExporter";
import {
  serializeRecordingCsvChunked,
  serializeSessionJsonChunked,
} from "./chunkedSerialization";
import {
  EXPORT_PROGRESS_STAGE,
  formatExportStage,
  normalizeExportStage,
} from "./formatExportStage";

export type ExportFormat = "csv" | "json";
export type PlaybackExportFormat = "csv" | "c3d" | "bvh" | "opensim";
export type JsonSchema = "legacy" | "full";

export interface ExportSessionRequest {
  sessionId: string;
  format: ExportFormat;
  jsonSchema?: JsonSchema;
  filename?: string;
}

export interface ExportPlaybackRequest {
  format: PlaybackExportFormat;
  sessionName: string;
  frameRate: number;
  frames: RecordedFrame[];
  includeAnalog?: boolean;
  filename?: string;
}

export interface ExportArtifact {
  content: BlobPart;
  filename: string;
  mimeType: string;
}

export interface ExportExecutionOptions {
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
  preferWorker?: boolean;
  onTelemetry?: (telemetry: ExportTelemetry) => void;
}

export interface ExportTelemetry {
  scope: "session" | "playback";
  mode: "data" | "download";
  format: string;
  path: "worker" | "main";
  fallbackUsed: boolean;
  frameCount: number;
  sensorCount: number;
  stage?: string;
  stageLabel?: string;
  fetchMs?: number;
  serializeMs?: number;
  downloadMs?: number;
  totalMs: number;
}

type WorkerExportInput =
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

type WorkerExportMessage =
  | {
      type: "progress";
      progress?: number;
      stage?: string;
    }
  | {
      type: "done";
      artifact: ExportArtifact;
    }
  | {
      type: "error";
      error?: string;
    };

export async function exportSessionData(
  request: ExportSessionRequest,
  options: ExportExecutionOptions = {},
): Promise<ExportArtifact> {
  const t0 = nowMs();

  const fetchStart = nowMs();
  const session = await dataManager.getSession(request.sessionId);
  if (!session) {
    throw new Error(`Session ${request.sessionId} not found`);
  }

  const imuFrames = await dataManager.exportSessionData(request.sessionId);
  if (imuFrames.length === 0) {
    throw new Error(`No IMU frames found for session ${request.sessionId}`);
  }

  const envFrames = dataManager.exportEnvData
    ? await dataManager.exportEnvData(request.sessionId)
    : [];
  const fetchMs = nowMs() - fetchStart;

  const serializeStart = nowMs();
  let path: "worker" | "main" = "main";
  let fallbackUsed = false;

  if (options.preferWorker !== false) {
    try {
      const artifact = await runExportWorker(
        {
          kind: "session",
          request,
          session,
          imuFrames,
          envFrames,
        },
        options,
      );
      path = "worker";
      const serializeMs = nowMs() - serializeStart;
      const totalMs = nowMs() - t0;
      emitTelemetry(options, {
        scope: "session",
        mode: "data",
        format: request.format,
        path,
        fallbackUsed,
        frameCount: imuFrames.length,
        sensorCount: session.sensorCount,
        fetchMs,
        serializeMs,
        totalMs,
      });
      return artifact;
    } catch (workerError) {
      if (
        workerError instanceof Error &&
        workerError.message === "Export cancelled"
      ) {
        throw workerError;
      }
      fallbackUsed = true;
      console.warn(
        "[ExportOrchestrator] Unified export worker failed for session export, using fallback:",
        workerError,
      );
    }
  }

  const artifact = buildSessionArtifactMain(
    request,
    session,
    imuFrames,
    envFrames,
  );
  path = "main";
  const serializeMs = nowMs() - serializeStart;
  const totalMs = nowMs() - t0;
  emitTelemetry(options, {
    scope: "session",
    mode: "data",
    format: request.format,
    path,
    fallbackUsed,
    frameCount: imuFrames.length,
    sensorCount: session.sensorCount,
    fetchMs,
    serializeMs,
    totalMs,
  });
  return artifact;
}

export async function exportAndDownloadSessionData(
  request: ExportSessionRequest,
  options: ExportExecutionOptions = {},
): Promise<ExportArtifact> {
  const t0 = nowMs();
  const artifact = await exportSessionData(request, options);
  const dlStart = nowMs();
  downloadBlobPart(artifact.content, artifact.filename, artifact.mimeType);
  const downloadMs = nowMs() - dlStart;
  const totalMs = nowMs() - t0;
  emitTelemetry(options, {
    scope: "session",
    mode: "download",
    format: request.format,
    path: "main",
    fallbackUsed: false,
    frameCount: 0,
    sensorCount: 0,
    downloadMs,
    totalMs,
  });
  return artifact;
}

export async function exportPlaybackData(
  request: ExportPlaybackRequest,
  options: ExportExecutionOptions = {},
): Promise<ExportArtifact> {
  const t0 = nowMs();
  if (!request.frames || request.frames.length === 0) {
    throw new Error("No frames available for export");
  }

  const sensorCount = new Set(request.frames.map((f) => f.sensorId)).size;
  const serializeStart = nowMs();
  let path: "worker" | "main" = "main";
  let fallbackUsed = false;

  if (options.preferWorker !== false) {
    try {
      const artifact = await runExportWorker(
        {
          kind: "playback",
          request,
        },
        options,
      );
      path = "worker";
      const serializeMs = nowMs() - serializeStart;
      const totalMs = nowMs() - t0;
      emitTelemetry(options, {
        scope: "playback",
        mode: "data",
        format: request.format,
        path,
        fallbackUsed,
        frameCount: request.frames.length,
        sensorCount,
        fetchMs: 0,
        serializeMs,
        totalMs,
      });
      return artifact;
    } catch (workerError) {
      if (
        workerError instanceof Error &&
        workerError.message === "Export cancelled"
      ) {
        throw workerError;
      }
      fallbackUsed = true;
      console.warn(
        "[ExportOrchestrator] Unified export worker failed for playback export, using fallback:",
        workerError,
      );
    }
  }

  const artifact = buildPlaybackArtifactMain(request);
  path = "main";
  const serializeMs = nowMs() - serializeStart;
  const totalMs = nowMs() - t0;
  emitTelemetry(options, {
    scope: "playback",
    mode: "data",
    format: request.format,
    path,
    fallbackUsed,
    frameCount: request.frames.length,
    sensorCount,
    fetchMs: 0,
    serializeMs,
    totalMs,
  });
  return artifact;
}

export async function exportAndDownloadPlaybackData(
  request: ExportPlaybackRequest,
  options: ExportExecutionOptions = {},
): Promise<ExportArtifact> {
  const t0 = nowMs();
  const artifact = await exportPlaybackData(request, options);
  const dlStart = nowMs();
  downloadBlobPart(artifact.content, artifact.filename, artifact.mimeType);
  const downloadMs = nowMs() - dlStart;
  const totalMs = nowMs() - t0;
  emitTelemetry(options, {
    scope: "playback",
    mode: "download",
    format: request.format,
    path: "main",
    fallbackUsed: false,
    frameCount: request.frames.length,
    sensorCount: new Set(request.frames.map((f) => f.sensorId)).size,
    downloadMs,
    totalMs,
  });
  return artifact;
}

async function runExportWorker(
  payload: WorkerExportInput,
  options: ExportExecutionOptions,
): Promise<ExportArtifact> {
  if (typeof Worker === "undefined") {
    throw new Error("Worker is not available in this environment");
  }

  const worker = new Worker(
    new URL("../../workers/exportWorker.ts", import.meta.url),
    { type: "module" },
  );

  return await new Promise<ExportArtifact>((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      worker.terminate();
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("Export cancelled"));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    worker.onmessage = (event: MessageEvent<WorkerExportMessage>) => {
      const data = event.data;
      if (data?.type === "progress") {
        options.onProgress?.(
          data.progress ?? 0,
          data.stage ?? EXPORT_PROGRESS_STAGE.WORKING,
        );
        return;
      }

      if (data?.type === "done" && data.artifact) {
        cleanup();
        resolve(data.artifact as ExportArtifact);
        return;
      }

      if (data?.type === "error") {
        cleanup();
        reject(new Error(data.error || "Export worker failed"));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Export worker crashed"));
    };

    worker.postMessage(payload);
  });
}

function buildSessionArtifactMain(
  request: ExportSessionRequest,
  session: RecordingSession,
  imuFrames: RecordedFrame[],
  envFrames: RecordedEnvFrame[],
): ExportArtifact {
  if (request.format === "csv") {
    const csv = serializeRecordingCsvChunked({ session, frames: imuFrames });
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
  });

  return {
    content: jsonContent,
    filename: request.filename || `${session.id}.json`,
    mimeType: "application/json",
  };
}

function buildPlaybackArtifactMain(
  request: ExportPlaybackRequest,
): ExportArtifact {
  const frameCount = request.frames.length;
  const startTime = request.frames[0].timestamp;
  const endTime = request.frames[frameCount - 1].timestamp;
  const sensorIds = new Set(request.frames.map((f) => f.sensorId));

  if (request.format === "csv") {
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
    const c3d = buildC3DArtifact(
      request.frames,
      {
        sessionName: request.sessionName,
        frameRate: request.frameRate,
        includeAnalog: request.includeAnalog,
      },
      request.filename,
    );

    return {
      content: c3d.content,
      filename: c3d.filename,
      mimeType: c3d.mimeType,
    };
  }

  if (request.format === "bvh") {
    const bvh = buildBVHArtifact(
      request.frames,
      {
        sessionName: request.sessionName,
        frameRate: request.frameRate,
      },
      request.filename,
    );

    return {
      content: bvh.content,
      filename: bvh.filename,
      mimeType: bvh.mimeType,
    };
  }

  const sto = buildOpenSimStoArtifact(
    request.frames,
    {
      sessionName: request.sessionName,
      dataRate: request.frameRate,
    },
    request.filename,
  );

  return {
    content: sto.content,
    filename: sto.filename,
    mimeType: sto.mimeType,
  };
}

function emitTelemetry(
  options: ExportExecutionOptions,
  telemetry: ExportTelemetry,
) {
  const stage =
    normalizeExportStage(telemetry.stage) || EXPORT_PROGRESS_STAGE.DONE;
  const enrichedTelemetry: ExportTelemetry = {
    ...telemetry,
    stage,
    stageLabel: formatExportStage(stage),
  };

  options.onTelemetry?.(enrichedTelemetry);
  console.info("[ExportPerf]", enrichedTelemetry);
}

function nowMs(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}
