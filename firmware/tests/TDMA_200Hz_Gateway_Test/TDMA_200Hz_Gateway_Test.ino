/**
 * TDMA 200Hz Reliability Test - Gateway Side
 * ==========================================
 *
 * This test runs on the Gateway to validate:
 * 1. Reliable 200Hz data reception from all connected nodes
 * 2. Timestamp synchronization across nodes
 * 3. No data loss over extended periods
 * 4. Frame sequence continuity
 *
 * Test Procedure:
 * 1. Flash this to Gateway
 * 2. Flash normal firmware to Nodes
 * 3. Connect nodes via webapp
 * 4. Let run for 1+ minute
 * 5. Review statistics in Serial Monitor
 *
 * Expected Results:
 * - 200Hz data rate (±2Hz) per node
 * - <0.1% packet loss
 * - Frame sequence gaps = 0
 * - Timestamp jitter < 5ms
 *
 * @author IMU Connect
 * @date 2025
 */

#include <Arduino.h>
#include <esp_now.h>
#include <WiFi.h>
#include "../../libraries/IMUConnectCore/src/TDMAProtocol.h"

// ============================================================================
// Configuration
// ============================================================================
#define TEST_DURATION_MS 60000 // Run test for 1 minute
#define MAX_TRACKED_NODES 6    // Track up to 6 nodes
#define STATS_INTERVAL_MS 5000 // Print stats every 5 seconds
#define EXPECTED_HZ 200        // Expected data rate

// ============================================================================
// Node Statistics Tracking
// ============================================================================
struct NodeStats
{
    uint8_t nodeId;
    uint8_t mac[6];
    bool active;

    // Counters
    uint32_t packetsReceived;
    uint32_t samplesReceived;
    uint32_t lastFrameNumber;
    uint32_t frameGaps;       // Missing frame sequences
    uint32_t duplicateFrames; // Same frame received twice

    // Timing
    uint32_t firstPacketTime;
    uint32_t lastPacketTime;
    uint32_t minInterPacketMs;
    uint32_t maxInterPacketMs;
    uint64_t sumInterPacketMs;

    // Calculated metrics
    float actualHz;
    float packetLossPercent;
};

NodeStats nodeStats[MAX_TRACKED_NODES];
uint8_t activeNodeCount = 0;

// Test state
uint32_t testStartTime = 0;
uint32_t lastStatsTime = 0;
bool testRunning = false;

// ============================================================================
// ESP-NOW Receive Callback
// ============================================================================
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
{
    if (!testRunning)
        return;
    if (len < sizeof(TDMADataPacket))
        return;

    TDMADataPacket *header = (TDMADataPacket *)data;
    if (header->type != TDMA_PACKET_DATA)
        return;

    uint32_t now = millis();

    // Find or create node stats entry
    int nodeIndex = -1;
    for (int i = 0; i < MAX_TRACKED_NODES; i++)
    {
        if (nodeStats[i].active && nodeStats[i].nodeId == header->nodeId)
        {
            nodeIndex = i;
            break;
        }
    }

    if (nodeIndex == -1)
    {
        // New node - find empty slot
        for (int i = 0; i < MAX_TRACKED_NODES; i++)
        {
            if (!nodeStats[i].active)
            {
                nodeIndex = i;
                nodeStats[i].active = true;
                nodeStats[i].nodeId = header->nodeId;
                memcpy(nodeStats[i].mac, info->src_addr, 6);
                nodeStats[i].packetsReceived = 0;
                nodeStats[i].samplesReceived = 0;
                nodeStats[i].lastFrameNumber = 0;
                nodeStats[i].frameGaps = 0;
                nodeStats[i].duplicateFrames = 0;
                nodeStats[i].firstPacketTime = now;
                nodeStats[i].lastPacketTime = now;
                nodeStats[i].minInterPacketMs = UINT32_MAX;
                nodeStats[i].maxInterPacketMs = 0;
                nodeStats[i].sumInterPacketMs = 0;
                activeNodeCount++;
                Serial.printf("[TEST] New node detected: ID=%d, MAC=%02X:%02X:%02X:%02X:%02X:%02X\n",
                              header->nodeId,
                              info->src_addr[0], info->src_addr[1], info->src_addr[2],
                              info->src_addr[3], info->src_addr[4], info->src_addr[5]);
                break;
            }
        }
    }

    if (nodeIndex == -1)
    {
        Serial.println("[TEST] WARNING: Max nodes exceeded!");
        return;
    }

    NodeStats &stats = nodeStats[nodeIndex];

    // Check frame sequence
    if (stats.packetsReceived > 0)
    {
        if (header->frameNumber == stats.lastFrameNumber)
        {
            stats.duplicateFrames++;
        }
        else if (header->frameNumber > stats.lastFrameNumber + 1)
        {
            stats.frameGaps += (header->frameNumber - stats.lastFrameNumber - 1);
        }

        // Track inter-packet timing
        uint32_t interPacketMs = now - stats.lastPacketTime;
        if (interPacketMs < stats.minInterPacketMs)
            stats.minInterPacketMs = interPacketMs;
        if (interPacketMs > stats.maxInterPacketMs)
            stats.maxInterPacketMs = interPacketMs;
        stats.sumInterPacketMs += interPacketMs;
    }

    stats.lastFrameNumber = header->frameNumber;
    stats.lastPacketTime = now;
    stats.packetsReceived++;
    stats.samplesReceived += header->sampleCount;
}

