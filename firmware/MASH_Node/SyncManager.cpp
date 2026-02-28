// IMPORTANT: Define DEVICE_ROLE before including Config.h
// This is needed because .cpp files are compiled separately from .ino
#define DEVICE_ROLE DEVICE_ROLE_NODE

#include "SyncManager.h"
#include "OTAManager.h"
#include "PowerStateManager.h"
#include "SensorManager.h"
#include <Preferences.h> // For auto-ID collision resolution (save custom_node_id)
#include <esp_wifi.h>    // For esp_wifi_set_channel() and esp_wifi_get_tsf_time()

// Global pointer for the static callback to find the instance
static SyncManager *globalSyncManager = nullptr;

// Include TimingGlobals to share timing metrics with main loop
#include "TimingGlobals.h"

// ============================================================================
// PHY RATE PINNING â€” Force 802.11g 6 Mbps OFDM for deterministic TDMA slots
// ============================================================================
// ESP-NOW broadcast peers are locked to 1 Mbps (802.11b).  Unicast peers may
// auto-negotiate higher rates, but the TDMA slot budget depends on KNOWN
// airtime.  We explicitly pin the Gateway unicast peer to 802.11g 6 Mbps so:
//   1. Slot width calculations match actual RF behaviour
//   2. OFDM preamble (20Âµs) replaces DSSS preamble (192Âµs) per TX
//   3. Mux-node payloads (6 sensors Ã— 4 samples = 609 bytes) fit in 20ms frame
// ============================================================================
void pinEspNowPhyRate(const uint8_t *peerMac)
{
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 1, 0)
  esp_now_rate_config_t rateConfig = {};
  rateConfig.phymode = WIFI_PHY_MODE_11G;
  rateConfig.rate = WIFI_PHY_RATE_6M;
  rateConfig.ersu = false;
  esp_err_t err = esp_now_set_peer_rate_config(peerMac, &rateConfig);
  if (err != ESP_OK)
  {
    Serial.printf("[PHY] Rate pin FAILED for %02X:%02X:%02X:%02X:%02X:%02X: 0x%X\n",
                  peerMac[0], peerMac[1], peerMac[2],
                  peerMac[3], peerMac[4], peerMac[5], err);
  }
  else
  {
    Serial.printf("[PHY] Pinned 802.11g 6Mbps for %02X:%02X:%02X:%02X:%02X:%02X\n",
                  peerMac[0], peerMac[1], peerMac[2],
                  peerMac[3], peerMac[4], peerMac[5]);
  }
#else
  (void)peerMac;
  Serial.println("[PHY] Rate pinning requires ESP-IDF >= 5.1 â€” skipped");
#endif
}

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
    // Pass sender MAC for auto-discovery of Gateway
    globalSyncManager->onPacketReceived(recv_info->src_addr, incomingData, len);
  }
}
#else
// Old callback signature for ESP-IDF 4.x / Arduino ESP32 2.x
void OnDataRecv(const uint8_t *mac_addr, const uint8_t *incomingData, int len)
{
  if (globalSyncManager)
  {
    // Pass sender MAC for auto-discovery of Gateway
    globalSyncManager->onPacketReceived(mac_addr, incomingData, len);
  }
}
#endif

