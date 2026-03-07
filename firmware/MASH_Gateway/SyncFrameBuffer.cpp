/**
 * SyncFrameBuffer.cpp - Cross-Node Synchronized Frame Assembly
 *
 * Implements the Sync Frame Buffer for assembling synchronized multi-sensor
 * data packets from individual node transmissions.
 */

// IMPORTANT: Define DEVICE_ROLE before including Config.h
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include "SyncFrameBuffer.h"
#include "SyncManager.h" // For getSyncEpoch()

// ============================================================================
// CROSS-NODE TIMESTAMP SYNCHRONIZATION (v10 - Simplified Epoch-Relative)
// ============================================================================
// v6: Epoch-relative truncation → boundary aliasing (70% incomplete frames)
// v7: Frame-anchored normalization → fails when nodes have different
// frameNumbers v8: Epoch-relative rounding → failed due to offset timestamps
// v9: Per-node offset compensation → too complex, integer overflow bugs
// v10: Simplified epoch-relative rounding with settling period after SYNC_RESET
//
// The key insight: Gateway reports 99.8% sync success at firmware level but
// web app shows 2.9%. This suggests frame assembly works but something else
// is broken. Simplifying to eliminate complexity and focus on diagnostics.
// ============================================================================

// Forward declaration of external sync manager
extern SyncManager syncManager;

namespace
{
  uint64_t getSampleOrdinal(uint32_t frameNumber, uint8_t sampleIndex)
  {
    return (static_cast<uint64_t>(frameNumber) * TDMA_SAMPLES_PER_FRAME) +
           static_cast<uint64_t>(sampleIndex);
  }
}

// ============================================================================
// Constructor
// ============================================================================

SyncFrameBuffer::SyncFrameBuffer()
    : expectedSensorCount(0), effectiveSensorCount(0), oldestSlotIndex(0),
      outputFrameNumber(0), completedFrameCount(0), trulyCompleteFrameCount(0),
      partialRecoveryFrameCount(0), droppedFrameCount(0),
      incompleteFrameCount(0), lastUpdateMs(0), latestObservedSampleOrdinal(0),
      slots(nullptr),
      slotsAllocated(false)
{
  // Initialize spinlock for thread safety
  portMUX_INITIALIZE(&_lock);

  memset(expectedSensorIds, 0, sizeof(expectedSensorIds));
  memset(sensorLastSeenMs, 0, sizeof(sensorLastSeenMs));
  // Note: slots is allocated later via allocateSlots()
}

SyncFrameBuffer::~SyncFrameBuffer()
{
  if (slots != nullptr)
  {
    heap_caps_free(slots);
    slots = nullptr;
  }
}

bool SyncFrameBuffer::allocateSlots()
{
  if (slotsAllocated && slots != nullptr)
  {
    return true; // Already allocated
  }

  size_t slotSize = sizeof(SyncTimestampSlot) * SYNC_TIMESTAMP_SLOTS;

  // Try PSRAM first (2MB available on QT Py ESP32-S3)
  if (psramFound())
  {
    slots = (SyncTimestampSlot *)heap_caps_malloc(slotSize, MALLOC_CAP_SPIRAM);
    if (slots != nullptr)
    {
      SAFE_LOG("[SyncFrame] Allocated %d slots (%u bytes) in PSRAM\n",
               SYNC_TIMESTAMP_SLOTS, slotSize);
    }
  }

  // Fallback to internal SRAM if PSRAM unavailable
  if (slots == nullptr)
  {
    slots =
        (SyncTimestampSlot *)heap_caps_malloc(slotSize, MALLOC_CAP_INTERNAL);
    if (slots != nullptr)
    {
      SAFE_LOG("[SyncFrame] WARNING: PSRAM unavailable, allocated %d slots (%u "
               "bytes) in internal SRAM\n",
               SYNC_TIMESTAMP_SLOTS, slotSize);
    }
  }

  if (slots == nullptr)
  {
    SAFE_PRINTLN("[SyncFrame] CRITICAL: Failed to allocate slot buffer!");
    return false;
  }

  memset(slots, 0, slotSize);
  slotsAllocated = true;
  return true;
}

// ============================================================================
// Initialization
// ============================================================================

void SyncFrameBuffer::init(const uint8_t *sensorIds, uint8_t count)
{
  if (!slotsAllocated)
  {
    allocateSlots();
  }
  setExpectedSensors(sensorIds, count);
  reset();
}

void SyncFrameBuffer::setExpectedSensors(const uint8_t *sensorIds,
                                         uint8_t count)
{
  if (count > SYNC_MAX_SENSORS)
  {
    count = SYNC_MAX_SENSORS;
  }

  // Protect state update with spinlock — addSample() on Core 1 reads
  // expectedSensorIds[] and expectedSensorCount via getSensorIndex()
  // without holding the lock, so we must ensure the update is atomic.
  portENTER_CRITICAL(&_lock);
  expectedSensorCount = count;
  memcpy(expectedSensorIds, sensorIds, count);
  effectiveSensorCount = count; // Initially assume all are active
  memset(sensorLastSeenMs, 0, sizeof(sensorLastSeenMs));
  portEXIT_CRITICAL(&_lock);

  // Log OUTSIDE the spinlock (SAFE_LOG takes serialWriteMutex)
  SAFE_LOG("[SyncFrame] Expected sensors updated: %d sensors [", count);
  for (uint8_t i = 0; i < count; i++)
  {
    SAFE_LOG("%d%s", sensorIds[i], (i < count - 1) ? ", " : "");
  }
  SAFE_PRINTLN("]");
}

