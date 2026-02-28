// ============================================================================
// SyncTransfer.cpp — TDMA data buffering, packet building, and transmission
// ============================================================================
// Extracted from SyncManager.cpp for maintainability.
// Contains: bufferSample, buildTDMAPacket, sendTDMAData, isInTransmitWindow,
//           isTDMASynced
// ============================================================================
#define DEVICE_ROLE DEVICE_ROLE_NODE

#include "SyncManager.h"
#include "SensorManager.h"
#include "TimingGlobals.h"

static constexpr int16_t UNITY_QUAT_W_I16 = 16384;
static constexpr int16_t UNITY_QUAT_X_I16 = 0;
static constexpr int16_t UNITY_QUAT_Y_I16 = 0;
static constexpr int16_t UNITY_QUAT_Z_I16 = 0;

// ============================================================================
// BUFFER SAMPLE — Store IMU data into the deterministic frame queue
// ============================================================================

bool SyncManager::bufferSample(SensorManager &sm)
{
    // ========================================================================
    // MUTEX: Short-lived lock for buffer access
    // ========================================================================
    // sendTDMAData() now only holds the mutex for ~50µs (snapshot), so
    // contention should be near-zero. We still track skips for diagnostics.
    // ========================================================================
    static uint32_t mutexSkipCount = 0;
    static uint32_t lastMutexSkipLog = 0;

    static uint32_t droppedExtraSamples = 0;
    static uint32_t droppedNewFramesRecording = 0;
    static uint32_t lastDropLog = 0;

    if (bufferMutex == nullptr ||
        xSemaphoreTake(bufferMutex, pdMS_TO_TICKS(1)) != pdTRUE)
    {
        mutexSkipCount++;
        if (millis() - lastMutexSkipLog > 5000)
        {
            Serial.printf("[TDMA] WARNING: bufferSample mutex skips: %lu (last 5s)\n",
                          mutexSkipCount);
            mutexSkipCount = 0;
            lastMutexSkipLog = millis();
        }
        return false; // Could not acquire mutex, skip this sample
    }

    uint8_t sensorCount = sm.getSensorCount();
    if (sensorCount > MAX_SENSORS)
        sensorCount = MAX_SENSORS;

    // Validate sensor count is within TDMA protocol limits
    if (sensorCount > TDMA_MAX_SENSORS_PER_NODE)
    {
        static bool warningPrinted = false;
        if (!warningPrinted)
        {
            Serial.printf("[TDMA] ERROR: %d sensors exceeds max %d - reduce "
                          "sensor count!\n",
                          sensorCount, TDMA_MAX_SENSORS_PER_NODE);
            warningPrinted = true;
        }
        xSemaphoreGive(bufferMutex);
        return false;
    }

    // Frame queue is bounded by TDMA_FRAME_QUEUE_CAPACITY. If full, apply policy.
    const uint8_t allMask = (TDMA_SAMPLES_PER_FRAME >= 8)
                                ? 0xFF
                                : (uint8_t)((1U << TDMA_SAMPLES_PER_FRAME) - 1U);

    // ============================================================================
    // FRAME NUMBER CALCULATION (Must match Gateway's beacon frame number!)
    // ============================================================================
    // CRITICAL: For cross-node sync, all nodes must use the SAME frame number
    // for samples taken during the same beacon period.
    //
    // The beacon contains the Gateway's authoritative frameNumber. We use that
    // directly, plus a small offset for samples taken between beacons:
    //   - Sample 0-3: all belong to currentFrameNumber (from beacon)
    //   - If we're past 20ms since beacon, increment frame (shouldn't happen
    //     in normal operation since beacons arrive every 20ms)
    //
    // GUARD: If we've never received a beacon (lastBeaconTime == 0), don't
    // buffer samples - we can't sync without knowing the frame number!
    // Also check beaconGatewayTimeUs in case it was reset by SYNC_RESET.
    // ============================================================================
    if (lastBeaconTime == 0 || beaconGatewayTimeUs == 0)
    {
        // No beacon received yet OR timing was just reset - wait for fresh beacon
        // Return false to indicate sample was not buffered
        xSemaphoreGive(bufferMutex);
        return false;
    }

    // ==========================================================================
    // INT_WDT FIX v7: Minimized critical section scope.
    // ALL Serial.printf and millis() calls moved OUTSIDE the spinlock.
    // portENTER_CRITICAL disables interrupts — any blocking I/O (UART) inside
    // it risks INT_WDT if the other core contends on the same lock.
    // ==========================================================================

    // FIX: Acquire syncStateLock to read/freewheel sync state atomically.
    // handleBeacon() on Core 0 updates these same variables under this lock.
    portENTER_CRITICAL(&syncStateLock);
    uint32_t timeSinceBeacon = micros() - lastBeaconTime;

    // SANITY CHECK: If timeSinceBeacon is huge (>1 second), something is wrong
    if (timeSinceBeacon > 1000000)
    {
        uint32_t staleMs = timeSinceBeacon / 1000; // capture for log
        portEXIT_CRITICAL(&syncStateLock);
        // Stale beacon - wait for fresh one (Serial OUTSIDE lock)
        static uint32_t lastStaleLog = 0;
        if (millis() - lastStaleLog > 2000)
        {
            lastStaleLog = millis();
            Serial.printf(
                "[SYNC] Stale beacon (%lu ms old) - waiting for fresh beacon\n",
                staleMs);
        }
        xSemaphoreGive(bufferMutex);
        return false;
    }

    // NORMAL/FREEWHEEL OPERATION:
    // If we missed a beacon, advance frame/anchor in bounded steps to keep
    // timestamps and transmit windows consistent. If too many beacons missed,
    // stop buffering until a fresh beacon arrives.
    const uint32_t framePeriodUs = TDMA_FRAME_PERIOD_MS * 1000;
    const uint8_t maxFreewheelFrames = 2; // Allow up to 2 missed beacons (40ms)
    uint32_t freewheelFramesCaptured = 0; // For deferred logging OUTSIDE lock

    if (timeSinceBeacon > framePeriodUs)
    {
        uint32_t missedFrames = timeSinceBeacon / framePeriodUs;
        if (missedFrames <= maxFreewheelFrames)
        {
            currentFrameNumber += missedFrames;
            beaconGatewayTimeUs += missedFrames * framePeriodUs;
            lastBeaconTime += missedFrames * framePeriodUs;
            timeSinceBeacon -= missedFrames * framePeriodUs;
            freewheelFramesCaptured = missedFrames; // Log AFTER releasing lock
        }
        else
        {
            portEXIT_CRITICAL(&syncStateLock);
            // Too many missed beacons - wait for a fresh beacon to re-anchor
            xSemaphoreGive(bufferMutex);
            return false;
        }
    }

    // Capture sync state atomically before releasing lock.
    // handleBeacon() on Core 0 can update these between portEXIT_CRITICAL
    // and the timestamp computation below, causing race conditions.
    uint32_t capturedBeaconGatewayTimeUs = beaconGatewayTimeUs;
    uint32_t capturedLastBeaconTime = lastBeaconTime;
    uint32_t capturedFrameNumber = currentFrameNumber;
    uint32_t capturedBeaconSequence = beaconSequence;
    portEXIT_CRITICAL(&syncStateLock);

    // DEFERRED LOG: Freewheeling message OUTSIDE critical section
    if (freewheelFramesCaptured > 0)
    {
        static uint32_t lastFreewheelLog = 0;
        if (millis() - lastFreewheelLog > 2000)
        {
            lastFreewheelLog = millis();
            Serial.printf("[SYNC] Freewheeling %lu frames (beacon loss)\n",
                          freewheelFramesCaptured);
        }
    }

    // Frame number for this sample
    const uint32_t sampleFrameNumber = capturedFrameNumber;

    // ============================================================================
    // EPOCH-BASED DETERMINISTIC TIMESTAMPS (v4 - Research-Grade Cross-Node Sync)
    // ============================================================================
    // Gateway now sends DETERMINISTIC timestamps in ALL beacons:
    //   beacon.gatewayTimeUs = epoch + (frameNumber * 20000)
    //
    // This makes timestamps INDEPENDENT of which beacon a node receives!
    //
    // Example with packet loss:
    //   Node A receives beacon #100: gatewayTimeUs = epoch + 2000000
    //   Node B receives beacon #103: gatewayTimeUs = epoch + 2060000
    //
    // For a sample at the SAME physical instant:
    //   Node A (sampleIndex=0): ts = (epoch + 2000000) + 0 = epoch + 2000000
    //   Node B (sampleIndex=0): ts = (epoch + 2060000) + 0 = epoch + 2060000
    //   Difference: 60ms (3 beacons)
    //
    // BUT - if they're both sampling at the same logical frame:
    //   Both should have currentFrameNumber=100 (from beacon sync)
    //   timestamp = epoch + (frame * 20000) + (sampleIndex * 5000)
    //
    // The key is that beaconGatewayTimeUs already encodes the frame number,
    // so nodes automatically produce correct timestamps for their frame.
    // ============================================================================

    uint32_t syncedTimestampUs;

    // ============================================================================
    // STEP 1: Deterministic sample index (0..3) per frame
    // ============================================================================
    // IMPORTANT: Do NOT use the shared samplesSinceBeacon counter here.
    // That counter is reset by the beacon handler on Core 0 and can race with
    // this function between capture and increment, causing indices to jump or
    // repeat. The end result is frames that never complete (no 4-sample packets),
    // which can cause the Gateway to drop the node from schedule and trigger the
    // 3s POWER_DOWN_GRACE_MS oscillation.
    //
    // Instead, track a per-frame sequential index under bufferMutex.
    // This guarantees we fill indices 0..3 for each captured frame.
    // ============================================================================

    if (bufferedSampleFrameNumber != sampleFrameNumber ||
        lastBufferedBeaconSequence != capturedBeaconSequence)
    {
        bufferedSampleFrameNumber = sampleFrameNumber;
        nextSampleIndexInFrame = 0;
        lastBufferedBeaconSequence = capturedBeaconSequence;
    }

    uint8_t sampleIndex = nextSampleIndexInFrame;
    if (sampleIndex >= TDMA_SAMPLES_PER_FRAME)
    {
        // Too many samples already buffered for this TDMA frame — drop extras.
        droppedExtraSamples++;
        if (millis() - lastDropLog > 5000)
        {
            lastDropLog = millis();
            Serial.printf(
                "[TDMA] Drops: extraSamples=%lu newFramesREC=%lu queueFrames=%u\n",
                droppedExtraSamples, droppedNewFramesRecording, frameQueueCount);
            droppedExtraSamples = 0;
            droppedNewFramesRecording = 0;
        }
        xSemaphoreGive(bufferMutex);
        return false;
    }

    // ============================================================================
    // STEP 2: Generate timestamp from beacon anchor + sample index
    // ============================================================================
    // This is THE KEY to cross-node synchronization:
    // ALL nodes use beaconGatewayTimeUs (which came from the Gateway's clock)
    // as the anchor, then add deterministic offsets.
    //
    // Result: All nodes produce IDENTICAL timestamps for same logical sample!
    // ============================================================================

    syncedTimestampUs = capturedBeaconGatewayTimeUs + (sampleIndex * 5000);

    // DEBUG: Log timestamp generation EVERY 2 SECONDS with full diagnostics
    static uint32_t lastTsGenDebug = 0;
    if (millis() - lastTsGenDebug > 2000)
    {
        lastTsGenDebug = millis();

        // Calculate what the OLD offset-based method would have produced (for
        // comparison)
        Serial.printf(
            "[TS GEN] nodeId=%d, beaconAnchor=%lu, sampleIdx=%d, ts=%lu us\n",
            nodeId, capturedBeaconGatewayTimeUs, sampleIndex, syncedTimestampUs);
        Serial.printf("         beaconRxLocal=%lu us, frame=%lu, counter=%u\n",
                      capturedLastBeaconTime, capturedFrameNumber, sampleIndex);

        // Also log PTP status for sync quality monitoring
        if (lastTwoWaySyncTime > 0)
        {
            uint32_t ptpAge = millis() - lastTwoWaySyncTime;
            Serial.printf("         PTP: offset=%lld us, RTT=%u us, age=%lu ms\n",
                          twoWayOffset, avgRttUs, ptpAge);
        }
    }

    // Advance sample counter for this frame AFTER successful store

    // ========================================================================
    // FRAME QUEUE: Find or create the frame entry for this sampleFrameNumber
    // ========================================================================
    int entryIndex = -1;
    for (uint8_t qi = 0; qi < frameQueueCount; qi++)
    {
        uint8_t idx = (uint8_t)((frameQueueTail + qi) % TDMA_FRAME_QUEUE_CAPACITY);
        if (frameQueue[idx].frameNumber == sampleFrameNumber)
        {
            entryIndex = (int)idx;
            break;
        }
    }

    if (entryIndex < 0)
    {
        // Need a new frame entry
        if (frameQueueCount >= TDMA_FRAME_QUEUE_CAPACITY)
        {
            if (currentBufferPolicy == POLICY_RECORDING)
            {
                // Recording: preserve queued history, drop new sample (frame not
                // enqueued)
                droppedNewFramesRecording++;
                if (millis() - lastDropLog > 5000)
                {
                    lastDropLog = millis();
                    Serial.printf("[TDMA] Drops: extraSamples=%lu newFramesREC=%lu "
                                  "queueFrames=%u\n",
                                  droppedExtraSamples, droppedNewFramesRecording,
                                  frameQueueCount);
                    droppedExtraSamples = 0;
                    droppedNewFramesRecording = 0;
                }
                xSemaphoreGive(bufferMutex);
                return false;
            }

            // Live: drop oldest frame to make room
            frameQueueTail =
                (uint8_t)((frameQueueTail + 1) % TDMA_FRAME_QUEUE_CAPACITY);
            frameQueueCount--;
        }

        uint8_t insertIdx = (uint8_t)((frameQueueTail + frameQueueCount) %
                                      TDMA_FRAME_QUEUE_CAPACITY);
        frameQueueCount++;

        frameQueue[insertIdx].frameNumber = sampleFrameNumber;
        frameQueue[insertIdx].sensorCount = sensorCount;
        frameQueue[insertIdx].presentMask = 0;
        memset(frameQueue[insertIdx].samples, 0,
               sizeof(frameQueue[insertIdx].samples));
        entryIndex = (int)insertIdx;
    }

    TDMAFrameBufferEntry *entry = &frameQueue[entryIndex];
    entry->sensorCount = sensorCount;

    // Store current sample into its deterministic index (0..3)
    for (int i = 0; i < sensorCount; i++)
    {
        IMUData data = sm.getData(i);

        // DEBUG: Log accel values being packed (every 5 seconds for sensor 0)
        static unsigned long lastPackDebug = 0;
        if (i == 0 && millis() - lastPackDebug > 5000)
        {
            lastPackDebug = millis();
            Serial.printf("[TDMA PACK] Accel(m/s2): X=%.2f Y=%.2f Z=%.2f -> int16: "
                          "X=%d Y=%d Z=%d\n",
                          data.accelX, data.accelY, data.accelZ,
                          (int16_t)(data.accelX * 100.0f),
                          (int16_t)(data.accelY * 100.0f),
                          (int16_t)(data.accelZ * 100.0f));
        }

        entry->samples[sampleIndex][i].sensorId = i + nodeId;
        entry->samples[sampleIndex][i].timestampUs = syncedTimestampUs;
        // Node-side fusion was removed; web app performs orientation fusion.
        // Keep protocol-compatible unit quaternion in payload.
        entry->samples[sampleIndex][i].q[0] = UNITY_QUAT_W_I16;
        entry->samples[sampleIndex][i].q[1] = UNITY_QUAT_X_I16;
        entry->samples[sampleIndex][i].q[2] = UNITY_QUAT_Y_I16;
        entry->samples[sampleIndex][i].q[3] = UNITY_QUAT_Z_I16;
        entry->samples[sampleIndex][i].a[0] = (int16_t)(data.accelX * 100.0f);
        entry->samples[sampleIndex][i].a[1] = (int16_t)(data.accelY * 100.0f);
        entry->samples[sampleIndex][i].a[2] = (int16_t)(data.accelZ * 100.0f);
        entry->samples[sampleIndex][i].g[0] = (int16_t)(data.gyroX * 900.0f);
        entry->samples[sampleIndex][i].g[1] = (int16_t)(data.gyroY * 900.0f);
        entry->samples[sampleIndex][i].g[2] = (int16_t)(data.gyroZ * 900.0f);

        // DEBUG: Log bytes being packed (every 5s, sensor 0 only)
        static unsigned long lastByteDebug = 0;
        if (i == 0 && millis() - lastByteDebug > 5000)
        {
            lastByteDebug = millis();
            TDMABatchedSensorData *sample = &entry->samples[sampleIndex][i];
            uint8_t *bytes = (uint8_t *)sample;
            Serial.printf("[TDMA BYTES] sensorId=%d a[]=(%d,%d,%d) bytes: ",
                          sample->sensorId, sample->a[0], sample->a[1], sample->a[2]);
            for (int b = 0; b < 25; b++)
            {
                Serial.printf("%02X ", bytes[b]);
            }
            Serial.println();
        }
    }

    // Mark this sample index present; complete when all 4 indices present
    entry->presentMask |= (uint8_t)(1U << sampleIndex);
    bool result = ((entry->presentMask & allMask) == allMask);

    // Advance index only after successfully buffering this sample
    nextSampleIndexInFrame = (uint8_t)(nextSampleIndexInFrame + 1);

    xSemaphoreGive(bufferMutex);
    return result;
}

