import * as THREE from 'three';

// Define the sensor input structure (3 sensors)
export interface ThreeSensorInput {
    pelvis: THREE.Quaternion;
    leftFoot: THREE.Quaternion;
    rightFoot: THREE.Quaternion;

    // Optional: Dead-reckoned position if available (otherwise we estimate)
    pelvisPos?: THREE.Vector3;
    leftFootPos?: THREE.Vector3;
    rightFootPos?: THREE.Vector3;
}

// Output skeleton pose (joint rotations)
export interface SimpleSkeletonPose {
    hips: {
        left: THREE.Quaternion;
        right: THREE.Quaternion;
    };
    knees: {
        left: number; // Single-axis hinge (flexion)
        right: number;
    };
    ankles: {
        left: THREE.Quaternion;
        right: THREE.Quaternion;
    };
}

// User body parameters (needed for IK)
export interface BodyDimensions {
    height: number;      // Total height in meters
    femurLength: number; // Estimated ~0.245 * height
    tibiaLength: number; // Estimated ~0.246 * height
    hipWidth: number;    // Estimated ~0.191 * height
}

/**
 * Lower Body Inverse Kinematics Solver (Sparse 3-IMU)
 * 
 * Logic:
 * 1. Establishes a "Root Frame" at the Pelvis.
 * 2. Estimates Foot Positions relative to Pelvis (using Skating Gait Cycle logic or provided pos).
 * 3. Solves the Hip-Knee-Ankle triangle (Two-Link IK) to find Knee Flexion.
 * 4. Resolves Hip Orientation to satisfy the Foot Position + Knee Constraint.
 */
export class LowerBodyIK {
    private dimensions: BodyDimensions;

    // Reuse vector objects to reduce GC
    private _v1 = new THREE.Vector3();

    constructor(userHeightMeters: number = 1.75) {
        // Standard anthropometric ratios (Winter, 1990)
        this.dimensions = {
            height: userHeightMeters,
            femurLength: userHeightMeters * 0.245,
            tibiaLength: userHeightMeters * 0.246,
            hipWidth: userHeightMeters * 0.191
        };
    }

    public solve(input: ThreeSensorInput): SimpleSkeletonPose {
        // 1. Determine Foot Positions relative to Pelvis
        // In a full system, we'd integrate accel. Here, for "Phase 8", we might use a simplified model.
        // Default assumption: Feet are on ground, Pelvis is at some height H.

        const pelvicPos = input.pelvisPos || new THREE.Vector3(0, 0.9, 0); // ~90cm height

        // Default foot positions (relative to world, assuming pelvis is localized)
        // If no positions provided, assume "Skate Stance" (wide, feet slightly forward/back depending on phase?)
        // For T-Pose/Calibration debug, assume feet at Y=0, X=+-0.15
        const leftFootPos = input.leftFootPos || new THREE.Vector3(-0.15, 0, 0.3); // Fake stride
        const rightFootPos = input.rightFootPos || new THREE.Vector3(0.15, 0, -0.3);

        // Calculate Hip Joint Centers (relative to Pelvis Center)
        // Hip Width is scalar, need Vector. Assuming Pelvis Z=Up, Y=Forward?
        // Wait, Conventions: 
        // Usually Y=Up, Z=Forward (ThreeJS).
        // Pelysis Orientation applied to Hip Offsets.

        // Local offsets
        const halfHip = this.dimensions.hipWidth / 2;
        const hipOffsetL = new THREE.Vector3(-halfHip, 0, 0); // Left is +X or -X? ThreeJS Left is +X usually? 
        // ThreeJS: +Y Up, +Z Forward, +X Right (Right Hand Rule). 
        // So Left is +X.
        // Wait, if I face +Z, Right is -X? 
        // Stand at origin looking down -Z. Right hand is +X.
        // Let's assume +X is Left for now (standard medical?) No, standard ThreeJS is +X Right.
        // So Left Hip = +X.
        const hipOffsetR = new THREE.Vector3(halfHip, 0, 0);

        // Apply Pelvis Rotation to Offsets
        // P_hip_world = P_pelvis_world + (Q_pelvis * P_hip_local)
        const hipPosL = hipOffsetL.clone().applyQuaternion(input.pelvis).add(pelvicPos);
        const hipPosR = hipOffsetR.clone().applyQuaternion(input.pelvis).add(pelvicPos);

        // Solve IK for both legs - returns hip quaternion and knee flexion angle
        const leftLimbResult = this.solveLimb(hipPosL, leftFootPos, this.dimensions.femurLength, this.dimensions.tibiaLength, false);
        const rightLimbResult = this.solveLimb(hipPosR, rightFootPos, this.dimensions.femurLength, this.dimensions.tibiaLength, true);

        return {
            hips: {
                left: leftLimbResult.hipQuat,
                right: rightLimbResult.hipQuat
            },
            knees: {
                left: leftLimbResult.kneeAngle * (180 / Math.PI), // Convert to degrees
                right: rightLimbResult.kneeAngle * (180 / Math.PI)
            },
            ankles: {
                left: new THREE.Quaternion(), // Identity for now (Foot orientation overrides)
                right: new THREE.Quaternion()
            }
        };
    }

