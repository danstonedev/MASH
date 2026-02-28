/**
 * Anatomical Constraints Module
 * 
 * Enforces biomechanically valid joint limits based on ISB standards.
 * Uses "soft" constraints to gradually correct drift without sudden snapping.
 */
import * as THREE from 'three';

// ============================================================================
// TYPES
// ============================================================================

export interface JointLimit {
    /** Minimum angle in radians */
    min: number;
    /** Maximum angle in radians */
    max: number;
    /** Rotation axis ('x' | 'y' | 'z') */
    axis: 'x' | 'y' | 'z';
    /** Optional: Name for debugging */
    name?: string;
}

export interface ConstraintResult {
    /** Constrained Euler angles */
    euler: THREE.Euler;
    /** Whether any constraint was violated */
    wasConstrained: boolean;
    /** Details of violations for debugging */
    violations: {
        axis: string;
        original: number;
        constrained: number;
        limit: 'min' | 'max';
    }[];
}

// ============================================================================
// ISB-BASED JOINT LIMITS (radians)
// Based on Wu et al. 2002, 2005 and clinical references
// ============================================================================

/**
 * Joint range of motion limits based on ISB standards and clinical data.
 * 
 * Convention (Three.js / ISB aligned):
 * - X axis: Flexion/Extension (sagittal plane)
 * - Y axis: Internal/External Rotation (transverse plane)
 * - Z axis: Abduction/Adduction (frontal plane)
 * 
 * Note: These are typical healthy adult ROMs. May need adjustment for
 * elderly, pediatric, or pathological populations.
 */
