/**
 * SO(3) Lie Group Operations
 * ==========================
 * Core mathematical primitives for manifold-correct orientation estimation.
 * 
 * SO(3) is the Special Orthogonal group in 3D - the group of 3D rotations.
 * Its Lie algebra so(3) consists of skew-symmetric matrices (or equivalently,
 * 3D angular velocity vectors).
 * 
 * Key operations:
 * - exp: so(3) → SO(3)  (rotation vector → rotation matrix)
 * - log: SO(3) → so(3)  (rotation matrix → rotation vector)
 * 
 * These are required for:
 * 1. Manifold integration (q_new = q_old ⊗ exp(ω*dt))
 * 2. Error-state Kalman filters
 * 3. Joint constraint computation
 * 
 * @module so3
 */

import * as THREE from 'three';

// ============================================================================
// CONSTANTS
// ============================================================================

const EPSILON = 1e-8;  // Small angle threshold for numerical stability

// ============================================================================
// SKEW-SYMMETRIC MATRIX
// ============================================================================

/**
 * Create skew-symmetric matrix from vector (hat operator).
 * 
 * For vector ω = [ωx, ωy, ωz]:
 *       [  0  -ωz   ωy ]
 * [ω]× = [ ωz   0  -ωx ]
 *       [-ωy  ωx    0  ]
 * 
 * Property: [ω]× v = ω × v (cross product)
 * 
 * @param v - Angular velocity or rotation vector
 * @returns 3x3 skew-symmetric matrix
 */
export function skew(v: THREE.Vector3): THREE.Matrix3 {
    const m = new THREE.Matrix3();
    // Three.js Matrix3.set() is in row-major order
    m.set(
        0, -v.z, v.y,
        v.z, 0, -v.x,
        -v.y, v.x, 0
    );
    return m;
}

/**
 * Extract vector from skew-symmetric matrix (vee operator).
 * Inverse of skew().
 * 
 * @param S - Skew-symmetric 3x3 matrix
 * @returns Vector such that skew(v) = S
 */
export function vee(S: THREE.Matrix3): THREE.Vector3 {
    const e = S.elements;
    // S = [ 0, -z, y; z, 0, -x; -y, x, 0 ] (column-major in Three.js)
    // elements[1] = z, elements[2] = -y, elements[5] = x
    return new THREE.Vector3(e[5], -e[2], e[1]);
}

// ============================================================================
// EXPONENTIAL MAP (so(3) → SO(3))
// ============================================================================

/**
 * Exponential map: rotation vector → rotation matrix.
 * 
 * Uses Rodrigues' formula for efficiency:
 *   R = I + sin(θ)[ω̂]× + (1-cos(θ))[ω̂]×²
 * 
 * where θ = ||φ|| is the rotation angle and ω̂ = φ/θ is the unit axis.
 * 
 * For small angles (θ < ε), uses Taylor expansion for numerical stability:
 *   R ≈ I + [φ]× + ½[φ]×²
 * 
 * @param phi - Rotation vector (axis × angle, in radians)
 * @returns Rotation matrix R ∈ SO(3)
 */
export function ExpSO3(phi: THREE.Vector3): THREE.Matrix3 {
    const angle = phi.length();

    if (angle < EPSILON) {
        // Small angle: R ≈ I + [φ]× + ½[φ]×²
        const K = skew(phi);
        const K2 = K.clone().multiply(K);
        const I = new THREE.Matrix3().identity();

        // R = I + K + 0.5*K²
        for (let i = 0; i < 9; i++) {
            I.elements[i] += K.elements[i] + 0.5 * K2.elements[i];
        }
        return I;
    }

    // Rodrigues' formula
    const axis = phi.clone().divideScalar(angle);
    const K = skew(axis);
    const K2 = K.clone().multiply(K);

    const s = Math.sin(angle);
    const c = Math.cos(angle);

    const R = new THREE.Matrix3().identity();
    for (let i = 0; i < 9; i++) {
        R.elements[i] += s * K.elements[i] + (1 - c) * K2.elements[i];
    }

    return R;
}

/**
 * Exponential map for quaternions.
 * 
 * Given angular velocity ω and time step dt:
 *   q_delta = exp(ω * dt / 2)
 * 
 * This is the correct manifold update for quaternion integration:
 *   q_new = q_old ⊗ q_delta
 * 
 * @param omega - Angular velocity vector (rad/s)
 * @param dt - Time step (seconds)
 * @returns Unit quaternion representing the rotation
 */
