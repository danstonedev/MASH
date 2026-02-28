/**
 * Stability Detection Module
 * ==========================
 * 
 * Utilities for detecting sensor stability during calibration.
 * Used to determine when the subject is holding still for capture.
 * 
 * @module calibration/stability
 */

import * as THREE from 'three';

// ============================================================================
// TYPES
// ============================================================================

export interface StabilityResult {
    isStable: boolean;
    stableDurationMs: number;
    avgGyroMagnitude: number;
    quaternionAverage: THREE.Quaternion;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Gyroscope magnitude threshold for stability (rad/s) */
export const STABILITY_THRESHOLD = 0.08;

/** Required duration of stability for capture (ms) */
export const STABILITY_DURATION_MS = 300;

/** Number of samples to average for pose capture */
export const SAMPLE_AVERAGING_FRAMES = 15;

// ============================================================================
// FUNCTIONS
// ============================================================================

/**
 * Check if sensors are stable enough for capture.
 * 
 * Stability is determined by gyroscope magnitude being below threshold
 * for all sensors in the buffer.
 * 
 * @param gyroSamples - Map of sensor ID to gyroscope sample history
 * @param requiredDurationMs - Required stable duration (default: STABILITY_DURATION_MS)
 * @returns StabilityResult with status and average quaternion
 */
export function checkStability(
    gyroSamples: Map<string, THREE.Vector3[]>,
    requiredDurationMs: number = STABILITY_DURATION_MS
): StabilityResult {
    let allStable = true;
    let maxGyroMag = 0;

    gyroSamples.forEach((samples) => {
        if (samples.length < 10) {
            allStable = false;
            return;
        }

        // Check last N samples for stability
        const recentSamples = samples.slice(-30);
        const avgMagnitude = recentSamples.reduce((sum, v) => sum + v.length(), 0) / recentSamples.length;

        maxGyroMag = Math.max(maxGyroMag, avgMagnitude);

        if (avgMagnitude > STABILITY_THRESHOLD) {
            allStable = false;
        }
    });

    return {
        isStable: allStable,
        stableDurationMs: allStable ? requiredDurationMs : 0,
        avgGyroMagnitude: maxGyroMag,
        quaternionAverage: new THREE.Quaternion(), // Computed separately
    };
}

/**
 * Compute SLERP-averaged quaternion from samples.
 * 
 * CRITICAL: Handles hemisphere crossing for on-body calibration.
 * When subject sways during T-pose capture, quaternions may cross
 * the hemisphere boundary (q and -q represent same rotation).
 * We ensure all quaternions are in the same hemisphere before averaging.
 * 
 * @param quaternions - Array of quaternion samples to average
 * @returns Normalized average quaternion
 */
export function averageQuaternions(quaternions: THREE.Quaternion[]): THREE.Quaternion {
    if (quaternions.length === 0) return new THREE.Quaternion();
    if (quaternions.length === 1) return quaternions[0].clone();

    // Progressive SLERP averaging with hemisphere normalization
    let result = quaternions[0].clone();
    for (let i = 1; i < quaternions.length; i++) {
        // HEMISPHERE CHECK: Ensure quaternion is in same hemisphere as running average
        // If dot product is negative, negate to get equivalent rotation in same hemisphere
        let q = quaternions[i];
        if (result.dot(q) < 0) {
            q = q.clone().set(-q.x, -q.y, -q.z, -q.w);
        }

        // Weight decreases as we accumulate more samples
        const weight = 1 / (i + 1);
        result.slerp(q, weight);
    }

    return result.normalize();
}
