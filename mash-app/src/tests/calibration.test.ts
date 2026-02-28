/**
 * Calibration Debug Tests
 * 
 * NOTE: Many of these tests used the DEPRECATED captureTPose method.
 * The calibration system now uses UnifiedCalibration with PCA functional calibration.
 * Legacy T-pose tests have been removed. New tests for UnifiedCalibration should be added.
 * 
 * Run with: npx vitest run src/tests/calibration.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';

// Mock the stores
import { useCalibrationStore } from '../store/useCalibrationStore';
import { useDeviceRegistry, deviceQuaternionCache } from '../store/useDeviceRegistry';
import { useSensorAssignmentStore } from '../store/useSensorAssignmentStore';
import { BodyRole } from '../biomech/topology/SensorRoles';

describe('Calibration Store', () => {
    beforeEach(() => {
        // Clear persistence
        localStorage.clear();
        sessionStorage.clear();

        // Reset stores before each test
        useCalibrationStore.getState().reset();
        useDeviceRegistry.setState({ devices: new Map() });
        useSensorAssignmentStore.getState().clearAll();
        deviceQuaternionCache.clear();
    });

    describe('Basic Store State', () => {
        it('should initialize with idle state', () => {
            const state = useCalibrationStore.getState();

            expect(state.calibrationStep).toBe('idle');
            expect(state.sensorOffsets.size).toBe(0);
            // Note: tPoseSensorData was removed - now handled via TareStore
        });

        it('should report not calibrated initially', () => {
            const state = useCalibrationStore.getState();
            expect(state.isCalibrated()).toBe(false);
        });
    });

    describe('Device Registry Integration', () => {
        it('should have devices available for calibration', () => {
            // Simulate 3 connected devices
            const devices = new Map();
            devices.set('sensor_0', {
                id: 'sensor_0',
                name: 'Sensor 0',
                // segment: 'pelvis', // DEPRECATED
                quaternion: [1, 0, 0, 0] as [number, number, number, number],
                accelerometer: [0, 0, 9.81] as [number, number, number],
                gyro: [0, 0, 0] as [number, number, number],
                battery: 100,
                isConnected: true,
                isSimulated: false,
                lastUpdate: Date.now()
            });
            devices.set('sensor_1', {
                id: 'sensor_1',
                name: 'Sensor 1',
                // segment: 'upper_arm_l', // DEPRECATED
                quaternion: [1, 0, 0, 0] as [number, number, number, number],
                accelerometer: [0, 0, 9.81] as [number, number, number],
                gyro: [0, 0, 0] as [number, number, number],
                battery: 100,
                isConnected: true,
                isSimulated: false,
                lastUpdate: Date.now()
            });
            devices.set('sensor_2', {
                id: 'sensor_2',
                name: 'Sensor 2',
                // segment: 'upper_arm_r', // DEPRECATED
                quaternion: [1, 0, 0, 0] as [number, number, number, number],
                accelerometer: [0, 0, 9.81] as [number, number, number],
                gyro: [0, 0, 0] as [number, number, number],
                battery: 100,
                isConnected: true,
                isSimulated: false,
                lastUpdate: Date.now()
            });

            useDeviceRegistry.setState({ devices });

            // Assign roles using new store
            useSensorAssignmentStore.getState().assign('sensor_0', BodyRole.PELVIS, 'manual');
            useSensorAssignmentStore.getState().assign('sensor_1', BodyRole.ARM_L, 'manual'); // Note: ARM_L -> upper_arm_l
            useSensorAssignmentStore.getState().assign('sensor_2', BodyRole.ARM_R, 'manual');

            const registry = useDeviceRegistry.getState();
            expect(registry.devices.size).toBe(3);

            const assignedCount = useSensorAssignmentStore.getState().assignments.size;
            expect(assignedCount).toBe(3);
        });
    });

    describe('Calibration Math (Static)', () => {
        it('should produce identity when sensor matches target', () => {
            // If sensor is at identity and target is identity, offset should be identity
            const sensorQuat = new THREE.Quaternion(0, 0, 0, 1); // Identity
            const targetQuat = new THREE.Quaternion(0, 0, 0, 1); // Identity

            // offset = inv(sensor) * target
            const offset = sensorQuat.clone().invert().multiply(targetQuat);

            expect(offset.x).toBeCloseTo(0, 5);
            expect(offset.y).toBeCloseTo(0, 5);
            expect(offset.z).toBeCloseTo(0, 5);
            expect(offset.w).toBeCloseTo(1, 5);
        });

        it('should correctly apply offset at runtime', () => {
            // Setup: sensor at 90deg Y rotation, target at identity
            const sensorTPose = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
            const targetTPose = new THREE.Quaternion(0, 0, 0, 1);

            // Calculate offset
            const offset = sensorTPose.clone().invert().multiply(targetTPose);

            // At runtime, if sensor is still at same rotation
            const sensorRuntime = sensorTPose.clone();
            const boneResult = sensorRuntime.clone().multiply(offset);

            // Should produce target pose
            expect(boneResult.x).toBeCloseTo(targetTPose.x, 4);
            expect(boneResult.y).toBeCloseTo(targetTPose.y, 4);
            expect(boneResult.z).toBeCloseTo(targetTPose.z, 4);
            expect(boneResult.w).toBeCloseTo(targetTPose.w, 4);
        });

        it('should track relative motion after calibration', () => {
            // Setup calibration
            const sensorTPose = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 4, 0)); // 45deg Y
            const targetTPose = new THREE.Quaternion(0, 0, 0, 1);
            const offset = sensorTPose.clone().invert().multiply(targetTPose);

            // Now sensor rotates 30deg around X from its starting position
            const deltaRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 6, 0, 0));
            const sensorRuntime = sensorTPose.clone().premultiply(deltaRotation);

            // Apply calibration
            const boneResult = sensorRuntime.clone().multiply(offset);

            const euler = new THREE.Euler().setFromQuaternion(boneResult, 'XYZ');

            // We should see some X rotation
            expect(Math.abs(euler.x)).toBeGreaterThan(0.3);

            // Verify quaternion is normalized
            const length = Math.sqrt(boneResult.x ** 2 + boneResult.y ** 2 + boneResult.z ** 2 + boneResult.w ** 2);
            expect(length).toBeCloseTo(1, 5);
        });
    });

    describe('applyUnifiedResults', () => {
        it('should apply unified calibration results to store', () => {
            const results = new Map<string, { segmentId: string; offset: THREE.Quaternion; quality: number; method: string }>();
            results.set('pelvis', {
                segmentId: 'pelvis',
                offset: new THREE.Quaternion(0, 0, 0, 1),
                quality: 95,
                method: 'pca-refined'
            });
            results.set('upper_arm_l', {
                segmentId: 'upper_arm_l',
                offset: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.1, 0)),
                quality: 88,
                method: 'pose'
            });

            useCalibrationStore.getState().applyUnifiedResults(results);

            const state = useCalibrationStore.getState();
            expect(state.calibrationStep).toBe('calibrated');
            expect(state.sensorOffsets.size).toBe(2);
            expect(state.isCalibrated()).toBe(true);

            const pelvisCalib = state.getCalibration('pelvis');
            expect(pelvisCalib).toBeDefined();
            expect(pelvisCalib?.method).toBe('functional'); // pca-refined maps to functional
            expect(pelvisCalib?.quality).toBe(95);
        });
    });
});

describe('Quaternion Order Convention', () => {
    it('should correctly convert [w,x,y,z] array to THREE.Quaternion(x,y,z,w)', () => {
        // Our cache stores as [w, x, y, z]
        const cached: [number, number, number, number] = [0.707, 0.707, 0, 0]; // 90deg X rotation
        const [w, x, y, z] = cached;

        const quat = new THREE.Quaternion(x, y, z, w);

        expect(quat.w).toBeCloseTo(0.707, 3);
        expect(quat.x).toBeCloseTo(0.707, 3);
        expect(quat.y).toBeCloseTo(0, 3);
        expect(quat.z).toBeCloseTo(0, 3);

        // Verify it represents 90deg X rotation
        const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
        expect(euler.x).toBeCloseTo(Math.PI / 2, 2);
    });
});