export const JOINT_LIMITS: Record<string, JointLimit[]> = {
    // ==========================================================================
    // LOWER EXTREMITY
    // ==========================================================================

    // Hip - highly mobile ball-and-socket joint
    'thigh_l': [
        { axis: 'x', min: -0.35, max: 2.09, name: 'Hip Flexion/Extension' },      // ~-20° to 120°
        { axis: 'y', min: -0.79, max: 0.79, name: 'Hip Int/Ext Rotation' },       // ~±45°
        { axis: 'z', min: -0.79, max: 0.52, name: 'Hip Add/Abduction' },          // ~-45° to 30°
    ],
    'thigh_r': [
        { axis: 'x', min: -0.35, max: 2.09, name: 'Hip Flexion/Extension' },
        { axis: 'y', min: -0.79, max: 0.79, name: 'Hip Int/Ext Rotation' },
        { axis: 'z', min: -0.52, max: 0.79, name: 'Hip Add/Abduction' },          // Mirrored
    ],

    // Knee - primarily hinge joint
    'tibia_l': [
        { axis: 'x', min: -0.09, max: 2.44, name: 'Knee Flexion' },               // ~-5° to 140°
        { axis: 'y', min: -0.26, max: 0.26, name: 'Knee Rotation (small)' },      // ~±15° (when flexed)
        { axis: 'z', min: -0.09, max: 0.09, name: 'Knee Varus/Valgus (minimal)' }, // ~±5°
    ],
    'tibia_r': [
        { axis: 'x', min: -0.09, max: 2.44, name: 'Knee Flexion' },
        { axis: 'y', min: -0.26, max: 0.26, name: 'Knee Rotation' },
        { axis: 'z', min: -0.09, max: 0.09, name: 'Knee Varus/Valgus' },
    ],

    // Ankle - talocrural joint
    'foot_l': [
        { axis: 'x', min: -0.79, max: 0.44, name: 'Ankle Plantar/Dorsiflexion' }, // ~-45° to 25°
        { axis: 'y', min: -0.35, max: 0.35, name: 'Ankle Rotation' },             // ~±20°
        { axis: 'z', min: -0.52, max: 0.35, name: 'Ankle Inv/Eversion' },         // ~-30° to 20°
    ],
    'foot_r': [
        { axis: 'x', min: -0.79, max: 0.44, name: 'Ankle Plantar/Dorsiflexion' },
        { axis: 'y', min: -0.35, max: 0.35, name: 'Ankle Rotation' },
        { axis: 'z', min: -0.35, max: 0.52, name: 'Ankle Inv/Eversion' },         // Mirrored
    ],

    // ==========================================================================
    // UPPER EXTREMITY
    // ==========================================================================

    // Shoulder - most mobile joint
    'upper_arm_l': [
        { axis: 'x', min: -1.05, max: 3.14, name: 'Shoulder Flex/Extension' },    // ~-60° to 180°
        { axis: 'y', min: -1.57, max: 1.57, name: 'Shoulder Rotation' },          // ~±90°
        { axis: 'z', min: -0.35, max: 3.14, name: 'Shoulder Add/Abduction' },     // ~-20° to 180°
    ],
    'upper_arm_r': [
        { axis: 'x', min: -1.05, max: 3.14, name: 'Shoulder Flex/Extension' },
        { axis: 'y', min: -1.57, max: 1.57, name: 'Shoulder Rotation' },
        { axis: 'z', min: -3.14, max: 0.35, name: 'Shoulder Add/Abduction' },     // Mirrored
    ],

    // Elbow - hinge joint
    'forearm_l': [
        { axis: 'x', min: 0, max: 2.62, name: 'Elbow Flexion' },                  // 0° to 150°
        { axis: 'y', min: -1.40, max: 1.40, name: 'Forearm Pronation/Supination' }, // ~±80°
        { axis: 'z', min: -0.09, max: 0.09, name: 'Carrying Angle' },             // ~±5°
    ],
    'forearm_r': [
        { axis: 'x', min: 0, max: 2.62, name: 'Elbow Flexion' },
        { axis: 'y', min: -1.40, max: 1.40, name: 'Forearm Pronation/Supination' },
        { axis: 'z', min: -0.09, max: 0.09, name: 'Carrying Angle' },
    ],

    // Wrist
    'hand_l': [
        { axis: 'x', min: -1.22, max: 1.22, name: 'Wrist Flex/Extension' },       // ~±70°
        { axis: 'z', min: -0.52, max: 0.35, name: 'Wrist Ulnar/Radial Dev' },     // ~-30° to 20°
    ],
    'hand_r': [
        { axis: 'x', min: -1.22, max: 1.22, name: 'Wrist Flex/Extension' },
        { axis: 'z', min: -0.35, max: 0.52, name: 'Wrist Ulnar/Radial Dev' },     // Mirrored
    ],

    // ==========================================================================
    // SPINE
    // ==========================================================================

    // Head/Neck (C-spine)
    'head': [
        { axis: 'x', min: -0.87, max: 0.79, name: 'Neck Flex/Extension' },        // ~-50° to 45°
        { axis: 'y', min: -1.40, max: 1.40, name: 'Neck Rotation' },              // ~±80°
        { axis: 'z', min: -0.70, max: 0.70, name: 'Neck Lateral Flexion' },       // ~±40°
    ],

    // Thoracic spine
    'torso': [
        { axis: 'x', min: -0.52, max: 0.52, name: 'Thoracic Flex/Extension' },    // ~±30°
        { axis: 'y', min: -0.52, max: 0.52, name: 'Thoracic Rotation' },          // ~±30°
        { axis: 'z', min: -0.44, max: 0.44, name: 'Thoracic Lateral Flex' },      // ~±25°
    ],

    // Pelvis (relative to world)
    'pelvis': [
        { axis: 'x', min: -0.52, max: 0.70, name: 'Pelvic Tilt' },                // ~-30° to 40°
        { axis: 'y', min: -0.79, max: 0.79, name: 'Pelvic Rotation' },            // ~±45°
        { axis: 'z', min: -0.35, max: 0.35, name: 'Pelvic Obliquity' },           // ~±20°
    ],
};

// ============================================================================
// CONSTRAINT FUNCTIONS
// ============================================================================

