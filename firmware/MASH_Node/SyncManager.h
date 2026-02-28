#ifndef SYNC_MANAGER_H
#define SYNC_MANAGER_H

#include "../libraries/IMUConnectCore/src/TDMAProtocol.h"
#include "Config.h"
#include <Arduino.h>
#include <WiFi.h>
#include <esp_idf_version.h>
#include <esp_now.h>
#include <freertos/semphr.h>
#include <functional>

enum SyncRole
{
  SYNC_ROLE_AUTO,   // Default: Will listen, can become master if forced
  SYNC_ROLE_MASTER, // Forces this device to be the time source
  SYNC_ROLE_SLAVE   // Forces this device to listen
};

enum BufferPolicy
{
  POLICY_RECORDING, // Drop NEWEST samples when buffer full (Prioritize
                    // history/completeness)
  POLICY_LIVE       // Drop OLDEST samples when buffer full (Prioritize
                    // latency/freshness)
};

// ============================================================================
// SYNC QUALITY LEVELS (Research-Grade Data Gating)
// ============================================================================
// Used to tag each sample with confidence level and gate transmission
// ============================================================================
enum SyncQuality : uint8_t
{
  SYNC_QUALITY_NONE = 0,     // No beacons received or >100ms stale
  SYNC_QUALITY_POOR = 1,     // Beacon >40ms old (2 missed) - DON'T USE FOR RESEARCH
  SYNC_QUALITY_OK = 2,       // Beacon <40ms old, some uncertainty
  SYNC_QUALITY_GOOD = 4,     // Beacon <20ms old, consecutive beacons received
  SYNC_QUALITY_EXCELLENT = 7 // Beacon <10ms old, stable offset
};

struct SyncPacket
{
  uint32_t masterTime; // The micros() of the master when sent (microseconds)
  uint8_t packetType;  // 0x01 = Time Sync
};

// Forward declarations
class SensorManager;
class OTAManager;
class PowerStateManager;

// Callback type for receiving IMU data (Gateway mode)
typedef std::function<void(const ESPNowDataPacket &packet)> DataRecvCallback;

// Callback type for OTA ACK response (Node -> Gateway)
typedef std::function<void(const ESPNowOTAAckPacket &ack)> OTAAckCallback;

// ============================================================================
// TDMA Sample Buffer (for batching samples before transmission)
// ============================================================================
#define TDMA_BUFFER_CAPACITY \
  60 // Buffering up to ~300ms of data (60 samples @ 200Hz)

// ============================================================================
// TDMA Frame Queue (Deterministic 200Hz Output)
// ============================================================================
// The previous implementation buffered a linear stream of samples and would
// transmit whatever was available when the node entered its slot.
//
// If a node's slot is early in the 20ms frame, only 0-3 new samples may have
// arrived since the last transmission, producing 3-sample packets and an
// effective rate of ~166-177Hz.
//
// Best practice for TDMA batching: send COMPLETE 4-sample frames with
// correct timestamps, allowing up to 1-frame (20ms) latency.
//
// This queue stores per-frame samples keyed by Gateway frameNumber and only
// transmits frames that have all 4 sample indices (0..3) present.
// ============================================================================
#define TDMA_FRAME_QUEUE_CAPACITY 16 // 16 frames × 20ms = 320ms of buffering

struct TDMAFrameBufferEntry
{
  uint32_t frameNumber; // Gateway beacon frame number these samples belong to
  uint8_t sensorCount;  // Sensors per sample
  uint8_t presentMask;  // Bit i set => sample index i present
  TDMABatchedSensorData samples[TDMA_SAMPLES_PER_FRAME][MAX_SENSORS];
};

struct TDMASampleBuffer
{
  TDMABatchedSensorData samples[TDMA_BUFFER_CAPACITY][MAX_SENSORS];
  uint8_t sampleCount;  // Number of samples buffered (0-60)
  uint8_t sensorCount;  // Number of sensors per sample
  uint32_t frameNumber; // Frame these samples belong to
};

class SyncManager
{
public:
  SyncManager();

  void init(const char *deviceName);
  void update();

  // Returns local time adjusted to match master
  uint32_t getAdjustedTime();

  void setRole(SyncRole role);
  SyncRole getRole() const { return currentRole; }

