/*******************************************************************************
 * TDMAProtocol.h - Time Division Multiple Access Protocol Definitions
 *
 * Part of IMUConnectCore library - shared between Gateway and Node firmware.
 * Implements industry-standard synchronized wireless transmission.
 *
 * ============================================================================
 * ARCHITECTURE: 200Hz SAMPLING, 50Hz TRANSMISSION (ESP-NOW v2.0)
 * ============================================================================
 *
 * ESP-NOW v2.0 (Arduino-ESP32 v3.x / ESP-IDF v5.5+) supports 1470-byte packets!
 * This eliminates all multi-packet complexity - ALL sensor configs fit in ONE
 * packet.
 *
 *   - Sample Rate:  200Hz (5ms between samples)
 *   - Beacon Rate:   50Hz (20ms between frames)
 *   - Batch Size:    4 samples per TDMA frame
 *   - Packet:        ALWAYS 1 packet per node per frame (v2.0 simplification!)
 *
 * ============================================================================
 * PACKET SIZE (ESP-NOW v2.0 - 1470 bytes max)
 * ============================================================================
 *
 * Packet Structure:
 *   - Header (TDMADataPacket): 8 bytes
 *   - Per sample per sensor (TDMABatchedSensorData): 25 bytes
 *   - Max payload for data: 1470 - 8 = 1462 bytes
 *
 * At 50Hz with 4 samples batched (ALL fit in single packet!):
 * | Sensors | Bytes/4-Sample | Fits in 1 Pkt? | Pkts/Frame | Notes          |
 * |---------|----------------|----------------|------------|----------------|
 * |    1    |     100        |     YES        |     1      | ✓ Single pkt   |
 * |    2    |     200        |     YES        |     1      | ✓ Single pkt   |
 * |    3    |     300        |     YES        |     1      | ✓ Single pkt   |
 * |    4    |     400        |     YES        |     1      | ✓ Single pkt   |
 * |    5    |     500        |     YES        |     1      | ✓ Single pkt   |
 * |    6    |     600        |     YES        |     1      | ✓ Single pkt   |
 * |    9    |     900        |     YES        |     1      | ✓ Single pkt   |
 * |   14    |    1400        |     YES        |     1      | ✓ Single pkt   |
 * |   58    |    1450        |     YES        |     1      | ✓ Max capacity |
 *
 * SIMPLIFIED: Every node sends exactly 1 packet per frame, regardless of
 * sensors.
 *
 ******************************************************************************/

#ifndef TDMA_PROTOCOL_H
#define TDMA_PROTOCOL_H

#include <Arduino.h>

// ============================================================================
// TDMA Timing Constants
// ============================================================================

// Frame rate: 50Hz (20ms per frame) - REDUCED from 200Hz for ESP-NOW stability
//
// WHY 50Hz INSTEAD OF 200Hz:
// - ESP-NOW has internal TX queue of ~20 packets
// - At 200Hz beacons, queue fills in ~100ms causing ESP_ERR_ESPNOW_NO_MEM
// - 50Hz gives 4x headroom and allows sample batching
//
// Sample rate remains 200Hz - we batch 4 samples per TDMA frame
#define TDMA_FRAME_PERIOD_MS 20
#define TDMA_FRAME_RATE_HZ 50

// Beacon transmission: Gateway sends at start of each frame
// OPTIMIZED: 12-byte packet takes <200us airtime. 500us is plenty of margin.
#define TDMA_BEACON_DURATION_US 500 // 0.5ms

// Safety gap between Beacon and First Slot to allow Gateway RX switching
// Critical for preventing collision where Node transmits while Gateway is
// finishing Beacon
#define TDMA_FIRST_SLOT_GAP_US 500

// ============================================================================
// SLOT TIMING — PIPELINED ARCHITECTURE
// ============================================================================
// SensorTask (Core 1) reads I2C and computes quaternions independently.
// ProtocolTask (Core 0) dequeues pre-buffered frames and transmits.
// Therefore TDMA slots only need to cover TRANSMISSION time:
//   packet build + ESP-NOW stack + RF airtime + safety margin.
//
// The slot width is computed dynamically by calculateSlotWidth(sensorCount)
// in the helper section below. No per-sensor or per-node constant is needed
// here — the formula derives slot width from first-principles RF timing.
// ============================================================================

// Minimum slot width — floor for any single ESP-NOW exchange.
// Covers: WiFi stack latency (~800µs) + smallest-packet airtime (~900µs)
//         + build/margin (~800µs).  Allows 5 single-sensor nodes comfortably.
#define TDMA_SLOT_MIN_WIDTH_US 2500 // 2.5ms min slot

// Inter-slot gap — radio turnaround between consecutive node slots.
// ESP32 WiFi radio turnaround is <50µs; 100µs provides safety.
#define TDMA_INTER_SLOT_GAP_US 100