// ============================================================================
// STABILITY FIX: ESP-NOW Send Callback for TX Pacing
// ESP-IDF 5.x (Arduino ESP32 3.x) uses wifi_tx_info_t instead of mac address
// ============================================================================
#if ESP_IDF_VERSION_MAJOR >= 5
// New callback signature for ESP-IDF 5.x / Arduino ESP32 3.x
void SyncManager::onEspNowSent(const wifi_tx_info_t *tx_info,
                               esp_now_send_status_t status)
{
  if (globalSyncManager)
  {
    portENTER_CRITICAL(&globalSyncManager->syncStateLock);
    if (g_txStartTime > 0)
    {
      uint32_t dur = micros() - g_txStartTime;
      if (dur > g_txAirTimeMax)
        g_txAirTimeMax = dur;
      g_txStartTime = 0;
    }
    globalSyncManager->txPending = false;
    if (status == ESP_NOW_SEND_SUCCESS)
    {
      // EXPERT REVIEW FIX: Reset consecutive failures on success
      // so Zombie detection can track continuous failure runs.
      globalSyncManager->consecutiveSendFailures = 0;
    }
    else
    {
      globalSyncManager->sendFailCount++;
      globalSyncManager->consecutiveSendFailures++;
    }
    portEXIT_CRITICAL(&globalSyncManager->syncStateLock);
  }
}
#else
// Old callback signature for ESP-IDF 4.x / Arduino ESP32 2.x
void SyncManager::onEspNowSent(const uint8_t *mac,
                               esp_now_send_status_t status)
{
  if (globalSyncManager)
  {
    portENTER_CRITICAL(&globalSyncManager->syncStateLock);
    if (g_txStartTime > 0)
    {
      uint32_t dur = micros() - g_txStartTime;
      if (dur > g_txAirTimeMax)
        g_txAirTimeMax = dur;
      g_txStartTime = 0;
    }
    globalSyncManager->txPending = false;
    if (status == ESP_NOW_SEND_SUCCESS)
    {
      // EXPERT REVIEW FIX: Reset consecutive failures on success
      globalSyncManager->consecutiveSendFailures = 0;
    }
    else
    {
      globalSyncManager->sendFailCount++;
      globalSyncManager->consecutiveSendFailures++;
    }
    portEXIT_CRITICAL(&globalSyncManager->syncStateLock);
  }
}
#endif

SyncManager::SyncManager()
    : currentRole(SYNC_ROLE_AUTO), timeOffset(0), lastSyncSend(0),
      otaManager(nullptr), nodeId(0), cachedSensorCount(0),
      powerStateManager(nullptr),
      gatewayMacDiscovered(false), // Will be set true when we hear a beacon
      tdmaNodeState(TDMA_NODE_UNREGISTERED), currentFrameNumber(0),
      lastBeaconTime(0), lastBeaconMillis(0), mySlotOffsetUs(0),
      mySlotWidthUs(0), lastRegistrationTime(0), registeredStateStartTime(0),
      lastGatewayState(0), consecutiveBeaconLosses(0), lastSyncCheckTime(0),
      inRecoveryMode(false), recoveryModeStartTime(0), lastKnownChannel(1),
      beaconGatewayTimeUs(0),
      samplesSinceBeacon(
          0), // Beacon-derived timestamp system (legacy fallback)
      localTsfAtBeaconRx(0), tsfOffset(0),
      tsfSyncValid(false), // TSF hardware sync
      bufferedSampleFrameNumber(0), nextSampleIndexInFrame(0),
      beaconSequence(0), lastBufferedBeaconSequence(0), frameQueueTail(0),
      frameQueueCount(0), smoothedOffset(0),
      // Phase 0: Two-way sync state initialization with statistical filtering
      delayReqSequence(0), lastDelayReqTime(0), pendingT1(0),
      pendingSequence(0), awaitingDelayResp(false), twoWayOffset(0),
      lastTwoWaySyncTime(0), lastRttUs(0),
      syncProtocolVersion(SYNC_PROTOCOL_VERSION_LEGACY), offsetSampleIndex(0),
      validSampleCount(0), avgRttUs(0), channelScanStart(0),
      currentScanChannel(0), txPending(false), sendFailCount(0),
      currentBufferPolicy(POLICY_LIVE), prevSampleValid(false),
      deltaOverflowCount(0),
      // Pipelined packet building state
      pipelinePacketSize(0), pipelineSamplesConsumed(0),
      pipelinePacketReady(false),
      // Deferred operation flags
      pendingReboot(false), pendingRebootNodeId(0),
      pendingReRegistration(false), pendingDelayReq(false)
{
  globalSyncManager = this;

  // ============================================================================
  // BUG 1 FIX: Create FreeRTOS mutex for buffer protection
  // ============================================================================
  // Protects sampleBuffer and pipeline state from concurrent access between
  // bufferSample() (Core 1 / loop) and sendTDMAData() (Core 0 / ProtocolTask).
  // ============================================================================
  bufferMutex = xSemaphoreCreateMutex();
  if (bufferMutex == nullptr)
  {
    Serial.println("[FATAL] Failed to create bufferMutex!");
  }

  // Initialize statistical filter arrays
  memset(offsetSamples, 0, sizeof(offsetSamples));
  memset(rttSamples, 0, sizeof(rttSamples));

  // Initialize deterministic frame queue
  memset(frameQueue, 0, sizeof(frameQueue));

  // Initialize delta compression state
  memset(prevSample, 0, sizeof(prevSample));

  // Initialize pipeline packet buffer
  memset(pipelinePacket, 0, sizeof(pipelinePacket));

  // Initialize Gateway MAC to broadcast (will be auto-discovered from beacon)
  // This allows sending before we know the actual Gateway MAC
  memset(gatewayMac, 0xFF, sizeof(gatewayMac));
}