  // Send Environmental data (Node mode)
  void sendEnviroData(SensorManager &sm);

  // Send Node Info / Topology (Node mode)
  void sendNodeInfo(SensorManager &sm, const char *name);

  // Send Magnetometer calibration progress (Node mode)
  void sendMagCalibProgress(SensorManager &sm);

  // Set callback for received data (Gateway mode)
  // Callback takes generic payload, len to support multiple types
  void setDataCallback(std::function<void(const uint8_t *data, int len)> cb)
  {
    onDataCallback = cb;
  }

  // Set OTA Manager for handling OTA packets (Node mode)
  void setOTAManager(OTAManager *mgr) { otaManager = mgr; }

  // Set unique node ID (derived from MAC at runtime)
  void setNodeId(uint8_t id) { nodeId = id; }
  uint8_t getNodeId() const { return nodeId; }

  // Set sensor count for TDMA registration (call during setup after sensors
  // enumerated)
  void setSensorCount(uint8_t count) { cachedSensorCount = count; }

  // Set Buffer Policy (Live vs Recording)
  void setBufferPolicy(BufferPolicy policy) { currentBufferPolicy = policy; }

  // Set power state manager for including power state in TDMA registration
  void setPowerStateManager(PowerStateManager *mgr) { powerStateManager = mgr; }

  // Set callback for radio mode changes (Node mode)
  // Called when Gateway sends RADIO_MODE_PACKET (0x06)
  void setRadioModeCallback(std::function<void(uint8_t mode)> cb)
  {
    onRadioModeCallback = cb;
  }

  // Set callback for mag calibration commands (Node mode)
  // Called when Gateway sends CMD_FORWARD_PACKET (0x08) for mag calibration
  void
  setMagCalibCallback(std::function<void(uint8_t cmdType, uint32_t param)> cb)
  {
    onMagCalibCallback = cb;
  }

  // Send OTA ACK back to Gateway
  void sendOTAAck(const ESPNowOTAAckPacket &ack);

  // Set callback for TDMA state changes (Node mode)
  // Used to enable/disable BLE based on sync status
  void setTDMAStateChangeCallback(std::function<void(TDMANodeState state)> cb)
  {
    onStateChangeCallback = cb;
  }

  // Called by ESP-NOW callback (includes sender MAC for auto-discovery)
  void onPacketReceived(const uint8_t *senderMac, const uint8_t *data, int len);

  // ============================================================================
  // TDMA Functions (Node Mode)
  // ============================================================================

  // Check if TDMA is synced and running (WITH GRACE PERIOD)
  // Now allows 30s recovery window for temporary sync loss
  bool isTDMASynced() const;

  // Check if Gateway is currently streaming (Warm Standby)
  bool isGatewayStreaming() const { return gatewayStreaming; }

  // Check sync health and trigger re-registration if needed
  void checkSyncHealth();

  // Full ESP-NOW re-initialization (used for Zombie recovery)
  void reinitEspNow();

  // Get TDMA node state for diagnostics
  TDMANodeState getTDMANodeState() const { return tdmaNodeState; }

  // Buffer a sample for TDMA batched transmission
  // Returns true if buffer is full and ready to transmit
  bool bufferSample(SensorManager &sm);

  // Send buffered samples in our assigned time slot
  void sendTDMAData();

  // Check if it's time to transmit (within our slot window)
  bool isInTransmitWindow() const;

  // Check if buffer has enough samples for transmission
  // ADAPTIVE BATCHING: Adjusts batch size based on sensor count to ensure
  // all packets fit within the TDMA transmit window.
  //
  // Problem: With 6+ sensors, we need 4 packets per frame (1 sample each).
  // ========================================================================
  // ESP-NOW v2.0 SIMPLIFICATION
  // ========================================================================
  // With v2.0's 1470-byte limit, ALL practical sensor configs fit in a
  // SINGLE packet with 4 samples. The complex per-sensor-count logic is
  // no longer needed!
  //
  // Example capacity with v2.0:
  // - 6 sensors: 600 bytes per frame << 1470 bytes (fits easily!)
  // - 9 sensors: 900 bytes per frame << 1470 bytes (still fits!)
  //
  // Wait for 4 samples (TDMA_SAMPLES_PER_FRAME) before sending.
  // With the overflow-preserving snapshot in sendTDMAData(), carryover
  // samples from the previous frame ensure this threshold is met promptly
  // when the transmit window opens (~1ms after beacon).
  // ========================================================================
  bool hasBufferedData() const
  {
    const uint8_t allMask =
        (TDMA_SAMPLES_PER_FRAME >= 8)
            ? 0xFF
            : (uint8_t)((1U << TDMA_SAMPLES_PER_FRAME) - 1U);
    if (frameQueueCount == 0)
      return false;
    for (uint8_t i = 0; i < frameQueueCount; i++)
    {
      uint8_t idx = (uint8_t)((frameQueueTail + i) % TDMA_FRAME_QUEUE_CAPACITY);
      if ((frameQueue[idx].presentMask & allMask) == allMask)
        return true;
    }
    return false;
  }