// Guard time: Buffer at end of frame so last node's TX completes before
// the next beacon.  ESP-NOW is half-duplex — if a node is mid-TX when the
// gateway sends the beacon, both are lost.
#define TDMA_GUARD_TIME_US 2000 // 2ms guard time

// Maximum nodes supported
#define TDMA_MAX_NODES 8

// ============================================================================
// 200Hz OUTPUT ARCHITECTURE (20 sensors max @ 200Hz time-synced)
// ============================================================================
// Goal: 200 samples/second from EACH sensor, time-synced across all sensors
//
// Strategy: Oversample at sensor (375Hz), batch 4 samples per TDMA frame,
//           Gateway passes through without decimation → 200Hz to WebApp
//
// Bandwidth: 20 sensors × 200 Hz × 18 bytes (delta) = 72 KB/s << 100 KB/s limit
// ============================================================================
#define TDMA_INTERNAL_SAMPLE_RATE_HZ 200
#define TDMA_SAMPLES_PER_FRAME \
  (TDMA_INTERNAL_SAMPLE_RATE_HZ / TDMA_FRAME_RATE_HZ) // = 4 samples per frame

// Maximum total sensors across all nodes (for bandwidth planning)
#define TDMA_MAX_TOTAL_SENSORS 20

// ============================================================================
// ESP-NOW Packet Size Constraints (v2.0 - Arduino-ESP32 v3.x / ESP-IDF v5.5+)
// ============================================================================

// ESP-NOW v2.0 supports 1470 bytes! (vs 250 bytes in v1.0)
// This allows ALL practical sensor configurations to fit in a SINGLE packet.
// Requires Arduino-ESP32 v3.x board package (based on ESP-IDF v5.5+)
#define ESPNOW_MAX_PAYLOAD 1470 // ESP-NOW v2.0 maximum payload size
#define TDMA_DATA_HEADER_SIZE 8 // sizeof(TDMADataPacket) header portion
#define TDMA_SENSOR_DATA_SIZE \
  25                                                                     // sizeof(TDMABatchedSensorData) - includes 4-byte timestamp
#define TDMA_MAX_DATA_BYTES (ESPNOW_MAX_PAYLOAD - TDMA_DATA_HEADER_SIZE) // 1462

// Maximum supported sensors per node
// With v2.0: 1462 / 25 = 58 sensors per sample (theoretical max)
// Practical limit: 14 sensors × 4 samples = 1400 bytes (fits easily)
#define TDMA_MAX_SENSORS_PER_NODE 58

// ============================================================================
// TDMA Packet Types
// ============================================================================

#define TDMA_PACKET_BEACON 0x20   // Gateway → All Nodes
#define TDMA_PACKET_REGISTER 0x21 // Node → Gateway (discovery)
#define TDMA_PACKET_SCHEDULE 0x22 // Gateway → All Nodes (slot assignments)
#define TDMA_PACKET_DATA 0x23     // Node → Gateway (batched IMU data, absolute)
#define TDMA_PACKET_DATA_V3 0x24  // Gateway → WebApp (delta-compressed data)
#define TDMA_PACKET_ACK 0x25      // Gateway → Node (optional)
#define TDMA_PACKET_DATA_DELTA \
  0x26 // Node → Gateway (delta-compressed IMU data)

// ============================================================================
// TWO-WAY SYNC (PTP-Lite v2) - Research-Grade Time Synchronization
// ============================================================================
// Phase 0: TSF timestamps + RTT measurement for sub-100µs accuracy
// See docs/EXPERT_REVIEW_FINAL_SYNTHESIS.md for full protocol specification
// ============================================================================
#define TDMA_PACKET_DELAY_REQ 0x30   // Node → Gateway: Request RTT measurement
#define TDMA_PACKET_DELAY_RESP 0x31  // Gateway → Node: Response with timestamps
#define TDMA_PACKET_SYNC_STATUS 0x32 // Node → Gateway: Report sync quality

// ============================================================================
// BEACON FLAGS - Encoded in TDMABeaconPacket.flags
// ============================================================================
// Bit layout: [7:4]=TDMA state, [3]=SYNC_RESET, [2:0]=sync protocol version
//
// SYNC_RESET flag: When set, ALL nodes must reset their timing state:
//   - Clear lastBeaconTime = 0
//   - Clear beaconGatewayTimeUs = 0
//   - Clear twoWayOffset and PTP state
//   - Wait for fresh beacon before buffering samples
//
// This ensures clean sync when:
//   - Gateway restarts
//   - Web app connects
//   - Recording starts
//   - Calibration begins
// ============================================================================
#define SYNC_FLAG_RESET_MASK 0x08   // Bit 3: Force all nodes to reset sync state
#define SYNC_FLAG_STREAMING 0x80    // Bit 7: Gateway is currently streaming data
#define SYNC_FLAG_VERSION_MASK 0x07 // Bits 0-2: Sync protocol version
#define SYNC_FLAG_STATE_SHIFT 4     // Bits 4-7: TDMA state