// ============================================================================
// PHASE 3: TDMA Sync Check with Grace Period
// ============================================================================
bool SyncManager::isTDMASynced() const
{
    // If we have a valid schedule and beacons are still recent, we're synced
    if (tdmaNodeState == TDMA_NODE_SYNCED)
    {
        return true; // Definitely synced
    }

    // GRACE PERIOD: Even if state isn't SYNCED, keep trying if we have:
    // 1. A valid slot assignment (from previous schedule)
    // 2. Beacons received within last 3 seconds (REDUCED from 30s!)
    // Rationale: 30s was too long - masked real problems and caused silent data
    // loss 3 seconds allows for brief hiccups while not hiding persistent issues
    if (mySlotWidthUs > 0 && (micros() - lastBeaconTime < 3000000))
    {
        return true; // Short grace period - keep trying briefly
    }

    return false; // Really lost sync
}

// ============================================================================
// TRANSMIT WINDOW CHECK
// ============================================================================

bool SyncManager::isInTransmitWindow() const
{
    if (tdmaNodeState != TDMA_NODE_SYNCED)
        return false;

    // Calculate time since last beacon (in adjusted gateway time)
    uint32_t timeSinceBeacon = micros() - lastBeaconTime;

    // FREEWHEELING (HARDENED): Allow only a small number of missed beacons.
    // If beacons are stale, transmitting based on an old frame phase can
    // self-sustain beacon loss (half-duplex radio) and trigger repeated recovery.
    // Allow up to 3 frames (60ms) of freewheel; beyond that, do not transmit.
    const uint32_t framePeriodUs = TDMA_FRAME_PERIOD_MS * 1000;
    if (timeSinceBeacon > (framePeriodUs * 3))
        return false;

    // Use modulo arithmetic to find our position in the current "virtual" frame
    // TDMA_FRAME_PERIOD_MS is 20ms (20000us)
    // Ensure we cast to uint32_t to match timeSinceBeacon
    uint32_t timeInVirtualFrame = timeSinceBeacon % framePeriodUs;

    // Check if we're within our slot window
    // GUARD ZONE: Stop transmitting before frame end so the radio is idle
    // when the next beacon arrives. ESP-NOW is half-duplex — if we're mid-TX
    // when the gateway sends a beacon, we miss it entirely.
    uint32_t guardZoneStartUs = framePeriodUs - TDMA_GUARD_TIME_US;
    return (timeInVirtualFrame >= mySlotOffsetUs &&
            timeInVirtualFrame < mySlotOffsetUs + mySlotWidthUs &&
            timeInVirtualFrame < guardZoneStartUs);
}

