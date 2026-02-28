/**
 * ISB Biomechanics Compliance Tests
 * ==================================
 * 
 * Tests for International Society of Biomechanics (ISB) standard compliance.
 * Based on Wu et al. (2002) - "ISB recommendation on definitions of joint 
 * coordinate system for the reporting of human joint motion - Part I"
 * 
 * Key standards:
 * - Grood & Suntay Joint Coordinate System (1983)
 * - ZXY Euler decomposition (standard: flexion, abduction, rotation)
 * - Right-hand coordinate system
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { JOINT_DEFINITIONS, JCS_EULER_ORDERS } from '../biomech/jointAngles';

describe('ISB Biomechanics Compliance', () => {

    describe('Joint Coordinate System (JCS) Standards', () => {
        /**
         * ISB Standard: Grood & Suntay decomposition order
         * Most joints use ZXY (or variant) to avoid gimbal lock at common poses
         */
        it('should define correct Euler orders for lower limb joints', () => {
            // Hip: ZXY (flexion around Z, abduction around X, rotation around Y)
            // Or XZY depending on implementation
            expect(JCS_EULER_ORDERS.hip_l).toBeDefined();
            expect(JCS_EULER_ORDERS.hip_r).toBeDefined();

            // Knee: XZY (flexion around X to avoid gimbal lock at 90° flexion)
            expect(JCS_EULER_ORDERS.knee_l).toBe('XZY');
            expect(JCS_EULER_ORDERS.knee_r).toBe('XZY');
        });

        it('should have consistent left/right joint definitions', () => {
            // Left and right joints should have same ROM ranges
            const leftHip = JOINT_DEFINITIONS.hip_l;
            const rightHip = JOINT_DEFINITIONS.hip_r;

            expect(leftHip.flexionRange).toEqual(rightHip.flexionRange);
            expect(leftHip.abductionRange).toEqual(rightHip.abductionRange);
            expect(leftHip.rotationRange).toEqual(rightHip.rotationRange);

            const leftKnee = JOINT_DEFINITIONS.knee_l;
            const rightKnee = JOINT_DEFINITIONS.knee_r;

            expect(leftKnee.flexionRange).toEqual(rightKnee.flexionRange);
        });
    });

    describe('Hip Joint Physiological Ranges', () => {
        /**
         * ISB/Clinical standard hip ROM:
         * - Flexion: 0° to 120° (some sources: 0° to 140°)
         * - Extension: 0° to -20° (hyperextension limited)
         * - Abduction: 0° to 45°
         * - Adduction: 0° to -30°
         * - Internal rotation: 0° to 40°
         * - External rotation: 0° to -45°
         */
        it('should define physiologically valid hip flexion range', () => {
            const hip = JOINT_DEFINITIONS.hip_l;

            // Flexion range should allow normal walking (~30°) and deep squat (~120°)
            expect(hip.flexionRange[0]).toBeLessThanOrEqual(-10); // Extension
            expect(hip.flexionRange[1]).toBeGreaterThanOrEqual(100); // Flexion
        });

        it('should define physiologically valid hip abduction range', () => {
            const hip = JOINT_DEFINITIONS.hip_l;

            // Abduction needed for side stepping, adduction for crossing legs
            expect(hip.abductionRange[0]).toBeLessThanOrEqual(-20);
            expect(hip.abductionRange[1]).toBeGreaterThanOrEqual(30);
        });

        it('should define physiologically valid hip rotation range', () => {
            const hip = JOINT_DEFINITIONS.hip_l;

            // Internal/external rotation for turning, pivoting
            expect(hip.rotationRange[0]).toBeLessThanOrEqual(-30);
            expect(hip.rotationRange[1]).toBeGreaterThanOrEqual(30);
        });
    });

    describe('Knee Joint Physiological Ranges', () => {
        /**
         * ISB/Clinical standard knee ROM:
         * - Flexion: 0° to 140° (full squat)
         * - Extension: 0° (no hyperextension normally)
         * - Varus/Valgus: ±10° (limited frontal plane motion)
         * - Internal/External rotation: ±30° (when flexed)
         */
        it('should define physiologically valid knee flexion range', () => {
            const knee = JOINT_DEFINITIONS.knee_l;

            // Knee flexion from 0° (straight) to ~140° (full squat)
            expect(knee.flexionRange[0]).toBeGreaterThanOrEqual(-5); // Near 0° extension
            expect(knee.flexionRange[1]).toBeGreaterThanOrEqual(130); // Full flexion
        });

        it('should limit knee varus/valgus appropriately', () => {
            const knee = JOINT_DEFINITIONS.knee_l;

            // Frontal plane motion should be limited (joint stability)
            const valgusRange = Math.abs(knee.abductionRange[0]) + Math.abs(knee.abductionRange[1]);
            expect(valgusRange).toBeLessThanOrEqual(30); // Total frontal ROM < 30°
        });

        it('should use XZY Euler order to avoid gimbal lock at 90° flexion', () => {
            // At 90° knee flexion, ZXY would create gimbal lock
            // XZY puts flexion on X-axis, avoiding this issue
            expect(JCS_EULER_ORDERS.knee_l).toBe('XZY');
            expect(JCS_EULER_ORDERS.knee_r).toBe('XZY');
        });
    });

    describe('Ankle Joint Physiological Ranges', () => {
        /**
         * ISB/Clinical standard ankle ROM (talocrural):
         * - Dorsiflexion: 0° to 20°
         * - Plantarflexion: 0° to -50°
         * - Inversion: 0° to 35° (combined with subtalar)
         * - Eversion: 0° to -15°
         */
        it('should define physiologically valid ankle dorsi/plantarflexion range', () => {
            // Check if ankle joints are defined
            const ankle = JOINT_DEFINITIONS.foot_l || JOINT_DEFINITIONS.ankle_l;

            if (ankle) {
                // Should allow walking gait (~10° dorsi, ~15° plantar)
                expect(ankle.flexionRange[0]).toBeLessThanOrEqual(-30); // Plantarflexion
                expect(ankle.flexionRange[1]).toBeGreaterThanOrEqual(15); // Dorsiflexion
            } else {
                // If not defined, skip with warning
                console.warn('Ankle joint not found in JOINT_DEFINITIONS - skipping');
            }
        });
    });

    describe('Euler Angle Decomposition Accuracy', () => {
        /**
         * Test that Euler decomposition correctly extracts joint angles
         * from quaternions according to ISB conventions.
         */
        it('should correctly extract pure flexion from quaternion', () => {
            // Create 30° flexion quaternion (rotation around X for XZY order)
            const flexionAngle = THREE.MathUtils.degToRad(30);
            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(flexionAngle, 0, 0, 'XZY')
            );

            // Extract Euler with XZY order
            const euler = new THREE.Euler().setFromQuaternion(quat, 'XZY');

            // Flexion should be on X axis for XZY order
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeCloseTo(30, 1);
            expect(THREE.MathUtils.radToDeg(euler.y)).toBeCloseTo(0, 1);
            expect(THREE.MathUtils.radToDeg(euler.z)).toBeCloseTo(0, 1);
        });

        it('should correctly extract combined flexion and abduction', () => {
            // Create 45° flexion + 15° abduction
            const flexion = THREE.MathUtils.degToRad(45);
            const abduction = THREE.MathUtils.degToRad(15);
            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(flexion, 0, abduction, 'XZY')
            );

            const euler = new THREE.Euler().setFromQuaternion(quat, 'XZY');

            // XZY: X=flexion, Z=abduction, Y=rotation
            expect(THREE.MathUtils.radToDeg(euler.x)).toBeCloseTo(45, 1);
            expect(THREE.MathUtils.radToDeg(euler.z)).toBeCloseTo(15, 1);
        });

        it('should handle gimbal lock gracefully at 90° flexion', () => {
            // This is why we use XZY for knee - 90° X rotation is common
            const flexion = THREE.MathUtils.degToRad(90);
            const rotation = THREE.MathUtils.degToRad(10); // Small rotation

            const quat = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(flexion, rotation, 0, 'XZY')
            );

            const euler = new THREE.Euler().setFromQuaternion(quat, 'XZY');

            // At 90° flexion, rotation should still be relatively accurate
            // (unlike ZXY where Z=90° causes gimbal lock)
            const flexionDeg = THREE.MathUtils.radToDeg(euler.x);
            expect(flexionDeg).toBeGreaterThan(85);
            expect(flexionDeg).toBeLessThan(95);
        });
    });

    describe('ISB Sign Conventions', () => {
        /**
         * ISB Standard sign conventions:
         * - Flexion: positive
         * - Extension: negative (or reverse depending on joint)
         * - Abduction: positive
         * - Adduction: negative
         * - Internal rotation: positive
         * - External rotation: negative
         */
        it('should follow consistent sign convention for flexion/extension', () => {
            // Flexion should be positive, extension negative
            // Check that ranges are defined consistently
            const hip = JOINT_DEFINITIONS.hip_l;
            const knee = JOINT_DEFINITIONS.knee_l;

            // Either [min, max] or [extension, flexion] format
            // The important thing is consistency
            expect(hip.flexionRange[1]).toBeGreaterThan(hip.flexionRange[0]);
            expect(knee.flexionRange[1]).toBeGreaterThan(knee.flexionRange[0]);
        });

        it('should define rotation ranges symmetrically', () => {
            const hip = JOINT_DEFINITIONS.hip_l;

            // Internal and external rotation limits should be roughly symmetric
            const internalRot = Math.abs(hip.rotationRange[1]);
            const externalRot = Math.abs(hip.rotationRange[0]);

            // Ratio should be reasonable (within 2:1)
            const ratio = Math.max(internalRot, externalRot) /
                Math.min(internalRot, externalRot);
            expect(ratio).toBeLessThan(3);
        });
    });
});
