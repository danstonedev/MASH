// IMPORTANT: Define DEVICE_ROLE before including Config.h
// This is needed because .cpp files are compiled separately from .ino
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include "SyncManager.h"
#include <Preferences.h> // OPP-8: NVS topology persistence
#include <esp_wifi.h>    // For esp_wifi_get_tsf_time() - hardware timestamp

// SensorManager only needed for Node builds (sendIMUData, sendEnviroData,
// sendNodeInfo)
#if DEVICE_ROLE == DEVICE_ROLE_NODE
#include "SensorManager.h"
#endif

// Global pointer for the static callback to find the instance
static SyncManager *globalSyncManager = nullptr;

// ============================================================================
// PHASE 0: Two-Way Sync State (Gateway tracks pending DELAY_REQ timestamps)
// ============================================================================
// When Gateway receives DELAY_REQ, it captures T2 immediately and responds
// with DELAY_RESP containing T2 and T3 (send time). No queuing needed —
// the response is sent synchronously in handleDelayReq().
// ============================================================================

// ============================================================================
// ESP-NOW Callback - Auto-detect ESP-IDF version for compatibility
// ESP-IDF 5.x (Arduino ESP32 3.x) uses new signature with esp_now_recv_info_t
// ESP-IDF 4.x (Arduino ESP32 2.x) uses old signature with mac address
// ============================================================================
#include <esp_idf_version.h>

#if ESP_IDF_VERSION_MAJOR >= 5
// New callback signature for ESP-IDF 5.x / Arduino ESP32 3.x
void OnDataRecv(const esp_now_recv_info_t *recv_info,
                const uint8_t *incomingData, int len)
{
  if (globalSyncManager)
  {
    globalSyncManager->onPacketReceived(recv_info->src_addr, incomingData, len);
  }
}
#else
// Old callback signature for ESP-IDF 4.x / Arduino ESP32 2.x
void OnDataRecv(const uint8_t *mac_addr, const uint8_t *incomingData, int len)
{
  if (globalSyncManager)
  {
    globalSyncManager->onPacketReceived(mac_addr, incomingData, len);
  }
}
#endif

// ============================================================================
// ESP-NOW SEND TRACKING (for diagnostics)
// ============================================================================
// At 50Hz beacon rate, ESP-NOW TX buffer should not overflow.
// We keep simple error tracking to detect any remaining issues.
// ============================================================================
static uint32_t espnowSendFailures = 0;
static esp_err_t lastSendError = ESP_OK;

SyncManager::SyncManager()
    : currentRole(SYNC_ROLE_AUTO), timeOffset(0), lastSyncSend(0),
      syncEpochUs(0), epochInitialized(false), tdmaState(TDMA_STATE_IDLE),
      tdmaFrameNumber(0), lastBeaconTime(0), discoveryStartTime(0),
      lastPruneTime(0), syncResetBeaconsRemaining(0),
      syncResetFrameNumberPending(false), syncPhaseCount(0), nodeCount(0),
      preRegisteredNodeCount(0), isStreaming(false)
{
  globalSyncManager = this;

  // Initialize registered nodes array
  memset(registeredNodes, 0, sizeof(registeredNodes));
}

void SyncManager::init(const char *deviceName)
{
  // ============================================================================
  // WiFi Setup for ESP-NOW
  // ============================================================================
  // We use WIFI_STA mode for ESP-NOW. TSF-based sync is NOT available without
  // actual WiFi AP connection, so we use micros()-based sync instead.
  // The beacon.gatewayTimeUs field carries micros() timestamp.
  // ============================================================================
  WiFi.mode(WIFI_STA);

  // Init ESP-NOW
  if (esp_now_init() != ESP_OK)
  {
    SAFE_PRINTLN("[Sync] Error initializing ESP-NOW");
    return;
  }

  // Register callback
  esp_now_register_recv_cb(OnDataRecv);

  // If we are a NODE, we need to register the Gateway as a peer to send data
#if DEVICE_ROLE == DEVICE_ROLE_NODE
  uint8_t gatewayMac[] = GATEWAY_MAC_ADDRESS;
  if (!esp_now_is_peer_exist(gatewayMac))
  {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, gatewayMac, 6);
    peerInfo.channel = ESP_NOW_CHANNEL;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }
  SAFE_PRINTLN("[Sync] Node Mode: Gateway peer registered");
#endif

  SAFE_PRINTLN("[Sync] ESP-NOW Initialized");

  // OPP-8: Load persisted node topology from NVS
#if DEVICE_ROLE == DEVICE_ROLE_GATEWAY
  loadTopologyFromNVS();
#endif
}

void SyncManager::update()
{
  // ============================================================================
  // TDMA Mode - Beacon-based synchronized transmission
  // ============================================================================
  if (tdmaState != TDMA_STATE_IDLE)
  {
    uint32_t now = micros();

    switch (tdmaState)
    {
    case TDMA_STATE_DISCOVERY:
      // Wait for nodes to register during discovery phase
      // OPP-8: Use shortened discovery if pre-registered nodes loaded from NVS
      {
        uint32_t discoveryTimeout = (preRegisteredNodeCount > 0)
                                        ? SHORT_DISCOVERY_MS
                                        : DISCOVERY_DURATION_MS;
        if (millis() - discoveryStartTime > discoveryTimeout)
        {
          if (nodeCount > 0)
          {
            // Nodes registered, calculate slots and broadcast schedule
            recalculateSlots();
            sendTDMASchedule();
            tdmaState = TDMA_STATE_SYNC;
            // OPP-8: Clear pre-registered count — they've been absorbed
            preRegisteredNodeCount = 0;
            SAFE_LOG("[TDMA] Discovery complete: %d nodes registered\n",
                     nodeCount);
          }
          else
          {
            // No nodes found, extend discovery (use full duration now)
            preRegisteredNodeCount = 0;
            SAFE_PRINTLN("[TDMA] No nodes found, extending discovery...");
            discoveryStartTime = millis();
          }
        }
        // During discovery, still send beacons so nodes can hear us
        if (now - lastBeaconTime >= TDMA_FRAME_PERIOD_MS * 1000)
        {
          sendTDMABeacon();
          lastBeaconTime = now;
          tdmaFrameNumber++; // Always increment frame number for proper node
                             // sync
        }
      }
      break;

    case TDMA_STATE_SYNC:
      // Brief sync phase - send schedule a few more times (not every beacon!)
      if (now - lastBeaconTime >= TDMA_FRAME_PERIOD_MS * 1000)
      {
        sendTDMABeacon();
        lastBeaconTime = now;
        tdmaFrameNumber++; // Always increment frame number for proper node sync
        syncPhaseCount++;

        // Send schedule less frequently (every 10 beacons) to reduce spam
        if (syncPhaseCount % 10 == 1)
        {
          sendTDMASchedule();
        }

        if (syncPhaseCount >= 50) // ~1 second of sync phase
        {
          tdmaState = TDMA_STATE_RUNNING;
          syncPhaseCount = 0;
          lastPruneTime = millis();
          SAFE_PRINTLN("[TDMA] Entering RUNNING state");
        }
      }
      break;

    case TDMA_STATE_RUNNING:
      // Normal operation: send beacon every frame (50Hz = 20ms)
      if (now - lastBeaconTime >= TDMA_FRAME_PERIOD_MS * 1000)
      {
        // Send beacon - 50Hz is sustainable for ESP-NOW
        sendTDMABeacon();
        lastBeaconTime = now;
        tdmaFrameNumber++;

        // Re-send schedule every 50 frames (~1 second) to help nodes that
        // missed it This ensures late-registering nodes or those with packet
        // loss still sync
        if (tdmaFrameNumber % 50 == 0 && nodeCount > 0)
        {
          sendTDMASchedule();
        }

        // Periodically prune inactive nodes and resend schedule
        // CRITICAL: NEVER prune while streaming. Pruning shifts compact
        // sensor IDs which would corrupt the identity mapping in
        // SyncFrameBuffer and the webapp. If a node goes silent during
        // a recording session, effectiveSensorCount handles it gracefully
        // (partial frame emission with zeros for missing sensors).
        // Pruning only runs in idle/standby when isStreaming==false.
        if (!isStreaming && millis() - lastPruneTime > 5000)
        {
          pruneInactiveNodes();
          lastPruneTime = millis();
        }
      }
      break;

    default:
      break;
    }
    return; // Don't run legacy sync when TDMA is active
  }

  // ============================================================================
  // Legacy Mode - Simple 1Hz sync pulses
  // ============================================================================
  if (currentRole == SYNC_ROLE_MASTER)
  {
    if (millis() - lastSyncSend >= 1000)
    {
      sendSyncPulse();
      lastSyncSend = millis();
    }
  }
}

