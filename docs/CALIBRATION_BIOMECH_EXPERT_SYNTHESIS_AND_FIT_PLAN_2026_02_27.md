# Calibration Refinement: Biomechanics Expert Synthesis + Fit-It Plan

**Date**: 2026-02-27  
**Prepared by**: Copilot synthesis of internal expert reviews (Vicon specialist, OpenSim specialist, clinical gait perspective)  
**Scope**: Refine calibration reliability and operator trust for multi-sensor (up to full-body) IMU workflows

---

## 1) Expert Synthesis (What a biomechanics reviewer would prioritize)

### A. The current direction is correct
Your current architecture already aligns with strong biomechanics practice:
- Multi-layer calibration/tare model (mounting alignment + heading/world alignment + clinical offsets)
- Topology-aware calibration flow
- Improved preflight and sync quality gating
- Timestamp-aligned pairing for dual-sensor calibration steps

### B. Remaining failure modes that most affect real users
From the specialist reviews and observed system behavior, highest-impact risks are:
1. **Calibration sample contamination** (micro-motion during “static” windows)
2. **Time misalignment in dual-sensor constraints** (especially SARA/SCoRE ingestion)
3. **Hidden quality uncertainty** (operator sees “success” but confidence should be conditional)
4. **No explicit post-cal functional verification** (user cannot quickly verify if calibration generalized to movement)

### C. Industry-comparable approaches worth adopting
Comparable systems (clinical gait labs, inertial suites) typically layer:
- **Static quality checks**: stillness/variance + gravity consistency before accepting samples
- **Temporal alignment quality thresholds**: hard fail or downgrade if skew/interpolation/drop rates exceed limits
- **Task-based verification** after calibration: neutral hold + small functional movement test
- **Confidence surfaced in UI** with one clear next action

---

## 2) Refined Calibration Principles (Before coding details)

1. **Do not accept calibration on intent; accept on quality evidence.**  
   Every accepted stage should satisfy measurable criteria (stillness, sync quality, sample count).

2. **Treat time alignment as first-class calibration input quality.**  
   Pairing quality is not just diagnostics; it should drive pass/fail and retry guidance.

3. **Separate “calibrated” from “trusted.”**  
   A stage can complete, but overall trust can be medium/low until functional checks pass.

4. **Use progressive burden.**  
   Fast initial path for users; only invoke stricter retries for failed regions/sensors.

5. **Always provide one immediate recovery action.**  
   Every warning/failure should map to exactly one recommended operator action.

---

## 3) Fit-It Plan (Phased, implementation-ready)

## Phase 0 — Baseline Lock + Metrics (1 sprint)
**Goal**: Ensure changes are measurable and reversible.

- Add calibration telemetry counters per run:
  - preflight failures by reason
  - stage retries
  - timeline interpolation ratio
  - timeline drop ratio
  - max skew
  - post-cal test pass rate
- Add `calibration_version` and `quality_profile` tags in QC artifact.

**Exit criteria**:
- Baseline report generated from at least 20 sessions.
- No regressions in existing build/type-check pipeline.

---

## Phase 1 — Static Capture Hardening (1 sprint)
**Goal**: Reduce false acceptance during static stages.

- For each static pose stage:
  - collect fixed-duration window (e.g., 0.5–1.0s)
  - compute quaternion variance and accel magnitude stability
  - reject sample window if motion threshold exceeded
- Use robust spherical mean over accepted window, not instantaneous sample.
- Surface actionable retry instruction tied to specific failed metric.

**Exit criteria**:
- >30% reduction in “good at calibration, bad in motion” complaints.
- Static stage acceptance is metric-backed (no unconditional quality=1 behavior).

---

## Phase 2 — Temporal Pairing Quality Gates (1 sprint)
**Goal**: Make dual-sensor steps fail fast when timing is weak.

- Promote timeline diagnostics into hard gate tiers:
  - green: accept
  - yellow: accept with warning + medium trust
  - red: fail stage + guided retry
- Add per-joint alignment quality scoring for SARA/SCoRE input windows.
- If red at full-body level, allow **targeted joint-region retry** rather than full reset.

**Exit criteria**:
- Lower variance in joint center/axis estimates across repeat trials.
- Reduced operator full-session restarts.

---

## Phase 3 — Post-Cal Functional Verification (1 sprint)
**Goal**: Confirm calibration transfers from static pose to movement.

Add two explicit post-cal test stages:
1. **Pose-check (10s neutral standing)**
   - thresholds: low drift, stable segment orientation, gravity-consistent trunk
2. **Squat-check (3–5 controlled reps)**
   - thresholds: bilateral symmetry envelope, plausible knee/hip coupling, low discontinuity

Outputs:
- pass / warn / fail per test
- clear remediation path (e.g., “retry thigh-shank pair only”)
- incorporate into trust card and QC markdown artifact

**Exit criteria**:
- Post-cal tests present in workflow and saved artifact.
- Operators can complete targeted fix loop in under 2 minutes.

---

## Phase 4 — Clinical/Research Confidence Layer (optional, 1–2 sprints)
**Goal**: Improve external validity and advanced use cases.

- Add profile presets (healthy adult / low-mobility / athletic) for thresholds.
- Add reliability score trend across sessions for each user/sensor set.
- Add optional export bundle for downstream OpenSim-style QA checks.

**Exit criteria**:
- Distinct threshold profiles validated on pilot cohort.
- Trend dashboard shows confidence improvement over repeated calibrations.

---

## 4) Prioritized Backlog (Top 10)

1. Implement static window stillness validator (quaternion + accel).
2. Replace single-frame static capture with robust windowed average.
3. Formalize timeline gate thresholds (green/yellow/red).
4. Add per-joint pairing quality score.
5. Add targeted retry routing by failed region.
6. Add post-cal `pose-check` stage in orchestrator + UI.
7. Add post-cal `squat-check` stage in orchestrator + UI.
8. Add test thresholds to QC artifact and markdown export.
9. Add trust state transition logic (`calibrated` -> `trusted`).
10. Add session telemetry summary for calibration improvement tracking.

---

## 5) Suggested Defaults (starting point)

Use as initial defaults, then tune from telemetry:
- Static window duration: 800 ms
- Minimum valid samples: 30
- Quaternion variance max: 0.001 (stage-dependent)
- Timeline max skew:
  - green <= 12 ms
  - yellow <= 20 ms
  - red > 20 ms
- Timeline dropped pair ratio:
  - green <= 5%
  - yellow <= 10%
  - red > 10%
- Squat-check reps: 3 required, smooth monotonic flexion/extension segments

---

## 6) Definition of Done for “Calibration 2.0”

Calibration is considered production-ready when:
- Static and dual-sensor stages are evidence-gated (not assumption-gated).
- Functional post-cal checks are mandatory for trust=high.
- Retry paths are region-specific and complete quickly.
- QC artifact captures enough data to explain every pass/fail decision.
- Operators receive one clear next action at all times.

---

## 7) Immediate Next Implementation Slice

If starting now, implement this smallest high-impact slice first:
1. Static window validator + robust averaging for all static stages.
2. Add `pose-check` and `squat-check` as explicit post-cal steps.
3. Wire results into Trust Status and QC markdown output.

This gives the largest trust gain with minimal workflow disruption.
