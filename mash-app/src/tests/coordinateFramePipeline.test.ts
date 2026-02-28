/**
 * Coordinate Frame Pipeline Tests
 * 
 * Research-grade tests to ensure the complete pipeline from IMU sensor
 * through calibration to bone rotation is mathematically correct.
 * 
 * This tests the critical path:
 * 1. Sensor reports quaternion in IMU frame [w,x,y,z]
 * 2. firmwareToThreeQuat converts to Three.js world frame
 * 3. Calibration offset is computed: offset = inv(sensor) * target
 * 4. At runtime: resultQuat = sensor * offset
 * 5. bone.quaternion.copy(resultQuat) - sets LOCAL rotation
 * 
 * Run with: npx vitest run src/tests/coordinateFramePipeline.test.ts
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    computeSinglePoseOffset,
    applyCalibrationOffset,
    computeCalibrationQuality
} from '../calibration/calibrationMath';
import { firmwareToThreeQuat, threeQuatToFirmware } from '../lib/math/conventions';

describe('Coordinate Frame Pipeline', () => {
    /**
     * IMU Frame (ICM-20649 convention):
     *   X: Right
     *   Y: Forward  
     *   Z: Up (gravity points -Z)
     * 
     * NEW: Firmware outputs Y-Up directly.
     * Old conversion logic removed.
     */
    describe('IMU to Three.js Frame Conversion', () => {
        /**
         * UPDATED MAPPING (2025):
         * Firmware VQF now outputs directly in Three.js Frame (Y-Up).
         * 
         * Frame:
         *   X: Right
         *   Y: Up
         *   Z: Forward (out of screen)
         * 
         * Transformation: Identity (Pass-through)
         */
        it('should convert identity correctly', () => {
            // IMU identity [w,x,y,z] = [1,0,0,0]
            const threeQuat = firmwareToThreeQuat([1, 0, 0, 0]);

            expect(threeQuat.w).toBeCloseTo(1, 5);
            expect(threeQuat.x).toBeCloseTo(0, 5);
            expect(threeQuat.y).toBeCloseTo(0, 5);
            expect(threeQuat.z).toBeCloseTo(0, 5);
        });
    });

    it('should preserve rotation magnitude during conversion', () => {
        // 90° rotation around X in IMU frame
        // IMU quaternion: [w, x, y, z] = [cos(45°), sin(45°), 0, 0]
        const angle = Math.PI / 2;
        const imuQuat: [number, number, number, number] = [
            Math.cos(angle / 2),
            Math.sin(angle / 2),
            0,
            0
        ];

        const threeQuat = firmwareToThreeQuat(imuQuat);

        // The rotation magnitude should be preserved
        const threeEuler = new THREE.Euler().setFromQuaternion(threeQuat);
        const totalAngle = Math.sqrt(threeEuler.x ** 2 + threeEuler.y ** 2 + threeEuler.z ** 2);
        expect(Math.abs(totalAngle)).toBeCloseTo(Math.PI / 2, 1);
    });

    it('should round-trip correctly', () => {
        // Create a normalized quaternion
        const original: [number, number, number, number] = [0.707, 0.3, 0.4, 0.5];
        const len = Math.sqrt(original.reduce((sum, v) => sum + v * v, 0));
        const normalized: [number, number, number, number] = original.map(v => v / len) as [number, number, number, number];

        const threeQuat = firmwareToThreeQuat(normalized);
        const backToIMU = threeQuatToFirmware(threeQuat);

        // Should get back the same values
        expect(backToIMU[0]).toBeCloseTo(normalized[0], 3);
        expect(backToIMU[1]).toBeCloseTo(normalized[1], 3);
        expect(backToIMU[2]).toBeCloseTo(normalized[2], 3);
        expect(backToIMU[3]).toBeCloseTo(normalized[3], 3);
    });
});

