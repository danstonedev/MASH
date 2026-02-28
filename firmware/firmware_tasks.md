Here is the analysis of the 143Hz issue.

### The Findings
1.  **I2C Speed is OK**: `Wire.setClock(400000)` is present. 6 sensors take ~2.4ms to read, well within the 5ms budget.
2.  **Sampling is OK**: The node attempts to sample at 200Hz (`POWER_FULL` state).
3.  **Buffer is OK**: Capacity is 60 samples.
4.  **The Root Cause**: **Strict Beacon Dependency**.
    *   The `isInTransmitWindow()` function checks `micros() - lastBeaconTime`.
    *   If a beacon packet (sent by Gateway every 20ms) is lost due to interference, `timeSinceBeacon` exceeds the slot end time.
    *   The Node **skips transmission** for that entire frame.
    *   It waits for the next successful beacon to resume sending.
    *   A 143Hz rate (vs 200Hz) implies ~29% of beacons are being missed/dropped.

### The Solution: "Freewheeling"
We must modify `SyncManager` to assume the frame cycle continues even if a beacon is missed. We can use the local clock to predict start times for subsequent frames up to a safety limit (e.g., 500ms).

I will now patch `SyncManager.cpp` to verify this hypothesis and fix the issue.