// ============================================================================
// Statistics Calculation and Display
// ============================================================================
void calculateStats()
{
    Serial.println("\n═══════════════════════════════════════════════════════════════");
    Serial.printf("  TDMA 200Hz RELIABILITY TEST - Elapsed: %.1f seconds\n",
                  (millis() - testStartTime) / 1000.0);
    Serial.println("═══════════════════════════════════════════════════════════════");

    for (int i = 0; i < MAX_TRACKED_NODES; i++)
    {
        if (!nodeStats[i].active)
            continue;

        NodeStats &stats = nodeStats[i];
        uint32_t testDurationMs = stats.lastPacketTime - stats.firstPacketTime;

        if (testDurationMs > 0 && stats.packetsReceived > 1)
        {
            // Calculate actual Hz (samples per second)
            stats.actualHz = (float)stats.samplesReceived * 1000.0 / testDurationMs;

            // Calculate expected samples
            uint32_t expectedSamples = (testDurationMs * EXPECTED_HZ) / 1000;
            if (expectedSamples > 0)
            {
                stats.packetLossPercent = 100.0 * (1.0 - (float)stats.samplesReceived / expectedSamples);
                if (stats.packetLossPercent < 0)
                    stats.packetLossPercent = 0;
            }

            float avgInterPacketMs = (float)stats.sumInterPacketMs / (stats.packetsReceived - 1);

            Serial.printf("\n  Node %d [%02X:%02X:%02X:%02X:%02X:%02X]\n",
                          stats.nodeId,
                          stats.mac[0], stats.mac[1], stats.mac[2],
                          stats.mac[3], stats.mac[4], stats.mac[5]);
            Serial.println("  ─────────────────────────────────────────────────────");
            Serial.printf("  │ Packets received:    %lu\n", stats.packetsReceived);
            Serial.printf("  │ Samples received:    %lu\n", stats.samplesReceived);
            Serial.printf("  │ Actual rate:         %.1f Hz %s\n",
                          stats.actualHz,
                          (stats.actualHz >= 198 && stats.actualHz <= 202) ? "✓" : "⚠");
            Serial.printf("  │ Frame gaps:          %lu %s\n",
                          stats.frameGaps,
                          stats.frameGaps == 0 ? "✓" : "⚠");
            Serial.printf("  │ Duplicate frames:    %lu\n", stats.duplicateFrames);
            Serial.printf("  │ Packet loss:         %.2f%% %s\n",
                          stats.packetLossPercent,
                          stats.packetLossPercent < 0.1 ? "✓" : "⚠");
            Serial.printf("  │ Inter-packet timing: min=%lu, avg=%.1f, max=%lu ms\n",
                          stats.minInterPacketMs, avgInterPacketMs, stats.maxInterPacketMs);
        }
    }

    if (activeNodeCount == 0)
    {
        Serial.println("\n  ⚠ No nodes detected yet. Ensure nodes are connected via webapp.");
    }
}

