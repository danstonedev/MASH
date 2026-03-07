/*******************************************************************************
 * GatewayTasks.ino - FreeRTOS tasks, serial frame utilities, node data decoder
 *
 * This file is auto-concatenated to MASH_Gateway.ino by the Arduino build
 * system. All globals/types defined in the main .ino are visible here.
 *
 * Contents:
 *   - decodeNodeData()       — 0x26 node data packet decoder
 *   - enqueueSerialFrame()   — length-prefixed frame enqueue
 *   - enqueueJsonFrame()     — JSON command response enqueue
 *   - logJson()              — structured log during streaming
 *   - SerialTxTask()         — USB Serial TX drain (Core 0)
 *   - DataIngestionTask()    — ESP-NOW → SyncFrameBuffer (Core 1)
 *   - ProtocolTask()         — Beacon TX + Sync Frame emission (Core 0)
 ******************************************************************************/

// ============================================================================
// NODE DATA DECODER (0x26)
// ============================================================================
// Decodes 0x26 packets from Nodes and extracts absolute sensor samples.
// ============================================================================

// Decode Node data packet (0x26) to absolute values
// Returns number of samples decoded, or 0 on error
// Output: TDMABatchedSensorData array
uint8_t decodeNodeData(
    const uint8_t *inputPacket, size_t inputLen,
    TDMABatchedSensorData *outputSamples, // [sampleCount][sensorCount]
    uint8_t maxSamples, uint8_t maxSensors, uint8_t *outNodeId,
    uint32_t *outFrameNumber, uint8_t *outSensorCount)
{
    if (inputLen < TDMA_NODE_DATA_HEADER_SIZE)
    {
        return 0;
    }

    const TDMANodeDataPacket *header = (const TDMANodeDataPacket *)inputPacket;

    if (header->type != TDMA_PACKET_NODE_DATA)
    {
        return 0; // Not a node data packet
    }

    *outNodeId = header->nodeId;
    *outFrameNumber = header->frameNumber;
    *outSensorCount = header->sensorCount;

    uint8_t sampleCount = header->sampleCount;
    uint8_t sensorCount = header->sensorCount;
    uint8_t flags = header->flags;

    if (sampleCount > maxSamples || sensorCount > maxSensors)
    {
        return 0; // Buffer too small
    }

    const uint8_t *srcData = inputPacket + TDMA_NODE_DATA_HEADER_SIZE;
    size_t srcOffset = 0;

    // Verify keyframe-only mode
    bool allKeyframe = (flags & NODE_DATA_FLAG_KEYFRAME) != 0;

    // Available data bytes after header
    size_t availableData = (inputLen > TDMA_NODE_DATA_HEADER_SIZE)
                               ? (inputLen - TDMA_NODE_DATA_HEADER_SIZE)
                               : 0;

    // All nodes send keyframe-only. Reject anything else.
    if (!allKeyframe)
    {
        return 0;
    }

    // All samples are absolute - copy with bounds checking
    uint8_t validSamples = 0;
    for (uint8_t s = 0; s < sampleCount; s++)
    {
        bool sampleComplete = true;
        for (uint8_t i = 0; i < sensorCount; i++)
        {
            if (srcOffset + sizeof(TDMABatchedSensorData) > availableData)
            {
                sampleComplete = false;
                break; // Not enough data for this sensor
            }
            memcpy(&outputSamples[s * maxSensors + i], srcData + srcOffset,
                   sizeof(TDMABatchedSensorData));
            srcOffset += sizeof(TDMABatchedSensorData);
        }
        if (!sampleComplete)
            break;
        validSamples++;
    }
    return validSamples;
}

// ============================================================================
// REMOVED: encodeV3WithDelta() — AUDIT FIX 2026-02-08 (MOD-1)
// This function (lines 475-648) converted V1/V2 packets to V3 (0x24) format.
// It was NEVER CALLED — the Gateway uses SyncFrameBuffer to produce 0x25/0x27
// packets directly. The V3 0x24 format was never parsed by the webapp either.
// Removed along with: V3_NODE_SLOTS, V3_NODE_INDEX, prevSamples[],
// hasPrevSample[], prevSampleNodeId[], deltaOverflowCount, deltaSampleCount,
// enableV3Compression — all dead variables (~200 lines total).
// ============================================================================

// ============================================================================
// Serial TX Task - Drains queue and sends length-prefixed frames
// ============================================================================
// Runs on Core 0 (away from Wi-Fi task on Core 1) for optimal coexistence.
// Sends a raw byte stream with length-prefixed frames.
// CRITICAL: Each frame (length prefix + data) must be in a SINGLE queue entry!
// ============================================================================