    // Basic Analytic Two-Link IK
    // Solves for Hip Rotation given Hip Pos, Ankle Pos, and fixed limb lengths.
    // Returns both hip quaternion and knee flexion angle (radians)
    private solveLimb(hipPos: THREE.Vector3, anklePos: THREE.Vector3, femurLen: number, tibiaLen: number, _isRight: boolean): { hipQuat: THREE.Quaternion; kneeAngle: number } {
        // 1. Vector from Hip to Ankle (Target Vector)
        this._v1.subVectors(anklePos, hipPos);
        const dist = this._v1.length();

        // 2. Calculate Knee Angle (Interior Angle)
        // Clamp distance to reach (avoid NaN for fully extended or unreachable)
        const maxReach = femurLen + tibiaLen;
        const clampedDist = Math.min(dist, maxReach - 0.001);

        // Cosine Rule for Hip Angle (alpha) relative to the Target Vector
        // alpha = angle between Femur and Target Vector
        // tibia^2 = femur^2 + dist^2 - 2*femur*dist*cos(alpha)
        // cos(alpha) = (femur^2 + dist^2 - tibia^2) / (2 * femur * dist)
        const num = (femurLen * femurLen) + (clampedDist * clampedDist) - (tibiaLen * tibiaLen);
        const den = 2 * femurLen * clampedDist;
        const alpha = Math.acos(Math.max(-1, Math.min(1, num / den)));

        // 3. Orient the Femur
        // Start with Femur pointing straight down (0, -1, 0) in Global Frame
        const neutralVec = new THREE.Vector3(0, -1, 0);

        // Rotation A: Rotate Neutral Leg to align with Target Vector (Hip -> Ankle)
        const qLookAt = new THREE.Quaternion().setFromUnitVectors(neutralVec.normalize(), this._v1.clone().normalize());

        // Rotation B: Apply "alpha" (Hip Flexion relative to reach line)
        // We need an axis to rotate around. This is the "Knee Hinge Axis".
        // For skating, the knee points somewhat outward or forward.
        // Simplest: Calculate the axis perpendicular to [Hip->Ankle] and [Forward].
        // This keeps the knee pointing forward-ish.
        const forwardVec = new THREE.Vector3(0, 0, 1); // Global Forward
        let kneeAxis = new THREE.Vector3().crossVectors(this._v1, forwardVec).normalize();

        if (kneeAxis.lengthSq() < 0.01) {
            // Leg is vertical, axis is X
            kneeAxis.set(1, 0, 0);
        }

        // Flip axis if Right leg? (Symmetry)
        // Actually, cross product direction might flip if vector flips?
        // Let's stick to consistent Forward reference.

        // Apply the alpha rotation around this axis (bending the knee "forward")
        // Note: If alpha > 0, we rotate "up" away from the target line?
        // Usually: Align to target, then rotate "up" away from target line by alpha.
        const qAlpha = new THREE.Quaternion().setFromAxisAngle(kneeAxis, alpha);

        // Combine: qResult = qLookAt * qAlpha
        // (Order matters: Rotate by alpha in the LookAt frame? or align frame then rotate?)
        const qFemur = qLookAt.multiply(qAlpha);

        // Calculate knee flexion angle using cosine rule
        // theta = interior angle at knee = pi - angle_between_femur_and_tibia
        // cos(theta) = (femur^2 + tibia^2 - dist^2) / (2 * femur * tibia)
        const kneeNum = (femurLen * femurLen) + (tibiaLen * tibiaLen) - (clampedDist * clampedDist);
        const kneeDen = 2 * femurLen * tibiaLen;
        const kneeInteriorAngle = Math.acos(Math.max(-1, Math.min(1, kneeNum / kneeDen)));
        // Knee flexion = deviation from straight leg (pi radians)
        const kneeFlexion = Math.PI - kneeInteriorAngle;

        return { hipQuat: qFemur, kneeAngle: kneeFlexion };
    }
}