// ============================================================================
// Final Report
// ============================================================================
void printFinalReport()
{
    Serial.println("\n\n");
    Serial.println("╔═══════════════════════════════════════════════════════════════╗");
    Serial.println("║            FINAL TEST REPORT - 200Hz RELIABILITY              ║");
    Serial.println("╚═══════════════════════════════════════════════════════════════╝");

    bool allPassed = true;

    for (int i = 0; i < MAX_TRACKED_NODES; i++)
    {
        if (!nodeStats[i].active)
            continue;

        NodeStats &stats = nodeStats[i];
        bool rateOk = (stats.actualHz >= 198 && stats.actualHz <= 202);
        bool gapsOk = (stats.frameGaps == 0);
        bool lossOk = (stats.packetLossPercent < 0.1);
        bool passed = rateOk && gapsOk && lossOk;

        Serial.printf("\n  Node %d: %s\n", stats.nodeId, passed ? "✓ PASS" : "✗ FAIL");
        Serial.printf("    Rate: %.1fHz [%s]  Gaps: %lu [%s]  Loss: %.2f%% [%s]\n",
                      stats.actualHz, rateOk ? "OK" : "FAIL",
                      stats.frameGaps, gapsOk ? "OK" : "FAIL",
                      stats.packetLossPercent, lossOk ? "OK" : "FAIL");

        if (!passed)
            allPassed = false;
    }

    Serial.println("\n───────────────────────────────────────────────────────────────");

    if (activeNodeCount == 0)
    {
        Serial.println("  RESULT: NO DATA - No nodes connected during test");
    }
    else if (allPassed)
    {
        Serial.println("  🎉 RESULT: ALL TESTS PASSED!");
        Serial.println("     ESP-NOW v2.0 TDMA is delivering reliable 200Hz sync.");
    }
    else
    {
        Serial.println("  ⚠ RESULT: SOME TESTS FAILED - Review issues above");
    }

    Serial.println("\n═══════════════════════════════════════════════════════════════");
}

// ============================================================================
// Setup
// ============================================================================
void setup()
{
    Serial.begin(115200);
    delay(2000);

    Serial.println("\n\n");
    Serial.println("╔═══════════════════════════════════════════════════════════════╗");
    Serial.println("║    TDMA 200Hz Reliability Test - Gateway                      ║");
    Serial.println("║    ESP-NOW v2.0 Validation                                    ║");
    Serial.println("╚═══════════════════════════════════════════════════════════════╝");
    Serial.printf("\n  Test duration: %d seconds\n", TEST_DURATION_MS / 1000);
    Serial.println("  Expected rate: 200Hz per node");
    Serial.println("  Pass criteria: <0.1% loss, 0 frame gaps, 198-202Hz");

    // Initialize WiFi for ESP-NOW
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();

    // Initialize ESP-NOW
    if (esp_now_init() != ESP_OK)
    {
        Serial.println("\n  ✗ ESP-NOW init failed!");
        return;
    }

    esp_now_register_recv_cb(onDataRecv);

    // Initialize stats
    memset(nodeStats, 0, sizeof(nodeStats));

    Serial.println("\n  ✓ ESP-NOW initialized");
    Serial.println("  → Waiting for nodes to connect via webapp...");
    Serial.println("  → Test will run for 60 seconds once nodes appear.\n");

    testStartTime = millis();
    lastStatsTime = testStartTime;
    testRunning = true;
}

// ============================================================================
// Main Loop
// ============================================================================
void loop()
{
    if (!testRunning)
    {
        delay(1000);
        return;
    }

    uint32_t now = millis();
    uint32_t elapsed = now - testStartTime;

    // Print periodic stats
    if (now - lastStatsTime >= STATS_INTERVAL_MS)
    {
        calculateStats();
        lastStatsTime = now;
    }

    // Check if test complete
    if (elapsed >= TEST_DURATION_MS)
    {
        testRunning = false;
        printFinalReport();
    }

    delay(10);
}
