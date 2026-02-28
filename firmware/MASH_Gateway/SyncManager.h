#ifndef SYNC_MANAGER_H
#define SYNC_MANAGER_H

#include "../libraries/IMUConnectCore/src/TDMAProtocol.h"
#include "Config.h"
#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <functional>

enum SyncRole
{
  SYNC_ROLE_AUTO,   // Default: Will listen, can become master if forced
  SYNC_ROLE_MASTER, // Forces this device to be the time source
  SYNC_ROLE_SLAVE   // Forces this device to listen
};

struct SyncPacket
{
  uint32_t masterTime; // The micros() of the master when sent (microseconds)
  uint8_t packetType;  // 0x01 = Time Sync
};

// Forward declaration
class SensorManager;

// Callback type for receiving IMU data (Gateway mode)
typedef std::function<void(const ESPNowDataPacket &packet)> DataRecvCallback;

// Callback type for when a new node registers (Gateway mode)
typedef std::function<void(uint8_t nodeId, uint8_t sensorCount)>
    NodeRegisteredCallback;

// Callback type for when inactive nodes are pruned (Gateway mode)
// Called once per prune cycle if any nodes were removed
typedef std::function<void()> NodePrunedCallback;

// ============================================================================
// TDMA Node Registration Info (tracked by Gateway)
// ============================================================================
struct TDMANodeInfo
{
  uint8_t nodeId;        // Node's unique ID
  uint8_t sensorCount;   // Number of sensors on this node
  bool hasMag;           // Has magnetometer
  bool hasBaro;          // Has barometer
  char nodeName[16];     // Human-readable name
  uint16_t slotOffsetUs; // Assigned slot offset from beacon
  uint16_t slotWidthUs;  // Assigned slot width
  uint32_t lastHeard;    // millis() when last heard from
  bool registered;       // Is this slot active?
  uint8_t mac[6];        // MAC address for collision detection
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

  // Send IMU data (Node mode) - Packs data from SensorManager
  void sendIMUData(SensorManager &sm);

  // Send Environmental data (Node mode)
  void sendEnviroData(SensorManager &sm);

  // Send Node Info / Topology (Node mode)
  void sendNodeInfo(SensorManager &sm, const char *name);

  // Set callback for received data (Gateway mode)
  // Callback takes generic payload, len to support multiple types
  void setDataCallback(std::function<void(const uint8_t *data, int len)> cb)
  {
    onDataCallback = cb;
  }

  // Set callback for when a new node registers (Gateway mode)
  // This allows updating SyncFrameBuffer when nodes register during discovery
  void setNodeRegisteredCallback(NodeRegisteredCallback cb)
  {
    onNodeRegistered = cb;
  }

  // Set callback for when inactive nodes are pruned (Gateway mode)
  // This allows SyncFrameBuffer to shrink its expected sensor set
  void setNodePrunedCallback(NodePrunedCallback cb)
  {
    onNodePruned = cb;
  }

  // Broadcast radio mode command to all nodes (Gateway mode)
  // mode: RADIO_MODE_BLE_OFF (0x00) or RADIO_MODE_BLE_ON (0x01)
  void sendRadioModeCommand(uint8_t mode);

  // Broadcast mag calibration command to nodes (Gateway mode)
  void sendMagCalibCommand(uint8_t cmdType, uint32_t param,
                           uint8_t targetNode = 0xFF);

  // Send "Set ID" command to specific MAC (Collision Resolution)
  void sendSetNodeIdCommand(const uint8_t *targetMac, uint8_t newId);

  // Called by ESP-NOW callback
  void onPacketReceived(const uint8_t *senderMac, const uint8_t *data, int len);

  // ============================================================================
  // TDMA Functions (Gateway Mode)
  // ============================================================================

  // Start TDMA coordination
  void startTDMA();

  // Force a full re-scan: clears all registered nodes (ignoring NVS cache)
  // and restarts the discovery phase. Use for manual user-initiated re-scans.
  void restartDiscovery();

  // Check if TDMA is currently active (not IDLE)
  bool isTDMAActive() const { return tdmaState != TDMA_STATE_IDLE; }