// ============================================================================
// Sample Ingestion
// ============================================================================

bool SyncFrameBuffer::addSample(uint8_t sensorId, uint8_t rawNodeId,
                                uint8_t localSensorIndex,
                                uint32_t timestampUs,
                                uint32_t frameNumber, uint8_t sampleIndex,
                                const int16_t *a, const int16_t *g)
{
  // Guard: slots must be allocated before use
  if (slots == nullptr)
    return false;

  // =========================================================================
  // TIMESTAMP NORMALIZATION (for 0x25 output packet header only)
  // =========================================================================
  // Slot matching (v11) uses (frameNumber, sampleIndex) as the primary key —
  // not timestamp proximity. normalizedTs is still computed here so the
  // emitted 0x25 packet header contains a clean, epoch-relative timestamp
  // that the webapp can use for display and interpolation.
  // =========================================================================

  const uint32_t SAMPLE_PERIOD_US = 5000;
  uint32_t epoch = syncManager.getSyncEpoch();
  uint32_t normalizedTs;

  // Track epoch changes and add settling period
  static uint32_t lastKnownEpoch = 0;
  static uint32_t epochChangeTime = 0;

  if (epoch != lastKnownEpoch)
  {
    if (lastKnownEpoch != 0)
    {
      SAFE_LOG("[SYNC v11] Epoch changed %lu → %lu\n", lastKnownEpoch, epoch);
    }
    lastKnownEpoch = epoch;
    epochChangeTime = millis();
  }

  // SETTLING: Discard samples briefly after epoch change.
  // FIX: Reduced from 250ms to 50ms — 250ms dropped 50 frames (12.5 full
  // TDMA cycles) on every epoch change, far more than needed. 50ms (10
  // frames) is sufficient for all nodes to receive the new epoch beacon.
  const uint32_t EPOCH_SETTLE_MS = 50;
  if (epochChangeTime > 0 && (millis() - epochChangeTime) < EPOCH_SETTLE_MS)
  {
    return false; // Discard stale sample
  }
  epochChangeTime = 0;

  if (epoch > 0 && syncManager.isEpochInitialized())
  {
    // Simple epoch-relative rounding
    int64_t relativeUs = (int64_t)timestampUs - (int64_t)epoch;
    int64_t logicalSlot = (relativeUs + (int64_t)(SAMPLE_PERIOD_US / 2)) /
                          (int64_t)SAMPLE_PERIOD_US;
    normalizedTs = epoch + (uint32_t)(logicalSlot * SAMPLE_PERIOD_US);
  }
  else
  {
    // Fallback: simple quantization
    normalizedTs = ((timestampUs + SAMPLE_PERIOD_US / 2) / SAMPLE_PERIOD_US) *
                   SAMPLE_PERIOD_US;
  }

  // Snapshot expected sensor configuration under lock to avoid races with
  // setExpectedSensors() updates from another task/core.
  uint8_t localExpectedSensorCount = 0;
  uint8_t localExpectedSensorIds[SYNC_MAX_SENSORS] = {0};
  portENTER_CRITICAL(&_lock);
  localExpectedSensorCount = expectedSensorCount;
  memcpy(localExpectedSensorIds, expectedSensorIds, localExpectedSensorCount);
  portEXIT_CRITICAL(&_lock);

  // =========================================================================
  // CROSS-NODE DIAGNOSTIC (log frame differences for debugging)
  // =========================================================================
  // SIMP-5: Verbose cross-node diagnostic (enable with SYNC_DEBUG=1)
  // =========================================================================
#if SYNC_DEBUG
  // Auto-detect: use the FIRST sensor from each of the first two nodes
  // (based on expectedSensorIds list, where each node contributes a block)
  // Instead of hardcoded IDs, we use the first and "middle" expected sensor.
  // =========================================================================
  static uint8_t diagSensor1 = 0xFF;
  static uint8_t diagSensor2 = 0xFF;
  static bool diagSensorsInit = false;

  if (!diagSensorsInit && localExpectedSensorCount >= 2)
  {
    diagSensor1 = localExpectedSensorIds[0];
    // Find first sensor from a different node (gap in ID sequence)
    for (uint8_t di = 1; di < localExpectedSensorCount; di++)
    {
      if (localExpectedSensorIds[di] != localExpectedSensorIds[di - 1] + 1 ||
          di == localExpectedSensorCount / 2)
      {
        diagSensor2 = localExpectedSensorIds[di];
        break;
      }
    }
    if (diagSensor2 == 0xFF)
      diagSensor2 = localExpectedSensorIds[localExpectedSensorCount - 1];
    SAFE_LOG(
        "[DIAG] Auto-detected diagnostic sensors: %d (node1), %d (node2)\n",
        diagSensor1, diagSensor2);
    diagSensorsInit = true;
  }

  static uint32_t lastFrameNumNode1 = 0;
  static uint32_t lastFrameNumNode2 = 0;
  static uint32_t lastTsNode1 = 0;
  static uint32_t lastTsNode2 = 0;
  static uint32_t lastFrameDiagLog = 0;

  if (sensorId == diagSensor1)
  {
    lastFrameNumNode1 = frameNumber;
    lastTsNode1 = timestampUs;
  }
  else if (sensorId == diagSensor2)
  {
    lastFrameNumNode2 = frameNumber;
    lastTsNode2 = timestampUs;
  }

  // Log comparison every 2 seconds
  if (millis() - lastFrameDiagLog > 2000 && lastTsNode1 > 0 &&
      lastTsNode2 > 0)
  {
    lastFrameDiagLog = millis();
    int32_t frameDelta =
        (int32_t)lastFrameNumNode2 - (int32_t)lastFrameNumNode1;
    int32_t tsDeltaUs = (int32_t)lastTsNode2 - (int32_t)lastTsNode1;

    SAFE_LOG("[DIAG v10] Node1(s3): frame=%lu, ts=%lu | Node2(s43): frame=%lu, "
             "ts=%lu\n",
             lastFrameNumNode1, lastTsNode1, lastFrameNumNode2, lastTsNode2);
    SAFE_LOG(
        "           Frame delta: %ld | Timestamp delta: %ld us (%.1f ms)\n",
        frameDelta, tsDeltaUs, tsDeltaUs / 1000.0f);

    if (abs(tsDeltaUs) > 5000)
    {
      SAFE_LOG("           >>> TIMESTAMPS MISALIGNED BY >5ms - potential sync "
               "issue <<<\n");
    }
  }
#endif // SYNC_DEBUG
  // =========================================================================

  // =========================================================================
  // SIMP-5: Drift tracking diagnostic (enable with SYNC_DEBUG=1)
  // =========================================================================
#if SYNC_DEBUG
  // Uses auto-detected diagSensor1/diagSensor2 from above
  // =========================================================================
  static uint32_t lastNormTsN1 = 0;
  static uint32_t lastNormTsN2 = 0;
  static uint32_t lastRawTsN1 = 0;
  static uint32_t lastRawTsN2 = 0;
  static uint32_t lastDriftLog = 0;
  static uint32_t sameNormMatches = 0;
  static int32_t maxRawDriftForSameNorm = 0;

  // Track by primary sensor ID of each node
  if (sensorId == diagSensor1)
  {
    lastNormTsN1 = normalizedTs;
    lastRawTsN1 = timestampUs;
  }
  else if (sensorId == diagSensor2)
  {
    lastNormTsN2 = normalizedTs;
    lastRawTsN2 = timestampUs;
  }

  // Compare drift when both nodes have the SAME normalized timestamp
  // This is the true measure of cross-node synchronization
  if (lastNormTsN1 == lastNormTsN2 && lastNormTsN1 > 0)
  {
    int32_t rawDrift = (int32_t)lastRawTsN2 - (int32_t)lastRawTsN1;
    sameNormMatches++;
    if (abs(rawDrift) > abs(maxRawDriftForSameNorm))
    {
      maxRawDriftForSameNorm = rawDrift;
    }
  }

  // Log drift statistics every 5 seconds
  if (millis() - lastDriftLog > 5000)
  {
    lastDriftLog = millis();
    SAFE_LOG("[DRIFT] Same-normalized-ts matches: %lu, max_raw_drift=%ld us "
             "(%.2f ms)\n",
             sameNormMatches, maxRawDriftForSameNorm,
             maxRawDriftForSameNorm / 1000.0f);
    SAFE_LOG("        epoch=%lu, node1(s%d)_raw=%lu, node2(s%d)_raw=%lu\n",
             syncManager.getSyncEpoch(), diagSensor1, lastRawTsN1, diagSensor2,
             lastRawTsN2);

    // Warn if drift exceeds a reasonable amount (should be <1ms with good sync)
    if (abs(maxRawDriftForSameNorm) > 2500)
    {
      SAFE_LOG(
          "[DRIFT] INFO: Raw drift >2.5ms indicates beacon jitter (normal).\n");
    }

    // Reset for next period
    maxRawDriftForSameNorm = 0;
    sameNormMatches = 0;
  }
#endif // SYNC_DEBUG
  // =========================================================================

  // Validate sensor is expected
  int8_t sensorIndex = -1;
  for (uint8_t i = 0; i < localExpectedSensorCount; i++)
  {
    if (localExpectedSensorIds[i] == sensorId)
    {
      sensorIndex = i;
      break;
    }
  }
  if (sensorIndex < 0)
  {
    // Unknown sensor - log occasionally
    static uint32_t lastUnknownLog = 0;
    if (millis() - lastUnknownLog > 5000)
    {
      SAFE_LOG(
          "[SyncFrame] WARNING: Unknown sensor %d (not in expected list)\n",
          sensorId);
      lastUnknownLog = millis();
    }
    return false;
  }

  // ========================================================================
  // SIMP-5: RX rate diagnostic (enable with SYNC_DEBUG=1)
  // ========================================================================
  // Also detects inactive sensors and auto-adjusts expectedSensorCount
  // to prevent all frames being emitted via forceEmit (35ms timeout).
  // ========================================================================
  static uint32_t samplesReceivedBySensor[SYNC_MAX_SENSORS] = {0};
  static uint32_t lastSampleRateLog = 0;
  samplesReceivedBySensor[sensorIndex]++;

#if SYNC_DEBUG
  if (millis() - lastSampleRateLog > 5000)
  {
    lastSampleRateLog = millis();
    SAFE_LOG("[RX RATES] Samples received per sensor (5s window):\n");
    uint8_t activeSensorCount = 0;
    for (uint8_t i = 0; i < expectedSensorCount; i++)
    {
      float rate = samplesReceivedBySensor[i] / 5.0f;
      SAFE_LOG("  Sensor %d: %lu samples (%.1f Hz)%s\n", expectedSensorIds[i],
               samplesReceivedBySensor[i], rate,
               (samplesReceivedBySensor[i] == 0) ? " *** INACTIVE ***" : "");
      if (samplesReceivedBySensor[i] > 0)
      {
        activeSensorCount++;
      }
      samplesReceivedBySensor[i] = 0; // Reset for next window
    }

    // NOTE: effectiveSensorCount auto-adjustment is now handled in
    // expireStaleSlots() using per-sample sensorLastSeenMs[] timestamps.
    // This provides ~1s detection latency instead of the previous 5s.
  }
#else
  // Still reset counters periodically even when debug is off
  if (millis() - lastSampleRateLog > 5000)
  {
    lastSampleRateLog = millis();
    for (uint8_t i = 0; i < expectedSensorCount; i++)
      samplesReceivedBySensor[i] = 0;
  }
#endif // SYNC_DEBUG

  // Find or create a slot for this (frameNumber, sampleIndex) pair — the TDMA-authoritative key
  portENTER_CRITICAL(&_lock);
  SyncTimestampSlot *slot = findOrCreateSlot(normalizedTs, frameNumber, sampleIndex);
  const uint64_t sampleOrdinal = getSampleOrdinal(frameNumber, sampleIndex);
  if (sampleOrdinal > latestObservedSampleOrdinal)
  {
    latestObservedSampleOrdinal = sampleOrdinal;
  }
  if (!slot)
  {
    // Buffer full, oldest slot not yet complete
    droppedFrameCount++;
    portEXIT_CRITICAL(&_lock);
    return false;
  }

  // Check if this sensor already reported for this timestamp
  if (slot->sensors[sensorIndex].present)
  {
    portEXIT_CRITICAL(&_lock);
    // Duplicate - this shouldn't happen with proper timestamps
    static uint32_t lastDupeLog = 0;
    if (millis() - lastDupeLog > 5000)
    {
      SAFE_LOG("[SyncFrame] WARNING: Duplicate sample for sensor %d at ts=%lu "
               "(norm=%lu)\n",
               sensorId, timestampUs, normalizedTs);
      lastDupeLog = millis();
    }
    return false;
  }

  // Store the sample
  SyncSensorSample &sample = slot->sensors[sensorIndex];
  sample.present = true;
  sample.sensorId = sensorId;
  sample.rawNodeId = rawNodeId;               // S1-FIX: Physical identity
  sample.localSensorIndex = localSensorIndex; // S1-FIX: Local sensor index
  memcpy(sample.a, a, sizeof(sample.a));
  memcpy(sample.g, g, sizeof(sample.g));
  sensorLastSeenMs[sensorIndex] = millis();

  slot->sensorsPresent++;
  portEXIT_CRITICAL(&_lock);

  return true;
}

