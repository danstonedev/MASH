# MASH Calibration Strategy — Per-Joint/Segment Protocol

## Design Philosophy

**Goal**: Fast, intuitive, research-grade calibration that a user can complete in under 60 seconds for full body (15 sensors), or under 10 seconds for single sensor.

**Core insight**: Not every joint needs PCA functional calibration. The cervical PCA protocol works brilliantly for the head because it has 3-DOF motion with large ROM. But a knee is a 1-DOF hinge — PCA is overkill. Each joint type gets the **minimum calibration complexity that achieves accurate results**.

---

## The Three Calibration Methods

### Method 1: Static Pose (T-Pose Boresight)
- **Time**: ~2s (hold still)
- **Captures**: Gravity vector (tilt) + heading (yaw boresight) + gyro bias
- **Accuracy**: ±5° tilt, yaw = relative to body facing direction
- **Best for**: Segments with a clear anatomical neutral (pelvis, torso, thighs)

### Method 2: Functional Hinge (Single-Axis PCA)
- **Time**: ~5s (hold still + 3× flex/extend + hold still)
- **Captures**: Everything from Static Pose + functional rotation axis via PCA
- **Accuracy**: ±2° per axis
- **Best for**: Hinge joints (knee, elbow) — one dominant motion axis

### Method 3: Functional 2-Axis (Current Cervical Protocol)
- **Time**: ~12s (hold still + 3× nod + 3× shake + hold still)
- **Captures**: Everything from Static Pose + pitch axis + yaw axis via PCA + orthogonal frame
- **Accuracy**: ±1-2° per axis, full axis alignment
- **Best for**: 3-DOF joints with large ROM (head/cervical, possibly lumbar)

---

## Per-Segment Calibration Protocols

### Root — Pelvis (PELVIS)
| Property | Value |
|---|---|
| **Method** | Static Pose |
| **Joint** | pelvis_orientation (vs world) |
| **ROM** | Tilt ±30°, Rotation ±45° |
| **Instruction** | "Stand upright, feet shoulder-width apart, look straight ahead" |
| **Duration** | ~2s |
| **Captures** | Gravity → tilt alignment, Heading → forward direction, Gyro bias |
| **Heading anchor** | YES — self-adaptive (root of chain, most stable sensor) |

**Rationale**: Pelvis is the kinematic root. Static pose is sufficient because:
1. Gravity gives pitch/roll (anterior/posterior tilt + lateral tilt)
2. Heading established by assuming user faces forward at calibration
3. No functional axis needed — pelvis motion is tracked as absolute orientation vs world
4. As root sensor, it has the least motion → lowest drift → best heading stability
5. All child segments (torso, thighs) reference pelvis heading via coherence cascade

**Special**: Pelvis heading becomes the **global reference frame** for the entire body. If pelvis drifts, everything drifts. This is by design — the heading coherence system means children correct relative to pelvis, so absolute yaw is only as good as the root.

---

### Spine — Torso/Chest (CHEST)
| Property | Value |
|---|---|
| **Method** | Static Pose |
| **Joint** | lumbar (pelvis → torso) |
| **ROM** | Flex [-30°, 90°], Side-bend ±30°, Rotation ±45° |
| **Instruction** | "Stand upright with arms relaxed at sides" |
| **Duration** | ~2s |
| **Captures** | Gravity → tilt, Heading → boresight (will be coherence-corrected vs pelvis) |
| **Heading anchor** | YES — self-adaptive + pelvis coherence (lumbar rotation ±45°) |

**Rationale**: Static pose works because:
1. At T-pose, torso and pelvis are aligned → heading from static pose is sufficient
2. Lumbar rotation ROM is only ±45° → coherence with pelvis catches any drift beyond that
3. Gravity gives the thorax tilt which defines the flex/ext and side-bend zeros
4. No functional calibration needed — the lumbar joint angles are computed as torso-relative-to-pelvis

**Enhancement with functional (optional)**: For research-grade lumbar analysis, could add a "bend forward" motion to PCA-identify the sagittal flexion axis. But for most use cases, gravity alignment + static heading is sufficient.

