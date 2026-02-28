import { suite, test, expect } from 'vitest';
import * as THREE from 'three';
import { refinePoseWithPCA, refineZeroWithFinalPose, ANATOMICAL_AXES } from './pcaRefinement';

suite('Sandwich Calibration Logic', () => {

    test('Debug: Zero Refinement', () => {
        console.log('--- DEBUG START ---');
        console.log('ANATOMICAL_AXES keys count:', Object.keys(ANATOMICAL_AXES).length);

        const segment = 'thigh_l';
        const axis = ANATOMICAL_AXES[segment];

        if (axis) console.log(`Axis for ${segment}: [${axis.x}, ${axis.y}, ${axis.z}]`);
        else console.log(`Axis for ${segment} is UNDEFINED`);

        // Setup 10 deg error around X
        const rotationAxis = new THREE.Vector3(1, 0, 0);
        const errorQuat = new THREE.Quaternion().setFromAxisAngle(rotationAxis, 10 * Math.PI / 180);
        console.log(`ErrorQuat (10 deg X): [${errorQuat.x.toFixed(4)}, ${errorQuat.y.toFixed(4)}, ${errorQuat.z.toFixed(4)}, ${errorQuat.w.toFixed(4)}]`);

        const currentOffset = errorQuat.clone();
        const finalSensor = new THREE.Quaternion(); // Identity
        const target = new THREE.Quaternion(); // Identity

        const refined = refineZeroWithFinalPose(currentOffset, segment, finalSensor, target);
        console.log(`Refined Offset: [${refined.x.toFixed(4)}, ${refined.y.toFixed(4)}, ${refined.z.toFixed(4)}, ${refined.w.toFixed(4)}]`);

        // Verify Result Angle
        const resultBone = finalSensor.clone().multiply(refined);
        const dot = Math.abs(resultBone.dot(target));
        const angle = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;

        console.log(`Result Angle: ${angle.toFixed(5)}°`);

        // Trace inverse
        const inv = currentOffset.clone().invert();
        console.log(`Inverse Offset: [${inv.x.toFixed(4)}, ${inv.y.toFixed(4)}, ${inv.z.toFixed(4)}, ${inv.w.toFixed(4)}]`);

        expect(angle).toBeLessThan(0.1);
    });

    test('Polarity Check (Backwards Sensor)', () => {
        const segment = 'thigh_l';
        const expected = new THREE.Vector3(1, 0, 0);
        const pose = new THREE.Quaternion();
        const pca = { segment, axis: new THREE.Vector3(-1, 0, 0), confidence: 1, sampleCount: 1, isValid: true };
        const g = new THREE.Vector3(0, -1, 0);
        const refined = refinePoseWithPCA(pose, pca, expected, g);
        const angle = 2 * Math.acos(Math.abs(refined.w)) * 180 / Math.PI;
        console.log(`Polarity Check Angle: ${angle.toFixed(5)}°`);
        expect(angle).toBeLessThan(1);
    });
});