  // Get current frame number
  uint32_t getCurrentFrame() const { return currentFrameNumber; }

  // Get last known WiFi channel (for restoring after BLE events)
  uint8_t getLastKnownChannel() const { return lastKnownChannel; }

private:
  SyncRole currentRole;
  uint32_t timeOffset; // Add this to micros() to get adjusted time
  unsigned long lastSyncSend;
  std::function<void(const uint8_t *data, int len)> onDataCallback;
  std::function<void(uint8_t mode)> onRadioModeCallback;
  std::function<void(uint8_t cmdType, uint32_t param)> onMagCalibCallback;
  std::function<void(TDMANodeState state)> onStateChangeCallback;
  OTAManager *otaManager;
  uint8_t nodeId;            // Unique node ID from MAC address
  uint8_t cachedSensorCount; // Cached sensor count for TDMA registration
  PowerStateManager
      *powerStateManager; // For including power state in TDMA registration

  // ============================================================================
  // AUTO-DISCOVERED GATEWAY MAC ADDRESS
  // ============================================================================
  // Learned automatically from the first beacon received from Gateway.
  // No manual configuration required!
  uint8_t gatewayMac[6];     // Discovered Gateway MAC address
  bool gatewayMacDiscovered; // True once we've learned the Gateway's MAC
  // ============================================================================

  void sendSyncPulse();

  // ============================================================================
  // TDMA State (Node Mode)
  // ============================================================================
  TDMANodeState tdmaNodeState;
  uint32_t currentFrameNumber; // Last beacon frame number received
  uint32_t lastBeaconTime;     // micros() when last beacon received
  volatile uint32_t
      lastBeaconMillis;              // millis() when last beacon received (for timeout
                                     // check) — volatile for cross-core visibility
  uint16_t mySlotOffsetUs;           // Our assigned slot offset
  uint16_t mySlotWidthUs;            // Our assigned slot width
  uint32_t lastRegistrationTime;     // When we last sent registration
  uint32_t registeredStateStartTime; // When we entered REGISTERED state (for
                                     // timeout)
  // Deterministic per-frame queue (complete 4-sample frames)
  TDMAFrameBufferEntry frameQueue[TDMA_FRAME_QUEUE_CAPACITY];
  uint8_t frameQueueTail;  // Index of oldest frame
  uint8_t frameQueueCount; // Number of queued frames

  // Sync Recovery State Tracking
  uint8_t lastGatewayState; // Last beacon state (for detecting resets)
  uint32_t
      consecutiveBeaconLosses; // Count beacons missed (for timeout detection)
  uint32_t lastSyncCheckTime;  // When we last checked sync health

  // CRITICAL: Recovery mode to prevent immediate channel scanning
  bool inRecoveryMode;            // Are we actively trying to recover?
  uint32_t recoveryModeStartTime; // When recovery mode started
  uint8_t lastKnownChannel;       // Last channel where we heard beacons

  // ============================================================================
  // HARDWARE TSF TIMESTAMP SYSTEM (Research-Grade Sync)
  // ============================================================================
  // The WiFi TSF (Timing Synchronization Function) provides a hardware-level
  // timestamp that is more accurate than micros() due to less software jitter.
  //
  // Strategy:
  // 1. Gateway sends beacon with gatewayTsfUs (its TSF at send time)
  // 2. Node captures localTsfAtBeaconRx when beacon arrives
  // 3. Offset = gatewayTsfUs - localTsfAtBeaconRx
  // 4. For each sample: sampleTime = localTsf() + offset
  //
  // This provides continuous time correlation instead of discrete sample
  // counting.
  // ============================================================================
  uint64_t localTsfAtBeaconRx; // Node's TSF when beacon was received
  int64_t tsfOffset;           // Offset to convert local TSF to Gateway time
  bool tsfSyncValid;           // True once we have valid TSF sync
  bool gatewayStreaming;       // True if Gateway is currently streaming data

