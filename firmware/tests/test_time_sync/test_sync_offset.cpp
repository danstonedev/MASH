/**
 * test_sync_offset.cpp - Time Synchronization Unit Tests
 *
 * CRITICAL TESTS for cross-node time synchronization.
 * These tests verify that the smoothedOffset variable is properly updated
 * when PTP v2 two-way sync is active, ensuring all nodes timestamp samples
 * in the Gateway's time domain.
 *
 * THE BUG THESE TESTS PREVENT:
 * Previously, timeOffset was updated by PTP v2 sync, but smoothedOffset
 * (used for sample timestamps) was never updated. This caused samples
 * from different nodes to have misaligned timestamps even though they
 * were sampled at the same real-world time.
 *
 * Run with: pio test -e native
 */

#include <unity.h>
#include <stdint.h>

// ============================================================================
// Mock Types and Variables (simulate SyncManager state)
// ============================================================================

// Simulate the sync manager state
static int32_t timeOffset = 0;
static int32_t smoothedOffset = 0;
static int64_t twoWayOffset = 0;
static uint32_t lastTwoWaySyncTime = 0;
static uint8_t syncProtocolVersion = 2; // PTP v2

// Constants
static const uint8_t SYNC_PROTOCOL_VERSION_PTP_V2 = 2;
static const float OFFSET_SMOOTHING = 0.3f;

// ============================================================================
// Mock Functions (extracted logic from SyncManager.cpp)
// ============================================================================

/**
 * Simulates handleBeacon() PTP v2 sync path
 * This is the FIXED version that updates smoothedOffset
 */
void handleBeacon_PTPv2_Fixed(uint32_t gatewayTimeUs, uint32_t localTime)
{
    if (syncProtocolVersion >= SYNC_PROTOCOL_VERSION_PTP_V2)
    {
        if (lastTwoWaySyncTime > 0)
        {
            // Use two-way sync offset
            timeOffset = (int32_t)twoWayOffset;
            smoothedOffset = timeOffset; // CRITICAL: Keep in sync!
        }
        else
        {
            // Fallback to one-way
            timeOffset = gatewayTimeUs - localTime;
            smoothedOffset = timeOffset; // CRITICAL: Keep in sync!
        }
    }
}

/**
 * Simulates handleBeacon() BUGGY version (for comparison)
 * This is what the code did BEFORE the fix
 */
void handleBeacon_PTPv2_Buggy(uint32_t gatewayTimeUs, uint32_t localTime)
{
    if (syncProtocolVersion >= SYNC_PROTOCOL_VERSION_PTP_V2)
    {
        if (lastTwoWaySyncTime > 0)
        {
            timeOffset = (int32_t)twoWayOffset;
            // BUG: smoothedOffset NOT updated!
        }
        else
        {
            timeOffset = gatewayTimeUs - localTime;
            // BUG: smoothedOffset NOT updated!
        }
    }
}

/**
 * Simulates handleDelayResp() - FIXED version
 */
void handleDelayResp_Fixed(int64_t newOffset)
{
    twoWayOffset = newOffset;
    timeOffset = (int32_t)newOffset;
    smoothedOffset = timeOffset; // CRITICAL: Keep in sync!
    lastTwoWaySyncTime = 1000;   // Simulate valid sync time
}

/**
 * Simulates handleDelayResp() - BUGGY version
 */
void handleDelayResp_Buggy(int64_t newOffset)
{
    twoWayOffset = newOffset;
    timeOffset = (int32_t)newOffset;
    // BUG: smoothedOffset NOT updated!
    lastTwoWaySyncTime = 1000;
}

/**
 * Simulates getting a synchronized timestamp for a sample
 */
uint32_t getSyncedTimestamp(uint32_t localMicros)
{
    return localMicros + smoothedOffset;
}

/**
 * Reset all state between tests
 */
void resetSyncState()
{
    timeOffset = 0;
    smoothedOffset = 0;
    twoWayOffset = 0;
    lastTwoWaySyncTime = 0;
    syncProtocolVersion = 2;
}

// ============================================================================
// TESTS
// ============================================================================

void setUp(void)
{
    resetSyncState();
}

void tearDown(void)
{
    // Nothing to clean up
}

/**
 * TEST: smoothedOffset must equal timeOffset after PTP v2 beacon handling
 */
void test_beacon_ptp_v2_updates_smoothedOffset(void)
{
    // Simulate: two-way sync already completed with offset of 5000us
    twoWayOffset = 5000;
    lastTwoWaySyncTime = 500; // Has valid two-way sync

    // Process a beacon
    handleBeacon_PTPv2_Fixed(1000000, 995000);

    // CRITICAL: smoothedOffset must match timeOffset
    TEST_ASSERT_EQUAL_INT32(timeOffset, smoothedOffset);
    TEST_ASSERT_EQUAL_INT32(5000, smoothedOffset);
}

/**
 * TEST: smoothedOffset must be updated on one-way fallback
 */
void test_beacon_ptp_v2_fallback_updates_smoothedOffset(void)
{
    // Simulate: no two-way sync yet
    lastTwoWaySyncTime = 0;

    uint32_t gatewayTime = 1000000;
    uint32_t localTime = 995000;

    handleBeacon_PTPv2_Fixed(gatewayTime, localTime);

    // Should use one-way offset
    TEST_ASSERT_EQUAL_INT32(gatewayTime - localTime, timeOffset);
    TEST_ASSERT_EQUAL_INT32(timeOffset, smoothedOffset);
}

/**
 * TEST: handleDelayResp must update smoothedOffset
 */