export function ExpQuaternion(omega: THREE.Vector3, dt: number): THREE.Quaternion {
    const angle = omega.length() * dt;
    const halfAngle = angle * 0.5;

    if (angle < EPSILON) {
        // Small angle approximation
        const q = new THREE.Quaternion(
            omega.x * dt * 0.5,
            omega.y * dt * 0.5,
            omega.z * dt * 0.5,
            1
        );
        return q.normalize();
    }

    const axis = omega.clone().normalize();
    const s = Math.sin(halfAngle);

    return new THREE.Quaternion(
        axis.x * s,
        axis.y * s,
        axis.z * s,
        Math.cos(halfAngle)
    );
}

// ============================================================================
// LOGARITHMIC MAP (SO(3) → so(3))
// ============================================================================

/**
 * Logarithmic map: rotation matrix → rotation vector.
 * 
 * Computes φ such that R = exp([φ]×).
 * 
 * Uses the formula:
 *   θ = arccos((tr(R) - 1) / 2)
 *   ω = (R - R^T) / (2 sin(θ))  (as skew-symmetric, then vee)
 *   φ = θ * ω
 * 
 * @param R - Rotation matrix ∈ SO(3)
 * @returns Rotation vector (axis × angle)
 */
export function LogSO3(R: THREE.Matrix3): THREE.Vector3 {
    const e = R.elements;
    // Trace = R[0,0] + R[1,1] + R[2,2]
    // Three.js is column-major: elements[0], elements[4], elements[8]
    const trace = e[0] + e[4] + e[8];
    const cosAngle = (trace - 1) / 2;

    if (cosAngle >= 1 - EPSILON) {
        // Near identity: θ ≈ 0
        // Use first-order approximation: φ ≈ vee(R - I)
        return new THREE.Vector3(
            (e[5] - e[7]) * 0.5,  // (R[1,2] - R[2,1]) / 2
            (e[6] - e[2]) * 0.5,  // (R[2,0] - R[0,2]) / 2
            (e[1] - e[3]) * 0.5   // (R[0,1] - R[1,0]) / 2
        );
    }

    if (cosAngle <= -1 + EPSILON) {
        // Near π rotation: need special handling
        // Find the column of R + I with largest norm
        const Rp = R.clone();
        Rp.elements[0] += 1;
        Rp.elements[4] += 1;
        Rp.elements[8] += 1;

        // Use column with max diagonal element
        let maxIdx = 0;
        if (Rp.elements[4] > Rp.elements[0]) maxIdx = 1;
        if (Rp.elements[8] > Rp.elements[maxIdx * 4]) maxIdx = 2;

        const axis = new THREE.Vector3(
            Rp.elements[maxIdx],
            Rp.elements[maxIdx + 3],
            Rp.elements[maxIdx + 6]
        ).normalize();

        return axis.multiplyScalar(Math.PI);
    }

    // General case
    const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
    const sinAngle = Math.sin(angle);

    const axis = new THREE.Vector3(
        (e[5] - e[7]) / (2 * sinAngle),
        (e[6] - e[2]) / (2 * sinAngle),
        (e[1] - e[3]) / (2 * sinAngle)
    );

    return axis.multiplyScalar(angle);
}

/**
 * Logarithmic map for quaternions.
 * 
 * Returns the rotation vector φ such that q = exp(φ/2).
 * 
 * @param q - Unit quaternion
 * @returns Rotation vector (axis × angle)
 */
export function LogQuaternion(q: THREE.Quaternion): THREE.Vector3 {
    // Ensure q.w >= 0 for unique representation
    const qNorm = q.w >= 0 ? q : new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w);

    const sinHalfAngle = Math.sqrt(qNorm.x * qNorm.x + qNorm.y * qNorm.y + qNorm.z * qNorm.z);

    if (sinHalfAngle < EPSILON) {
        // Small angle
        return new THREE.Vector3(qNorm.x * 2, qNorm.y * 2, qNorm.z * 2);
    }

    const halfAngle = Math.atan2(sinHalfAngle, qNorm.w);
    const scale = 2 * halfAngle / sinHalfAngle;

    return new THREE.Vector3(qNorm.x * scale, qNorm.y * scale, qNorm.z * scale);
}