// ============================================================================
// TDMA State Machine
// ============================================================================

enum TDMAState
{
  TDMA_STATE_IDLE,      // Not started
  TDMA_STATE_DISCOVERY, // Gateway collecting node registrations
  TDMA_STATE_SYNC,      // Gateway broadcasting schedule
  TDMA_STATE_RUNNING    // Normal operation
};

enum TDMANodeState
{
  TDMA_NODE_UNREGISTERED, // Waiting to register
  TDMA_NODE_REGISTERED,   // Received acknowledgment
  TDMA_NODE_SYNCED        // Has slot assignment, ready to transmit
};

// ============================================================================
// Packet Structures
// ============================================================================

// Beacon Packet (Gateway → All Nodes, broadcast)
// Sent at T=0 of each frame
// UPGRADED: Now includes 64-bit TSF timestamp for hardware-level sync
struct __attribute__((packed)) TDMABeaconPacket
{
  uint8_t type;           // TDMA_PACKET_BEACON (0x20)
  uint32_t frameNumber;   // Monotonic frame counter
  uint32_t gatewayTimeUs; // Gateway micros() time (THE ANCHOR for all node
                          // timestamps)
  uint8_t nodeCount;      // Number of registered nodes
  uint8_t wifiChannel;    // WiFi channel (so nodes can sync)
  uint8_t
      flags; // Upper nibble: TDMA state, Lower nibble: sync protocol version
  // NEW: TSF timestamp for hardware-level synchronization (Phase 0)
  uint64_t gatewayTsfUs; // Gateway TSF timestamp (from esp_wifi_get_tsf_time)
  // PTP STAGGERING: Which node should perform PTP exchange this frame
  // This prevents multiple nodes doing PTP simultaneously, which can corrupt
  // timestamps. Value 0xFF means no node should do PTP this frame. Nodes should
  // only send DELAY_REQ when (ptpSlotNode == myNodeId) OR (ptpSlotNode == 0xFF
  // && initial calibration)
  uint8_t ptpSlotNode;
};

// Node Registration Packet (Node → Gateway)
// Sent during discovery phase
struct __attribute__((packed)) TDMARegisterPacket
{
  uint8_t type;        // TDMA_PACKET_REGISTER (0x21)
  uint8_t nodeId;      // Node's unique ID (from MAC)
  uint8_t sensorCount; // Number of sensors on this node
  uint8_t hasMag;      // Has magnetometer
  uint8_t hasBaro;     // Has barometer
  uint8_t powerState;  // Current power state (0=LOW, 1=MED, 2=FULL)
  uint8_t sampleRate;  // Current sample rate / 10 (e.g., 20 = 200Hz)
  char nodeName[16];   // Human-readable name
};

// Slot Schedule Packet (Gateway → All Nodes, broadcast)
// Sent after discovery, contains all slot assignments
struct __attribute__((packed)) TDMASchedulePacket
{
  uint8_t type;      // TDMA_PACKET_SCHEDULE (0x22)
  uint8_t nodeCount; // Total nodes in schedule
  uint8_t reserved;  // Padding
  struct
  {
    uint8_t nodeId;        // Node ID
    uint16_t slotOffsetUs; // Microseconds offset from beacon
    uint16_t slotWidthUs;  // Allowed transmission window
  } slots[TDMA_MAX_NODES];
};

// Batched Data Packet (Node → Gateway)
// Contains multiple samples per transmission with synchronized timestamps
struct __attribute__((packed)) TDMABatchedSensorData
{
  uint8_t sensorId;     // Sensor ID
  uint32_t timestampUs; // Synchronized timestamp in microseconds (Gateway time
                        // domain)
  int16_t q[4];         // Quaternion (w, x, y, z) scaled by 16384
  int16_t a[3];         // Accelerometer (x, y, z) in m/s^2 * 100
  int16_t g[3];         // Gyroscope (x, y, z) in rad/s * 900
};

struct __attribute__((packed)) TDMADataPacket
{
  uint8_t type;         // TDMA_PACKET_DATA (0x23)
  uint8_t nodeId;       // Sending node ID
  uint32_t frameNumber; // Must match beacon's frameNumber
  uint8_t sampleCount;  // Number of samples in batch (1-4)
  uint8_t sensorCount;  // Number of sensors per sample
  // Followed by: sampleCount * sensorCount * TDMABatchedSensorData
  // See header documentation for packet size limits per sensor count
};