void SyncManager::sendSyncPulse()
{
  SyncPacket packet;
  packet.masterTime = micros(); // Use microseconds for precision sync
  packet.packetType = 0x01;

  // Log sync pulse periodically
  static unsigned long lastSyncLog = 0;
  if (millis() - lastSyncLog > 10000)
  {
    SAFE_LOG("[Sync] Broadcasting sync pulse: masterTime=%lu us\n",
             packet.masterTime);
    lastSyncLog = millis();
  }

  // Broadcast to all (FF:FF:FF:FF:FF:FF)
  uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

  // Need to add peer before sending if not exists?
  // ESP-NOW usually requires adding peer first.
  // For broadcast, we add the broadcast address as a peer.
  if (!esp_now_is_peer_exist(broadcastAddress))
  {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, broadcastAddress, 6);
    peerInfo.channel = 0;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }

  esp_now_send(broadcastAddress, (uint8_t *)&packet, sizeof(packet));
  // Serial.println("[Sync] Sent sync pulse");
}

void SyncManager::sendIMUData(SensorManager &sm)
{
#if DEVICE_ROLE == DEVICE_ROLE_NODE
  ESPNowDataPacket packet;
  memset(&packet, 0, sizeof(packet)); // Clear buffer

  packet.type = 0x02; // IMU Data (Compressed)
  packet.count = sm.getSensorCount();
  if (packet.count > MAX_SENSORS)
    packet.count = MAX_SENSORS;
  packet.timestamp = getAdjustedTime(); // Use synced time if available

  for (int i = 0; i < packet.count; i++)
  {
    IMUData data = sm.getData(i);
    Quaternion q = sm.getQuaternion(i);

    // ID mapping
    packet.sensors[i].id = i + SENSOR_ID_OFFSET;

    // Compression
    packet.sensors[i].q[0] = (int16_t)(q.w * 16384.0f);
    packet.sensors[i].q[1] = (int16_t)(q.x * 16384.0f);
    packet.sensors[i].q[2] = (int16_t)(q.y * 16384.0f);
    packet.sensors[i].q[3] = (int16_t)(q.z * 16384.0f);

    packet.sensors[i].a[0] = (int16_t)(data.accelX * 100.0f);
    packet.sensors[i].a[1] = (int16_t)(data.accelY * 100.0f);
    packet.sensors[i].a[2] = (int16_t)(data.accelZ * 100.0f);

    packet.sensors[i].g[0] = (int16_t)(data.gyroX * 100.0f);
    packet.sensors[i].g[1] = (int16_t)(data.gyroY * 100.0f);
    packet.sensors[i].g[2] = (int16_t)(data.gyroZ * 100.0f);
  }

  uint8_t gatewayMac[] = GATEWAY_MAC_ADDRESS;
  esp_now_send(gatewayMac, (uint8_t *)&packet, sizeof(packet));
#endif
}

void SyncManager::sendEnviroData(SensorManager &sm)
{
#if DEVICE_ROLE == DEVICE_ROLE_NODE
  ESPNowEnviroPacket packet;
  memset(&packet, 0, sizeof(packet));

  packet.type = 0x04; // Environmental Data
  packet.hasMag = sm.hasMag() ? 1 : 0;
  packet.hasBaro = sm.hasBaro() ? 1 : 0;

  if (sm.hasMag())
  {
    MagData mag = sm.getMagData();
    packet.mag[0] = mag.x;
    packet.mag[1] = mag.y;
    packet.mag[2] = mag.z;
    packet.mag[3] = mag.heading;
  }

  if (sm.hasBaro())
  {
    BaroData baro = sm.getBaroData();
    packet.baro[0] = baro.pressure;
    packet.baro[1] = baro.temperature;
    packet.baro[2] = baro.altitude;
  }

  uint8_t gatewayMac[] = GATEWAY_MAC_ADDRESS;
  esp_now_send(gatewayMac, (uint8_t *)&packet, sizeof(packet));
#endif
}

void SyncManager::sendNodeInfo(SensorManager &sm, const char *name)
{
#if DEVICE_ROLE == DEVICE_ROLE_NODE
  ESPNowNodeInfoPacket packet;
  memset(&packet, 0, sizeof(packet));

  packet.type = 0x05; // Node Info
  strncpy(packet.nodeName, name, sizeof(packet.nodeName) - 1);
  packet.sensorIdOffset = SENSOR_ID_OFFSET;
  packet.sensorCount = sm.getSensorCount();
  packet.hasMag = sm.hasMag() ? 1 : 0;
  packet.hasBaro = sm.hasBaro() ? 1 : 0;

  uint8_t gatewayMac[] = GATEWAY_MAC_ADDRESS;
  esp_now_send(gatewayMac, (uint8_t *)&packet, sizeof(packet));
#endif
}

void SyncManager::onPacketReceived(const uint8_t *senderMac,
                                   const uint8_t *data, int len)
{
  if (len < 1)
    return;

  // Keep ANY registered node alive regardless of packet type or streaming state.
  // Without this, nodes get pruned when isStreaming=false because data packets
  // (0x04/0x23/0x26) are dropped in the data callback before updateNodeLastHeard.
  updateNodeLastHeardByMAC(senderMac);

  uint8_t type = data[0];

  // Debug: Log registration packets specially (they're critical for TDMA setup)
  if (type == TDMA_PACKET_REGISTER)
  {
    SAFE_LOG(
        "[Sync] !!! REGISTRATION PACKET !!! type=0x%02X, len=%d, expected=%d\n",
        type, len, sizeof(TDMARegisterPacket));
    if (len >= 5)
    {
      // Log the raw data to see nodeId
      SAFE_LOG("[Sync] Registration data: nodeId=%d, sensorCount=%d\n", data[1],
               data[2]);
    }
  }

  if (type == 0x01 && len == sizeof(SyncPacket))
  { // Sync Packet
    SyncPacket *packet = (SyncPacket *)data;
    if (currentRole != SYNC_ROLE_MASTER)
    {
      uint32_t now = micros(); // Use microseconds to match masterTime
      timeOffset = packet->masterTime - now;
    }
  }
  // Handle TDMA Registration from Nodes - be lenient with size check
  else if (type == TDMA_PACKET_REGISTER)
  {
    if (len == sizeof(TDMARegisterPacket))
    {
      handleNodeRegistration(senderMac, data, len);
    }
    else
    {
      SAFE_LOG("[Sync] WARNING: Registration packet size mismatch! Got "
               "%d, expected %d\n",
               len, sizeof(TDMARegisterPacket));
      // Try to handle it anyway if it's at least the minimum size
      if (len >= 5)
      {
        SAFE_PRINTLN(
            "[Sync] Attempting to handle undersized registration packet...");
        handleNodeRegistration(senderMac, data, len);
      }
    }
  }
  // ============================================================================
  // PHASE 0: Handle DELAY_REQ from Nodes (Two-Way Sync Protocol)
  // ============================================================================
  else if (type == TDMA_PACKET_DELAY_REQ && len >= sizeof(TDMADelayReqPacket))
  {
    handleDelayReq(data, len);
  }
  // ============================================================================
  else
  {
    // Forward unknown/data packets to callback
    if (onDataCallback)
    {
      onDataCallback(data, len);
    }
  }
}

uint32_t SyncManager::getAdjustedTime() { return micros() + timeOffset; }

