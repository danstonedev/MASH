# Multi-Sensor Calibration Architecture - Expert Recommendations

## Date: 2026-02-01
## Status: Pre-Multi-Sensor Expansion

---

## 1. Executive Summary

**Recommendation: Preservation-First, Pattern-Consistent Extension**

Do NOT merge or refactor the working head calibration code. Instead:
1. **Lock down** proven behavior with golden tests ✅ DONE
2. **Extend** using the SAME mathematical pattern for body segments
3. **Validate** each segment type before proceeding

---

## 2. What We've Proven Works

### Head/Cervical Calibration (Hardware Verified)
```
Pipeline: q_world = (q_sensor × mountingTare) × frameAlignment

Where:
  mountingTare = inv(startQuat) × inv(frameAlignment)
  frameAlignment = PCA-derived axis remapping (nod→pitch, shake→yaw)

At neutral pose: q_world = identity ✓
Motion tracking: ✓
```

### Pipeline Inspector (Hardware Verified)
- Direct VQF → Three.js visualization
- Identity transforms for raw sensor view
- Debugging capabilities preserved

### Golden Test Suite (15 tests)
- `goldenCalibration.test.ts` - LOCKED behavior specification
- Tests cover: neutral→identity, motion tracking, frame alignment, invariants

---

## 3. Research-Based Multi-Sensor Architecture

### 3.1 IMU Sensor Fusion Literature

Key papers informing this architecture:
- **Seel et al. (2014)** - IMU-based joint angle measurement
- **Madgwick (2010)** - Efficient orientation filter (AHRS)
- **Xsens MVN** - Commercial full-body motion capture system

### 3.2 Critical Requirements for Multi-Sensor

| Requirement | Solution |
|------------|----------|
| Shared world frame | All sensors agree on forward/up via heading alignment |
| Segment independence | Each sensor calibrates independently |
| Joint angle extraction | q_joint = inv(q_parent) × q_child |
| Drift correction | ZUPT at foot contact, joint constraints |

### 3.3 Hierarchical Calibration Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    CALIBRATION HIERARCHY                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   1. ROOT SEGMENT (Pelvis)                                      │
│      └── Define world forward/up                                │
│          calibrate(sensor_quat, target=standing_neutral)        │
│                                                                 │
│   2. SPINE CHAIN (Pelvis → Spine → Chest → Head)                │
│      └── Each inherits parent's world frame                     │
│          calibrate relative to parent                           │
│                                                                 │
│   3. LIMB CHAINS (Pelvis → Thigh → Shin → Foot)                 │
│      └── Same pattern, different targets per segment            │
│                                                                 │
│   4. HEAD (Special Case)                                        │
│      └── Uses PCA nod/shake for axis alignment                  │
│          Already working - DO NOT CHANGE                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Recommended Implementation Path

### Phase 1: Lock Current State (COMPLETED)
- [x] Create golden tests for head calibration
- [x] Document exact mathematical formulas
- [x] Run full test suite baseline (325 pass, 4 fail - VQF test issue)

### Phase 2: Body Segment Pattern (NEXT)
Apply the SAME two-step pattern to body segments:

```typescript
// Body calibration should use the SAME pattern as head:
function calibrateBodySegment(
  startQuat: Quaternion,        // Sensor quat at calibration pose
  targetOrientation: Quaternion, // Expected bone orientation (from anatomy)
  frameAlignment?: Quaternion    // Optional axis remapping (from PCA if needed)
): { mountingTare: Quaternion; frameAlignment: Quaternion } {
  
  const alignment = frameAlignment ?? new THREE.Quaternion();
  
  // SAME FORMULA AS HEAD:
  // mountingTare = inv(startQuat) × inv(alignment)
  const boresight = startQuat.clone().invert();
  const alignmentInv = alignment.clone().invert();
  
  // Key difference: body segments may want target ≠ identity
  // For now, use same pattern - test with hardware before adding complexity
  const mountingTare = boresight.multiply(alignmentInv);
  
  return { mountingTare, frameAlignment: alignment };
}
```

### Phase 3: Multi-Sensor Coordination
1. Add heading alignment step (all sensors face same direction)
2. Add constraint-based validation (joint limits)
3. Add ZUPT integration (foot contact detection)

### Phase 4: Runtime Corrections
- AutoCalEngine already exists
- Validate with hardware before enabling

---

## 5. What NOT To Do

### ❌ Do NOT Merge Systems
- Head calibration works because of specific two-step pipeline
- Body calibration uses different architecture (single-step)
- Merging them risks breaking both

### ❌ Do NOT Use Similarity Transform
```typescript
// WRONG - This swaps Y/Z axes!
const q_wrong = R.multiply(q_sensor).multiply(R.inverse());

// RIGHT - Preserves local frame axes
const q_correct = q_sensor.multiply(R);
```
This is documented in tests and must be preserved.

### ❌ Do NOT Change Working Code
- CervicalCalibrationFunctions.ts - FROZEN
- OrientationPipeline.ts (core transform logic) - FROZEN
- taringPipeline.ts (applyMountingTare, applyFrameAlignment) - FROZEN

---

## 6. Test Before Each Change

Before ANY modification:
1. Run: `npx vitest run src/tests/goldenCalibration.test.ts`
2. Run: `npx vitest run src/tests/headCalibrationIntegration.test.ts`
3. All must pass

After modification:
1. Run full suite: `npx vitest run`
2. If golden tests fail → REVERT
3. Hardware verification required for new segment types

---

## 7. Architecture Decision Record

### ADR-001: Two-Step Pipeline for Head Calibration
**Status:** Accepted, Hardware Verified
**Context:** Head requires nod/shake PCA to determine axis alignment
**Decision:** Use `(q_sensor × mountingTare) × frameAlignment` with pre-compensation
**Consequences:** Works perfectly, but requires understanding the math

### ADR-002: Body Calibration Architecture
**Status:** Under Review (not yet hardware tested)
**Context:** Body uses Gram-Schmidt single-step offset
**Question:** Should we migrate to two-step pattern for consistency?
**Recommendation:** Test current approach with hardware first

### ADR-003: Shared TareStore
**Status:** Accepted
**Context:** All segments write to same store
**Decision:** TareStore handles all segment types uniformly
**Note:** Head uses `frameAlignment` field; body may not need it

---

## 8. Files to Protect

### Read-Only (Proven Working)
```
src/calibration/CervicalCalibrationFunctions.ts  # Head calibration
src/calibration/HeadAlignment.ts                  # PCA axis detection
src/lib/math/OrientationPipeline.ts              # Core transform
src/calibration/taringPipeline.ts                # Tare application
```

### Golden Tests
```
src/tests/goldenCalibration.test.ts              # NEVER MODIFY
src/tests/headCalibrationIntegration.test.ts     # NEVER MODIFY  
```

### Safe to Modify
```
src/calibration/UnifiedCalibration.ts            # Body calibration
src/calibration/AutoCalEngine.ts                 # Runtime corrections
```

---

## 9. Next Steps Checklist

- [ ] Hardware test body calibration with single thigh sensor
- [ ] If works: Document pattern, add golden tests
- [ ] If fails: Apply head's two-step pattern
- [ ] Add second sensor (shin), test joint angle extraction
- [ ] Add pelvis root, test hierarchical propagation
- [ ] Add heading alignment (all sensors share forward direction)
- [ ] Full body test with 4+ sensors

---

## 10. Contact

Questions about this architecture?
- Review the golden tests first
- Check the ADRs above
- Verify with hardware before changing math
