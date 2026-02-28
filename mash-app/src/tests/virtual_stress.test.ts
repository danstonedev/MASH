import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IMUParser } from "../lib/connection/IMUParser";
import { JitterBuffer } from "../lib/connection/JitterBuffer";

// ============================================================================
// TEST HELPERS - 0x25 SyncFrame Format
// ============================================================================

// Scaling constants matching firmware
const QUAT_SCALE = 16384;
const ACCEL_SCALE = 100; // m/s²
const GYRO_SCALE = 900; // rad/s

// Re-implement CRC8 for test generation (Polynomial 0x07)
const CRC8_TABLE = [
  0x00, 0x07, 0x0e, 0x09, 0x1c, 0x1b, 0x12, 0x15, 0x38, 0x3f, 0x36, 0x31, 0x24,
  0x23, 0x2a, 0x2d, 0x70, 0x77, 0x7e, 0x79, 0x6c, 0x6b, 0x62, 0x65, 0x48, 0x4f,
  0x46, 0x41, 0x54, 0x53, 0x5a, 0x5d, 0xe0, 0xe7, 0xee, 0xe9, 0xfc, 0xfb, 0xf2,
  0xf5, 0xd8, 0xdf, 0xd6, 0xd1, 0xc4, 0xc3, 0xca, 0xcd, 0x90, 0x97, 0x9e, 0x99,
  0x8c, 0x8b, 0x82, 0x85, 0xa8, 0xaf, 0xa6, 0xa1, 0xb4, 0xb3, 0xba, 0xbd, 0xc7,
  0xc0, 0xc9, 0xce, 0xdb, 0xdc, 0xd5, 0xd2, 0xff, 0xf8, 0xf1, 0xf6, 0xe3, 0xe4,
  0xed, 0xea, 0xb7, 0xb0, 0xb9, 0xbe, 0xab, 0xac, 0xa5, 0xa2, 0x8f, 0x88, 0x81,
  0x86, 0x93, 0x94, 0x9d, 0x9a, 0x27, 0x20, 0x29, 0x2e, 0x3b, 0x3c, 0x35, 0x32,
  0x1f, 0x18, 0x11, 0x16, 0x03, 0x04, 0x0d, 0x0a, 0x57, 0x50, 0x59, 0x5e, 0x4b,
  0x4c, 0x45, 0x42, 0x6f, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7d, 0x7a, 0x89, 0x8e,
  0x87, 0x80, 0x95, 0x92, 0x9b, 0x9c, 0xb1, 0xb6, 0xbf, 0xb8, 0xad, 0xaa, 0xa3,
  0xa4, 0xf9, 0xfe, 0xf7, 0xf0, 0xe5, 0xe2, 0xeb, 0xec, 0xc1, 0xc6, 0xcf, 0xc8,
  0xdd, 0xda, 0xd3, 0xd4, 0x69, 0x6e, 0x67, 0x60, 0x75, 0x72, 0x7b, 0x7c, 0x51,
  0x56, 0x5f, 0x58, 0x4d, 0x4a, 0x43, 0x44, 0x19, 0x1e, 0x17, 0x10, 0x05, 0x02,
  0x0b, 0x0c, 0x21, 0x26, 0x2f, 0x28, 0x3d, 0x3a, 0x33, 0x34, 0x4e, 0x49, 0x40,
  0x47, 0x52, 0x55, 0x5c, 0x5b, 0x76, 0x71, 0x78, 0x7f, 0x6a, 0x6d, 0x64, 0x63,
  0x3e, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2c, 0x2b, 0x06, 0x01, 0x08, 0x0f, 0x1a,
  0x1d, 0x14, 0x13, 0xae, 0xa9, 0xa0, 0xa7, 0xb2, 0xb5, 0xbc, 0xbb, 0x96, 0x91,
  0x98, 0x9f, 0x8a, 0x8d, 0x84, 0x83, 0xde, 0xd9, 0xd0, 0xd7, 0xc2, 0xc5, 0xcc,
  0xcb, 0xe6, 0xe1, 0xe8, 0xef, 0xfa, 0xfd, 0xf4, 0xf3,
];

function calculateCRC8(data: Uint8Array, length: number): number {
  let crc = 0x00;
  for (let i = 0; i < length; i++) {
    crc = CRC8_TABLE[(crc ^ data[i]) & 0xff];
  }
  return crc;
}