  // Legacy fallback (used if TSF unavailable)
  uint32_t beaconGatewayTimeUs; // Gateway's timestamp from last beacon
  uint8_t samplesSinceBeacon;   // Sample index within current frame (0-3)

  // Deterministic per-frame sample indexing (avoids races with beacon reset)
  uint32_t bufferedSampleFrameNumber;
  uint8_t nextSampleIndexInFrame;

  // Monotonic counter incremented on each received beacon
  uint32_t beaconSequence;
  uint32_t lastBufferedBeaconSequence;
  // ============================================================================

  // Smoothed time sync (exponential moving average for clock drift)
  int32_t smoothedOffset; // EMA of time offset
  static constexpr float OFFSET_SMOOTHING =
      0.1f; // EMA alpha (0.1 = 10% new, 90% old)

  // ============================================================================
  // PHASE 0: Two-Way Sync State (PTP-Lite v2) with Statistical Filtering
  // ============================================================================
  uint32_t delayReqSequence;   // Sequence number for DELAY_REQ packets
  uint32_t lastDelayReqTime;   // millis() when last DELAY_REQ sent
  uint64_t pendingT1;          // T1 timestamp from our last DELAY_REQ
  uint32_t pendingSequence;    // Sequence number we're waiting for
  bool awaitingDelayResp;      // True if waiting for DELAY_RESP
  int64_t twoWayOffset;        // Filtered offset from two-way sync (microseconds)
  uint32_t lastTwoWaySyncTime; // millis() of last successful two-way sync
  uint16_t lastRttUs;          // Last measured RTT (for diagnostics)
  uint8_t syncProtocolVersion; // Protocol version from beacon (1=legacy, 2=PTP)

  // Statistical filtering for improved accuracy
  static constexpr int OFFSET_SAMPLE_COUNT =
      5; // Number of samples for median filter
  int64_t
      offsetSamples[OFFSET_SAMPLE_COUNT];   // Circular buffer of recent offsets
  uint16_t rttSamples[OFFSET_SAMPLE_COUNT]; // Corresponding RTT values
  uint8_t offsetSampleIndex;                // Current index in circular buffer
  uint8_t validSampleCount;                 // Number of valid samples collected
  uint16_t avgRttUs;                        // Running average RTT for quality check
  // ============================================================================

  // Channel scanning (for finding Gateway's WiFi channel)
  uint32_t channelScanStart;  // When we started scanning current channel
  uint8_t currentScanChannel; // Index into scan channel list

  // ============================================================================
  // ESP-NOW TX Pacing State (STABILITY FIX)
  // ============================================================================
  // ESP-IDF recommends waiting for send callback before sending next packet
  // This prevents callback disorder and intermittent congestion
  // ============================================================================
  volatile bool txPending;          // True if waiting for send callback
  uint32_t sendFailCount;           // Total number of send failures
  uint32_t consecutiveSendFailures; // Consecutive failures for Zombie detection
  BufferPolicy currentBufferPolicy; // Policy for handling buffer overflows

  // ============================================================================
  // PHASE 4: Node-Side Delta Compression State
  // ============================================================================
  TDMABatchedSensorData
      prevSample[MAX_SENSORS]; // Previous sample for delta calculation
  bool prevSampleValid;        // True after first transmission (keyframe sent)
  uint32_t deltaOverflowCount; // Track delta overflow occurrences
  // ============================================================================

  // ============================================================================
  // PIPELINED PACKET BUILDING (Parallelization Optimization)
  // ============================================================================
  // Double-buffer system: Build next packet while current is transmitting.
  // This saves ~300µs per frame by overlapping packet construction with TX.
  //
  // How it works:
  // 1. When sendTDMAData() is called, it checks if pre-built packet exists
  // 2. If yes, send it immediately (no build delay)
  // 3. If more samples in buffer, pre-build next packet before returning
  // 4. The pre-built packet is stored in pipelinePacket/pipelinePacketSize
  // ============================================================================
  uint8_t pipelinePacket[ESPNOW_MAX_PAYLOAD]; // Pre-built packet buffer
  size_t pipelinePacketSize;                  // Size of pre-built packet (0 = no packet)
  uint8_t pipelineSamplesConsumed;            // Samples used in pre-built packet
  bool pipelinePacketReady;                   // True if packet is ready to send
  // ============================================================================

