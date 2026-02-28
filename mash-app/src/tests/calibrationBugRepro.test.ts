
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeSinglePoseOffset } from '../calibration/calibrationMath';
import { OrientationProcessor } from '../components/visualization/skeleton/OrientationProcessor';
import { createDefaultTareState } from '../calibration/taringPipeline';

describe('Calibration Backwards Logic Repro', () => {

    // 1. Verify computeSinglePoseOffset math
    it('should calculate offset that cancels error when applied via Post-Multiply', () => {
        // Setup:
        // Target = Identity (0)
        // Sensor = Rotated +90 deg (say, X axis)
        const target = new THREE.Quaternion(0, 0, 0, 1); // Identity
        const sensor = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // +90 deg X

        // Calculate Offset
        const offset = computeSinglePoseOffset(sensor, target);

        // Expectation:
        // offset should be -90 deg X to cancel +90 deg Sensor.
        // Formula: inv(sensor) * target

        // Verification 1: Does logic match expected result?
        // inv(+90) * 0 = -90.
        const sensorInv = sensor.clone().invert();
        expect(offset.angleTo(sensorInv)).toBeLessThan(0.001);

        // Verification 2: Application
        // Result = Sensor * Offset (Post-Multiply)
        const result = sensor.clone().multiply(offset);

        // Result should be Target (Identity)
        const angleToTarget = result.angleTo(target) * (180 / Math.PI);
        expect(angleToTarget).toBeLessThan(0.01);
    });

    // 2. Verify OrientationProcessor Application Logic
    it('should apply orientation correctly to bone hierarchy', () => {
        // Setup Mock Hierarchy
        // Root (Hips) -> Child (Thigh)
        const hips = new THREE.Bone();
        hips.name = 'Hips';
        const thigh = new THREE.Bone();
        thigh.name = 'Thigh';
        hips.add(thigh);

        // Set Hips to some rotation (e.g. 90 deg Y)
        // This simulates parent moving.
        hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        hips.updateMatrixWorld(true);

        // Desired Thigh World Orientation: Identity (0,0,0,1) - Vertical Up
        const desiredWorld = new THREE.Quaternion(0, 0, 0, 1);

        // Processor logic
        const processor = new OrientationProcessor();

        // Mock result from processor step 1-3
        // We bypass processQuaternion and test applyToBone directly
        // assuming processQuaternion outputs correct World Quat

        processor.applyToBone(thigh, desiredWorld);

        // Check Thigh World Quaternion
        // We need to force update to check result
        thigh.updateMatrixWorld(true);
        const actualWorld = new THREE.Quaternion();
        thigh.getWorldQuaternion(actualWorld);

        // Should match Desired World
        const error = actualWorld.angleTo(desiredWorld) * (180 / Math.PI);

        // DEBUG LOG
        const euler = new THREE.Euler().setFromQuaternion(actualWorld);
        console.log(`Desired World: Identity`);
        console.log(`Actual World: ${euler.x}, ${euler.y}, ${euler.z}`);

        expect(error).toBeLessThan(0.1);
    });
});