// ============================================================================
// Frame Retrieval
// ============================================================================

bool SyncFrameBuffer::hasCompleteFrame() const
{
  if (slots == nullptr)
    return false;
  portENTER_CRITICAL(&_lock);
  for (uint8_t i = 0; i < SYNC_TIMESTAMP_SLOTS; i++)
  {
    if (slots[i].active && isSlotComplete(slots[i]))
    {
      portEXIT_CRITICAL(&_lock);
      return true;
    }
  }
  portEXIT_CRITICAL(&_lock);
  return false;
}

size_t SyncFrameBuffer::getCompleteFrame(uint8_t *outputBuffer, size_t maxLen)
{
  // Find the oldest complete slot (maintain ordering)
  SyncTimestampSlot *completeSlot = nullptr;
  uint8_t completeSlotIndex = 0;
  uint32_t oldestTimestamp = UINT32_MAX;

  portENTER_CRITICAL(&_lock);
  for (uint8_t i = 0; i < SYNC_TIMESTAMP_SLOTS; i++)
  {
    if (slots[i].active && isSlotComplete(slots[i]))
    {
      if (slots[i].timestampUs < oldestTimestamp)
      {
        oldestTimestamp = slots[i].timestampUs;
        completeSlot = &slots[i];
        completeSlotIndex = i;
      }
    }
  }

  if (!completeSlot)
  {
    portEXIT_CRITICAL(&_lock);
    return 0;
  }

  // Copy slot data under lock, then release so addSample() isn't blocked
  // during the relatively expensive packet building
  SyncTimestampSlot localSlot;
  memcpy(&localSlot, completeSlot, sizeof(SyncTimestampSlot));

  // Mark slot as consumed while still under lock
  completeSlot->active = false;
  completeSlot->sensorsPresent = 0;
  for (uint8_t i = 0; i < SYNC_MAX_SENSORS; i++)
  {
    completeSlot->sensors[i].present = false;
  }
  portEXIT_CRITICAL(&_lock);

  size_t packetSize = 0;

  // Build absolute 0x25 frame
  packetSize = buildAbsoluteFrame(localSlot, outputBuffer, maxLen);

  if (packetSize > 0)
  {
    // Log sync quality every 5 seconds
    static uint32_t lastSyncDiagLog = 0;
    if (millis() - lastSyncDiagLog > 5000)
    {
      lastSyncDiagLog = millis();

      uint32_t totalEmitted =
          trulyCompleteFrameCount + partialRecoveryFrameCount;
      float trueCompleteRate =
          (totalEmitted > 0)
              ? (float)trulyCompleteFrameCount / totalEmitted * 100.0f
              : 0.0f;

      SAFE_LOG("[SYNC QUALITY] TrulyComplete: %lu, Partial: %lu, Incomplete: "
               "%lu, Dropped: %lu\n",
               trulyCompleteFrameCount, partialRecoveryFrameCount,
               incompleteFrameCount, droppedFrameCount);
      SAFE_LOG("               TRUE SYNC RATE: %.1f%% (frames with ALL %d "
               "sensors, effective=%d)\n",
               trueCompleteRate, expectedSensorCount, effectiveSensorCount);
      SAFE_LOG("               Total frames emitted: %lu\n",
               completedFrameCount);
    }

    // Slot already cleared under lock above — no need to clear again

    completedFrameCount++;
    outputFrameNumber++;

    // Track truly complete (all ACTIVE sensors) vs partial recovery (forceEmit)
    // This keeps trueSyncRate aligned with effectiveSensorCount-based slot
    // completeness and avoids falsely penalizing expected-but-inactive sensors.
    const uint8_t requiredSensors =
        (effectiveSensorCount > 0) ? effectiveSensorCount : expectedSensorCount;
    if (localSlot.sensorsPresent >= requiredSensors)
    {
      trulyCompleteFrameCount++;
    }
    else
    {
      partialRecoveryFrameCount++;
    }

    // ====================================================================
    // OUTPUT FRAME RATE DIAGNOSTIC (388Hz investigation)
    // ====================================================================
    // Precisely measure actual output frame rate to verify the BUG 1 FIX
    // resolved the ~388Hz issue. Expected: ~200Hz with 200Hz sampling.
    // ====================================================================
    static uint32_t rateWindowStart = 0;
    static uint32_t rateWindowFrames = 0;
    uint32_t rateNow = millis();

    if (rateWindowStart == 0)
    {
      rateWindowStart = rateNow;
    }
    rateWindowFrames++;

    uint32_t rateElapsed = rateNow - rateWindowStart;
    if (rateElapsed >= 5000)
    {
      float actualHz = (float)rateWindowFrames / (rateElapsed / 1000.0f);
      SAFE_LOG("[FRAME RATE] Output: %.1f Hz (%lu frames in %lu ms) | "
               "Expected: 200 Hz | Ratio: %.2fx\n",
               actualHz, rateWindowFrames, rateElapsed, actualHz / 200.0f);

      if (actualHz > 220.0f)
      {
        SAFE_LOG("[FRAME RATE] *** WARNING: Output rate %.1f Hz exceeds "
                 "expected 200 Hz by %.1f%% ***\n",
                 actualHz, ((actualHz - 200.0f) / 200.0f) * 100.0f);
      }

      rateWindowStart = rateNow;
      rateWindowFrames = 0;
    }
  }

  return packetSize;
}

