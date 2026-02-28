/**
 * SyncFrameBuffer.h - Cross-Node Synchronized Frame Assembly
 *
 * PURPOSE:
 * Collects samples from multiple nodes and assembles them into "Sync Frames"
 * where ALL sensors have data with IDENTICAL timestamps.
 *
 * THE PROBLEM IT SOLVES:
 * Previously, each node sent its own packet, and the web app had to correlate
 * samples across packets by timestamp. This led to timing mismatches and
 * made it impossible to guarantee all sensors were truly synchronized.
 *
 * THE SOLUTION:
 * Gateway buffers incoming samples by timestamp. Only when ALL registered
 * sensors have data for a given timestamp does the Gateway emit a "Sync Frame".
 * This guarantees the web app receives properly synchronized multi-sensor data.
 *
 * NEW PACKET FORMAT (0x25 - SYNC_FRAME):
 * +----------+------------+------------+------------+
 * | Header   | Sensor 0   | Sensor 1   | ...        |
 * | 10 bytes | 24 bytes   | 24 bytes   | ...        |
 * +----------+------------+------------+------------+
 *
 * Header: type(1) + frameNum(4) + timestampUs(4) + sensorCount(1) = 10 bytes
 * Sensor: sensorId(1) + q[4](8) + a[3](6) + g[3](6) + flags(1) + reserved(2) = 24 bytes
 *
 * Max packet: 10 + (20 sensors × 24 bytes) = 490 bytes (fits in ESP-NOW v2)
 */

#ifndef SYNC_FRAME_BUFFER_H
#define SYNC_FRAME_BUFFER_H

#include <Arduino.h>
// portMUX_TYPE, heap_caps_malloc, MALLOC_CAP_SPIRAM are all
// available through the default Arduino-ESP32 includes

#define SYNC_FRAME_MAX_PACKET_SIZE 512
#include "../libraries/IMUConnectCore/src/TDMAProtocol.h"

// ============================================================================
// Configuration
// ============================================================================

// Maximum sensors we expect across all nodes
// Sized for 16-sensor goal (4 nodes × 4 sensors) with headroom for expansion.
// Memory: 20 sensors × 24 bytes × 64 slots = 30,720 bytes (fits in PSRAM).
// AUDIT FIX 2026-02-08: Increased from 8→20 to support 16-sensor target.
#define SYNC_MAX_SENSORS 20

// How many timestamp slots to buffer (circular buffer)
// At 200Hz with PSRAM, 64 slots = 320ms of buffering for excellent jitter tolerance.
// Previously 16 (80ms) when limited to internal SRAM.
#define SYNC_TIMESTAMP_SLOTS 64

// Maximum age of a timestamp slot before it's considered stale (ms)
// At 200Hz (5ms/frame), 55ms = 11 frame periods. This gives generous margin for
// ESP-NOW retransmissions (~1-3ms) and freewheel frame delivery (~20ms late)
// while still detecting truly stale slots promptly.
// HISTORY: 25ms → 35ms → 55ms
//   25ms: Too tight, premature partial frames from freewheeling nodes
//   35ms: Still caused ~20% frame loss (155-162Hz vs 200Hz target)
//   55ms: Allows 2 missed beacons (40ms) + jitter margin, with 64-slot
//         circular buffer providing 320ms of depth to absorb the latency.
// USB-only path (no BLE bottleneck) means this extra buffering doesn't
// add end-to-end latency — slots drain as fast as they complete.
#define SYNC_SLOT_TIMEOUT_MS 55

// ============================================================================
// TIMESTAMP TOLERANCE FOR CROSS-NODE SYNCHRONIZATION
// ============================================================================
// This defines how close two timestamps must be to be considered "the same"
// and placed in the same sync frame slot.
//
// RESEARCH-GRADE REQUIREMENTS (200Hz output):
// - Sample period: 5000µs (5ms)
// - Acceptable sync error: <10% of sample period = <500µs
// - With beacon-anchored timestamps, nodes should produce IDENTICAL timestamps
//   (0µs difference) but we allow tolerance for:
//   - ESP-NOW jitter in beacon delivery (~50-200µs)
//   - Interrupt latency differences (~10-50µs)
//   - Clock quantization effects
//
// With the ROUNDING fix on Node side, boundary aliasing is eliminated.
// All nodes within ±2.5ms of a sample boundary produce identical timestamps.
//
// 2500µs (half a sample period) tolerance handles:
// - ESP-NOW beacon delivery jitter (~200µs)
// - Interrupt latency variance (~50µs)
// - Minor crystal variance (< 100µs)
//
// This is tight enough to prevent matching adjacent frames while being
// robust to real-world timing variations.
// ============================================================================
#define SYNC_TIMESTAMP_TOLERANCE_US 2500