void SyncManager::setRole(SyncRole role)
{
  currentRole = role;
  if (role == SYNC_ROLE_MASTER)
  {
    timeOffset = 0; // Masters use their own time
    SAFE_PRINTLN("[Sync] Role set to MASTER");
  }
  else
  {
    SAFE_PRINTLN("[Sync] Role set to SLAVE (listening)");
  }
}

void SyncManager::sendRadioModeCommand(uint8_t mode)
{
  ESPNowRadioModePacket packet;
  packet.type = RADIO_MODE_PACKET; // 0x06
  packet.mode = mode;

  // Broadcast to all nodes (FF:FF:FF:FF:FF:FF)
  uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

  // Add broadcast peer if needed
  if (!esp_now_is_peer_exist(broadcastAddress))
  {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, broadcastAddress, 6);
    peerInfo.channel = 0; // Use current channel
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }

  esp_now_send(broadcastAddress, (uint8_t *)&packet, sizeof(packet));
  SAFE_LOG("[Sync] Broadcast radio mode: %s\n",
           mode == RADIO_MODE_BLE_OFF ? "BLE_OFF" : "BLE_ON");
}

void SyncManager::sendMagCalibCommand(uint8_t cmdType, uint32_t param,
                                      uint8_t targetNode)
{
  ESPNowCmdPacket packet;
  packet.type = CMD_FORWARD_PACKET; // 0x08
  packet.cmdType = cmdType;
  packet.param1 = param;
  packet.targetNode = targetNode;

  // Broadcast to all nodes (FF:FF:FF:FF:FF:FF)
  uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

  // Add broadcast peer if needed
  if (!esp_now_is_peer_exist(broadcastAddress))
  {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, broadcastAddress, 6);
    peerInfo.channel = 0;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }

  esp_now_send(broadcastAddress, (uint8_t *)&packet, sizeof(packet));
  SAFE_LOG("[Sync] Broadcast mag command: type=%d param=%lu\n", cmdType, param);
}

// ============================================================================
// AUTO-ID COLLISION RESOLUTION
// ============================================================================
// When two nodes derive the same nodeId from their MAC addresses, the Gateway
// detects the collision during registration and assigns a new unique ID to the
// second node via a targeted CMD_SET_NODE_ID command. The node persists this
// new ID and reboots - fully automatic, no user intervention needed.
// ============================================================================

uint8_t SyncManager::findUniqueNodeId(const uint8_t *mac)
{
  // Generate a candidate from a different part of the MAC
  // Try MAC bytes [1], [2], [3], [4] in order until we find one not already
  // used
  for (int byteIdx = 1; byteIdx <= 4; byteIdx++)
  {
    uint8_t candidate =
        mac[5 - byteIdx]; // Walk from second-to-last byte backwards
    if (candidate == 0)
      candidate = byteIdx; // Never use 0

    // Check if any registered node already has this ID
    bool collision = false;
    for (int i = 0; i < TDMA_MAX_NODES; i++)
    {
      if (registeredNodes[i].registered &&
          registeredNodes[i].nodeId == candidate)
      {
        collision = true;
        break;
      }
    }
    if (!collision)
      return candidate;
  }

  // Fallback: scan for any free ID from 1-255
  for (uint16_t id = 1; id <= 255; id++)
  {
    bool collision = false;
    for (int i = 0; i < TDMA_MAX_NODES; i++)
    {
      if (registeredNodes[i].registered &&
          registeredNodes[i].nodeId == (uint8_t)id)
      {
        collision = true;
        break;
      }
    }
    if (!collision)
      return (uint8_t)id;
  }

  return 1; // Fallback — should never reach here with <200 possible IDs
}

void SyncManager::sendSetNodeIdCommand(const uint8_t *targetMac,
                                       uint8_t newId)
{
  ESPNowCmdPacket packet;
  packet.type = CMD_FORWARD_PACKET; // 0x08
  packet.targetNode =
      0xFF;                         // Broadcast - both nodes have same ID so we can't target by nodeId
  packet.cmdType = CMD_SET_NODE_ID; // 0x53
  packet.param1 = newId;
  // Pack last 4 bytes of target MAC into param2 as a discriminator
  // So only the specific colliding node applies the command
  packet.param2 = ((uint32_t)targetMac[2] << 24) |
                  ((uint32_t)targetMac[3] << 16) |
                  ((uint32_t)targetMac[4] << 8) | ((uint32_t)targetMac[5]);

  uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

  if (!esp_now_is_peer_exist(broadcastAddress))
  {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, broadcastAddress, 6);
    peerInfo.channel = 0;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }

  // Send multiple times to ensure delivery (node will reboot on receipt)
  for (int i = 0; i < 3; i++)
  {
    esp_now_send(broadcastAddress, (uint8_t *)&packet, sizeof(packet));
    delay(10);
  }

  SAFE_LOG("[TDMA] Sent SET_NODE_ID command: newId=%d (3x for reliability)\n",
           newId);
}
// ============================================================================

// ============================================================================
// TDMA Implementation (Gateway Mode)
// ============================================================================

void SyncManager::startTDMA()
{
  SAFE_PRINTLN("[TDMA] Starting TDMA coordination...");

  // Reset state
  tdmaState = TDMA_STATE_DISCOVERY;
  tdmaFrameNumber = 0;
  lastBeaconTime = micros();
  discoveryStartTime = millis();
  syncPhaseCount = 0; // Reset sync phase counter

  // Clear discovery lock and session tracking for fresh session
  discoveryLocked = false;
  clearSessionMACs();
  memset(pendingNodes, 0, sizeof(pendingNodes));

  // OPP-8: If pre-registered nodes were loaded from NVS, keep them
  // and use shortened discovery to allow new nodes to join.
  // Otherwise do a full clean discovery.
  if (preRegisteredNodeCount > 0)
  {
    // Nodes loaded from NVS already populate registeredNodes[]
    // nodeCount was set by loadTopologyFromNVS()
    SAFE_LOG(
        "[TDMA] Pre-registered %d nodes from NVS, short discovery (%lu ms)\n",
        preRegisteredNodeCount, SHORT_DISCOVERY_MS);
  }
  else
  {
    nodeCount = 0;
    memset(registeredNodes, 0, sizeof(registeredNodes));
  }

  // Ensure broadcast peer is added
  uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
  if (!esp_now_is_peer_exist(broadcastAddress))
  {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, broadcastAddress, 6);
    peerInfo.channel = 0;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }

  SAFE_LOG("[TDMA] Discovery phase started (%lu ms)\n",
           (preRegisteredNodeCount > 0) ? SHORT_DISCOVERY_MS
                                        : DISCOVERY_DURATION_MS);
}

void SyncManager::stopTDMA()
{
  SAFE_PRINTLN("[TDMA] Stopping TDMA coordination");
  tdmaState = TDMA_STATE_IDLE;
}

void SyncManager::restartDiscovery()
{
  SAFE_PRINTLN("[TDMA] !!! MANUAL RE-SCAN REQUESTED - wiping node table !!!");
  tdmaState = TDMA_STATE_IDLE;

  // Force full clean slate regardless of NVS cache
  preRegisteredNodeCount = 0;
  nodeCount = 0;
  memset(registeredNodes, 0, sizeof(registeredNodes));
  memset(pendingNodes, 0, sizeof(pendingNodes));

  // Notify webapp so SyncFrameBuffer resets expected sensors
  if (onNodePruned)
  {
    onNodePruned();
  }

  startTDMA();
}

uint8_t SyncManager::getRegisteredNodeCount() const
{
  uint8_t count = 0;
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered)
    {
      count++;
    }
  }
  return count;
}

uint8_t SyncManager::getActiveNodeCount(uint32_t activeThresholdMs) const
{
  const uint32_t now = millis();
  uint8_t count = 0;
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered &&
        (now - registeredNodes[i].lastHeard) <= activeThresholdMs)
    {
      count++;
    }
  }
  return count;
}

uint8_t SyncManager::getActiveSensorCount(uint32_t activeThresholdMs) const
{
  const uint32_t now = millis();
  uint8_t count = 0;
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered &&
        (now - registeredNodes[i].lastHeard) <= activeThresholdMs)
    {
      count = (uint8_t)(count + registeredNodes[i].sensorCount);
    }
  }
  return count;
}

