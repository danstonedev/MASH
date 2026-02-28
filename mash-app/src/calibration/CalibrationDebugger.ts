/**
 * Calibration Debugger
 * ====================
 * 
 * Diagnostic tools for investigating post-calibration model shifts.
 * 
 * Usage from browser console:
 *   calibrationDebugger.auditPipeline()
 *   calibrationDebugger.watchSegment('thigh_r')
 *   calibrationDebugger.compareWorldVsLocal('mixamorig1RightUpLeg')
 * 
 * @module calibration/CalibrationDebugger
 */

import * as THREE from 'three';
import { useCalibrationStore } from '../store/useCalibrationStore';
import { useSensorAssignmentStore } from '../store/useSensorAssignmentStore';
import { useDeviceRegistry, deviceQuaternionCache } from '../store/useDeviceRegistry';
import { firmwareToThreeQuat } from '../lib/math/conventions';
import { getTposeTarget, logTposeTargets, TPOSE_TARGETS } from './tposeTargets';
import { SEGMENT_TO_BONE } from '../biomech/boneMapping';
import { orientationProcessor } from '../components/visualization/skeleton/OrientationProcessor';

// ============================================================================
// TYPES
// ============================================================================

interface PipelineSnapshot {
    timestamp: number;
    segment: string;
    sensorId: string;
    rawQuat: [number, number, number, number];
    worldQuat: [number, number, number, number];
    calibOffset: [number, number, number, number] | null;
    expectedTarget: [number, number, number, number];
    postCalibQuat: [number, number, number, number];
    angularErrorDeg: number;
}

interface SegmentAuditResult {
    segment: string;
    boneName: string;
    sensorId: string | null;
    hasCalibration: boolean;
    calibrationQuality: number;
    rawSensorEuler: string;
    targetEuler: string;
    offsetEuler: string;
    verificationResult: 'PASS' | 'FAIL' | 'SKIP';
    angularErrorDeg: number;
}

// ============================================================================
// CALIBRATION DEBUGGER CLASS
// ============================================================================

class CalibrationDebugger {
    private _watchedSegment: string | null = null;
    private snapshots: PipelineSnapshot[] = [];


