# Diagnosis and Fix Report (2026-02-05)

## Critical Issue Identified
The Gateway logs showed **TDMA Slot Widths of ~9ms** (`9272 us`) per node. given the project pivot to 4 sensors, the target slot width is **2.5ms** (`2500 us`).

This discrepancy caused:
1. **Late Transmission:** Node 2 was starting its transmission at ~10.4ms into the frame.
2. **Retries Crossing Frame Boundary:** Due to RF interference or missed ACKs, Node 2's retries extended to the end of the 20ms frame.
3. **Collision with Beacon:** If Node 2 transmits past the 20ms mark, it collides with the Gateway's next Beacon (sent at T=0 of next frame), causing massive packet loss and `AirTime` reporting as ~100% (timeout).

## The Fix
The `calculateSlotWidth` function in the Gateway firmware appeared to be using outdated logic or constants (likely from a cached build or shadowed definition), resulting in the 9ms slots.

We have applied a **Direct Override** in `SyncManager.cpp` to enforce the optimized formula:
```cpp
// Explicit calculation:
// Width = 1000us (Overhead) + (Sensors * 200us)
// Clamped to Minimum 2500us
```

### Expected Behavior After Re-Flash
- **Slot Width:** Reduced from ~9200us down to **2500us**.
- **Timing:** 
  - Node 1 (1 sensor) starts at ~1000us. Ends <3500us.
  - Node 2 (4 sensors) starts at ~3600us. Ends <6100us.
  - **Free Time:** ~13ms of free airtime at the end of every frame.
- **Reliability:** This massive buffer allows ample time for retries without colliding with the next Beacon.

## Next Steps
1. **Compile and Upload** the Gateway firmware (`MASH_Gateway`).
2. Run the system and verify the logs show `width=2500` (or close to it) in the `[TDMA] Slot calculation` lines.