// ============================================================================
// TWO-WAY SYNC PACKETS (PTP-Lite v2 Protocol)
// ============================================================================
// Implements research-grade time synchronization using RTT measurement
// and Kalman filtering for offset + drift estimation.
//
// Protocol flow:
// 1. Node sends DELAY_REQ with T1 (local TSF)
// 2. Gateway records T2 (TSF on receive), T3 (TSF on send)
// 3. Gateway responds with DELAY_RESP containing T1, T2, T3
// 4. Node records T4 (TSF on receive)
// 5. Node computes: offset = ((T2-T1) + (T3-T4)) / 2
//                   RTT = (T4-T1) - (T3-T2)
// ============================================================================

// DELAY_REQ Packet (Node → Gateway)
// Sent periodically to measure RTT and refine sync
struct __attribute__((packed)) TDMADelayReqPacket
{
  uint8_t type;         // TDMA_PACKET_DELAY_REQ (0x30)
  uint8_t nodeId;       // Node's unique ID
  uint32_t sequenceNum; // For matching request/response pairs
  uint64_t nodeT1Tsf;   // T1: Node's TSF timestamp when sending
};

// DELAY_RESP Packet (Gateway → Node)
// Response to DELAY_REQ with all timestamps needed for offset calculation
struct __attribute__((packed)) TDMADelayRespPacket
{
  uint8_t type;          // TDMA_PACKET_DELAY_RESP (0x31)
  uint8_t nodeId;        // Target node ID
  uint32_t sequenceNum;  // Echo of request sequence number
  uint64_t nodeT1Tsf;    // Echo of T1 from request
  uint64_t gatewayT2Tsf; // T2: Gateway's TSF when DELAY_REQ received
  uint64_t gatewayT3Tsf; // T3: Gateway's TSF when sending this response
};

// ============================================================================
// SYNC QUALITY METADATA (Phase 3: Webapp Integration)
// ============================================================================
// Embedded in data packets to provide per-sample sync confidence
// Allows webapp to filter/flag data based on sync quality
// ============================================================================

// Sync confidence levels (matches webapp display)
enum SyncConfidence : uint8_t
{
  SYNC_CONF_UNCERTAIN = 0, // No recent sync, high uncertainty (>5ms)
  SYNC_CONF_LOW = 1,       // Sync aging, moderate uncertainty (1-5ms)
  SYNC_CONF_MEDIUM = 2,    // Normal operation, good sync (<1ms)
  SYNC_CONF_HIGH = 3       // Excellent sync, recent RTT measurement (<500µs)
};

// Sync quality flags - appended to TDMADataPacket when sync protocol v2 active
struct __attribute__((packed)) SyncQualityFlags
{
  uint16_t offsetUncertaintyUs;  // 1-sigma uncertainty estimate (0-65535 µs)
  int16_t driftPpmX10;           // Estimated drift rate × 10 (e.g., 200 = 20.0 ppm)
  uint16_t lastSyncAgeMs;        // Time since last two-way sync (0-65535 ms)
  uint8_t confidence : 2;        // SyncConfidence enum (0-3)
  uint8_t kalmanInitialized : 1; // Is Kalman filter converged?
  uint8_t outlierRejected : 1;   // Was last RTT measurement rejected as outlier?
  uint8_t reserved : 4;          // Reserved for future use
};

// Extended data packet with sync quality (optional, when syncProtocolVersion >=
// 2)
struct __attribute__((packed)) TDMADataPacketV2
{
  uint8_t type;                 // TDMA_PACKET_DATA (0x23)
  uint8_t nodeId;               // Sending node ID
  uint32_t frameNumber;         // Must match beacon's frameNumber
  uint8_t sampleCount;          // Number of samples in batch (1-4)
  uint8_t sensorCount;          // Number of sensors per sample
  SyncQualityFlags syncQuality; // Sync quality metadata (7 bytes)
  // Followed by: sampleCount * sensorCount * TDMABatchedSensorData
};

// ============================================================================
// TDMA DATA PACKET V3 - Delta Compression Format (Phase 3 Optimization)
// ============================================================================
// V3 introduces keyframe + delta architecture for ~35% bandwidth reduction.
// - First sample per packet is always absolute (keyframe)
// - Subsequent samples can be delta-encoded if deltas fit in int8
// - Self-describing flags allow mixed absolute/delta within same packet
// - Backwards compatible: WebApp can detect via type byte (0x24)
// ============================================================================