    /**
     * Full audit of the calibration pipeline.
     * Call this after calibration to see if offsets are computed correctly.
     */
    auditPipeline(): void {
        console.log('\n========================================');
        console.log('   CALIBRATION PIPELINE AUDIT');
        console.log('========================================\n');

        const calStore = useCalibrationStore.getState();
        const assignStore = useSensorAssignmentStore.getState();
        const deviceStore = useDeviceRegistry.getState();

        console.log(`Calibration Step: ${calStore.calibrationStep}`);
        console.log(`Total Offsets Stored: ${calStore.sensorOffsets.size}`);
        console.log(`Connected Devices: ${deviceStore.devices.size}\n`);

        // Log all T-pose targets
        console.log('--- T-POSE TARGETS (Expected Sensor Orientations) ---');
        logTposeTargets();
        console.log('');

        // Audit each calibrated segment
        const results: SegmentAuditResult[] = [];

        calStore.sensorOffsets.forEach((calibData, segment) => {
            const boneName = SEGMENT_TO_BONE[segment] || SEGMENT_TO_BONE[segment.toLowerCase()];

            // Find sensor assigned to this segment
            let sensorId: string | null = null;
            deviceStore.devices.forEach((device) => {
                const deviceSegment = assignStore.getSegmentForSensor(device.id);
                if (deviceSegment === segment) {
                    sensorId = device.id;
                }
            });

            const targetQuat = getTposeTarget(segment);
            const offsetQuat = calibData.offset;

            // Convert to Euler for human-readable output
            const targetEuler = this.quatToEulerStr(targetQuat);
            const offsetEuler = this.quatToEulerStr(offsetQuat);

            // Get current sensor reading (if available)
            let rawSensorEuler = 'N/A';
            let verificationResult: 'PASS' | 'FAIL' | 'SKIP' = 'SKIP';
            let angularErrorDeg = 0;

            if (sensorId) {
                const rawQuat = deviceQuaternionCache.get(sensorId);
                if (rawQuat) {
                    const sensorWorld = firmwareToThreeQuat(rawQuat);
                    rawSensorEuler = this.quatToEulerStr(sensorWorld);

                    // Verification: sensor * offset should ≈ target
                    const calibrated = sensorWorld.clone().multiply(offsetQuat);
                    angularErrorDeg = calibrated.angleTo(targetQuat) * (180 / Math.PI);

                    // PASS if < 5°, FAIL otherwise
                    verificationResult = angularErrorDeg < 5 ? 'PASS' : 'FAIL';
                }
            }

            results.push({
                segment,
                boneName: boneName || 'UNKNOWN',
                sensorId,
                hasCalibration: true,
                calibrationQuality: calibData.quality,
                rawSensorEuler,
                targetEuler,
                offsetEuler,
                verificationResult,
                angularErrorDeg,
            });
        });

        // Print results table
        console.log('--- CALIBRATION VERIFICATION ---');
        console.table(results.map(r => ({
            Segment: r.segment,
            Bone: r.boneName,
            Sensor: r.sensorId || '-',
            Quality: `${r.calibrationQuality.toFixed(0)}%`,
            Target: r.targetEuler,
            Offset: r.offsetEuler,
            Error: `${r.angularErrorDeg.toFixed(1)}°`,
            Status: r.verificationResult,
        })));

        // Summary
        const passCount = results.filter(r => r.verificationResult === 'PASS').length;
        const failCount = results.filter(r => r.verificationResult === 'FAIL').length;
        const skipCount = results.filter(r => r.verificationResult === 'SKIP').length;

        console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL, ${skipCount} SKIP`);

        if (failCount > 0) {
            console.log('\n[!] FAILURES DETECTED - Check the following:');
            results.filter(r => r.verificationResult === 'FAIL').forEach(r => {
                console.log(`    - ${r.segment}: ${r.angularErrorDeg.toFixed(1)}° error`);
            });
        }

        console.log('\n========================================\n');
    }

    /**
     * Watch a specific segment's orientation pipeline in real-time.
     * Logs every 60 frames (~1/sec at 60fps).
     * 
     * @param segment - Segment ID to watch (e.g., 'thigh_r')
     */
    watchSegment(segment: string): void {
        this._watchedSegment = segment;
        orientationProcessor.setDebugSegment(segment);
        console.log(`[CalibDebug] Now watching segment: ${segment}`);
        console.log(`[CalibDebug] Logs will appear every ~1 second`);
    }

    /**
     * Stop watching any segment.
     */
    stopWatching(): void {
        this._watchedSegment = null;
        orientationProcessor.setDebugSegment(null);
        console.log(`[CalibDebug] Stopped watching`);
    }

    /**
     * Capture a snapshot of the current pipeline state.
     */
    captureSnapshot(segment: string): PipelineSnapshot | null {
        const calStore = useCalibrationStore.getState();
        const assignStore = useSensorAssignmentStore.getState();
        const deviceStore = useDeviceRegistry.getState();

        // Find sensor for segment
        let sensorId: string | null = null;
        deviceStore.devices.forEach((device) => {
            if (assignStore.getSegmentForSensor(device.id) === segment) {
                sensorId = device.id;
            }
        });

        if (!sensorId) {
            console.warn(`[CalibDebug] No sensor assigned to ${segment}`);
            return null;
        }

        const rawQuat = deviceQuaternionCache.get(sensorId);
        if (!rawQuat) {
            console.warn(`[CalibDebug] No quaternion data for ${sensorId}`);
            return null;
        }

        const worldQuat = firmwareToThreeQuat(rawQuat);
        const calibData = calStore.getCalibration(segment);
        const targetQuat = getTposeTarget(segment);

        let postCalibQuat = worldQuat.clone();
        if (calibData) {
            postCalibQuat = worldQuat.clone().multiply(calibData.offset);
        }

        const angularErrorDeg = postCalibQuat.angleTo(targetQuat) * (180 / Math.PI);

        const snapshot: PipelineSnapshot = {
            timestamp: Date.now(),
            segment,
            sensorId,
            rawQuat: rawQuat,
            worldQuat: worldQuat.toArray() as [number, number, number, number],
            calibOffset: calibData ? calibData.offset.toArray() as [number, number, number, number] : null,
            expectedTarget: targetQuat.toArray() as [number, number, number, number],
            postCalibQuat: postCalibQuat.toArray() as [number, number, number, number],
            angularErrorDeg,
        };

        this.snapshots.push(snapshot);
        if (this.snapshots.length > 100) {
            this.snapshots.shift();
        }

        return snapshot;
    }

    /**
     * Compare world quaternion vs local quaternion for a bone.
     * Helps debug world-to-local transform issues.
     * 
     * @param boneName - Three.js bone name (e.g., 'mixamorig1RightUpLeg')
     */
    compareWorldVsLocal(boneName: string): void {
        // This needs to be called with access to the scene
        console.log(`[CalibDebug] To compare world/local for ${boneName}:`);
        console.log(`  1. Open React DevTools`);
        console.log(`  2. Find the SkeletonModel component`);
        console.log(`  3. Run: bonesRef.current.get('${boneName}')`);
        console.log(`  4. Check bone.quaternion (local) vs bone.getWorldQuaternion()`);
    }

    /**
     * Test quaternion multiplication order.
     * Print results of both multiplication orders to help debug.
     */
    testMultiplicationOrder(segment: string): void {
        const calStore = useCalibrationStore.getState();
        const assignStore = useSensorAssignmentStore.getState();
        const deviceStore = useDeviceRegistry.getState();

        // Find sensor
        let sensorId: string | null = null;
        deviceStore.devices.forEach((device) => {
            if (assignStore.getSegmentForSensor(device.id) === segment) {
                sensorId = device.id;
            }
        });

        if (!sensorId) {
            console.warn(`No sensor for ${segment}`);
            return;
        }

        const rawQuat = deviceQuaternionCache.get(sensorId);
        if (!rawQuat) {
            console.warn(`No data for ${sensorId}`);
            return;
        }

        const sensorWorld = firmwareToThreeQuat(rawQuat);
        const calibData = calStore.getCalibration(segment);
        if (!calibData) {
            console.warn(`No calibration for ${segment}`);
            return;
        }

        const targetQuat = getTposeTarget(segment);

        // Method A: sensor * offset (current implementation)
        const resultA = sensorWorld.clone().multiply(calibData.offset);
        const errorA = resultA.angleTo(targetQuat) * 180 / Math.PI;

        // Method B: offset * sensor (alternative)
        const resultB = calibData.offset.clone().multiply(sensorWorld);
        const errorB = resultB.angleTo(targetQuat) * 180 / Math.PI;

        console.log(`[CalibDebug] Quaternion Order Test for ${segment}:`);
        console.log(`  Target: ${this.quatToEulerStr(targetQuat)}`);
        console.log(`  Method A (sensor * offset): ${this.quatToEulerStr(resultA)} - Error: ${errorA.toFixed(1)}°`);
        console.log(`  Method B (offset * sensor): ${this.quatToEulerStr(resultB)} - Error: ${errorB.toFixed(1)}°`);
        console.log(`  ${errorA < errorB ? 'Current method (A) is better' : errorB < errorA ? '⚠️ Method B might be better!' : 'Same error'}`);
    }

    /**
     * Print all stored snapshots.
     */
    printSnapshots(): void {
        console.log('[CalibDebug] Recent Snapshots:');
        console.table(this.snapshots.map(s => ({
            Time: new Date(s.timestamp).toISOString().substr(11, 8),
            Segment: s.segment,
            Error: `${s.angularErrorDeg.toFixed(1)}°`,
            PostCalib: `[${s.postCalibQuat.map(v => v.toFixed(2)).join(', ')}]`,
        })));
    }

    /**
     * Check segment ID case sensitivity issues.
     */
    checkSegmentCases(): void {
        console.log('[CalibDebug] Segment ID Case Analysis:');

        const tposeKeys = Object.keys(TPOSE_TARGETS);
        const boneMapKeys = Object.keys(SEGMENT_TO_BONE);

        console.log('T-Pose Target Keys:', tposeKeys);
        console.log('Bone Mapping Keys:', boneMapKeys);

        // Find mismatches
        const tposeSet = new Set(tposeKeys.map(k => k.toLowerCase()));
        const boneSet = new Set(boneMapKeys.map(k => k.toLowerCase()));

        const inTposeNotBone = tposeKeys.filter(k => !boneSet.has(k.toLowerCase()));
        const inBoneNotTpose = boneMapKeys.filter(k => !tposeSet.has(k.toLowerCase()));

        if (inTposeNotBone.length > 0) {
            console.warn('In TPOSE_TARGETS but not SEGMENT_TO_BONE:', inTposeNotBone);
        }
        if (inBoneNotTpose.length > 0) {
            console.warn('In SEGMENT_TO_BONE but not TPOSE_TARGETS:', inBoneNotTpose);
        }
    }

    // ========================================================================
    // HELPER METHODS
    // ========================================================================

    private quatToEulerStr(q: THREE.Quaternion): string {
        const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
        const r2d = (rad: number) => (rad * 180 / Math.PI).toFixed(1);
        return `[${r2d(e.x)}, ${r2d(e.y)}, ${r2d(e.z)}]`;
    }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const calibrationDebugger = new CalibrationDebugger();

// Expose to window for console access
(window as any).calibrationDebugger = calibrationDebugger;
(window as any).CalibrationDebugger = CalibrationDebugger;

console.log('[CalibDebug] Debugger loaded. Access via `calibrationDebugger` in console.');
console.log('[CalibDebug] Commands: auditPipeline(), watchSegment(id), testMultiplicationOrder(id)');
