/**
 * Gimbal Lock Detection and Mitigation
 * =====================================
 * 
 * Gimbal lock occurs when converting quaternions to Euler angles and the
 * middle rotation axis aligns with one of the outer axes, causing loss
 * of one degree of freedom.
 * 
 * Example (XYZ order):
 *   - When pitch (Y) approaches ±90°, roll and yaw become indistinguishable
 *   - Small quaternion changes cause large Euler angle jumps
 *   - Joint angle displays become unreliable
 * 
 * This module provides:
 *   1. Detection of gimbal lock proximity
 *   2. Warning signals for UI
 *   3. Alternative Euler order suggestions
 *   4. Quaternion-based angle computation (lock-free)
 * 
 * @module gimbalLock
 */

import * as THREE from 'three';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Degrees from 90° to start warning */
const GIMBAL_WARNING_THRESHOLD = 15;  // Warn at 75°+

/** Degrees from 90° for critical lock */
const GIMBAL_CRITICAL_THRESHOLD = 5;  // Critical at 85°+

// ============================================================================
// TYPES
// ============================================================================

export interface GimbalLockStatus {
    /** Is approaching gimbal lock */
    isWarning: boolean;

    /** Is in gimbal lock region */
    isCritical: boolean;

    /** Current Euler order being used */
    eulerOrder: THREE.EulerOrder;

    /** Degrees from gimbal lock (0 = locked) */
    degreesFromLock: number;

    /** Suggested alternative Euler order to avoid lock */
    suggestedOrder: THREE.EulerOrder | null;

    /** Human-readable status message */
    message: string;
}

// ============================================================================
// GIMBAL LOCK DETECTION
// ============================================================================

/**
 * Check gimbal lock status for a quaternion with given Euler order.
 * 
 * @param quat - Orientation quaternion
 * @param order - Current Euler order (default 'XYZ')
 * @returns Gimbal lock status
 */
export function checkGimbalLock(
    quat: THREE.Quaternion,
    order: THREE.EulerOrder = 'XYZ'
): GimbalLockStatus {
    // Convert to Euler with specified order
    const euler = new THREE.Euler().setFromQuaternion(quat, order);

    // Get the middle axis angle (the one that causes gimbal lock)
    const middleAngle = getMiddleAxisAngle(euler, order);
    const middleAngleDeg = Math.abs(middleAngle * (180 / Math.PI));

    // Distance from 90° (gimbal lock point)
    const degreesFromLock = Math.abs(90 - middleAngleDeg);

    const isWarning = degreesFromLock < GIMBAL_WARNING_THRESHOLD;
    const isCritical = degreesFromLock < GIMBAL_CRITICAL_THRESHOLD;

    // Suggest alternative order if approaching lock
    let suggestedOrder: THREE.EulerOrder | null = null;
    let message = 'No gimbal lock risk';

    if (isWarning) {
        suggestedOrder = suggestAlternativeOrder(order, euler);

        if (isCritical) {
            message = `⚠️ GIMBAL LOCK! Middle axis at ${middleAngleDeg.toFixed(1)}°. ` +
                `Switch to ${suggestedOrder} order.`;
        } else {
            message = `Approaching gimbal lock (${degreesFromLock.toFixed(1)}° away). ` +
                `Consider ${suggestedOrder} order.`;
        }
    }

    return {
        isWarning,
        isCritical,
        eulerOrder: order,
        degreesFromLock,
        suggestedOrder,
        message
    };
}

/**
 * Get the middle axis angle for a given Euler order.
 */
function getMiddleAxisAngle(euler: THREE.Euler, order: THREE.EulerOrder): number {
    switch (order) {
        case 'XYZ': case 'ZYX': return euler.y;
        case 'XZY': case 'YZX': return euler.z;
        case 'YXZ': case 'ZXY': return euler.x;
        default: return euler.y;
    }
}

