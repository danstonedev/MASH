# Research-Strict Code Tickets (MASH)

**Date:** 2026-02-17  
**Intent:** Convert the research-first calibration strategy into concrete, file-level engineering tickets.

---

## Implementation Principle

All tickets below assume:

- `research_strict` is the default mode for study-grade data
- low-confidence calibration cannot silently pass in research mode
- every calibration run emits a machine-readable QC artifact

---

## Sprint 1 — Protocol and Mode Architecture

## RS-001 — Add explicit calibration mode model
**Priority:** P0  
**Goal:** Introduce explicit mode enum and state propagation (`research_strict`, `operational_fast`).

**Primary files / symbols**
- `mash-app/src/calibration/UnifiedCalibration.ts`
  - `start(...)`
  - `currentFlow`
  - `CALIBRATION_FLOWS`
- `mash-app/src/store/useCalibrationStore.ts`
  - `CalibrationState`
  - `calibrationMode`
  - `setCalibrationMode`
- `mash-app/src/components/layout/panels/DevicePanel.tsx`
  - `handleStartCalibration()`
  - `useQuickMode`

**Tasks**
1. Replace `useQuickMode/useStreamlined` branching with mode-driven routing.
2. Add mode to calibration state and runtime metadata.
3. Default UI/action path to `research_strict`.

**Acceptance criteria**
- Mode is visible in runtime state and persisted in store/session context.
- Calibration flow selection is mode-based, not ad hoc boolean flags.

---

## RS-002 — Implement strict per-limb research flow
**Priority:** P0  
**Goal:** Add deterministic research sequence (static + bilateral limb tasks + head 2-axis).

**Primary files / symbols**
- `mash-app/src/calibration/UnifiedCalibration.ts`
  - `CalibrationStep`
  - `STEP_DURATIONS`
  - `completeCurrentStep()`
  - `captureFunctionalData(...)`
- `mash-app/src/components/layout/panels/DevicePanel.tsx`
  - step instructions rendering

**Tasks**
1. Add new steps for left/right limb isolation and head 2-axis capture.
2. Ensure each step has dedicated capture buffers and completion rules.
3. Keep existing streamlined flow behind `operational_fast`.

**Acceptance criteria**
- Research mode always executes the scripted per-limb sequence.
- Head functional calibration is explicitly included in research mode.

---

## Sprint 2 — Hard Gating and Retry Logic

## RS-003 — Add per-joint hard pass/fail gate engine
**Priority:** P0  
**Goal:** Promote confidence checks to hard gates for research mode.

**Primary files / symbols**
- `mash-app/src/calibration/UnifiedCalibration.ts`
  - `computeFinalCalibration()`
  - `performVerification()`
  - `runPostCalibrationValidation()`
- `mash-app/src/calibration/hingeCalibration.ts`
  - `calibrateHingeJoint(...)`
  - `assessHingeQuality(...)`
- `mash-app/src/calibration/sara.ts`
  - `SARAResult.confidence`

**Tasks**
1. Add joint-type threshold profile (knee/elbow stricter than generic).
2. Emit explicit gate outcomes (`PASS`, `RETRY_REQUIRED`, `FAIL`).
3. Block completion in research mode when critical joints fail.

**Acceptance criteria**
- No research-mode run finishes `complete` with failed critical joints.
- Gate outcomes are available for UI and export.

---

## RS-004 — Add movement quality checks (isolation / ROM / smoothness)
**Priority:** P0  
**Goal:** Reject low-quality functional trials even when confidence is superficially high.

**Primary files / symbols**
- `mash-app/src/calibration/UnifiedCalibration.ts`
  - `processFrame(...)` (functional steps)
  - `performVerification()`
- `mash-app/src/calibration/calibrationMath.ts`
  - `estimateFunctionalAxis(...)`

**Tasks**
1. Add trial-level movement-quality metrics.
2. Add retry reason taxonomy (`low_confidence`, `insufficient_rom`, `cross_axis_contamination`, `jitter`).

**Acceptance criteria**
- Functional trial acceptance requires confidence + motion-quality pass.
- Retry reason displayed and serialized.

---

## Sprint 3 — QC Artifact and Reporting

## RS-005 — Add calibration QC JSON artifact exporter
**Priority:** P0  
**Goal:** Write `calibration_qc_<sessionId>.json` for every research-mode run.

**Primary files / symbols**
- `mash-app/src/store/useCalibrationStore.ts`
  - `CalibrationReport` (extend)
