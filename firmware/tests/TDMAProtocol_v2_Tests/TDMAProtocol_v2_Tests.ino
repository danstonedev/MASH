/**
 * TDMA Protocol v2.0 Test Suite
 * ==============================
 *
 * Comprehensive tests for ESP-NOW v2.0 TDMA protocol implementation.
 *
 * Tests validate:
 * 1. Packet size calculations for 1-9 sensor configurations
 * 2. Single-packet guarantee for all practical configs
 * 3. 200Hz timing feasibility
 * 4. Frame time calculations
 * 5. Slot width calculations
 *
 * Upload to any ESP32 to run tests - no WiFi/BLE needed.
 *
 * @author IMU Connect
 * @date 2025
 */

#include <Arduino.h>
#include "../../libraries/IMUConnectCore/src/TDMAProtocol.h"

// Test counters
static uint16_t testsRun = 0;
static uint16_t testsPassed = 0;
static uint16_t testsFailed = 0;

// Test macros
#define TEST_ASSERT(condition, message)               \
    do                                                \
    {                                                 \
        testsRun++;                                   \
        if (condition)                                \
        {                                             \
            testsPassed++;                            \
            Serial.printf("  ✓ PASS: %s\n", message); \
        }                                             \
        else                                          \
        {                                             \
            testsFailed++;                            \
            Serial.printf("  ✗ FAIL: %s\n", message); \
        }                                             \
    } while (0)

#define TEST_ASSERT_EQUAL(expected, actual, message)                                                           \
    do                                                                                                         \
    {                                                                                                          \
        testsRun++;                                                                                            \
        if ((expected) == (actual))                                                                            \
        {                                                                                                      \
            testsPassed++;                                                                                     \
            Serial.printf("  ✓ PASS: %s (expected=%d, actual=%d)\n", message, (int)(expected), (int)(actual)); \
        }                                                                                                      \
        else                                                                                                   \
        {                                                                                                      \
            testsFailed++;                                                                                     \
            Serial.printf("  ✗ FAIL: %s (expected=%d, actual=%d)\n", message, (int)(expected), (int)(actual)); \
        }                                                                                                      \
    } while (0)

// ============================================================================
// Test Group 1: ESP-NOW v2.0 Constants
// ============================================================================
void testConstants()
{
    Serial.println("\n=== Test Group 1: ESP-NOW v2.0 Constants ===\n");

    // Verify v2.0 payload size
    TEST_ASSERT_EQUAL(1470, ESPNOW_MAX_PAYLOAD, "ESP-NOW v2.0 max payload is 1470 bytes");

    // Verify header size
    TEST_ASSERT_EQUAL(8, TDMA_HEADER_SIZE, "TDMA header size is 8 bytes");

    // Verify max data bytes
    TEST_ASSERT_EQUAL(1462, TDMA_MAX_DATA_BYTES, "Max data bytes is 1462 (1470-8)");

    // Verify sensor data size
    TEST_ASSERT_EQUAL(25, TDMA_SENSOR_DATA_SIZE, "Sensor data size is 25 bytes");

    // Verify samples per frame
    TEST_ASSERT_EQUAL(4, TDMA_SAMPLES_PER_FRAME, "Samples per frame is 4 (50Hz TX)");

    // Verify frame period
    TEST_ASSERT_EQUAL(20, TDMA_FRAME_PERIOD_MS, "Frame period is 20ms (50Hz)");
}

