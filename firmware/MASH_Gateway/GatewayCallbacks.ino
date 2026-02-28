/*******************************************************************************
 * GatewayCallbacks.ino - Command callbacks, LED helpers, serial command parsing
 *
 * This file is auto-concatenated to MASH_Gateway.ino by the Arduino build
 * system. All globals/types defined in the main .ino are visible here.
 ******************************************************************************/

// ============================================================================
// Status LED Colors
// ============================================================================

void setStatusColor(uint8_t r, uint8_t g, uint8_t b)
{
    if (boardHasNeoPixel)
    {
        statusLED.setPixelColor(0, statusLED.Color(r, g, b));
        statusLED.show();
    }
}

void showStartupAnimation()
{
    // Gateway-specific: Purple pulse
    for (int i = 0; i < 3; i++)
    {
        setStatusColor(50, 0, 50); // Purple
        delay(150);
        setStatusColor(0, 0, 0);
        delay(150);
    }
}

// ============================================================================
// Command Callbacks (Gateway-specific - limited functionality)
// ============================================================================

void onStartStreaming()
{
    if (!isStreaming)
    {
        Serial.println("[Gateway] Streaming enabled");
    }
    isStreaming = true;
    suppressSerialLogs = true;
    setStatusColor(0, 50, 50); // Cyan = Gateway streaming

    // ============================================================================
    // DEFERRED SYNC RESET: Don't fire immediately — wait until TDMA is RUNNING
    // and SyncFrameBuffer is initialized. ProtocolTask checks this flag and
    // fires ONE reset when all conditions are met. This prevents multiple
    // overlapping 200ms reset windows when nodes are still registering.
    // ============================================================================
    pendingSyncReset = true;
    syncManager.setStreaming(true);

    // BLE radio mode commands removed — nodes run TDMA-only (ENABLE_BLE=0)

    // ============================================================================
    // SYNC RECOVERY FIX: Don't restart TDMA if already running!
    // ============================================================================
    // Restarting wipes the node registration table, causing all nodes to be
    // pruned. Only start TDMA if it's not already in DISCOVERY, SYNC, or RUNNING.
    if (!syncManager.isTDMAActive())
    {
        syncManager.startTDMA();
    }
    else
    {
        Serial.println(
            "[TDMA] Already running - preserving existing node registrations");
    }
    // ============================================================================

    // ============================================================================
    // SYNC FRAME BUFFER INITIALIZATION
    // ============================================================================
    // Initialize the cross-node synchronization buffer with expected sensors.
    // This MUST happen after TDMA is running so we know which nodes are
    // registered.
    // ============================================================================
    if (useSyncFrameMode)
    {
        uint8_t expectedSensorIds[SYNC_MAX_SENSORS];
        uint8_t sensorCount =
            syncManager.getExpectedSensorIds(expectedSensorIds, SYNC_MAX_SENSORS);

        if (sensorCount > 0)
        {
            syncFrameBuffer.init(expectedSensorIds, sensorCount);
            syncFrameBufferInitialized = true;
            Serial.printf("[SyncFrame] Initialized with %d sensors: ", sensorCount);
            for (uint8_t i = 0; i < sensorCount; i++)
            {
                Serial.printf("%d ", expectedSensorIds[i]);
            }
            Serial.println();
        }
        else
        {
            Serial.println(
                "[SyncFrame] WARNING: No sensors registered yet - will retry");
            syncFrameBufferInitialized = false;
        }
    }
    // ============================================================================
}

void onStopStreaming()
{
    isStreaming = false;
    suppressSerialLogs = false;
    setStatusColor(50, 0, 50); // Purple = Gateway idle
    Serial.println("[Gateway] Streaming disabled");

    syncManager.setStreaming(false);
    pendingSyncReset = false; // Cancel any pending deferred sync reset

    // Keep TDMA running in standby mode (Warm Standby)
    // This prevents nodes from disconnecting and scanning channels
    if (!syncManager.isTDMAActive())
    {
        syncManager.startTDMA();
    }

    // Reset Sync Frame Buffer
    if (syncFrameBufferInitialized)
    {
        syncFrameBuffer.reset();
        syncFrameBufferInitialized = false;
        Serial.println("[SyncFrame] Buffer reset");
    }

    // BLE radio mode commands removed — nodes run TDMA-only (ENABLE_BLE=0)
}

void onSetSampleRate(uint16_t rateHz)
{
    // Gateway doesn't sample directly, but can forward this to nodes
    Serial.printf("[Gateway] Sample rate command received: %d Hz (ignored)\n",
                  rateHz);
}

