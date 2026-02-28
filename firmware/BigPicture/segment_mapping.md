# Segment Mapping — IMU to Skeleton

## Purpose
Define the mapping from physical IMU sensors to body segments and Mixamo skeleton bones.

---

## V1 Segment Inventory

The V1 suit supports **12 body segments** with direct IMU sensing:

| # | Segment ID | Body Region | Mixamo Bone | Node |
|---|------------|-------------|-------------|------|
| 1 | `pelvis` | Hip/Sacrum | mixamorigHips | B |
| 2 | `torso` | Sternum/T8 | mixamorigSpine2 | A |
| 3 | `thigh_l` | Left Thigh | mixamorigLeftUpLeg | B |
| 4 | `thigh_r` | Right Thigh | mixamorigRightUpLeg | B |
| 5 | `shank_l` | Left Shin | mixamorigLeftLeg | B |
| 6 | `shank_r` | Right Shin | mixamorigRightLeg | B |
| 7 | `foot_l` | Left Foot | mixamorigLeftFoot | C |
| 8 | `foot_r` | Right Foot | mixamorigRightFoot | D |
| 9 | `upper_arm_l` | Left Upper Arm | mixamorigLeftArm | A |
| 10 | `upper_arm_r` | Right Upper Arm | mixamorigRightArm | A |
| 11 | `forearm_l` | Left Forearm | mixamorigLeftForeArm | A |
| 12 | `forearm_r` | Right Forearm | mixamorigRightForeArm | A |

---

## Segments Without Direct IMU (Derived)

These segments are inferred from parent/child relationships or IK:

| Segment ID | Mixamo Bone | Derivation Method |
|------------|-------------|-------------------|
| `head` | mixamorigHead | Future: IMU or derived from torso |
| `hand_l` | mixamorigLeftHand | Future: wrist IMU |
| `hand_r` | mixamorigRightHand | Future: wrist IMU |
| `spine` | mixamorigSpine | Interpolated pelvis ↔ torso |
| `spine1` | mixamorigSpine1 | Interpolated pelvis ↔ torso |
| `neck` | mixamorigNeck | Interpolated torso ↔ head |

---

## Web App Segment Registry

From `src/biomech/segmentRegistry.ts`:

```typescript
export type SegmentId = 
    | 'pelvis' | 'torso' | 'head'
    | 'thigh_l' | 'shank_l' | 'foot_l'
    | 'thigh_r' | 'shank_r' | 'foot_r'
    | 'upper_arm_l' | 'forearm_l' | 'hand_l'
    | 'upper_arm_r' | 'forearm_r' | 'hand_r';
```

---

## Bone Mapping Implementation

From `src/biomech/boneMapping.ts`:

```typescript
export const SEGMENT_TO_BONE: Record<SegmentId, string> = {
    // Core
    pelvis: 'mixamorigHips',
    torso: 'mixamorigSpine2',
    head: 'mixamorigHead',

    // Left Leg
    thigh_l: 'mixamorigLeftUpLeg',
    shank_l: 'mixamorigLeftLeg',
    foot_l: 'mixamorigLeftFoot',

    // Right Leg
    thigh_r: 'mixamorigRightUpLeg',
    shank_r: 'mixamorigRightLeg',
    foot_r: 'mixamorigRightFoot',

    // Left Arm
    upper_arm_l: 'mixamorigLeftArm',
    forearm_l: 'mixamorigLeftForeArm',
    hand_l: 'mixamorigLeftHand',

    // Right Arm
    upper_arm_r: 'mixamorigRightArm',
    forearm_r: 'mixamorigRightForeArm',
    hand_r: 'mixamorigRightHand',
};
```

---

## Auto-Assignment Logic

The web app auto-assigns sensors based on device name:

```typescript
// From useDeviceRegistry.ts
if (realName.startsWith("IMU-")) {
    const suffix = realName.replace("IMU-", "").toLowerCase();
    const mapping = {
        'pelvis': 'pelvis',
        'torso': 'torso',
        'leftthigh': 'thigh_l',
        'rightthigh': 'thigh_r',
        // ... etc
    };
    autoSegment = mapping[suffix];
}
```

**Naming Convention**: `IMU-{SegmentName}` (case insensitive)

Examples:
- `IMU-Pelvis` → pelvis
- `IMU-LeftThigh` → thigh_l
- `IMU-RightFoot` → foot_r

---

## Sensor Placement Guidelines

### Torso Placement Decision: Sternum vs C7

| Location | Pros | Cons |
|----------|------|------|
| **Sternum (T8)** | Better for forward lean detection, less hair interference | Can shift during arm movement |
| **C7 (Neck)** | Stable attachment point | Hair/clothing interference, less trunk info |

**Recommendation**: Sternum for skating (forward lean is critical metric)

### General Placement Rules

1. **Align X-axis forward** (direction of travel)
2. **Z-axis up** (perpendicular to skin)
3. **Secure with elastic strap** to minimize movement
4. **Place on flat surface** of bone when possible
5. **Avoid muscle bellies** (they deform)

---

## Coordinate Systems

### IMU Frame (ICM20649)
- X: Right (when worn)
- Y: Forward
- Z: Up

### Three.js World Frame
- X: Right
- Y: Up
- Z: Forward (towards camera)

### Conversion
```typescript
// IMU [w,x,y,z] → Three.js Quaternion(x,y,z,w)
const threeQuat = new THREE.Quaternion(x, z, -y, w);
```