// ============================================================================
// Maintenance
// ============================================================================

void SyncFrameBuffer::update()
{
  // No rate limiter — called from ProtocolTask at ~1ms intervals.
  // expireStaleSlots() uses SYNC_SLOT_TIMEOUT_MS (25ms) to determine staleness,
  // so calling more frequently just detects expired slots sooner.
  expireStaleSlots();
}

void SyncFrameBuffer::expireStaleSlots()
{
  uint32_t now = millis();

  // ========================================================================
  // DIAGNOSTIC: Track which sensors are consistently missing
  // ========================================================================
  static uint32_t missCountBySensor[SYNC_MAX_SENSORS] = {0};
  static uint32_t totalIncompleteFramesTracked = 0;
  static uint32_t lastMissSummaryLog = 0;

  // ========================================================================
  // DEFERRED LOGGING: Collect log data under lock, log AFTER releasing.
  // ========================================================================
  // CRITICAL FIX: SAFE_LOG internally calls xSemaphoreTake(serialWriteMutex)
  // which MUST NOT be called inside portENTER_CRITICAL (spinlock disables
  // interrupts, so if the mutex is held, the scheduler can't run to release
  // it → deadlock → watchdog reset).
  // ========================================================================
  struct PartialFrameLog
  {
    uint32_t timestampUs;
    uint32_t frameNumber;
    uint8_t sampleIndex;
    uint8_t sensorsPresent;
    uint8_t expectedCount;
    uint32_t ageMs;
    uint32_t lagSamples;
  };
  static uint32_t lastPartialLog = 0;
  PartialFrameLog partialLog = {0, 0, 0, 0, 0, 0, 0};
  bool shouldLogPartial = false;

  // Miss summary data (snapshot under lock, log outside)
  bool shouldLogMissSummary = false;
  uint32_t missSummaryTotal = 0;
  uint32_t missSummarySnapshot[SYNC_MAX_SENSORS] = {0};
  uint8_t missSummarySensorIds[SYNC_MAX_SENSORS] = {0};
  uint8_t missSummarySensorCount = 0;

  portENTER_CRITICAL(&_lock);
  const uint64_t latestSampleOrdinal = latestObservedSampleOrdinal;
  for (uint8_t i = 0; i < SYNC_TIMESTAMP_SLOTS; i++)
  {
    if (slots[i].active)
    {
      uint32_t age = now - slots[i].receivedAtMs;
      const uint64_t slotOrdinal =
          getSampleOrdinal(slots[i].frameNumber, slots[i].sampleIndex);
      const uint32_t lagSamples =
          (latestSampleOrdinal > slotOrdinal)
              ? static_cast<uint32_t>(latestSampleOrdinal - slotOrdinal)
              : 0;
      const bool lateByStreamAdvance =
          lagSamples >= SYNC_SLOT_ADVANCE_TIMEOUT_SAMPLES;
      const bool lateByHardTimeout = age > SYNC_SLOT_TIMEOUT_MS;

      if (lateByStreamAdvance || lateByHardTimeout)
      {
        // Skip if already forced (avoid double processing)
        if (slots[i].forceEmit)
          continue;

        // Slot timed out without completing
        if (!isSlotComplete(slots[i]))
        {
          incompleteFrameCount++;
          totalIncompleteFramesTracked++;

          // Track which sensors were missing
          for (uint8_t j = 0; j < expectedSensorCount; j++)
          {
            if (!slots[i].sensors[j].present)
            {
              missCountBySensor[j]++;
            }
          }

          // PARTIAL FRAME RECOVERY (v7 Upgrade)
          // If we have ANY data, emit it instead of dropping it.
          if (slots[i].sensorsPresent > 0)
          {
            slots[i].forceEmit = true;

            // Collect log data (will log outside lock)
            if (now - lastPartialLog > 2000)
            {
              partialLog.timestampUs = slots[i].timestampUs;
              partialLog.frameNumber = slots[i].frameNumber;
              partialLog.sampleIndex = slots[i].sampleIndex;
              partialLog.sensorsPresent = slots[i].sensorsPresent;
              partialLog.expectedCount = expectedSensorCount;
              partialLog.ageMs = age;
              partialLog.lagSamples = lagSamples;
              shouldLogPartial = true;
              lastPartialLog = now;
            }

            // CRITICAL: Prevent slot clearing so it can be picked up by
            // getCompleteFrame
            continue;
          }

          // Clear empty slot (no data to recover)
          slots[i].active = false;
          slots[i].sensorsPresent = 0;
          for (uint8_t j = 0; j < SYNC_MAX_SENSORS; j++)
          {
            slots[i].sensors[j].present = false;
          }
        }

        // Periodic miss summary: snapshot data under lock
        if (now - lastMissSummaryLog > 10000 &&
            totalIncompleteFramesTracked > 0)
        {
          lastMissSummaryLog = now;
          shouldLogMissSummary = true;
          missSummaryTotal = totalIncompleteFramesTracked;
          missSummarySensorCount = expectedSensorCount;
          for (uint8_t j = 0; j < expectedSensorCount; j++)
          {
            missSummarySnapshot[j] = missCountBySensor[j];
            missSummarySensorIds[j] = expectedSensorIds[j];
          }
          // Reset counters for next period
          memset(missCountBySensor, 0, sizeof(missCountBySensor));
          totalIncompleteFramesTracked = 0;
        }
      }
    }
  }
  portEXIT_CRITICAL(&_lock);

  // ========================================================================
  // DEFERRED LOGGING: All SAFE_LOG calls happen OUTSIDE the spinlock
  // ========================================================================
  if (shouldLogPartial)
  {
    SAFE_LOG("[SyncFrame] TIMEOUT: Recovering partial frame fn=%lu sample=%u "
             "ts=%lu (%d/%d sensors, age=%lu ms, lag=%lu samples)\n",
             (unsigned long)partialLog.frameNumber,
             partialLog.sampleIndex,
             (unsigned long)partialLog.timestampUs,
             partialLog.sensorsPresent,
             partialLog.expectedCount,
             (unsigned long)partialLog.ageMs,
             (unsigned long)partialLog.lagSamples);
  }

  if (shouldLogMissSummary)
  {
    SAFE_LOG("[MISS ANALYSIS] Over %lu incomplete frames:\n", missSummaryTotal);
    for (uint8_t j = 0; j < missSummarySensorCount; j++)
    {
      if (missSummarySnapshot[j] > 0)
      {
        float missRate =
            (float)missSummarySnapshot[j] / missSummaryTotal * 100.0f;
        SAFE_LOG("  Sensor %d: missed %lu times (%.1f%%)\n",
                 missSummarySensorIds[j], missSummarySnapshot[j], missRate);
      }
    }
  }

  // ========================================================================
  // ACTIVE SENSOR RECOMPUTATION (moved from addSample 5s window)
  // ========================================================================
  // Uses per-sample sensorLastSeenMs[] (updated in addSample) to detect
  // offline sensors. Checks every ~1s — much faster than the old 5s window.
  // effectiveSensorCount is volatile for cross-core visibility.
  // ========================================================================
  static uint32_t lastActivityCheck = 0;
  if (now - lastActivityCheck > 1000)
  {
    lastActivityCheck = now;
    uint8_t activeSensors = 0;
    for (uint8_t i = 0; i < expectedSensorCount; i++)
    {
      if (sensorLastSeenMs[i] > 0 &&
          (now - sensorLastSeenMs[i]) <= SENSOR_INACTIVE_THRESHOLD_MS)
      {
        activeSensors++;
      }
    }
    if (activeSensors > 0 && activeSensors != effectiveSensorCount)
    {
      uint8_t prev = effectiveSensorCount;
      effectiveSensorCount = activeSensors;
      SAFE_LOG("[SyncFrame] effectiveSensorCount: %d -> %d "
               "(registered: %d, inactive threshold: %lu ms)\n",
               prev, activeSensors, expectedSensorCount,
               SENSOR_INACTIVE_THRESHOLD_MS);
    }
  }
}