void onSetAccelRange(uint8_t rangeG)
{
    Serial.printf("[Gateway] Accel range command received: %d g (ignored)\n",
                  rangeG);
}

void onSetGyroRange(uint16_t rangeDPS)
{
    Serial.printf("[Gateway] Gyro range command received: %d dps (ignored)\n",
                  rangeDPS);
}

void onSwitchMode(ConnectionMode mode)
{
    currentMode = mode;
    Serial.printf("[Gateway] Mode switched to: %s\n",
                  mode == MODE_BLE ? "SERIAL" : "WiFi");
}

void onGetStatus(JsonDocument &response)
{
    response["role"] = "gateway";
    response["isStreaming"] = isStreaming;
    response["mode"] = (currentMode == MODE_BLE) ? "serial" : "wifi";
    response["wifiConnected"] = wifiManager.isConnected();
    if (wifiManager.isConnected())
    {
        response["ipAddress"] = wifiManager.getIPAddress();
    }
    // Gateway doesn't have direct sensors
    response["sensorCount"] = 0;
    response["hasMagnetometer"] = false;
    response["hasBarometer"] = false;

    // ============================================================================
    // PHASE 0 INSTRUMENTATION: Serial Throughput Statistics
    // ============================================================================
    // These stats help identify bottlenecks and validate optimizations.
    // - frames: Total frames sent via BLE
    // - batches: Total batch notifications
    // - drops: Frames dropped due to queue overflow (should be 0 with 2M PHY)
    // - queueFree: Available slots in BLE TX queue
    // - queueSize: Total BLE TX queue capacity
    // - overloaded: True if experiencing sustained queue pressure
    // ============================================================================
    JsonObject throughput = response["throughput"].to<JsonObject>();
    throughput["frames"] = serialTxFrameCount;
    throughput["batches"] = serialTxBatchCount;
    throughput["drops"] = serialTxDropCount;
    throughput["queueFree"] =
        serialTxQueue ? uxQueueSpacesAvailable(serialTxQueue) : 0;
    throughput["queueSize"] = SERIAL_TX_QUEUE_SIZE;
    throughput["overloaded"] = serialQueueOverloaded;
}

// ============================================================================
// Sync Readiness Verification (GET_SYNC_STATUS command)
// ============================================================================
// Returns comprehensive TDMA + SyncFrameBuffer state for the webapp to
// verify that the system is ready before streaming. Includes per-node
// health, sync quality metrics, and a composite "ready" flag.
// ============================================================================
void onGetSyncStatus(JsonDocument &response)
{
    response["schema"] = "sync_status_v2_compact";

    // TDMA state
    response["tdmaState"] = syncManager.getTDMAStateName();
    response["isStreaming"] = isStreaming;

    // Node registry
    uint8_t nodeCount = syncManager.getRegisteredNodeCount();
    response["nodeCount"] = nodeCount;

    JsonArray nodes = response["nodes"].to<JsonArray>();
    const TDMANodeInfo *regNodes = syncManager.getRegisteredNodes();
    uint32_t now = millis();

    for (uint8_t i = 0; i < syncManager.getMaxNodes(); i++)
    {
        if (regNodes[i].registered)
        {
            JsonObject node = nodes.add<JsonObject>();
            node["nodeId"] = regNodes[i].nodeId;
            node["name"] = regNodes[i].nodeName;
            node["sensorCount"] = regNodes[i].sensorCount;
            node["hasMag"] = regNodes[i].hasMag;
            node["hasBaro"] = regNodes[i].hasBaro;
            node["lastHeardMs"] = now - regNodes[i].lastHeard;
            node["alive"] = (now - regNodes[i].lastHeard) < 5000;

            // IDENTITY FIX: Include compact sensor base ID so webapp can
            // map SyncFrame compact IDs (1,2,3...) back to this node.
            node["compactBase"] = syncManager.getCompactSensorId(
                regNodes[i].nodeId, 0);

            // MAC address as hex string
            char macStr[18];
            snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
                     regNodes[i].mac[0], regNodes[i].mac[1], regNodes[i].mac[2],
                     regNodes[i].mac[3], regNodes[i].mac[4], regNodes[i].mac[5]);
            node["mac"] = macStr;
        }
    }

    // SyncFrameBuffer metrics
    JsonObject sfb = response["syncBuffer"].to<JsonObject>();
    sfb["initialized"] = syncFrameBufferInitialized;
    sfb["expectedSensors"] = syncFrameBuffer.getExpectedSensorCount();
    sfb["completedFrames"] = syncFrameBuffer.getCompletedFrames();
    sfb["trulyComplete"] = syncFrameBuffer.getTrulyCompleteFrames();
    sfb["partialRecovery"] = syncFrameBuffer.getPartialRecoveryFrames();
    sfb["dropped"] = syncFrameBuffer.getDroppedFrames();
    sfb["incomplete"] = syncFrameBuffer.getIncompleteFrames();
    sfb["trueSyncRate"] = syncFrameBuffer.getTrueSyncRate();

    // Serial TX health
    JsonObject tx = response["serialTx"].to<JsonObject>();
    tx["frames"] = serialTxFrameCount;
    tx["drops"] = serialTxDropCount;
    tx["queueFree"] = serialTxQueue ? uxQueueSpacesAvailable(serialTxQueue) : 0;
    tx["paused"] = serialTxPaused;

    // ============================================================================
    // Composite readiness assessment
    // ============================================================================
    // Ready = TDMA running + at least 1 node alive + SyncFrameBuffer initialized
    // + data flowing (completedFrames > 0)
    // NOTE: sync quality is surfaced as diagnostic, not as a hard gate.
    // ============================================================================
    bool tdmaRunning = syncManager.isTDMARunning();
    bool hasAliveNodes = false;
    for (uint8_t i = 0; i < syncManager.getMaxNodes(); i++)
    {
        if (regNodes[i].registered && (now - regNodes[i].lastHeard) < 5000)
        {
            hasAliveNodes = true;
            break;
        }
    }
    bool bufferReady =
        syncFrameBufferInitialized && syncFrameBuffer.getCompletedFrames() > 0;
    float syncRate = syncFrameBuffer.getTrueSyncRate();
    bool syncQualityOk =
        syncRate > 50.0f || syncFrameBuffer.getCompletedFrames() < 10;

    response["ready"] =
        tdmaRunning && hasAliveNodes && bufferReady;

    // Readiness breakdown for debugging
    JsonObject readiness = response["readiness"].to<JsonObject>();
    readiness["tdmaRunning"] = tdmaRunning;
    readiness["hasAliveNodes"] = hasAliveNodes;
    readiness["bufferReady"] = bufferReady;
    readiness["syncQualityOk"] = syncQualityOk;
    readiness["syncRate"] = syncRate;

    // ========================================================================
    // Discovery Lock & Pending Nodes
    // ========================================================================
    response["discoveryLocked"] = syncManager.isDiscoveryLocked();

    uint8_t pendingCount = syncManager.getPendingNodeCount();
    response["pendingNodeCount"] = pendingCount;
}