const char *SyncManager::getTDMAStateName() const
{
  switch (tdmaState)
  {
  case TDMA_STATE_IDLE:
    return "idle";
  case TDMA_STATE_DISCOVERY:
    return "discovery";
  case TDMA_STATE_SYNC:
    return "sync";
  case TDMA_STATE_RUNNING:
    return "running";
  default:
    return "unknown";
  }
}

void SyncManager::updateNodeLastHeard(uint8_t nodeId)
{
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered && registeredNodes[i].nodeId == nodeId)
    {
      registeredNodes[i].lastHeard = millis();
      return;
    }
  }
}

void SyncManager::updateNodeLastHeardByMAC(const uint8_t *mac)
{
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered &&
        memcmp(registeredNodes[i].mac, mac, 6) == 0)
    {
      registeredNodes[i].lastHeard = millis();
      return;
    }
  }
}

void SyncManager::sendTDMABeacon()
{
  // ============================================================================
  // EPOCH-BASED DETERMINISTIC TIMESTAMPS (Research-Grade Cross-Node Sync)
  // ============================================================================
  // PROBLEM: If Node A receives beacon N and Node B receives beacon N+3 due to
  // packet loss, they had different gatewayTimeUs values (60ms apart). This
  // caused 60-300ms drift that persisted even with the frozen anchor fix.
  //
  // SOLUTION: Use EPOCH-BASED timestamps where:
  //   gatewayTimeUs = epoch + (frameNumber * 20000)
  //
  // This makes timestamps DETERMINISTIC and INDEPENDENT of beacon timing:
  // - Beacon #0:   epoch + 0
  // - Beacon #1:   epoch + 20000
  // - Beacon #100: epoch + 2000000
  //
  // Now if Node A receives beacon #50 and Node B receives beacon #53:
  // - Node A computes: epoch + 50*20000 + sampleIndex*5000
  // - Node B computes: epoch + 53*20000 + sampleIndex*5000
  //
  // For the SAME physical sampling instant, both produce IDENTICAL timestamps
  // because the sample's logical position (frame + sampleIndex) is the same!
  //
  // The epoch is reset during SYNC_RESET to provide a fresh time reference.
  // ============================================================================

  // NOTE: syncEpochUs and epochInitialized are now class members (not static)
  // so they can be accessed by SyncFrameBuffer for timestamp normalization.

  if (syncResetFrameNumberPending)
  {
    tdmaFrameNumber = 0;
    syncResetFrameNumberPending = false;
    // Set the epoch to current time - this is the reference point for frame 0
    syncEpochUs = micros();
    epochInitialized = true;
    SAFE_LOG_NB("[SYNC] EPOCH RESET: frame=0, epoch=%lu us\n", syncEpochUs);
  }

  // Initialize epoch on first beacon if not done via SYNC_RESET
  if (!epochInitialized)
  {
    syncEpochUs = micros() - (tdmaFrameNumber * TDMA_FRAME_PERIOD_MS * 1000);
    epochInitialized = true;
    SAFE_LOG_NB("[SYNC] EPOCH INIT: frame=%lu, epoch=%lu us\n", tdmaFrameNumber,
                syncEpochUs);
  }

  TDMABeaconPacket beacon;
  beacon.type = TDMA_PACKET_BEACON;
  beacon.frameNumber = tdmaFrameNumber;

  // ============================================================================
  // DETERMINISTIC TIMESTAMP: epoch + frameNumber * 20000
  // ============================================================================
  // This ensures ALL beacons (not just SYNC_RESET) have predictable timestamps.
  // Nodes can compute the correct timestamp from ANY beacon they receive.
  // ============================================================================
  beacon.gatewayTimeUs =
      syncEpochUs + (tdmaFrameNumber * TDMA_FRAME_PERIOD_MS * 1000);
  beacon.nodeCount = nodeCount;

  // ============================================================================
  // MICROS-BASED SYNCHRONIZATION
  // ============================================================================
  // TSF (Timing Synchronization Function) is NOT available without WiFi AP
  // connection. Instead, we use micros() as the authoritative clock. Nodes
  // compute their offset at beacon reception: offset = beacon.gatewayTimeUs -
  // local_micros_at_rx This achieves ~100-500us accuracy (limited by ESP-NOW
  // latency jitter).
  //
  // The gatewayTsfUs field is set to same value for backwards compatibility.
  // ============================================================================
  beacon.gatewayTsfUs = (uint64_t)beacon.gatewayTimeUs;

  // DEBUG: Log beacon timestamp EVERY 2 SECONDS
  static uint32_t lastBeaconTsDebug = 0;
  if (millis() - lastBeaconTsDebug > 2000)
  {
    lastBeaconTsDebug = millis();
    SAFE_LOG_NB(
        "[GW BEACON] epoch=%lu, frame=%lu, ts=%lu (deterministic sync)\n",
        syncEpochUs, beacon.frameNumber, beacon.gatewayTimeUs);
  }
  // ============================================================================

  // FIX #3: VALIDATE WIFI CHANNEL BEFORE INCLUDING IN BEACON
  // Critical: WiFi.channel() returns 0 when STA mode is not connected,
  // causing Nodes to attempt switching to invalid channel 0.
  //
  // Solution: Default to channel 1 if WiFi returns 0 or invalid value
  uint8_t currentChannel = WiFi.channel();
  if (currentChannel == 0 || currentChannel > 14)
  {
    currentChannel =
        1; // ESP-NOW default channel (set by esp_wifi_set_channel in setup)
  }
  beacon.wifiChannel = currentChannel;

  // ============================================================================
  // SYNC RECOVERY: Encode Gateway state and sync protocol version in beacon
  // flags
  // ============================================================================
  // Bit layout: [7:4]=TDMA state, [3]=SYNC_RESET, [2:0]=sync protocol version
  //
  // When syncResetBeaconsRemaining > 0, set bit 3 to force all nodes to reset.
  // We broadcast SYNC_RESET for multiple beacons to ensure ALL nodes receive it
  // even with 10% packet loss. 10 beacons @ 50Hz = 200ms of reset broadcasts.
  // ============================================================================
  uint8_t resetBit = (syncResetBeaconsRemaining > 0) ? SYNC_FLAG_RESET_MASK : 0;
  uint8_t streamingBit = isStreaming ? SYNC_FLAG_STREAMING : 0;
  beacon.flags = (tdmaState << SYNC_FLAG_STATE_SHIFT) | streamingBit |
                 resetBit | SYNC_PROTOCOL_VERSION_PTP_V2;

  // DEBUG: Log beacon flags when SYNC_RESET is active
  if (syncResetBeaconsRemaining > 0)
  {
    SAFE_LOG_NB(
        "[GW FLAGS] Sending beacon with flags=0x%02X (reset=%d, state=%d, "
        "remaining=%d)\n",
        beacon.flags, resetBit ? 1 : 0, tdmaState, syncResetBeaconsRemaining);
  }

  // Decrement counter after sending beacon with reset set
  if (syncResetBeaconsRemaining > 0)
  {
    syncResetBeaconsRemaining--;
    if (syncResetBeaconsRemaining == 0)
    {
      SAFE_PRINTLN_NB("[SYNC] SYNC_RESET broadcast complete (10 beacons sent)");
    }
    else if (syncResetBeaconsRemaining == 9)
    {
      SAFE_PRINTLN_NB(
          "[SYNC] Broadcasting SYNC_RESET for next 10 beacons (200ms)");
    }
  }
  // ============================================================================

  // ============================================================================
  // PTP STAGGERING: Assign one node per frame to do PTP exchange
  // ============================================================================
  // This prevents multiple nodes from sending DELAY_REQ simultaneously,
  // which can corrupt T2/T3 timestamps on the Gateway side.
  //
  // Strategy: Round-robin through registered nodes at 50Hz beacon rate
  // - Each node gets a PTP slot every (nodeCount) frames
  // - With 4 nodes at 50Hz: each node syncs ~12.5 times/second (plenty!)
  // - 0xFF means "no node should do PTP" (used during discovery)
  // ============================================================================
  if (nodeCount > 0 && tdmaState == TDMA_STATE_RUNNING)
  {
    // Find the N-th registered node (where N = frameNumber % nodeCount)
    uint8_t ptpSlotIndex = tdmaFrameNumber % nodeCount;
    uint8_t foundCount = 0;
    beacon.ptpSlotNode = 0xFF; // Default: no PTP this frame

    for (int i = 0; i < TDMA_MAX_NODES && foundCount <= ptpSlotIndex; i++)
    {
      if (registeredNodes[i].registered)
      {
        if (foundCount == ptpSlotIndex)
        {
          beacon.ptpSlotNode = registeredNodes[i].nodeId;
          break;
        }
        foundCount++;
      }
    }
  }
  else
  {
    // During discovery/sync, allow all nodes to do initial PTP calibration
    beacon.ptpSlotNode = 0xFF;
  }
  // ============================================================================

  uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

  // Direct send - at 50Hz beacon rate, ESP-NOW buffer won't overflow
  esp_err_t result =
      esp_now_send(broadcastAddress, (uint8_t *)&beacon, sizeof(beacon));
  if (result != ESP_OK)
  {
    espnowSendFailures++;
    lastSendError = result;
  }

  // Log every 500 frames (once per 10 seconds at 50Hz) to reduce blocking
  // Include send failure count and heap info for diagnostics
  if (tdmaFrameNumber % 500 == 0)
  {
    SAFE_LOG_NB("[TDMA] Beacon #%lu sent, %d nodes, state=%d, ch=%d",
                tdmaFrameNumber, nodeCount, tdmaState, currentChannel);
    if (espnowSendFailures > 0)
    {
      // Error 0x3067 = ESP_ERR_ESPNOW_NO_MEM (TX buffer full)
      SAFE_LOG_NB(", SEND FAILURES: %lu (err=0x%X)", espnowSendFailures,
                  lastSendError);
    }
    // Show free heap to detect memory leaks
    SAFE_LOG_NB(", heap=%luKB", ESP.getFreeHeap() / 1024);
    SAFE_PRINTLN_NB(""); // Fix: Empty string for println

    // Also log node health status
    for (int i = 0; i < TDMA_MAX_NODES; i++)
    {
      if (registeredNodes[i].registered)
      {
        uint32_t silenceMs = millis() - registeredNodes[i].lastHeard;
        if (silenceMs > 2000)
        {
          SAFE_LOG_NB("[TDMA] WARNING: Node %d (%s) silent for %lu ms\n",
                      registeredNodes[i].nodeId, registeredNodes[i].nodeName,
                      silenceMs);
        }
      }
    }
  }
}