void SyncManager::init(const char *deviceName)
{
  // ESP-NOW requires Wi-Fi to be on.
  // We use WIFI_STA (Station) mode so we don't create an AP.
  WiFi.mode(WIFI_STA);

  // Set initial WiFi channel - start on channel 1, will scan if no beacons
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  Serial.println("[Sync] Initial WiFi channel set to 1 (will scan if needed)");
  channelScanStart = millis();

  // Init ESP-NOW
  if (esp_now_init() != ESP_OK)
  {
    Serial.println("[Sync] Error initializing ESP-NOW");
    return;
  }

  // Register receive callback
  esp_now_register_recv_cb(OnDataRecv);

  // ============================================================================
  // STABILITY FIX: Register send callback for TX pacing
  // ============================================================================
  esp_now_register_send_cb(SyncManager::onEspNowSent);
  Serial.println("[Sync] ESP-NOW send callback registered (TX pacing enabled)");

  // If we are a NODE, register broadcast peer initially.
  // The actual Gateway MAC will be auto-discovered from beacon packets!
#if DEVICE_ROLE == DEVICE_ROLE_NODE
  // Use broadcast initially - Gateway MAC will be learned from first beacon
  uint8_t broadcastMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
  if (!esp_now_is_peer_exist(broadcastMac))
  {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, broadcastMac, 6);
    peerInfo.channel = ESP_NOW_CHANNEL;
    peerInfo.ifidx =
        WIFI_IF_STA; // CRITICAL: Explicitly match interface for startup
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }
  Serial.println("[Sync] Node Mode: Broadcast peer registered (awaiting "
                 "Gateway discovery)");
#endif

  Serial.println("[Sync] ESP-NOW Initialized");
}