  // Stop TDMA (reverts to legacy sync)
  void stopTDMA();

  // Check if TDMA is running
  bool isTDMARunning() const { return tdmaState == TDMA_STATE_RUNNING; }

  // Get number of registered nodes
  uint8_t getRegisteredNodeCount() const;

  // Get number of recently active nodes/sensors (faster operator feedback)
  uint8_t getActiveNodeCount(uint32_t activeThresholdMs = 3000) const;
  uint8_t getActiveSensorCount(uint32_t activeThresholdMs = 3000) const;

  // Update lastHeard time for a node (called when TDMA data received)
  void updateNodeLastHeard(uint8_t nodeId);
  void updateNodeLastHeardByMAC(const uint8_t *mac);

  // Get TDMA state for diagnostics
  TDMAState getTDMAState() const { return tdmaState; }

  // Force all nodes to reset their timing state (called when streaming starts)
  void triggerSyncReset();

  // ============================================================================
  // DISCOVERY LOCK — Late-Join Control
  // ============================================================================
  // When locked, new (unknown) nodes are queued in pendingNodes[] instead
  // of being auto-admitted. Known session nodes (temporary dropout/reconnect)
  // are auto-re-admitted silently.
  // ============================================================================
  void setDiscoveryLocked(bool locked);
  bool isDiscoveryLocked() const { return discoveryLocked; }

  // Pending node management
  struct PendingNode
  {
    uint8_t nodeId;
    uint8_t sensorCount;
    bool hasMag;
    bool hasBaro;
    char nodeName[16];
    uint8_t mac[6];
    uint32_t requestedAt; // millis() when first queued
    bool occupied;
  };
  static const uint8_t MAX_PENDING_NODES = 4;
  const PendingNode *getPendingNodes() const { return pendingNodes; }
  uint8_t getPendingNodeCount() const;
  bool acceptPendingNode(uint8_t nodeId);
  bool rejectPendingNode(uint8_t nodeId);

  // Callback for notifying webapp of pending nodes
  typedef std::function<void(const PendingNode &node)> NodePendingCallback;
  void setNodePendingCallback(NodePendingCallback cb) { onNodePending = cb; }

  // ============================================================================
  // OPP-8: Pre-registration Node Topology Persistence
  // ============================================================================
  // Save/load registered node topology to NVS so reconnecting nodes
  // skip full discovery on Gateway reboot
  void saveTopologyToNVS();
  void loadTopologyFromNVS();
  void clearPersistedTopology();
  uint8_t getPreRegisteredNodeCount() const { return preRegisteredNodeCount; }

  // ============================================================================
  // Sync Readiness Verification
  // ============================================================================
  // Expose node-level info and TDMA state for pre-streaming readiness checks
  const TDMANodeInfo *getRegisteredNodes() const { return registeredNodes; }
  uint8_t getMaxNodes() const { return TDMA_MAX_NODES; }
  const char *getTDMAStateName() const;

  // ============================================================================
  // SYNC FRAME SUPPORT - Get expected sensors for cross-node synchronization
  // ============================================================================
  // Returns total count of expected sensors across all registered nodes
  uint8_t getExpectedSensorCount() const;

  // Fill an array with expected sensor IDs (nodeId + localIndex for each
  // sensor) Returns actual count written
  uint8_t getExpectedSensorIds(uint8_t *sensorIds, uint8_t maxCount) const;

  // Map (nodeId, localSensorIndex) to a collision-safe gateway-local sensor ID
  // in the range 1..N across currently registered nodes.
  // Returns 0 if node/index is invalid.
  uint8_t getCompactSensorId(uint8_t nodeId, uint8_t localSensorIndex) const;

  // Get the current sync epoch (base timestamp for frame 0)
  // Used by SyncFrameBuffer to normalize timestamps from different nodes
  uint32_t getSyncEpoch() const { return syncEpochUs; }

  // Check if epoch has been initialized
  bool isEpochInitialized() const { return epochInitialized; }

