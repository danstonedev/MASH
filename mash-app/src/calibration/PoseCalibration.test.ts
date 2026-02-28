
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeSinglePoseOffset, applyCalibrationOffset } from './calibrationMath';

/**
 * PoseCalibration Tests
 * 
 * Verifies the "Tare" math logic:
 * Offset = inv(Sensor) * Target
 * Result = Sensor * Offset
 * 
 * Specifically testing the scenario where Source (Sensor) is flat, but Target (Model) is angled.
 */

describe('Pose Calibration Logic', () => {

    // Helper: Create quaternion from Euler degrees
    const qFromDeg = (x: number, y: number, z: number) =>
        new THREE.Quaternion().setFromEuler(new THREE.Euler(
            THREE.MathUtils.degToRad(x),
            THREE.MathUtils.degToRad(y),
            THREE.MathUtils.degToRad(z),
            'XYZ'
        ));

    it('should perfectly align sensor to target when sensor matches target exactly', () => {
        const target = qFromDeg(0, 0, 0); // Identity
        const sensor = qFromDeg(0, 0, 0); // Identity

        const offset = computeSinglePoseOffset(sensor, target);
        const result = applyCalibrationOffset(sensor, offset);

        // Result should be Identity
        expect(result.x).toBeCloseTo(0);
        expect(result.y).toBeCloseTo(0);
        expect(result.z).toBeCloseTo(0);
        expect(Math.abs(result.w)).toBeCloseTo(1);
    });

    it('should correct a 90-degree sensor misalignment', () => {
        const target = qFromDeg(0, 0, 0); // Identity (Model is flat)
        const sensor = qFromDeg(90, 0, 0); // Sensor is tilted 90 degrees

        // Tare
        const offset = computeSinglePoseOffset(sensor, target);

        // Runtime
        // If sensor is still at 90 deg (user hasn't moved), result should be 0 (flat)
        const resultStatic = applyCalibrationOffset(sensor, offset);
        expect(resultStatic.x).toBeCloseTo(0);

        // If sensor moves back to 0 (user tilted back 90 deg), result should be -90
        const sensorMoved = qFromDeg(0, 0, 0);
        const resultMoved = applyCalibrationOffset(sensorMoved, offset);

        // Expected: -90 degrees pitch
        const euler = new THREE.Euler().setFromQuaternion(resultMoved);
        expect(THREE.MathUtils.radToDeg(euler.x)).toBeCloseTo(-90);
    });

    it('reproduces "Toes Pointed Down" issue: Model Feet are Plantarflexed', () => {
        // SCENARIO:
        // User stands flat: Sensor = 0 deg pitch
        // Model T-Pose default: Feet are angled down 30 deg (Plantarflexion)
        const sensorT = qFromDeg(0, 0, 0);
        const targetT = qFromDeg(-30, 0, 0); // Model points toes down 30 deg

        // Tare
        const offset = computeSinglePoseOffset(sensorT, targetT);

        // Runtime: User is standing flat (Sensor = 0)
        // What does the model look like?
        const result = applyCalibrationOffset(sensorT, offset);

        // EXPECTATION: Result should match TargetT (-30 deg)
        // This means the model will look like toes are pointed down, even though user is flat.
        const euler = new THREE.Euler().setFromQuaternion(result);
        const pitch = THREE.MathUtils.radToDeg(euler.x);

        // If pitch is -30, then the issue is confirmed:
        // Relying on the Model's T-Pose forces the user's neutral pose to look like the model's neutral pose.
        expect(pitch).toBeCloseTo(-30);
    });

    it('fix strategy: Forcing a "Flat Foot" target override', () => {
        // SCENARIO:
        // Use a "Corrected" Target for feet (0 deg) instead of Model's default (-30 deg)
        const sensorT = qFromDeg(0, 0, 0);
        const targetOverride = qFromDeg(0, 0, 0); // Force flat

        // Tare
        const offset = computeSinglePoseOffset(sensorT, targetOverride);

        // Runtime: User is standing flat
        const result = applyCalibrationOffset(sensorT, offset);

        // Result should be 0 (Flat)
        const euler = new THREE.Euler().setFromQuaternion(result);
        expect(THREE.MathUtils.radToDeg(euler.x)).toBeCloseTo(0);

        // Runtime: User points toes down 30 deg
        const sensorPoint = qFromDeg(-30, 0, 0);
        const resultPoint = applyCalibrationOffset(sensorPoint, offset);

        const eulerPoint = new THREE.Euler().setFromQuaternion(resultPoint);
        expect(THREE.MathUtils.radToDeg(eulerPoint.x)).toBeCloseTo(-30);
    });

});
