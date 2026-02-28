# MASH Research-First Calibration Execution Plan

**Date:** 2026-02-17  
**Program Objective:** Build MASH toward research-caliber biomechanics data quality, with reproducible calibration, auditable QC, and validation-grade reporting.

---

## 1) Strategic Decision (Locked)

1. **Primary mode:** `research_strict` (default for all internal studies and external evaluations)
2. **Secondary mode:** `operational_fast` (allowed for demos/UX only)
3. **No mixed claims:** outputs must always declare mode in metadata and reports

---

## 2) Definition of “Research-Caliber” for MASH

A session qualifies as research-caliber only if all below are true:

1. Protocol used is `research_strict`
2. All critical joints pass strict calibration gates
3. Session emits complete QC artifact (method, confidence, sample counts, retries)
4. Validation checks pass (or failures are explicitly flagged and excluded)
5. Data processing configuration is fully versioned and reproducible

---

## 3) Engineering Workstreams

## WS-A: Protocol Unification (Highest Priority)

### A1. Implement explicit calibration mode architecture
**Scope**
- Add `research_strict` and `operational_fast` mode selector in calibration orchestrator
- Ensure mode is persisted in session metadata and export payloads

**Acceptance Criteria**
- Every calibration session records mode
- Runtime flow and thresholds are deterministically selected by mode
- Existing behavior remains available under `operational_fast`

### A2. Add strict per-joint scripted flow for research mode
**Scope**
- Implement per-limb sequence from strategy docs: static -> left leg -> right leg -> left arm -> right arm -> head
- Enforce side-isolated movement prompts and completion checks

**Acceptance Criteria**
- Research mode never uses generic walk-only substitution for hinge calibration
- Each prescribed motion is captured with independent quality assessment

---

## WS-B: Joint-Specific Quality Gating

### B1. Promote strict confidence thresholds to hard pass/fail gates
**Baseline target gates (initial)**
- Knee/Elbow (hinge-critical): SARA >= 0.75 preferred; PCA fallback >= 0.80
- Hip/Shoulder: SARA >= 0.70 preferred; PCA fallback >= 0.75
- Head 2-axis: pitch >= 0.80 and yaw >= 0.80
- Static segments: static quality >= 0.80

**Acceptance Criteria**
- Joint is marked `FAIL` if gate unmet
- Calibration flow forces retry on critical-joint fail
- No silent fallback to low-confidence outputs in research mode

### B2. Add movement quality constraints
**Scope**
- Add isolation, smoothness, and minimum ROM checks per functional trial
- Reject trials with excessive cross-axis contamination

**Acceptance Criteria**
- Trial-level QC is included in final session artifact
- Retry reason codes are explicit (`low_confidence`, `poor_isolation`, `insufficient_rom`, etc.)

---

## WS-C: Session QC Artifact & Reproducibility

### C1. Emit machine-readable calibration artifact
**Output file:** `calibration_qc_<sessionId>.json`

**Minimum schema**
- mode, software version, thresholds profile
- per-joint: method, confidence, sampleCount, usableDuration, passFail, retryCount
- heading/drift metrics
- final session pass/fail

### C2. Emit human-readable calibration report
**Output file:** `calibration_qc_<sessionId>.md`

**Acceptance Criteria**
- Artifact generated for every research-mode run
- Artifact can be used to filter sessions for analysis inclusion/exclusion

---

## WS-D: Heading and Hip Robustness (Known weak points)

### D1. Heading observability score
**Scope**
- Add per-session heading confidence/drift indicators
- Flag degenerate tasks where yaw observability is weak

### D2. Hip reliability profiling
**Scope**
- Separate quality profiles for overground vs treadmill-like motions
- Require stricter movement prescription for hip plane calibration

**Acceptance Criteria**
- Hip outputs include confidence tier and context tags
- Research exports include warning flags for borderline hip validity

---

## WS-E: Validation Study Framework

### E1. Establish external validation protocol
**Design**
- Compare against OMC (and force plates where relevant)
- Analyze by joint, plane, and activity context

### E2. Define endpoint metrics
- RMSE / MAE per joint-plane
- agreement analyses (correlation + Bland-Altman)
- pass rates by calibration mode

**Acceptance Criteria**
- Validation protocol document exists and is executable
- Dataset split and analysis scripts are versioned

---

## 4) Suggested Sprint Breakdown (90 Days)

## Sprint 1 (Weeks 1–2): Foundation
- Implement mode architecture (`research_strict` + metadata)
- Add strict flow scaffold and step-level hooks
- Add pass/fail status model for joints

## Sprint 2 (Weeks 3–4): Gating + QC artifacts
- Implement hard gates and retry loops
- Implement JSON + Markdown QC artifacts
- Add failure reason taxonomy

## Sprint 3 (Weeks 5–8): Robustness upgrades
- Add heading observability scoring
- Add hip context-specific quality profile
- Tighten head 2-axis calibration checks

## Sprint 4 (Weeks 9–12): Validation readiness
- Freeze strict protocol version
- Run pilot concurrent validity dataset
- Produce first research-mode performance report

---

## 5) Non-Negotiable Rules Going Forward

1. **Research claims require research mode only**
2. **No publication-grade output without QC artifact attached**
3. **Any failed critical joint invalidates full-session research label**
4. **Threshold changes must be versioned and changelogged**

---

## 6) Immediate Implementation Tickets (Start Next)

1. Add `CalibrationMode` enum + persistence + export field
2. Add `research_strict` flow definition and step router
3. Implement per-joint gate evaluator service
4. Implement `calibration_qc_<sessionId>.json` serializer
5. Add UI/state visibility for per-joint pass/fail and retry prompts

---

## 7) Success Criteria at 90 Days

- >=90% of research-mode sessions produce complete QC artifacts
- >=80% pass rate on critical joints after guided retries
- Demonstrated improvement in knee/ankle repeatability and confidence stability
- First external concurrent-validity pilot completed with reproducible pipeline

---

## 8) Decision Summary

MASH should proceed as a **research-first system**, where speed-optimized calibration remains available but is clearly separated from research-grade outputs. This protects scientific validity, aligns with current biomechanics literature, and establishes a credible path to publication-quality evidence.