  // Toggle the streaming flag in beacons (Warm Standby)
  void setStreaming(bool streaming) { isStreaming = streaming; }

  // Get the current authoritative frame number (for cross-node sync validation)
  uint32_t getCurrentFrameNumber() const { return tdmaFrameNumber; }
  // ============================================================================

private:
  SyncRole currentRole;
  uint32_t timeOffset; // Add this to millis() to get adjusted time
  unsigned long lastSyncSend;
  std::function<void(const uint8_t *data, int len)> onDataCallback;
  NodeRegisteredCallback onNodeRegistered; // Callback when node registers
  NodePrunedCallback onNodePruned;         // Callback when nodes pruned

  // Epoch tracking (moved from sendTDMABeacon for external access)
  uint32_t syncEpochUs;
  bool epochInitialized;
  bool isStreaming; // Warm Standby flag

  // ============================================================================
  // TDMA State (Gateway Mode)
  // ============================================================================
  TDMAState tdmaState;
  volatile uint32_t tdmaFrameNumber;          // Monotonic frame counter
  uint32_t lastBeaconTime;                    // micros() of last beacon send
  uint32_t discoveryStartTime;                // When discovery phase started
  uint32_t lastPruneTime;                     // When we last pruned inactive nodes
  volatile uint8_t syncResetBeaconsRemaining; // Number of beacons to broadcast
                                              // SYNC_RESET (0=none)
  volatile bool
      syncResetFrameNumberPending; // Reset frame number on next beacon (atomic)
  uint8_t syncPhaseCount;          // Counter for sync phase iterations
  TDMANodeInfo registeredNodes[TDMA_MAX_NODES];
  uint8_t nodeCount;

  // FIX #4: EXTEND DISCOVERY DURATION
  // Discovery phase duration (collect registrations before starting)
  // Extended from 3s to 10s to allow Nodes to complete full channel scan
  // Rationale: Nodes scan 11 channels @ 500ms each = 5.5s minimum
  // 10s provides margin for RF propagation delays and retransmissions
  static const uint32_t DISCOVERY_DURATION_MS = 10000; // Was: 3000
  static const uint32_t SHORT_DISCOVERY_MS =
      3000;                       // OPP-8: shortened when pre-registered nodes exist
  uint8_t preRegisteredNodeCount; // OPP-8: count loaded from NVS

  // ============================================================================
  // TDMA Helper Functions
  // ============================================================================
  void sendSyncPulse();    // Legacy sync pulse
  void sendTDMABeacon();   // TDMA beacon at start of each frame
  void sendTDMASchedule(); // Broadcast slot assignments
  void handleNodeRegistration(const uint8_t *senderMac, const uint8_t *data,
                              int len);
  bool recalculateSlots();   // Recompute slot assignments, returns false if frame overbudget
  void pruneInactiveNodes(); // Remove nodes not heard from recently
  uint8_t findUniqueNodeId(
      const uint8_t *mac); // Find unused ID for collision resolution

  // Discovery lock state
  bool discoveryLocked = false;
  PendingNode pendingNodes[MAX_PENDING_NODES];
  uint8_t sessionKnownMACs[TDMA_MAX_NODES][6];
  uint8_t sessionKnownMACCount = 0;
  NodePendingCallback onNodePending;

  bool isSessionKnownMAC(const uint8_t *mac) const;
  void recordSessionMAC(const uint8_t *mac);
  void clearSessionMACs();
  bool addPendingNode(uint8_t nodeId, uint8_t sensorCount, bool hasMag,
                      bool hasBaro, const char *name, const uint8_t *mac);

  // ============================================================================
  // PHASE 0: Two-Way Sync (PTP-Lite v2) Functions
  // ============================================================================
  void handleDelayReq(const uint8_t *data,
                      int len); // Handle DELAY_REQ from Node
  void sendDelayResp(uint8_t nodeId, uint32_t sequenceNum, uint64_t nodeT1,
                     uint64_t gatewayT2); // Send DELAY_RESP
};

extern SyncManager syncManager;

#endif // SYNC_MANAGER_H
