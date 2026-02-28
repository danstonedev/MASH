/**
 * IMUParser - Static utility class for parsing BLE IMU packets
 *
 * Simplified parser for SyncFrame-based pipeline (0x25 absolute frames only).
 * Legacy per-node formats (0x23, 0x24) have been removed.
 */

import type {
  IMUDataPacket,
  EnvironmentalDataPacket,
  NodeInfoPacket,
  JSONPacket,
  SyncQuality,
} from "../ble/DeviceInterface";
import {
  reportSyncedSamples,
  reportCRCResult,
  reportParserRejects,
} from "./SyncedSampleStats";

// ============================================================================
// CRC-8 (polynomial 0x07) — must match firmware computeCRC8()
// ============================================================================
function computeCRC8(data: DataView, offset: number, length: number): number {
  let crc = 0x00;
  for (let i = 0; i < length; i++) {
    crc ^= data.getUint8(offset + i);
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

// CRC diagnostic counters
let _crcCheckCount = 0;
let _crcFailCount = 0;
let _lastCrcDiagLog = 0;

// ============================================================================
// DIAGNOSTIC: Track sync frame parsing completeness
// ============================================================================
let _lastSyncFrameLog = 0;
let _incompleteSyncFrames = 0;
let _lastHeaderCorruptionLog = 0;
let _jsonParseErrorCount = 0;
let _lastJsonParseErrorLogMs = 0;

// ============================================================================
// Header corruption telemetry — accumulated stats instead of just console.warn
// ============================================================================
interface HeaderCorruptionStats {
  /** Total frames where header sensorCount != inferred sensorCount */
  totalMismatches: number;
  /** Histogram: headerValue → count (e.g., {0: 5, 255: 12} = 5 frames with header=0, 12 with header=255) */
  headerValueHist: Record<number, number>;
  /** Histogram: inferredValue → count of mismatched frames for that inferred count */
  inferredValueHist: Record<number, number>;
  /** Total frames where neither header nor inference was usable */
  unparsableFrames: number;
}
const _headerCorruption: HeaderCorruptionStats = {
  totalMismatches: 0,
  headerValueHist: {},
  inferredValueHist: {},
  unparsableFrames: 0,
};

/** Get accumulated header corruption telemetry */
export function getHeaderCorruptionStats(): HeaderCorruptionStats {
  return { ..._headerCorruption };
}

/** Reset header corruption stats */
export function resetHeaderCorruptionStats(): void {
  _headerCorruption.totalMismatches = 0;
  _headerCorruption.headerValueHist = {};
  _headerCorruption.inferredValueHist = {};
  _headerCorruption.unparsableFrames = 0;
}

// ============================================================================
// DIAGNOSTIC: Rolling sync composition tracker
// Tracks how many sensors are valid per frame to diagnose 0% sync issues
// ============================================================================
let _syncDiagTotalFrames = 0;
let _syncDiagFullFrames = 0; // Frames where ALL sensorCount sensors are valid
let _syncDiagPartialFrames = 0; // Frames where SOME sensors are invalid
let _syncDiagSensorHist: Record<number, number> = {}; // validCount → frequency
let _syncDiagLastReport = 0;
let _syncDiagExpectedSensors = 0; // The sensorCount from the header
let _syncDiagSensorPresence: Record<number, number> = {}; // sensorId → count of frames present in
let _trustedSyncSensorIds = new Set<number>();
let _trustedSyncSensorIdsUpdatedAt = 0;
// Reduced from 10s → 1s. The old TTL caused catastrophic lockout: a single
// corrupted sensorCount header would lock the parser to 3 sensors for 10s
// (2,000 frames lost). 1s limits damage to 200 frames max.
const TRUSTED_SYNC_IDS_TTL_MS = 1000;
// Stability-first: parser should not hard-filter sensor IDs during topology churn.
// Expected-range enforcement is handled in useDeviceStore/useNetworkStore.
const ENFORCE_TRUSTED_SYNC_IDS_FILTER = false;

// ============================================================================
// PIPELINE FIX: Drop-point counters — expose silent filter events
// ============================================================================
let _dropCountQuatMag = 0; // Quaternion magnitude out of [0.8, 1.2]
let _dropCountInvalid = 0; // isValid flag was 0
let _dropCountUntrusted = 0; // Filtered by _trustedSyncSensorIds
let _dropCountCorruptFrame = 0; // Entire frame rejected (all quaternions garbage after recovery)
let _totalSensorsProcessed = 0; // Total sensor slots seen (before filtering)

/** Get pipeline drop counters for diagnostic display */
export function getParserDropCounts() {
  return {
    quatMag: _dropCountQuatMag,
    invalid: _dropCountInvalid,
    untrusted: _dropCountUntrusted,
    corruptFrame: _dropCountCorruptFrame,
    totalProcessed: _totalSensorsProcessed,
  };
}

/** Reset drop counters (call on disconnect/reconnect) */
export function resetParserDropCounts() {
  _dropCountQuatMag = 0;
  _dropCountInvalid = 0;
  _dropCountUntrusted = 0;
  _dropCountCorruptFrame = 0;
  _totalSensorsProcessed = 0;
  _trustedSyncSensorIds.clear();
  _trustedSyncSensorIdsUpdatedAt = 0;
}

function areConsecutiveModulo256(ids: number[]): boolean {
  if (ids.length <= 1) return true;
  const uniq = Array.from(new Set(ids.map((id) => ((id % 256) + 256) % 256)));
  const n = uniq.length;
  if (n !== ids.length) return false;

  for (let startIndex = 0; startIndex < n; startIndex++) {
    const start = uniq[startIndex];
    let ok = true;
    for (let i = 1; i < n; i++) {
      const expected = (start + i) % 256;
      if (!uniq.includes(expected)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }

  return false;
}

function trackSyncFrameDiag(
  sensorCount: number,
  validSensorIds: number[],
  frameType: string,
  frameNumber: number,
) {
  _syncDiagTotalFrames++;
  _syncDiagExpectedSensors = sensorCount;

  const validCount = validSensorIds.length;
  if (validCount >= sensorCount) {
    _syncDiagFullFrames++;
  } else {
    _syncDiagPartialFrames++;
  }

  _syncDiagSensorHist[validCount] = (_syncDiagSensorHist[validCount] || 0) + 1;

  for (const sid of validSensorIds) {
    _syncDiagSensorPresence[sid] = (_syncDiagSensorPresence[sid] || 0) + 1;
  }

  // Report every 5 seconds
  const now = performance.now();
  if (now - _syncDiagLastReport > 5000) {
    _syncDiagLastReport = now;
    const fullPct =
      _syncDiagTotalFrames > 0
        ? ((_syncDiagFullFrames / _syncDiagTotalFrames) * 100).toFixed(1)
        : "0.0";

    console.debug(
      `[SYNC DIAG] ${_syncDiagTotalFrames} frames (${frameType}): ` +
        `${_syncDiagFullFrames} full (${fullPct}%), ${_syncDiagPartialFrames} partial`,
    );

    // Show valid-sensor-count distribution
    const histStr = Object.entries(_syncDiagSensorHist)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([count, freq]) => `${count}sensors:${freq}`)
      .join(", ");
    console.debug(`  Distribution: [${histStr}]`);

    // Show per-sensor presence
    const presStr = Object.entries(_syncDiagSensorPresence)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([sid, cnt]) => {
        const pct = ((cnt / _syncDiagTotalFrames) * 100).toFixed(0);
        return `S${sid}:${pct}%`;
      })
      .join(", ");
    console.debug(`  Per-sensor: [${presStr}]`);

    // Key diagnostic: if 0% full frames but sensors are present at ~50% each,
    // it means partial frames alternate between nodes (never all in one frame).
    // Only warn after 60s of data — early startup commonly has partial frames
    // while nodes are still discovering and TDMA slots aren't fully assigned.
    if (
      _syncDiagFullFrames === 0 &&
      _syncDiagTotalFrames > 20 &&
      performance.now() > 60000
    ) {
      console.debug(
        `[SYNC DIAG] ⚠️  0% COMPLETE FRAMES — Gateway is sending partial sync frames. ` +
          `Nodes are NOT landing in the same timestamp slot.`,
      );
    }

    // Reset for next window
    _syncDiagTotalFrames = 0;
    _syncDiagFullFrames = 0;
    _syncDiagPartialFrames = 0;
    _syncDiagSensorHist = {};
    _syncDiagSensorPresence = {};
  }
}

/**
 * Static parser class for BLE IMU packets.
 *
 * PROTOCOL SPECIFICATION:
 * - Gateway sends length-prefixed frames over BLE: [len_lo][len_hi][frame_data...]
 * - BLEConnection handles stream reassembly and extracts individual frames
 * - This parser processes individual frames (after length prefix is stripped)
 *
 * Frame Types (first byte):
 * - 0x04: Environmental data (magnetometer/barometer)
 * - 0x05: Node info/discovery
 * - 0x25: SYNC FRAME - Cross-node synchronized data (absolute values)
 * - 0x06: JSON status/command response
 */

export class IMUParser {
  /**
   * Parse a single unwrapped packet frame (no length prefix).
   * This is the primary method for parsing individual frames.
   */
  static parseSingleFrame(
    data: DataView,
  ): (IMUDataPacket | NodeInfoPacket | EnvironmentalDataPacket | JSONPacket)[] {
    const len = data.byteLength;
    const packets: (
      | IMUDataPacket
      | NodeInfoPacket
      | EnvironmentalDataPacket
      | JSONPacket
    )[] = [];

    if (len === 0) return packets;

    // --- ENVIRONMENTAL (0x04) ---
    if (data.getUint8(0) === 0x04) {
      const env = IMUParser.parseEnvironmentalPacket(data);
      if (env) {
        packets.push(env);
      }
      return packets;
    }

    // --- NODE INFO / DISCOVERY (0x05) ---
    if (data.getUint8(0) === 0x05) {
      const nodeInfo = IMUParser.parseNodeInfoPacket(data);
      if (nodeInfo) {
        packets.push(nodeInfo);
      }
      return packets;
    }

    // --- JSON STATUS / COMMAND RESPONSE (0x06) ---
    if (data.getUint8(0) === 0x06) {
      let text = "";
      try {
        text = new TextDecoder().decode(
          new Uint8Array(data.buffer, data.byteOffset + 1, len - 1),
        );
        const parsed = JSON.parse(text);
        packets.push(parsed as JSONPacket);
      } catch (error) {
        // Recovery path: firmware/log interleave can occasionally inject noise
        // around JSON payloads. Try extracting the first complete object.
        try {
          const start = text.indexOf("{");
          const end = text.lastIndexOf("}");
          if (start >= 0 && end > start) {
            const recovered = JSON.parse(text.slice(start, end + 1));
            packets.push(recovered as JSONPacket);
            return packets;
          }
        } catch {
          // Fall through to diagnostics.
        }

        _jsonParseErrorCount++;
        const now = Date.now();
        if (now - _lastJsonParseErrorLogMs > 2000) {
          _lastJsonParseErrorLogMs = now;
          const preview = text
            .slice(0, 120)
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n");
          console.warn(
            `[IMUParser] JSON parse failed (count=${_jsonParseErrorCount}, len=${len}): "${preview}"`,
            error,
          );
        }
      }
      return packets;
    }

    // =========================================================================
    // SYNC FRAME FORMAT (0x25) - Cross-Node Timestamp Synchronization
    // =========================================================================
    // Sync Frames contain ONE synchronized sample from ALL sensors with the
    // SAME timestamp. The Gateway only emits these when all expected sensors
    // have data for a given timestamp slot.
    //
    // Header (10 bytes):
    //   [0]: Type (0x25)
    //   [1-4]: Frame number (uint32 LE)
    //   [5-8]: Timestamp in microseconds (uint32 LE)
    //   [9]: Sensor count
    //
    // Per-sensor data (24 bytes each):
    //   [0]: Sensor ID
    //   [1-8]: Quaternion (4x int16 LE) - w,x,y,z scaled by 16384
    //   [9-14]: Accelerometer (3x int16 LE) - scaled by 100 (m/s²)
    //   [15-20]: Gyroscope (3x int16 LE) - scaled by 900 (rad/s)
    //   [21]: Flags (reserved)
    //   [22-23]: Padding (reserved)
    // =========================================================================
    const SYNC_FRAME_HEADER_SIZE = 10;
    const SYNC_FRAME_SENSOR_SIZE = 24;
    const MAX_REASONABLE_SYNC_SENSORS = 32;

    if (len >= SYNC_FRAME_HEADER_SIZE && data.getUint8(0) === 0x25) {
      const nowMs = performance.now();
      if (
        _trustedSyncSensorIds.size > 0 &&
        nowMs - _trustedSyncSensorIdsUpdatedAt > TRUSTED_SYNC_IDS_TTL_MS
      ) {
        _trustedSyncSensorIds.clear();
      }

      const frameNumber = data.getUint32(1, true);
      const timestampUs = data.getUint32(5, true);
      const sensorCountHeader = data.getUint8(9);

      // =====================================================================
      // ROBUST SENSOR COUNT: Always prefer frame-length inference
      // =====================================================================
      // The sensorCount header byte (offset 9) is systematically corrupted
      // on some hardware — observed values {0, 1, 254, 255} correspond to
      // the MSByte of timestampUs wrapping at the uint32 boundary (~71.6 min
      // uptime), suggesting either a compiler struct-packing bug or a USB CDC
      // byte-corruption pattern.
      //
      // FIX: Always infer sensor count from frame length when possible.
      // The header byte is only used as a fallback when inference fails
      // (non-multiple-of-24 payload). This makes the parser immune to any
      // single-byte corruption at offset 9.
      // =====================================================================
      const rawPayloadBytes = len - SYNC_FRAME_HEADER_SIZE;

      // =====================================================================
      // CRC-8 DETECTION & VALIDATION
      // =====================================================================
      // New firmware appends a CRC-8 byte after sensor data. Detect by:
      //   payload % 24 === 1  → CRC present (N sensors × 24 + 1 CRC byte)
      //   payload % 24 === 0  → No CRC (backwards compatible with old firmware)
      // =====================================================================
      let payloadBytes = rawPayloadBytes;
      let hasCRC = false;
      if (
        rawPayloadBytes > 0 &&
        rawPayloadBytes % SYNC_FRAME_SENSOR_SIZE === 1
      ) {
        // CRC byte present — validate before parsing
        hasCRC = true;
        const frameDataLen = len - 1; // everything except the CRC byte
        const expectedCRC = data.getUint8(len - 1);
        const computedCRC = computeCRC8(data, 0, frameDataLen);
        _crcCheckCount++;

        if (computedCRC !== expectedCRC) {
          _crcFailCount++;
          reportCRCResult(false);
          const nowCrcMs = performance.now();
          if (nowCrcMs - _lastCrcDiagLog > 2000) {
            _lastCrcDiagLog = nowCrcMs;
            console.warn(
              `[SYNC_FRAME] CRC-8 FAIL: expected=0x${expectedCRC.toString(16).padStart(2, "0")} ` +
                `computed=0x${computedCRC.toString(16).padStart(2, "0")} ` +
                `(${_crcFailCount}/${_crcCheckCount} failures)`,
            );
          }
          return packets; // Drop corrupted frame
        }
        reportCRCResult(true);
        payloadBytes = rawPayloadBytes - 1; // Strip CRC byte for sensor parsing
      }

      const inferredFromLen =
        payloadBytes >= 0 && payloadBytes % SYNC_FRAME_SENSOR_SIZE === 0
          ? payloadBytes / SYNC_FRAME_SENSOR_SIZE
          : -1;

      let sensorCount: number;
      let wasRecovered = false;

      if (
        inferredFromLen > 0 &&
        inferredFromLen <= MAX_REASONABLE_SYNC_SENSORS
      ) {
        // Primary path: use frame-length inference (reliable)
        sensorCount = inferredFromLen;
        if (sensorCountHeader !== inferredFromLen) {
          wasRecovered = true;
          // Accumulate corruption telemetry
          _headerCorruption.totalMismatches++;
          _headerCorruption.headerValueHist[sensorCountHeader] =
            (_headerCorruption.headerValueHist[sensorCountHeader] ?? 0) + 1;
          _headerCorruption.inferredValueHist[inferredFromLen] =
            (_headerCorruption.inferredValueHist[inferredFromLen] ?? 0) + 1;
          // Rate-limited hex dump for debugging the corruption source
          if (nowMs - _lastHeaderCorruptionLog > 2000) {
            _lastHeaderCorruptionLog = nowMs;
            const hexBytes: string[] = [];
            for (let b = 0; b < Math.min(12, len); b++) {
              hexBytes.push(data.getUint8(b).toString(16).padStart(2, "0"));
            }
            console.warn(
              `[SYNC_FRAME] Header byte[9]=${sensorCountHeader} != inferred=${inferredFromLen} ` +
                `(len=${len}). Raw header: [${hexBytes.join(" ")}]`,
            );
          }
        }
      } else if (
        sensorCountHeader > 0 &&
        sensorCountHeader <= MAX_REASONABLE_SYNC_SENSORS
      ) {
        // Fallback: frame length doesn't cleanly divide — trust header
        const expectedSize =
          SYNC_FRAME_HEADER_SIZE + sensorCountHeader * SYNC_FRAME_SENSOR_SIZE;
        if (len >= expectedSize) {
          sensorCount = sensorCountHeader;
        } else {
          console.warn(
            `[SYNC_FRAME] Cannot parse: len=${len}, header=${sensorCountHeader}, inferred=${inferredFromLen}`,
          );
          _headerCorruption.unparsableFrames++;
          return packets;
        }
      } else {
        // Neither inference nor header is usable
        console.warn(
          `[SYNC_FRAME] Cannot parse: len=${len}, header=${sensorCountHeader}, inferred=${inferredFromLen}`,
        );
        _headerCorruption.unparsableFrames++;
        return packets;
      }

      const timestampSec = timestampUs / 1_000_000;
      const syncSensorIds: number[] = [];

      // Pre-validate: on recovered frames, check quaternion magnitudes before accepting.
      // Garbage data will have random int16 values that almost never produce |q| ≈ 1.0.
      if (wasRecovered) {
        let validQuatCount = 0;
        for (let s = 0; s < sensorCount; s++) {
          const off = SYNC_FRAME_HEADER_SIZE + s * SYNC_FRAME_SENSOR_SIZE;
          const rw = data.getInt16(off + 1, true);
          const rx = data.getInt16(off + 3, true);
          const ry = data.getInt16(off + 5, true);
          const rz = data.getInt16(off + 7, true);
          const magSq =
            (rw * rw + rx * rx + ry * ry + rz * rz) / (16384.0 * 16384.0);
          // Valid unit quaternion: magnitude² should be in [0.8, 1.2]
          if (magSq >= 0.8 && magSq <= 1.2) validQuatCount++;
        }
        if (validQuatCount === 0) {
          // All quaternions are garbage — this is not real sensor data
          _dropCountCorruptFrame++;
          reportParserRejects(1);
          if (nowMs - _lastHeaderCorruptionLog > 2000) {
            _lastHeaderCorruptionLog = nowMs;
            console.warn(
              `[SYNC_FRAME] Rejected recovered frame: 0/${sensorCount} quaternions valid (garbage data)`,
            );
          }
          return packets;
        }
      }

      for (let s = 0; s < sensorCount; s++) {
        const sensorOffset =
          SYNC_FRAME_HEADER_SIZE + s * SYNC_FRAME_SENSOR_SIZE;

        const sensorId = data.getUint8(sensorOffset);
        _totalSensorsProcessed++;

        // Quaternion (4x int16) - scaled by 16384
        const qwRaw = data.getInt16(sensorOffset + 1, true);
        const qxRaw = data.getInt16(sensorOffset + 3, true);
        const qyRaw = data.getInt16(sensorOffset + 5, true);
        const qzRaw = data.getInt16(sensorOffset + 7, true);

        // Quaternion magnitude sanity check (catches corrupted sensor data)
        const quatMagSq =
          (qwRaw * qwRaw + qxRaw * qxRaw + qyRaw * qyRaw + qzRaw * qzRaw) /
          (16384.0 * 16384.0);
        if (quatMagSq < 0.8 || quatMagSq > 1.2) {
          // Garbage quaternion — skip this sensor slot
          _dropCountQuatMag++;
          reportParserRejects(1);
          continue;
        }

        const qw = qwRaw / 16384.0;
        const qx = qxRaw / 16384.0;
        const qy = qyRaw / 16384.0;
        const qz = qzRaw / 16384.0;

        // Accelerometer (3x int16) - scaled by 100 (m/s²)
        const ax = data.getInt16(sensorOffset + 9, true) / 100.0;
        const ay = data.getInt16(sensorOffset + 11, true) / 100.0;
        const az = data.getInt16(sensorOffset + 13, true) / 100.0;

        // Gyroscope (3x int16) - scaled by 900 (rad/s)
        const gxRaw = data.getInt16(sensorOffset + 15, true);
        const gyRaw = data.getInt16(sensorOffset + 17, true);
        const gzRaw = data.getInt16(sensorOffset + 19, true);

        // Flags (Offset 21 in 24-byte struct)
        const flags = data.getUint8(sensorOffset + 21);
        const isValid = (flags & 0x01) !== 0;

        // Skip invalid sensors (Partial Frame Emission/Recovered Slots)
        if (!isValid) {
          _dropCountInvalid++;
          reportParserRejects(1);
          continue;
        }

        if (
          ENFORCE_TRUSTED_SYNC_IDS_FILTER &&
          _trustedSyncSensorIds.size > 0 &&
          !_trustedSyncSensorIds.has(sensorId)
        ) {
          _dropCountUntrusted++;
          reportParserRejects(1);
          continue;
        }

        syncSensorIds.push(sensorId);

        const gx = gxRaw / 900.0;
        const gy = gyRaw / 900.0;
        const gz = gzRaw / 900.0;

        // Sync frames have guaranteed high quality sync
        const syncQuality: SyncQuality = {
          offsetUncertaintyUs: 0,
          driftPpmX10: 0,
          lastSyncAgeMs: 0,
          confidence: 3, // High
          kalmanInitialized: true,
          outlierRejected: false,
        };

        const packet: IMUDataPacket = {
          sensorId,
          timestamp: timestampSec,
          timestampUs,
          frameNumber,
          quaternion: [qw, qx, qy, qz],
          accelerometer: [ax, ay, az],
          gyro: [gx, gy, gz],
          battery: 100,
          format: "0x25-sync",
          syncQuality,
          // OPP-2: Frame completeness metadata (populated after sensor loop)
        };

        packets.push(packet);
      }

      // Report synced samples (with firmware timestamp for StreamAnalyzer jitter analysis)
      if (syncSensorIds.length > 0) {
        reportSyncedSamples(syncSensorIds, 1, frameNumber, [timestampUs]);
      }

      // OPP-2: Enrich all parsed packets with frame completeness metadata
      const completeness0x25 = {
        validCount: syncSensorIds.length,
        expectedCount: sensorCount,
        isComplete: syncSensorIds.length >= sensorCount,
      };
      for (const pkt of packets) {
        if ("quaternion" in pkt) {
          (pkt as IMUDataPacket).frameCompleteness = completeness0x25;
        }
      }

      // Track sync completeness diagnostics
      trackSyncFrameDiag(sensorCount, syncSensorIds, "0x25", frameNumber);

      // Learn trusted sensor IDs from complete, contiguous frames.
      // SAFETY: Only learn when the header sensorCount matches the frame-length-
      // inferred count. This prevents corrupted headers from poisoning the set.
      if (
        syncSensorIds.length === sensorCount &&
        sensorCount >= 2 &&
        (inferredFromLen <= 0 || sensorCount === inferredFromLen) &&
        areConsecutiveModulo256(syncSensorIds)
      ) {
        _trustedSyncSensorIds = new Set(syncSensorIds);
        _trustedSyncSensorIdsUpdatedAt = nowMs;
      }

      // DIAGNOSTIC: Log frame completeness every 5 seconds
      const now = performance.now();
      if (now - _lastSyncFrameLog > 5000) {
        _lastSyncFrameLog = now;
        console.debug(
          `[SYNC FRAME 0x25] frame#=${frameNumber}, sensors parsed: ${syncSensorIds.length}/${sensorCount} [${syncSensorIds.join(",")}]`,
        );
      }
      // Track incomplete frames
      if (syncSensorIds.length < sensorCount) {
        _incompleteSyncFrames++;
      }

      return packets;
    }

    return packets;
  }

  /**
   * Parse Node Info / Discovery packet (0x05).
   * Returns null if not a node info packet.
   */
  static parseNodeInfoPacket(data: DataView): NodeInfoPacket | null {
    const len = data.byteLength;
    if (len !== 37 && len !== 46) return null;
    if (data.getUint8(0) !== 0x05) return null;

    const nameBytes = new Uint8Array(data.buffer, data.byteOffset + 1, 32);
    let nameLen = 0;
    while (nameLen < 32 && nameBytes[nameLen] !== 0) nameLen++;
    const nodeName = new TextDecoder().decode(nameBytes.subarray(0, nameLen));

    const sensorIdOffset = data.getUint8(33);
    const sensorCount = data.getUint8(34);
    const hasMag = data.getUint8(35) === 1;
    const hasBaro = data.getUint8(36) === 1;

    let useMux: boolean | undefined;
    let sensorChannels: number[] | undefined;

    if (len >= 46) {
      useMux = data.getUint8(37) === 1;
      sensorChannels = [];
      for (let i = 0; i < 8; i++) {
        sensorChannels.push(data.getInt8(38 + i));
      }
    }

    return {
      nodeName,
      sensorIdOffset,
      sensorCount,
      hasMagnetometer: hasMag,
      hasBarometer: hasBaro,
      useMux,
      sensorChannels,
    };
  }

  /**
   * Parse environmental packet (0x04 format).
   * Returns null if not an environmental packet.
   */
  static parseEnvironmentalPacket(
    data: DataView,
  ): EnvironmentalDataPacket | null {
    const len = data.byteLength;

    if (len === 31 && data.getUint8(0) === 0x04) {
      const hasMag = data.getUint8(1) === 1;
      const hasBaro = data.getUint8(2) === 1;

      const envPacket: EnvironmentalDataPacket = {
        timestamp: performance.now(),
      };

      if (hasMag) {
        envPacket.magnetometer = {
          x: data.getFloat32(3, true),
          y: data.getFloat32(7, true),
          z: data.getFloat32(11, true),
          heading: data.getFloat32(15, true),
        };
      }

      if (hasBaro) {
        envPacket.barometer = {
          pressure: data.getFloat32(19, true),
          temperature: data.getFloat32(23, true),
          altitude: data.getFloat32(27, true),
        };
      }

      return envPacket;
    }

    return null;
  }
}