void SyncManager::sendTDMASchedule()
{
  TDMASchedulePacket schedule;
  schedule.type = TDMA_PACKET_SCHEDULE;
  schedule.nodeCount = nodeCount;
  schedule.reserved = 0;

  // Serial.printf("[TDMA] Building schedule: nodeCount=%d\n", nodeCount);

  // Fill in slot assignments
  uint8_t slotIdx = 0;
  for (int i = 0; i < TDMA_MAX_NODES && slotIdx < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered)
    {
      schedule.slots[slotIdx].nodeId = registeredNodes[i].nodeId;
      schedule.slots[slotIdx].slotOffsetUs = registeredNodes[i].slotOffsetUs;
      schedule.slots[slotIdx].slotWidthUs = registeredNodes[i].slotWidthUs;
      // Serial.printf("[TDMA]   Slot %d: node %d (offset=%u, width=%u)\n",
      //               slotIdx, registeredNodes[i].nodeId,
      //               registeredNodes[i].slotOffsetUs,
      //               registeredNodes[i].slotWidthUs);
      slotIdx++;
    }
  }

  // VERIFY: slotIdx should match nodeCount
  if (slotIdx != nodeCount)
  {
    SAFE_LOG(
        "[TDMA] WARNING: nodeCount mismatch! nodeCount=%d but slotIdx=%d\n",
        nodeCount, slotIdx);
  }

  uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

  // Debug size mismatch
  // Serial.printf("[TDMA] Sending Schedule: size=%d, nodeCount=%d\n",
  // sizeof(schedule), nodeCount);

  // Direct send - schedules are infrequent
  esp_now_send(broadcastAddress, (uint8_t *)&schedule, sizeof(schedule));

  // Reduced logging: Only print summary
  // Serial.printf("[TDMA] Schedule broadcast complete: %d slots assigned\n",
  //               slotIdx);
}

