// ============================================================================
// SyncPTP.cpp — Two-Way Sync (PTP-Lite v2) and Sync Health Monitoring
// ============================================================================
// Extracted from SyncManager.cpp for maintainability.
// Contains: sendDelayReq, handleDelayResp, checkSyncHealth
// ============================================================================
#define DEVICE_ROLE DEVICE_ROLE_NODE

#include "SyncManager.h"
#include <esp_wifi.h>

// ============================================================================
// PHASE 2: Sync Health Check (called periodically from update())
// ============================================================================
void SyncManager::checkSyncHealth()
{
    uint32_t now = millis();

    // Only check every 1 second to avoid spam
    if (now - lastSyncCheckTime < 1000)
    {
        return;
    }
    lastSyncCheckTime = now;

    // Check if beacons have stopped (5 second timeout)
    // Only trigger if we were previously receiving beacons AND not already in
    // recovery
    // Check if beacons have stopped (5 second timeout)
    // OR if we are in "Zombie Mode" (hearing beacons but unable to send)
    // 0x3067 errors mean the WiFi stack is corrupted and needs peer re-reg.

    bool beaconTimeout = lastBeaconMillis > 0 && (now - lastBeaconMillis > 5000);

    // ZOMBIE DETECTION v2 (Consecutive Failure Counter)
    // The previous delta-based check was too slow/unreliable.
    // Now we track continuous failures. At 200Hz, 100 failures = 0.5s of data
    // loss. If we can't send for 0.5s despite receiving beacons, the stack is
    // broken.
    bool isZombie = (consecutiveSendFailures > 100);

    if (isZombie)
    {
        Serial.printf("[SYNC RECOVERY] Zombie detected! Beacons ok but %lu "
                      "consecutive send failures\n",
                      consecutiveSendFailures);
    }

    if ((beaconTimeout || isZombie) && !inRecoveryMode)
    {
        if (beaconTimeout)
        {
            Serial.printf("[SYNC RECOVERY] No beacons for 5s! delta=%lu ms, "
                          "lastBeaconMillis=%lu, now=%lu\n",
                          now - lastBeaconMillis, lastBeaconMillis, now);
        }

        // Only change state if we were actually synced (avoid state thrashing)
        if (tdmaNodeState == TDMA_NODE_SYNCED)
        {
            tdmaNodeState = TDMA_NODE_REGISTERED; // Stay registered, try to re-sync
        }
        else
        {
            tdmaNodeState = TDMA_NODE_UNREGISTERED;
        }
        if (onStateChangeCallback)
            onStateChangeCallback(tdmaNodeState);

        // ========================================================================
        // CRITICAL FIX: Re-register Gateway ESP-NOW peer on recovery
        // ========================================================================
        // After beacon loss OR Zombie detection, the internal WiFi/ESP-NOW state
        // is likely corrupted. Fix: delete and re-add peer.
        //
        // RATE-LIMITED: Only re-register at most once per 60s to avoid
        // hammering the WiFi stack. Repeated esp_now_del_peer/add_peer cycles
        // corrupt internal WiFi state → INT_WDT crash after ~12 cycles.
        // ========================================================================
        if (gatewayMacDiscovered)
        {
            static uint32_t lastPeerReRegTime = 0;
            bool rateLimitOk =
                (now - lastPeerReRegTime > 60000) || lastPeerReRegTime == 0;

            // Force re-reg for Zombies immediately (they are already broken)
            if (isZombie)
                rateLimitOk = true;

            if (rateLimitOk)
            {
                if (isZombie)
                {
                    // EXPERT REVIEW FIX (v9): Full stack reinit for Zombies (0x3067
                    // recovery)
                    reinitEspNow();
                    consecutiveSendFailures = 0;
                    lastPeerReRegTime = now;
                }
                else
                {
                    // Standard peer refresh
                    if (esp_now_is_peer_exist(gatewayMac))
                    {
                        esp_now_del_peer(gatewayMac);
                    }
                    esp_now_peer_info_t peerInfo = {};
                    memcpy(peerInfo.peer_addr, gatewayMac, 6);
                    peerInfo.channel =
                        lastKnownChannel > 0 ? lastKnownChannel : ESP_NOW_CHANNEL;
                    peerInfo.encrypt = false;
                    esp_err_t addResult = esp_now_add_peer(&peerInfo);
                    if (addResult == ESP_OK)
                    {
                        pinEspNowPhyRate(gatewayMac); // Pin unicast to 802.11g 6 Mbps
                    }
                    Serial.printf(
                        "[RECOVERY] Re-registered Gateway peer on ch %d (result: "
                        "0x%X, consec_fails=%lu)\n",
                        peerInfo.channel, addResult, consecutiveSendFailures);
                    lastPeerReRegTime = now;

                    // Reset failures after re-reg attempts to give it a chance
                    consecutiveSendFailures = 0;
                }
            }
            else
            {
                Serial.printf("[RECOVERY] Skipping peer re-reg (cooldown active)\n");
            }
        }
        // ========================================================================
        // ========================================================================

        // CRITICAL: Enter recovery mode - stay on last channel and retry
        inRecoveryMode = true;
        recoveryModeStartTime = now;
        lastRegistrationTime = 0;     // Force immediate registration
        registeredStateStartTime = 0; // Reset REGISTERED timeout tracker

        sendTDMARegistration();
        consecutiveBeaconLosses++;

        Serial.printf(
            "[RECOVERY] Will retry on channel %d for 15s before scanning\n",
            lastKnownChannel);
        // Don't return - let update() continue to process any incoming packets
    }
}

