// ============================================================================
// SyncBeacon.cpp — TDMA Beacon, Schedule, and Registration handling
// ============================================================================
// Extracted from SyncManager.cpp for maintainability.
// Contains: handleTDMABeacon, handleTDMASchedule, sendTDMARegistration
// ============================================================================
#define DEVICE_ROLE DEVICE_ROLE_NODE

#include "SyncManager.h"
#include "PowerStateManager.h"
#include <esp_wifi.h>

// ============================================================================
// TDMA BEACON HANDLER
// ============================================================================

void SyncManager::handleTDMABeacon(const uint8_t *data, int len)
{
    TDMABeaconPacket *beacon = (TDMABeaconPacket *)data;

    // Track the channel we found the gateway on
    lastKnownChannel = beacon->wifiChannel;

    // ============================================================================
    // DEBUG: Log beacon flags to diagnose SYNC_RESET detection issue
    // ============================================================================
    static uint32_t lastFlagDebug = 0;
    if (millis() - lastFlagDebug > 2000)
    {
        lastFlagDebug = millis();
        uint8_t resetBit = (beacon->flags & SYNC_FLAG_RESET_MASK) ? 1 : 0;
        uint8_t state = (beacon->flags >> SYNC_FLAG_STATE_SHIFT) & 0x0F;
        uint8_t version = beacon->flags & SYNC_FLAG_VERSION_MASK;
        Serial.printf("[BEACON FLAGS] raw=0x%02X, state=%d, reset=%d, version=%d\n",
                      beacon->flags, state, resetBit, version);
    }

    // ============================================================================
    // PHASE 0: Extract sync protocol version from beacon flags
    // ============================================================================
    // Bit layout: [7:4]=TDMA state, [3]=SYNC_RESET, [2:0]=sync protocol version
    syncProtocolVersion = beacon->flags & SYNC_FLAG_VERSION_MASK;
    // ============================================================================

    // ============================================================================
    // SYNC RESET: Gateway requested all nodes reset their timing state
    // ============================================================================
    // This happens when:
    //   - Web app connects and starts streaming
    //   - Recording starts
    //   - Gateway restarts
    //
    // Gateway broadcasts SYNC_RESET for 10 beacons (200ms) to ensure all nodes
    // receive it even with packet loss. We only log the first one per reset
    // cycle.
    // ============================================================================

    // CRITICAL: These must be at function scope (not inside the if block) so we
    // can check resetInProgress when deciding whether to update
    // currentFrameNumber.
    static bool syncResetInProgress = false;
    static uint32_t lastSyncResetTime = 0;

    // If >500ms since last reset, the reset cycle has ended
    if (millis() - lastSyncResetTime > 500)
    {
        syncResetInProgress = false;
    }

    if (beacon->flags & SYNC_FLAG_RESET_MASK)
    {
        // CRITICAL FIX: Only reset timing on the FIRST beacon of a reset cycle!
        // Gateway broadcasts SYNC_RESET for 10 beacons (200ms), but we must only
        // reset once. Previously, we reset timing on EVERY beacon with the flag,
        // causing samples to fail the "stale beacon" check when lastBeaconTime
        // was cleared mid-stream. This caused ~27% sample loss!
        if (!syncResetInProgress)
        {
            Serial.printf(
                "[SYNC] Received SYNC_RESET - resetting timing (frame was %lu)\n",
                currentFrameNumber);
            syncResetInProgress = true;

            // EXPERT REVIEW FIX: Wrap shared timing state in syncStateLock.
            // bufferSample() on Core 1 reads these under the same lock.
            // Without this, a SYNC_RESET during bufferSample produces torn reads.
            portENTER_CRITICAL(&syncStateLock);
            lastBeaconTime = 0;
            beaconGatewayTimeUs = 0;
            samplesSinceBeacon = 0;
            currentFrameNumber = 0;
            portEXIT_CRITICAL(&syncStateLock);

            // CRITICAL: Clear any queued frames to avoid sending stale samples
            frameQueueTail = 0;
            frameQueueCount = 0;
            memset(frameQueue, 0, sizeof(frameQueue));

            // Clear any in-flight pipeline state
            pipelinePacketReady = false;
            pipelinePacketSize = 0;
            pipelineSamplesConsumed = 0;

            // Reset PTP/two-way sync state
            twoWayOffset = 0;
            avgRttUs = 0;
            validSampleCount = 0;
            lastTwoWaySyncTime = 0;
            lastDelayReqTime = 0;
            awaitingDelayResp = false;

            // Reset offset smoothing
            tsfOffset = 0;
            smoothedOffset = 0;
            timeOffset = 0;
            tsfSyncValid = false;
        }
        // Update lastSyncResetTime for ALL beacons in the cycle (to detect cycle
        // end)
        lastSyncResetTime = millis();

        // CRITICAL: During SYNC_RESET cycle, we SKIP updating currentFrameNumber
        // from the beacon. All nodes must start at frame 0 regardless of which
        // beacon in the 10-beacon cycle they first receive. The frame number
        // will naturally sync on the FIRST beacon AFTER the reset cycle ends.
        // This is handled by the check below at the currentFrameNumber assignment.
    }
    // ============================================================================

    // ============================================================================
    // SYNC RECOVERY: Beacon State Monitoring
    // ============================================================================
    uint8_t beaconState =
        (beacon->flags >> 4) & 0x0F; // Extract state from flags upper nibble
    gatewayStreaming = (beacon->flags & SYNC_FLAG_STREAMING) != 0;

    // Detect Gateway reset (state changed from RUNNING back to DISCOVERY)
    if (lastGatewayState == TDMA_STATE_RUNNING &&
        beaconState == TDMA_STATE_DISCOVERY)
    {
        Serial.println("[SYNC RECOVERY] Gateway reset detected! Re-registering...");
        tdmaNodeState = TDMA_NODE_UNREGISTERED;
        if (onStateChangeCallback)
            onStateChangeCallback(tdmaNodeState);
        // BUG 5 FIX: Defer randomized re-registration to update() context.
        // delay() in ESP-NOW callback blocks the WiFi task.
        portENTER_CRITICAL(&syncStateLock);
        pendingReRegistration = true;
        portEXIT_CRITICAL(&syncStateLock);
    }
    lastGatewayState = beaconState;

    // Reset beacon loss counter (we got a beacon!)
    consecutiveBeaconLosses = 0;

    // ============================================================================
    // CRITICAL FIX: Exit recovery mode when we receive a beacon!
    // Recovery mode was blocking reconnection because it returned early from
    // update()
    // ============================================================================
    if (inRecoveryMode)
    {
        Serial.println("[RECOVERY] Beacon received! Exiting recovery mode.");
        inRecoveryMode = false;
    }
    // ============================================================================

    // Check if we need to switch to the Gateway's WiFi channel
    static uint8_t currentChannel = 0;
    if (beacon->wifiChannel != 0 && beacon->wifiChannel != currentChannel)
    {
        esp_wifi_set_channel(beacon->wifiChannel, WIFI_SECOND_CHAN_NONE);
        Serial.printf("[TDMA] *** Switching to WiFi channel %d (was %d) ***\n",
                      beacon->wifiChannel, currentChannel);
        currentChannel = beacon->wifiChannel;
    }

    uint32_t localTime = micros();
    lastBeaconTime = localTime;
    lastBeaconMillis = millis(); // Track for timeout detection
    // REMOVED: lastSyncCheckTime = millis();
    // BUG FIX v5: Beacons must NOT reset the health check timer!
    // This prevented checkSyncHealth from running while beacons flowed,
    // then caused stale reads when it finally ran during a brief gap.

    // ============================================================================
    // CRITICAL FIX v3: Only update frame number if NOT in a SYNC_RESET cycle!
    // ============================================================================
    // During SYNC_RESET (10 beacons over 200ms), ALL nodes must end up at frame
    // 0. Problem: If Node A receives SYNC_RESET on beacon #3 (frame=3) and Node B
    // receives it on beacon #7 (frame=7), they end up 4 frames (80ms) apart!
    //
    // Solution: During SYNC_RESET cycle, keep currentFrameNumber at 0 (set by
    // the SYNC_RESET handler). Only resume tracking beacon->frameNumber AFTER
    // the reset cycle ends (500ms of no SYNC_RESET flag).
    // ============================================================================
    // FIX: Acquire syncStateLock to make frame/timestamp updates atomic with
    // respect to bufferSample() freewheel reads on Core 1.
    // NOTE: Lock scope is narrow — excludes Serial.printf/millis to avoid
    // holding the spinlock during slow I/O with interrupts disabled.
    portENTER_CRITICAL(&syncStateLock);
    beaconSequence++;
    // IMPORTANT: Always track the Gateway's frame number.
    // Freezing frameNumber during SYNC_RESET can break streaming if the reset
    // flag is asserted repeatedly while connected (node would keep sending frame
    // 0).
    currentFrameNumber = beacon->frameNumber;

    // ============================================================================
    // HARDWARE TSF TIMESTAMP SYSTEM (Research-Grade Sync)
    // ============================================================================
    // Read LOCAL TSF at beacon reception time for hardware-level timing.
    // TSF is captured in WiFi MAC layer with sub-microsecond precision.
    // This eliminates software jitter from interrupt latency, etc.
    // ============================================================================
    // MICROS-BASED SYNCHRONIZATION (Works without WiFi AP connection)
    // ============================================================================
    // Since TSF requires actual WiFi AP connection (which we don't have with
    // standalone ESP-NOW), we use micros()-based sync instead.
    //
    // The beacon arrival is the synchronization event:
    // - Gateway sends its micros() value in beacon.gatewayTimeUs
    // - Node captures its micros() at beacon reception
    // - Offset = gateway_micros - local_micros (at beacon instant)
    // - For any sample: syncedTimestamp = local_micros + offset
    //
    // This achieves ~100-500us accuracy (limited by ESP-NOW latency jitter)
    // ============================================================================

    uint32_t localMicrosAtBeaconRx = micros();

    // Compute offset: how much to add to local micros() to get gateway time
    // Note: beacon->gatewayTimeUs is the Gateway's micros() when it sent the
    // beacon
    tsfOffset = (int64_t)beacon->gatewayTimeUs - (int64_t)localMicrosAtBeaconRx;
    tsfSyncValid = true;                        // Always valid with micros() approach
    localTsfAtBeaconRx = localMicrosAtBeaconRx; // Store for debugging

    // Legacy fallback fields (kept for compatibility)
    beaconGatewayTimeUs = beacon->gatewayTimeUs;
    samplesSinceBeacon = 0; // Reset sample counter for new frame
    portEXIT_CRITICAL(&syncStateLock);

    // Debug: Log sync offset EVERY 2 SECONDS (outside spinlock to avoid blocking)
    static uint32_t lastSyncDebugTime = 0;
    if (millis() - lastSyncDebugTime > 2000)
    {
        lastSyncDebugTime = millis();
        Serial.printf("[BEACON SYNC] nodeId=%d, gwMicros=%lu, localMicros=%lu, "
                      "offset=%lld us\n",
                      nodeId, beacon->gatewayTimeUs, localMicrosAtBeaconRx,
                      tsfOffset);
    }

    // ============================================================================

    // ============================================================================
    // PHASE 0: Two-Way Sync (PTP-Lite v2)
    // If Gateway supports PTP v2, use two-way sync instead of one-way
    // ============================================================================
    if (syncProtocolVersion >= SYNC_PROTOCOL_VERSION_PTP_V2)
    {
        // Use two-way sync offset if we have one, otherwise fall back to one-way
        if (lastTwoWaySyncTime > 0)
        {
            timeOffset = (int32_t)twoWayOffset;
            smoothedOffset = timeOffset; // CRITICAL FIX: Keep smoothedOffset in sync
                                         // for timestamps!
        }
        else
        {
            // Fallback: use one-way offset until two-way sync completes
            timeOffset = beacon->gatewayTimeUs - localTime;
            smoothedOffset =
                timeOffset; // CRITICAL FIX: Initialize smoothedOffset too
        }

        // ============================================================================
        // ADAPTIVE SYNC INTERVAL
        // ============================================================================
        // - Initial calibration: sync every 100ms until we have enough samples
        // - Stable operation: sync every 500ms to compensate for clock drift
        // - Recovery: if we detect large offset change, increase sync frequency
        // ============================================================================
        uint32_t delayReqInterval;
        if (validSampleCount < OFFSET_SAMPLE_COUNT)
        {
            // Initial calibration - sync frequently to build up sample buffer
            delayReqInterval = 100;
        }
        else if (lastTwoWaySyncTime == 0)
        {
            // Never synced - try frequently
            delayReqInterval = 100;
        }
        else
        {
            // Normal operation - sync every 500ms (2Hz)
            // This compensates for ~20-40ppm crystal drift
            delayReqInterval = 500;
        }

        // ========================================================================
        // LOST DELAY_RESP RECOVERY
        // ========================================================================
        // If we sent a DELAY_REQ but never got the response (packet loss),
        // awaitingDelayResp stays true forever — blocking all future PTP.
        // Clear it after 500ms (25 beacon cycles) to allow retry.
        // ========================================================================
        if (awaitingDelayResp && (millis() - lastDelayReqTime > 500))
        {
            awaitingDelayResp = false;
            static uint32_t lastTimeoutLog = 0;
            if (millis() - lastTimeoutLog > 30000)
            { // Increased to 30s
                lastTimeoutLog = millis();
                Serial.printf("[PTP] DELAY_RESP timeout — clearing for retry\n");
            }
        }

        // Start PTP sync as soon as we're registered (don't wait for SYNCED)
        // This ensures timestamps are accurate even before schedule is received
        //
        // PTP STAGGERING: Only send DELAY_REQ when:
        // 1. It's our designated PTP slot (ptpSlotNode == nodeId), OR
        // 2. We're in initial calibration AND ptpSlotNode == 0xFF (discovery mode),
        // OR
        // 3. PTP is stale — fallback to prevent unbounded clock drift when
        //    slot assignments are missed. Threshold is staggered per nodeId
        //    (2.0s + nodeId×200ms) so nodes don't all retry simultaneously,
        //    which would corrupt each other's T2 timestamps on the gateway.
        //
        // This prevents multiple nodes from doing PTP simultaneously, which would
        // corrupt the Gateway's T2/T3 timestamps.
        bool isOurPtpSlot = (beacon->ptpSlotNode == nodeId);
        bool isInitialCalibration = (validSampleCount < OFFSET_SAMPLE_COUNT) &&
                                    (beacon->ptpSlotNode == 0xFF);
        uint32_t staleThresholdMs =
            2000 +
            (nodeId * 200); // Stagger per node to avoid simultaneous recovery
        bool isPtpStale = (lastTwoWaySyncTime > 0) &&
                          (millis() - lastTwoWaySyncTime > staleThresholdMs);
        bool shouldDoPtp = isOurPtpSlot || isInitialCalibration || isPtpStale;

        if ((tdmaNodeState == TDMA_NODE_REGISTERED ||
             tdmaNodeState == TDMA_NODE_SYNCED) &&
            millis() - lastDelayReqTime > delayReqInterval && !awaitingDelayResp &&
            shouldDoPtp)
        {
            // INT_WDT FIX v7: Defer esp_now_send to update() context.
            // Calling esp_now_send from inside the WiFi RX callback can deadlock.

            // EXPERT REVIEW FIX (v9): Suppress DELAY_REQ when sends are failing
            if (consecutiveSendFailures < 10)
            {
                portENTER_CRITICAL(&syncStateLock);
                pendingDelayReq = true;
                portEXIT_CRITICAL(&syncStateLock);
            }
        }
    }
    else
    {
        // Legacy one-way sync with exponential smoothing
        int32_t newOffset = beacon->gatewayTimeUs - localTime;

        if (smoothedOffset == 0)
        {
            // First beacon - use directly
            smoothedOffset = newOffset;
        }
        else
        {
            // Apply exponential smoothing
            smoothedOffset = (int32_t)(OFFSET_SMOOTHING * newOffset +
                                       (1.0f - OFFSET_SMOOTHING) * smoothedOffset);
        }
        timeOffset = smoothedOffset;
    }
    // ============================================================================

    // If we're unregistered and gateway is in discovery mode, register
    if (tdmaNodeState == TDMA_NODE_UNREGISTERED)
    {
        // FIX: Use beaconState extracted earlier (upper nibble of flags)
        // Previously checked (beacon->flags & 0x01) which was ALWAYS false!
        bool isDiscoveryMode = (beaconState == TDMA_STATE_DISCOVERY);

        if (isDiscoveryMode)
        { // Discovery mode - FIXED bit check
            if (tdmaNodeState != TDMA_NODE_REGISTERED)
            {
                tdmaNodeState = TDMA_NODE_REGISTERED;
                if (onStateChangeCallback)
                    onStateChangeCallback(tdmaNodeState);
            }
            // INT_WDT FIX v7: Defer esp_now_send to update() context.
            portENTER_CRITICAL(&syncStateLock);
            pendingReRegistration = true;
            portEXIT_CRITICAL(&syncStateLock);
        }
        else
        {
            // Gateway not in discovery, but we should still try to register
            if (millis() - lastRegistrationTime > 1000)
            {
                // INT_WDT FIX v7: Defer esp_now_send to update() context.
                portENTER_CRITICAL(&syncStateLock);
                pendingReRegistration = true;
                portEXIT_CRITICAL(&syncStateLock);
            }
        }
    }

    // Log periodically
    static uint32_t lastBeaconLog = 0;
    if (beacon->frameNumber - lastBeaconLog >= 50)
    {
        Serial.printf("[TDMA] Beacon #%lu, offset=%ld us, state=%d\n",
                      beacon->frameNumber, smoothedOffset, tdmaNodeState);
        lastBeaconLog = beacon->frameNumber;
    }
}

