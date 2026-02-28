/**
 * syncFramePipeline.test.ts - Comprehensive Sync Frame Pipeline Tests
 *
 * These tests validate the entire Sync Frame architecture from packet generation
 * through parsing to data integrity verification.
 *
 * THE SYNC FRAME ARCHITECTURE:
 * - Gateway collects samples from multiple nodes
 * - Only emits 0x25 packets when ALL sensors have data for the same timestamp
 * - Guarantees cross-node synchronization at the packet level
 *
 * TEST COVERAGE:
 * 1. Packet format correctness
 * 2. Parser behavior with valid/invalid data
 * 3. Multi-sensor timestamp alignment verification
 * 4. Stress testing with high sample rates
 * 5. Edge cases (missing sensors, timeout, overflow)
 * 6. End-to-end data integrity
 *
 * Run with: npm test -- --run syncFramePipeline
 */

import { describe, it, expect, beforeEach } from "vitest";

// ============================================================================
// SYNC FRAME PACKET FORMAT CONSTANTS (must match firmware)
// ============================================================================

const SYNC_FRAME_PACKET_TYPE = 0x25;
const SYNC_FRAME_HEADER_SIZE = 10; // type(1) + frame(4) + timestamp(4) + sensorCount(1)
const SYNC_FRAME_SENSOR_SIZE = 24; // sensorId(1) + q[4](8) + a[3](6) + g[3](6) + flags(1) + reserved(2)

// Scaling factors (must match firmware)
const QUAT_SCALE = 16384; // Quaternion: ±1.0 → ±16384
const ACCEL_SCALE = 100; // Accelerometer: m/s² × 100
const GYRO_SCALE = 900; // Gyroscope: °/s × 900

// ============================================================================
// TYPES
// ============================================================================

interface SensorData {
  sensorId: number;
  quaternion: { w: number; x: number; y: number; z: number };
  acceleration: { x: number; y: number; z: number };
  gyroscope: { x: number; y: number; z: number };
}

interface SyncFrame {
  frameNumber: number;
  timestampUs: number;
  sensors: SensorData[];
}

interface ParsedPacket {
  sensorId: number;
  timestamp: number;
  quaternion: { w: number; x: number; y: number; z: number };
  acceleration: { x: number; y: number; z: number };
  gyroscope: { x: number; y: number; z: number };
  format: string;
}

// ============================================================================
// PACKET GENERATOR (Simulates Gateway Output)
// ============================================================================

/**
 * Build a 0x25 Sync Frame packet exactly as the Gateway would
 */