---

### Spine — Upper Spine (SPINE_UPPER / T2)
| Property | Value |
|---|---|
| **Method** | Static Pose |
| **Joint** | thoracic (torso → spine_upper) |
| **ROM** | Flex [-40°, 60°], Side-bend ±30°, Rotation ±45° |
| **Instruction** | Same as torso — captured simultaneously |
| **Duration** | 0s additional (captured during T-pose) |
| **Heading anchor** | YES — coherence vs torso (thoracic rotation ±45°) |

**Rationale**: T2 sensor is optional (detailed spinal analysis). Static pose is sufficient:
1. At T-pose, T2 and torso (T7) are aligned
2. The thoracic joint between them has only ±45° rotation ROM
3. Heading coherence with torso keeps yaw bounded
4. Gravity gives the upper spine curvature reference

---

### Head (HEAD)
| Property | Value |
|---|---|
| **Method** | Functional 2-Axis (PCA) — CURRENT PROTOCOL |
| **Joint** | cervical (spine_upper/torso → head) |
| **ROM** | Flex [-60°, 70°], Side-bend ±45°, Rotation ±80° |
| **Instruction** | "Hold still → Nod YES ×3 → Shake NO ×3" |
| **Duration** | ~12s |
| **Captures** | Gyro bias, gravity, PCA pitch axis (nod), PCA yaw axis (shake), orthogonal frame alignment, heading boresight |
| **Heading anchor** | YES — self-adaptive + parent coherence when torso available (cervical rotation ±80°) |

**Rationale**: Full 2-axis PCA is justified because:
1. Head sensor mounting varies hugely (headband, hat, helmet, VR strap) → high mounting angle variation
2. Cervical spine has the largest rotation ROM (±80°) of any spinal joint → heading coherence alone isn't tight enough
3. Head is the most visible/important segment for avatar quality → worth the extra calibration time
4. The nod/shake protocol is intuitive and fast

**Already implemented and proven at 99% confidence.**

---

### Hip → Thigh (HIP_L / HIP_R)
| Property | Value |
|---|---|
| **Method** | Functional Hinge |
| **Joint** | hip_l / hip_r (pelvis → thigh) |
| **ROM** | Flex [-20°, 120°], Abd [-30°, 45°], Rotation [-45°, 45°] |
| **Instruction** | "Stand still → Swing leg forward/back ×3 → Stand still" |
| **Duration** | ~5s |
| **Captures** | Gyro bias, gravity, PCA sagittal flex/ext axis |
| **Heading anchor** | YES — pelvis coherence (hip rotation ±45°) |

**Rationale**: Single-axis functional calibration because:
1. Hip flexion/extension is the dominant movement (walking, running) — must be accurate
2. The thigh sensor orientation on the leg varies with how tightly the strap sits
3. PCA of the swing motion identifies the **true lateral axis** (flexion axis) precisely
4. With the flexion axis + gravity, we can reconstruct the full coordinate frame:
   - Gravity → longitudinal axis (down the thigh)
   - PCA → lateral axis (medial-lateral)
   - Cross product → anterior-posterior axis
5. Heading (rotation about femur long axis) is bounded by hip rotation ROM ±45° via pelvis coherence

**Math for hinge calibration**:
```
1. PCA on gyro during leg swings → flexionAxis (should roughly = lateral/X)
2. gravityAxis = normalize(accel) at rest (should roughly = longitudinal/Y pointing down)
3. anteriorAxis = cross(flexionAxis, gravityAxis) → forward/Z
4. Gram-Schmidt orthogonalize: Y' = gravityAxis, X' = cross(Y', anteriorAxis), Z' = cross(X', Y')
5. Build rotation matrix [X', Y', Z'] → axisAlignment quaternion
```

---