- `mash-app/src/store/useRecordingStore.ts`
  - session metadata lifecycle
- New file:
  - `mash-app/src/calibration/CalibrationQcExporter.ts` (create)

**Tasks**
1. Define QC schema with per-joint outcomes.
2. Export mode, thresholds, method used, retries, drift, and final pass/fail.
3. Attach artifact to session export path.

**Acceptance criteria**
- Research-mode calibration always produces JSON QC artifact.
- Artifact is retrievable with session data.

---

## RS-006 — Add human-readable QC markdown summary
**Priority:** P1  
**Goal:** Generate a markdown summary for investigators and audit logs.

**Primary files / symbols**
- New file:
  - `mash-app/src/calibration/CalibrationQcReport.ts` (create)
- `mash-app/src/store/useCalibrationStore.ts`
  - `setCalibrationReport(...)`

**Tasks**
1. Generate per-joint table with method/confidence/pass-fail.
2. Include session-level verdict and exclusion reason if failed.

**Acceptance criteria**
- Report can be downloaded/exported with run data.
- Matches JSON artifact contents.

---

## Sprint 4 — Robustness for known weak points

## RS-007 — Add heading observability and drift quality score
**Priority:** P1  
**Goal:** Explicitly quantify heading reliability in magnetometer-limited scenarios.

**Primary files / symbols**
- `mash-app/src/calibration/UnifiedCalibration.ts`
  - heading extraction in `captureWalkInPlaceData()`
- `mash-app/src/store/useTareStore.ts`
  - heading-related state integration

**Tasks**
1. Add heading quality metric and confidence tier.
2. Add warnings for degenerate motion observability.

**Acceptance criteria**
- Each research run includes heading quality in QC artifact.

---

## RS-008 — Hip-specific reliability profile (context-aware)
**Priority:** P1  
**Goal:** Make hip outputs context-aware (overground/treadmill-like/degenerated motions).

**Primary files / symbols**
- `mash-app/src/calibration/UnifiedCalibration.ts`
  - `computeFinalCalibration()`
  - verification path
- `mash-app/src/biomech/KinematicsEngine.ts`

**Tasks**
1. Add hip confidence contextual tag.
2. Increase strictness for hip internal/external rotation in research mode.

**Acceptance criteria**
- Hip outputs include quality/context tags in QC artifact and UI.

---

## QA / Test Tickets (parallel)

## RS-009 — Unit tests for mode routing and strict gates
**Priority:** P0

**Primary files**
- `mash-app/src/tests/calibrationVerification.test.ts`
- `mash-app/src/tests/calibration.test.ts`
- `mash-app/src/tests/orientationPipelineE2E.test.ts`

**Acceptance criteria**
- Tests cover: strict mode default, critical-joint fail blocks completion, retry behavior.

---

## RS-010 — Integration tests for QC artifact generation
**Priority:** P0

**Primary files**
- New tests:
  - `mash-app/src/tests/calibrationQcArtifact.test.ts`

**Acceptance criteria**
- JSON and markdown artifacts are generated and internally consistent.

---

## RS-011 — Regression tests for existing fast flow
**Priority:** P1

**Primary files**
- `mash-app/src/tests/calibrationVerification.test.ts`

**Acceptance criteria**
- `operational_fast` behavior unchanged except explicit mode labeling.

---

## RS-012 — Documentation and protocol conformance checks
**Priority:** P1

**Primary docs**
- `docs/FUNCTIONAL_CALIBRATION_INDUSTRY_MATRIX_2026_02_17.md`
- `docs/RESEARCH_CALIBRATION_EXECUTION_PLAN_2026_02_17.md`
- `mash-app/docs/CalibrationGuide.md`

**Acceptance criteria**
- User docs and runtime flow descriptions are synchronized.

---

## Dependency Order

1. RS-001 -> RS-002 -> RS-003/RS-004  
2. RS-005/RS-006 can begin once RS-003 data model is stable  
3. RS-007/RS-008 after strict flow lands  
4. RS-009..012 run continuously, with final pass before research release tag

---

## Release Gate (Research Mode)

Research mode can be declared active only when:

- RS-001 through RS-006 are complete
- RS-009 and RS-010 pass in CI
- At least one pilot dataset exported with full QC artifacts

---

## Notes for Task Board Import

Use ticket IDs as canonical labels (`RS-001` .. `RS-012`) and map them to epics:

- Epic A: Mode + Flow
- Epic B: Strict Gating
- Epic C: QC Artifacts
- Epic D: Robustness
- Epic E: Validation/QA
