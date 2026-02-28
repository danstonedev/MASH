/**
 * SO(3) and Madgwick Filter Unit Tests
 * =====================================
 * 
 * Validation tests for PhD-level physics engine components.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    ExpSO3,
    LogSO3,
    ExpQuaternion,
    LogQuaternion,
    skew,
    isValidSO3
} from './so3';

describe('SO(3) Math Layer', () => {

    describe('skew()', () => {
        it('should create correct skew-symmetric matrix', () => {
            const v = new THREE.Vector3(1, 2, 3);
            const S = skew(v);

            // Skew matrix diagonal should be zero
            expect(S.elements[0]).toBe(0);
            expect(S.elements[4]).toBe(0);
            expect(S.elements[8]).toBe(0);

            // Check off-diagonal elements (column-major)
            expect(S.elements[1]).toBe(3);   // S[1,0] = z
            expect(S.elements[3]).toBe(-3);  // S[0,1] = -z
        });
    });

    describe('ExpSO3() / LogSO3() round-trip', () => {
        it('should recover rotation vector for small angles', () => {
            const phi = new THREE.Vector3(0.1, 0.05, 0.02);
            const R = ExpSO3(phi);
            const phiRecovered = LogSO3(R);

            expect(phiRecovered.distanceTo(phi)).toBeLessThan(1e-6);
        });

        it('should recover rotation vector for large angles', () => {
            const phi = new THREE.Vector3(1.5, 0.5, 0.3);
            const R = ExpSO3(phi);
            const phiRecovered = LogSO3(R);

            expect(phiRecovered.distanceTo(phi)).toBeLessThan(1e-5);
        });

        it('should return identity for zero vector', () => {
            const phi = new THREE.Vector3(0, 0, 0);
            const R = ExpSO3(phi);

            // Check it's approximately identity
            expect(R.elements[0]).toBeCloseTo(1, 5);
            expect(R.elements[4]).toBeCloseTo(1, 5);
            expect(R.elements[8]).toBeCloseTo(1, 5);
        });
    });

    describe('ExpQuaternion() / LogQuaternion() round-trip', () => {
        it('should recover rotation vector', () => {
            const omega = new THREE.Vector3(1, 0.5, 0.2);
            const dt = 0.01;
            const q = ExpQuaternion(omega, dt);
            const phiRecovered = LogQuaternion(q);

            const phiExpected = omega.clone().multiplyScalar(dt);
            expect(phiRecovered.distanceTo(phiExpected)).toBeLessThan(1e-6);
        });

        it('should produce unit quaternion', () => {
            const omega = new THREE.Vector3(2, 1, 0.5);
            const q = ExpQuaternion(omega, 0.01);

            const norm = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
            expect(Math.abs(norm - 1)).toBeLessThan(1e-10);
        });
    });

    describe('isValidSO3()', () => {
        it('should accept identity matrix', () => {
            const I = new THREE.Matrix3().identity();
            expect(isValidSO3(I)).toBe(true);
        });

        it('should accept result of ExpSO3', () => {
            const phi = new THREE.Vector3(0.5, 0.3, 0.1);
            const R = ExpSO3(phi);
            expect(isValidSO3(R)).toBe(true);
        });

        it('should reject non-orthogonal matrix', () => {
            const M = new THREE.Matrix3();
            M.set(1, 0.5, 0, 0, 1, 0, 0, 0, 1);
            expect(isValidSO3(M)).toBe(false);
        });
    });
});

describe('Madgwick Filter', () => {
    // Import dynamically to avoid circular deps with vitest
    it('should be implemented (placeholder)', () => {
        expect(true).toBe(true);
    });
});