### Knee → Tibia (KNEE_L / KNEE_R)
| Property | Value |
|---|---|
| **Method** | Functional Hinge |
| **Joint** | knee_l / knee_r (thigh → tibia) |
| **ROM** | Flex [0°, 140°], Varus/Valgus ±10°, Rotation ±30° |
| **Instruction** | "Stand still → Bend knee ×3 → Stand still" |
| **Duration** | ~5s |
| **Captures** | Gyro bias, gravity, PCA flexion axis |
| **Heading anchor** | YES — thigh coherence (knee rotation ±30°) |

**Rationale**: Hinge calibration is ideal here because the knee **is** a hinge:
1. Knee flexion/extension accounts for >95% of knee motion in gait
2. The varus/valgus and rotation DOFs are very small (±10°, ±30°)
3. PCA of knee bends precisely identifies the flexion axis
4. Gravity gives the longitudinal axis down the tibia
5. Cross product gives the anterior axis
6. Heading coherence with thigh keeps tibial rotation bounded (±30°)

**Important**: Knee bends should be slow and controlled. Fast knee bends produce noisy PCA because the motion isn't purely in the sagittal plane during rapid deceleration.

---

### Ankle → Foot (FOOT_L / FOOT_R)
| Property | Value |
|---|---|
| **Method** | Static Pose |
| **Joint** | ankle_l / ankle_r (tibia → foot) |
| **ROM** | Dorsi/Plantar [-50°, 20°], Inversion/Eversion ±20°, Rotation ±20° |
| **Instruction** | "Stand still, feet flat on ground" |
| **Duration** | 0s additional (captured during T-pose) |
| **Heading anchor** | YES — tibia coherence (ankle rotation ±20°) |

**Rationale**: Static pose is sufficient because:
1. Foot sensor orientation when standing flat is highly predictable
2. Gravity gives pitch (dorsiflexion angle) and roll (inversion/eversion)
3. Heading is tightly bounded by ankle rotation ROM (±20°) via tibia coherence
4. Foot motion during walking is primarily dorsi/plantarflexion — well-captured by gravity alignment
5. Adding a functional step (ankle circles) wouldn't meaningfully improve accuracy for the overhead cost

**Special consideration**: The foot sensor mounting is typically on the dorsum (top of foot) or in the shoe tongue. At rest with foot flat, gravity alignment establishes a very consistent reference.

---

### Shoulder → Upper Arm (ARM_L / ARM_R)
| Property | Value |
|---|---|
| **Method** | Functional Hinge |
| **Joint** | shoulder_l / shoulder_r (torso → upper_arm) |
| **ROM** | Flex [-60°, 180°], Abd [-10°, 180°], Rotation [-90°, 90°] |
| **Instruction** | "Arms at sides → Raise arm forward/up ×3 → Arms at sides" |
| **Duration** | ~5s |
| **Captures** | Gyro bias, gravity, PCA flexion axis |
| **Heading anchor** | YES — torso coherence (shoulder rotation ±90°) |

**Rationale**: Hinge calibration for the dominant motion plane:
1. Shoulder flexion/extension (raising arm forward/back) produces the strongest, cleanest gyro signal
2. PCA identifies the lateral axis (flexion axis) — should roughly align with medial-lateral
3. With gravity (pointing down the arm in T-pose rest), we reconstruct the full frame
4. Shoulder rotation ROM is large (±90°) so coherence with torso is loose — making the functional axis calibration more important here
5. Could alternatively use abduction (raising arm sideways) — either works for PCA, but forward raise is more intuitive

**Alternative instruction**: "Arms at sides → Raise arm to the side and back down ×3" (abduction). Consider which motion the user finds more natural.

---

### Elbow → Forearm (FOREARM_L / FOREARM_R)
| Property | Value |
|---|---|
| **Method** | Functional Hinge |
| **Joint** | elbow_l / elbow_r (upper_arm → forearm) |
| **ROM** | Flex [0°, 150°], Varus/Valgus ±10°, Rotation [-90°, 90°] |
| **Instruction** | "Arm straight → Bend elbow ×3 → Arm straight" |
| **Duration** | ~5s |
| **Captures** | Gyro bias, gravity, PCA flexion axis |
| **Heading anchor** | YES — upper_arm coherence (elbow rotation ±90°) |

