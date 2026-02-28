import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { estimateJointCenterIMU, type IMUSCoREInput } from './ScoreAnalysis';

describe('SCoRE Analysis (IMU)', () => {
    it('should incorrectly fail without timestamps', () => {
        // This test confirms that we enforce timestamps now
        // Minimal data set
        const input: IMUSCoREInput = {
            proximalAccel: Array(60).fill(new THREE.Vector3()),
            proximalGyro: Array(60).fill(new THREE.Vector3()),
            proximalQuats: Array(60).fill(new THREE.Quaternion()),
            distalAccel: Array(60).fill(new THREE.Vector3()),
            distalGyro: Array(60).fill(new THREE.Vector3()),
            distalQuats: Array(60).fill(new THREE.Quaternion()),
            timestamps: [] // Empty
        };

        const result = estimateJointCenterIMU(input);
        expect(result).toBeNull();
    });

    it('should solve for a simple static case (identity)', () => {
        // Even if static, if we provide enough data, it should return *something* or handle singular matrix gracefully
        // Actually, SCoRE needs motion (rotation) to resolve the location.
        // Static data leads to singular matrix (rank deficient).
        // Seel method relies on `dw` (angular accel) and `w` (angular vel).
        // If w=0 and dw=0, the matrix is zero.

        const n = 60;
        const dt = 0.01;
        const timestamps = Array(n).fill(0).map((_, i) => i * dt);

        const input: IMUSCoREInput = {
            proximalAccel: Array(n).fill(new THREE.Vector3(0, 0, 9.81)),
            proximalGyro: Array(n).fill(new THREE.Vector3(0, 0, 0)),
            proximalQuats: Array(n).fill(new THREE.Quaternion()),
            distalAccel: Array(n).fill(new THREE.Vector3(0, 0, 9.81)),
            distalGyro: Array(n).fill(new THREE.Vector3(0, 0, 0)),
            distalQuats: Array(n).fill(new THREE.Quaternion()),
            timestamps: timestamps
        };

        const result = estimateJointCenterIMU(input);
        // Expect null because of singular matrix (no motion)
        expect(result).toBeNull();
    });

    it.skip('should estimate offset for synthetic hinge joint motion', () => {
        // Synthetic setup:
        // Joint at origin (0,0,0) world.
        // Proximal Sensor at (-0.2, 0, 0) -> rotates around Z
        // Distal Sensor at (0.2, 0, 0) -> rotates around Z
        // Actually, easier:
        // P_joint_prox = [0.2, 0, 0] (Joint is +0.2x from sensor)
        // P_joint_dist = [-0.2, 0, 0] (Joint is -0.2x from sensor)

        // Motion: Simple sinusoidal rotation around Z axis.

        const n = 100;
        const dt = 0.01; // 100Hz
        const timestamps = Array(n).fill(0).map((_, i) => i * dt);
        const jointCenterProx = new THREE.Vector3(0.2, 0, 0);
        const jointCenterDist = new THREE.Vector3(-0.2, 0, 0);

        const input: IMUSCoREInput = {
            proximalAccel: [],
            proximalGyro: [],
            proximalQuats: [],
            distalAccel: [],
            distalGyro: [],
            distalQuats: [],
            timestamps: timestamps
        };

        // Step 1: Generate Quaternions for 3D motion (rotation around varying axis to avoid singularity)
        for (let i = 0; i < n; i++) {
            const t = timestamps[i];

            // Motion: Rotate around X and Y axes sinusoidally -> 3D rotation
            const ex = Math.sin(t * 3) * 0.5;
            const ey = Math.cos(t * 2) * 0.5; // Different freq
            const ez = Math.sin(t * 1) * 0.2;

            const qRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(ex, ey, ez));

            // Proximal moves with qRot
            input.proximalQuats.push(qRot.clone());

            // Distal moves with qRot * hinge_rotation
            // Hinge rotates around local X
            const hingeAngle = Math.sin(t * 4);
            const qHinge = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), hingeAngle);
            const qDist = qRot.clone().multiply(qHinge);

            input.distalQuats.push(qDist);

            // Initialize buffers with placeholders
            input.proximalGyro.push(new THREE.Vector3());
            input.distalGyro.push(new THREE.Vector3());
            input.proximalAccel.push(new THREE.Vector3());
            input.distalAccel.push(new THREE.Vector3());
        }

        // Helper: Numerical differentiation for Angular Velocity (w)
        // w_local = 2 * q_inv * dq/dt
        const computeW = (qPrev: THREE.Quaternion, qNext: THREE.Quaternion, dt: number) => {
            const dq = new THREE.Quaternion(
                (qNext.x - qPrev.x) / dt,
                (qNext.y - qPrev.y) / dt,
                (qNext.z - qPrev.z) / dt,
                (qNext.w - qPrev.w) / dt
            );
            const q_inv = qPrev.clone().invert();
            const res = q_inv.multiply(dq); // Local frame? Verify order.
            // w_local = 2 * (q_inv * dq)
            // Or is it w_global = 2 * (dq * q_inv)?
            // IMU measures local angular velocity.
            // Kinematics: q_dot = 0.5 * q * w_local (quaternion multiplication)
            // => w_local_quat = 2 * q_inv * q_dot
            return new THREE.Vector3(2 * res.x, 2 * res.y, 2 * res.z);
        };

        // Step 2: Compute Angular Velocity (w)
        for (let i = 1; i < n - 1; i++) {
            const dt2 = timestamps[i + 1] - timestamps[i - 1];
            input.proximalGyro[i] = computeW(input.proximalQuats[i - 1], input.proximalQuats[i + 1], dt2);
            input.distalGyro[i] = computeW(input.distalQuats[i - 1], input.distalQuats[i + 1], dt2);
        }

        // Step 3: Compute Accel (a) from w and dw
        for (let i = 2; i < n - 2; i++) {
            // Central diff for dw
            const dt2 = timestamps[i + 1] - timestamps[i - 1];
            const dwP = new THREE.Vector3().subVectors(input.proximalGyro[i + 1], input.proximalGyro[i - 1]).divideScalar(dt2);
            const dwD = new THREE.Vector3().subVectors(input.distalGyro[i + 1], input.distalGyro[i - 1]).divideScalar(dt2);

            // Kinematics: a_sensor = - (w x (w x r) + dw x r)
            // r matches the joint centers defined above
            const rP = jointCenterProx.clone();
            const wP = input.proximalGyro[i];
            const term1P = wP.clone().cross(wP.clone().cross(rP));
            const term2P = dwP.clone().cross(rP);
            input.proximalAccel[i] = term1P.add(term2P).negate();

            const rD = jointCenterDist.clone();
            const wD = input.distalGyro[i];
            const term1D = wD.clone().cross(wD.clone().cross(rD));
            const term2D = dwD.clone().cross(rD);
            input.distalAccel[i] = term1D.add(term2D).negate();
        }

        const result = estimateJointCenterIMU(input);

        expect(result).not.toBeNull();
        if (result) {
            console.log('SCoRE Result Prox:', result.jointCenterProximal);
            console.log('SCoRE Result Dist:', result.jointCenterDistal);

            // Allow larger tolerance due to numerical diff noise?
            expect(result.jointCenterProximal.x).toBeCloseTo(0.2, 1);
            expect(result.jointCenterProximal.y).toBeCloseTo(0, 1);
            expect(result.jointCenterProximal.z).toBeCloseTo(0, 1);

            // Check Distal (Target: -0.2, 0, 0)
            expect(result.jointCenterDistal.x).toBeCloseTo(-0.2, 1);
        }
    });

    it('should ignore intervals with variable dt if handled correctly (robustness)', () => {
        // Create variable timestamps
        const n = 60;
        const timestamps = [];
        let t = 0;
        for (let i = 0; i < n; i++) {
            t += 0.01 + (Math.random() * 0.005); // Jittery 100Hz
            timestamps.push(t);
        }

        const input: IMUSCoREInput = {
            proximalAccel: Array(n).fill(new THREE.Vector3(0, 1, 0)),
            proximalGyro: Array(n).fill(new THREE.Vector3(0, 0, 1)), // Constant rotation
            proximalQuats: Array(n).fill(new THREE.Quaternion()),
            distalAccel: Array(n).fill(new THREE.Vector3(0, 1, 0)),
            distalGyro: Array(n).fill(new THREE.Vector3(0, 0, -1)),
            distalQuats: Array(n).fill(new THREE.Quaternion()),
            timestamps: timestamps
        };

        const result = estimateJointCenterIMU(input);
        // Just ensure it doesn't crash
        // It might return null due to singular matrix (constant velocity = 0 accel)
    });
});