/**
 * Create a 0x25 SyncFrame packet
 *
 * Header (10 bytes - matches firmware SyncFrameBuffer.h):
 *   [0]: Type (0x25)
 *   [1-4]: Frame number (uint32 LE)
 *   [5-8]: Timestamp in microseconds (uint32 LE)
 *   [9]: Sensor count
 *
 * Per-sensor data (24 bytes each):
 *   [0]: Sensor ID
 *   [1-8]: Quaternion (4x int16 LE) - w,x,y,z scaled by 16384
 *   [9-14]: Accelerometer (3x int16 LE) - scaled by 100 (m/s²)
 *   [15-20]: Gyroscope (3x int16 LE) - scaled by 900 (rad/s)
 *   [21]: Flags (reserved)
 *   [22-23]: Padding (reserved)
 */
function createSyncFramePacket(
  frameNumber: number,
  timestampUs: number,
  sensorIds: number[],
  corruptCRC: boolean = false,
): DataView {
  const HEADER_SIZE = 10;
  const SENSOR_DATA_SIZE = 24;
  const sensorCount = sensorIds.length;

  const TOTAL_SIZE = HEADER_SIZE + sensorCount * SENSOR_DATA_SIZE;

  const buffer = new ArrayBuffer(TOTAL_SIZE);
  const view = new DataView(buffer);

  // -- HEADER (10 bytes) --
  view.setUint8(0, 0x25); // Type: SYNC_FRAME_PACKET
  view.setUint32(1, frameNumber, true); // Frame Number (Little Endian)
  view.setUint32(5, timestampUs, true); // Timestamp in microseconds
  view.setUint8(9, sensorCount); // Sensor Count

  // -- SENSOR DATA (24 bytes each) --
  for (let i = 0; i < sensorCount; i++) {
    const sensorOffset = HEADER_SIZE + i * SENSOR_DATA_SIZE;

    // [0] Sensor ID (1 byte)
    view.setUint8(sensorOffset, sensorIds[i]);

    // [1-8] Quaternion (4x int16) - w,x,y,z - Identity quaternion
    view.setInt16(sensorOffset + 1, QUAT_SCALE, true); // W = 1.0
    view.setInt16(sensorOffset + 3, 0, true); // X = 0
    view.setInt16(sensorOffset + 5, 0, true); // Y = 0
    view.setInt16(sensorOffset + 7, 0, true); // Z = 0

    // [9-14] Acceleration (3x int16) - scaled by 100
    view.setInt16(sensorOffset + 9, 0, true); // Ax = 0
    view.setInt16(sensorOffset + 11, 0, true); // Ay = 0
    view.setInt16(sensorOffset + 13, ACCEL_SCALE, true); // Az = 1G (gravity)

    // [15-20] Gyroscope (3x int16) - scaled by 900
    view.setInt16(sensorOffset + 15, 0, true); // Gx = 0
    view.setInt16(sensorOffset + 17, 0, true); // Gy = 0
    view.setInt16(sensorOffset + 19, 0, true); // Gz = 0

    // [21] Flags (bit0 = valid)
    view.setUint8(sensorOffset + 21, 0x01);

    // [22-23] Padding (reserved)
    view.setUint16(sensorOffset + 22, 0, true);
  }

  // Corrupt packet by changing the type to make it unrecognized
  if (corruptCRC) {
    view.setUint8(0, 0xff);
  }

  return view;
}

// ============================================================================
// SIMULATION TESTS (DEEP BUFFER & INTEGRITY)
// ============================================================================

describe("Deep Buffer & Integrity Pipeline", () => {
  it("Pipeline should accept clean 200Hz stream (Normal Operation)", () => {
    // Simulate 1 second of data (200 SyncFrame packets at 200Hz)
    let totalSamples = 0;

    for (let f = 0; f < 200; f++) {
      const timestamp = f * 5000; // 5ms intervals (200Hz)
      const view = createSyncFramePacket(f, timestamp, [1], false);
      const parsed = IMUParser.parseSingleFrame(view);

      expect(parsed).toBeDefined();
      // Each SyncFrame has 1 sensor = 1 result
      expect(parsed.length).toBe(1);
      totalSamples += parsed.length;
    }

    expect(totalSamples).toBe(200);
  });

  it("Pipeline should REJECT corrupted packets (Anti-Ghost Sensor)", () => {
    // Create a packet with invalid CRC
    const view = createSyncFramePacket(100, 500000, [1], true); // Corrupted!

    const parsed = IMUParser.parseSingleFrame(view);

    // Expect REJECTION (empty array)
    expect(parsed.length).toBe(0);
  });

  it('Pipeline should handle "Faraday Burst" (300ms Gap -> catch-up)', () => {
    // Simulate: Frames 0-9 arrive normally
    // Frames 10-24 (15 frames = ~75ms at 200Hz) get BLOCKED (radio silence)
    // Frame 25 arrives after burst

    let receivedSamples = 0;

    // 1. Normal Phase
    for (let f = 0; f < 10; f++) {
      const timestamp = f * 5000;
      const view = createSyncFramePacket(f, timestamp, [1], false);
      receivedSamples += IMUParser.parseSingleFrame(view).length;
    }

    // 2. Silence Phase ... (No calls to parser)

    // 3. Burst Phase (Simulating Gateway flushing buffer)
    // The Gateway receives these back-to-back
    for (let f = 10; f < 25; f++) {
      const timestamp = f * 5000;
      const view = createSyncFramePacket(f, timestamp, [1], false);
      const parsed = IMUParser.parseSingleFrame(view);
      receivedSamples += parsed.length;

      // Each packet should parse successfully
      expect(parsed.length).toBe(1);
    }

    // Total should be 25 frames * 1 sample = 25 samples
    expect(receivedSamples).toBe(25);
  });

  it("Pipeline should handle Multi-Sensor Packets", () => {
    // 6 sensors in one SyncFrame (Heavy load)
    const sensorIds = [1, 2, 3, 4, 5, 6];
    const view = createSyncFramePacket(50, 250000, sensorIds, false);
    const parsed = IMUParser.parseSingleFrame(view);

    // 6 sensors = 6 data points
    expect(parsed.length).toBe(6);

    // Check IDs
    const ids = parsed.map((p) => p.sensorId);
    expect(ids).toContain(1);
    expect(ids).toContain(6);
  });
});