void onCalibrate(uint8_t sensorId)
{
    Serial.printf("[Gateway] Calibration command for sensor %d (forwarding not "
                  "implemented)\n",
                  sensorId);
}

void onCalibrateGyro(uint8_t sensorId)
{
    Serial.printf("[Gateway] Zeroing Gyros for sensor %d (Broadcasting)\n",
                  sensorId);
    // Forward using CMD_GYRO_CALIBRATE (0x52)
    syncManager.sendMagCalibCommand(CMD_GYRO_CALIBRATE, sensorId);
}

// ============================================================================
// Discovery Lock Callbacks
// ============================================================================

void onDiscoveryLock(bool locked)
{
    syncManager.setDiscoveryLocked(locked);
}

// ============================================================================
// TDMA Re-scan
// ============================================================================

void onTDMARescan()
{
    SAFE_PRINTLN("[CMD] TDMA_RESCAN received - restarting discovery");
    syncManager.restartDiscovery();
}

bool onAcceptNode(uint8_t nodeId)
{
    bool ok = syncManager.acceptPendingNode(nodeId);
    if (ok)
    {
        // Trigger deferred sync reset so the new node's data gets
        // incorporated into the SyncFrameBuffer cleanly
        pendingSyncReset = true;
        syncFrameBuffer.reset();
    }
    return ok;
}

bool onRejectNode(uint8_t nodeId)
{
    return syncManager.rejectPendingNode(nodeId);
}

void onGetPendingNodes(JsonDocument &response)
{
    const auto *pNodes = syncManager.getPendingNodes();
    uint32_t now = millis();
    JsonArray pending = response["nodes"].to<JsonArray>();
    for (uint8_t i = 0; i < SyncManager::MAX_PENDING_NODES; i++)
    {
        if (pNodes[i].occupied)
        {
            JsonObject pn = pending.add<JsonObject>();
            pn["nodeId"] = pNodes[i].nodeId;
            pn["name"] = pNodes[i].nodeName;
            pn["sensorCount"] = pNodes[i].sensorCount;
            pn["hasMag"] = pNodes[i].hasMag;
            pn["hasBaro"] = pNodes[i].hasBaro;
            pn["waitingMs"] = now - pNodes[i].requestedAt;

            char macStr[18];
            snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
                     pNodes[i].mac[0], pNodes[i].mac[1], pNodes[i].mac[2],
                     pNodes[i].mac[3], pNodes[i].mac[4], pNodes[i].mac[5]);
            pn["mac"] = macStr;
        }
    }
    response["count"] = syncManager.getPendingNodeCount();
    response["discoveryLocked"] = syncManager.isDiscoveryLocked();
}

