# Runtime Feature Review: Enable vs Remove (Post-Calibration)

Date: 2026-02-17  
Scope: Features related to live adjustment after initial calibration  
Goal: Decide whether currently disabled/not-fully-active runtime correction features should be enabled, retained disabled, or removed.

---

## Executive Decision Summary

| Feature | Current State | Recommendation | Why |
|---|---|---|---|
| `AutoCalEngine` runtime corrections (`ZUPT`, `drift`, `heading`, `constraint`) | Present but globally disabled in runtime loop | **Keep disabled now**; **do not enable directly** | Known distortion risk in code comment, proposal-only architecture, no validation harness/tests in place |
| `DriftMonitor` yaw correction in FK path | FK reads correction, but monitor update not on main runtime path | **Refactor before enable** (either wire correctly or remove correction read) | Currently gives false sense of active correction; correction source is not consistently driven |
| `CalibrationLogger` correction logging (for runtime corrections) | Implemented, primarily used by `AutoCalEngine` | **Keep, but demote to optional instrumentation** | Useful once corrections are truly applied; currently low value while engine is off |
| Device registry low-pass filter toggle | Implemented, default OFF, hooked into ingest path | **Keep OFF by default; retain feature** | Lower risk and already integrated; useful as controlled noise mitigation switch |
| "Client fusion" legacy switches | Explicitly removed/disabled in registry comments | **Keep removed** | Avoids architecture confusion; VQF path is current source of truth |

---

## Findings (Code-Level)

### 1) AutoCalEngine is intentionally disabled in runtime
- Main visualization loop hard-disables it:
  - `const ENABLE_AUTO_CAL_ENGINE = false; // Disabled: causing model distortion`
- Location: `mash-app/src/components/visualization/SkeletonModel.tsx`
- Engine still computes proposals and logs corrections, but does not robustly apply corrections to pose state itself.
- In `AutoCalEngine`, comment explicitly states actual application should happen in `SkeletonModel`.

**Assessment:** Not production-ready to enable for research sessions without a controlled apply path and acceptance tests.

---

### 2) Drift correction path is partially wired
- FK solver reads yaw correction from `DriftMonitor` (`getYawCorrection()`), then applies yaw compensation.
- Location: `mash-app/src/biomech/ForwardKinematics.ts`
- However, `DriftMonitor.processFrame()` is not called in the main live update loop for FK/skeleton runtime.
- `processFrame()` is used in drift characterization tooling, not normal live visualization path.

**Assessment:** This is an inconsistent state: correction sink exists, but correction source is not guaranteed to update in live operation.

---

### 3) Uncertainty tracking is active and valuable (but not equivalent to active drift correction)
- Device registry continuously updates `UncertaintyTracker` via gyro propagation and accel-based correction.
- Exposes drift metrics and quality scores used by quality UI components.
- Location: `mash-app/src/store/useDeviceRegistry.ts`, `mash-app/src/lib/math/uncertainty.ts`

**Assessment:** This is active and useful for monitoring, but it is **diagnostic drift estimation**, not fully closed-loop drift correction of pose.

---

### 4) Low-pass filter is real, optional, and safer than enabling AutoCalEngine wholesale
- Toggle exists in device registry, disabled by default.
- Applied on ingest path when enabled.
- Location: `mash-app/src/store/useDeviceRegistry.ts`

**Assessment:** Reasonable to keep for controlled experiments; lower systemic risk than turning on global runtime correction proposals.

---

### 5) Test coverage gap
- No direct tests found for:
  - `AutoCalEngine`
  - `DriftMonitor` live correction behavior
  - Integration of runtime correction into skeleton/FK loop

**Assessment:** Enabling currently disabled correction features without targeted tests is high risk for research-grade reproducibility.

---

## Recommendation Detail

## A) AutoCalEngine (`ENABLE_AUTO_CAL_ENGINE`)
**Decision:** Keep disabled for now.

**Enable criteria (must meet all):**
1. Single correction-application point is defined (non-FK + FK parity).
2. Correction blending limits are explicit (max deg/frame and cumulative cap).
3. Guardrails by segment type (e.g., pelvis-only heading updates).
4. Replay-based regression tests prove no pose distortion.
5. Runtime kill switch + telemetry for rollback.

If criteria are not met by next milestone, convert to tooling-only module and remove from default runtime path.

---

## B) DriftMonitor correction in FK
**Decision:** Refactor now; don’t leave half-enabled.

Choose one path:
1. **Wire fully:** call `DriftMonitor.processFrame()` at controlled cadence in live loop before FK update; keep yaw correction application.
2. **Or remove correction read:** strip `getYawCorrection()` from FK until full pipeline is validated.

For research reliability, option 2 is cleaner unless immediate validation bandwidth exists.

---

## C) CalibrationLogger
**Decision:** Keep.

Rationale:
- Valuable for auditability once runtime corrections are active.
- Low risk if left dormant.

Action:
- Keep exported; mark as instrumentation-only until correction pipeline is productionized.

---

## D) Low-pass filter toggle
**Decision:** Keep feature, default OFF.

Action:
- Document as experiment-only switch in operator/research docs.
- Add profile presets (OFF, 10Hz, 15Hz) if needed for controlled A/B runs.

---

## E) Remove stale/dead hooks
**Decision:** Remove or quarantine ambiguous dead paths.

Specifically:
- Any path that implies active correction but has no data source updates should be removed or clearly marked inert.
- Prevents operator confusion and avoids false confidence in runtime correction behavior.

---

## Proposed 2-Phase Plan

### Phase 1 (Immediate hygiene)
1. Keep `AutoCalEngine` disabled.
2. Decide and execute one path for FK drift correction consistency (wire or remove read).
3. Add explicit comments to avoid ambiguity in runtime behavior.
4. Add a short “Active vs Inactive Runtime Corrections” section in docs.

### Phase 2 (Enable candidate, controlled)
1. Implement bounded correction application pipeline.
2. Add unit + replay integration tests.
3. Run A/B comparisons (baseline vs correction-enabled) on representative sessions.
4. Enable behind feature flag only after distortion-free validation.

---

## Bottom Line

For research-grade output today:
- **Do not enable AutoCalEngine as-is.**
- **Fix the DriftMonitor/FK inconsistency immediately** (wire properly or remove correction usage).
- **Keep low-pass optional and default OFF.**
- **Retain logging/instrumentation modules but treat them as dormant until correction application is validated.**