// ============================================================================
// PHASE 0: Two-Way Sync Implementation (PTP-Lite v2)
// ============================================================================
// Implements research-grade time synchronization using RTT measurement.
// No filtering - raw offset calculation from timestamps.
//
// Protocol:
// 1. Node sends DELAY_REQ with T1 (local TSF)
// 2. Gateway records T2 (TSF on receive), T3 (TSF on send)
// 3. Gateway responds with DELAY_RESP containing T1, T2, T3
// 4. Node records T4 (TSF on receive)
// 5. Offset = ((T2-T1) + (T3-T4)) / 2
//    RTT = (T4-T1) - (T3-T2)
// ============================================================================

void SyncManager::sendDelayReq()
{
    // Capture T1 timestamp FIRST (minimize software delay)
    // Use micros() since TSF is not synchronized without WiFi AP connection
    uint64_t t1 = (uint64_t)micros();

    TDMADelayReqPacket req;
    req.type = TDMA_PACKET_DELAY_REQ;
    req.nodeId = nodeId;
    req.sequenceNum = ++delayReqSequence;
    req.nodeT1Tsf = t1;

    // Store pending request info
    pendingT1 = t1;
    pendingSequence = req.sequenceNum;
    awaitingDelayResp = true;
    lastDelayReqTime = millis();

    // Send to Gateway
    esp_err_t result = esp_now_send(gatewayMac, (uint8_t *)&req, sizeof(req));
    if (result != ESP_OK)
    {
        awaitingDelayResp = false;
        Serial.printf("[SYNC] DELAY_REQ send failed: 0x%X\n", result);
    }
}

