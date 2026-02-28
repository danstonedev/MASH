/**
 * IMU Connect Convention Definitions
 * ===================================
 * SINGLE SOURCE OF TRUTH for coordinate frames and rotation conventions.
 * 
 * All IMU math code MUST reference this file for frame definitions.
 * Violating these conventions causes "mysterious bugs" that are actually
 * convention inconsistencies.
 * 
 * @module conventions
 */

import * as THREE from 'three';

// ============================================================================
// COORDINATE FRAME DEFINITIONS
// ============================================================================

/**
 * GLOBAL FRAME (G) - Three.js World
 * 
 * Right-handed coordinate system:
 *   X → Right
 *   Y → Up (opposite gravity)
 *   Z → Forward (toward camera)
 * 
 * This is the standard Three.js convention (Y-up).
 */
export const GLOBAL_FRAME = {
    name: 'Global (G)',
    xAxis: 'Right',
    yAxis: 'Up',
    zAxis: 'Forward',
    handedness: 'right' as const,
    convention: 'Y-up (Three.js default)',
} as const;

/**
 * SENSOR FRAME (S) - ICM-20649 MEMS Chip
 * 
 * Right-handed coordinate system (when chip is face-up):
 *   X → Right (along short PCB edge)
 *   Y → Forward (along long PCB edge)
 *   Z → Up (normal to PCB, toward you)
 * 
 * Accelerometer reports +Z when stationary (gravity = -Z in world).
 * Gyroscope reports positive angular velocity for CCW rotation when
 * looking down the positive axis.
 */
export const SENSOR_FRAME = {
    name: 'Sensor (S)',
    xAxis: 'Right (short edge)',
    yAxis: 'Forward (long edge)',
    zAxis: 'Up (chip normal)',
    handedness: 'right' as const,
    convention: 'ICM-20649 datasheet',
} as const;

/**
 * GYROSCOPE UNITS
 * 
 * IMPORTANT: Throughout the entire pipeline, gyroscope data is in RAD/S (radians per second).
 * 
 * - ESP32 firmware: Adafruit ICM20649 library returns rad/s
 * - BLE 0x03 packet: Packed as (rad/s * 100), parsed back to rad/s
 * - Web app Madgwick: Expects rad/s input
 * 
 * DO NOT apply deg→rad conversion to data from the 0x03 packet!
 */

// ============================================================================
// GRAVITY
// ============================================================================

/**
 * Gravity vector in Global frame (Three.js world)
 * Y-down because Y-axis points up
 */
export const GRAVITY_GLOBAL = new THREE.Vector3(0, -9.81, 0);

/**
 * Standard gravity magnitude (m/s²)
 */
export const GRAVITY_MAGNITUDE = 9.81;

/**
 * Gravity unit vector (normalized, pointing down in global frame)
 */
export const GRAVITY_DIRECTION = new THREE.Vector3(0, -1, 0);

// ============================================================================
// ROTATION CONVENTION
// ============================================================================

/**
 * ROTATION CONVENTION: R_GS = R_(G←S)
 * 
 * This quaternion/matrix TRANSFORMS vectors FROM Sensor frame TO Global frame:
 *   v_Global = R_GS * v_Sensor
 * 
 * Mnemonic: "G from S" - the subscript order matches the transformation direction.
 * 
 * This is the ACTIVE transformation convention (rotates vectors, not frames).
 */
export const ROTATION_CONVENTION = {
    notation: 'R_GS = R_(G←S)',
    meaning: 'Transforms vector FROM Sensor TO Global',
    formula: 'v_G = R_GS * v_S',
    type: 'active' as const,
} as const;

/**
 * Quaternion storage order: [w, x, y, z]
 * 
 * IMPORTANT: Three.js Quaternion constructor is (x, y, z, w) but
 * our firmware sends [w, x, y, z]. Be careful with ordering!
 */
export const QUATERNION_ORDER = {
    firmware: '[w, x, y, z]',
    threeJS: 'new Quaternion(x, y, z, w)',
    note: 'Order differs! Map carefully.',
} as const;

// ============================================================================
// COORDINATE HELPER FUNCTIONS
// ============================================================================
// NOTE (Jan 2026): Coordinate conversion is now done in firmware at sensor
// read time. All data arrives in Y-up (Three.js) frame. Legacy transform
// functions have been removed.

/**
 * Convert firmware quaternion array [w,x,y,z] to THREE.Quaternion.
 * No coordinate conversion - firmware sends Y-up frame directly.
 */
export function firmwareToThreeQuat(q: [number, number, number, number]): THREE.Quaternion {
    const [w, x, y, z] = q;
    return new THREE.Quaternion(x, y, z, w);
}

/**
 * Convert THREE.Quaternion to firmware array format [w,x,y,z].
 */
export function threeQuatToFirmware(q: THREE.Quaternion): [number, number, number, number] {
    return [q.w, q.x, q.y, q.z];
}

/**
 * Convert firmware vector array [x,y,z] to THREE.Vector3.
 * No coordinate conversion - firmware sends Y-up frame directly.
 */
export function firmwareToThreeVec(v: [number, number, number]): THREE.Vector3 {
    return new THREE.Vector3(v[0], v[1], v[2]);
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Check if a quaternion is properly normalized (unit quaternion).
 * Required for valid SO(3) representation.
 * 
 * @param q - Quaternion to check
 * @param tolerance - Maximum deviation from unit length (default 1e-6)
 * @returns true if |q| ≈ 1
 */
export function isUnitQuaternion(q: THREE.Quaternion, tolerance = 1e-6): boolean {
    return Math.abs(q.length() - 1) < tolerance;
}

/**
 * Check if a rotation matrix is valid (orthonormal with det=+1).
 * Required for valid SO(3) representation.
 * 
 * @param R - 3x3 rotation matrix
 * @param tolerance - Maximum deviation (default 1e-6)
 * @returns true if R ∈ SO(3)
 */
export function isValidRotationMatrix(R: THREE.Matrix3, tolerance = 1e-6): boolean {
    // Check R * R^T ≈ I
    const RT = R.clone().transpose();
    const RRT = R.clone().multiply(RT);
    const I = new THREE.Matrix3().identity();

    // Check each element
    for (let i = 0; i < 9; i++) {
        if (Math.abs(RRT.elements[i] - I.elements[i]) > tolerance) {
            return false;
        }
    }

    // Check det(R) ≈ +1
    const det = R.determinant();
    return Math.abs(det - 1) < tolerance;
}