void SyncManager::handleNodeRegistration(const uint8_t *senderMac,
                                         const uint8_t *data, int len)
{
  if (len < 3)
  {
    SAFE_LOG("[TDMA] Registration packet too short: %d bytes\n", len);
    return;
  }

  TDMARegisterPacket regPacket = {};
  const size_t copyLen =
      (len < (int)sizeof(TDMARegisterPacket)) ? (size_t)len : sizeof(TDMARegisterPacket);
  memcpy(&regPacket, data, copyLen);
  regPacket.nodeName[sizeof(regPacket.nodeName) - 1] = '\0';

  TDMARegisterPacket *reg = &regPacket;

  if (reg->sensorCount > MAX_SENSORS)
  {
    SAFE_LOG("[TDMA] Clamping sensorCount from %u to %u for node %u\n",
             reg->sensorCount, (uint8_t)MAX_SENSORS, reg->nodeId);
    reg->sensorCount = MAX_SENSORS;
  }

  SAFE_LOG("[TDMA] >>> Registration from node %d: %s (%d sensors) "
           "MAC=%02X:%02X:%02X:%02X:%02X:%02X <<<\n",
           reg->nodeId, reg->nodeName, reg->sensorCount, senderMac[0],
           senderMac[1], senderMac[2], senderMac[3], senderMac[4],
           senderMac[5]);
  SAFE_LOG("[TDMA] Current state: %d, nodeCount: %d\n", tdmaState, nodeCount);

  // ============================================================================
  // COLLISION DETECTION: Check if a DIFFERENT MAC is registering with same
  // nodeId
  // ============================================================================
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered &&
        registeredNodes[i].nodeId == reg->nodeId &&
        memcmp(registeredNodes[i].mac, senderMac, 6) != 0)
    {
      // COLLISION! Two different physical devices have the same nodeId.
      // Resolve by assigning the NEW arrival a fresh unique ID.
      uint8_t newId = findUniqueNodeId(senderMac);
      SAFE_LOG("[TDMA] !!! NODE ID COLLISION DETECTED !!! nodeId=%d\n",
               reg->nodeId);
      SAFE_LOG("[TDMA] Existing MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
               registeredNodes[i].mac[0], registeredNodes[i].mac[1],
               registeredNodes[i].mac[2], registeredNodes[i].mac[3],
               registeredNodes[i].mac[4], registeredNodes[i].mac[5]);
      SAFE_LOG("[TDMA] Colliding MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
               senderMac[0], senderMac[1], senderMac[2], senderMac[3],
               senderMac[4], senderMac[5]);
      SAFE_LOG("[TDMA] >>> AUTO-RESOLVING: Assigning new ID %d to colliding "
               "node <<<\n",
               newId);

      sendSetNodeIdCommand(senderMac, newId);
      return; // Don't register - the node will reboot and re-register with new
              // ID
    }
  }
  // ============================================================================

  // Check if already registered (same MAC, update entry)
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered &&
        registeredNodes[i].nodeId == reg->nodeId)
    {
      // Update existing entry
      bool sensorCountChanged = (registeredNodes[i].sensorCount != reg->sensorCount);
      registeredNodes[i].sensorCount = reg->sensorCount;
      registeredNodes[i].hasMag = reg->hasMag;
      registeredNodes[i].hasBaro = reg->hasBaro;
      strncpy(registeredNodes[i].nodeName, reg->nodeName, 15);
      registeredNodes[i].nodeName[15] = '\0';
      registeredNodes[i].lastHeard = millis();
      memcpy(registeredNodes[i].mac, senderMac, 6);

      // If sensorCount changed (e.g. first registration used fallback MAX_SENSORS
      // but correct count arrived on re-registration), recompute slot widths now
      // so that the stale slotWidthUs doesn't create dead-air gaps every frame.
      if (sensorCountChanged)
      {
        SAFE_LOG("[TDMA] sensorCount changed for node %d (%d->%d), recalculating slots\n",
                 reg->nodeId, registeredNodes[i].sensorCount, reg->sensorCount);
        recalculateSlots();
        // Send beacon first so all nodes re-anchor their virtual-frame clock
        // to the updated layout, then immediately follow with the new schedule
        // so slot offsets and timing arrive in tight succession.
        sendTDMABeacon();
        sendTDMASchedule();
        return;
      }

      // ========================================================================
      // RATE LIMIT SCHEDULE RE-SENDS TO PREVENT TX QUEUE FLOODING
      // ========================================================================
      // If Node keeps re-registering, it means it's not receiving schedules.
      // But sending schedule on EVERY registration floods ESP-NOW TX queue,
      // causing even MORE failures (100%+ failure rate observed).
      // Solution: Only re-send schedule at most once per second per node.
      // ========================================================================
      static uint32_t lastScheduleResendTime = 0;
      static uint8_t lastResendNodeId = 0xFF;

      uint32_t now = millis();
      bool shouldResend = false;

      if (tdmaState == TDMA_STATE_SYNC || tdmaState == TDMA_STATE_RUNNING)
      {
        // Only resend if it's a different node OR >1 second since last resend
        if (reg->nodeId != lastResendNodeId ||
            (now - lastScheduleResendTime) > 1000)
        {
          shouldResend = true;
          lastScheduleResendTime = now;
          lastResendNodeId = reg->nodeId;
        }
      }

      if (shouldResend)
      {
        SAFE_LOG("[TDMA] Re-sending schedule to help node %d sync\n",
                 reg->nodeId);
        sendTDMASchedule();
      }
      else
      {
        // Silently skip - don't spam logs either
        static uint32_t skippedResends = 0;
        skippedResends++;
        if (skippedResends % 10 == 0)
        {
          SAFE_LOG("[TDMA] Skipped %lu schedule resends (rate limited)\n",
                   skippedResends);
        }
      }
      // ========================================================================

      return;
    }
  }

  // ==========================================================================
  // DISCOVERY LOCK: If locked, queue unknown nodes instead of admitting them.
  // Session-known MACs (nodes that were registered earlier this session) are
  // auto-re-admitted silently — this handles temporary dropouts.
  // ==========================================================================
  if (discoveryLocked && !isSessionKnownMAC(senderMac))
  {
    SAFE_LOG("[TDMA] Discovery LOCKED - queuing node %d (%s) as pending\n",
             reg->nodeId, reg->nodeName);
    addPendingNode(reg->nodeId, reg->sensorCount, reg->hasMag, reg->hasBaro,
                   reg->nodeName, senderMac);
    return;
  }

  // Find empty slot for new node
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (!registeredNodes[i].registered)
    {
      // ====================================================================
      // ADMISSION CONTROL: Project frame time with this node included.
      // Reject registration if the schedule would exceed the 20ms budget.
      // ====================================================================
      {
        uint8_t sensorCounts[TDMA_MAX_NODES];
        uint8_t projectedCount = 0;
        for (int j = 0; j < TDMA_MAX_NODES; j++)
        {
          if (registeredNodes[j].registered)
          {
            sensorCounts[projectedCount++] = registeredNodes[j].sensorCount;
          }
        }
        sensorCounts[projectedCount++] = reg->sensorCount; // candidate node

        uint32_t projectedFrameUs = calculateFrameTime(projectedCount, sensorCounts);
        uint32_t budgetUs = (uint32_t)TDMA_FRAME_PERIOD_MS * 1000;

        if (projectedFrameUs > budgetUs)
        {
          SAFE_LOG("[TDMA] REJECTED node %d (%s, %d sensors): "
                   "would overflow frame (%lu > %lu µs)\n",
                   reg->nodeId, reg->nodeName, reg->sensorCount,
                   projectedFrameUs, budgetUs);
          return;
        }
      }
      // ====================================================================

      registeredNodes[i].nodeId = reg->nodeId;
      registeredNodes[i].sensorCount = reg->sensorCount;
      registeredNodes[i].hasMag = reg->hasMag;
      registeredNodes[i].hasBaro = reg->hasBaro;
      strncpy(registeredNodes[i].nodeName, reg->nodeName, 15);
      registeredNodes[i].nodeName[15] = '\0';
      registeredNodes[i].lastHeard = millis();
      registeredNodes[i].registered = true;
      memcpy(registeredNodes[i].mac, senderMac, 6);
      nodeCount++;

      SAFE_LOG("[TDMA] *** REGISTERED NEW NODE %d in slot %d (total: %d) ***\n",
               reg->nodeId, i, nodeCount);

      // Track this MAC as session-known for auto-re-admit on dropout
      recordSessionMAC(senderMac);

      // ALWAYS recalculate slots and send schedule when a new node registers
      // This ensures ANY late-registering node gets their slot assignment
      recalculateSlots();
      sendTDMASchedule();

      // Notify callback so SyncFrameBuffer can be updated
      if (onNodeRegistered)
      {
        onNodeRegistered(reg->nodeId, reg->sensorCount);
      }

      // OPP-8: Persist updated topology to NVS
      saveTopologyToNVS();
      return;
    }
  }

  SAFE_PRINTLN("[TDMA] WARNING: Max nodes reached, registration rejected");
}

bool SyncManager::recalculateSlots()
{
  // ============================================================================
  // Single source of truth: calculateSlotWidth() from TDMAProtocol.h
  // Slot width = fixed overhead (1500µs) + RF airtime (payload × 8µs/byte)
  // Clamped to TDMA_SLOT_MIN_WIDTH_US floor.
  // ============================================================================

  uint16_t currentOffset =
      TDMA_BEACON_DURATION_US +
      TDMA_FIRST_SLOT_GAP_US; // Start after beacon + safety gap

  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered)
    {
      registeredNodes[i].slotOffsetUs = currentOffset;
      registeredNodes[i].slotWidthUs =
          calculateSlotWidth(registeredNodes[i].sensorCount);

      SAFE_LOG("[TDMA] Slot %d: node=%d, sensors=%d, offset=%u, width=%u us\n",
               i, registeredNodes[i].nodeId, registeredNodes[i].sensorCount,
               registeredNodes[i].slotOffsetUs, registeredNodes[i].slotWidthUs);

      currentOffset += registeredNodes[i].slotWidthUs + TDMA_INTER_SLOT_GAP_US;
    }
  }

  uint32_t totalFrameTime = currentOffset + TDMA_GUARD_TIME_US;
  uint32_t frameBudgetUs = (uint32_t)TDMA_FRAME_PERIOD_MS * 1000;
  float utilisation = (totalFrameTime * 100.0f) / frameBudgetUs;

  SAFE_LOG("[TDMA] Frame: %lu / %lu µs (%.1f%% utilisation, %d nodes)\n",
           totalFrameTime, frameBudgetUs, utilisation, nodeCount);

  if (totalFrameTime > frameBudgetUs)
  {
    SAFE_LOG("[TDMA] CRITICAL: Frame overbudget by %lu µs! Collisions likely.\n",
             totalFrameTime - frameBudgetUs);
    return false;
  }

  return true;
}

void SyncManager::pruneInactiveNodes()
{
  uint32_t now = millis();
  bool changed = false;

  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered)
    {
      // Consider node inactive if not heard from in 10 seconds
      if (now - registeredNodes[i].lastHeard > 10000)
      {
        SAFE_LOG("[TDMA] Pruning inactive node %d (%s)\n",
                 registeredNodes[i].nodeId, registeredNodes[i].nodeName);
        registeredNodes[i].registered = false;
        nodeCount--;
        changed = true;
      }
    }
  }

  if (changed)
  {
    if (nodeCount > 0)
    {
      recalculateSlots();
      sendTDMASchedule();
    }

    // Notify listener (e.g., MASH_Gateway.ino) so SyncFrameBuffer can
    // shrink its expected sensor set and stop emitting phantom IDs.
    if (onNodePruned)
    {
      onNodePruned();
    }
  }
}

