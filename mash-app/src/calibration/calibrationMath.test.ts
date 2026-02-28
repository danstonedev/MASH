
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { estimateFunctionalAxis, constructGramSchmidtFrame } from './calibrationMath';

describe('Functional Calibration Math', () => {

    describe('PCA - estimateFunctionalAxis', () => {
        it('should correctly identify X axis from oscillation', () => {
            // Generate oscillating data around X axis: (0, 0, 0)
            // motion is (1, 0, 0) direction
            const samples: THREE.Vector3[] = [];
            for (let i = 0; i < 20; i++) {
                // Perfect oscillation on X
                samples.push(new THREE.Vector3(Math.sin(i * 0.5), 0, 0));
            }

            const result = estimateFunctionalAxis(samples);
            expect(result.axis.x).toBeCloseTo(1, 1); // Close to 1 or -1
            expect(result.confidence).toBeGreaterThan(0.9);
        });

        it('should handle offset data correctly (Centered PCA)', () => {
            // This test FAILS with uncentered PCA (Correlation Matrix)
            // Generate oscillating data on X, but shifted by (5, 5, 5)
            // Center of oscillation is (5, 5, 5), Axis is X.
            // If data is NOT centered, PCA will find the vector pointing to (5,5,5) as the primary axis.

            const samples: THREE.Vector3[] = [];
            const offset = new THREE.Vector3(5, 5, 5);

            for (let i = 0; i < 100; i++) {
                // Oscillation on X + Offset
                // Slower frequency (0.1) to survive low-pass STA filter
                const v = new THREE.Vector3(Math.sin(i * 0.1), 0, 0).add(offset);
                samples.push(v);
            }

            const result = estimateFunctionalAxis(samples);

            // Should still identify X axis (1, 0, 0)
            expect(Math.abs(result.axis.x)).toBeGreaterThan(0.95);
            expect(Math.abs(result.axis.y)).toBeLessThan(0.1);
            expect(Math.abs(result.axis.z)).toBeLessThan(0.1);
        });
    });

    describe('Frame Construction - constructGramSchmidtFrame', () => {
        it('should create orthogonal frame preserving primary axis', () => {
            // Primary = X-axis (1, 0, 0) [Sensor Frame]
            // Reference = Gravity (-Y) (0, -1, 0) [Sensor Frame]
            // Target Primary = (1, 0, 0) [Bone Frame]
            // Target Secondary = (0, -1, 0) [Bone Frame]

            const primary = new THREE.Vector3(1, 0, 0);
            const ref = new THREE.Vector3(0, -1, 0); // Down

            const quat = constructGramSchmidtFrame(primary, ref);

            // Since Sensor Axes match Target Axes exactly, result should be Identity quaternion
            // (1, 0, 0, 0) or (-1, 0, 0, 0)
            expect(Math.abs(quat.w)).toBeCloseTo(1, 1);

            // Verify orthogonality
            const m = new THREE.Matrix4().makeRotationFromQuaternion(quat);
            const x = new THREE.Vector3();
            const y = new THREE.Vector3();
            const z = new THREE.Vector3();
            m.extractBasis(x, y, z);

            expect(x.dot(y)).toBeCloseTo(0);
            expect(x.dot(z)).toBeCloseTo(0);
            expect(y.dot(z)).toBeCloseTo(0);
        });

        it('should fix "spin" using reference vector', () => {
            // Case where Primary axis is correct, but sensor is rolled 90 degrees around it.
            // Sensor Primary (X): (1, 0, 0)
            // Sensor Gravity is (0, 0, 1) (Z-axis in Sensor, meaning sensor is rolled)
            // Target Primary: (1, 0, 0)
            // Target Gravity: (0, -1, 0)

            const primary = new THREE.Vector3(1, 0, 0);
            const ref = new THREE.Vector3(0, 0, 1);

            const quat = constructGramSchmidtFrame(primary, ref);

            // Apply this calibration
            // We expect Sensor (1,0,0) -> Bone (1,0,0) (Primary preserved)
            const mappedPrimary = primary.clone().applyQuaternion(quat);
            expect(mappedPrimary.x).toBeCloseTo(1, 1);

            // We expect Sensor (0,0,1) -> Bone (0,-1,0) (Gravity mapped to Down)
            const mappedRef = ref.clone().applyQuaternion(quat);
            expect(mappedRef.x).toBeCloseTo(0);
            expect(mappedRef.y).toBeCloseTo(-1); // Gravity mapped to -Y
            expect(mappedRef.z).toBeCloseTo(0);
        });
    });
});
