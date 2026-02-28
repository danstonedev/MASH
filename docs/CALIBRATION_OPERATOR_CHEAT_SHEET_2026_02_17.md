# MASH Calibration Operator Cheat Sheet (Research-First)

Date: 2026-02-17  
Audience: Operators running calibration with variable sensor kits  
Default Mode: **Research Strict** (Operational Fast is optional)

---

## 1) Pre-Flight (Always)

1. Connect sensors and confirm assignments are correct.
2. Choose mode:
   - **Research Strict** for research-quality data (default)
   - **Operational Fast** for quicker field workflows
3. Ensure subject starts in neutral standing posture.
4. Keep magnetically noisy objects away from sensors when possible.
5. Start calibration.

---

## 2) Kit → Flow Map

> If assignments change, topology is re-detected at start, and the flow adapts automatically.

### A) 1-Sensor Kit (Single Sensor)

Typical examples: head only, pelvis only, one limb segment.

**Research Strict**
- warm-up
- static-pose
- generic-flex
- final-pose
- verification
- complete

**Operational Fast**
- warm-up
- auto-pose
- generic-flex
- verification
- complete

Operator cue: For `generic-flex`, perform the joint motion that best excites that segment (controlled, full ROM, repeatable).

---

### B) 2-Sensor Skate/Foot Kit (Dual Skate)

Typical examples: `skate_l + skate_r` or foot-paired setup.

**Research Strict**
- warm-up
- static-pose
- ankle-flex
- final-pose
- verification
- complete

**Operational Fast**
- warm-up
- auto-pose
- auto-walk
- verification
- complete

Operator cue: Use clear dorsiflexion/plantarflexion cycles during `ankle-flex`.

---

### C) Leg Kit (Sparse Leg / Full Leg)

Typical examples: thigh+tibia subsets, unilateral or bilateral, with/without pelvis.

**Research Strict**
- warm-up
- static-pose
- leg-left-functional
- leg-right-functional
- final-pose
- verification
- complete

**Operational Fast**
- warm-up
- auto-pose
- sit-to-stand
- verification
- complete

Operator cue:
- Left step: only left leg motion (swing + bend), controlled cadence.
- Right step: only right leg motion.
- If one side is uninstrumented, that side step is effectively a low/no-op capture; continue flow.

---

### D) Arm Kit (Sparse Arm)

Typical examples: upper-arm/forearm/hand subsets.

**Research Strict**
- warm-up
- static-pose
- arm-left-functional
- arm-right-functional
- final-pose
- verification
- complete

**Operational Fast**
- warm-up
- auto-pose
- auto-walk
- verification
- complete

Operator cue:
- Left arm step: controlled shoulder raise/lower + elbow flexion
- Right arm step: same pattern on right

---

### E) Core Kit (Core Only)

Typical examples: pelvis/torso/chest/head only.

**Research Strict**
- warm-up
- static-pose
- hip-rotation
- final-pose
- verification
- complete

**Operational Fast**
- warm-up
- auto-pose
- auto-walk
- verification
- complete

Operator cue: Use smooth trunk/hip rotation; avoid jerky starts/stops.

---

### F) Full Body / Sparse Body Kit

Typical examples: mixed upper + lower + core sensors.

**Research Strict**
- warm-up
- static-pose
- leg-left-functional
- leg-right-functional
- arm-left-functional
- arm-right-functional
- head-functional
- final-pose
- verification
- complete

**Operational Fast**
- warm-up
- auto-pose
- sit-to-stand
- auto-walk
- verification
- complete

Operator cue:
- Isolate each requested limb during its functional step.
- Keep head nod/shake gentle and consistent in `head-functional`.

---

## 3) Motion Quality Rules (Operator Version)

Use these in every functional step:
- Move through **clear ROM** (avoid tiny motion).
- Maintain **smooth motion** (avoid jerk/spikes).
- Use **repeatable tempo** (not random bursts).
- Keep non-target body parts as still as practical during isolated steps.

---

## 4) Research Strict Pass/Fail Behavior

In Research Strict, critical joints are hard-gated. Calibration can fail with retry required if confidence or verification quality is insufficient.

Critical segments monitored:
- thigh_l, thigh_r
- tibia_l, tibia_r
- upper_arm_l, upper_arm_r
- forearm_l, forearm_r
- head

Common failure reasons shown in UI:
- missing functional confidence
- confidence below threshold
- insufficient verification movement
- excessive verification jitter

When failure occurs:
1. UI shows failed segments + reasons.
2. QC JSON auto-downloads once per unique failure state.
3. You can also manually export QC JSON/Markdown.
4. Re-run calibration after correcting motion quality.

---

## 5) Quick Troubleshooting by Failure Type

### Insufficient verification movement
- Increase movement amplitude during verification.
- Ensure each instrumented segment actually moves.

### Excessive verification jitter
- Slow down movement speed.
- Reduce abrupt reversals and impact-like motion.
- Check strap tightness and sensor stability.

### Low confidence
- Repeat functional step with cleaner isolation.
- Increase repetitions with consistent rhythm.
- Minimize compensatory movement from adjacent segments.

### Missing confidence
- Confirm assignment is correct for that segment.
- Confirm sensor is streaming throughout functional step.

---

## 6) Recommended Operator Defaults

For research sessions:
- Use **Research Strict**.
- Prefer complete side-specific functional steps (left/right).
- Export and archive QC artifact with session files.

For field or quick checks:
- Use **Operational Fast**.
- If quality is suspect, immediately rerun in Research Strict.

---

## 7) Session Checklist (30-second closeout)

- Calibration status reached `complete` (not `error`).
- Quality score is acceptable for your protocol.
- No unresolved strict gate failures.
- QC artifact saved when applicable.
- Proceed to recording.