// ============================================================================
// PHASE 0: Two-Way Sync Implementation (PTP-Lite v2)
// ============================================================================
// This implements the research-grade time synchronization protocol as
// specified in docs/EXPERT_REVIEW_FINAL_SYNTHESIS.md
//
// When a Node sends DELAY_REQ:
// 1. Gateway captures T2 (TSF timestamp on receive)
// 2. Gateway immediately sends DELAY_RESP with T1 (echoed), T2, T3
// 3. Node uses all 4 timestamps to calculate offset and RTT
// ============================================================================

void SyncManager::handleDelayReq(const uint8_t *data, int len)
{
  // Capture receive timestamp FIRST (minimize software delay)
  // Use micros() since TSF is not available without WiFi AP connection
  uint64_t t2 = (uint64_t)micros();

  TDMADelayReqPacket *req = (TDMADelayReqPacket *)data;

  // Log periodically (every 50th request per node to avoid spam)
  // Use nodeId % TDMA_MAX_NODES as hash index — nodeIds are assigned 50+
  // so raw nodeId exceeds array bounds. Modulo gives O(1) per-bucket counting.
  static uint32_t delayReqCount[TDMA_MAX_NODES] = {};
  uint8_t bucket = req->nodeId % TDMA_MAX_NODES;
  delayReqCount[bucket]++;
  if (delayReqCount[bucket] % 50 == 1)
  {
    SAFE_LOG("[SYNC] DELAY_REQ from node %d, seq=%lu\n", req->nodeId,
             req->sequenceNum);
  }

  // Send response immediately (minimize T3-T2 processing delay)
  sendDelayResp(req->nodeId, req->sequenceNum, req->nodeT1Tsf, t2);
}

void SyncManager::sendDelayResp(uint8_t nodeId, uint32_t sequenceNum,
                                uint64_t nodeT1, uint64_t gatewayT2)
{
  TDMADelayRespPacket resp;
  resp.type = TDMA_PACKET_DELAY_RESP;
  resp.nodeId = nodeId;
  resp.sequenceNum = sequenceNum;
  resp.nodeT1Tsf = nodeT1;
  resp.gatewayT2Tsf = gatewayT2;

  // Capture T3 just before sending (minimize delay between capture and TX)
  // Use micros() since TSF is not available without WiFi AP connection
  resp.gatewayT3Tsf = (uint64_t)micros();

  // Send to broadcast (node will filter by nodeId)
  // TODO: If we have node MAC addresses cached, could send unicast for
  // efficiency
  uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

  esp_err_t result =
      esp_now_send(broadcastAddress, (uint8_t *)&resp, sizeof(resp));
  if (result != ESP_OK)
  {
    SAFE_LOG("[SYNC] DELAY_RESP send failed: 0x%X\n", result);
  }
}
// ============================================================================

// ============================================================================
// SYNC FRAME SUPPORT - Get expected sensors for cross-node synchronization
// ============================================================================

uint8_t SyncManager::getExpectedSensorCount() const
{
  uint8_t totalSensors = 0;
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered)
    {
      totalSensors += registeredNodes[i].sensorCount;
    }
  }
  return totalSensors;
}

uint8_t SyncManager::getExpectedSensorIds(uint8_t *sensorIds,
                                          uint8_t maxCount) const
{
  uint8_t idx = 0;
  for (int i = 0; i < TDMA_MAX_NODES && idx < maxCount; i++)
  {
    if (registeredNodes[i].registered)
    {
      uint8_t sensorCount = registeredNodes[i].sensorCount;

      // Use gateway-local compact IDs to guarantee uniqueness even if
      // nodeId ranges overlap (e.g., node A: 88..93 and node B: 92..94).
      for (uint8_t s = 0; s < sensorCount && idx < maxCount; s++)
      {
        sensorIds[idx] = (uint8_t)(idx + 1);
        idx++;
      }
    }
  }
  return idx;
}

uint8_t SyncManager::getCompactSensorId(uint8_t nodeId,
                                        uint8_t localSensorIndex) const
{
  uint8_t compactBase = 0;

  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (!registeredNodes[i].registered)
    {
      continue;
    }

    const uint8_t sensorCount = registeredNodes[i].sensorCount;

    if (registeredNodes[i].nodeId == nodeId)
    {
      if (localSensorIndex >= sensorCount)
      {
        return 0;
      }
      return (uint8_t)(compactBase + localSensorIndex + 1);
    }

    compactBase = (uint8_t)(compactBase + sensorCount);
  }

  return 0;
}
// ============================================================================

// ============================================================================
// SYNC RESET - Force all nodes to reset their timing state
// ============================================================================
// Called when:
//   - Gateway starts streaming (web app connects)
//   - Recording starts
//   - Calibration begins
//
// Sets syncResetBeaconsRemaining to broadcast SYNC_RESET for multiple beacons.
// This ensures ALL nodes receive the reset even with packet loss (~10%).
// Nodes seeing SYNC_FLAG_RESET_MASK will reset their timing state.
// ============================================================================
void SyncManager::triggerSyncReset()
{
  // Broadcast SYNC_RESET for 10 beacons (200ms at 50Hz)
  // With 10% packet loss, probability of a node missing ALL 10 = 0.1^10 ≈
  // 0.00000001%
  syncResetBeaconsRemaining = 10;
  SAFE_PRINTLN(
      "[SYNC] triggerSyncReset() called - will broadcast reset for 10 beacons");

  // CRITICAL FIX: Mark frame number for reset, but don't reset here!
  // The actual reset happens in sendTDMABeacon() to avoid race condition.
  // If we reset here, a beacon might already be mid-construction with the old
  // value.
  syncResetFrameNumberPending = true;

  // Reset SyncFrameBuffer statistics for clean metrics
  // (The buffer itself is reset by init() in onStartStreaming)
}
// ============================================================================

// ============================================================================
// OPP-8: Pre-registration Node Topology Persistence (NVS)
// ============================================================================
// Saves/loads the registeredNodes[] array to NVS so the Gateway can
// restore known node topology on reboot. This allows:
// - Shortened discovery phase (3s instead of 10s) when expected nodes rejoin
// - Immediate slot assignment for previously known nodes
//
// NVS namespace: "tdma_topo" (separate from "imu_config")
// Keys: "nodeCount" (uint8_t) + "node0".."node7" (binary blobs)
//
// Persisted fields per node (26 bytes):
//   nodeId(1) + sensorCount(1) + hasMag(1) + hasBaro(1) + nodeName(16) + mac(6)
// Runtime fields (slotOffsetUs, slotWidthUs, lastHeard, registered) are
// recomputed at boot.
// ============================================================================

// Compact struct for NVS storage (no padding, no runtime fields)
struct __attribute__((packed)) NVSNodeEntry
{
  uint8_t nodeId;
  uint8_t sensorCount;
  uint8_t hasMag;
  uint8_t hasBaro;
  char nodeName[16];
  uint8_t mac[6];
};

static const char *TOPO_NVS_NS = "tdma_topo";

void SyncManager::saveTopologyToNVS()
{
  Preferences prefs;
  if (!prefs.begin(TOPO_NVS_NS, false)) // read-write
  {
    SAFE_PRINTLN("[TDMA-NVS] Failed to open NVS namespace for write");
    return;
  }

  // Count active nodes and save each
  uint8_t saveCount = 0;
  for (int i = 0; i < TDMA_MAX_NODES; i++)
  {
    if (registeredNodes[i].registered)
    {
      NVSNodeEntry entry;
      entry.nodeId = registeredNodes[i].nodeId;
      entry.sensorCount = registeredNodes[i].sensorCount;
      entry.hasMag = registeredNodes[i].hasMag ? 1 : 0;
      entry.hasBaro = registeredNodes[i].hasBaro ? 1 : 0;
      memcpy(entry.nodeName, registeredNodes[i].nodeName, 16);
      memcpy(entry.mac, registeredNodes[i].mac, 6);

      char key[8];
      snprintf(key, sizeof(key), "node%d", i);
      prefs.putBytes(key, &entry, sizeof(NVSNodeEntry));
      saveCount++;
    }
  }

  prefs.putUChar("nodeCount", saveCount);
  prefs.end();

  SAFE_LOG("[TDMA-NVS] Saved %d nodes to NVS\n", saveCount);
}

