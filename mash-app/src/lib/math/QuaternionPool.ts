/**
 * QuaternionPool - Industry-Grade Quaternion Utilities
 * =====================================================
 * 
 * Following patterns from Xsens MVN, Unity, and OpenSense:
 * 
 * 1. STATIC CONSTANTS: Avoid per-frame allocations
 * 2. HEMISPHERE-SAFE OPERATIONS: Always check dot product before SLERP
 * 3. OBJECT POOLING: Reuse temporary quaternions in hot paths
 * 
 * @module QuaternionPool
 */

import * as THREE from 'three';

// =============================================================================
// STATIC CONSTANTS (Immutable - never modify these!)
// =============================================================================

/**
 * Identity quaternion - represents no rotation.
 * Use this instead of `new THREE.Quaternion()` in comparisons.
 */
export const IDENTITY_QUAT = Object.freeze(new THREE.Quaternion(0, 0, 0, 1));

/**
 * Check if a quaternion is effectively identity (no rotation).
 * More robust than .equals() - handles floating point error.
 * 
 * @param q - Quaternion to check
 * @param tolerance - Maximum deviation (default 1e-4)
 */
export function isIdentity(q: THREE.Quaternion, tolerance: number = 1e-4): boolean {
    return Math.abs(q.w - 1) < tolerance &&
        Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) < tolerance;
}

// =============================================================================
// QUATERNION ARRAY FORMAT STANDARD (Industry Convention)
// =============================================================================

/**
 * STANDARD QUATERNION ARRAY FORMAT: [w, x, y, z]
 * 
 * This is the SINGLE SOURCE OF TRUTH for quaternion array ordering.
 * Use this type for all storage, serialization, and transmission.
 * 
 * Industry precedent:
 * - Xsens MVN: [w, x, y, z] ✓
 * - BVH format: [w, x, y, z] ✓
 * - Our firmware: [w, x, y, z] ✓
 * - ROS tf2: [x, y, z, w] (different)
 * - Unity: [x, y, z, w] (different)
 */
export type QuatArrayWXYZ = [number, number, number, number];

// =============================================================================
// HEMISPHERE-SAFE OPERATIONS (Critical for SLERP)
// =============================================================================

/**
 * Ensure two quaternions are in the same hemisphere for SLERP.
 * 
 * Quaternions q and -q represent the same rotation, but SLERP between
 * opposite hemispheres takes the "long way around" causing flipping.
 * 
 * Industry Standard: Xsens, Unity, Unreal all use this pattern.
 * 
 * @param target - The quaternion to potentially negate
 * @param reference - The reference quaternion (usually previous frame)
 * @returns Target quaternion in same hemisphere as reference
 */
export function ensureSameHemisphere(
    target: THREE.Quaternion,
    reference: THREE.Quaternion
): THREE.Quaternion {
    if (reference.dot(target) < 0) {
        return new THREE.Quaternion(-target.x, -target.y, -target.z, -target.w);
    }
    return target;
}

/**
 * Hemisphere-safe SLERP interpolation.
 * 
 * @param from - Starting quaternion (will be modified in place)
 * @param to - Target quaternion
 * @param alpha - Interpolation factor (0 = from, 1 = to)
 * @returns The 'from' quaternion after interpolation
 */
export function safeSlerp(
    from: THREE.Quaternion,
    to: THREE.Quaternion,
    alpha: number
): THREE.Quaternion {
    const safeTarget = ensureSameHemisphere(to, from);
    return from.slerp(safeTarget, alpha);
}

// =============================================================================
// QUATERNION SMOOTHER (Encapsulates per-sensor smoothing state)
// =============================================================================

/**
 * Adaptive quaternion smoother with hemisphere handling.
 * 
 * Industry pattern: Each sensor gets its own smoother instance.
 * - Xsens: Kalman-based quaternion filtering
 * - Unity: Rigidbody.rotation smoothing
 * - This: Adaptive SLERP with gyro-based alpha
 */
export class QuaternionSmoother {
    private smoothed: THREE.Quaternion = new THREE.Quaternion();
    private initialized: boolean = false;

    // Adaptive smoothing parameters
    // Adjusted: Less aggressive smoothing for more responsive movement
    private static readonly MIN_ALPHA = 0.4;       // Was 0.2 - higher baseline responsiveness
    private static readonly MAX_ALPHA = 1.0;       // Was 0.7 - allow full speed updates
    private static readonly GYRO_SCALE = 0.5;      // Was 0.3 - faster response to motion
    private static readonly NOISE_FLOOR = 0.1;     // rad/s
    private static readonly PLAYBACK_ALPHA = 0.3;  // Was 0.15 - more responsive playback