// ============================================================================
// TDMA SCHEDULE HANDLER
// ============================================================================

void SyncManager::handleTDMASchedule(const uint8_t *data, int len)
{
    if (len < 3)
    {
        Serial.printf("[TDMA] Schedule packet too short: %d bytes\n", len);
        return;
    }

    TDMASchedulePacket *schedule = (TDMASchedulePacket *)data;
    const int headerSize = 3; // type(1) + nodeCount(1) + reserved(1)
    const int slotSize = sizeof(schedule->slots[0]);
    const int availableSlotBytes = len - headerSize;
    const uint8_t availableSlots =
        (availableSlotBytes > 0) ? (uint8_t)(availableSlotBytes / slotSize) : 0;
    const uint8_t maxProcessSlots =
        (availableSlots < TDMA_MAX_NODES) ? availableSlots : TDMA_MAX_NODES;
    const uint8_t scheduleNodeCount =
        (schedule->nodeCount < maxProcessSlots) ? schedule->nodeCount : maxProcessSlots;

    if (schedule->nodeCount > maxProcessSlots)
    {
        Serial.printf("[TDMA] Schedule truncated: advertised=%u, available=%u\n",
                      schedule->nodeCount, maxProcessSlots);
    }

    // Only log schedule details if we're not already synced (reduces spam)
    bool shouldLog = (tdmaNodeState != TDMA_NODE_SYNCED);

    if (shouldLog)
    {
        Serial.printf("[TDMA] Schedule received: %d nodes, our nodeId=%d\n",
                      scheduleNodeCount, nodeId);

        // Log all nodes in the schedule for debugging
        for (int i = 0; i < scheduleNodeCount; i++)
        {
            Serial.printf(
                "[TDMA]   Schedule slot %d: nodeId=%d, offset=%u, width=%u\n", i,
                schedule->slots[i].nodeId, schedule->slots[i].slotOffsetUs,
                schedule->slots[i].slotWidthUs);
        }
    }

    // Find our slot assignment
    bool foundSlot = false;
    uint32_t oldOffset = mySlotOffsetUs;
    uint32_t oldWidth = mySlotWidthUs;

    for (int i = 0; i < scheduleNodeCount; i++)
    {
        if (schedule->slots[i].nodeId == nodeId)
        {
            mySlotOffsetUs = schedule->slots[i].slotOffsetUs;
            mySlotWidthUs = schedule->slots[i].slotWidthUs;
            foundSlot = true;

            // Only log if slot actually changes (reduces serial spam)
            if (oldOffset != mySlotOffsetUs || oldWidth != mySlotWidthUs ||
                tdmaNodeState != TDMA_NODE_SYNCED)
            {
                Serial.printf("[TDMA] Found our slot! offset=%u us, width=%u us\n",
                              mySlotOffsetUs, mySlotWidthUs);
            }
            break;
        }
    }

    if (foundSlot)
    {
        if (tdmaNodeState != TDMA_NODE_SYNCED)
        {
            tdmaNodeState = TDMA_NODE_SYNCED;
            if (onStateChangeCallback)
                onStateChangeCallback(tdmaNodeState);
            Serial.println(
                "[TDMA] Node is now SYNCED and ready for slot-based transmission");
        }
        // Don't log repeated schedules - we're already synced
    }
    else
    {
        Serial.printf("[TDMA] WARNING: Our nodeId %d not found in schedule!\n",
                      nodeId);
        // Fix: Go to UNREGISTERED so update() loop triggers re-registration
        // Previously stuck in TDMA_NODE_REGISTERED without inRecoveryMode =
        // deadlock
        if (tdmaNodeState != TDMA_NODE_UNREGISTERED)
        {
            tdmaNodeState = TDMA_NODE_UNREGISTERED;
            if (onStateChangeCallback)
                onStateChangeCallback(tdmaNodeState);

            // Force immediate retry
            sendTDMARegistration();
            lastRegistrationTime = millis();
        }
    }
}

