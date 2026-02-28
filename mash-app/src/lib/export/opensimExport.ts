/**
 * Legacy OpenSim export compatibility layer.
 *
 * This module preserves historical exports (`exportToSTO`, `exportToCSV`,
 * `exportToJSON`, `downloadFile`) while delegating implementation to the
 * unified export stack.
 */

import { dataManager } from "../db";
import { exportSessionData, type JsonSchema } from "./ExportOrchestrator";
import { buildOpenSimStoArtifact } from "./OpenSimExporter";
import { downloadFile as downloadFileInternal } from "./download";

export interface STOExportOptions {
  sessionId: string;
  includeQuaternions?: boolean;
  includeAccelerometer?: boolean;
  includeGyroscope?: boolean;
  useISBConvention?: boolean;
  applyHeadingCorrection?: boolean;
}

export interface STOExportResult {
  content: string;
  filename: string;
  frameCount: number;
  duration: number;
  columns: string[];
}

export async function exportToSTO(
  options: STOExportOptions,
): Promise<STOExportResult> {
  const { sessionId } = options;
  const session = await dataManager.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const imuFrames = await dataManager.exportSessionData(sessionId);
  if (imuFrames.length === 0) {
    throw new Error(`No frames found for session ${sessionId}`);
  }

  const artifact = buildOpenSimStoArtifact(imuFrames, {
    sessionName: session.name,
    dataRate: session.sampleRate || 0,
  });

  const columns = extractStoColumns(artifact.content);
  const start = imuFrames[0].timestamp;
  const end = imuFrames[imuFrames.length - 1].timestamp;

  return {
    content: artifact.content,
    filename: artifact.filename,
    frameCount: imuFrames.length,
    duration: (end - start) / 1000,
    columns,
  };
}

export async function exportToCSV(sessionId: string): Promise<string> {
  return await exportAsString(sessionId, "csv");
}

export async function exportToJSON(sessionId: string): Promise<string> {
  return await exportAsString(sessionId, "json", "full");
}

export function downloadFile(
  content: string,
  filename: string,
  mimeType: string = "text/plain",
): void {
  downloadFileInternal(content, filename, mimeType);
}

async function exportAsString(
  sessionId: string,
  format: "csv" | "json",
  jsonSchema?: JsonSchema,
): Promise<string> {
  const artifact = await exportSessionData(
    {
      sessionId,
      format,
      jsonSchema,
    },
    {
      preferWorker: false,
    },
  );

  if (typeof artifact.content !== "string") {
    throw new Error("Expected text export payload");
  }

  return artifact.content;
}

function extractStoColumns(content: string): string[] {
  const lines = content.split("\n");
  const headerEndIdx = lines.findIndex((line) => line.trim() === "endheader");
  if (headerEndIdx < 0) {
    return [];
  }

  for (let i = headerEndIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    return line
      .split(/\t+/)
      .map((col) => col.trim())
      .filter(Boolean);
  }

  return [];
}
