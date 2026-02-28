/**
 * Heading (Yaw) Utilities
 * =======================
 * 
 * Functions for extracting and manipulating yaw (heading) from quaternions.
 * Used for Xsens-style forward direction detection during calibration.
 * 
 * @module calibration/heading
 */

import * as THREE from 'three';

/**
 * Extract yaw-only quaternion from a full rotation.
 * 
 * Used to isolate heading component for correction.
 * YXZ order ensures yaw (Y) is extracted cleanly.
 * 
 * @param q - Input quaternion
 * @returns Quaternion with only yaw rotation (pitch/roll zeroed)
 */
export function extractYawQuaternion(q: THREE.Quaternion): THREE.Quaternion {
    const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    return new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, euler.y, 0, 'YXZ')
    );
}

/**
 * Remove yaw (heading) from a quaternion, leaving only tilt (roll/pitch).
 * 
 * Useful for isolating tilt-only alignment.
 * 
 * @param q - Input quaternion
 * @returns Quaternion with yaw removed (tilt only)
 */
export function removeYaw(q: THREE.Quaternion): THREE.Quaternion {
    const yaw = extractYawQuaternion(q);
    return yaw.clone().invert().multiply(q);
}

/**
 * Extract heading angle in radians from quaternion.
 * 
 * @param q - Input quaternion
 * @returns Yaw angle in radians
 */
export function getHeadingRadians(q: THREE.Quaternion): number {
    const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    return euler.y;
}

/**
 * Extract heading angle in degrees from quaternion.
 * 
 * @param q - Input quaternion
 * @returns Yaw angle in degrees
 */
export function getHeadingDegrees(q: THREE.Quaternion): number {
    return THREE.MathUtils.radToDeg(getHeadingRadians(q));
}