// ============================================================================
// PIPELINED PACKET BUILDER (Simplified — All Keyframes)
// ============================================================================
// Delta compression removed: With ESP-NOW v2.0 (1470 bytes), keyframe-only
// packets fit easily (4 samples × 6 sensors × 25 bytes = 600 bytes).
// Removing delta encoding eliminates CPU overhead and failure-mode complexity.
// ============================================================================
size_t buildTDMAPacket(uint8_t *packet,
                       const TDMABatchedSensorData (*frameSamples)[MAX_SENSORS],
                       uint8_t frameSampleCount, uint8_t sensorCount,
                       uint32_t frameNumber, TDMABatchedSensorData *prevSample,
                       bool &prevSampleValid, uint32_t &deltaOverflowCount,
                       uint8_t nodeId, uint8_t syncProtocolVersion,
                       uint16_t lastRttUs, uint32_t timeSinceLastSync,
                       bool twoWaySyncActive, uint8_t &samplesConsumed)
{
    if (frameSampleCount == 0 || frameSamples == nullptr)
    {
        samplesConsumed = 0;
        return 0;
    }

    uint8_t maxSamplesPerPacket = calculateMaxSamplesPerPacket(sensorCount);
    if (maxSamplesPerPacket == 0)
    {
        samplesConsumed = 0;
        return 0;
    }

    uint8_t samplesToSend = frameSampleCount;
    if (samplesToSend > maxSamplesPerPacket)
    {
        samplesToSend = maxSamplesPerPacket;
    }

    // Build packet header
    TDMANodeDeltaPacket *header = (TDMANodeDeltaPacket *)packet;
    header->type = TDMA_PACKET_DATA_DELTA;
    header->nodeId = nodeId;
    header->frameNumber = frameNumber;
    header->sampleCount = samplesToSend;
    header->sensorCount = sensorCount;
    header->reserved = 0;
    header->flags = NODE_DELTA_FLAG_ALL_KEYFRAME;

    size_t destOffset = sizeof(TDMANodeDeltaPacket);

    // All samples packed as keyframes (no delta encoding)
    for (uint8_t s = 0; s < samplesToSend; s++)
    {
        for (uint8_t sensor = 0; sensor < sensorCount; sensor++)
        {
            memcpy(packet + destOffset, &frameSamples[s][sensor],
                   sizeof(TDMABatchedSensorData));
            destOffset += sizeof(TDMABatchedSensorData);
        }
    }

    // Sync quality metadata
    if (syncProtocolVersion == SYNC_PROTOCOL_VERSION_PTP_V2)
    {
        header->flags |= NODE_DELTA_FLAG_SYNC_V2;
        SyncQualityFlags *syncQuality = (SyncQualityFlags *)(packet + destOffset);

        syncQuality->lastSyncAgeMs =
            (timeSinceLastSync > 65535) ? 65535 : (uint16_t)timeSinceLastSync;
        syncQuality->driftPpmX10 = 0;
        syncQuality->kalmanInitialized = 0;
        syncQuality->outlierRejected = 0;
        syncQuality->reserved = 0;

        if (!twoWaySyncActive || timeSinceLastSync > 5000)
        {
            syncQuality->confidence = SYNC_CONF_UNCERTAIN;
            syncQuality->offsetUncertaintyUs = 65535;
        }
        else if (timeSinceLastSync > 2000 || lastRttUs > 5000)
        {
            syncQuality->confidence = SYNC_CONF_LOW;
            syncQuality->offsetUncertaintyUs =
                (lastRttUs / 2) + (timeSinceLastSync * 10);
        }
        else if (timeSinceLastSync > 500 || lastRttUs > 2000)
        {
            syncQuality->confidence = SYNC_CONF_MEDIUM;
            syncQuality->offsetUncertaintyUs = lastRttUs / 2;
        }
        else
        {
            syncQuality->confidence = SYNC_CONF_HIGH;
            syncQuality->offsetUncertaintyUs = lastRttUs / 4;
        }

        destOffset += sizeof(SyncQualityFlags);
    }

    // CRC
    uint8_t crc = calculateCRC8(packet, destOffset);
    packet[destOffset] = crc;
    destOffset++;

    // (prevSample tracking removed — delta compression disabled)

    samplesConsumed = samplesToSend;
    return destOffset;
}