**Rationale**: The elbow is a hinge, just like the knee:
1. Elbow flexion/extension is the dominant motion
2. PCA of bicep curls gives an excellent flexion axis with high variance ratio
3. Pro/supination (±90°) is the secondary DOF — bounded by upper_arm coherence
4. Elbow varus/valgus is minimal (±10°)
5. Gravity gives the longitudinal axis when arm is hanging straight at rest

**Note**: Forearm pronation/supination is poorly captured by a single forearm sensor. The 90° rotation ROM is large and hard to constrain biomechanically. For research-grade pro/supination analysis, consider a paired forearm+hand sensor approach where the relative twist between them captures pronation directly.

---

### Wrist → Hand (HAND_L / HAND_R)
| Property | Value |
|---|---|
| **Method** | Static Pose |
| **Joint** | wrist_l / wrist_r (forearm → hand) |
| **ROM** | Flex ±80°, Radial/Ulnar ±25-30°, Rotation ±90° |
| **Instruction** | "Hands flat, palms facing body" (T-pose position) |
| **Duration** | 0s additional (captured during T-pose) |
| **Heading anchor** | YES — forearm coherence (wrist rotation ±90°) |

**Rationale**: Static pose for hands because:
1. Hand sensor mounting is fairly constrained (back of hand, glove)
2. Gravity gives wrist flexion/extension and radial/ulnar deviation references
3. The wrist rotation ROM (±90°) is coupled with forearm pro/supination — hard to separate with a single sensor
4. Functional calibration (waving) wouldn't add much value given the coupled rotation
5. For most sports/clinical applications, wrist tracking is secondary to arm tracking

---

## Unified Calibration Sequence

### Full Body (15 sensors) — Target: 45-60 seconds

```
PHASE 1: T-POSE STATIC CAPTURE (all sensors simultaneously)
Duration: 3 seconds
Instruction: "Stand in T-pose. Arms straight out, palms forward, look straight ahead."
Captures for ALL sensors:
  ✓ Gyro bias (averaged over 3s = 600 samples at 200Hz → excellent √600 = 24.5× noise reduction)
  ✓ Gravity alignment (tilt reference)
  ✓ Heading boresight (yaw zero = body forward)

Sensors DONE after Phase 1: pelvis, torso, spine_upper, foot_l, foot_r, hand_l, hand_r
(7 of 15 — all static-only sensors)

PHASE 2: LOWER BODY FUNCTIONAL (sequential, one leg at a time)
Duration: ~20 seconds

Step 2a: LEFT LEG (10s)
  "Swing left leg forward and back ×3"     → PCA for hip_l flexion axis
  "Bend left knee ×3"                       → PCA for knee_l flexion axis

Step 2b: RIGHT LEG (10s)
  "Swing right leg forward and back ×3"     → PCA for hip_r flexion axis
  "Bend right knee ×3"                      → PCA for knee_r flexion axis

Sensors DONE: thigh_l, tibia_l, thigh_r, tibia_r  (11 of 15)

PHASE 3: UPPER BODY FUNCTIONAL (sequential, one arm at a time)
Duration: ~15 seconds

Step 3a: LEFT ARM (7s)
  "Raise left arm forward and back ×3"      → PCA for shoulder_l flexion axis
  "Bend left elbow ×3"                      → PCA for elbow_l flexion axis

Step 3b: RIGHT ARM (7s)
  "Raise right arm forward and back ×3"     → PCA for shoulder_r flexion axis
  "Bend right elbow ×3"                     → PCA for elbow_r flexion axis

Sensors DONE: upper_arm_l, forearm_l, upper_arm_r, forearm_r  (15 of 15... except head)

PHASE 4: HEAD FUNCTIONAL (existing cervical protocol)
Duration: ~12 seconds

  "Hold still → Nod YES ×3 → Shake NO ×3"

Sensor DONE: head  (all 15 complete)
```

**Total**: ~50 seconds for 15 sensors. User performs 10 distinct motions.