void SyncManager::reinitEspNow()
{
  // ============================================================================
  // CRITICAL FAIL-SAFE (v10): System Reboot on Persistent Failure
  // ============================================================================
  // If we are calling this function again within 10 seconds, it means the
  // previous radio reset failed to clear the error. The hardware or driver
  // state is likely corrupted beyond software recovery. Force a system reboot.
  // ============================================================================
  static uint32_t lastReinitTime = 0;
  if (lastReinitTime > 0 && millis() - lastReinitTime < 10000)
  {
    Serial.println(
        "[RECOVERY] Critical Failure: Radio reset ineffective. System "
        "Reboot in 100ms!");
    delay(100);
    ESP.restart();
  }
  lastReinitTime = millis();

  // ============================================================================
  // AGGRESSIVE RADIO RESET (v10)
  // ============================================================================
  // 0x3067 (ESP_ERR_ESPNOW_IF) indicates an interface mismatch or driver
  // corruption. We perform a full driver cycle using Arduino APIs to ensure
  // state consistency.
  // ============================================================================
  Serial.println("[RECOVERY] *** FULL RADIO RESET (v10) ***");
  Serial.println("[RECOVERY] Stopping WiFi Driver...");

  esp_now_deinit();
  WiFi.mode(WIFI_OFF);

  // Give hardware time to settle
  delay(100);

  Serial.println("[RECOVERY] Starting WiFi Driver...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(); // Ensure we don't auto-connect to AP

  // FORCE CHANNEL immediately after start to ensure we are on the correct
  // frequency
  uint8_t ch = lastKnownChannel > 0 ? lastKnownChannel : 1;
  esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  Serial.printf("[RECOVERY] Forced WiFi Channel to %d\n", ch);

  Serial.println("[RECOVERY] Re-initializing ESP-NOW...");
  if (esp_now_init() != ESP_OK)
  {
    Serial.println("[RECOVERY] FATAL: ESP-NOW init failed! Rebooting...");
    delay(100);
    ESP.restart();
    return;
  }

  // Re-register callbacks
  esp_now_register_recv_cb(OnDataRecv);
  esp_now_register_send_cb(SyncManager::onEspNowSent);

  // Re-add Broadcast Peer
  esp_now_peer_info_t peerInfo = {};
  memset(peerInfo.peer_addr, 0xFF, 6);
  peerInfo.channel = ESP_NOW_CHANNEL;
  peerInfo.ifidx = WIFI_IF_STA; // CRITICAL: Explicitly match interface
  peerInfo.encrypt = false;
  esp_now_add_peer(&peerInfo);

  // Re-add Gateway Peer if known
  if (gatewayMacDiscovered)
  {
    memset(&peerInfo, 0, sizeof(peerInfo));
    memcpy(peerInfo.peer_addr, gatewayMac, 6);
    peerInfo.channel = ch;
    peerInfo.ifidx = WIFI_IF_STA; // CRITICAL: Explicitly match interface
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
    pinEspNowPhyRate(gatewayMac); // Pin unicast to 802.11g 6 Mbps
    Serial.printf("[RECOVERY] Restored Gateway peer on ch %d\n",
                  peerInfo.channel);
  }

  // Ensure WiFi power save is disabled
  esp_wifi_set_ps(WIFI_PS_NONE);

  Serial.println("[RECOVERY] Radio reset complete. Resuming operations.");
}

void SyncManager::update()
{
  // ============================================================================
  // ============================================================================
  // BUG 5 FIX: Handle deferred operations from ESP-NOW callback context
  // ============================================================================

  // These flags are set by onPacketReceived() (WiFi task) and safely handled
  // here in the main loop context where delay/NVS/restart are safe.
  // ============================================================================
  bool doReboot = false;
  bool doReRegistration = false;
  bool doDelayReq = false;
  uint8_t rebootNodeId = 0;

  portENTER_CRITICAL(&syncStateLock);
  doReboot = pendingReboot;
  rebootNodeId = pendingRebootNodeId;
  pendingReboot = false;

  doReRegistration = pendingReRegistration;
  pendingReRegistration = false;

  doDelayReq = pendingDelayReq;
  pendingDelayReq = false;
  portEXIT_CRITICAL(&syncStateLock);

  if (doReboot)
  {
    Serial.println("[Sync] Applying new Node ID and rebooting...");
    Preferences prefs;
    prefs.begin("imu_config", false);
    prefs.putUChar("custom_node_id", rebootNodeId);
    prefs.end();
    delay(500);
    ESP.restart();
  }

  if (doReRegistration)
  {
    // Random delay (0-100ms) to prevent registration storm from multiple nodes
    delay(random(0, 100));
    sendTDMARegistration();
    lastRegistrationTime = millis();
  }

  // ==========================================================================
  // INT_WDT FIX v7: Deferred PTP DELAY_REQ from WiFi callback
  // ==========================================================================
  if (doDelayReq)
  {
    sendDelayReq();
  }

  // ============================================================================
  // FIX #5: IMPROVED CHANNEL SCANNING - Allow re-scanning if beacons are lost
  // ============================================================================
  if (tdmaNodeState == TDMA_NODE_UNREGISTERED)
  {
    uint32_t now = millis();
    uint32_t timeSinceLastBeacon =
        (lastBeaconMillis == 0) ? 0xFFFFFFFF : (now - lastBeaconMillis);

    // ========================================================================
    // CRITICAL FIX: Recovery mode - stay on last channel aggressively retrying
    // MODIFIED: Don't return early! Let beacon processing continue below.
    // ========================================================================
    if (inRecoveryMode)
    {
      uint32_t recoveryDuration = now - recoveryModeStartTime;

      // Aggressively retry registration every 500ms while in recovery
      if (now - lastRegistrationTime > 500)
      {
        // EXPERT REVIEW FIX (v9): Suppress registration retry when sends are
        // failing
        if (consecutiveSendFailures < 10)
        {
          sendTDMARegistration();
          lastRegistrationTime = now;
          Serial.println(
              "[RECOVERY] Retrying registration on last known channel...");
        }
      }

      // After 15 seconds of failed recovery, give up and start channel scanning
      if (recoveryDuration > 15000)
      {
        Serial.println("[RECOVERY] Timeout! Falling back to channel scanning.");
        inRecoveryMode = false;
        // Reset beacon tracking to trigger fresh channel scan
        lastBeaconMillis = 0;
        channelScanStart = 0;   // Force immediate channel switch
        currentScanChannel = 0; // Start from channel 1
      }

      // REMOVED: return; - Must NOT skip beacon/schedule processing!
      // Recovery should retry registration while still listening for beacons
      // Fall through to beacon processing below
    }
    // ========================================================================

    // If no beacon in last 3 seconds, scan channels
    // This allows re-scanning if Node loses Gateway after initial beacon
    // reception
    if (timeSinceLastBeacon > 3000)
    {
      // Scan channels 1, 6, 11 (most common WiFi channels), then 2-10
      static const uint8_t scanChannels[] = {1, 6, 11, 2, 3, 4, 5, 7, 8, 9, 10};
      static const int numChannels =
          sizeof(scanChannels) / sizeof(scanChannels[0]);

      uint32_t timeSinceScan = now - channelScanStart;

      // Spend 500ms on each channel before moving to next
      if (timeSinceScan > 500)
      {
        currentScanChannel = (currentScanChannel + 1) % numChannels;
        uint8_t newChannel = scanChannels[currentScanChannel];
        esp_wifi_set_channel(newChannel, WIFI_SECOND_CHAN_NONE);
        Serial.printf("[Sync] Scanning channel %d for Gateway beacons...\n",
                      newChannel);
        channelScanStart = now;
      }
    }
  }

  // ============================================================================
  // TDMA Mode - If we've received beacons, participate in TDMA
  // ============================================================================
  if (tdmaNodeState != TDMA_NODE_UNREGISTERED)
  {
    uint32_t now = millis();

    // ========================================================================
    // SYNC RECOVERY: Periodic health check
    // ========================================================================
    checkSyncHealth();
    // ========================================================================

    // REMOVED OLD 2S TIMEOUT - Sync recovery now handles beacon loss with
    // 5s timeout and auto re-registration. The old code would revert to
    // UNREGISTERED before recovery could trigger!

    // If registered but not synced, keep sending registrations until we get a
    // schedule
    if (tdmaNodeState == TDMA_NODE_REGISTERED)
    {
      if (now - lastRegistrationTime > 500)
      {
        sendTDMARegistration();
        lastRegistrationTime = now;
      }

      // FALLBACK: If we've been in REGISTERED state for >10 seconds without
      // getting synced, the schedule might be getting lost. Fall back to
      // UNREGISTERED to trigger recovery.
      // INCREASED from 5s to 10s to avoid competing with checkSyncHealth's 5s
      // timeout
      if (registeredStateStartTime == 0)
      {
        registeredStateStartTime = now;
      }
      if (now - registeredStateStartTime > 10000)
      {
        Serial.println("[TDMA] Timeout waiting for schedule (10s), triggering "
                       "re-registration");
        if (tdmaNodeState != TDMA_NODE_UNREGISTERED)
        {
          tdmaNodeState = TDMA_NODE_UNREGISTERED;
          if (onStateChangeCallback)
            onStateChangeCallback(tdmaNodeState);
        }
        registeredStateStartTime = 0;
        // Don't reset lastBeaconMillis here - checkSyncHealth will handle
        // recovery
      }
    }
    else
    {
      // Reset the timeout tracker when not in REGISTERED state
      registeredStateStartTime = 0;
    }

    return; // Don't run legacy sync when TDMA is active
  }

  // ============================================================================
  // Legacy Mode - Simple 1Hz sync pulses (only if we're master, which is rare
  // for nodes)
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
  packet.masterTime = millis();
  packet.packetType = 0x01;

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

  // Use auto-discovered Gateway MAC (or broadcast if not yet discovered)
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
  packet.sensorIdOffset = nodeId;
  packet.sensorCount = sm.getSensorCount();
  packet.hasMag = sm.hasMag() ? 1 : 0;
  packet.hasBaro = sm.hasBaro() ? 1 : 0;
  packet.useMux = sm.isUsingMultiplexer() ? 1 : 0;
  sm.getSensorTopology(packet.sensorChannels);

  // Use auto-discovered Gateway MAC (or broadcast if not yet discovered)
  esp_now_send(gatewayMac, (uint8_t *)&packet, sizeof(packet));
#endif
}

void SyncManager::sendMagCalibProgress(SensorManager &sm)
{
#if DEVICE_ROLE == DEVICE_ROLE_NODE
  if (!sm.hasMag())
    return; // No magnetometer, nothing to send

  ESPNowMagCalibPacket packet;
  memset(&packet, 0, sizeof(packet));

  packet.type = MAG_CALIB_PACKET;
  packet.nodeId = nodeId;
  packet.progress = sm.getMagCalibrationProgress();
  packet.isCalibrating = sm.isMagCalibrating() ? 1 : 0;
  packet.isCalibrated = sm.isMagCalibrated() ? 1 : 0;

  // Include calibration data if available
  MagCalibrationData cal = sm.getMagCalibration();
  packet.hardIronX = cal.hardIronX;
  packet.hardIronY = cal.hardIronY;
  packet.hardIronZ = cal.hardIronZ;
  packet.softIronScaleX = cal.softIronScaleX;
  packet.softIronScaleY = cal.softIronScaleY;
  packet.softIronScaleZ = cal.softIronScaleZ;
  packet.sampleCount = cal.sampleCount;

  // Use auto-discovered Gateway MAC (or fallback to broadcast)
  esp_now_send(gatewayMac, (uint8_t *)&packet, sizeof(packet));
#endif
}

void SyncManager::onPacketReceived(const uint8_t *senderMac,
                                   const uint8_t *data, int len)
{
  if (len < 1)
    return;

  uint8_t type = data[0];

  // ============================================================================
  // DEBUG: Log all received packets to diagnose schedule reception issues
  // ============================================================================
  static uint32_t packetCounts[256] = {0};
  packetCounts[type]++;
  static unsigned long lastPacketLog = 0;
  if (millis() - lastPacketLog > 5000)
  {
    Serial.printf("[DEBUG] Packets received - BEACON(0x20):%lu "
                  "SCHEDULE(0x22):%lu REG(0x21):%lu DATA(0x23):%lu\n",
                  packetCounts[0x20], packetCounts[0x22], packetCounts[0x21],
                  packetCounts[0x23]);
    lastPacketLog = millis();
  }
  // ============================================================================

  // ============================================================================
  // AUTO-DISCOVER GATEWAY MAC from beacon packets
  // ============================================================================
  if (type == TDMA_PACKET_BEACON && !gatewayMacDiscovered &&
      senderMac != nullptr)
  {
    // Learn Gateway MAC from the first beacon we receive
    memcpy(gatewayMac, senderMac, 6);
    gatewayMacDiscovered = true;

    // Register Gateway as ESP-NOW peer with actual MAC (enables ACKs!)
    if (!esp_now_is_peer_exist(gatewayMac))
    {
      esp_now_peer_info_t peerInfo = {};
      memcpy(peerInfo.peer_addr, gatewayMac, 6);
      peerInfo.channel = ESP_NOW_CHANNEL;
      peerInfo.encrypt = false;
      esp_now_add_peer(&peerInfo);
      pinEspNowPhyRate(gatewayMac); // Pin unicast to 802.11g 6 Mbps
    }

    Serial.printf("[Sync] *** AUTO-DISCOVERED Gateway MAC: "
                  "%02X:%02X:%02X:%02X:%02X:%02X ***\n",
                  gatewayMac[0], gatewayMac[1], gatewayMac[2], gatewayMac[3],
                  gatewayMac[4], gatewayMac[5]);
  }
  // ============================================================================

  if (type == 0x01 && len == sizeof(SyncPacket))
  { // Legacy Sync Packet
    SyncPacket *packet = (SyncPacket *)data;
    if (currentRole != SYNC_ROLE_MASTER)
    {
      uint32_t now = micros(); // Use micros for precision
      int32_t newOffset = packet->masterTime - now;

      // Log sync updates periodically (every ~10 seconds)
      static unsigned long lastSyncLog = 0;
      if (millis() - lastSyncLog > 10000)
      {
        Serial.printf("[Sync] Sync pulse received: masterTime=%lu, "
                      "localTime=%lu, offset=%ld us\n",
                      packet->masterTime, now, newOffset);
        lastSyncLog = millis();
      }

      timeOffset = newOffset;
    }
  }
  // ============================================================================
  // TDMA Packet Handling
  // ============================================================================
  // ============================================================================
  // TDMA Packet Handling
  // ============================================================================
  else if (type == TDMA_PACKET_BEACON)
  {
    // RELAXED CHECK: Allow if at least expected size (12 bytes)
    // ESP-NOW might add padding or be larger than expected
    if (len >= sizeof(TDMABeaconPacket))
    {
      handleTDMABeacon(data, len);
    }
    else
    {
      // Only log if it's actually too small (corruption/noise)
      Serial.printf("[Sync] Packet ignored: type=BEACON len=%d expected=%d\n",
                    len, sizeof(TDMABeaconPacket));
    }
  }
  else if (type == TDMA_PACKET_SCHEDULE)
  {
    // RELAXED CHECK: Allow if at least header size (3 bytes)
    // Variable length schedules might trigger strict size mismatch
    if (len >= 3)
    {
      handleTDMASchedule(data, len);
    }
    else
    {
      Serial.printf("[Sync] Packet ignored: type=SCHEDULE len=%d expected>=3\n",
                    len);
    }
  }
  // Handle Radio Mode command from Gateway
  else if (type == RADIO_MODE_PACKET && len == sizeof(ESPNowRadioModePacket))
  {
    ESPNowRadioModePacket *packet = (ESPNowRadioModePacket *)data;
    Serial.printf("[Sync] Received radio mode command: %s\n",
                  packet->mode == RADIO_MODE_BLE_OFF ? "BLE_OFF" : "BLE_ON");
    if (onRadioModeCallback)
    {
      onRadioModeCallback(packet->mode);
    }
  }
  // Handle Command Forward packet from Gateway (0x08)
  else if (type == CMD_FORWARD_PACKET && len == sizeof(ESPNowCmdPacket))
  {
    ESPNowCmdPacket *packet = (ESPNowCmdPacket *)data;
    Serial.printf(
        "[Sync] Received command forward: cmdType=%d param=%lu target=%d\n",
        packet->cmdType, packet->param1, packet->targetNode);

    // Check if this command is for us (broadcast or our nodeId)
    if (packet->targetNode == 0xFF || packet->targetNode == nodeId)
    {
      // Handle Magnetometer Calibration Commands
      if (onMagCalibCallback && (packet->cmdType == CMD_MAG_CALIBRATE ||
                                 packet->cmdType == CMD_MAG_CLEAR))
      {
        onMagCalibCallback(packet->cmdType, packet->param1);
      }
      // Handle Gyro Calibration Command
      else if (onMagCalibCallback && packet->cmdType == CMD_GYRO_CALIBRATE)
      {
        onMagCalibCallback(packet->cmdType, packet->param1);
      }
      // Handle AUTO-RESOLVED NODE ID ASSIGNMENT
      else if (packet->cmdType == CMD_SET_NODE_ID)
      {
        // Verify this command is for US by checking MAC discriminator in param2
        // param2 contains last 4 bytes of target MAC (standard network order)
        uint8_t myMac[6];
        esp_wifi_get_mac(WIFI_IF_STA, myMac); // Same format as ESP-NOW src_addr
        uint32_t myMacSuffix = ((uint32_t)myMac[2] << 24) |
                               ((uint32_t)myMac[3] << 16) |
                               ((uint32_t)myMac[4] << 8) | ((uint32_t)myMac[5]);

        if (packet->param2 == myMacSuffix)
        {
          uint8_t newId = (uint8_t)packet->param1;
          Serial.printf("[Sync] >>> RECEIVED AUTO-ID ASSIGNMENT: %d (MAC match "
                        "confirmed) <<<\n",
                        newId);

          // BUG 5 FIX: Defer NVS write and reboot to update() context.
          // ESP-NOW callbacks run in the WiFi task - delay() and NVS writes
          // block the radio stack and can cause watchdog resets.
          portENTER_CRITICAL(&syncStateLock);
          pendingRebootNodeId = newId;
          pendingReboot = true;
          portEXIT_CRITICAL(&syncStateLock);
        }
        else
        {
          Serial.printf(
              "[Sync] SET_NODE_ID not for us (myMAC=0x%08lX, target=0x%08lX)\n",
              myMacSuffix, packet->param2);
        }
      }
    }
  }
#if DEVICE_ROLE == DEVICE_ROLE_NODE
  // Handle OTA packets from Gateway
  else if (type == OTA_PACKET_BEGIN && len == sizeof(ESPNowOTABeginPacket))
  {
    if (otaManager)
    {
      ESPNowOTABeginPacket *packet = (ESPNowOTABeginPacket *)data;
      bool success = otaManager->handleBegin(*packet);
      ESPNowOTAAckPacket ack;
      ack.type = OTA_PACKET_ACK;
      ack.nodeId = nodeId;
      ack.status = success ? 0 : 1;
      ack.lastOffset = 0;
      ack.progress = 0;
      sendOTAAck(ack);
    }
  }
  else if (type == OTA_PACKET_DATA && len >= 6)
  {
    if (otaManager)
    {
      ESPNowOTADataPacket *packet = (ESPNowOTADataPacket *)data;
      ESPNowOTAAckPacket ack = otaManager->handleData(*packet);
      sendOTAAck(ack);
    }
  }
  else if (type == OTA_PACKET_END && len == sizeof(ESPNowOTAEndPacket))
  {
    if (otaManager)
    {
      ESPNowOTAEndPacket *packet = (ESPNowOTAEndPacket *)data;
      bool success = otaManager->handleEnd(*packet);
      ESPNowOTAAckPacket ack;
      ack.type = OTA_PACKET_ACK;
      ack.nodeId = nodeId;
      ack.status = success ? 0 : 1;
      ack.lastOffset = 0xFFFF; // Signal end
      ack.progress = 100;
      sendOTAAck(ack);
      if (success)
      {
        // EXPERT REVIEW FIX: delay(500) in WiFi callback blocks WiFi task
        // for 500ms, exceeding the 300ms INT_WDT threshold.
        // Defer reboot to update() context via pendingReboot flag.
        portENTER_CRITICAL(&syncStateLock);
        pendingReboot = true;
        portEXIT_CRITICAL(&syncStateLock);
      }
    }
  }
  else if (type == OTA_PACKET_ABORT)
  {
    if (otaManager)
    {
      otaManager->handleAbort();
    }
  }
#endif
  // ============================================================================
  // PHASE 0: Handle DELAY_RESP from Gateway (Two-Way Sync)
  // ============================================================================
  else if (type == TDMA_PACKET_DELAY_RESP &&
           len >= sizeof(TDMADelayRespPacket))
  {
    handleDelayResp(data, len);
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

void SyncManager::sendOTAAck(const ESPNowOTAAckPacket &ack)
{
#if DEVICE_ROLE == DEVICE_ROLE_NODE
  // Use auto-discovered Gateway MAC (or broadcast if not yet discovered)
  esp_now_send(gatewayMac, (uint8_t *)&ack, sizeof(ack));
#endif
}

uint32_t SyncManager::getAdjustedTime() { return micros() + timeOffset; }

void SyncManager::setRole(SyncRole role)
{
  currentRole = role;
  if (role == SYNC_ROLE_MASTER)
  {
    timeOffset = 0; // Masters use their own time
    Serial.println("[Sync] Role set to MASTER");
  }
  else
  {
    Serial.println("[Sync] Role set to SLAVE (listening)");
  }
}