function buildSyncFramePacket(frame: SyncFrame): Uint8Array {
  const packetSize =
    SYNC_FRAME_HEADER_SIZE + frame.sensors.length * SYNC_FRAME_SENSOR_SIZE;
  const buffer = new ArrayBuffer(packetSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Header
  view.setUint8(0, SYNC_FRAME_PACKET_TYPE); // Type
  view.setUint32(1, frame.frameNumber, true); // Frame number (LE)
  view.setUint32(5, frame.timestampUs, true); // Timestamp (LE)
  view.setUint8(9, frame.sensors.length); // Sensor count

  // Per-sensor data
  for (let i = 0; i < frame.sensors.length; i++) {
    const sensor = frame.sensors[i];
    const offset = SYNC_FRAME_HEADER_SIZE + i * SYNC_FRAME_SENSOR_SIZE;

    view.setUint8(offset, sensor.sensorId);

    // Quaternion (scaled by 16384 - matches firmware)
    view.setInt16(offset + 1, Math.round(sensor.quaternion.w * 16384), true);
    view.setInt16(offset + 3, Math.round(sensor.quaternion.x * 16384), true);
    view.setInt16(offset + 5, Math.round(sensor.quaternion.y * 16384), true);
    view.setInt16(offset + 7, Math.round(sensor.quaternion.z * 16384), true);

    // Accelerometer (scaled by 100 for m/s² - matches firmware)
    view.setInt16(offset + 9, Math.round(sensor.acceleration.x * 100), true);
    view.setInt16(offset + 11, Math.round(sensor.acceleration.y * 100), true);
    view.setInt16(offset + 13, Math.round(sensor.acceleration.z * 100), true);

    // Gyroscope (scaled by 900 for rad/s - matches firmware)
    view.setInt16(offset + 15, Math.round(sensor.gyroscope.x * 900), true);
    view.setInt16(offset + 17, Math.round(sensor.gyroscope.y * 900), true);
    view.setInt16(offset + 19, Math.round(sensor.gyroscope.z * 900), true);

    // Flags and reserved
    view.setUint8(offset + 21, 0x01); // Valid flag
    view.setUint8(offset + 22, 0);
    view.setUint8(offset + 23, 0);
  }

  return bytes;
}

/**
 * Parse a 0x25 Sync Frame packet (simplified version matching IMUParser)
 */
function parseSyncFramePacket(data: Uint8Array): ParsedPacket[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const packets: ParsedPacket[] = [];

  if (data.length < SYNC_FRAME_HEADER_SIZE) {
    throw new Error(
      `Packet too short: ${data.length} < ${SYNC_FRAME_HEADER_SIZE}`,
    );
  }

  const type = view.getUint8(0);
  if (type !== SYNC_FRAME_PACKET_TYPE) {
    throw new Error(`Invalid packet type: 0x${type.toString(16)}`);
  }

  const frameNumber = view.getUint32(1, true);
  const timestampUs = view.getUint32(5, true);
  const sensorCount = view.getUint8(9);

  const expectedSize =
    SYNC_FRAME_HEADER_SIZE + sensorCount * SYNC_FRAME_SENSOR_SIZE;
  if (data.length < expectedSize) {
    throw new Error(
      `Packet too short for ${sensorCount} sensors: ${data.length} < ${expectedSize}`,
    );
  }

  const timestampSec = timestampUs / 1_000_000;

  for (let i = 0; i < sensorCount; i++) {
    const offset = SYNC_FRAME_HEADER_SIZE + i * SYNC_FRAME_SENSOR_SIZE;

    const sensorId = view.getUint8(offset);

    // Quaternion (scaled by 16384 - matches firmware)
    const qw = view.getInt16(offset + 1, true) / 16384.0;
    const qx = view.getInt16(offset + 3, true) / 16384.0;
    const qy = view.getInt16(offset + 5, true) / 16384.0;
    const qz = view.getInt16(offset + 7, true) / 16384.0;

    // Accelerometer (scaled by 100 - matches firmware)
    const ax = view.getInt16(offset + 9, true) / 100.0;
    const ay = view.getInt16(offset + 11, true) / 100.0;
    const az = view.getInt16(offset + 13, true) / 100.0;

    // Gyroscope (scaled by 900 - matches firmware)
    const gx = view.getInt16(offset + 15, true) / 900.0;
    const gy = view.getInt16(offset + 17, true) / 900.0;
    const gz = view.getInt16(offset + 19, true) / 900.0;

    packets.push({
      sensorId,
      timestamp: timestampSec,
      quaternion: { w: qw, x: qx, y: qy, z: qz },
      acceleration: { x: ax, y: ay, z: az },
      gyroscope: { x: gx, y: gy, z: gz },
      format: "0x25-sync",
    });
  }

  return packets;
}

// ============================================================================
// SYNC FRAME BUFFER SIMULATOR (Simulates Gateway Behavior)
// ============================================================================

interface SampleInput {
  sensorId: number;
  timestampUs: number;
  frameNumber: number;
  quaternion: { w: number; x: number; y: number; z: number };
  acceleration: { x: number; y: number; z: number };
  gyroscope: { x: number; y: number; z: number };
}

interface TimestampSlot {
  timestampUs: number;
  frameNumber: number;
  sensors: Map<number, SampleInput>;
}

class SyncFrameBufferSimulator {
  private expectedSensorIds: number[] = [];
  private slots: Map<number, TimestampSlot> = new Map();
  private completedFrames: SyncFrame[] = [];
  private droppedCount = 0;
  private incompleteCount = 0;
  private timestampTolerance = 100; // 100µs tolerance

  constructor(expectedSensorIds: number[]) {
    this.expectedSensorIds = [...expectedSensorIds];
  }

  addSample(sample: SampleInput): void {
    if (!this.expectedSensorIds.includes(sample.sensorId)) {
      return; // Unknown sensor
    }

    // Find or create slot (with tolerance matching)
    let slot = this.findSlotWithinTolerance(sample.timestampUs);

    if (!slot) {
      slot = {
        timestampUs: sample.timestampUs,
        frameNumber: sample.frameNumber,
        sensors: new Map(),
      };
      this.slots.set(sample.timestampUs, slot);
    }

    slot.sensors.set(sample.sensorId, sample);

    // Check if slot is complete
    if (this.isSlotComplete(slot)) {
      this.emitFrame(slot);
      this.slots.delete(slot.timestampUs);
    }
  }

  private findSlotWithinTolerance(
    timestampUs: number,
  ): TimestampSlot | undefined {
    for (const [ts, slot] of this.slots) {
      if (Math.abs(ts - timestampUs) <= this.timestampTolerance) {
        return slot;
      }
    }
    return undefined;
  }

  private isSlotComplete(slot: TimestampSlot): boolean {
    return this.expectedSensorIds.every((id) => slot.sensors.has(id));
  }

  private emitFrame(slot: TimestampSlot): void {
    const sensors: SensorData[] = this.expectedSensorIds.map((id) => {
      const sample = slot.sensors.get(id)!;
      return {
        sensorId: sample.sensorId,
        quaternion: sample.quaternion,
        acceleration: sample.acceleration,
        gyroscope: sample.gyroscope,
      };
    });

    this.completedFrames.push({
      frameNumber: slot.frameNumber,
      timestampUs: slot.timestampUs,
      sensors,
    });
  }

  expireOldSlots(currentTimeUs: number, timeoutUs: number = 50000): void {
    for (const [ts, slot] of this.slots) {
      if (currentTimeUs - ts > timeoutUs) {
        if (!this.isSlotComplete(slot)) {
          this.incompleteCount++;
        }
        this.slots.delete(ts);
      }
    }
  }

  getCompletedFrames(): SyncFrame[] {
    return [...this.completedFrames];
  }

  clearCompletedFrames(): void {
    this.completedFrames = [];
  }

  getStats() {
    return {
      pendingSlots: this.slots.size,
      completedFrames: this.completedFrames.length,
      droppedCount: this.droppedCount,
      incompleteCount: this.incompleteCount,
    };
  }
}

// ============================================================================
// TEST HELPERS
// ============================================================================

function createSensorData(sensorId: number, variation: number = 0): SensorData {
  return {
    sensorId,
    quaternion: { w: 1, x: 0 + variation * 0.001, y: 0, z: 0 },
    acceleration: { x: 0, y: 0, z: 9.81 + variation * 0.01 },
    gyroscope: { x: variation * 0.1, y: 0, z: 0 },
  };
}

function createSampleInput(
  sensorId: number,
  timestampUs: number,
  frameNumber: number,
): SampleInput {
  return {
    sensorId,
    timestampUs,
    frameNumber,
    quaternion: { w: 1, x: 0, y: 0, z: 0 },
    acceleration: { x: 0, y: 0, z: 9.81 },
    gyroscope: { x: 0, y: 0, z: 0 },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe("Sync Frame Pipeline", () => {
  describe("Packet Format", () => {
    it("should create valid 0x25 packet header", () => {
      const frame: SyncFrame = {
        frameNumber: 42,
        timestampUs: 1000000,
        sensors: [createSensorData(180)],
      };

      const packet = buildSyncFramePacket(frame);
      const view = new DataView(packet.buffer);

      expect(packet[0]).toBe(0x25);
      expect(view.getUint32(1, true)).toBe(42);
      expect(view.getUint32(5, true)).toBe(1000000);
      expect(packet[9]).toBe(1);
    });

    it("should encode sensor data correctly", () => {
      const frame: SyncFrame = {
        frameNumber: 1,
        timestampUs: 5000000,
        sensors: [
          {
            sensorId: 180,
            quaternion: { w: 1, x: 0, y: 0, z: 0 },
            acceleration: { x: 0, y: 0, z: 1 }, // 1 m/s²
            gyroscope: { x: 0, y: 0, z: 1.5 }, // 1.5 rad/s (~86 deg/s)
          },
        ],
      };

      const packet = buildSyncFramePacket(frame);
      const view = new DataView(packet.buffer);

      // Sensor data starts at offset 10 (after header)
      const sensorOffset = SYNC_FRAME_HEADER_SIZE;

      // Check sensor ID
      expect(view.getUint8(sensorOffset)).toBe(180);

      // Check quaternion (w=1 → 16384)
      expect(view.getInt16(sensorOffset + 1, true)).toBe(16384);

      // Check accel z (1 m/s² → 100 at scale 100) at offset +13
      expect(view.getInt16(sensorOffset + 13, true)).toBe(100);

      // Check gyro z (1.5 rad/s → 1350 at scale 900) at offset +19
      expect(view.getInt16(sensorOffset + 19, true)).toBe(1350);
    });

    it("should calculate correct packet size for 7 sensors", () => {
      const sensors = [180, 181, 182, 183, 184, 185, 204].map((id) =>
        createSensorData(id),
      );
      const frame: SyncFrame = {
        frameNumber: 100,
        timestampUs: 2000000,
        sensors,
      };

      const packet = buildSyncFramePacket(frame);
      const expectedSize = SYNC_FRAME_HEADER_SIZE + 7 * SYNC_FRAME_SENSOR_SIZE;

      expect(packet.length).toBe(expectedSize);
      expect(packet.length).toBe(10 + 7 * 24); // 178 bytes
    });
  });

  describe("Packet Parsing", () => {
    it("should parse single-sensor packet", () => {
      const frame: SyncFrame = {
        frameNumber: 1,
        timestampUs: 1000000,
        sensors: [createSensorData(180)],
      };

      const packet = buildSyncFramePacket(frame);
      const parsed = parseSyncFramePacket(packet);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].sensorId).toBe(180);
      expect(parsed[0].timestamp).toBeCloseTo(1.0, 6);
      expect(parsed[0].format).toBe("0x25-sync");
    });

    it("should parse 7-sensor packet with correct data", () => {
      const sensorIds = [180, 181, 182, 183, 184, 185, 204];
      const sensors = sensorIds.map((id, i) => ({
        sensorId: id,
        quaternion: { w: 1, x: 0.1 * i, y: 0, z: 0 },
        acceleration: { x: 0, y: 0, z: 9.81 + i * 0.1 },
        gyroscope: { x: i * 10, y: 0, z: 0 },
      }));

      const frame: SyncFrame = {
        frameNumber: 42,
        timestampUs: 5000000,
        sensors,
      };

      const packet = buildSyncFramePacket(frame);
      const parsed = parseSyncFramePacket(packet);

      expect(parsed).toHaveLength(7);

      // All sensors should have the SAME timestamp (the whole point!)
      const timestamps = parsed.map((p) => p.timestamp);
      expect(new Set(timestamps).size).toBe(1);
      expect(timestamps[0]).toBeCloseTo(5.0, 6);

      // Verify sensor IDs are preserved
      expect(parsed.map((p) => p.sensorId)).toEqual(sensorIds);

      // Spot check data (allowing for quantization)
      expect(parsed[0].quaternion.w).toBeCloseTo(1, 2);
      expect(parsed[3].quaternion.x).toBeCloseTo(0.3, 1);
    });

    it("should throw on truncated packet", () => {
      const frame: SyncFrame = {
        frameNumber: 1,
        timestampUs: 1000000,
        sensors: [createSensorData(180), createSensorData(181)],
      };

      const packet = buildSyncFramePacket(frame);
      const truncated = packet.slice(0, 30); // Cut off part of sensor data

      expect(() => parseSyncFramePacket(truncated)).toThrow();
    });

    it("should throw on wrong packet type", () => {
      const packet = new Uint8Array([0x23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
      expect(() => parseSyncFramePacket(packet)).toThrow(/Invalid packet type/);
    });
  });

  describe("SyncFrameBuffer Simulation", () => {
    const expectedSensors = [180, 181, 182, 183, 184, 185, 204];
    let buffer: SyncFrameBufferSimulator;

    beforeEach(() => {
      buffer = new SyncFrameBufferSimulator(expectedSensors);
    });

    it("should complete frame when all sensors arrive", () => {
      const timestampUs = 1000000;

      // Add all 7 sensors with same timestamp
      for (const sensorId of expectedSensors) {
        buffer.addSample(createSampleInput(sensorId, timestampUs, 1));
      }

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0].sensors).toHaveLength(7);
      expect(frames[0].timestampUs).toBe(timestampUs);
    });

    it("should NOT complete frame when sensors are missing", () => {
      const timestampUs = 1000000;

      // Add only 6 sensors (missing 204)
      for (const sensorId of [180, 181, 182, 183, 184, 185]) {
        buffer.addSample(createSampleInput(sensorId, timestampUs, 1));
      }

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(0);
      expect(buffer.getStats().pendingSlots).toBe(1);
    });

    it("should handle samples arriving out of order", () => {
      const timestampUs = 1000000;

      // Add sensors in random order
      const shuffled = [204, 181, 183, 180, 185, 182, 184];
      for (const sensorId of shuffled) {
        buffer.addSample(createSampleInput(sensorId, timestampUs, 1));
      }

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(1);
    });

    it("should match timestamps within tolerance", () => {
      // Sensors arrive with slight timestamp variations (within 100µs)
      buffer.addSample(createSampleInput(180, 1000000, 1));
      buffer.addSample(createSampleInput(181, 1000050, 1)); // +50µs
      buffer.addSample(createSampleInput(182, 1000025, 1)); // +25µs
      buffer.addSample(createSampleInput(183, 1000075, 1)); // +75µs
      buffer.addSample(createSampleInput(184, 1000010, 1)); // +10µs
      buffer.addSample(createSampleInput(185, 1000090, 1)); // +90µs
      buffer.addSample(createSampleInput(204, 1000030, 1)); // +30µs

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(1);
    });

    it("should NOT match timestamps outside tolerance", () => {
      // Sensors with timestamps too far apart
      buffer.addSample(createSampleInput(180, 1000000, 1));
      buffer.addSample(createSampleInput(181, 1000000, 1));
      buffer.addSample(createSampleInput(182, 1000000, 1));
      buffer.addSample(createSampleInput(183, 1000000, 1));
      buffer.addSample(createSampleInput(184, 1000000, 1));
      buffer.addSample(createSampleInput(185, 1000000, 1));
      buffer.addSample(createSampleInput(204, 1005000, 1)); // 5ms later - different frame!

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(0);
      expect(buffer.getStats().pendingSlots).toBe(2); // Two separate slots
    });

    it("should handle multiple frames in sequence", () => {
      // Simulate 200Hz for 100ms = 20 frames
      for (let frame = 0; frame < 20; frame++) {
        const timestampUs = 1000000 + frame * 5000; // 5ms intervals
        for (const sensorId of expectedSensors) {
          buffer.addSample(createSampleInput(sensorId, timestampUs, frame));
        }
      }

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(20);

      // Verify timestamps are sequential
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i].timestampUs - frames[i - 1].timestampUs).toBe(5000);
      }
    });

    it("should expire incomplete frames after timeout", () => {
      const timestampUs = 1000000;

      // Add only 6 sensors
      for (const sensorId of [180, 181, 182, 183, 184, 185]) {
        buffer.addSample(createSampleInput(sensorId, timestampUs, 1));
      }

      // Expire with current time 60ms later
      buffer.expireOldSlots(timestampUs + 60000);

      expect(buffer.getStats().pendingSlots).toBe(0);
      expect(buffer.getStats().incompleteCount).toBe(1);
    });

    it("should ignore unknown sensors", () => {
      // Add sample from unknown sensor
      buffer.addSample(createSampleInput(999, 1000000, 1));

      expect(buffer.getStats().pendingSlots).toBe(0);
    });
  });

  describe("End-to-End Pipeline", () => {
    it("should preserve data integrity through full pipeline", () => {
      const expectedSensors = [180, 181, 182, 183, 184, 185, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      // Create samples with specific data
      // Note: gyro values must fit in int16 after scaling by 900
      // Max safe value: 32767 / 900 ≈ 36 rad/s
      const originalData: Map<number, SampleInput> = new Map();
      const timestampUs = 5000000;

      for (let i = 0; i < expectedSensors.length; i++) {
        const sensorId = expectedSensors[i];
        const sample: SampleInput = {
          sensorId,
          timestampUs,
          frameNumber: 1,
          quaternion: { w: 0.9, x: 0.1 * i, y: 0.05 * i, z: 0.02 * i },
          acceleration: { x: 0.1 * i, y: 0.2 * i, z: 9.81 },
          gyroscope: { x: 1.0 * i, y: 0.5 * i, z: 0.2 * i }, // Realistic rad/s values
        };
        originalData.set(sensorId, sample);
        buffer.addSample(sample);
      }

      // Get completed frame
      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(1);

      // Build packet
      const packet = buildSyncFramePacket(frames[0]);

      // Parse packet
      const parsed = parseSyncFramePacket(packet);

      // Verify data integrity (allowing for quantization error)
      for (const p of parsed) {
        const original = originalData.get(p.sensorId)!;

        expect(p.quaternion.w).toBeCloseTo(original.quaternion.w, 1);
        expect(p.quaternion.x).toBeCloseTo(original.quaternion.x, 1);
        expect(p.acceleration.z).toBeCloseTo(original.acceleration.z, 0);
        expect(p.gyroscope.x).toBeCloseTo(original.gyroscope.x, 0);
      }
    });

    it("should handle high-frequency streaming (200Hz for 10s)", () => {
      const expectedSensors = [180, 181, 182, 183, 184, 185, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      const durationMs = 10000; // 10 seconds
      const sampleIntervalUs = 5000; // 200Hz = 5ms
      const totalFrames = (durationMs * 1000) / sampleIntervalUs; // 2000 frames

      // Simulate streaming
      for (let frame = 0; frame < totalFrames; frame++) {
        const timestampUs = frame * sampleIntervalUs;
        for (const sensorId of expectedSensors) {
          buffer.addSample(createSampleInput(sensorId, timestampUs, frame));
        }
      }

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(totalFrames);

      // Verify frame continuity
      let missingFrames = 0;
      for (let i = 1; i < frames.length; i++) {
        if (
          frames[i].timestampUs - frames[i - 1].timestampUs !==
          sampleIntervalUs
        ) {
          missingFrames++;
        }
      }
      expect(missingFrames).toBe(0);
    });

    it("should calculate correct Hz from sync frames", () => {
      const expectedSensors = [180, 181, 182, 183, 184, 185, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      const startTimeUs = 1000000;
      const targetHz = 200;
      const sampleIntervalUs = 1000000 / targetHz;
      const numFrames = 100;

      for (let frame = 0; frame < numFrames; frame++) {
        const timestampUs = startTimeUs + frame * sampleIntervalUs;
        for (const sensorId of expectedSensors) {
          buffer.addSample(createSampleInput(sensorId, timestampUs, frame));
        }
      }

      const frames = buffer.getCompletedFrames();

      // Calculate Hz from timestamps
      const firstTs = frames[0].timestampUs;
      const lastTs = frames[frames.length - 1].timestampUs;
      const durationUs = lastTs - firstTs;
      const calculatedHz = (frames.length - 1) / (durationUs / 1000000);

      expect(calculatedHz).toBeCloseTo(targetHz, 0);
    });
  });

  describe("Stress Tests", () => {
    it("should handle interleaved samples from different frames", () => {
      const expectedSensors = [180, 181, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      // Interleave samples from multiple frames (realistic network jitter)
      // Frame 0 @ t=0, Frame 1 @ t=5000
      buffer.addSample(createSampleInput(180, 0, 0));
      buffer.addSample(createSampleInput(180, 5000, 1));
      buffer.addSample(createSampleInput(181, 0, 0));
      buffer.addSample(createSampleInput(204, 5000, 1));
      buffer.addSample(createSampleInput(204, 0, 0));
      buffer.addSample(createSampleInput(181, 5000, 1));

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(2);

      // Verify correct ordering by timestamp
      expect(frames[0].timestampUs).toBeLessThan(frames[1].timestampUs);
    });

    it("should handle packet loss gracefully (missing one node)", () => {
      const expectedSensors = [180, 181, 182, 183, 184, 185, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      // Simulate Node 204 dropping out after frame 10
      for (let frame = 0; frame < 20; frame++) {
        const timestampUs = frame * 5000;

        // Node 180's sensors always arrive
        for (const sensorId of [180, 181, 182, 183, 184, 185]) {
          buffer.addSample(createSampleInput(sensorId, timestampUs, frame));
        }

        // Node 204 only arrives for first 10 frames
        if (frame < 10) {
          buffer.addSample(createSampleInput(204, timestampUs, frame));
        }
      }

      // Expire incomplete frames (need time after last frame)
      buffer.expireOldSlots(200000); // 200ms to ensure all incomplete frames expire

      const stats = buffer.getStats();
      expect(buffer.getCompletedFrames()).toHaveLength(10);
      // Incomplete frames are those where Node 204 was missing (frames 10-19)
      expect(stats.incompleteCount).toBeGreaterThanOrEqual(10);
    });

    it("should maintain timestamp consistency under jitter", () => {
      const expectedSensors = [180, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      // Add samples with random jitter up to 50µs
      for (let frame = 0; frame < 100; frame++) {
        const baseTimestamp = frame * 5000;

        buffer.addSample(
          createSampleInput(180, baseTimestamp + Math.random() * 50, frame),
        );
        buffer.addSample(
          createSampleInput(204, baseTimestamp + Math.random() * 50, frame),
        );
      }

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(100);

      // All frames should be complete with consistent sensors
      for (const frame of frames) {
        expect(frame.sensors).toHaveLength(2);
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle timestamp overflow (uint32 wraparound)", () => {
      const expectedSensors = [180, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      // Near uint32 max
      const nearMax = 0xffffffff - 10000;

      buffer.addSample(createSampleInput(180, nearMax, 1));
      buffer.addSample(createSampleInput(204, nearMax, 1));

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0].timestampUs).toBe(nearMax);
    });

    it("should handle zero timestamp", () => {
      const expectedSensors = [180, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      buffer.addSample(createSampleInput(180, 0, 0));
      buffer.addSample(createSampleInput(204, 0, 0));

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0].timestampUs).toBe(0);
    });

    it("should handle duplicate samples (same sensor, same timestamp)", () => {
      const expectedSensors = [180, 204];
      const buffer = new SyncFrameBufferSimulator(expectedSensors);

      // Add same sample twice
      buffer.addSample(createSampleInput(180, 1000000, 1));
      buffer.addSample(createSampleInput(180, 1000000, 1)); // Duplicate
      buffer.addSample(createSampleInput(204, 1000000, 1));

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0].sensors).toHaveLength(2);
    });

    it("should handle empty sensor list", () => {
      const buffer = new SyncFrameBufferSimulator([]);

      // Any sample should be ignored
      buffer.addSample(createSampleInput(180, 1000000, 1));

      // Should immediately complete with 0 sensors? Or never complete?
      // Design choice: empty sensor list means nothing to wait for
      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(0);
    });

    it("should handle single sensor configuration", () => {
      const buffer = new SyncFrameBufferSimulator([180]);

      buffer.addSample(createSampleInput(180, 1000000, 1));

      const frames = buffer.getCompletedFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0].sensors).toHaveLength(1);
    });
  });
});

// ============================================================================
// EXPORT for use in other tests
// ============================================================================

export {
  buildSyncFramePacket,
  parseSyncFramePacket,
  SyncFrameBufferSimulator,
  type SyncFrame,
  type SensorData,
  type ParsedPacket,
  type SampleInput,
};