### Lower Body Only (7 sensors) — Target: 25 seconds

```
Phase 1: T-pose static (3s) → pelvis, foot_l, foot_r done
Phase 2: Left leg swings + bends (10s) → thigh_l, tibia_l done
Phase 3: Right leg swings + bends (10s) → thigh_r, tibia_r done
```

### Single Head Sensor — Target: 12 seconds (current protocol, unchanged)

---

## Calibration Order Optimization

**Why this order matters**:

1. **Static first**: All sensors get bias + gravity + heading simultaneously in one 3-second hold. No wasted time.

2. **Root before leaves**: Pelvis calibrates first (in Phase 1), so when thighs calibrate in Phase 2, heading coherence with pelvis is already active. Same for torso → arms.

3. **Bilateral sequential**: Left leg, then right leg (not interleaved) because the user needs to shift weight. Switching sides frequently is confusing and slow.

4. **Head last**: Cervical protocol requires standing still for initial hold. If you calibrate head first and then legs, the leg swings would add motion artifacts. Head last means everything is stable by the time we do the sensitive PCA.

---

## Technical Implementation Architecture

### Generalized Functional Calibration Engine

Instead of a cervical-specific calibration class, create a **generic segment calibration engine**:

```typescript
interface SegmentCalibrationConfig {
  segmentId: string;
  method: 'static' | 'hinge' | 'two_axis';

  // For hinge method:
  hingeMotionInstruction?: string;   // "Swing leg forward ×3"
  hingeAxisName?: string;            // "flexion"

  // For two_axis method:
  primaryMotionInstruction?: string; // "Nod YES ×3"
  primaryAxisName?: string;          // "pitch"
  secondaryMotionInstruction?: string; // "Shake NO ×3"
  secondaryAxisName?: string;        // "yaw"

  // Sign disambiguation
  // For hinge: functional axis should point in this direction
  expectedAxisDirection?: 'right' | 'up' | 'forward';
  // Use gravity or start quaternion for disambiguation
  disambiguationMethod?: 'gravity' | 'quaternion';
}
```

### Hinge Calibration Math (SARA + PCA Fallback)

Hinge joints now use a **dual-strategy approach**:

1. **SARA (Symmetrical Axis of Rotation Approach)** — Ehrig et al., 2007
   - Uses BOTH parent + child sensor quaternions during hinge motion
   - Cancels soft-tissue artifacts automatically (STA moves both sensors similarly)
   - Doesn't require the parent segment to be stationary
   - Produces the axis in BOTH sensor frames simultaneously
   - **Preferred** when both sensors are available

2. **Single-sensor PCA (fallback)**
   - Uses only child-sensor gyro angular velocity
   - Still effective for clean, controlled movements
   - Used when parent sensor data is unavailable

#### SARA Mathematical Foundation

```
For a hinge joint, there exists unit vectors v_p (parent frame) and v_c (child frame)
such that at every instant t:   R_p(t) · v_p = R_c(t) · v_c

Accumulate M = Σ R_p(t)ᵀ · R_c(t)  =  Σ R_rel(t)
(equivalent to: q_rel(t) = conj(q_parent) × q_child for quaternions)

Then:
  - Joint axis in CHILD frame  = largest eigenvector of MᵀM  (power iteration)
  - Joint axis in PARENT frame = M · v_child / ‖M · v_child‖
  - Confidence = σ_max / N  (1.0 = pure hinge, <<1 = ball joint)
```

#### Implementation Files

- `src/calibration/sara.ts` — Core SARA algorithm + IncrementalSARA class
- `src/calibration/hingeCalibration.ts` — Hinge calibration engine (SARA + PCA + Gram-Schmidt)