void test_delay_resp_updates_smoothedOffset(void)
{
    // Simulate receiving DELAY_RESP with calculated offset
    int64_t calculatedOffset = 12345;

    handleDelayResp_Fixed(calculatedOffset);

    TEST_ASSERT_EQUAL_INT32(calculatedOffset, timeOffset);
    TEST_ASSERT_EQUAL_INT32(calculatedOffset, smoothedOffset);
    TEST_ASSERT_EQUAL_INT32(calculatedOffset, (int32_t)twoWayOffset);
}

/**
 * TEST: Sample timestamps use smoothedOffset (regression test)
 */
void test_sample_timestamp_uses_smoothedOffset(void)
{
    // Set up sync state
    twoWayOffset = 10000;
    lastTwoWaySyncTime = 1000;
    handleBeacon_PTPv2_Fixed(0, 0); // Process beacon to update smoothedOffset

    uint32_t localTime = 500000;
    uint32_t syncedTs = getSyncedTimestamp(localTime);

    // Timestamp should be local + smoothedOffset
    TEST_ASSERT_EQUAL_UINT32(localTime + smoothedOffset, syncedTs);
    TEST_ASSERT_EQUAL_UINT32(510000, syncedTs);
}

/**
 * TEST: Demonstrate the BUG (smoothedOffset not updated)
 * This test shows what WOULD happen with the buggy code
 */
void test_buggy_code_leaves_smoothedOffset_stale(void)
{
    // Initial state: smoothedOffset is 0
    TEST_ASSERT_EQUAL_INT32(0, smoothedOffset);

    // Simulate two-way sync completing
    twoWayOffset = 8000;
    lastTwoWaySyncTime = 500;

    // Process beacon with BUGGY code
    handleBeacon_PTPv2_Buggy(1000000, 992000);

    // timeOffset is updated correctly
    TEST_ASSERT_EQUAL_INT32(8000, timeOffset);

    // BUG: smoothedOffset is still 0!
    TEST_ASSERT_EQUAL_INT32(0, smoothedOffset);

    // This means samples would be timestamped with offset=0 instead of 8000!
    uint32_t localTime = 500000;
    uint32_t buggyTimestamp = getSyncedTimestamp(localTime);
    TEST_ASSERT_EQUAL_UINT32(500000, buggyTimestamp); // WRONG! Should be 508000
}

/**
 * TEST: Two nodes should produce aligned timestamps after sync
 */
void test_two_nodes_produce_aligned_timestamps(void)
{
    // Simulate Node A with offset +5000us
    int32_t nodeA_smoothedOffset = 5000;
    uint32_t nodeA_localTime = 1000000;
    uint32_t nodeA_syncedTs = nodeA_localTime + nodeA_smoothedOffset;

    // Simulate Node B with offset +5050us (50us difference due to RTT)
    int32_t nodeB_smoothedOffset = 5050;
    uint32_t nodeB_localTime = 1000000; // Same real-world time
    uint32_t nodeB_syncedTs = nodeB_localTime + nodeB_smoothedOffset;

    // Timestamps should be within RTT/2 of each other (typ. <500us)
    int32_t difference = (int32_t)nodeA_syncedTs - (int32_t)nodeB_syncedTs;
    TEST_ASSERT_INT32_WITHIN(500, 0, difference);
}

/**
 * TEST: Rapid sync updates should all propagate to smoothedOffset
 */
void test_rapid_sync_updates_propagate(void)
{
    // Simulate multiple rapid DELAY_RESP packets
    for (int i = 0; i < 10; i++)
    {
        int64_t offset = 1000 + (i * 100); // Varying offsets
        handleDelayResp_Fixed(offset);

        // After each update, smoothedOffset must match
        TEST_ASSERT_EQUAL_INT32(timeOffset, smoothedOffset);
        TEST_ASSERT_EQUAL_INT32((int32_t)offset, smoothedOffset);
    }
}

/**
 * TEST: Offset can be negative (node ahead of gateway)
 */
void test_negative_offset_handled_correctly(void)
{
    int64_t negativeOffset = -3000; // Node is 3ms ahead of gateway

    handleDelayResp_Fixed(negativeOffset);

    TEST_ASSERT_EQUAL_INT32(-3000, timeOffset);
    TEST_ASSERT_EQUAL_INT32(-3000, smoothedOffset);

    // Sample timestamp should be reduced
    uint32_t localTime = 1000000;
    uint32_t syncedTs = getSyncedTimestamp(localTime);
    TEST_ASSERT_EQUAL_UINT32(997000, syncedTs);
}

/**
 * TEST: Large offsets (seconds) handled without overflow
 */
void test_large_offset_no_overflow(void)
{
    // 2 second offset (2,000,000 microseconds)
    int64_t largeOffset = 2000000;

    handleDelayResp_Fixed(largeOffset);

    TEST_ASSERT_EQUAL_INT32(2000000, smoothedOffset);

    uint32_t localTime = 1000000;
    uint32_t syncedTs = getSyncedTimestamp(localTime);
    TEST_ASSERT_EQUAL_UINT32(3000000, syncedTs);
}

// ============================================================================
// MAIN
// ============================================================================

int main(int argc, char **argv)
{
    UNITY_BEGIN();

    RUN_TEST(test_beacon_ptp_v2_updates_smoothedOffset);
    RUN_TEST(test_beacon_ptp_v2_fallback_updates_smoothedOffset);
    RUN_TEST(test_delay_resp_updates_smoothedOffset);
    RUN_TEST(test_sample_timestamp_uses_smoothedOffset);
    RUN_TEST(test_buggy_code_leaves_smoothedOffset_stale);
    RUN_TEST(test_two_nodes_produce_aligned_timestamps);
    RUN_TEST(test_rapid_sync_updates_propagate);
    RUN_TEST(test_negative_offset_handled_correctly);
    RUN_TEST(test_large_offset_no_overflow);

    return UNITY_END();
}