void SyncManager::loadTopologyFromNVS()
{
  Preferences prefs;
  if (!prefs.begin(TOPO_NVS_NS, true)) // read-only
  {
    SAFE_PRINTLN("[TDMA-NVS] No persisted topology found");
    return;
  }

  uint8_t savedCount = prefs.getUChar("nodeCount", 0);
  if (savedCount == 0)
  {
    prefs.end();
    SAFE_PRINTLN("[TDMA-NVS] No nodes in persisted topology");
    return;
  }

  // Load nodes into registeredNodes[] array
  uint8_t loaded = 0;
  for (int i = 0; i < TDMA_MAX_NODES && loaded < savedCount; i++)
  {
    char key[8];
    snprintf(key, sizeof(key), "node%d", i);

    NVSNodeEntry entry;
    size_t readLen = prefs.getBytes(key, &entry, sizeof(NVSNodeEntry));
    if (readLen == sizeof(NVSNodeEntry))
    {
      registeredNodes[i].nodeId = entry.nodeId;
      registeredNodes[i].sensorCount = entry.sensorCount;
      registeredNodes[i].hasMag = entry.hasMag != 0;
      registeredNodes[i].hasBaro = entry.hasBaro != 0;
      memcpy(registeredNodes[i].nodeName, entry.nodeName, 16);
      registeredNodes[i].nodeName[15] = '\0'; // Safety null-terminate
      memcpy(registeredNodes[i].mac, entry.mac, 6);
      registeredNodes[i].registered = true;
      registeredNodes[i].lastHeard = millis(); // Mark as "just seen"
      registeredNodes[i].slotOffsetUs = 0;     // Will be recalculated
      registeredNodes[i].slotWidthUs = 0;      // Will be recalculated
      loaded++;

      SAFE_LOG("[TDMA-NVS] Loaded node %d (%s) with %d sensors\n", entry.nodeId,
               entry.nodeName, entry.sensorCount);
    }
  }

  prefs.end();

  nodeCount = loaded;
  preRegisteredNodeCount = loaded;
  SAFE_LOG("[TDMA-NVS] Restored %d nodes from NVS\n", loaded);
}

void SyncManager::clearPersistedTopology()
{
  Preferences prefs;
  if (prefs.begin(TOPO_NVS_NS, false))
  {
    prefs.clear();
    prefs.end();
    preRegisteredNodeCount = 0;
    SAFE_PRINTLN("[TDMA-NVS] Cleared persisted topology");
  }
}
// ============================================================================

// ============================================================================
// DISCOVERY LOCK — Late-Join Control
// ============================================================================

void SyncManager::setDiscoveryLocked(bool locked)
{
  discoveryLocked = locked;
  SAFE_LOG("[TDMA] Discovery %s\n", locked ? "LOCKED" : "UNLOCKED");

  if (!locked)
  {
    // When unlocking, auto-admit any pending nodes
    for (int i = 0; i < MAX_PENDING_NODES; i++)
    {
      if (pendingNodes[i].occupied)
      {
        SAFE_LOG("[TDMA] Auto-admitting pending node %d on unlock\n",
                 pendingNodes[i].nodeId);
        pendingNodes[i].occupied = false;
      }
    }
  }
}

uint8_t SyncManager::getPendingNodeCount() const
{
  uint8_t count = 0;
  for (int i = 0; i < MAX_PENDING_NODES; i++)
  {
    if (pendingNodes[i].occupied)
      count++;
  }
  return count;
}

bool SyncManager::addPendingNode(uint8_t nodeId, uint8_t sensorCount,
                                 bool hasMag, bool hasBaro,
                                 const char *name, const uint8_t *mac)
{
  // Check if this node is already pending (update timestamp)
  for (int i = 0; i < MAX_PENDING_NODES; i++)
  {
    if (pendingNodes[i].occupied &&
        memcmp(pendingNodes[i].mac, mac, 6) == 0)
    {
      pendingNodes[i].requestedAt = millis();
      return true; // Already queued, don't re-notify
    }
  }

  // Find empty slot
  for (int i = 0; i < MAX_PENDING_NODES; i++)
  {
    if (!pendingNodes[i].occupied)
    {
      pendingNodes[i].nodeId = nodeId;
      pendingNodes[i].sensorCount = sensorCount;
      pendingNodes[i].hasMag = hasMag;
      pendingNodes[i].hasBaro = hasBaro;
      strncpy(pendingNodes[i].nodeName, name, 15);
      pendingNodes[i].nodeName[15] = '\0';
      memcpy(pendingNodes[i].mac, mac, 6);
      pendingNodes[i].requestedAt = millis();
      pendingNodes[i].occupied = true;

      SAFE_LOG("[TDMA] Pending node %d (%s) queued in slot %d\n",
               nodeId, name, i);

      // Notify webapp
      if (onNodePending)
      {
        onNodePending(pendingNodes[i]);
      }
      return true;
    }
  }

  SAFE_PRINTLN("[TDMA] WARNING: Pending node queue full, ignoring");
  return false;
}

bool SyncManager::acceptPendingNode(uint8_t nodeId)
{
  for (int i = 0; i < MAX_PENDING_NODES; i++)
  {
    if (pendingNodes[i].occupied && pendingNodes[i].nodeId == nodeId)
    {
      SAFE_LOG("[TDMA] Accepting pending node %d (%s)\n",
               nodeId, pendingNodes[i].nodeName);

      // Feed the registration back through handleNodeRegistration
      // Temporarily unlock discovery for this admission
      bool wasLocked = discoveryLocked;
      discoveryLocked = false;

      // Build a minimal registration packet to re-process
      TDMARegisterPacket reg = {};
      reg.nodeId = pendingNodes[i].nodeId;
      reg.sensorCount = pendingNodes[i].sensorCount;
      reg.hasMag = pendingNodes[i].hasMag;
      reg.hasBaro = pendingNodes[i].hasBaro;
      strncpy(reg.nodeName, pendingNodes[i].nodeName, 15);
      reg.nodeName[15] = '\0';

      uint8_t mac[6];
      memcpy(mac, pendingNodes[i].mac, 6);

      // Clear from pending queue
      pendingNodes[i].occupied = false;

      // Re-process as normal registration
      handleNodeRegistration(mac, (const uint8_t *)&reg, sizeof(reg));

      // Restore lock state
      discoveryLocked = wasLocked;
      return true;
    }
  }

  SAFE_LOG("[TDMA] ACCEPT_NODE: nodeId %d not found in pending queue\n", nodeId);
  return false;
}

bool SyncManager::rejectPendingNode(uint8_t nodeId)
{
  for (int i = 0; i < MAX_PENDING_NODES; i++)
  {
    if (pendingNodes[i].occupied && pendingNodes[i].nodeId == nodeId)
    {
      SAFE_LOG("[TDMA] Rejecting pending node %d (%s)\n",
               nodeId, pendingNodes[i].nodeName);
      pendingNodes[i].occupied = false;
      return true;
    }
  }

  SAFE_LOG("[TDMA] REJECT_NODE: nodeId %d not found in pending queue\n", nodeId);
  return false;
}

bool SyncManager::isSessionKnownMAC(const uint8_t *mac) const
{
  for (uint8_t i = 0; i < sessionKnownMACCount; i++)
  {
    if (memcmp(sessionKnownMACs[i], mac, 6) == 0)
    {
      return true;
    }
  }
  return false;
}

void SyncManager::recordSessionMAC(const uint8_t *mac)
{
  // Don't duplicate
  if (isSessionKnownMAC(mac))
    return;

  if (sessionKnownMACCount < TDMA_MAX_NODES)
  {
    memcpy(sessionKnownMACs[sessionKnownMACCount], mac, 6);
    sessionKnownMACCount++;
  }
}

void SyncManager::clearSessionMACs()
{
  memset(sessionKnownMACs, 0, sizeof(sessionKnownMACs));
  sessionKnownMACCount = 0;
}
// ============================================================================