// ============================================================================
// Sync Frame Packet Format (0x25 - ABSOLUTE)
// ============================================================================
// Original format: 24 bytes per sensor, all values absolute
// Used for: Keyframes, first packet after connection, error recovery
// Max sensors @ 200Hz: ~13 (limited by BLE 65 KB/s)

#define SYNC_FRAME_PACKET_TYPE 0x25

// Per-sensor data in sync frame (24 bytes - fixed size for easy parsing)
struct __attribute__((packed)) SyncFrameSensorData
{
    uint8_t sensorId;    // Unique sensor ID (nodeId + localIndex)
    int16_t q[4];        // Quaternion (w, x, y, z) scaled by 16384
    int16_t a[3];        // Accelerometer (x, y, z) scaled by 100 (m/s²)
    int16_t g[3];        // Gyroscope (x, y, z) scaled by 900 (°/s)
    uint8_t flags;       // Bit 0: valid, Bit 1: interpolated, Bits 2-7: reserved
    uint8_t reserved[2]; // Padding to 24 bytes
};

// Sync Frame packet header
struct __attribute__((packed)) SyncFramePacket
{
    uint8_t type;         // 0x25 = SYNC_FRAME_PACKET_TYPE
    uint32_t frameNumber; // Monotonic frame counter
    uint32_t timestampUs; // Synchronized timestamp (beacon-derived)
    uint8_t sensorCount;  // Number of sensors in this frame
                          // Followed by sensorCount × SyncFrameSensorData
};

#define SYNC_FRAME_HEADER_SIZE sizeof(SyncFramePacket)
#define SYNC_FRAME_SENSOR_SIZE sizeof(SyncFrameSensorData)

// ============================================================================
// Compile-time verification of packed struct layout
// ============================================================================
// If these fail, the compiler is NOT respecting __attribute__((packed)) and
// the webapp parser will read corrupted sensorCount values at byte offset 9.
static_assert(sizeof(SyncFramePacket) == 10,
              "SyncFramePacket must be exactly 10 bytes (packed)!");
static_assert(sizeof(SyncFrameSensorData) == 24,
              "SyncFrameSensorData must be exactly 24 bytes (packed)!");
static_assert(offsetof(SyncFramePacket, type) == 0,
              "SyncFramePacket.type must be at offset 0!");
static_assert(offsetof(SyncFramePacket, frameNumber) == 1,
              "SyncFramePacket.frameNumber must be at offset 1!");
static_assert(offsetof(SyncFramePacket, timestampUs) == 5,
              "SyncFramePacket.timestampUs must be at offset 5!");
static_assert(offsetof(SyncFramePacket, sensorCount) == 9,
              "SyncFramePacket.sensorCount must be at offset 9!");

// Flags for SyncFrameSensorData
#define SYNC_SENSOR_FLAG_VALID 0x01
#define SYNC_SENSOR_FLAG_INTERPOLATED 0x02

// ============================================================================
// Internal Buffer Structures
// ============================================================================

// Single sensor's data at a specific timestamp
struct SyncSensorSample
{
    bool present; // Has this sensor reported for this timestamp?
    uint8_t sensorId;
    int16_t q[4];
    int16_t a[3];
    int16_t g[3];
};

// A timestamp slot - holds data from all sensors for one moment in time
struct SyncTimestampSlot
{
    bool active;                                // Is this slot in use?
    bool forceEmit;                             // Force emission even if incomplete (timeout)
    uint32_t timestampUs;                       // The synchronized timestamp
    uint32_t frameNumber;                       // Frame number from beacon
    uint32_t receivedAtMs;                      // When first sample arrived (for timeout)
    uint8_t sensorsPresent;                     // Count of sensors with data
    SyncSensorSample sensors[SYNC_MAX_SENSORS]; // Per-sensor data
};

// ============================================================================
// SyncFrameBuffer Class
// ============================================================================

class SyncFrameBuffer
{
public:
    SyncFrameBuffer();
    ~SyncFrameBuffer();

    /**
     * Initialize the buffer with expected sensor configuration
     * @param sensorIds Array of expected sensor IDs
     * @param count Number of sensors expected
     */
    void init(const uint8_t *sensorIds, uint8_t count);

    /**
     * Update expected sensors (called when nodes register/unregister)
     */
    void setExpectedSensors(const uint8_t *sensorIds, uint8_t count);

    /**
     * Add a sample from a node
     * @param sensorId Sensor ID (nodeId + localIndex)
     * @param timestampUs Synchronized timestamp
     * @param frameNumber Frame number from packet
     * @param q Quaternion data
     * @param a Accelerometer data
     * @param g Gyroscope data
     * @return true if sample was added, false if buffer full or invalid
     */
    bool addSample(
        uint8_t sensorId,
        uint32_t timestampUs,
        uint32_t frameNumber,
        const int16_t *q,
        const int16_t *a,
        const int16_t *g);

