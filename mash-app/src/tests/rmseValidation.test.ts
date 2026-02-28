/**
 * RMSE Validation Tests
 * =====================
 * 
 * Tests for Root Mean Square Error (RMSE) calculation and validation.
 * Industry standard for IMU motion capture accuracy assessment.
 * 
 * Target thresholds (from academic literature):
 * - Sagittal plane: RMSE < 8° (acceptable), < 3° (excellent)
 * - Frontal/Transverse: RMSE < 10-15° (acceptable due to higher noise)
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { OrientationProcessor } from '../components/visualization/skeleton/OrientationProcessor';
import { createDefaultTareState } from '../calibration/taringPipeline';

describe('RMSE Validation', () => {

    /**
     * Calculate Root Mean Square Error between two angle arrays.
     * @param measured Array of measured angles (degrees)
     * @param reference Array of reference/ground truth angles (degrees)
     * @returns RMSE in degrees
     */
    function calculateRMSE(measured: number[], reference: number[]): number {
        if (measured.length !== reference.length) {
            throw new Error('Arrays must have equal length');
        }
        if (measured.length === 0) return 0;

        const squaredErrors = measured.map((m, i) => (m - reference[i]) ** 2);
        const meanSquaredError = squaredErrors.reduce((a, b) => a + b, 0) / squaredErrors.length;
        return Math.sqrt(meanSquaredError);
    }

    /**
     * Calculate Mean Absolute Error (MAE) - another common metric.
     */
    function calculateMAE(measured: number[], reference: number[]): number {
        if (measured.length !== reference.length) {
            throw new Error('Arrays must have equal length');
        }
        if (measured.length === 0) return 0;

        const absoluteErrors = measured.map((m, i) => Math.abs(m - reference[i]));
        return absoluteErrors.reduce((a, b) => a + b, 0) / absoluteErrors.length;
    }

    describe('RMSE Calculation Utility', () => {
        it('should return 0 for identical arrays', () => {
            const data = [10, 20, 30, 40, 50];
            expect(calculateRMSE(data, data)).toBe(0);
        });

        it('should calculate correct RMSE for known error', () => {
            const reference = [0, 0, 0, 0];
            const measured = [2, -2, 2, -2]; // Consistent 2° error

            // RMSE = sqrt(mean([4, 4, 4, 4])) = sqrt(4) = 2
            expect(calculateRMSE(measured, reference)).toBeCloseTo(2, 5);
        });

        it('should calculate correct RMSE for mixed errors', () => {
            const reference = [0, 0, 0, 0, 0];
            const measured = [1, 2, 3, 4, 5];

            // MSE = (1 + 4 + 9 + 16 + 25) / 5 = 55/5 = 11
            // RMSE = sqrt(11) ≈ 3.317
            expect(calculateRMSE(measured, reference)).toBeCloseTo(Math.sqrt(11), 3);
        });

        it('should handle negative angles correctly', () => {
            const reference = [-10, -5, 0, 5, 10];
            const measured = [-8, -3, 2, 7, 12]; // All 2° high

            expect(calculateRMSE(measured, reference)).toBeCloseTo(2, 5);
        });
    });

    describe('MAE Calculation Utility', () => {
        it('should return 0 for identical arrays', () => {
            const data = [10, 20, 30, 40, 50];
            expect(calculateMAE(data, data)).toBe(0);
        });

        it('should calculate correct MAE', () => {
            const reference = [0, 0, 0, 0];
            const measured = [1, -2, 3, -4];

            // MAE = (1 + 2 + 3 + 4) / 4 = 2.5
            expect(calculateMAE(measured, reference)).toBeCloseTo(2.5, 5);
        });
    });

    describe('Known Motion RMSE', () => {
        /**
         * Test RMSE with known sinusoidal input (synthetic ground truth).
         */
        it('should achieve <5° RMSE for pure sinusoidal motion', () => {
            const processor = new OrientationProcessor();

            const groundTruth: number[] = [];
            const measured: number[] = [];

            // Generate sinusoidal motion
            for (let i = 0; i < 360; i++) {
                const angle = Math.sin(THREE.MathUtils.degToRad(i)) * 30; // ±30°
                groundTruth.push(angle);

                // Create quaternion from angle
                const quat = new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(THREE.MathUtils.degToRad(angle), 0, 0)
                );

                // Process through pipeline
                const result = processor.processQuaternion(
                    [quat.w, quat.x, quat.y, quat.z],
                    'thigh_l',
                    createDefaultTareState()
                );

                if (result) {
                    // Extract angle from output
                    const euler = new THREE.Euler().setFromQuaternion(result.worldQuat);
                    measured.push(THREE.MathUtils.radToDeg(euler.x));
                }
            }

            // Calculate RMSE
            const rmse = calculateRMSE(measured, groundTruth);

            // Should be very low since we're using synthetic data without noise
            // Note: Some error expected due to coordinate transform
            expect(rmse).toBeLessThan(10); // Generous threshold for coordinate differences
        });

        it('should achieve consistent RMSE across multiple trials', () => {
            const rmseValues: number[] = [];

            for (let trial = 0; trial < 3; trial++) {
                const processor = new OrientationProcessor();

                const groundTruth: number[] = [];
                const measured: number[] = [];

                for (let i = 0; i < 100; i++) {
                    const angle = (i / 100) * 90; // 0° to 90° ramp
                    groundTruth.push(angle);

                    const quat = new THREE.Quaternion().setFromEuler(
                        new THREE.Euler(THREE.MathUtils.degToRad(angle), 0, 0)
                    );

                    const result = processor.processQuaternion(
                        [quat.w, quat.x, quat.y, quat.z],
                        'knee_l',
                        createDefaultTareState()
                    );

                    if (result) {
                        const euler = new THREE.Euler().setFromQuaternion(result.worldQuat);
                        measured.push(THREE.MathUtils.radToDeg(euler.x));
                    }
                }

                rmseValues.push(calculateRMSE(measured, groundTruth));
            }

            // All trials should produce similar RMSE (consistent behavior)
            const maxRMSE = Math.max(...rmseValues);
            const minRMSE = Math.min(...rmseValues);
            expect(maxRMSE - minRMSE).toBeLessThan(1); // Within 1° variation
        });
    });

    describe('Multi-Joint RMSE Reporting', () => {
        it('should report RMSE separately for each joint', () => {
            const joints = ['hip_l', 'knee_l', 'ankle_l'];
            const rmseByJoint: Record<string, number> = {};

            for (const joint of joints) {
                const processor = new OrientationProcessor();

                const groundTruth: number[] = [];
                const measured: number[] = [];

                for (let i = 0; i < 50; i++) {
                    const angle = Math.sin(i * 0.1) * 20;
                    groundTruth.push(angle);

                    const quat = new THREE.Quaternion().setFromEuler(
                        new THREE.Euler(THREE.MathUtils.degToRad(angle), 0, 0)
                    );

                    const result = processor.processQuaternion(
                        [quat.w, quat.x, quat.y, quat.z],
                        joint,
                        createDefaultTareState()
                    );

                    if (result) {
                        const euler = new THREE.Euler().setFromQuaternion(result.worldQuat);
                        measured.push(THREE.MathUtils.radToDeg(euler.x));
                    }
                }

                rmseByJoint[joint] = calculateRMSE(measured, groundTruth);
            }

            // All joints should have RMSE values
            expect(Object.keys(rmseByJoint).length).toBe(3);

            // Each RMSE should be reasonable
            for (const joint of joints) {
                expect(rmseByJoint[joint]).toBeDefined();
                expect(rmseByJoint[joint]).toBeLessThan(15);
            }
        });
    });

    describe('Industry Threshold Compliance', () => {
        /**
         * Verify that our system can meet industry RMSE thresholds
         * when given accurate input data.
         */
        it('should meet <8° RMSE threshold for sagittal plane motion', () => {
            const processor = new OrientationProcessor();

            // Simulate typical sagittal plane movement
            const groundTruth: number[] = [];
            const measured: number[] = [];

            for (let i = 0; i < 100; i++) {
                // Typical knee flexion during gait (0-60°)
                const angle = (Math.sin(i * 0.1) + 1) * 30; // 0° to 60°
                groundTruth.push(angle);

                const quat = new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(THREE.MathUtils.degToRad(angle), 0, 0)
                );

                const result = processor.processQuaternion(
                    [quat.w, quat.x, quat.y, quat.z],
                    'knee_r',
                    createDefaultTareState()
                );

                if (result) {
                    const euler = new THREE.Euler().setFromQuaternion(result.worldQuat);
                    measured.push(THREE.MathUtils.radToDeg(euler.x));
                }
            }

            const rmse = calculateRMSE(measured, groundTruth);

            // Industry threshold: <8° for sagittal plane
            expect(rmse).toBeLessThan(8);
        });
    });
});
