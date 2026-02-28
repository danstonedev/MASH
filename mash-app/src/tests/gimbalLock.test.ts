/**
 * Gimbal Lock Tests
 * =================
 * 
 * Industry-best tests for gimbal lock edge cases.
 * Critical for shoulder abduction, overhead reaching, and athletic movements.
 * 
 * Gimbal lock occurs when two rotation axes align, causing loss of one DOF.
 * - ZXY: Gimbal lock at ±90° X rotation (pitch)
 * - XZY: Gimbal lock at ±90° Z rotation (avoids knee flexion issue)
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

describe('Gimbal Lock Edge Cases', () => {

    describe('90° Pitch (X-axis) Gimbal Lock', () => {
        /**
         * ZXY order has gimbal lock at ±90° pitch.
         * This affects hip joint when leg raised horizontal.
         */
        it('should handle exactly 90° pitch', () => {
            // Create quaternion for 90° pitch
            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(Math.PI / 2, 0, 0, 'ZXY')
            );

            // Extract Euler angles using ZXY order
            const euler = new THREE.Euler().setFromQuaternion(quat, 'ZXY');

            // X rotation should be ~90°
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeCloseTo(90, 0);
        });

        it('should handle 89° pitch (just before gimbal lock)', () => {
            const pitch89 = THREE.MathUtils.degToRad(89);
            const yaw15 = THREE.MathUtils.degToRad(15);
            const roll10 = THREE.MathUtils.degToRad(10);

            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(pitch89, yaw15, roll10, 'ZXY')
            );

            const euler = new THREE.Euler().setFromQuaternion(quat, 'ZXY');

            // Should still recover angles (though with reduced precision)
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeGreaterThan(85);
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeLessThan(95);
        });

        it('should preserve combined rotation through gimbal lock zone', () => {
            // Pass through gimbal lock zone: 80° → 90° → 100° pitch
            const reference = new THREE.Quaternion();
            const results: { angle: number; recovered: number }[] = [];

            for (let pitch = 80; pitch <= 100; pitch += 5) {
                const quat = new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(THREE.MathUtils.degToRad(pitch), 0.1, 0.05, 'ZXY')
                );

                // Quaternion-based angle measurement is always valid
                const angle = THREE.MathUtils.radToDeg(reference.angleTo(quat));

                const euler = new THREE.Euler().setFromQuaternion(quat, 'ZXY');
                results.push({ angle, recovered: THREE.MathUtils.radToDeg(euler.x) });
            }

            // Quaternion angle should increase monotonically
            for (let i = 1; i < results.length; i++) {
                expect(results[i].angle).toBeGreaterThanOrEqual(results[i - 1].angle - 0.5);
            }
        });
    });

    describe('Knee Flexion (Using XZY to Avoid Gimbal Lock)', () => {
        /**
         * XZY order moves gimbal lock to Z=90°, which is rare for knees.
         * This is critical for deep squats where knee flexion > 90°.
         */
        it('should handle 90° knee flexion without gimbal lock', () => {
            const flexion90 = THREE.MathUtils.degToRad(90);

            // XZY: X is primary flexion axis
            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(flexion90, 0, 0, 'XZY')
            );

            const euler = new THREE.Euler().setFromQuaternion(quat, 'XZY');

            // Should recover exact 90° flexion
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeCloseTo(90, 1);
            expect(THREE.MathUtils.radToDeg(euler.z)).toBeCloseTo(0, 1);
        });

        it('should handle 120° knee flexion (deep squat)', () => {
            const flexion120 = THREE.MathUtils.degToRad(120);

            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(flexion120, 0, 0, 'XZY')
            );

            const euler = new THREE.Euler().setFromQuaternion(quat, 'XZY');

            // Should recover ~120° flexion
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeGreaterThan(115);
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeLessThan(125);
        });

        it('should handle knee flexion with tibial rotation', () => {
            // Real knee motion: 90° flexion with 10° internal rotation
            const flexion = THREE.MathUtils.degToRad(90);
            const rotation = THREE.MathUtils.degToRad(10);

            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(flexion, rotation, 0, 'XZY')
            );

            const euler = new THREE.Euler().setFromQuaternion(quat, 'XZY');

            // Should preserve both components
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeCloseTo(90, 2);
            expect(THREE.MathUtils.radToDeg(euler.y)).toBeCloseTo(10, 2);
        });
    });

    describe('Shoulder Abduction (Overhead Reaching)', () => {
        /**
         * Shoulder at 90° abduction is a common gimbal lock scenario.
         * Used in YXZ order for shoulder (ISB recommendation).
         */
        it('should handle 90° shoulder abduction', () => {
            // YXZ for shoulder: Y=elevation, X=rotation, Z=abduction
            const abduction90 = THREE.MathUtils.degToRad(90);

            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(0, abduction90, 0, 'YXZ')
            );

            const euler = new THREE.Euler().setFromQuaternion(quat, 'YXZ');

            expect(THREE.MathUtils.radToDeg(euler.y)).toBeCloseTo(90, 1);
        });

        it('should handle overhead reach (170° elevation)', () => {
            // Near-vertical arm position
            const elevation170 = THREE.MathUtils.degToRad(170);

            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(0, elevation170, 0, 'YXZ')
            );

            const euler = new THREE.Euler().setFromQuaternion(quat, 'YXZ');

            // Should still extract reasonable angle
            expect(THREE.MathUtils.radToDeg(Math.abs(euler.y))).toBeGreaterThan(160);
        });
    });

    describe('Quaternion SLERP Through Gimbal Lock', () => {
        /**
         * Tests smooth interpolation through gimbal lock regions.
         * Critical for animation smoothing.
         */
        it('should SLERP smoothly from 80° to 100° pitch', () => {
            const q1 = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(THREE.MathUtils.degToRad(80), 0, 0)
            );
            const q2 = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(THREE.MathUtils.degToRad(100), 0, 0)
            );

            const interpolated: number[] = [];
            for (let t = 0; t <= 1; t += 0.1) {
                const q = q1.clone().slerp(q2, t);
                interpolated.push(q.lengthSq());
            }

            // All interpolated quaternions should be normalized
            for (const len of interpolated) {
                expect(len).toBeCloseTo(1, 3);
            }
        });

        it('should maintain shortest path during SLERP near gimbal lock', () => {
            const q1 = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(THREE.MathUtils.degToRad(85), 0.1, 0.1)
            );
            const q2 = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(THREE.MathUtils.degToRad(95), -0.1, -0.1)
            );

            // Ensure quaternions are on same hemisphere
            if (q1.dot(q2) < 0) {
                q2.set(-q2.x, -q2.y, -q2.z, -q2.w);
            }

            const mid = q1.clone().slerp(q2, 0.5);

            // Midpoint should be between start and end
            const angleToStart = mid.angleTo(q1);
            const angleToEnd = mid.angleTo(q2);
            const startToEnd = q1.angleTo(q2);

            expect(angleToStart).toBeLessThan(startToEnd);
            expect(angleToEnd).toBeLessThan(startToEnd);
        });
    });

    describe('Euler Order Fallback Strategy', () => {
        /**
         * Tests strategy of using quaternion angle when near gimbal lock.
         */
        it('should detect approaching gimbal lock using second component', () => {
            // Near gimbal lock, the "middle" Euler component approaches ±90°
            const nearGimbal = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(THREE.MathUtils.degToRad(88), 0.2, 0.1, 'ZXY')
            );

            const euler = new THREE.Euler().setFromQuaternion(nearGimbal, 'ZXY');
            const middleComponent = Math.abs(THREE.MathUtils.radToDeg(euler.x));

            // When middle component > 85°, consider fallback
            const nearGimbalLock = middleComponent > 85;
            expect(nearGimbalLock).toBe(true);
        });

        it('should use quaternion-based angle measurement as fallback', () => {
            // For display purposes, use quaternion angle when Euler fails
            const q1 = new THREE.Quaternion();
            const q2 = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(THREE.MathUtils.degToRad(90), 0.3, 0.2, 'ZXY')
            );

            // Quaternion angle is always reliable
            const angleDeg = THREE.MathUtils.radToDeg(q1.angleTo(q2));

            // Should be close to the intended rotation magnitude
            expect(angleDeg).toBeGreaterThan(85);
            expect(angleDeg).toBeLessThan(95);
        });
    });
});