void SyncFrameBuffer::reset()
{
  portENTER_CRITICAL(&_lock);
  if (slots != nullptr && slotsAllocated)
  {
    memset(slots, 0, sizeof(SyncTimestampSlot) * SYNC_TIMESTAMP_SLOTS);
  }
  oldestSlotIndex = 0;
  outputFrameNumber = 0;
  completedFrameCount = 0;
  trulyCompleteFrameCount = 0;
  partialRecoveryFrameCount = 0;
  droppedFrameCount = 0;
  incompleteFrameCount = 0;
  lastUpdateMs = millis();
  latestObservedSampleOrdinal = 0;
  effectiveSensorCount =
      expectedSensorCount; // Reset to full count on buffer reset
  memset(sensorLastSeenMs, 0, sizeof(sensorLastSeenMs));

  portEXIT_CRITICAL(&_lock);

  SAFE_PRINTLN("[SyncFrame] Buffer reset");
}

void SyncFrameBuffer::printStatus() const
{
  SAFE_LOG("[SyncFrame] Status: expected=%d sensors, completed=%lu, "
           "dropped=%lu, incomplete=%lu\n",
           expectedSensorCount, completedFrameCount, droppedFrameCount,
           incompleteFrameCount);

  uint8_t activeSlots = 0;
  portENTER_CRITICAL(&_lock);
  for (uint8_t i = 0; i < SYNC_TIMESTAMP_SLOTS; i++)
  {
    if (slots[i].active)
    {
      activeSlots++;
    }
  }
  portEXIT_CRITICAL(&_lock);
  SAFE_LOG("[SyncFrame] Active slots: %d/%d\n", activeSlots,
           SYNC_TIMESTAMP_SLOTS);
}