// ============================================================================
// Test Group 2: Packet Size Calculations for Various Sensor Counts
// ============================================================================
void testPacketSizes()
{
    Serial.println("\n=== Test Group 2: Packet Sizes for All Sensor Configs ===\n");

    // Test all practical sensor counts (1-9)
    for (uint8_t sensorCount = 1; sensorCount <= 9; sensorCount++)
    {
        // Calculate packet size: header + (sensors * samples * sensorDataSize)
        size_t dataSize = sensorCount * TDMA_SAMPLES_PER_FRAME * TDMA_SENSOR_DATA_SIZE;
        size_t packetSize = TDMA_HEADER_SIZE + dataSize;

        char msg[100];
        snprintf(msg, sizeof(msg), "%d sensors: packet size %d bytes <= 1470",
                 sensorCount, packetSize);
        TEST_ASSERT(packetSize <= ESPNOW_MAX_PAYLOAD, msg);

        // Also verify it fits in one packet
        uint8_t packetsNeeded = calculatePacketsPerFrame(sensorCount);
        snprintf(msg, sizeof(msg), "%d sensors: needs %d packet(s)",
                 sensorCount, packetsNeeded);
        TEST_ASSERT_EQUAL(1, packetsNeeded, msg);
    }

    // Print summary table
    Serial.println("\n  Packet Size Summary Table:");
    Serial.println("  ┌─────────────┬──────────────┬───────────────┬──────────────┐");
    Serial.println("  │ Sensors     │ Data Bytes   │ Total Packet  │ v2.0 Margin  │");
    Serial.println("  ├─────────────┼──────────────┼───────────────┼──────────────┤");

    for (uint8_t s = 1; s <= 9; s++)
    {
        size_t dataBytes = s * TDMA_SAMPLES_PER_FRAME * TDMA_SENSOR_DATA_SIZE;
        size_t totalPacket = TDMA_HEADER_SIZE + dataBytes;
        size_t margin = ESPNOW_MAX_PAYLOAD - totalPacket;
        Serial.printf("  │ %2d          │ %4d         │ %4d          │ %4d (%.0f%%)  │\n",
                      s, dataBytes, totalPacket, margin,
                      100.0 * margin / ESPNOW_MAX_PAYLOAD);
    }
    Serial.println("  └─────────────┴──────────────┴───────────────┴──────────────┘");
}

// ============================================================================
// Test Group 3: Timing Calculations for 200Hz
// ============================================================================
void testTiming()
{
    Serial.println("\n=== Test Group 3: 200Hz Timing Feasibility ===\n");

    // 200Hz = 5ms sample period
    uint32_t samplePeriodUs = 5000;

    // Frame period is 20ms (50Hz TX rate, batching 4 samples)
    uint32_t framePeriodUs = TDMA_FRAME_PERIOD_MS * 1000;
    TEST_ASSERT_EQUAL(20000, framePeriodUs, "Frame period is 20ms");

    // Verify 4 samples fit in one frame
    uint32_t samplingTimeUs = TDMA_SAMPLES_PER_FRAME * samplePeriodUs;
    TEST_ASSERT(samplingTimeUs <= framePeriodUs,
                "4 samples (20ms) fit in 20ms frame");

    // Calculate transmission time for various packet sizes at 6 Mbps OFDM
    Serial.println("\n  Transmission Time Analysis (802.11g 6 Mbps OFDM):");
    Serial.println("  ┌─────────────┬────────────────┬──────────────┬──────────────┐");
    Serial.println("  │ Sensors     │ Packet Bytes   │ Slot (ms)    │ Frame Margin │");
    Serial.println("  ├─────────────┼────────────────┼──────────────┼──────────────┤");

    for (uint8_t s = 1; s <= 9; s++)
    {
        uint16_t slotUs = calculateSlotWidth(s);
        float slotMs = slotUs / 1000.0;
        size_t packetBytes = TDMA_HEADER_SIZE +
                             (s * TDMA_SAMPLES_PER_FRAME * TDMA_SENSOR_DATA_SIZE) + 1;
        float marginMs = 20.0 - slotMs;

        Serial.printf("  │ %2d          │ %4d           │ %.2f         │ %.2f ms     │\n",
                      s, packetBytes, slotMs, marginMs);

        char msg[100];
        snprintf(msg, sizeof(msg), "%d sensors slot (%.2fms) < 20ms frame",
                 s, slotMs);
        TEST_ASSERT(slotMs < 20.0, msg);
    }
    Serial.println("  └─────────────┴────────────────┴──────────────┴──────────────┘");
}