describe('Calibration Offset Computation', () => {
    /**
     * Calibration formula: offset = inv(sensor_calib) * target
     * At runtime: bone = sensor_runtime * offset
     * 
     * Key insight: If sensor hasn't moved since calibration,
     * bone = sensor_calib * inv(sensor_calib) * target = target
     */
    it('should produce target orientation when sensor unchanged', () => {
        // Sensor at calibration time
        const sensorCalib = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0.3, 0.5, 0.2)
        );
        // Target bone orientation in T-pose
        const target = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0.1, 0.2, 0.1)
        );

        const offset = computeSinglePoseOffset(sensorCalib, target);

        // At runtime, sensor is still at calibration position
        const sensorRuntime = sensorCalib.clone();
        const result = applyCalibrationOffset(sensorRuntime, offset);

        // Result should equal target
        expect(result.angleTo(target)).toBeCloseTo(0, 4);
    });

    it('should track relative motion after calibration', () => {
        // Calibration setup
        const sensorCalib = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, Math.PI / 4, 0) // 45° yaw
        );
        const target = new THREE.Quaternion(); // identity

        const offset = computeSinglePoseOffset(sensorCalib, target);

        // Apply 30° pitch rotation to sensor
        const pitchRotation = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(Math.PI / 6, 0, 0)
        );
        const sensorRuntime = sensorCalib.clone().premultiply(pitchRotation);

        // Apply calibration
        const result = applyCalibrationOffset(sensorRuntime, offset);

        // The result should show approximately 30° of pitch from target
        const angleDeg = target.angleTo(result) * (180 / Math.PI);
        expect(angleDeg).toBeCloseTo(30, 2);
    });

    it('should handle pelvis (root bone) correctly', () => {
        // For pelvis, target is typically near identity (standing upright)
        const sensorCalib = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0.1, 0.8, 0.05) // Sensor mounted at angle
        );
        const target = new THREE.Quaternion(); // Upright

        const offset = computeSinglePoseOffset(sensorCalib, target);
        const result = applyCalibrationOffset(sensorCalib.clone(), offset);

        // After calibration, pelvis should be upright
        expect(result.angleTo(target)).toBeCloseTo(0, 4);
    });

    it('should handle thigh (child bone) with local target', () => {
        // Thigh's local quaternion in T-pose is NOT identity
        // It's typically rotated to point downward
        const thighLocalTPose = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, 0, Math.PI) // 180° around Z (pointing down)
        );

        // Sensor on thigh in global frame during T-pose
        const sensorCalib = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0.1, 0.5, 0.2) // Arbitrary sensor orientation
        );

        // Important: target is LOCAL bone quaternion
        const offset = computeSinglePoseOffset(sensorCalib, thighLocalTPose);
        const result = applyCalibrationOffset(sensorCalib.clone(), offset);

        // Result should match the local T-pose quaternion
        expect(result.angleTo(thighLocalTPose)).toBeCloseTo(0, 4);
    });
});

describe('Quality Metrics', () => {
    it('should give 100% quality for perfect alignment', () => {
        const actual = new THREE.Quaternion();
        const expected = new THREE.Quaternion();

        const quality = computeCalibrationQuality(actual, expected);

        expect(quality.score).toBe(100);
        expect(quality.metrics.angularError).toBe(0);
    });

    it('should degrade linearly with angular error', () => {
        const expected = new THREE.Quaternion();

        // 5° error
        const actual5deg = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(5 * Math.PI / 180, 0, 0)
        );
        const quality5 = computeCalibrationQuality(actual5deg, expected);

        // 10° error
        const actual10deg = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(10 * Math.PI / 180, 0, 0)
        );
        const quality10 = computeCalibrationQuality(actual10deg, expected);

        // 10° error should have lower score than 5°
        expect(quality10.score).toBeLessThan(quality5.score);

        // Both should be above 50% for reasonable errors
        expect(quality5.score).toBeGreaterThan(70);
        expect(quality10.score).toBeGreaterThan(50);
    });
});

