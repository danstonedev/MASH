import type { RecordedFrame, RecordingSession } from "../db";
import { serializeRecordingCsvChunked } from "./chunkedSerialization";

export interface BuildRecordingCsvInput {
  session: RecordingSession;
  frames: RecordedFrame[];
}

export function buildRecordingCsv({
  session,
  frames,
}: BuildRecordingCsvInput): string | null {
  return serializeRecordingCsvChunked({ session, frames });
}