// ============================================================================
// Test Group 4: Multi-Node Frame Calculations
// ============================================================================
void testMultiNodeFrames()
{
    Serial.println("\n=== Test Group 4: Multi-Node Frame Calculations ===\n");

    // Test various node counts with different sensor configs
    struct TestCase
    {
        uint8_t nodeCount;
        uint8_t sensorCounts[6];
        const char *description;
    };

    TestCase testCases[] = {
        // Standard 2-node setup (foot IMUs)
        {2, {3, 3, 0, 0, 0, 0}, "2 nodes × 3 sensors (foot IMUs)"},
        // Full body 6-node setup
        {3, {2, 2, 2, 0, 0, 0}, "3 nodes × 2 sensors (half body)"},
        // Mixed configs
        {2, {6, 3, 0, 0, 0, 0}, "2 nodes (6+3 sensors)"},
        // Single high-density node
        {1, {9, 0, 0, 0, 0, 0}, "1 node x 9 sensors (max practical)"},
        // Schema A: mux-node body capture
        {5, {1, 2, 3, 3, 6, 0}, "Schema A (1+2+3+3+6 mux)"},
        // Schema B: 6-node uniform legs
        {6, {1, 2, 3, 3, 3, 3}, "Schema B (1+2+3+3+3+3)"},
    };

    uint8_t numCases = sizeof(testCases) / sizeof(TestCase);

    Serial.println("  ┌──────────────────────────────────┬─────────────┬──────────────┐");
    Serial.println("  │ Configuration                    │ Frame Time  │ Fits in 20ms │");
    Serial.println("  ├──────────────────────────────────┼─────────────┼──────────────┤");

    for (uint8_t i = 0; i < numCases; i++)
    {
        TestCase &tc = testCases[i];
        uint32_t frameTime = calculateFrameTime(tc.nodeCount, tc.sensorCounts);
        float frameTimeMs = frameTime / 1000.0;
        bool fits = frameTime <= (TDMA_FRAME_PERIOD_MS * 1000);

        Serial.printf("  │ %-32s │ %6.2f ms   │ %s           │\n",
                      tc.description, frameTimeMs, fits ? "YES" : "NO ");

        char msg[100];
        snprintf(msg, sizeof(msg), "%s fits in frame", tc.description);
        TEST_ASSERT(fits, msg);
    }
    Serial.println("  └──────────────────────────────────┴─────────────┴──────────────┘");
}

// ============================================================================
// Test Group 5: calculateMaxSamplesPerPacket() Validation
// ============================================================================
void testMaxSamplesCalculation()
{
    Serial.println("\n=== Test Group 5: calculateMaxSamplesPerPacket() ===\n");

    // For all practical configs with v2.0, should return TDMA_SAMPLES_PER_FRAME (4)
    for (uint8_t sensorCount = 1; sensorCount <= 9; sensorCount++)
    {
        uint8_t maxSamples = calculateMaxSamplesPerPacket(sensorCount);

        char msg[100];
        snprintf(msg, sizeof(msg), "%d sensors: maxSamplesPerPacket = %d",
                 sensorCount, maxSamples);
        TEST_ASSERT_EQUAL(TDMA_SAMPLES_PER_FRAME, maxSamples, msg);
    }

    // Edge case: 0 sensors should return 0
    TEST_ASSERT_EQUAL(0, calculateMaxSamplesPerPacket(0),
                      "0 sensors returns 0 (invalid)");

    // Very high sensor count that might exceed limit
    uint8_t highSensorCount = TDMA_MAX_SENSORS_PER_NODE + 1;
    TEST_ASSERT_EQUAL(0, calculateMaxSamplesPerPacket(highSensorCount),
                      "Excessive sensors returns 0");
}

// ============================================================================
// Test Group 6: Slot Width Calculations
// ============================================================================
void testSlotWidths()
{
    Serial.println("\n=== Test Group 6: Slot Width Calculations ===\n");

    // With 802.11g 6 Mbps OFDM model, airtime is much lower.
    // Most sensor counts fit within the 2500µs minimum slot width.
    // Only very high sensor counts (>= ~7) exceed the minimum.
    uint16_t slot0 = calculateSlotWidth(0);
    uint16_t slot1 = calculateSlotWidth(1);
    uint16_t slot3 = calculateSlotWidth(3);
    uint16_t slot6 = calculateSlotWidth(6);
    uint16_t slot9 = calculateSlotWidth(9);

    Serial.printf("  0 sensor slot: %d us\n", slot0);
    Serial.printf("  1 sensor slot: %d us\n", slot1);
    Serial.printf("  3 sensor slot: %d us\n", slot3);
    Serial.printf("  6 sensor slot: %d us\n", slot6);
    Serial.printf("  9 sensor slot: %d us\n", slot9);

    // At 6 Mbps OFDM, slots 1-6 all clamp to minimum (airtime < overhead floor)
    TEST_ASSERT_EQUAL(TDMA_SLOT_MIN_WIDTH_US, slot0,
                      "0-sensor slot equals minimum width");
    TEST_ASSERT_EQUAL(TDMA_SLOT_MIN_WIDTH_US, slot1,
                      "1-sensor slot clamped to minimum (6 Mbps airtime is small)");
    TEST_ASSERT_EQUAL(TDMA_SLOT_MIN_WIDTH_US, slot6,
                      "6-sensor slot still within minimum at 6 Mbps");

    // 9-sensor slot should exceed the minimum
    // Payload = 909 bytes.  Airtime = 74 + 4*ceil((326+7272)/24) = 74 + 1268 = 1342µs
    // Total = 1500 + 1342 = 2842µs > 2500µs
    TEST_ASSERT(slot9 > TDMA_SLOT_MIN_WIDTH_US,
                "9-sensor slot exceeds minimum width");
    TEST_ASSERT(slot9 > 2800 && slot9 < 2900,
                "9-sensor slot is ~2842µs (expected range)");

    // Monotonicity: higher sensor count should always be >= lower
    TEST_ASSERT(slot9 >= slot6, "9-sensor slot >= 6-sensor slot");
    TEST_ASSERT(slot6 >= slot1, "6-sensor slot >= 1-sensor slot");
}