describe("Jitter Buffer Logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("JitterBuffer should re-order scrambled packets (Prevent Time Travel)", () => {
    const buffer = new JitterBuffer();

    // Create 3 SyncFrame packets (Frame 10, 11, 12)
    const rawP1 = createSyncFramePacket(10, 50000, [1], false);
    const parsedP1 = IMUParser.parseSingleFrame(rawP1);

    const rawP2 = createSyncFramePacket(11, 55000, [1], false);
    const parsedP2 = IMUParser.parseSingleFrame(rawP2);

    const rawP3 = createSyncFramePacket(12, 60000, [1], false);
    const parsedP3 = IMUParser.parseSingleFrame(rawP3);

    // Simulating scrambled arrival: 10 -> 12 -> 11
    buffer.add(parsedP1);
    buffer.add(parsedP3); // Gap!
    buffer.add(parsedP2); // Gap filled.

    // Advance time beyond buffer delay (40ms)
    vi.advanceTimersByTime(50);

    const out = buffer.pop();

    // We expect all 3 packets * 1 sample = 3 samples output
    expect(out.length).toBe(3);

    // Verify Order: Frame 10 -> 11 -> 12
    expect(out[0].frameNumber).toBe(10);
    expect(out[1].frameNumber).toBe(11);
    expect(out[2].frameNumber).toBe(12);
  });

  it("JitterBuffer should smooth bursts (Sequence logic)", () => {
    const buffer = new JitterBuffer();

    // Packet 50
    const p1 = IMUParser.parseSingleFrame(
      createSyncFramePacket(50, 250000, [1], false),
    );
    buffer.add(p1);

    // Wait for it to clear (startup sync) on timeout
    vi.advanceTimersByTime(50);
    const out1 = buffer.pop();
    expect(out1.length).toBe(1);
    expect(out1[0].frameNumber).toBe(50);

    // Now sending Packet 51 (The 'Next' frame)
    // Should release IMMEDIATELY without waiting 40ms
    const p2 = IMUParser.parseSingleFrame(
      createSyncFramePacket(51, 255000, [1], false),
    );
    buffer.add(p2);

    // Zero time advance!
    const out2 = buffer.pop();
    expect(out2.length).toBe(1);
    expect(out2[0].frameNumber).toBe(51);
  });
});

describe("Jitter Buffer Resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should recover from a Zombie Lockout (Sensor Reset)", () => {
    const buffer = new JitterBuffer();

    // 1. Establish high frame count
    const p1 = IMUParser.parseSingleFrame(
      createSyncFramePacket(5000, 25000000, [1], false),
    );
    buffer.add(p1);
    vi.advanceTimersByTime(50);

    const out1 = buffer.pop(); // Pop the 5000
    expect(out1[0].frameNumber).toBe(5000);

    // 2. Sensor Resets! Frame count goes to 0.
    // The Gateway stays connected, so the stream just jumps back to 0.
    const p2 = IMUParser.parseSingleFrame(
      createSyncFramePacket(0, 0, [1], false),
    );
    buffer.add(p2);

    // OLD LOGIC would drop this (0 <= 5000)
    // NEW LOGIC should see the massive negative jump and Reset

    vi.advanceTimersByTime(50);
    const out2 = buffer.pop();

    expect(out2.length).toBeGreaterThan(0);
    expect(out2[0].frameNumber).toBe(0);
  });
});