// V3 Packet Flags byte breakdown:
// Bit 0:   hasEnviro - Environmental data appended after IMU samples
// Bit 1:   hasDelta - Packet contains delta-encoded samples (after keyframe)
// Bit 2-3: compressionMode - 0=none, 1=delta-quat-only, 2=delta-full
// Bit 4-5: syncConfidence - Mirrors SyncConfidence enum (0-3)
// Bit 6:   keyframeOnly - All samples are absolute (delta overflow fallback)
// Bit 7:   reserved
#define V3_FLAG_HAS_ENVIRO 0x01
#define V3_FLAG_HAS_DELTA 0x02
#define V3_FLAG_COMP_MASK 0x0C // Bits 2-3
#define V3_FLAG_COMP_SHIFT 2
#define V3_FLAG_SYNC_MASK 0x30 // Bits 4-5
#define V3_FLAG_SYNC_SHIFT 4
#define V3_FLAG_KEYFRAME_ONLY 0x40

// Delta-compressed sensor data (16 bytes vs 25 for absolute)
// Used for samples 1+ when deltas fit in int8 range
struct __attribute__((packed)) TDMADeltaSensorData
{
  uint8_t sensorId;          // 1 byte - Sensor identifier
  uint16_t timestampDeltaUs; // 2 bytes - Delta from previous sample (max 65ms)
  int8_t dq[4];              // 4 bytes - Quaternion delta (scaled by 16384, ±0.0078)
  int16_t a[3];              // 6 bytes - Accel ABSOLUTE (impacts need full precision)
  int8_t dg[3];              // 3 bytes - Gyro delta (scaled by 900, ±0.14 rad/s)
};

// V3 packet header (14 bytes vs 8 for V1, 15 for V2)
struct __attribute__((packed)) TDMADataPacketV3
{
  uint8_t type;         // TDMA_PACKET_DATA_V3 (0x24)
  uint8_t nodeId;       // Source node ID
  uint32_t frameNumber; // TDMA frame number for ordering
  uint8_t flags;        // V3_FLAG_* bitfield
  uint8_t sampleCount;  // Total samples (1-4)
  uint8_t sensorCount;  // Sensors per sample (1-8)
  // Sync quality (always present in V3, 5 bytes)
  uint16_t offsetUncertaintyUs; // Sync uncertainty
  uint16_t syncAgeMs;           // Time since last PTP exchange
  uint8_t driftPpmDiv10;        // Drift in PPM / 10 (0-255 = 0-25.5 PPM)
  // Payload follows: see below for format based on flags
  //
  // If keyframeOnly (bit 6 set):
  //   [TDMABatchedSensorData × sampleCount × sensorCount]  (25 bytes each)
  //
  // If hasDelta (bit 1 set):
  //   Sample 0: [TDMABatchedSensorData × sensorCount]      (keyframe, 25 bytes
  //   each) Sample 1+: [TDMADeltaSensorData × sensorCount]       (delta, 16
  //   bytes each)
  //
  // If hasEnviro (bit 0 set):
  //   [EnvironmentalData] appended at end (before CRC)
  //
  // [CRC8] - always last byte
};

// Size constants for V3
#define TDMA_V3_HEADER_SIZE 14
#define TDMA_DELTA_SENSOR_SIZE 16
#define TDMA_ABSOLUTE_SENSOR_SIZE 25

// ============================================================================
// NODE-SIDE DELTA COMPRESSION (0x26) - ESP-NOW Traffic Reduction
// ============================================================================
// Same concept as V3 but for Node → Gateway traffic.
// - First sample in batch is always absolute (keyframe)
// - Samples 1-3 use delta encoding if deltas fit in int8
// - Reduces ESP-NOW bandwidth by ~35% (from 600 to ~390 bytes per frame)
// - Gateway reconstructs absolute values before forwarding to BLE
// ============================================================================

// Node delta packet flags (similar to V3 but simplified)
#define NODE_DELTA_FLAG_HAS_DELTA 0x01 // Bit 0: Contains delta samples
#define NODE_DELTA_FLAG_ALL_KEYFRAME \
  0x02                               // Bit 1: All samples are absolute (overflow fallback)
#define NODE_DELTA_FLAG_SYNC_V2 0x04 // Bit 2: Contains sync quality metadata

// Node-side delta packet header (10 bytes)
struct __attribute__((packed)) TDMANodeDeltaPacket
{
  uint8_t type;         // TDMA_PACKET_DATA_DELTA (0x26)
  uint8_t nodeId;       // Sending node ID
  uint32_t frameNumber; // Must match beacon's frameNumber
  uint8_t flags;        // NODE_DELTA_FLAG_* bitfield
  uint8_t sampleCount;  // Total samples (1-4)
  uint8_t sensorCount;  // Sensors per sample
  uint8_t reserved;     // Alignment padding
  // Payload format (based on flags):
  //
  // If ALL_KEYFRAME (overflow fallback):
  //   [TDMABatchedSensorData × sampleCount × sensorCount]  (25 bytes each)
  //
  // If HAS_DELTA (normal operation):
  //   Sample 0: [TDMABatchedSensorData × sensorCount]      (keyframe, 25 bytes
  //   each) Sample 1+: [TDMADeltaSensorData × sensorCount]       (delta, 16
  //   bytes each)
  //
  // Optional (if SYNC_V2): [SyncQualityFlags] (7 bytes) after sample data
  //
  // [CRC8] - always last byte
};