// ============================================================================
// Test Group 7: TDMA Data Packet Structure
// ============================================================================
void testPacketStructure()
{
    Serial.println("\n=== Test Group 7: TDMA Packet Structure ===\n");

    // Verify TDMADataPacket header is 8 bytes
    TEST_ASSERT_EQUAL(8, sizeof(TDMADataPacket), "TDMADataPacket header is 8 bytes");

    // Verify TDMABatchedSensorData is 25 bytes
    TEST_ASSERT_EQUAL(25, sizeof(TDMABatchedSensorData),
                      "TDMABatchedSensorData is 25 bytes");

    // Create a test packet and verify structure
    uint8_t testBuffer[ESPNOW_MAX_PAYLOAD];
    TDMADataPacket *header = (TDMADataPacket *)testBuffer;

    header->type = TDMA_PACKET_DATA;
    header->nodeId = 1;
    header->frameNumber = 12345;
    header->sampleCount = 4;
    header->sensorCount = 6;

    TEST_ASSERT_EQUAL(TDMA_PACKET_DATA, header->type, "Packet type field");
    TEST_ASSERT_EQUAL(1, header->nodeId, "Node ID field");
    TEST_ASSERT_EQUAL(12345, header->frameNumber, "Frame number field");
    TEST_ASSERT_EQUAL(4, header->sampleCount, "Sample count field");
    TEST_ASSERT_EQUAL(6, header->sensorCount, "Sensor count field");

    // Calculate expected total packet size for 6 sensors, 4 samples
    size_t expectedSize = sizeof(TDMADataPacket) +
                          (6 * 4 * sizeof(TDMABatchedSensorData));
    Serial.printf("\n  Expected packet size for 6 sensors, 4 samples: %d bytes\n",
                  expectedSize);
    TEST_ASSERT(expectedSize <= ESPNOW_MAX_PAYLOAD,
                "6-sensor packet fits in v2.0 payload");
}

// ============================================================================
// Test Group 8: 200Hz Data Rate Verification
// ============================================================================
void test200HzDataRate()
{
    Serial.println("\n=== Test Group 8: 200Hz Data Rate Verification ===\n");

    // 200Hz = 5ms per sample
    // 50Hz frames (20ms) with 4 samples each = 200Hz effective
    uint32_t effectiveRateHz = TDMA_SAMPLES_PER_FRAME * (1000 / TDMA_FRAME_PERIOD_MS);
    TEST_ASSERT_EQUAL(200, effectiveRateHz, "Effective sample rate is 200Hz");

    // Data throughput calculation
    Serial.println("\n  Data Throughput Analysis:");
    Serial.println("  ┌─────────────┬──────────────┬───────────────┬───────────────┐");
    Serial.println("  │ Sensors     │ Bytes/Frame  │ Frames/Sec    │ Throughput    │");
    Serial.println("  ├─────────────┼──────────────┼───────────────┼───────────────┤");

    for (uint8_t s = 1; s <= 9; s++)
    {
        size_t bytesPerFrame = TDMA_HEADER_SIZE +
                               (s * TDMA_SAMPLES_PER_FRAME * TDMA_SENSOR_DATA_SIZE);
        uint32_t framesPerSec = 1000 / TDMA_FRAME_PERIOD_MS;
        uint32_t bytesPerSec = bytesPerFrame * framesPerSec;

        Serial.printf("  │ %2d          │ %4d         │ %2d            │ %5d B/s     │\n",
                      s, bytesPerFrame, framesPerSec, bytesPerSec);
    }
    Serial.println("  └─────────────┴──────────────┴───────────────┴───────────────┘");

    // Verify max throughput is within ESP-NOW capability
    // ESP-NOW at 1 Mbps = 125,000 bytes/sec theoretical max
    uint32_t maxThroughput = (TDMA_HEADER_SIZE +
                              (9 * TDMA_SAMPLES_PER_FRAME * TDMA_SENSOR_DATA_SIZE)) *
                             50;
    TEST_ASSERT(maxThroughput < 125000,
                "Max throughput within ESP-NOW capability");
}