// ============================================================================
// TDMA REGISTRATION
// ============================================================================

void SyncManager::sendTDMARegistration()
{
#if DEVICE_ROLE == DEVICE_ROLE_NODE
    TDMARegisterPacket reg;
    reg.type = TDMA_PACKET_REGISTER;
    reg.nodeId = nodeId;
    // Use actual sensor count; send 0 if not yet known so the gateway
    // sizes the slot to the minimum rather than MAX_SENSORS worth of dead air.
    reg.sensorCount = cachedSensorCount;
    reg.hasMag = 0; // Will be set properly when we have SensorManager access
    reg.hasBaro = 0;

    // Power state fields for UI visibility
    if (powerStateManager)
    {
        reg.powerState = (uint8_t)powerStateManager->getState();
        reg.sampleRate =
            powerStateManager->getSampleRateHz() / 10; // Scale: 20 = 200Hz
    }
    else
    {
        reg.powerState = 0;
        reg.sampleRate = 20; // Default 200Hz
    }

    snprintf(reg.nodeName, sizeof(reg.nodeName), "Node-%d", nodeId);

    // Use auto-discovered Gateway MAC (or broadcast if not yet discovered)
    esp_now_send(gatewayMac, (uint8_t *)&reg, sizeof(reg));

    Serial.printf("[TDMA] Sent registration: nodeId=%d, sensorCount=%d, "
                  "powerState=%d, sampleRate=%dHz\n",
                  nodeId, reg.sensorCount, reg.powerState, reg.sampleRate * 10);
#endif
}
