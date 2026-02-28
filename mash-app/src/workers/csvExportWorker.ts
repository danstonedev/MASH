/// <reference lib="webworker" />

import type { RecordedFrame, RecordingSession } from "../lib/db";
import { buildRecordingCsv } from "../lib/export/buildRecordingCsv";

interface CsvExportWorkerInput {
  session: RecordingSession;
  frames: RecordedFrame[];
}

self.onmessage = (event: MessageEvent<CsvExportWorkerInput>) => {
  try {
    const csv = buildRecordingCsv({
      session: event.data.session,
      frames: event.data.frames,
    });
    self.postMessage({ ok: true, csv });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ ok: false, error: message });
  }
};

export {};