// ============================================================================
// Test Group 9: v1.0 vs v2.0 Comparison (for documentation)
// ============================================================================
void testV1vsV2Comparison()
{
    Serial.println("\n=== Test Group 9: v1.0 vs v2.0 Comparison ===\n");

    const uint16_t V1_MAX_PAYLOAD = 250;
    const uint16_t V2_MAX_PAYLOAD = 1470;
    const uint8_t HEADER_SIZE = 8;

    Serial.println("  Capacity Comparison:");
    Serial.println("  ┌─────────────┬──────────────┬──────────────┬───────────────┐");
    Serial.println("  │ Sensors     │ v1.0 Packets │ v2.0 Packets │ Improvement   │");
    Serial.println("  ├─────────────┼──────────────┼──────────────┼───────────────┤");

    for (uint8_t s = 1; s <= 9; s++)
    {
        size_t dataBytes = s * TDMA_SAMPLES_PER_FRAME * TDMA_SENSOR_DATA_SIZE;

        // v1.0 calculation
        uint8_t v1MaxSamples = (V1_MAX_PAYLOAD - HEADER_SIZE) /
                               (s * TDMA_SENSOR_DATA_SIZE);
        if (v1MaxSamples > TDMA_SAMPLES_PER_FRAME)
            v1MaxSamples = TDMA_SAMPLES_PER_FRAME;
        if (v1MaxSamples == 0)
            v1MaxSamples = 1;
        uint8_t v1Packets = (TDMA_SAMPLES_PER_FRAME + v1MaxSamples - 1) / v1MaxSamples;

        // v2.0 always 1 packet
        uint8_t v2Packets = 1;

        float improvement = (v1Packets > v2Packets) ? (float)v1Packets / v2Packets : 1.0;

        Serial.printf("  │ %2d          │ %2d           │ %2d           │ %.1fx          │\n",
                      s, v1Packets, v2Packets, improvement);

        char msg[100];
        snprintf(msg, sizeof(msg), "%d sensors: v2.0 uses fewer/equal packets to v1.0", s);
        TEST_ASSERT(v2Packets <= v1Packets, msg);
    }
    Serial.println("  └─────────────┴──────────────┴──────────────┴───────────────┘");

    Serial.printf("\n  Summary: v2.0 payload is %.1fx larger than v1.0\n",
                  (float)V2_MAX_PAYLOAD / V1_MAX_PAYLOAD);
}

// ============================================================================
// Main Setup/Loop
// ============================================================================
void setup()
{
    Serial.begin(115200);
    delay(2000); // Wait for serial monitor

    Serial.println();
    Serial.println("╔═══════════════════════════════════════════════════════════════╗");
    Serial.println("║    TDMA Protocol v2.0 Test Suite                              ║");
    Serial.println("║    ESP-NOW v2.0 (1470 bytes) Validation                       ║");
    Serial.println("╚═══════════════════════════════════════════════════════════════╝");

    // Run all test groups
    testConstants();
    testPacketSizes();
    testTiming();
    testMultiNodeFrames();
    testMaxSamplesCalculation();
    testSlotWidths();
    testPacketStructure();
    test200HzDataRate();
    testV1vsV2Comparison();

    // Print final summary
    Serial.println("\n╔═══════════════════════════════════════════════════════════════╗");
    Serial.printf("║    TEST SUMMARY: %d/%d tests passed                            ║\n",
                  testsPassed, testsRun);
    Serial.println("╚═══════════════════════════════════════════════════════════════╝");

    if (testsFailed == 0)
    {
        Serial.println("\n🎉 ALL TESTS PASSED! ESP-NOW v2.0 TDMA protocol is ready.");
        Serial.println("   All sensor configs (1-9) fit in single packet.");
        Serial.println("   200Hz data rate is achievable with room to spare.");
    }
    else
    {
        Serial.printf("\n⚠️  %d TESTS FAILED - review failures above.\n", testsFailed);
    }

    Serial.println("\n--- Test complete. Reset to run again. ---");
}

void loop()
{
    // Nothing to do - tests run once in setup
    delay(10000);
}