static constexpr uint8_t PACKET_JSON = 0x06;

// Enqueue a complete length-prefixed frame as a single atomic unit.
// Note: Pause gating is intentionally disabled during bring-up to avoid
// deadlocks where control packets continue but IMU/sync frames are starved.
static inline void enqueueSerialFrame(const uint8_t *frame, size_t len,
                                      bool isCommandResponse)
{
    (void)isCommandResponse;
    // CRITICAL: Frame + 2-byte length prefix must fit in one SerialFrame
    if (len + 2 > SERIAL_FRAME_BUFFER_SIZE)
    {
        // Frame too large - this should never happen with proper sizing
        static uint32_t lastWarn = 0;
        if (millis() - lastWarn > 1000)
        {
            if (isStreaming)
            {
                logJson("error", "Serial frame too large for buffer");
            }
            else
            {
                Serial.printf(
                    "[Serial] ERROR: Frame too large (%d bytes) for buffer!\n", len);
            }
            lastWarn = millis();
        }
        serialTxDropCount++;
        return;
    }

    SerialFrame f;
    // Stream format: [len_lo][len_hi][frame...]
    f.data[0] = (uint8_t)(len & 0xFF);
    f.data[1] = (uint8_t)((len >> 8) & 0xFF);
    memcpy(f.data + 2, frame, len);
    f.len = (uint16_t)(len + 2);

    if (xQueueSend(serialTxQueue, &f, 0) != pdTRUE)
    {
        serialTxDropCount++;
    }
}

static inline void enqueueJsonFrame(const String &json)
{
    const size_t jsonLen = json.length();
    if (jsonLen == 0)
    {
        return;
    }

    // Frame payload = PACKET_JSON byte + JSON text
    const size_t frameLen = jsonLen + 1;

    if (frameLen <= SERIAL_FRAME_BUFFER_SIZE)
    {
        // Normal path: fits in queue buffer
        uint8_t buffer[SERIAL_FRAME_BUFFER_SIZE];
        buffer[0] = PACKET_JSON;
        memcpy(buffer + 1, json.c_str(), jsonLen);
        enqueueSerialFrame(buffer, frameLen,
                           true); // OPP-7: Always send command responses
        return;
    }

    // =========================================================================
    // Oversized path: frame too large for queue (e.g., sync_status with many
    // nodes). Write directly to Serial with length-prefix framing, holding the
    // mutex so bytes don't interleave with SerialTxTask batch writes.
    // Safe because command responses are infrequent (not the 200Hz hot path).
    // =========================================================================
    const size_t totalLen = 2 + frameLen; // 2-byte length prefix + payload
    uint8_t *buf = (uint8_t *)malloc(totalLen);
    if (!buf)
    {
        return;
    }
    buf[0] = (uint8_t)(frameLen & 0xFF);
    buf[1] = (uint8_t)((frameLen >> 8) & 0xFF);
    buf[2] = PACKET_JSON;
    memcpy(buf + 3, json.c_str(), jsonLen);

    if (serialWriteMutex != nullptr)
        xSemaphoreTake(serialWriteMutex, portMAX_DELAY);
    ::Serial.write(buf, totalLen);
    if (serialWriteMutex != nullptr)
        xSemaphoreGive(serialWriteMutex);

    free(buf);
}

static void logJson(const char *level, const char *message)
{
    if (!isStreaming)
    {
        Serial.printf("[%s] %s\n", level, message);
        return;
    }

    StaticJsonDocument<256> doc;
    doc["type"] = "log";
    doc["level"] = level;
    doc["message"] = message;
    doc["ts"] = millis();

    String output;
    serializeJson(doc, output);
    enqueueJsonFrame(output);
}

// ============================================================================
// SerialTxTask - Batched USB Serial Drain (Core 0)
// ============================================================================