#define TDMA_NODE_DELTA_HEADER_SIZE 10

// Sync protocol version in beacon flags (lower 4 bits)
#define SYNC_PROTOCOL_VERSION_LEGACY 0x01 // One-way sync (original)
#define SYNC_PROTOCOL_VERSION_PTP_V2 0x02 // Two-way PTP-Lite with Kalman filter

// ============================================================================
// CRC8 Lookup Table and Functions
// ============================================================================
// CRC-8-CCITT polynomial 0x07: Used for corruption detection
// This is computed over the entire packet (header + data) and appended as the
// last byte before transmission. The receiver validates before parsing.

static const uint8_t CRC8_TABLE[256] = {
    0x00, 0x07, 0x0E, 0x09, 0x1C, 0x1B, 0x12, 0x15, 0x38, 0x3F, 0x36, 0x31,
    0x24, 0x23, 0x2A, 0x2D, 0x70, 0x77, 0x7E, 0x79, 0x6C, 0x6B, 0x62, 0x65,
    0x48, 0x4F, 0x46, 0x41, 0x54, 0x53, 0x5A, 0x5D, 0xE0, 0xE7, 0xEE, 0xE9,
    0xFC, 0xFB, 0xF2, 0xF5, 0xD8, 0xDF, 0xD6, 0xD1, 0xC4, 0xC3, 0xCA, 0xCD,
    0x90, 0x97, 0x9E, 0x99, 0x8C, 0x8B, 0x82, 0x85, 0xA8, 0xAF, 0xA6, 0xA1,
    0xB4, 0xB3, 0xBA, 0xBD, 0xC7, 0xC0, 0xC9, 0xCE, 0xDB, 0xDC, 0xD5, 0xD2,
    0xFF, 0xF8, 0xF1, 0xF6, 0xE3, 0xE4, 0xED, 0xEA, 0xB7, 0xB0, 0xB9, 0xBE,
    0xAB, 0xAC, 0xA5, 0xA2, 0x8F, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9D, 0x9A,
    0x27, 0x20, 0x29, 0x2E, 0x3B, 0x3C, 0x35, 0x32, 0x1F, 0x18, 0x11, 0x16,
    0x03, 0x04, 0x0D, 0x0A, 0x57, 0x50, 0x59, 0x5E, 0x4B, 0x4C, 0x45, 0x42,
    0x6F, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7D, 0x7A, 0x89, 0x8E, 0x87, 0x80,
    0x95, 0x92, 0x9B, 0x9C, 0xB1, 0xB6, 0xBF, 0xB8, 0xAD, 0xAA, 0xA3, 0xA4,
    0xF9, 0xFE, 0xF7, 0xF0, 0xE5, 0xE2, 0xEB, 0xEC, 0xC1, 0xC6, 0xCF, 0xC8,
    0xDD, 0xDA, 0xD3, 0xD4, 0x69, 0x6E, 0x67, 0x60, 0x75, 0x72, 0x7B, 0x7C,
    0x51, 0x56, 0x5F, 0x58, 0x4D, 0x4A, 0x43, 0x44, 0x19, 0x1E, 0x17, 0x10,
    0x05, 0x02, 0x0B, 0x0C, 0x21, 0x26, 0x2F, 0x28, 0x3D, 0x3A, 0x33, 0x34,
    0x4E, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5C, 0x5B, 0x76, 0x71, 0x78, 0x7F,
    0x6A, 0x6D, 0x64, 0x63, 0x3E, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2C, 0x2B,
    0x06, 0x01, 0x08, 0x0F, 0x1A, 0x1D, 0x14, 0x13, 0xAE, 0xA9, 0xA0, 0xA7,
    0xB2, 0xB5, 0xBC, 0xBB, 0x96, 0x91, 0x98, 0x9F, 0x8A, 0x8D, 0x84, 0x83,
    0xDE, 0xD9, 0xD0, 0xD7, 0xC2, 0xC5, 0xCC, 0xCB, 0xE6, 0xE1, 0xE8, 0xEF,
    0xFA, 0xFD, 0xF4, 0xF3};

// Calculate CRC8 over a buffer
inline uint8_t calculateCRC8(const uint8_t *data, size_t len)
{
  uint8_t crc = 0x00;
  for (size_t i = 0; i < len; i++)
  {
    crc = CRC8_TABLE[crc ^ data[i]];
  }
  return crc;
}