void onSetWiFi(const char *ssid, const char *password)
{
    Serial.printf("[Gateway] Setting WiFi credentials: %s\n", ssid);
    wifiManager.setCredentials(ssid, password);
    // Don't auto-connect here - let CONNECT_WIFI handle it
}

bool onConnectWiFi()
{
    Serial.println("[Gateway] Connecting to WiFi...");
    bool success = wifiManager.connect();
    if (success)
    {
        Serial.printf("[Gateway] WiFi connected! IP: %s\n",
                      wifiManager.getIPAddress().c_str());
        // Start the WiFi OTA server
        wifiOTAServer.init();
    }
    return success;
}

void onGetWiFiStatus(JsonDocument &response)
{
    bool staConnected = wifiManager.isConnected();
    bool apActive = wifiManager.isAPActive();

    response["connected"] = staConnected || apActive;

    if (staConnected)
    {
        response["ip"] = wifiManager.getIPAddress();
        response["rssi"] = wifiManager.getRSSI();
        response["mode"] = "station";
    }
    else if (apActive)
    {
        response["ip"] = WiFi.softAPIP().toString();
        response["rssi"] = 0;
        response["mode"] = "ap";
    }

    response["otaReady"] = wifiOTAServer.isRunning();
}

void onSetOutputMode(OutputMode mode)
{
    Serial.printf("[Gateway] Output mode command: %s (ignored)\n",
                  mode == OUTPUT_QUATERNION ? "quaternion" : "raw");
}

void onSetFilterBeta(float beta)
{
    Serial.printf("[Gateway] Filter beta command: %.3f (ignored)\n", beta);
}

void onSetName(const char *name)
{
    Serial.printf("[Gateway] Setting device name to: %s\n", name);
    preferences.begin("imu_config", false);
    preferences.putString("device_name", name);
    preferences.end();
    Serial.println("[Gateway] Name saved. Rebooting...");
    delay(1000);
    ESP.restart();
}

void onSetSyncRole(const char *role)
{
    if (strcmp(role, "master") == 0)
    {
        syncManager.setRole(SYNC_ROLE_MASTER);
    }
    else if (strcmp(role, "slave") == 0)
    {
        syncManager.setRole(SYNC_ROLE_SLAVE);
    }
    else
    {
        syncManager.setRole(SYNC_ROLE_AUTO);
    }
}

void onGetCalibration(uint8_t sensorId, JsonDocument &response)
{
    response["error"] = "Gateway does not have local sensors";
}

void onSetZupt(float gyroThresh, float accelThresh, int minFrames)
{
    Serial.println("[Gateway] ZUPT command received (ignored)");
}

// ============================================================================
// USB Serial Command Processing
// ============================================================================

static void processSerialCommands()
{
    while (Serial.available() > 0)
    {
        const char c = static_cast<char>(Serial.read());
        if (c == '\n')
        {
            String cmd = serialCommandBuffer;
            serialCommandBuffer = "";
            cmd.trim();
            if (cmd.length() > 0)
            {
                // OPP-7: Fast-path PAUSE/RESUME flow control (skip JSON parsing)
                if (cmd.indexOf("\"PAUSE\"") >= 0 || cmd == "PAUSE")
                {
                    serialTxPaused = true;
                    serialPauseCount++;
                    SAFE_LOG("[FlowCtrl] PAUSED (count=%lu)\n", serialPauseCount);
                    enqueueJsonFrame("{\"type\":\"flow\",\"status\":\"paused\"}");
                }
                else if (cmd.indexOf("\"RESUME\"") >= 0 || cmd == "RESUME")
                {
                    serialTxPaused = false;
                    serialResumeCount++;
                    SAFE_LOG("[FlowCtrl] RESUMED (count=%lu)\n", serialResumeCount);
                    enqueueJsonFrame("{\"type\":\"flow\",\"status\":\"resumed\"}");
                }
                else
                {
                    String response = commandHandler.processCommand(cmd);
                    enqueueJsonFrame(response);
                }
            }
        }
        else if (c != '\r')
        {
            if (serialCommandBuffer.length() < 512)
            {
                serialCommandBuffer += c;
            }
            else
            {
                serialCommandBuffer = "";
            }
        }
    }
}
