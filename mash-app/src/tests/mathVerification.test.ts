
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { firmwareToThreeQuat } from '../lib/math/conventions';
import { computeMountingTare, applyMountingTare } from '../calibration/taringPipeline';

// Helper to create a specific rotation
function eulerToQuat(x: number, y: number, z: number): THREE.Quaternion {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
}

function quatToArray(q: THREE.Quaternion): [number, number, number, number] {
    return [q.w, q.x, q.y, q.z];
}

describe('Math Pipeline Verification', () => {

    it('should prove that ANY sensor orientation produces the TARGET output after taring', () => {
        // 1. Define the TARGET (Bone) orientation (e.g. T-Pose: Zero rotation)
        const targetBoneQuat = new THREE.Quaternion(); // Identity

        // 2. Simulate wacky sensor mountings
        const mountings = [
            { name: 'Perfect', q: new THREE.Quaternion() }, // Identity
            { name: 'UpsideDown', q: eulerToQuat(Math.PI, 0, 0) }, // 180 deg X
            { name: 'Sideways', q: eulerToQuat(0, 0, Math.PI / 2) }, // 90 deg Z
            { name: 'Complex', q: eulerToQuat(0.5, 0.2, -0.8) }, // Random
        ];

        mountings.forEach(({ name, q: sensorMounting }) => {
            // SCENARIO: The sensor is mounted with 'sensorMounting' rotation relative to bone.
            // If Bone is at Identity, Sensor reads 'sensorMounting'.

            // A. CAPTURE TARE (User stands in T-Pose)
            // Sensor reads 'sensorMounting' because bone is identity.
            // In ThreeJS frame:
            const rawSensorQuat = sensorMounting.clone();
            // (Skipping firmwareToThreeQuat for this step as we assume rawSensorQuat IS the global frame representation of the sensor)

            const tareResult = computeMountingTare(rawSensorQuat, targetBoneQuat);
            expect(tareResult.success).toBe(true);
            const mountingTare = tareResult.tare;

            // B. VERIFY CORRECTION
            // Apply tare to the reading. Result should represent the BONE (Identity).
            const corrected = applyMountingTare(rawSensorQuat, mountingTare);

            // Check if corrected == target
            const angle = corrected.angleTo(targetBoneQuat);
            const deg = THREE.MathUtils.radToDeg(angle);

            // console.log(`[${name}] Error: ${deg.toFixed(6)} degrees`);
            expect(deg).toBeLessThan(0.0001);
        });
    });

    it('should handle firmwareToThreeQuat conversion consistently during taring', () => {
        // 1. Simulate a physical sensor mounted upside down on a table.
        // Physical Sensor Frame (S): Z is Up. Y is Forward.
        // If Upside Down: Z points Down (World -Y). 
        // Wait, "Up" for sensor is chip normal. If chip is upside down, Z is down.
        // Gravity vector in sensor frame should be +1 Z (since it measures reaction force UP).

        // Let's stick to quaternions. 
        // Firmware sends [w, x, y, z].
        // We simulate a raw firmware quaternion for an "Upside Down" sensor.
        // Identity (Flat): [1, 0, 0, 0].
        // Upside Down (Rot 180 X): [0, 1, 0, 0].

        const rawFirmwareUpsideDown: [number, number, number, number] = [0, 1, 0, 0]; // 180 deg rotation about X

        // 2. Convert to World using conventions
        const worldQuat = firmwareToThreeQuat(rawFirmwareUpsideDown);

        // 3. This worldQuat represents the sensor in ThreeJS frame.
        // We want to Tare this to be "Identity" (Flat T-Pose).
        const target = new THREE.Quaternion(); // Identity

        // 4. Compute Tare
        const tareResult = computeMountingTare(worldQuat, target);

        // 5. Apply Tare
        const corrected = applyMountingTare(worldQuat, tareResult.tare);

        // 6. Verify success
        expect(corrected.angleTo(target)).toBeLessThan(0.0001);
    });
});
