# MASH vs Industry Functional Calibration Matrix (Joint-by-Joint)

**Date:** 2026-02-17  
**Purpose:** Establish a single, auditable reference for comparing MASH functional limb calibration against industry/research norms and defining acceptance gates for validation studies.

---

## 1) Scope and Baseline

This matrix compares three layers:

1. **MASH intended protocol** (documented per-segment strategy)
2. **MASH runtime protocol** (what `UnifiedCalibration` currently executes)
3. **Industry-standard expectations** (Xsens/Noraxon/OpenSim-aligned research practice)

Primary MASH references:
- `docs/CALIBRATION_STRATEGY.md`
- `mash-app/docs/CalibrationGuide.md`
- `mash-app/src/calibration/UnifiedCalibration.ts`
- `mash-app/src/calibration/hingeCalibration.ts`
- `mash-app/src/calibration/sara.ts`

---

## 2) Protocol Reality Check (Critical)

### 2.1 Documented Intended Full-Body Sequence (Per-Limb)

1. Static T-pose capture (all sensors)  
2. Left leg functional (hip swing + knee bend)  
3. Right leg functional (hip swing + knee bend)  
4. Left arm functional (shoulder raise + elbow bend)  
5. Right arm functional (shoulder raise + elbow bend)  
6. Head 2-axis functional (nod + shake)

### 2.2 Runtime Executed Full-Body Sequence (`UnifiedCalibration`)

`warm-up -> auto-pose -> sit-to-stand -> auto-walk -> verification -> complete`

**Implication:** There is a protocol mismatch between documentation/training and runtime execution. This must be resolved before formal validation benchmarking.

---

## 3) Joint-by-Joint Calibration Matrix

### Legend
- **Static:** static pose boresight/tare
- **PCA:** single-sensor principal axis from gyro
- **SARA:** dual-sensor hinge axis (preferred when both segments are instrumented)
- **Pass/Fail:** hard gate for accept/retry decision in study-grade sessions

| Segment / Joint | MASH Intended Motion Prescription | MASH Runtime Data Source (Current) | Industry Typical Functional Protocol | Recommended Minimum Reps / Duration | Recommended Confidence Gate | Pass/Fail Rule (Recommended) |
|---|---|---|---|---|---|---|
| Pelvis (root) | Static T-pose hold | `auto-pose` stability capture + heading extraction during walk | Static neutral with strict stillness; optional dynamic heading consistency check | 1 static capture; >=1.5 s stable | Stillness + gravity alignment quality >=0.85 | **Pass** if stable window reached and pose quality >=85; else retry static |
| Torso / Spine upper | Static T-pose hold | `auto-pose` + dynamic refinement via walk/sit-to-stand PCA | Static neutral; optional trunk flex/rotation trials for frame refinement | 1 static + optional 3 trunk cycles | Static quality >=0.80 | **Pass** if static quality >=80 and no validation warnings of severe drift |
| Hip L/R (pelvis->thigh) | Leg swing forward/back x3 per side | sit-to-stand + auto-walk mixed functional buffers | Functional flex/ext cycles with parent+child sensors; SARA favored | >=3–5 controlled cycles per side (or >=6 s usable movement) | SARA >=0.70 preferred; PCA >=0.75 fallback | **Pass** if SARA>=0.70 or PCA>=0.75 and ROM sample quality acceptable |
| Knee L/R (thigh->tibia) | Knee bend x3 per side | sit-to-stand + auto-walk mixed functional buffers | Isolated knee flex/ext cycles with minimal hip compensation; SARA favored | >=5 cycles preferred (>=3 minimum) | SARA >=0.75 preferred; PCA >=0.80 fallback | **Pass** if SARA>=0.75 or PCA>=0.80; fail if dominant multi-axis contamination |
| Ankle L/R (tibia->foot) | Static only (feet flat) | Mostly static + dynamic walk effects | Static neutral often acceptable; optional plantar/dorsi functional trial in high-accuracy studies | Static + optional 3 dorsiflex cycles | Static quality >=0.80; optional PCA >=0.70 | **Pass** static if posture quality >=80; for research mode add functional check |
| Shoulder L/R (torso->upper arm) | Arm raise x3 per side | auto-walk general movement buffer | Controlled flexion or abduction cycles, one arm at a time | >=3–5 cycles per side | SARA >=0.70 preferred; PCA >=0.75 fallback | **Pass** if unilateral movement yields confidence gate; otherwise force side-specific redo |
| Elbow L/R (upper arm->forearm) | Elbow bend x3 per side | auto-walk mixed movement | Isolated elbow flex/ext cycles; avoid shoulder coupling | >=5 cycles preferred | SARA >=0.75 preferred; PCA >=0.80 fallback | **Pass** if isolation quality high and gate met; fail if shoulder movement dominates |
| Wrist L/R (forearm->hand) | Static only | static + generic functional exposure | Often static for production; functional for specialty studies | Static (+ optional wave/flex cycles) | Static >=0.80 | **Pass** static for baseline; require functional only if wrist endpoint is primary outcome |
| Head / Cervical | Hold + nod x3 + shake x3 | Topology/runtime dependent; not explicitly in full-body default flow | 2-axis functional protocol is standard for head-mounted IMUs | >=3 nod + >=3 shake with clean isolation | Pitch and yaw confidence each >=0.80 (combined >=0.80) | **Pass** only if both axes pass and cross-axis leakage is acceptable |