// Verify CRC8 (assumes CRC is last byte of packet)
// Returns true if CRC is valid
inline bool verifyCRC8(const uint8_t *packet, size_t totalLen)
{
  if (totalLen < 2)
    return false;
  uint8_t computed = calculateCRC8(packet, totalLen - 1);
  return computed == packet[totalLen - 1];
}

// ============================================================================
// Compile-Time Validation
// ============================================================================

// Verify TDMABatchedSensorData size matches our constant
static_assert(
    sizeof(TDMABatchedSensorData) == TDMA_SENSOR_DATA_SIZE,
    "TDMABatchedSensorData size mismatch - update TDMA_SENSOR_DATA_SIZE");

// Verify header size
static_assert(
    sizeof(TDMADataPacket) == TDMA_DATA_HEADER_SIZE,
    "TDMADataPacket header size mismatch - update TDMA_DATA_HEADER_SIZE");

// ============================================================================
// TDMA TIMING VALIDATION (Prevents Configuration Errors)
// ============================================================================

// CRITICAL: Slot width MUST fit within frame period!
// If this fails, slots are longer than the frame itself (impossible)
static_assert(TDMA_SLOT_MIN_WIDTH_US <= (TDMA_FRAME_PERIOD_MS * 1000),
              "ERROR: TDMA_SLOT_MIN_WIDTH_US exceeds frame period! "
              "At 200Hz (5ms frames), slot must be ≤5000us. "
              "Current value would cause scheduling failure.");

// Verify frame rate matches period
static_assert(TDMA_FRAME_RATE_HZ == (1000 / TDMA_FRAME_PERIOD_MS),
              "ERROR: TDMA_FRAME_RATE_HZ doesn't match TDMA_FRAME_PERIOD_MS! "
              "These must be inverse of each other.");

// Verify samples per frame calculation
static_assert(TDMA_SAMPLES_PER_FRAME ==
                  (TDMA_INTERNAL_SAMPLE_RATE_HZ / TDMA_FRAME_RATE_HZ),
              "ERROR: TDMA_SAMPLES_PER_FRAME calculation is incorrect! "
              "Should equal INTERNAL_SAMPLE_RATE / FRAME_RATE.");

// At 200Hz operation, samples per frame MUST be 1 (real-time, no batching)
static_assert(!(TDMA_FRAME_RATE_HZ == 200 && TDMA_SAMPLES_PER_FRAME != 1),
              "ERROR: At 200Hz frame rate, TDMA_SAMPLES_PER_FRAME must be 1! "
              "Check TDMA_INTERNAL_SAMPLE_RATE_HZ configuration.");

// Minimum frame timing check: beacon + guard must fit in frame
static_assert((TDMA_BEACON_DURATION_US + TDMA_GUARD_TIME_US) <
                  (TDMA_FRAME_PERIOD_MS * 1000),
              "ERROR: Beacon + Guard time exceed frame period! "
              "No time left for data transmission slots.");

// ============================================================================
// Helper Functions (Simplified for ESP-NOW v2.0)
// ============================================================================

// Calculate maximum samples per packet for a given sensor count
// With ESP-NOW v2.0 (1470 bytes), ALL configs fit 4 samples in one packet!
// Returns 0 if sensor count exceeds maximum supported
inline uint8_t calculateMaxSamplesPerPacket(uint8_t sensorCount)
{
  if (sensorCount == 0 || sensorCount > TDMA_MAX_SENSORS_PER_NODE)
  {
    return 0; // Invalid or unsupported sensor count
  }

  // With v2.0's 1462 data bytes, we can fit many samples:
  // Formula: 1462 / (sensorCount * 25)
  // Example: 6 sensors = 1462 / 150 = 9 samples (we only need 4!)
  uint8_t maxSamples =
      TDMA_MAX_DATA_BYTES / (sensorCount * TDMA_SENSOR_DATA_SIZE);

  // Clamp to frame size - we batch 4 samples per frame
  if (maxSamples > TDMA_SAMPLES_PER_FRAME)
  {
    maxSamples = TDMA_SAMPLES_PER_FRAME;
  }
  return maxSamples;
}

// Calculate number of packets needed per frame for a given sensor count
// With ESP-NOW v2.0: This is ALWAYS 1 for any practical config!
inline uint8_t calculatePacketsPerFrame(uint8_t sensorCount)
{
  uint8_t samplesPerPacket = calculateMaxSamplesPerPacket(sensorCount);
  if (samplesPerPacket == 0)
    return 0; // Unsupported

  // With v2.0, samplesPerPacket is always >= 4 for reasonable sensor counts
  // So this always returns 1
  return (TDMA_SAMPLES_PER_FRAME + samplesPerPacket - 1) / samplesPerPacket;
}

