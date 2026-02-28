# Data Pipeline Re-Audit Report
**Date:** February 2, 2026
**Auditor:** GitHub Copilot (System Architect)
**Status:** ⚠️ **CRITICAL REGRESSION DETECTED**

## 1. Executive Summary
The "World Class" stability upgrade has introduced a **critical regression** that will cause sensors to permanently stop updating if they power-cycle or reset during a session. While the Jitter Buffer correctly fixes "Time Travel" artifacts, its logic is too aggressive and lacks "Reset Detection".

| Component | Status | Verdict |
| :--- | :--- | :--- |
| **Jitter Buffer Logic** | **FAIL** | "Zombie Lockout" bug on sensor reset. |
| **Integration** | **PASS** | Correctly hooked into `BLEConnection`. Resets on full disconnect. |
| **Testing** | **INCOMPLETE** | Missing test cases for Sensor Reset/Rollover. |
| **Legacy Support** | **PASS** | Correctly bypasses buffer for non-frame-numbered packets. |

---

## 2. Technical Analysis

### A. The "Zombie Lockout" Bug (Critical)
**File:** `src/lib/connection/JitterBuffer.ts`
**Line:** 37-41
```typescript
const lastFrame = this.lastEmittedFrame.get(p.sensorId || 0) ?? -1;
if (p.frameNumber <= lastFrame) {
    // Already emitted this frame (or newer). Drop it.
    continue;
}
```
**Scenario:**
1.  Gateway is connected. Sensor A is sending Frame 5000.
2.  `lastEmittedFrame` for Sensor A is 5000.
3.  Sensor A reboots (brownout/battery glitch) but Gateway stays connected.
4.  Sensor A connects to Gateway and starts sending from Frame 0.
5.  **Failure:** JitterBuffer sees `0 <= 5000`. Drops packet.
6.  **Result:** Sensor A appears "dead" in the UI until `frameNumber` exceeds 5000 (25 seconds) or the user disconnects the entire system.

**Correction Required:**
Implement "Reset Detection". If the difference `lastFrame - frameNumber` is large (e.g., > 200 frames / 1 second), assume a reset happened and accept the new frame.

### B. Frame Number Rollover (Minor)
**File:** `src/lib/connection/JitterBuffer.ts`
**Issue:** `uint32` frame numbers wrap every ~248 days at 200Hz.
**Impact:** Negligible for current usage, but technically the same logic (`new < old`) will cause a lockout on legitimate rollover.
**Mitigation:** Standard "modulo arithmetic" comparison should be used instead of direct comparison, or simply rely on the Reset Detection logic above to handle the wrap as a "reset".

### C. Jitter Buffer Integration (Good)
**File:** `src/lib/connection/BLEConnection.ts`
**Observation:**
- The integration separates legacy packets vs. TDMA packets correctly.
- `jitterBuffer.reset()` is called on `disconnect` and `handleDisconnect`.
- **Note:** This only resets if the *Gateway* disconnects. It does not help the individual sensor reset case described above.

---

## 3. Test Suite Gaps (`virtual_stress.test.ts`)
The current test suite verifies:
✅ Re-ordering of scrambled packets.
✅ Smoothing of bursts.
✅ Pipeline integrity (CRC, Parsing).

**MISSING:**
❌ **Sensor Reset Recovery:** A test that injects Frame 5000, then Frame 0, and asserts Frame 0 is output.
❌ **Rollover:** A test for `uint32` boundary conditions (though low priority).

---

## 4. Residual Risks (Original Audit)
The following risks from the previous audit remain **Unresolved**:

1.  **"Blind Drop" at Gateway:**
    - The firmware still silently drops packets if the 64-item queue fills.
    - `BLEConnection.ts` monitors gaps but cannot prevent them.
    - **Recommendation:** Keep the previously suggested "Adaptive Rate Control", but fix the critical JitterBuffer bug first.

2.  **Added Latency:**
    - The Jitter Buffer adds a fixed **40ms** delay.
    - This is an acceptable trade-off for smoothness, but should be noted in the documentation.

## 5. Next Steps
1.  **Stop Ship:** Do not deploy `JitterBuffer.ts` in its current state.
2.  **Hotfix:** Modify `JitterBuffer.ts` to detect significant negative jumps (> 1 second) and treat them as resets.
3.  **Verify:** Add a regression test case to `virtual_stress.test.ts` for the reset scenario.