// ============================================================================
// Private Helpers
// ============================================================================

SyncTimestampSlot *SyncFrameBuffer::findOrCreateSlot(uint32_t normalizedTs,
                                                     uint32_t frameNumber,
                                                     uint8_t sampleIndex)
{
  // =========================================================================
  // TDMA FRAME+SAMPLE SLOT MATCHING (v11 - Frame-Authoritative Key)
  // =========================================================================
  // Primary key: (frameNumber, sampleIndex) — derived from the TDMA beacon,
  // shared identically by all nodes in the same logical super-frame and
  // sub-sample slot. This is beacon-authoritative and immune to timestamp
  // rounding boundary aliasing.
  //
  // v10 used normalizedTs as the sole key. This worked when all nodes received
  // the same beacon, but if any node freewheeled or had even a few hundred µs
  // of beacon jitter the rounding could land on opposite sides of a 5ms
  // boundary → samples from the same logical moment went into different slots
  // → never completed → force-emitted → low completeness (32% observed).
  //
  // v11 fix: match by (frameNumber, sampleIndex). normalizedTs is still stored
  // per slot — averaged across the first arriving sensor — so the output 0x25
  // packet header contains a sensible time value.
  // =========================================================================

  // First: look for an existing active slot with the same (frameNumber, sampleIndex)
  for (uint8_t i = 0; i < SYNC_TIMESTAMP_SLOTS; i++)
  {
    if (slots[i].active &&
        slots[i].frameNumber == frameNumber &&
        slots[i].sampleIndex == sampleIndex)
    {
      return &slots[i];
    }
  }

  // No matching slot — find an empty one
  for (uint8_t i = 0; i < SYNC_TIMESTAMP_SLOTS; i++)
  {
    if (!slots[i].active)
    {
      slots[i].active = true;
      slots[i].timestampUs = normalizedTs;
      slots[i].frameNumber = frameNumber;
      slots[i].sampleIndex = sampleIndex;
      slots[i].receivedAtMs = millis();
      slots[i].sensorsPresent = 0;
      return &slots[i];
    }
  }

  // All slots full - find oldest incomplete slot to recycle
  uint32_t oldestTime = UINT32_MAX;
  uint8_t oldestIdx = 0;
  bool foundIncompleteSlot = false;

  for (uint8_t i = 0; i < SYNC_TIMESTAMP_SLOTS; i++)
  {
    if (slots[i].receivedAtMs < oldestTime && !isSlotComplete(slots[i]))
    {
      oldestTime = slots[i].receivedAtMs;
      oldestIdx = i;
      foundIncompleteSlot = true;
    }
  }

  // Check if we can recycle this slot
  if (foundIncompleteSlot && slots[oldestIdx].active)
  {
    // Log that we're dropping an incomplete frame
    incompleteFrameCount++;

    // Recycle the slot
    slots[oldestIdx].active = true;
    slots[oldestIdx].timestampUs = normalizedTs;
    slots[oldestIdx].frameNumber = frameNumber;
    slots[oldestIdx].sampleIndex = sampleIndex;
    slots[oldestIdx].receivedAtMs = millis();
    slots[oldestIdx].sensorsPresent = 0;
    for (uint8_t j = 0; j < SYNC_MAX_SENSORS; j++)
    {
      slots[oldestIdx].sensors[j].present = false;
    }
    return &slots[oldestIdx];
  }

  return nullptr;
}