```typescript
import { computeSARA, IncrementalSARA } from './sara';
import { calibrateHingeJoint, type HingeCalibrationInput } from './hingeCalibration';

// Batch mode (offline / end of calibration step):
const result = calibrateHingeJoint({
  jointId: 'knee_l',
  childGyroSamples: gyroData,       // from child sensor
  childGravity: accelAtRest,        // from child sensor at T-pose
  parentQuaternions: parentQuats,   // if parent sensor available → SARA
  childQuaternions: childQuats,     // if parent sensor available → SARA
  side: 'left',
});
// result.method === 'sara' or 'single-pca'
// result.axisAlignment → sensor-to-bone quaternion

// Real-time mode (during calibration, for confidence feedback):
const inc = new IncrementalSARA();
onEachFrame(() => {
  inc.addSample(parentQuat, childQuat);
  const interim = inc.compute(20); // min 20 samples
  if (interim) updateUI(`Confidence: ${(interim.confidence * 100).toFixed(0)}%`);
});
```

### Batch Static Calibration (new — all static sensors in one pass)

```typescript
function calibrateStaticPose(
  sensorIds: string[],
  duration: number = 3000  // 3 seconds
): Promise<Map<string, CalibrationResult>> {

  // 1. Accumulate all sensors simultaneously for `duration` ms
  // 2. For each sensor:
  //    a. Average gyro → bias
  //    b. Average accel → gravity vector
  //    c. Current VQF quaternion → heading boresight
  //    d. Compute: headingTare = extractYaw(quaternion)
  //    e. Compute: mountingTare = identity (static only)
  //    f. Store in TareStore

  // This replaces per-sensor stationary_start for all static-method sensors
}
```

### Heading Coherence Seeding

After all calibration is complete:
```typescript
// Set VQF heading anchors, root first
for (const segment of calibrationOrder) {
  const sensorId = getSensorForSegment(segment);
  const vqf = filterRegistry.get(sensorId);
  vqf?.setHeadingAnchor(vqf.getQuaternion());
}
// Coherence cascade is automatic via OrientationProcessor
```

---

## Quality Metrics Per Method

| Method | Confidence Metric | Excellent | Good | Fair | Poor |
|---|---|---|---|---|---|
| Static Pose | Gyro variance during hold | < 0.001 | < 0.005 | < 0.01 | > 0.01 |
| SARA Hinge | σ_max / N | > 0.95 | > 0.85 | > 0.70 | < 0.70 |
| Functional Hinge (PCA) | PCA variance ratio (λ₁/trace) | > 0.90 | > 0.80 | > 0.65 | < 0.65 |
| Functional 2-Axis | √(pitch_conf × yaw_conf) | > 0.90 | > 0.80 | > 0.65 | < 0.65 |

---

## Summary Table

| Segment | Method | Time | Instruction | Joint | Key Axis |
|---|---|---|---|---|---|
| pelvis | Static | 3s (shared) | T-pose hold | pelvis_orientation | Gravity + heading |
| torso | Static | 3s (shared) | T-pose hold | lumbar | Gravity + heading |
| spine_upper | Static | 3s (shared) | T-pose hold | thoracic | Gravity + heading |
| head | 2-Axis PCA | 12s | Nod + Shake | cervical | Pitch PCA + Yaw PCA |
| thigh_l/r | SARA / PCA | 5s each | Leg swing ×3 | hip_l/r | SARA axis + gravity |
| tibia_l/r | SARA / PCA | 5s each | Knee bend ×3 | knee_l/r | SARA axis + gravity |
| foot_l/r | Static | 3s (shared) | T-pose hold | ankle_l/r | Gravity + heading |
| upper_arm_l/r | SARA / PCA | 5s each | Arm raise ×3 | shoulder_l/r | SARA axis + gravity |
| forearm_l/r | SARA / PCA | 5s each | Elbow bend ×3 | elbow_l/r | SARA axis + gravity |
| hand_l/r | Static | 3s (shared) | T-pose hold | wrist_l/r | Gravity + heading |

**Static sensors** (7): calibrated simultaneously in one 3-second T-pose hold.
**Hinge sensors** (6): ~5s each, done in bilateral pairs.
**2-Axis sensors** (1): head only, 12s.
**Theoretical minimum** for full body: 3 + 10 + 10 + 7 + 7 + 12 = **49 seconds**.