    /**
     * Check if a complete sync frame is ready
     * @return true if all expected sensors have data for at least one timestamp
     */
    bool hasCompleteFrame() const;

    /**
     * Build and retrieve a complete sync frame
     * @param outputBuffer Buffer to write the sync frame packet
     * @param maxLen Maximum output buffer size
     * @return Size of the packet written, or 0 if no complete frame
     */
    size_t getCompleteFrame(uint8_t *outputBuffer, size_t maxLen);

    /**
     * Periodic maintenance - expire stale slots, update stats
     * Call this from loop() at ~100Hz
     */
    void update();

    /**
     * Get diagnostic statistics
     */
    uint32_t getCompletedFrames() const { return completedFrameCount; }
    uint32_t getTrulyCompleteFrames() const { return trulyCompleteFrameCount; }
    uint32_t getPartialRecoveryFrames() const { return partialRecoveryFrameCount; }
    uint32_t getDroppedFrames() const { return droppedFrameCount; }
    uint32_t getIncompleteFrames() const { return incompleteFrameCount; }
    uint8_t getExpectedSensorCount() const { return expectedSensorCount; }
    uint8_t getEffectiveSensorCount() const { return effectiveSensorCount; }

    /**
     * Get true sync rate: percentage of frames with ALL sensors present
     * Returns 0.0 if no frames emitted yet
     */
    float getTrueSyncRate() const
    {
        uint32_t total = trulyCompleteFrameCount + partialRecoveryFrameCount;
        if (total == 0)
            return 0.0f;
        return (float)trulyCompleteFrameCount / (float)total * 100.0f;
    }

    /**
     * Allocate slot buffer in PSRAM (call once from setup).
     * If PSRAM is unavailable, falls back to internal heap.
     * @return true if allocation succeeded
     */
    bool allocateSlots();

    /**
     * Reset buffer state (e.g., on connection loss)
     */
    void reset();

    /**
     * Debug: Print buffer status
     */
    void printStatus() const;

private:
    // Expected sensor configuration
    uint8_t expectedSensorIds[SYNC_MAX_SENSORS];
    uint8_t expectedSensorCount;

    // ========================================================================
    // ACTIVE SENSOR TRACKING (388Hz fix)
    // ========================================================================
    // Tracks which sensors are actually reporting data so isSlotComplete()
    // can use the ACTIVE count instead of the REGISTERED count. Without this,
    // a registered-but-offline sensor (e.g., sensor 190) causes every frame
    // to wait for the 35ms forceEmit timeout, adding unnecessary latency.
    // ========================================================================
    volatile uint8_t effectiveSensorCount;                     // Active sensors (may be < expectedSensorCount)
    uint32_t sensorLastSeenMs[SYNC_MAX_SENSORS];               // Per-sensor last-seen timestamps
    static const uint32_t SENSOR_INACTIVE_THRESHOLD_MS = 2000; // 2s without data = inactive

    // ========================================================================
    // THREAD SAFETY: Spinlock for cross-task access
    // ========================================================================
    // addSample() is called from ESP-NOW callback (WiFi task, high priority)
    // hasCompleteFrame()/getCompleteFrame()/update() called from ProtocolTask
    // These can preempt each other on the same core. Spinlock prevents corruption.
    // ========================================================================
    mutable portMUX_TYPE _lock;

    // Circular buffer of timestamp slots (dynamically allocated in PSRAM)
    SyncTimestampSlot *slots; // Pointer to PSRAM-backed array
    bool slotsAllocated;      // Whether dynamic allocation succeeded
    uint8_t oldestSlotIndex;

    // Frame counter for output packets
    uint32_t outputFrameNumber;

    // Statistics
    uint32_t completedFrameCount;
    uint32_t trulyCompleteFrameCount;   // Frames with ALL sensors (no forceEmit)
    uint32_t partialRecoveryFrameCount; // Frames emitted via forceEmit (missing sensors)
    uint32_t droppedFrameCount;
    uint32_t incompleteFrameCount;
    uint32_t lastUpdateMs;

    // Find or create a slot for the given timestamp
    SyncTimestampSlot *findOrCreateSlot(uint32_t timestampUs, uint32_t frameNumber);

    // Find slot index for a sensor ID (-1 if not expected)
    int8_t getSensorIndex(uint8_t sensorId) const;

    // Check if a slot is complete (all sensors present)
    bool isSlotComplete(const SyncTimestampSlot &slot) const;

    // Expire old slots
    void expireStaleSlots();

    /**
     * Build an absolute 0x25 packet
     * @param slot The complete frame slot
     * @param outputBuffer Buffer to write packet
     * @param maxLen Maximum buffer size
     * @return Packet size, or 0 on error
     */
    size_t buildAbsoluteFrame(const SyncTimestampSlot &slot, uint8_t *outputBuffer, size_t maxLen);
};

#endif // SYNC_FRAME_BUFFER_H