/**
 * Apply soft anatomical constraints to Euler angles.
 * 
 * "Soft" constraints gradually push values back toward valid range
 * rather than hard-clamping, which prevents sudden visual snapping.
 * 
 * @param jointId - Segment ID matching JOINT_LIMITS keys
 * @param euler - Current Euler angles
 * @param softness - 0 = hard clamp, 1 = no constraint (default 0.7)
 * @returns Constrained Euler angles with violation info
 */
export function applySoftConstraints(
    jointId: string,
    euler: THREE.Euler,
    softness: number = 0.7
): ConstraintResult {
    const limits = JOINT_LIMITS[jointId];
    if (!limits) {
        return {
            euler: euler.clone(),
            wasConstrained: false,
            violations: []
        };
    }

    const result = euler.clone();
    const violations: ConstraintResult['violations'] = [];

    for (const limit of limits) {
        const current = result[limit.axis];

        if (current < limit.min) {
            // Below minimum - push back
            const corrected = limit.min + (current - limit.min) * softness;
            result[limit.axis] = corrected;
            violations.push({
                axis: limit.name || limit.axis,
                original: current * (180 / Math.PI),
                constrained: corrected * (180 / Math.PI),
                limit: 'min'
            });
        } else if (current > limit.max) {
            // Above maximum - push back
            const corrected = limit.max + (current - limit.max) * softness;
            result[limit.axis] = corrected;
            violations.push({
                axis: limit.name || limit.axis,
                original: current * (180 / Math.PI),
                constrained: corrected * (180 / Math.PI),
                limit: 'max'
            });
        }
    }

    return {
        euler: result,
        wasConstrained: violations.length > 0,
        violations
    };
}

/**
 * Apply hard constraints (strict clamping) to Euler angles.
 * Use only when soft constraints are insufficient.
 * 
 * @param jointId - Segment ID
 * @param euler - Current Euler angles
 * @returns Clamped Euler angles
 */
export function applyHardConstraints(
    jointId: string,
    euler: THREE.Euler
): THREE.Euler {
    const limits = JOINT_LIMITS[jointId];
    if (!limits) return euler.clone();

    const result = euler.clone();

    for (const limit of limits) {
        result[limit.axis] = THREE.MathUtils.clamp(
            result[limit.axis],
            limit.min,
            limit.max
        );
    }

    return result;
}

/**
 * Check if a joint pose is within valid ROM.
 * 
 * @param jointId - Segment ID
 * @param euler - Current Euler angles
 * @param tolerance - Degrees of tolerance beyond strict limits (default 5°)
 * @returns True if pose is valid
 */
export function isValidPose(
    jointId: string,
    euler: THREE.Euler,
    tolerance: number = 5
): boolean {
    const limits = JOINT_LIMITS[jointId];
    if (!limits) return true;

    const toleranceRad = tolerance * (Math.PI / 180);

    for (const limit of limits) {
        const current = euler[limit.axis];
        if (current < limit.min - toleranceRad || current > limit.max + toleranceRad) {
            return false;
        }
    }

    return true;
}

/**
 * Get constraint violation severity for a joint.
 * 
 * @param jointId - Segment ID
 * @param euler - Current Euler angles
 * @returns Severity 0-1 (0 = within limits, 1 = severely violated)
 */
export function getViolationSeverity(
    jointId: string,
    euler: THREE.Euler
): number {
    const limits = JOINT_LIMITS[jointId];
    if (!limits) return 0;

    let maxViolation = 0;

    for (const limit of limits) {
        const current = euler[limit.axis];
        const range = limit.max - limit.min;

        let violation = 0;
        if (current < limit.min) {
            violation = (limit.min - current) / range;
        } else if (current > limit.max) {
            violation = (current - limit.max) / range;
        }

        maxViolation = Math.max(maxViolation, violation);
    }

    return Math.min(1, maxViolation);
}
