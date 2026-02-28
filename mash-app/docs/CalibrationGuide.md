# IMU Connect Calibration Guide

## Overview

Calibration establishes the mathematical relationship between sensor orientation and bone orientation. This is **required** for accurate motion capture. Three calibration steps ensure PhD-level accuracy.

---

## Pre-Calibration Checklist

- [ ] All sensors powered on and connected
- [ ] Sensors securely attached (won't move during calibration)
- [ ] User ready to hold still poses
- [ ] Clear space for movement calibration

---

## Step 1: Sensor Bias Calibration (10 seconds)

**Purpose:** Removes gyroscope bias (drift when stationary)

### Procedure:
1. Place all sensors on a **flat, stable surface**
2. Ensure no movement or vibration
3. Press **"Calibrate Sensors"**
4. Wait for 10-second countdown

### Success Indicators:
- ✅ "Bias calibration complete"
- ✅ All sensors show green status

### Troubleshooting:
| Issue | Solution |
|-------|----------|
| "Motion detected" warning | Place sensors on more stable surface |
| Calibration times out | Check sensor connections |
| High drift after calibration | Recalibrate when sensor is at room temperature |

---

## Step 2: T-Pose Calibration (Mounting Tare)

**Purpose:** Aligns sensor frames with bone frames

### Procedure:
1. Stand in **T-Pose**:
   - Arms horizontal, palms facing down
   - Feet shoulder-width apart
   - Legs straight
   - Look straight ahead (this sets your "forward" direction)

2. Hold perfectly still for 3 seconds
3. Press **"Capture T-Pose"**

### Success Indicators:
- ✅ Avatar aligns to your pose
- ✅ Raising your arm moves the avatar's arm correctly
- ✅ All limbs track in the correct direction

### Troubleshooting:
| Issue | Solution |
|-------|----------|
| Avatar facing wrong way | Repeat T-Pose while facing camera |
| Limbs swapped (left/right) | Check sensor-to-segment assignment |
| Limbs rotated | Sensor may have slipped; re-attach and recalibrate |

---

## Step 3: Functional Calibration (Optional but Recommended)

**Purpose:** Mathematically determines joint hinge axis from motion

This step is especially important when sensors cannot be perfectly aligned with bones (e.g., on curved muscle surfaces).

### Procedure:
1. From standing position
2. Slowly flex the target joint (e.g., knee) to ~90°
3. Return to straight
4. Repeat 5 times at steady pace
5. Press **"Capture Functional Axis"**

### Motion Requirements:
- **Speed:** 0.5+ rad/s angular velocity
- **Duration:** 5-10 cycles
- **Isolation:** Keep other joints still

### Success Indicators:
- ✅ "Quality: Excellent (>85%)" - Perfect
- ✅ "Quality: Good (70-85%)" - Acceptable
- ⚠️ "Quality: Acceptable (50-70%)" - Try again with more isolated motion
- ❌ "Quality: Poor (<50%)" - Too much multi-axis motion

### Troubleshooting:
| Issue | Solution |
|-------|----------|
| "Not enough active samples" | Swing joint faster |
| Low quality score | Isolate the joint; don't move other body parts |
| Wrong axis detected | Verify correct sensor is selected |

---

## Quality Verification

After calibration, verify with these checks:

### Level 1: Sensor Check
> "If I tilt the chip, does the virtual bone tilt?"

Rotate each sensor and verify the corresponding bone moves correctly.

### Level 2: Alignment Check
> "In T-Pose, are all bones aligned to the grid?"

Stand in T-Pose and verify bones are aligned with world axes.

### Level 3: Isolation Check
> "If I spin around, does the knee angle stay constant?"

Spin your whole body while keeping knee locked straight. Knee joint angle should stay near 0°.

### Level 4: Range Check
> "Can I flex my knee past 120° without angle flipping?"

Test full range of motion; values should be continuous, not jumping.

---

## When to Recalibrate

| Event | Recalibrate? |
|-------|--------------|
| Sensor falls off | Yes (Steps 2-3) |
| Sensor battery swapped | Yes (Steps 1-3) |
| New session (same sensors) | Step 2 only |
| System restarted | Steps 1-3 |
| Visible drift in angles | Step 1 (bias) |
| Joint angles seem wrong | Step 3 (functional) |

---

## Advanced: Understanding the Taring Hierarchy

IMU Connect uses a 3-level taring (calibration) hierarchy:

```
Raw Sensor → [Level 1: Mounting] → Bone → [Level 2: Heading] → World → [Level 3: Joint] → Clinical
```

| Level | Name | What It Fixes |
|-------|------|---------------|
| 1 | Mounting Tare | Sensor taped on crooked |
| 2 | Heading Tare | User facing any direction |
| 3 | Joint Tare | User can't reach anatomical zero |

---

## Support

If calibration repeatedly fails:
1. Check [Limitations](./Limitations.md) for known issues
2. Review sensor placement photos
3. Contact support with calibration log
