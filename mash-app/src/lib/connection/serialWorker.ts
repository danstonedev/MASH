/// <reference lib="webworker" />

import { IMUParser } from "./IMUParser";
import { RingBuffer } from "./RingBuffer";

type WorkerInbound = {
  type: "chunk";
  chunk: Uint8Array;
};

type WorkerStats = {
  chunkBytes: number;
  framesExtracted: number;
  resyncEvents: number;
  overflowEvents: number;
  overflowBytes: number;
  ringLength: number;
  rawAsciiPreview?: string;
};

type WorkerOutbound = {
  type: "parsed";
  packets: any[];
  stats: WorkerStats;
  syncFrames?: Array<{
    frameNumber: number;
    timestampUs: number;
    sensorCount: number;
    validSensorIds: number[];
  }>;
};

const ringBuffer = new RingBuffer(262144);

const MAX_FRAME_LEN = 4096;
const MIN_FRAME_LEN = 3;
const MAX_RESYNC_ATTEMPTS = 128;

function isPlausibleFrame(packetType: number, frameLen: number): boolean {
  // 0x25 sync frame: header(10) + N*16 sensor slots [+ optional CRC byte]
  if (packetType === 0x25) {
    const minLen = 10 + 16; // one sensor
    const maxLen = 10 + 32 * 16 + 1; // bounded by parser's max reasonable sensors
    if (frameLen < minLen || frameLen > maxLen) return false;
    const payload = frameLen - 10;
    return payload % 16 === 0 || payload % 16 === 1;
  }

  // 0x05 node info: legacy 37 bytes or extended 46 bytes
  if (packetType === 0x05) {
    return frameLen === 37 || frameLen === 46;
  }

  // 0x04 environmental packet is fixed-size
  if (packetType === 0x04) {
    return frameLen === 31;
  }

  // 0x06 JSON packet is variable length, but must include at least type+1 byte
  if (packetType === 0x06) {
    return frameLen >= 2 && frameLen <= MAX_FRAME_LEN;
  }

  return false;
}

function handleChunk(chunk: Uint8Array): WorkerOutbound {
  ringBuffer.write(chunk);
  const overflow = ringBuffer.drainOverflowStats();
  const rawAsciiPreview = getAsciiPreview(chunk);

  const frames: Uint8Array[] = [];
  const syncFrames: WorkerOutbound["syncFrames"] = [];
  let resyncAttempts = 0;
  let resyncEvents = 0;

  while (ringBuffer.length >= 2) {
    const lenLo = ringBuffer.peekByte(0);
    const lenHi = ringBuffer.peekByte(1);
    const frameLen = lenLo | (lenHi << 8);

    if (frameLen < MIN_FRAME_LEN || frameLen > MAX_FRAME_LEN) {
      resyncAttempts++;
      if (resyncAttempts > MAX_RESYNC_ATTEMPTS) {
        const discard = Math.max(0, ringBuffer.length - 512);
        if (discard > 0) ringBuffer.skip(discard);
        resyncEvents++;
        break;
      }
      ringBuffer.skip(1);
      continue;
    }

    if (ringBuffer.length < 2 + frameLen) break;

    const packetType = ringBuffer.peekByte(2);
    if (!isPlausibleFrame(packetType, frameLen)) {
      // Unknown type is typically raw serial log/noise; resync byte-wise.
      resyncAttempts++;
      if (resyncAttempts > MAX_RESYNC_ATTEMPTS) {
        const discard = Math.max(0, ringBuffer.length - 512);
        if (discard > 0) ringBuffer.skip(discard);
        resyncEvents++;
        break;
      }
      ringBuffer.skip(1);
      continue;
    }

    ringBuffer.skip(2);
    const frame = ringBuffer.read(frameLen);
    frames.push(frame);
    if (packetType === 0x25) {
      const meta = extractSyncFrameMeta(frame);
      if (meta) syncFrames.push(meta);
    }
    resyncAttempts = 0;
  }

  const packets: any[] = [];
  for (const frame of frames) {
    const parsed = IMUParser.parseSingleFrame(
      new DataView(frame.buffer, frame.byteOffset, frame.byteLength),
    );
    if (parsed.length > 0) packets.push(...parsed);
  }

  return {
    type: "parsed",
    packets,
    stats: {
      chunkBytes: chunk.length,
      framesExtracted: frames.length,
      resyncEvents,
      overflowEvents: overflow.events,
      overflowBytes: overflow.bytes,
      ringLength: ringBuffer.length,
      rawAsciiPreview,
    },
    syncFrames,
  };
}

function getAsciiPreview(chunk: Uint8Array): string | undefined {
  if (!chunk || chunk.length === 0) return undefined;
  const max = Math.min(chunk.length, 120);
  let printable = 0;
  let out = "";
  for (let i = 0; i < max; i++) {
    const b = chunk[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) {
      printable++;
      out += String.fromCharCode(b);
    } else {
      out += ".";
    }
  }
  if (printable / max < 0.75) return undefined;
  const normalized = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return normalized.trim().length > 0 ? normalized.trim() : undefined;
}

function extractSyncFrameMeta(frame: Uint8Array): {
  frameNumber: number;
  timestampUs: number;
  sensorCount: number;
  validSensorIds: number[];
} | null {
  if (frame.length < 10 || frame[0] !== 0x25) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const frameNumber = view.getUint32(1, true);
  const timestampUs = view.getUint32(5, true);
  const sensorCountHeader = view.getUint8(9);
  const sensorSize = 16;
  const headerSize = 10;

  // =========================================================================
  // CRC-8 DETECTION: Strip trailing CRC byte if present
  // =========================================================================
  const rawPayload = frame.length - headerSize;
  let effectiveLen = frame.length;
  if (rawPayload > 0 && rawPayload % sensorSize === 1) {
    // CRC byte present — IMUParser validates it; here we just strip for length calc
    effectiveLen = frame.length - 1;
  }

  // =========================================================================
  // ROBUST SENSOR COUNT: Always prefer frame-length inference
  // =========================================================================
  const payloadBytes = effectiveLen - headerSize;
  const inferredFromLen =
    payloadBytes >= 0 && payloadBytes % sensorSize === 0
      ? payloadBytes / sensorSize
      : -1;

  let sensorCount: number;
  if (inferredFromLen > 0 && inferredFromLen <= 32) {
    sensorCount = inferredFromLen;
  } else if (
    sensorCountHeader > 0 &&
    sensorCountHeader <= 32 &&
    frame.length >= headerSize + sensorCountHeader * sensorSize
  ) {
    sensorCount = sensorCountHeader;
  } else {
    return null;
  }

  const validSensorIds: number[] = [];
  for (let s = 0; s < sensorCount; s++) {
    const offset = headerSize + s * sensorSize;
    const sensorId = view.getUint8(offset);
    const flags = view.getUint8(offset + 13);
    const isValid = (flags & 0x01) !== 0;

    // PIPELINE FIX: Removed duplicate quaternion magnitude check.
    // IMUParser already performs this check with proper diagnostic counters.
    // Having it here silently excluded sensors from validSensorIds, making
    // SyncedSampleStats undercount and disagree with IMUParser's numbers.

    if (isValid) validSensorIds.push(sensorId);
  }

  return { frameNumber, timestampUs, sensorCount, validSensorIds };
}

self.onmessage = (event: MessageEvent<WorkerInbound>) => {
  if (!event.data || event.data.type !== "chunk") return;
  const result = handleChunk(event.data.chunk);
  self.postMessage(result as WorkerOutbound);
};