// ============================================================================
// QUATERNION OPERATIONS
// ============================================================================

/**
 * Quaternion multiplication: p ⊗ q
 * 
 * Represents composition of rotations: R_pq = R_p * R_q
 * 
 * @param p - Left quaternion
 * @param q - Right quaternion
 * @returns Product quaternion
 */
export function quatMultiply(p: THREE.Quaternion, q: THREE.Quaternion): THREE.Quaternion {
    return new THREE.Quaternion(
        p.w * q.x + p.x * q.w + p.y * q.z - p.z * q.y,
        p.w * q.y - p.x * q.z + p.y * q.w + p.z * q.x,
        p.w * q.z + p.x * q.y - p.y * q.x + p.z * q.w,
        p.w * q.w - p.x * q.x - p.y * q.y - p.z * q.z
    );
}

/**
 * Rotate a vector by a quaternion: q ⊗ v ⊗ q*
 * 
 * @param q - Unit quaternion
 * @param v - Vector to rotate
 * @returns Rotated vector
 */
export function quatRotateVector(q: THREE.Quaternion, v: THREE.Vector3): THREE.Vector3 {
    // Optimized form avoiding full quaternion multiplication
    const qv = new THREE.Vector3(q.x, q.y, q.z);
    const uv = qv.clone().cross(v);
    const uuv = qv.clone().cross(uv);

    return v.clone()
        .add(uv.multiplyScalar(2 * q.w))
        .add(uuv.multiplyScalar(2));
}

// ============================================================================
// MATRIX OPERATIONS
// ============================================================================

/**
 * Convert rotation matrix to quaternion.
 * 
 * @param R - Rotation matrix ∈ SO(3)
 * @returns Unit quaternion
 */
export function matrixToQuaternion(R: THREE.Matrix3): THREE.Quaternion {
    const q = new THREE.Quaternion();
    const m4 = new THREE.Matrix4().setFromMatrix3(R);
    q.setFromRotationMatrix(m4);
    return q;
}

/**
 * Convert quaternion to rotation matrix.
 * 
 * @param q - Unit quaternion
 * @returns Rotation matrix ∈ SO(3)
 */
export function quaternionToMatrix(q: THREE.Quaternion): THREE.Matrix3 {
    const m4 = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const m3 = new THREE.Matrix3().setFromMatrix4(m4);
    return m3;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Check if rotation matrix is valid (orthonormal, det=+1).
 * 
 * @param R - Matrix to check
 * @param tolerance - Maximum deviation
 * @returns true if R ∈ SO(3)
 */
export function isValidSO3(R: THREE.Matrix3, tolerance = 1e-6): boolean {
    // Check R * R^T ≈ I
    const RT = R.clone().transpose();
    const RRT = R.clone().multiply(RT);

    const I = new THREE.Matrix3().identity();
    for (let i = 0; i < 9; i++) {
        if (Math.abs(RRT.elements[i] - I.elements[i]) > tolerance) {
            return false;
        }
    }

    // Check det(R) ≈ +1
    return Math.abs(R.determinant() - 1) < tolerance;
}

/**
 * Project a matrix onto SO(3) (nearest valid rotation matrix).
 * Uses SVD: R_proj = U * V^T where A = U * Σ * V^T
 * 
 * For now, uses simpler Gram-Schmidt orthonormalization.
 * 
 * @param M - Matrix to project
 * @returns Nearest rotation matrix
 */
export function projectToSO3(M: THREE.Matrix3): THREE.Matrix3 {
    // Extract columns
    const e = M.elements;
    const c0 = new THREE.Vector3(e[0], e[1], e[2]).normalize();
    let c1 = new THREE.Vector3(e[3], e[4], e[5]);
    let c2 = new THREE.Vector3(e[6], e[7], e[8]);

    // Gram-Schmidt
    c1 = c1.sub(c0.clone().multiplyScalar(c0.dot(c1))).normalize();
    c2 = c0.clone().cross(c1);  // Ensure right-handed

    const R = new THREE.Matrix3();
    R.set(
        c0.x, c1.x, c2.x,
        c0.y, c1.y, c2.y,
        c0.z, c1.z, c2.z
    );
    return R;
}