---

## 4) Method-Specific Threshold Matrix

| Method | MASH Current Behavior | Recommended Study-Grade Threshold | Retry Condition |
|---|---|---|---|
| Static stability detection | `auto-pose` uses ~1500 ms stable window | Keep >=1500 ms, plus variance cap and gravity consistency check | Motion reset, or quality <0.80 |
| PCA axis detection | Early exits around 0.65–0.70 in some paths | Raise target to >=0.75 for hinge-critical joints | Confidence < threshold or low ROM |
| SARA hinge axis | Accepted when confidence >0.4 in hinge path | Require >=0.70 for pass, >=0.75 for knee/elbow | SARA below threshold; fallback PCA must still pass |
| Verification step | Movement-based quick ROM check | Add explicit per-joint pass/fail report with confidence + smoothness | Any critical joint fails threshold |

---

## 5) Required Gating Outputs Per Session (for Industry Comparison)

For each calibrated joint, store:

- method used (`static`, `pca-refined`, `sara-refined`)
- confidence score (method-specific)
- sample count and usable duration
- movement quality flags (isolation, smoothness, range)
- pass/fail status and retry count

Without this, comparisons against Xsens/Noraxon/OpenSim workflows are difficult to defend in formal validation.

---

## 6) Mismatch Register (Must Resolve)

1. **Flow mismatch:** per-limb documented sequence vs generic auto runtime flow  
2. **Threshold mismatch:** runtime allows lower-confidence early exits than study-grade expectations  
3. **Head calibration consistency:** documented as dedicated 2-axis protocol, but full-body runtime path is generic unless separately routed  
4. **Joint isolation fidelity:** walk/sit-to-stand buffers are efficient but may reduce joint-specific axis purity vs isolated prescriptions

---

## 7) Decision Recommendation

Adopt one canonical mode for external validation studies:

- **Mode A (Research/Validation):** strict per-limb scripted functional sequence with higher gates
- **Mode B (Operational):** current streamlined auto flow for speed/usability

Both can coexist, but reports and publications should always declare which mode generated the data.

---

## 8) Immediate Next Implementation Items

1. Add a **Calibration Mode selector** (`research_strict` vs `operational_fast`)  
2. Enforce per-joint confidence thresholds from this matrix  
3. Emit machine-readable calibration QC artifact per session  
4. Align user docs with actual runtime mode behavior

---

## 9) Audit Conclusion

MASH already contains strong calibration primitives (multi-level tare, PCA, SARA, verification). The key next step is **protocol unification + explicit gating** so your process is both high-performing and publication-defensible against industry standards.