describe('End-to-End Pipeline Simulation', () => {
    /**
     * Simulate the complete pipeline as it runs in SkeletonModel.tsx
     */
    it('should correctly calibrate and animate a segment', () => {
        // Step 1: Sensor sends data in IMU frame [w,x,y,z]
        // Simulating sensor at 45° yaw during calibration
        const imuCalibRaw: [number, number, number, number] = [
            Math.cos(Math.PI / 8), // w
            0,                      // x
            Math.sin(Math.PI / 8), // y (yaw axis in IMU frame)
            0                       // z
        ];

        // Step 2: Convert to Three.js frame
        const sensorCalibThree = firmwareToThreeQuat(imuCalibRaw);

        // Step 3: Target is identity (bone in T-pose for pelvis)
        const target = new THREE.Quaternion();

        // Step 4: Compute offset
        const offset = computeSinglePoseOffset(sensorCalibThree, target);

        // Step 5: Verify calibration - sensor at calibration position should give target
        const resultAtCalib = applyCalibrationOffset(sensorCalibThree.clone(), offset);
        expect(resultAtCalib.angleTo(target)).toBeCloseTo(0, 4);

        // Step 6: Simulate runtime motion - sensor rotates 45° more yaw
        const imuRuntimeRaw: [number, number, number, number] = [
            Math.cos(Math.PI / 4), // w (now at 90° yaw)
            0,
            Math.sin(Math.PI / 4), // y
            0
        ];
        const sensorRuntimeThree = firmwareToThreeQuat(imuRuntimeRaw);

        // Step 7: Apply calibration
        const boneResult = applyCalibrationOffset(sensorRuntimeThree, offset);

        // Step 8: The bone should have rotated ~45° from target
        const angleDeg = target.angleTo(boneResult) * (180 / Math.PI);
        expect(angleDeg).toBeCloseTo(45, 5);
    });

    it('should preserve kinematic chain relationships', () => {
        // Parent bone (pelvis) at identity
        const parentWorld = new THREE.Quaternion();

        // Child bone (thigh) local rotation in T-pose
        const childLocalTPose = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, 0, 0.1) // Slight natural angle
        );

        // Child's world orientation = parent * local
        const childWorldTPose = parentWorld.clone().multiply(childLocalTPose);

        // Sensor on child in world frame during T-pose
        const sensorCalib = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0.2, 0.3, 0.1)
        );

        // CRITICAL: Calibration uses LOCAL target, not world!
        const offset = computeSinglePoseOffset(sensorCalib, childLocalTPose);

        // At calibration time, result should match local T-pose
        const result = applyCalibrationOffset(sensorCalib.clone(), offset);
        expect(result.angleTo(childLocalTPose)).toBeCloseTo(0, 4);

        // When set as bone.quaternion, the world result is parent * result
        const childWorldResult = parentWorld.clone().multiply(result);
        expect(childWorldResult.angleTo(childWorldTPose)).toBeCloseTo(0, 4);
    });
});

describe('Edge Cases and Failure Modes', () => {
    it('should handle gimbal lock gracefully', () => {
        // 90° pitch (gimbal lock territory)
        const sensor = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(Math.PI / 2, 0, 0)
        );
        const target = new THREE.Quaternion();

        const offset = computeSinglePoseOffset(sensor, target);
        const result = applyCalibrationOffset(sensor.clone(), offset);

        expect(result.angleTo(target)).toBeCloseTo(0, 3);
    });

    it('should handle quaternion double-cover (q = -q)', () => {
        const sensor = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5);
        const target = new THREE.Quaternion();

        const offset = computeSinglePoseOffset(sensor, target);
        const result = applyCalibrationOffset(sensor.clone(), offset);

        // Even with potential sign flip, angle should be correct
        expect(result.angleTo(target)).toBeCloseTo(0, 3);
    });

    it('should maintain unit quaternion after operations', () => {
        const sensor = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(1.2, -0.8, 2.1)
        );
        const target = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(-0.5, 1.1, 0.3)
        );

        const offset = computeSinglePoseOffset(sensor, target);
        const result = applyCalibrationOffset(sensor.clone(), offset);

        // Result should be unit quaternion
        const length = Math.sqrt(
            result.x ** 2 + result.y ** 2 + result.z ** 2 + result.w ** 2
        );
        expect(length).toBeCloseTo(1, 5);
    });
});