void SyncManager::handleDelayResp(const uint8_t *data, int len)
{
    // Capture T4 timestamp FIRST (minimize software delay)
    // Use micros() since TSF is not synchronized without WiFi AP connection
    uint64_t t4 = (uint64_t)micros();

    TDMADelayRespPacket *resp = (TDMADelayRespPacket *)data;

    // Verify this response is for us
    if (resp->nodeId != nodeId)
    {
        return; // Not for us
    }

    // Verify sequence number matches
    if (resp->sequenceNum != pendingSequence || !awaitingDelayResp)
    {
        Serial.printf("[SYNC] DELAY_RESP seq mismatch: got %lu, expected %lu\n",
                      resp->sequenceNum, pendingSequence);
        return;
    }

    awaitingDelayResp = false;

    // Extract timestamps
    uint64_t t1 = resp->nodeT1Tsf;    // Our send time (echoed back)
    uint64_t t2 = resp->gatewayT2Tsf; // Gateway receive time
    uint64_t t3 = resp->gatewayT3Tsf; // Gateway send time

    // Calculate offset and RTT using standard PTP formula
    // offset = ((T2-T1) + (T3-T4)) / 2
    // RTT = (T4-T1) - (T3-T2)
    int64_t d1 = (int64_t)t2 - (int64_t)t1; // Forward delay + offset
    int64_t d2 = (int64_t)t3 - (int64_t)t4; // Return delay - offset

    int64_t newOffset = (d1 + d2) / 2;
    int64_t rtt = ((int64_t)t4 - (int64_t)t1) - ((int64_t)t3 - (int64_t)t2);

    // ============================================================================
    // STATISTICAL FILTERING FOR IMPROVED ACCURACY
    // ============================================================================
    // 1. Sanity check: RTT should be positive and reasonable
    // 2. Quality check: Reject if RTT is >3x the running average (outlier)
    // 3. Median filter: Use middle value of last N samples (rejects outliers)
    //
    // NOTE: Multi-sensor nodes with I2C multiplexers have higher RTT (~8-15ms)
    // because the ESP-NOW callback may be delayed by ongoing I2C operations.
    // Single-sensor nodes typically see ~2-5ms RTT.
    // ============================================================================

    // Basic sanity check - allow up to 20ms for multi-sensor nodes
    // (6 sensors × ~2ms I2C read time + ESP-NOW overhead)
    if (rtt < 0 || rtt > 20000)
    {
        Serial.printf("[SYNC] Bad RTT: %lld us (discarding, max=20000)\n", rtt);
        return;
    }

    // Quality check: reject RTT outliers (>2x average after initial calibration)
    if (validSampleCount >= 3 && avgRttUs > 0)
    {
        if (rtt > (int64_t)avgRttUs * 3) // Allow 3x variance
        {
            Serial.printf("[SYNC] RTT outlier: %lld us (avg=%u, discarding)\n", rtt,
                          avgRttUs);
            return;
        }
    }

    // Store sample in circular buffer
    offsetSamples[offsetSampleIndex] = newOffset;
    rttSamples[offsetSampleIndex] = (uint16_t)rtt;
    offsetSampleIndex = (offsetSampleIndex + 1) % OFFSET_SAMPLE_COUNT;
    if (validSampleCount < OFFSET_SAMPLE_COUNT)
    {
        validSampleCount++;
    }

    // Update running average RTT (simple exponential moving average)
    if (avgRttUs == 0)
    {
        avgRttUs = (uint16_t)rtt;
    }
    else
    {
        avgRttUs =
            (avgRttUs * 7 + (uint16_t)rtt) / 8; // ~12.5% weight to new sample
    }

    // Calculate filtered offset using median of collected samples
    int64_t filteredOffset;
    if (validSampleCount >= 3)
    {
        // Copy samples for sorting (don't modify original buffer)
        int64_t sortedSamples[OFFSET_SAMPLE_COUNT];
        memcpy(sortedSamples, offsetSamples, validSampleCount * sizeof(int64_t));

        // Simple bubble sort (N is small, so O(N²) is fine)
        for (int i = 0; i < validSampleCount - 1; i++)
        {
            for (int j = 0; j < validSampleCount - i - 1; j++)
            {
                if (sortedSamples[j] > sortedSamples[j + 1])
                {
                    int64_t temp = sortedSamples[j];
                    sortedSamples[j] = sortedSamples[j + 1];
                    sortedSamples[j + 1] = temp;
                }
            }
        }

        // Take median (middle value)
        filteredOffset = sortedSamples[validSampleCount / 2];
    }
    else
    {
        // Not enough samples yet, use latest
        filteredOffset = newOffset;
    }

    // Store filtered offset
    twoWayOffset = filteredOffset;
    timeOffset = (int32_t)filteredOffset;
    smoothedOffset = timeOffset;

    // ============================================================================
    // CRITICAL: Keep tsfOffset synchronized with PTP result
    // ============================================================================
    // The beacon-anchored timestamp system uses beaconGatewayTimeUs directly,
    // but we still need consistent offsets for:
    // 1. Drift detection (comparing PTP offset vs beacon offset)
    // 2. Fallback if beacon timestamps become unreliable
    // 3. Diagnostic logging and sync quality assessment
    //
    // By updating tsfOffset when PTP completes, we ensure all offset variables
    // are consistent, preventing the "two competing systems" bug.
    // ============================================================================
    tsfOffset = filteredOffset;

    lastRttUs = (uint16_t)rtt;
    lastTwoWaySyncTime = millis();

    // Log periodically (every 10th successful sync)
    static uint32_t syncCount = 0;
    if (++syncCount % 10 == 1)
    {
        Serial.printf("[SYNC] Two-way: raw=%lld, filtered=%lld us, RTT=%u us "
                      "(avg=%u, samples=%d)\n",
                      newOffset, filteredOffset, lastRttUs, avgRttUs,
                      validSampleCount);
    }
}
// ============================================================================