// ============================================================================
// calculateSlotWidth — Single source of truth for TDMA slot sizing.
// ============================================================================
// PIPELINED ARCHITECTURE: SensorTask (Core 1) reads I2C sensors and buffers
// complete 4-sample frames independently.  ProtocolTask (Core 0) dequeues
// the next ready frame, serialises it, and calls esp_now_send().
//
// The TDMA slot must be wide enough for the ENTIRE radio transaction to
// complete before the next node's slot begins (prevents collisions):
//
//   ┌─ Packet build ──┐  ┌── ESP-NOW stack ──┐  ┌─── RF transaction ───┐
//   │  memcpy + CRC    │  │ queue→WiFi driver  │  │ 802.11g OFDM frame  │
//   │  ~200µs          │  │ ~800µs             │  │ + SIFS + ACK         │
//   └──────────────────┘  └────────────────────┘  └──────────────────────┘
//   ┌── Safety margin ─┐
//   │ ISR / RTOS jitter │
//   │ ~500µs            │
//   └───────────────────┘
//
// Payload at 50Hz (4 samples batched):
//   Header(8) + 4 × sensors × 25 + CRC(1) bytes
//
// RF model — 802.11g OFDM @ 6 Mbps (pinned via esp_now_set_peer_rate_config):
//   PHY rate is explicitly pinned to 802.11g 6 Mbps on unicast peers.
//
//   OFDM preamble + PLCP header = 20µs
//   Data symbols  = 4µs × ceil((22 + 8 × (38 + payload)) / 24)
//     where 22 = SERVICE(16) + TAIL(6) bits, 38 = MAC(24) + vendor(10) + FCS(4)
//     and 24 = N_DBPS at 6 Mbps (BPSK R=1/2)
//   SIFS          = 10µs
//   ACK           = 20µs + 4µs × ceil((22 + 112) / 24) = 44µs
//
//   T_rf = 74 + 4 × ceil((326 + 8 × payload) / 24)  µs
// ============================================================================
inline uint16_t calculateSlotWidth(uint8_t sensorCount)
{
  if (sensorCount == 0)
    return TDMA_SLOT_MIN_WIDTH_US;

  // 1. Fixed per-slot software overhead:
  //    build (~200µs) + ESP-NOW stack (~800µs) + margin (~500µs)
  const uint32_t FIXED_OVERHEAD_US = 1500;

  // 2. RF airtime — 802.11g OFDM @ 6 Mbps
  uint32_t payloadBytes =
      TDMA_DATA_HEADER_SIZE +
      (TDMA_SAMPLES_PER_FRAME * sensorCount * TDMA_SENSOR_DATA_SIZE) + 1;

  //    OFDM symbol count: ceil((22 + 8×(38 + payload)) / 24)
  //    Numerator avoids float: (326 + 8*payload + 23) / 24   (integer ceil)
  uint32_t ofdmBits = 326 + 8 * payloadBytes; // SERVICE+TAIL + frame+payload bits
  uint32_t ofdmSyms = (ofdmBits + 23) / 24;   // ceil division by N_DBPS
  uint32_t dataFrameUs = 20 + 4 * ofdmSyms;   // preamble + data symbols
  uint32_t airtimeUs = dataFrameUs + 10 + 44; // + SIFS + ACK

  // 3. Total slot width
  uint32_t totalUs = FIXED_OVERHEAD_US + airtimeUs;

  // 4. Enforce minimum (WiFi stack jitter floor)
  if (totalUs < TDMA_SLOT_MIN_WIDTH_US)
  {
    return TDMA_SLOT_MIN_WIDTH_US;
  }

  // 5. Prevent uint16_t overflow (high sensor counts)
  if (totalUs > 0xFFFF)
  {
    return 0xFFFF;
  }

  return (uint16_t)totalUs;
}

// Calculate total frame time needed for all nodes
// With v2.0: Much simpler - each node gets one fixed-width slot
inline uint32_t calculateFrameTime(uint8_t nodeCount, uint8_t *sensorCounts)
{
  if (nodeCount == 0)
    return TDMA_BEACON_DURATION_US;

  // Calculate actual slot widths based on sensor counts
  uint32_t totalSlotTime = 0;

  for (uint8_t i = 0; i < nodeCount; i++)
  {
    uint8_t sensors = (sensorCounts != nullptr) ? sensorCounts[i] : 1;
    totalSlotTime += calculateSlotWidth(sensors);
  }

  // Total: beacon + first gap + slots + inter-slot gaps + guard time
  uint32_t frameTime =
      TDMA_BEACON_DURATION_US + TDMA_FIRST_SLOT_GAP_US + totalSlotTime +
      ((nodeCount > 1 ? nodeCount - 1 : 0) * TDMA_INTER_SLOT_GAP_US) +
      TDMA_GUARD_TIME_US;

  return frameTime;
}

#endif // TDMA_PROTOCOL_H