  // ============================================================================
  // FreeRTOS MUTEX: Protects sampleBuffer + pipeline state
  // ============================================================================
  // bufferSample() runs on Core 1 (loop), sendTDMAData() runs on Core 0
  // (ProtocolTask). Without mutex, concurrent access corrupts packet data.
  // ============================================================================
  SemaphoreHandle_t bufferMutex;

  // ============================================================================
  // SPINLOCK: Protects sync state variables shared between handleBeacon()
  // (Core 0 / WiFi task) and bufferSample() (Core 1 / main loop).
  // Covers: currentFrameNumber, beaconGatewayTimeUs, lastBeaconTime,
  //         samplesSinceBeacon
  // ============================================================================
  portMUX_TYPE syncStateLock = portMUX_INITIALIZER_UNLOCKED;

  // ============================================================================
  // DEFERRED OPERATIONS: Flags set in ESP-NOW callback, handled in update()
  // ============================================================================
  // ESP-NOW callbacks run in WiFi task context. delay(), NVS writes, and
  // ESP.restart() must NOT be called there — they block the WiFi stack.
  // ============================================================================
  volatile bool pendingReboot;          // Set true to request reboot from update()
  volatile uint8_t pendingRebootNodeId; // Node ID to save before rebooting
  volatile bool
      pendingReRegistration; // Set true to request re-registration with jitter
  volatile bool
      pendingDelayReq; // INT_WDT FIX v7: Defer PTP send from WiFi callback
  // ============================================================================

  // Static callback for esp_now_register_send_cb
#if ESP_IDF_VERSION_MAJOR >= 5
  static void onEspNowSent(const wifi_tx_info_t *tx_info,
                           esp_now_send_status_t status);
#else
  static void onEspNowSent(const uint8_t *mac, esp_now_send_status_t status);
#endif

  // ============================================================================
  // TDMA Helper Functions
  // ============================================================================
  void handleTDMABeacon(const uint8_t *data, int len);
  void handleTDMASchedule(const uint8_t *data, int len);
  void sendTDMARegistration();

  // ============================================================================
  // PHASE 0: Two-Way Sync Functions (PTP-Lite v2)
  // ============================================================================
  void sendDelayReq(); // Send DELAY_REQ to Gateway
  void handleDelayResp(const uint8_t *data,
                       int len); // Handle DELAY_RESP from Gateway

public:
  // Sync quality accessors for Phase 3 (webapp integration)
  int64_t getTwoWayOffset() const { return twoWayOffset; }
  uint16_t getLastRttUs() const { return lastRttUs; }
  uint32_t getTimeSinceLastSync() const
  {
    return millis() - lastTwoWaySyncTime;
  }
  bool isTwoWaySyncActive() const
  {
    return syncProtocolVersion >= SYNC_PROTOCOL_VERSION_PTP_V2;
  }
};

extern SyncManager syncManager;

// ============================================================================
// Shared helper functions (used across SyncManager translation units)
// ============================================================================

// Pin ESP-NOW unicast peer to 802.11g 6 Mbps OFDM for deterministic TDMA slots
void pinEspNowPhyRate(const uint8_t *peerMac);

// Build a TDMA data packet from buffered frame samples (keyframe-only)
size_t buildTDMAPacket(uint8_t *packet,
                       const TDMABatchedSensorData (*frameSamples)[MAX_SENSORS],
                       uint8_t frameSampleCount, uint8_t sensorCount,
                       uint32_t frameNumber, TDMABatchedSensorData *prevSample,
                       bool &prevSampleValid, uint32_t &deltaOverflowCount,
                       uint8_t nodeId, uint8_t syncProtocolVersion,
                       uint16_t lastRttUs, uint32_t timeSinceLastSync,
                       bool twoWaySyncActive, uint8_t &samplesConsumed);

#endif // SYNC_MANAGER_H