// ============================================================================
// PIPELINED TDMA TRANSMISSION
// ============================================================================
// OPTIMIZED: Mutex is held only long enough to snapshot the buffer (~50µs),
// then released before packet building, sending, and pre-building.
// This eliminates the mutex contention that was causing ~1 dropped sample
// per 20ms TDMA frame (200Hz → 155Hz).
//
// Previous approach held the mutex for the entire function (1-3ms), which
// overlapped with the 1ms mutex timeout in bufferSample() on Core 1,
// causing ~22% sample loss.
// ============================================================================
void SyncManager::sendTDMAData()
{
#if DEVICE_ROLE == DEVICE_ROLE_NODE

    bool localTxPending = false;
    uint32_t localTxStartTime = 0;
    portENTER_CRITICAL(&syncStateLock);
    localTxPending = txPending;
    localTxStartTime = g_txStartTime;
    portEXIT_CRITICAL(&syncStateLock);

    if (localTxPending)
    {
        // CRITICAL FIX: Timeout stale txPending flag.
        // If esp_now_send() returned ESP_OK but the send callback never fires
        // (WiFi TX stuck, internal queue corruption), txPending stays true forever
        // → Build=0, AirTime=0, queueFrames fills to 16.
        // Normal air time is 5-9ms, so 50ms is a generous timeout.
        if (localTxStartTime > 0 && (micros() - localTxStartTime) > 50000)
        {
            portENTER_CRITICAL(&syncStateLock);
            txPending = false;
            g_txStartTime = 0;
            sendFailCount++;
            portEXIT_CRITICAL(&syncStateLock);
            static uint32_t lastStallLog = 0;
            if (millis() - lastStallLog > 2000)
            {
                Serial.println("[TDMA] TX stall detected — callback never fired, "
                               "clearing txPending");
                lastStallLog = millis();
            }
        }
        else
        {
            return;
        }
    }

    const uint8_t allMask = (TDMA_SAMPLES_PER_FRAME >= 8)
                                ? 0xFF
                                : (uint8_t)((1U << TDMA_SAMPLES_PER_FRAME) - 1U);

    // Capture current frame number for stale-frame cleanup (under sync lock)
    uint32_t capturedCurrentFrame = 0;
    portENTER_CRITICAL(&syncStateLock);
    capturedCurrentFrame = currentFrameNumber;
    portEXIT_CRITICAL(&syncStateLock);

    TDMAFrameBufferEntry frameToSend;
    bool haveFrame = false;

    static uint32_t droppedStaleIncompleteFrames = 0;
    static uint32_t lastStaleDropLog = 0;

    if (bufferMutex == nullptr ||
        xSemaphoreTake(bufferMutex, pdMS_TO_TICKS(1)) != pdTRUE)
    {
        return;
    }

    // Drop stale incomplete frames in LIVE mode so they don't block the queue.
    while (frameQueueCount > 0)
    {
        uint8_t idx = frameQueueTail;
        bool complete = ((frameQueue[idx].presentMask & allMask) == allMask);
        if (complete)
        {
            frameToSend = frameQueue[idx];
            frameQueueTail =
                (uint8_t)((frameQueueTail + 1) % TDMA_FRAME_QUEUE_CAPACITY);
            frameQueueCount--;
            haveFrame = true;
            break;
        }

        // Incomplete: if it's older than the previous frame, discard (LIVE only)
        if (currentBufferPolicy == POLICY_LIVE && capturedCurrentFrame > 1 &&
            frameQueue[idx].frameNumber + 1 < capturedCurrentFrame)
        {
            droppedStaleIncompleteFrames++;
            frameQueueTail =
                (uint8_t)((frameQueueTail + 1) % TDMA_FRAME_QUEUE_CAPACITY);
            frameQueueCount--;
            continue;
        }
        break;
    }

    xSemaphoreGive(bufferMutex);

    if (!haveFrame)
    {
        if (droppedStaleIncompleteFrames > 0 &&
            millis() - lastStaleDropLog > 30000)
        { // Increased to 30s
            lastStaleDropLog = millis();
            Serial.printf("[TDMA] Dropped stale incomplete frames: %lu (last 30s)\n",
                          droppedStaleIncompleteFrames);
            droppedStaleIncompleteFrames = 0;
        }
        return;
    }

    uint8_t samplesConsumed = 0;
    uint32_t tBuildStart = micros();
    size_t packetSize = buildTDMAPacket(
        pipelinePacket, frameToSend.samples, TDMA_SAMPLES_PER_FRAME,
        frameToSend.sensorCount, frameToSend.frameNumber, prevSample,
        prevSampleValid, deltaOverflowCount, nodeId, syncProtocolVersion,
        lastRttUs, getTimeSinceLastSync(), isTwoWaySyncActive(), samplesConsumed);
    uint32_t tBuild = micros() - tBuildStart;
    if (tBuild > g_packetBuildTimeMax)
        g_packetBuildTimeMax = tBuild;

    if (packetSize == 0)
    {
        return;
    }

    portENTER_CRITICAL(&syncStateLock);
    txPending = true;
    g_txStartTime = micros();
    portEXIT_CRITICAL(&syncStateLock);
    esp_err_t sendResult = esp_now_send(gatewayMac, pipelinePacket, packetSize);
    if (sendResult != ESP_OK)
    {
        // CRITICAL FIX: If esp_now_send() fails synchronously, the send callback
        // will NEVER fire, leaving txPending=true forever → permanent TX deadlock.
        // Clear it immediately so future sends can proceed.
        portENTER_CRITICAL(&syncStateLock);
        txPending = false;
        g_txStartTime = 0;
        sendFailCount++;
        consecutiveSendFailures++; // EXPERT REVIEW FIX: Track synchronous failures
                                   // too
        portEXIT_CRITICAL(&syncStateLock);
        static uint32_t lastSendErrLog = 0;
        if (millis() - lastSendErrLog > 2000)
        {
            Serial.printf("[TDMA] Data send failed: 0x%X (queueFrames=%u)\n",
                          sendResult, frameQueueCount);
            lastSendErrLog = millis();
        }
    }

    // Log stats periodically
    static uint32_t lastTxLog = 0;
    if (millis() - lastTxLog > 5000 &&
        (sendFailCount > 0 || deltaOverflowCount > 0))
    {
        Serial.printf(
            "[TDMA] Stats: Fails=%lu, DeltaOverflows=%lu, QueueFrames=%u\n",
            sendFailCount, deltaOverflowCount, frameQueueCount);
        lastTxLog = millis();
    }
#endif
}