/**
 * Suggest an alternative Euler order to avoid gimbal lock.
 * 
 * Basic heuristic: If middle axis is near ±90°, switch to an order
 * where a different axis is in the middle.
 */
function suggestAlternativeOrder(
    currentOrder: THREE.EulerOrder,
    euler: THREE.Euler
): THREE.EulerOrder {
    // Find which axis has smallest absolute angle (safest for middle)
    const absX = Math.abs(euler.x);
    const absY = Math.abs(euler.y);
    const absZ = Math.abs(euler.z);

    // Choose order that puts smallest angle in middle
    if (absY <= absX && absY <= absZ) {
        return 'XYZ';  // Y in middle
    } else if (absX <= absY && absX <= absZ) {
        return 'YXZ';  // X in middle
    } else {
        return 'XZY';  // Z in middle
    }
}

// ============================================================================
// QUATERNION-BASED JOINT ANGLES (GIMBAL-LOCK FREE)
// ============================================================================

/**
 * Compute joint angles directly from quaternions without Euler conversion.
 * Uses swing-twist decomposition which is gimbal-lock free.
 * 
 * @param parent - Parent segment quaternion
 * @param child - Child segment quaternion
 * @param hingeAxis - Local hinge axis (for 1-DOF joints like knee)
 * @returns Joint angles in degrees { flexion, abduction, rotation }
 */
export function computeJointAngles(
    parent: THREE.Quaternion,
    child: THREE.Quaternion,
    hingeAxis?: THREE.Vector3
): { flexion: number; abduction: number; rotation: number } {
    // Relative rotation: q_rel = q_parent^(-1) * q_child
    const parentInv = parent.clone().invert();
    const relative = parentInv.multiply(child);

    if (hingeAxis) {
        // For hinge joints, decompose into twist around hinge axis
        const { twist, angle } = swingTwistDecomposition(relative, hingeAxis);
        return {
            flexion: angle * (180 / Math.PI),
            abduction: 0,
            rotation: 0
        };
    }

    // For ball joints, use Euler but with dynamic order selection
    const status = checkGimbalLock(relative);
    const order = status.isWarning ? status.suggestedOrder || 'XYZ' : 'XYZ';

    const euler = new THREE.Euler().setFromQuaternion(relative, order);

    return {
        flexion: euler.x * (180 / Math.PI),
        abduction: euler.z * (180 / Math.PI),
        rotation: euler.y * (180 / Math.PI)
    };
}

/**
 * Swing-twist decomposition of a quaternion.
 * Separates rotation into:
 *   - Twist: rotation around the specified axis
 *   - Swing: rotation to align with that axis
 */
function swingTwistDecomposition(
    q: THREE.Quaternion,
    axis: THREE.Vector3
): { swing: THREE.Quaternion; twist: THREE.Quaternion; angle: number } {
    // Project quaternion onto twist axis
    const dot = axis.x * q.x + axis.y * q.y + axis.z * q.z;
    const twist = new THREE.Quaternion(
        axis.x * dot,
        axis.y * dot,
        axis.z * dot,
        q.w
    ).normalize();

    // Swing = q * twist^(-1)
    const twistInv = twist.clone().invert();
    const swing = q.clone().multiply(twistInv);

    // Twist angle
    const angle = 2 * Math.acos(Math.min(1, Math.abs(twist.w)));
    const signedAngle = dot >= 0 ? angle : -angle;

    return { swing, twist, angle: signedAngle };
}

// ============================================================================
// UI HELPERS
// ============================================================================

/**
 * Get CSS class for gimbal lock warning display.
 */
export function getGimbalLockClass(status: GimbalLockStatus): string {
    if (status.isCritical) return 'gimbal-critical';
    if (status.isWarning) return 'gimbal-warning';
    return '';
}

/**
 * Get icon for gimbal lock status.
 */
export function getGimbalLockIcon(status: GimbalLockStatus): string {
    if (status.isCritical) return '🔴';
    if (status.isWarning) return '🟡';
    return '🟢';
}