int8_t SyncFrameBuffer::getSensorIndex(uint8_t sensorId) const
{
  for (uint8_t i = 0; i < expectedSensorCount; i++)
  {
    if (expectedSensorIds[i] == sensorId)
    {
      return i;
    }
  }
  return -1;
}

bool SyncFrameBuffer::isSlotComplete(const SyncTimestampSlot &slot) const
{
  if (!slot.active)
    return false;
  // Use effectiveSensorCount (active sensors) instead of expectedSensorCount
  // (registered sensors) to handle offline sensors gracefully.
  // This prevents all frames from routing through forceEmit (35ms timeout)
  // when a registered sensor goes offline without deregistering.
  return (slot.sensorsPresent >= effectiveSensorCount) || slot.forceEmit;
}

// ============================================================================
// CRC-8 (polynomial 0x07) for frame integrity detection
// ============================================================================
static uint8_t computeCRC8(const uint8_t *data, size_t len)
{
  uint8_t crc = 0x00;
  for (size_t i = 0; i < len; i++)
  {
    crc ^= data[i];
    for (uint8_t j = 0; j < 8; j++)
    {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) : (crc << 1);
    }
  }
  return crc;
}

// ============================================================================
size_t SyncFrameBuffer::buildAbsoluteFrame(const SyncTimestampSlot &slot,
                                           uint8_t *outputBuffer,
                                           size_t maxLen)
{
  // THREAD SAFETY: Snapshot expectedSensorCount and expectedSensorIds into
  // locals. This function runs OUTSIDE the spinlock (lock released after
  // slot copy in getCompleteFrame), but setExpectedSensors() on another
  // task writes these members under the lock. Without a local snapshot,
  // the compiler may re-read the member on each access and see a torn
  // value if setExpectedSensors() fires mid-function.
  const uint32_t nowMs = millis();
  const uint8_t localSensorCount = expectedSensorCount;
  uint8_t localSensorIds[SYNC_MAX_SENSORS];
  uint32_t localSensorLastSeenMs[SYNC_MAX_SENSORS];
  memcpy(localSensorIds, expectedSensorIds, localSensorCount);
  memcpy(localSensorLastSeenMs, sensorLastSeenMs,
         sizeof(localSensorLastSeenMs));

  uint8_t includedIndices[SYNC_MAX_SENSORS] = {0};
  uint8_t includedCount = 0;

  if (slot.forceEmit)
  {
    // PARTIAL-FRAME TRUTHFULNESS: For timeout-recovered slots, advertise
    // ONLY sensors actually present to avoid overstating availability.
    for (uint8_t i = 0; i < localSensorCount && includedCount < SYNC_MAX_SENSORS;
         i++)
    {
      if (slot.sensors[i].present)
      {
        includedIndices[includedCount++] = i;
      }
    }
  }
  else
  {
    // SIMP-7: Unified active-sensor filtering for normal frames.
    // Include sensors seen within the inactive threshold. If none pass
    // (startup/transient), fall back to all registered sensors.
    for (uint8_t i = 0;
         i < localSensorCount && includedCount < SYNC_MAX_SENSORS; i++)
    {
      const bool active =
          localSensorLastSeenMs[i] > 0 &&
          (nowMs - localSensorLastSeenMs[i]) <= SENSOR_INACTIVE_THRESHOLD_MS;
      if (active)
      {
        includedIndices[includedCount++] = i;
      }
    }

    // Fallback: if active filtering yielded nothing (startup/transient), include
    // all registered sensors to preserve continuity.
    if (includedCount == 0)
    {
      for (uint8_t i = 0; i < localSensorCount; i++)
      {
        includedIndices[includedCount++] = i;
      }
    }
  }

  // Safety fallback for pathological states.
  if (includedCount == 0)
  {
    return 0;
  }

  // Calculate required size (header + sensors + CRC-8 trailer)
  size_t frameDataSize =
      SYNC_FRAME_HEADER_SIZE + (includedCount * SYNC_FRAME_SENSOR_SIZE);
  size_t requiredSize = frameDataSize + 1; // +1 for CRC-8 byte

  if (maxLen < requiredSize)
  {
    SAFE_LOG("[SyncFrame] ERROR: Output buffer too small (%d < %d)\n", maxLen,
             requiredSize);
    return 0;
  }

  // Build the sync frame packet header
  SyncFramePacket *header = (SyncFramePacket *)outputBuffer;
  header->type = SYNC_FRAME_PACKET_TYPE; // 0x25
  header->frameNumber = outputFrameNumber;
  header->timestampUs = slot.timestampUs;
  header->sensorCount = includedCount;

  // BELT-AND-SUSPENDERS: Write sensorCount directly at byte offset 9.
  // If the compiler mis-handles __attribute__((packed)) struct member
  // access (observed on some toolchains), the struct write above may land
  // at the wrong offset. This raw byte write guarantees byte[9] is correct
  // regardless of compiler behavior.
  outputBuffer[9] = includedCount;

  // Add sensor data in expected order
  SyncFrameSensorData *sensorData =
      (SyncFrameSensorData *)(outputBuffer + SYNC_FRAME_HEADER_SIZE);

  for (uint8_t outIdx = 0; outIdx < includedCount; outIdx++)
  {
    const uint8_t i = includedIndices[outIdx];
    const SyncSensorSample &sample = slot.sensors[i];

    // FIX: Use the EXPECTED sensor ID for non-present sensors instead of
    // the memset default (0). This prevents phantom sensorId=0 in 0x25
    // frames which corrupts diagnostics and can cause ghost sensors in
    // the web app if serial corruption flips the valid flag bit.
    sensorData[outIdx].sensorId =
        sample.present ? sample.sensorId : localSensorIds[i];
    memcpy(sensorData[outIdx].a, sample.a, sizeof(sensorData[outIdx].a));
    memcpy(sensorData[outIdx].g, sample.g, sizeof(sensorData[outIdx].g));
    sensorData[outIdx].flags = sample.present ? SYNC_SENSOR_FLAG_VALID : 0;
    // S1-FIX: Embed physical identity in previously-reserved bytes
    // reserved[0] = rawNodeId (MAC-derived physical node ID)
    // reserved[1] = localSensorIndex (sensor's index within its node, 0-based)
    // This allows the webapp to build stable device keys independent of
    // compact ID assignment order.
    sensorData[outIdx].reserved[0] = sample.present ? sample.rawNodeId : 0;
    sensorData[outIdx].reserved[1] = sample.present ? sample.localSensorIndex : 0;
  }

  // Append CRC-8 trailing byte for corruption detection.
  // The CRC covers the entire frame (header + sensor data).
  // Web app detects CRC presence via (len - headerSize) % sensorSize == 1.
  outputBuffer[frameDataSize] = computeCRC8(outputBuffer, frameDataSize);

  return requiredSize;
}