    /**
     * Process a new quaternion sample.
     * 
     * @param target - New quaternion from sensor
     * @param gyroMagnitude - Angular velocity magnitude (rad/s), or null for playback
     * @returns Smoothed quaternion
     */
    update(target: THREE.Quaternion, gyroMagnitude: number | null = null): THREE.Quaternion {
        if (!this.initialized) {
            this.smoothed.copy(target);
            this.initialized = true;
            return this.smoothed.clone();
        }

        // Hemisphere check: ensure we interpolate the short way
        const safeTarget = ensureSameHemisphere(target, this.smoothed);

        // Calculate alpha
        let alpha: number;
        if (gyroMagnitude === null) {
            // Playback mode: fixed moderate smoothing
            alpha = QuaternionSmoother.PLAYBACK_ALPHA;
        } else {
            // Live mode: adaptive based on motion
            const clampedGyro = gyroMagnitude < QuaternionSmoother.NOISE_FLOOR
                ? 0
                : gyroMagnitude;
            alpha = Math.min(
                QuaternionSmoother.MAX_ALPHA,
                Math.max(
                    QuaternionSmoother.MIN_ALPHA,
                    QuaternionSmoother.MIN_ALPHA + clampedGyro * QuaternionSmoother.GYRO_SCALE
                )
            );
        }

        // SLERP interpolation
        this.smoothed.slerp(safeTarget, alpha);

        return this.smoothed.clone();
    }

    /**
     * Reset smoother state.
     * Call when sensor disconnects or calibration changes.
     */
    reset(): void {
        this.smoothed.set(0, 0, 0, 1);
        this.initialized = false;
    }

    /**
     * Get current smoothed quaternion without updating.
     */
    getCurrent(): THREE.Quaternion {
        return this.smoothed.clone();
    }

    /**
     * Process a new quaternion sample (Zero-Allocation).
     * Writes result directly to the provided target quaternion.
     */
    updateInPlace(targetInput: THREE.Quaternion, resultOutput: THREE.Quaternion, gyroMagnitude: number | null = null): void {
        if (!this.initialized) {
            this.smoothed.copy(targetInput);
            this.initialized = true;
            resultOutput.copy(this.smoothed);
            return;
        }

        // Hemisphere check: ensure we interpolate the short way
        const safeTarget = ensureSameHemisphere(targetInput, this.smoothed);

        // Calculate alpha
        let alpha: number;
        if (gyroMagnitude === null) {
            alpha = QuaternionSmoother.PLAYBACK_ALPHA;
        } else {
            const clampedGyro = gyroMagnitude < QuaternionSmoother.NOISE_FLOOR ? 0 : gyroMagnitude;
            alpha = Math.min(
                QuaternionSmoother.MAX_ALPHA,
                Math.max(
                    QuaternionSmoother.MIN_ALPHA,
                    QuaternionSmoother.MIN_ALPHA + clampedGyro * QuaternionSmoother.GYRO_SCALE
                )
            );
        }

        // SLERP interpolation
        this.smoothed.slerp(safeTarget, alpha);
        resultOutput.copy(this.smoothed);
    }
}

// =============================================================================
// SMOOTHER REGISTRY (Per-sensor smoother instances)
// =============================================================================

const smootherRegistry = new Map<string, QuaternionSmoother>();

/**
 * Get or create a smoother for a specific sensor.
 * Industry pattern: Each sensor maintains its own filtering state.
 */
export function getSmoother(sensorId: string): QuaternionSmoother {
    if (!smootherRegistry.has(sensorId)) {
        smootherRegistry.set(sensorId, new QuaternionSmoother());
    }
    return smootherRegistry.get(sensorId)!;
}

/**
 * Reset smoother for a sensor (call on disconnect/recalibration).
 */
export function resetSmoother(sensorId: string): void {
    smootherRegistry.get(sensorId)?.reset();
}

/**
 * Clear all smoothers (call on full reset).
 */
export function clearAllSmoothers(): void {
    smootherRegistry.clear();
}

// =============================================================================
// CONVERSION HELPERS (Centralized format conversions)
// =============================================================================

// =============================================================================
// CONVERSION HELPERS (Centralized format conversions)
// =============================================================================

/**
 * Convert sensor array [w,x,y,z] to THREE.Quaternion.
 * This is ORDER ONLY - no frame conversion!
 * 
 * @param arr - Quaternion in sensor format [w, x, y, z]
 * @param target - Optional target quaternion to write to (avoids allocation)
 */
export function arrayToThreeQuat(arr: [number, number, number, number], target?: THREE.Quaternion): THREE.Quaternion {
    const [w, x, y, z] = arr;
    if (target) {
        target.set(x, y, z, w);
        return target;
    }
    return new THREE.Quaternion(x, y, z, w);
}

/**
 * Convert THREE.Quaternion to sensor array [w,x,y,z].
 * This is ORDER ONLY - no frame conversion!
 */
export function threeQuatToArray(q: THREE.Quaternion): [number, number, number, number] {
    return [q.w, q.x, q.y, q.z];
}

/**
 * Copy THREE.Quaternion to an existing array [w,x,y,z].
 * Zero-allocation version of threeQuatToArray.
 */
export function copyToArray(q: THREE.Quaternion, target: [number, number, number, number]): void {
    target[0] = q.w;
    target[1] = q.x;
    target[2] = q.y;
    target[3] = q.z;
}
