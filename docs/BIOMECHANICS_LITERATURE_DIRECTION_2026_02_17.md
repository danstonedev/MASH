# MASH Direction from Current Biomechanics Literature (2023–2025)

**Date:** 2026-02-17  
**Goal:** Translate recent IMU biomechanics literature into concrete product and research directions for MASH.

---

## Strategic Priority (Updated)

MASH is now explicitly targeting **research-caliber data quality over calibration speed**.

- `research_strict` should be treated as the default for all study-grade collection.
- `operational_fast` should be retained only for demos and non-research workflows.
- Any reported performance claims must declare calibration mode.

---

## 1) Literature Snapshot (What recent evidence is saying)

## 1.1 Calibration quality is still the dominant error driver
Recent work continues to show that sensor-to-segment calibration choices materially change kinematic error outcomes, especially in upper limb and multi-plane motion.

- 2024 elbow study reports meaningful differences between calibration methods and recommends method choice by context (manual alignment practical, functional calibration viable alternative).
- 2023 upper-limb systematic review highlights better performance when functional axis calibration and kinematic constraints are included.

**Implication for MASH:** Your existing static + functional hybrid architecture is directionally correct, but calibration mode selection and quality gating need to be explicit per joint/task.

---

## 1.2 Lower-limb sagittal validity is good; hip and treadmill are harder
A 2025 systematic review/meta-analysis reports that IMUs are often acceptable for ankle/knee sagittal RoM, while hip and treadmill contexts are less stable and more variable.

**Implication for MASH:**
- Knee/ankle sagittal metrics are the best near-term “defensible” outputs.
- Hip and multi-plane metrics need stronger calibration QA + confidence reporting before being used as primary claims.

---

## 1.3 Variability is high across studies due to protocol heterogeneity
Recent reviews repeatedly attribute between-study variability to inconsistent placement, calibration protocols, and processing pipelines.

**Implication for MASH:** Standardizing and logging your protocol may yield as much benefit as adding new algorithms.

---

## 1.4 Magnetometer-free approaches remain feasible but yaw remains vulnerable
Recent magnetometer-free gait papers still report heading/yaw limitations and observability issues during degenerate motions (e.g., straight walking), even when sagittal outputs are strong.

**Implication for MASH:** Your heading coherence + hierarchical constraints are strategic strengths; these should be formalized as first-class QC outputs.

---

## 1.5 ML is becoming the bridge to OMC methodology, but not yet a replacement for calibration discipline
2025 deep-learning papers show promising IMU→marker/kinematics mapping with improved errors after temporal alignment and cross-dataset testing.

**Implication for MASH:** ML is a strong medium-term layer for refinement and harmonization, but should sit on top of robust calibration/QC—not replace it.

---

## 2) MASH Positioning vs Literature

### 2.1 Where MASH already aligns well
- Multi-level calibration pipeline (static + functional)
- Functional axis estimation using PCA and SARA-style dual-sensor concepts
- Runtime verification and confidence concepts
- Strong synchronization and packet-level robustness in firmware

### 2.2 Where MASH is currently behind state-of-practice expectations
1. **Protocol consistency:** documented per-limb sequence differs from runtime auto-flow
2. **Joint-specific QC gates:** current thresholds are more operationally permissive than validation-grade
3. **Session-level calibration traceability:** no single standardized calibration report artifact with method/quality/pass-fail per joint
4. **External validity framing:** no explicit claim taxonomy (what is “clinical-grade”, “research-grade”, “operational”) by metric and context

---

## 3) Recommended Direction (Prioritized)

## Phase A (Immediate: 2–4 weeks) — Standardize and make claims defensible

1. **Create two formal calibration modes**
   - `operational_fast`: current streamlined flow
   - `validation_strict`: scripted per-limb sequence with stricter thresholds

2. **Implement per-joint hard quality gates**
   - Hinge-critical joints (knee/elbow): higher SARA/PCA confidence thresholds
   - Fail/retry logic captured explicitly (not just warnings)

3. **Emit calibration session artifact (`json` + human report)**
   - For each joint: method, confidence, sample count, pass/fail, retry count, drift notes

4. **Define claim tiers for users and publications**
   - Tier 1: exploratory/operational
   - Tier 2: research-comparable
   - Tier 3: clinical-supporting (only after validation studies)

**Expected outcome:** biggest reduction in methodological risk with minimal algorithmic churn.

---

## Phase B (Near-term: 1–2 months) — Improve known weak points

1. **Hip robustness track**
   - Add stricter movement prescriptions and confidence checks for hip rotation planes
   - Separate overground vs treadmill calibration/validation profiles

2. **Heading robustness track**
   - Add explicit heading quality score and drift monitor outputs per session
   - Build fail-safe when yaw observability is poor (e.g., constrained straight-line task)

3. **Upper-limb free-living mode**
   - Add shoulder/scapula caution flags and reduced-confidence reporting where STA risk is high

---

## Phase C (Medium-term: 2–4 months) — Validation & ML augmentation

1. **Validation study package**
   - Concurrent comparison against OMC/force plates with predefined endpoints
   - Report by joint/plane/activity, not only aggregate scores

2. **ML augmentation layer (optional by mode)**
   - Use data-driven mapping to refine angles in hard segments (hip/shoulder)
   - Keep physics/constraint path as default and transparent baseline

---

## 4) What Direction to Take Next (Direct Answer)

If the goal is to move toward industry-standard credibility quickly, the best next direction is:

1. **Make research-strict calibration the primary default path**
2. **Enforce joint-specific hard pass/fail gates with session-level QC artifacts**
3. **Prioritize hip/yaw robustness before broad feature expansion**
4. **Run structured external validation before stronger clinical-style claims**

This sequence is most aligned with current literature and gives MASH the strongest path to defensible outcomes.

---

## 5) Practical 90-Day KPI Set

- `% sessions with all critical joints passing strict gates`
- `median calibration retries per joint`
- `knee/ankle sagittal RMSE vs reference in validation set`
- `hip error stratified by overground vs treadmill`
- `heading drift score distribution by session type`
- `documentation-to-runtime protocol conformance rate`

---

## 6) Source List Used for This Refresh

- PubMed: *Validity of Wearable Inertial Sensors for Gait Analysis: A Systematic Review* (2024), PMID 39795564
- PubMed: *Effects of IMU sensor-to-segment calibration on clinical 3D elbow joint angles estimation* (2024), PMID 38835976
- PubMed: *Conversion of Upper-Limb IMU Data to Joint Angles: A Systematic Review* (2023), PMID 37514829
- PubMed: *Comparison of Joint Axis Estimation Methods Using IMUs* (2024), PMID 40039139
- PubMed: *Concurrent validity of wearable IMUs for sagittal lower-limb RoM and estimated GRFs: systematic review & meta-analysis* (2025), PMID 41088368
- PubMed: *Body-Worn IMU-Based Human Hip and Knee Kinematics Estimation during Treadmill Walking* (2022), PMID 35408159
- PubMed: *Quantifying shoulder motion in the free-living environment using wearable IMUs: Challenges and recommendations* (2025), PMID 39987887
- PubMed: *Bridging the methodological gap between IMUs and OMC with deep learning* (2025), PMID 41012969

---

## 7) Caveat

Literature and benchmarks are evolving rapidly. Recommendations above are grounded in currently available evidence and should be rechecked quarterly for threshold updates and stronger meta-analytic consensus.