void SerialTxTask(void *param)
{
    SerialFrame frame;
    Serial.println("[SerialTx] Task started on Core 0");

    // Local coalescing buffer (fits multiple frames)
    static uint8_t coalesceBuffer[SERIAL_FRAME_BUFFER_SIZE * 4];

    for (;;)
    {
        // Try to receive with short timeout (5ms)
        // Keep it at 2ms to stay responsive to incoming frames
        if (xQueueReceive(serialTxQueue, &frame, pdMS_TO_TICKS(2)) == pdTRUE)
        {
            uint32_t batchStart = millis();
            uint32_t framesInBatch = 0;
            size_t bufferOffset = 0;

            // Dequeue available frames into coalescing buffer
            do
            {
                // Guard: check if next frame fits in the coalescing buffer
                if (bufferOffset + frame.len > sizeof(coalesceBuffer))
                {
                    // Buffer full - ship what we have and then process this frame
                    if (serialWriteMutex != nullptr)
                        xSemaphoreTake(serialWriteMutex, portMAX_DELAY);
                    Serial.write(coalesceBuffer, bufferOffset);
                    if (serialWriteMutex != nullptr)
                        xSemaphoreGive(serialWriteMutex);

                    bufferOffset = 0;
                    serialTxBatchCount++;
                }

                memcpy(coalesceBuffer + bufferOffset, frame.data, frame.len);
                bufferOffset += frame.len;

                serialTxFrameCount++;
                framesInBatch++;

                // Batch limits: max frames or max time
                if (framesInBatch >= SERIAL_MAX_BATCH_FRAMES)
                    break;
                if ((millis() - batchStart) >= SERIAL_BATCH_INTERVAL_MS)
                    break;

                // Try to peek next frame without blocking
            } while (xQueueReceive(serialTxQueue, &frame, 0) == pdTRUE);

            // Final write of coalesced buffer
            if (bufferOffset > 0)
            {
                if (serialWriteMutex != nullptr)
                {
                    xSemaphoreTake(serialWriteMutex, portMAX_DELAY);
                }

                Serial.write(coalesceBuffer, bufferOffset);

                if (serialWriteMutex != nullptr)
                {
                    xSemaphoreGive(serialWriteMutex);
                }
                serialTxBatchCount++;
            }
        }

        uint32_t now = millis();

        // Periodic diagnostics with overflow detection (every 5 seconds)
        static uint32_t lastDiagTime = 0;
        if (now - lastDiagTime > 5000)
        {
            // Calculate drops since last report
            uint32_t dropsDelta = serialTxDropCount - lastReportedDrops;
            lastReportedDrops = serialTxDropCount;

            // Check for overflow conditions
            if (dropsDelta >= QUEUE_OVERFLOW_CRITICAL_THRESHOLD)
            {
                if (isStreaming)
                {
                    logJson("error",
                            "Serial queue overloaded: drops > critical threshold");
                }
                else
                {
                    Serial.println("[SerialTx] ========================================");
                    Serial.println(
                        "[SerialTx] CRITICAL: Serial queue severely overloaded!");
                    Serial.printf("[SerialTx] Dropped %lu frames in 5 seconds\n",
                                  dropsDelta);
                    Serial.println(
                        "[SerialTx] Data rate exceeds serial throughput capacity");
                    Serial.println(
                        "[SerialTx] Consider reducing sample rate or sensor count");
                    Serial.println("[SerialTx] ========================================");
                }
                serialQueueOverloaded = true;
            }
            else if (dropsDelta >= QUEUE_OVERFLOW_WARN_THRESHOLD)
            {
                if (isStreaming)
                {
                    logJson("warn", "Serial queue pressure: drops > warning threshold");
                }
                else
                {
                    Serial.printf(
                        "[SerialTx] WARNING: Dropped %lu frames in 5s (queue pressure)\n",
                        dropsDelta);
                }
                serialQueueOverloaded = true;
            }
            else
            {
                serialQueueOverloaded = false; // Clear flag when healthy
            }

            // Standard diagnostics
            if (isStreaming)
            {
                char buffer[160];
                snprintf(buffer, sizeof(buffer),
                         "SerialTx stats: frames=%lu batches=%lu drops=%lu (+%lu) "
                         "free=%u/%d heap=%uKB",
                         serialTxFrameCount, serialTxBatchCount, serialTxDropCount,
                         dropsDelta, uxQueueSpacesAvailable(serialTxQueue),
                         SERIAL_TX_QUEUE_SIZE, ESP.getFreeHeap() / 1024);
                logJson("info", buffer);
            }
            else
            {
                Serial.printf(
                    "[SerialTx] Frames: %lu, Batches: %lu, Drops: %lu (+%lu), "
                    "QueueFree: %u/%d, heap=%uKB\n",
                    serialTxFrameCount, serialTxBatchCount, serialTxDropCount,
                    dropsDelta, uxQueueSpacesAvailable(serialTxQueue),
                    SERIAL_TX_QUEUE_SIZE, ESP.getFreeHeap() / 1024);
            }
            lastDiagTime = now;
        }
    }
}

// ============================================================================
// DATA INGESTION TASK - ESP-NOW Packet Processing (Core 1)
// ============================================================================
// Dequeues raw ESP-NOW packets and processes them into SyncFrameBuffer.
// Runs on Core 1 to distribute work across both cores. The ESP-NOW callback
// on Core 0 just does a memcpy+enqueue (<5µs), then returns immediately.
//
// This task handles:
// 1. 0x23 (TDMA batched) → extract samples → addSample()
// 2. 0x26 (Node delta) → decode → addSample()
// ============================================================================

void DataIngestionTask(void *param)
{
    Serial.println(
        "[DataIngestion] Task started on Core 1 - ESP-NOW processing active");

    EspNowRxPacket rxPacket;
    uint32_t lastDiagTime = millis();
    uint32_t lastNodeDiagTime = millis();

    struct NodeIngestStats
    {
        uint8_t nodeId;
        uint32_t packets;
        uint32_t samplesAdded;
        uint32_t sampleAddFails;
        bool used;
    };
    NodeIngestStats nodeStats[TDMA_MAX_NODES] = {};

    auto getNodeStatSlot = [&](uint8_t nodeId) -> NodeIngestStats *
    {
        if (nodeId == 0)
            return nullptr;
        for (uint8_t i = 0; i < TDMA_MAX_NODES; i++)
        {
            if (nodeStats[i].used && nodeStats[i].nodeId == nodeId)
            {
                return &nodeStats[i];
            }
        }
        for (uint8_t i = 0; i < TDMA_MAX_NODES; i++)
        {
            if (!nodeStats[i].used)
            {
                nodeStats[i].used = true;
                nodeStats[i].nodeId = nodeId;
                nodeStats[i].packets = 0;
                nodeStats[i].samplesAdded = 0;
                nodeStats[i].sampleAddFails = 0;
                return &nodeStats[i];
            }
        }
        return nullptr;
    };

    for (;;)
    {
        // Block waiting for packets (up to 10ms timeout for diagnostics)
        if (xQueueReceive(espNowRxQueue, &rxPacket, pdMS_TO_TICKS(10)) == pdTRUE)
        {
            espNowRxProcessedCount++;
            uint8_t packetType = rxPacket.data[0];

            // SIMP-2: 0x23 handler removed — nodes exclusively use 0x26 format.
            // Legacy 0x23 packets are silently dropped.

            if (packetType == TDMA_PACKET_NODE_DATA && useSyncFrameMode &&
                syncFrameBufferInitialized)
            {
                // ====================================================================
                // 0x26 Node Data → Decode → SyncFrameBuffer
                // ====================================================================
                TDMABatchedSensorData decodedSamples[TDMA_SAMPLES_PER_FRAME][MAX_SENSORS]; // Max samples × max sensors per node
                uint8_t nodeIdOut, sensorCountOut;
                uint32_t frameNumberOut;

                uint8_t decodedCount =
                    decodeNodeData(rxPacket.data, rxPacket.len, &decodedSamples[0][0],
                                    TDMA_SAMPLES_PER_FRAME, MAX_SENSORS, &nodeIdOut, &frameNumberOut, &sensorCountOut);
                NodeIngestStats *ns = getNodeStatSlot(nodeIdOut);
                if (ns)
                {
                    ns->packets++;
                }

                // FIX: Removed frame-level dedup — it silently dropped valid data when
                // nodes freewheel and reuse frame numbers. SyncFrameBuffer.addSample()
                // already handles sample-level dedup via timestamp slot matching.
                if (decodedCount > 0)
                {
                    for (uint8_t sampleIdx = 0; sampleIdx < decodedCount; sampleIdx++)
                    {
                        for (uint8_t sensorIdx = 0; sensorIdx < sensorCountOut;
                             sensorIdx++)
                        {
                            TDMABatchedSensorData *sample =
                                &decodedSamples[sampleIdx][sensorIdx];

                            const uint8_t compactSensorId =
                                syncManager.getCompactSensorId(nodeIdOut, sensorIdx);
                            if (compactSensorId == 0)
                            {
                                if (ns)
                                {
                                    ns->sampleAddFails++;
                                }
                                continue;
                            }

                            bool added = syncFrameBuffer.addSample(
                                compactSensorId, nodeIdOut, sensorIdx,
                                sample->timestampUs,
                                frameNumberOut, sampleIdx,
                                sample->a, sample->g);
                            if (ns)
                            {
                                if (added)
                                {
                                    ns->samplesAdded++;
                                }
                                else
                                {
                                    ns->sampleAddFails++;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Periodic diagnostics (every 10 seconds)
        uint32_t now = millis();
        if (now - lastDiagTime > 10000)
        {
            Serial.printf(
                "[DataIngestion] Processed: %lu, Dropped: %lu, QueueFree: %u/%d\n",
                espNowRxProcessedCount, espNowRxDropCount,
                uxQueueSpacesAvailable(espNowRxQueue), ESPNOW_RX_QUEUE_SIZE);
            lastDiagTime = now;
        }

        if (now - lastNodeDiagTime > 5000)
        {
            lastNodeDiagTime = now;
            Serial.println("[DataIngestion] Node contribution (5s window):");
            bool any = false;
            String json = "{\"type\":\"gateway_ingest_diag\",\"window_ms\":5000,\"nodes\":[";
            bool firstJsonNode = true;
            for (uint8_t i = 0; i < TDMA_MAX_NODES; i++)
            {
                if (!nodeStats[i].used)
                    continue;
                any = true;
                float pktHz = nodeStats[i].packets / 5.0f;
                float sampleHz = nodeStats[i].samplesAdded / 5.0f;
                Serial.printf(
                    "  node=%u packets=%lu (%.1f/s) added=%lu (%.1f/s) fails=%lu\n",
                    nodeStats[i].nodeId,
                    (unsigned long)nodeStats[i].packets,
                    pktHz,
                    (unsigned long)nodeStats[i].samplesAdded,
                    sampleHz,
                    (unsigned long)nodeStats[i].sampleAddFails);

                if (!firstJsonNode)
                {
                    json += ",";
                }
                firstJsonNode = false;
                char nodeJson[160];
                snprintf(nodeJson, sizeof(nodeJson),
                         "{\"nodeId\":%u,\"packets\":%lu,\"samplesAdded\":%lu,\"sampleAddFails\":%lu}",
                         nodeStats[i].nodeId,
                         (unsigned long)nodeStats[i].packets,
                         (unsigned long)nodeStats[i].samplesAdded,
                         (unsigned long)nodeStats[i].sampleAddFails);
                json += nodeJson;

                nodeStats[i].packets = 0;
                nodeStats[i].samplesAdded = 0;
                nodeStats[i].sampleAddFails = 0;
            }
            if (!any)
            {
                Serial.println("  (no TDMA data packets in window)");
            }
            json += "]}";
            enqueueJsonFrame(json);
        }
    }
}

// ============================================================================
// PROTOCOL TASK - Jitter-Free Beacon & Sync Frame Management (Core 0)
// ============================================================================
// This task handles all timing-critical operations:
// 1. TDMA beacon transmission at exactly 20ms intervals (50Hz)
// 2. SyncFrameBuffer update and complete frame detection
// 3. Sync Frame (0x25) packet emission when frames are complete
//
// MUST run on Core 0 because syncManager.update() calls esp_now_send()
// which interacts with the WiFi stack pinned to Core 0. SyncManager
// internal state is also accessed from ESP-NOW callbacks on Core 0.
// The spinlock on SyncFrameBuffer handles cross-core access from
// DataIngestionTask on Core 1.
// ============================================================================

void ProtocolTask(void *param)
{
    Serial.println(
        "[Protocol] Task started on Core 0 - Jitter-free timing active");

    uint32_t lastBeaconUs = micros();
    const uint32_t BEACON_INTERVAL_US =
        TDMA_FRAME_PERIOD_MS * 1000; // 20ms = 20000µs
    uint32_t suppressedPreRunningSyncFrames = 0;
    uint32_t lastSuppressedSyncFrameLogMs = 0;
    bool lastTDMARunningState = false;

    // Sync frame output buffer (reused each iteration)
    static uint8_t syncFramePacket[SYNC_FRAME_MAX_PACKET_SIZE];

    protocolTaskRunning = true;

    // FIX: Use vTaskDelayUntil for deterministic 1ms wakeup cadence instead of
    // vTaskDelay(1) which drifts. This reduces beacon check jitter significantly.
    TickType_t xLastWakeTime = xTaskGetTickCount();

    for (;;)
    {
        uint32_t nowUs = micros();

        // ========================================================================
        // TDMA Beacon Transmission (exactly every 20ms)
        // ========================================================================
        if (syncManager.isTDMAActive())
        {
            uint32_t elapsedUs = nowUs - lastBeaconUs;

            if (elapsedUs >= BEACON_INTERVAL_US)
            {
                // Track jitter for diagnostics
                int32_t jitterUs = (int32_t)elapsedUs - (int32_t)BEACON_INTERVAL_US;
                if (abs(jitterUs) > (int32_t)beaconJitterMaxUs)
                {
                    beaconJitterMaxUs = abs(jitterUs);
                }

                // Send beacon via SyncManager (it handles all the packet building)
                syncManager.update();

                lastBeaconUs = nowUs;
                beaconTxCount++;
            }
        }

        // ========================================================================
        // SyncFrameBuffer Management
        // ========================================================================
        if (useSyncFrameMode && syncFrameBufferInitialized)
        {
            const bool tdmaRunning = syncManager.isTDMARunning();
            if (tdmaRunning != lastTDMARunningState)
            {
                lastTDMARunningState = tdmaRunning;
                SAFE_LOG_NB(
                    "[Protocol] TDMA state changed: %s - sync frame emission %s\n",
                    syncManager.getTDMAStateName(),
                    tdmaRunning ? "ENABLED" : "SUPPRESSED");
            }

            // Update buffer (expire stale slots)
            syncFrameBuffer.update();

            // Product contract: SyncFrames are only allowed to leave the
            // gateway once TDMA is fully RUNNING. Discovery/SYNC-phase frames
            // are drained so the buffer cannot back up, but they are dropped
            // instead of being forwarded to the webapp.
            while (syncFrameBuffer.hasCompleteFrame())
            {
                size_t frameLen = syncFrameBuffer.getCompleteFrame(
                    syncFramePacket, sizeof(syncFramePacket));

                if (frameLen == 0)
                {
                    continue;
                }

                if (tdmaRunning)
                {
                    enqueueSerialFrame(syncFramePacket, frameLen, false);
                    syncFrameEmitCount++;
                }
                else
                {
                    suppressedPreRunningSyncFrames++;
                }
            }

            const uint32_t nowMs = millis();
            if (!tdmaRunning && suppressedPreRunningSyncFrames > 0 &&
                (nowMs - lastSuppressedSyncFrameLogMs) > 2000)
            {
                lastSuppressedSyncFrameLogMs = nowMs;
                SAFE_LOG_NB(
                    "[Protocol] Suppressed %lu pre-RUNNING SyncFrames while tdma=%s\n",
                    suppressedPreRunningSyncFrames,
                    syncManager.getTDMAStateName());
                suppressedPreRunningSyncFrames = 0;
            }
        }

        // ========================================================================
        // DEFERRED SYNC RESET — Fire once when all conditions are met
        // ========================================================================
        // Instead of resetting on every START + every node registration, we
        // wait for the system to stabilize:
        //   1. pendingSyncReset flag set (by onStartStreaming or late-join)
        //   2. isStreaming (webapp connected)
        //   3. TDMA in RUNNING state (discovery + sync phases complete)
        //   4. SyncFrameBuffer initialized (sensor IDs known)
        // Only THEN fire a single triggerSyncReset(). This eliminates the
        // multiple overlapping 200ms reset windows that delayed data flow.
        // ========================================================================
        if (pendingSyncReset &&
            syncManager.isTDMARunning() && syncFrameBufferInitialized)
        {
            pendingSyncReset = false;
            syncManager.triggerSyncReset();
            SAFE_LOG_NB("[SYNC] Deferred sync reset fired — TDMA RUNNING + "
                        "buffer ready + streaming active\n");
        }

        // ========================================================================
        // Diagnostics (every 10 seconds)
        // ========================================================================
        static uint32_t lastProtocolDiag = 0;
        uint32_t nowMs = millis();
        if (nowMs - lastProtocolDiag > 10000)
        {
            if (syncManager.isTDMAActive())
            {
                SAFE_LOG_NB(
                    "[Protocol] Beacons: %lu, MaxJitter: %luµs, SyncFrames: %lu\n",
                    beaconTxCount, beaconJitterMaxUs, syncFrameEmitCount);
                beaconJitterMaxUs = 0; // Reset max jitter tracking
            }
            lastProtocolDiag = nowMs;
        }

        // FIX: vTaskDelayUntil ensures deterministic 1ms wake cadence, reducing
        // beacon timing jitter vs vTaskDelay which drifts from "now".
        vTaskDelayUntil(&xLastWakeTime, pdMS_TO_TICKS(1));
    }
}
