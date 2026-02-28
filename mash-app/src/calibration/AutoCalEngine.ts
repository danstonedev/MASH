/**
 * Auto-Calibration Engine
 * 
 * Continuous runtime corrections that automatically improve calibration:
 * - ZUPT (Zero Velocity Update): Update gyro bias during stillness
 * - Heading Realignment: Detect straight walks and correct global yaw
 * - Constraint Softening: Pull joints back to anatomical limits
 * - Drift Compensation: Detect and counter slow yaw drift
 * 
 * All corrections are logged for ML training.
 */

import * as THREE from 'three';
import { useDeviceRegistry, deviceGyroCache, deviceAccelCache, deviceQuaternionCache } from '../store/useDeviceRegistry';
import { useTareStore } from '../store/useTareStore';
import { calibrationLogger, type CorrectionType } from './CalibrationLogger';
import { firmwareToThreeQuat } from '../lib/math/conventions';
import { useSensorAssignmentStore } from '../store/useSensorAssignmentStore';

// ============================================================================
// TYPES
// ============================================================================

export interface GyroBias {
    sensorId: string;
    bias: THREE.Vector3;
    confidence: number;
    lastUpdated: number;
}

export interface HeadingCorrection {
    yawOffset: number;  // radians
    confidence: number;
    source: 'walk' | 'manual';
    timestamp: number;
}

export interface CorrectionProposal {
    type: CorrectionType;
    sensor: string;
    magnitude: number;      // degrees
    correction: THREE.Quaternion;
    confidence: number;
}

export interface AutoCalState {
    enabled: boolean;
    gyroBiases: Map<string, GyroBias>;
    globalHeadingCorrection: HeadingCorrection | null;
    correctionsApplied: number;
    lastCorrectionTime: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// ZUPT (Zero Velocity Update)
const ZUPT_GYRO_THRESHOLD = 0.02;        // rad/s - very still
const ZUPT_MIN_DURATION_MS = 500;         // Must be still for this long
const ZUPT_BIAS_LEARNING_RATE = 0.1;      // How fast to update bias estimate

// Heading
const STRAIGHT_WALK_ACCEL_VARIANCE = 0.5; // Low lateral variance indicates straight walk
const STRAIGHT_WALK_MIN_DURATION_MS = 2000;
const HEADING_CORRECTION_MAX_DEG = 2;     // Max correction per detection

// Drift
const DRIFT_THRESHOLD_DEG_PER_SEC = 0.1;  // Degrees per second
const DRIFT_CORRECTION_RATE = 0.01;       // Slow correction

// Joint Constraints
const CONSTRAINT_SOFT_FACTOR = 0.1;       // How aggressively to pull back
const CONSTRAINT_MARGIN_DEG = 5;          // Degrees past limit before correction

// ============================================================================
// AUTO-CALIBRATION ENGINE
// ============================================================================

export class AutoCalEngine {
    private state: AutoCalState;
    private stillnessStartTime: Map<string, number> = new Map();
    private walkDetectionBuffer: THREE.Vector3[] = [];
    private walkStartTime: number = 0;
    private driftHistory: Map<string, number[]> = new Map();  // yaw over time

    constructor() {
        this.state = {
            enabled: true,
            gyroBiases: new Map(),
            globalHeadingCorrection: null,
            correctionsApplied: 0,
            lastCorrectionTime: 0,
        };
    }

    /**
     * Enable/disable auto-calibration
     */
    setEnabled(enabled: boolean): void {
        this.state.enabled = enabled;
    }

    /**
     * Process a frame of sensor data (call from SkeletonModel.useFrame)
     * Returns corrections to apply
     */
    processFrame(): CorrectionProposal[] {
        if (!this.state.enabled) return [];

        const corrections: CorrectionProposal[] = [];
        const registry = useDeviceRegistry.getState();
        const tareStore = useTareStore.getState();

        // Only run when calibrated (has tares)
        if (!tareStore.hasTares()) {
            return [];
        }

        registry.devices.forEach((device) => {
            const segment = useSensorAssignmentStore.getState().getSegmentForSensor(device.id);
            if (!segment) return;

            // 1. ZUPT - Zero Velocity Update
            const zuptCorrection = this.processZUPT(device.id, segment);
            if (zuptCorrection) {
                corrections.push(zuptCorrection);
            }

            // 2. Joint Constraint Softening
            const constraintCorrection = this.processConstraints(device.id, segment);
            if (constraintCorrection) {
                corrections.push(constraintCorrection);
            }

            // 3. Drift Detection (pelvis only for now)
            if (segment === 'pelvis') {
                const driftCorrection = this.processDrift(device.id, segment);
                if (driftCorrection) {
                    corrections.push(driftCorrection);
                }

                // 4. Straight Walk Heading
                const headingCorrection = this.processHeadingDetection(device.id);
                if (headingCorrection) {
                    corrections.push(headingCorrection);
                }
            }
        });

        // Apply and log corrections
        corrections.forEach((correction) => {
            this.applyCorrection(correction);
        });

        return corrections;
    }

    /**
     * ZUPT: Detect stillness and update gyro bias
     */
    private processZUPT(sensorId: string, segment: string): CorrectionProposal | null {
        const gyro = deviceGyroCache.get(sensorId);
        if (!gyro) return null;

        const gyroVec = new THREE.Vector3(gyro[0], gyro[1], gyro[2]);
        const magnitude = gyroVec.length();

        const now = Date.now();

        if (magnitude < ZUPT_GYRO_THRESHOLD) {
            // Sensor is still
            if (!this.stillnessStartTime.has(sensorId)) {
                this.stillnessStartTime.set(sensorId, now);
            }

            const stillDuration = now - (this.stillnessStartTime.get(sensorId) || now);

            if (stillDuration >= ZUPT_MIN_DURATION_MS) {
                // Update gyro bias estimate
                const currentBias = this.state.gyroBiases.get(sensorId)?.bias || new THREE.Vector3();
                const newBias = currentBias.clone().lerp(gyroVec, ZUPT_BIAS_LEARNING_RATE);

                this.state.gyroBiases.set(sensorId, {
                    sensorId,
                    bias: newBias,
                    confidence: Math.min(1, stillDuration / 5000), // Builds over 5s
                    lastUpdated: now,
                });

                // Only propose correction if bias is significant
                if (newBias.length() > 0.005) {
                    return {
                        type: 'zupt',
                        sensor: segment,
                        magnitude: newBias.length() * (180 / Math.PI),
                        correction: new THREE.Quaternion(), // Bias is applied differently
                        confidence: this.state.gyroBiases.get(sensorId)?.confidence || 0.5,
                    };
                }
            }
        } else {
            // No longer still
            this.stillnessStartTime.delete(sensorId);
        }

        return null;
    }

    /**
     * Constraint: Soft-pull joints back to anatomical limits
     */
    private processConstraints(sensorId: string, segment: string): CorrectionProposal | null {
        // Get current quaternion
        const quat = deviceQuaternionCache.get(sensorId);
        if (!quat) return null;

        // Convert to Euler using centralized conversion
        const threeQuat = firmwareToThreeQuat(quat);
        const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'XYZ');

        // Check against known constraints (simplified)
        const constraints = this.getConstraints(segment);
        if (!constraints) return null;

        let needsCorrection = false;
        const correctedEuler = euler.clone();

        // Check X (flexion typically)
        if (euler.x < constraints.xMin - CONSTRAINT_MARGIN_DEG * Math.PI / 180) {
            correctedEuler.x = THREE.MathUtils.lerp(euler.x, constraints.xMin, CONSTRAINT_SOFT_FACTOR);
            needsCorrection = true;
        } else if (euler.x > constraints.xMax + CONSTRAINT_MARGIN_DEG * Math.PI / 180) {
            correctedEuler.x = THREE.MathUtils.lerp(euler.x, constraints.xMax, CONSTRAINT_SOFT_FACTOR);
            needsCorrection = true;
        }

        if (needsCorrection) {
            const correctedQuat = new THREE.Quaternion().setFromEuler(correctedEuler);
            const correction = threeQuat.clone().invert().multiply(correctedQuat);

            return {
                type: 'constraint',
                sensor: segment,
                magnitude: threeQuat.angleTo(correctedQuat) * (180 / Math.PI),
                correction,
                confidence: 0.8,
            };
        }

        return null;
    }

    /**
     * Drift: Detect slow yaw drift and compensate
     */
    private processDrift(sensorId: string, segment: string): CorrectionProposal | null {
        const quat = deviceQuaternionCache.get(sensorId);
        if (!quat) return null;

        // Use centralized conversion
        const threeQuat = firmwareToThreeQuat(quat);
        const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'YXZ');
        const yaw = euler.y * (180 / Math.PI);

        // Track yaw over time
        const history = this.driftHistory.get(sensorId) || [];
        history.push(yaw);
        if (history.length > 600) history.shift();  // Keep ~10s at 60fps
        this.driftHistory.set(sensorId, history);

        // Need enough history
        if (history.length < 300) return null;  // Need ~5s

        // Calculate drift rate
        const oldYaw = history[0];
        const newYaw = history[history.length - 1];
        const timeSec = history.length / 60;
        const driftRate = (newYaw - oldYaw) / timeSec;  // deg/s

        if (Math.abs(driftRate) > DRIFT_THRESHOLD_DEG_PER_SEC) {
            // Apply small opposing correction
            const correctionDeg = -driftRate * DRIFT_CORRECTION_RATE;
            const correctionRad = correctionDeg * (Math.PI / 180);
            const correction = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(0, correctionRad, 0, 'YXZ')
            );

            return {
                type: 'drift',
                sensor: segment,
                magnitude: Math.abs(correctionDeg),
                correction,
                confidence: 0.6,
            };
        }

        return null;
    }

    /**
     * Heading: Detect straight walks and realign global yaw
     */
    private processHeadingDetection(pelvisSensorId: string): CorrectionProposal | null {
        const accel = deviceAccelCache.get(pelvisSensorId);
        if (!accel) return null;

        const accelVec = new THREE.Vector3(accel[0], accel[1], accel[2]);

        // Buffer acceleration for variance calculation
        this.walkDetectionBuffer.push(accelVec.clone());
        if (this.walkDetectionBuffer.length > 120) {  // ~2s
            this.walkDetectionBuffer.shift();
        }

        if (this.walkDetectionBuffer.length < 60) return null;

        // Calculate lateral (X) variance - low variance = straight walk
        const xValues = this.walkDetectionBuffer.map(v => v.x);
        const xMean = xValues.reduce((a, b) => a + b, 0) / xValues.length;
        const xVariance = xValues.reduce((sum, x) => sum + Math.pow(x - xMean, 2), 0) / xValues.length;

        // Calculate forward (Z) movement - should be consistent
        const zValues = this.walkDetectionBuffer.map(v => v.z);
        const zMean = Math.abs(zValues.reduce((a, b) => a + b, 0) / zValues.length);

        const now = Date.now();

        if (xVariance < STRAIGHT_WALK_ACCEL_VARIANCE && zMean > 1.0) {
            // Looks like straight walk
            if (this.walkStartTime === 0) {
                this.walkStartTime = now;
            }

            const walkDuration = now - this.walkStartTime;

            if (walkDuration >= STRAIGHT_WALK_MIN_DURATION_MS) {
                // Calculate heading from acceleration direction
                const avgAccel = new THREE.Vector3();
                this.walkDetectionBuffer.forEach(v => avgAccel.add(v));
                avgAccel.divideScalar(this.walkDetectionBuffer.length);

                // Forward direction in XZ plane
                const headingRad = Math.atan2(avgAccel.x, avgAccel.z);
                const headingDeg = headingRad * (180 / Math.PI);

                // Only correct if significantly off from forward (0°)
                if (Math.abs(headingDeg) > 2 && Math.abs(headingDeg) < HEADING_CORRECTION_MAX_DEG) {
                    const correctionRad = -headingRad * 0.1;  // Gentle correction
                    const correction = new THREE.Quaternion().setFromEuler(
                        new THREE.Euler(0, correctionRad, 0, 'YXZ')
                    );

                    this.walkStartTime = 0;  // Reset

                    return {
                        type: 'heading',
                        sensor: 'global',
                        magnitude: Math.abs(correctionRad * 180 / Math.PI),
                        correction,
                        confidence: 0.7,
                    };
                }
            }
        } else {
            this.walkStartTime = 0;  // Reset if not straight walking
        }

        return null;
    }

    /**
     * Apply correction and log it
     */
    private applyCorrection(correction: CorrectionProposal): void {
        // Log for ML
        calibrationLogger.logCorrection({
            type: correction.type,
            sensor: correction.sensor,
            magnitude: correction.magnitude,
            correction: [
                correction.correction.x,
                correction.correction.y,
                correction.correction.z,
                correction.correction.w
            ],
            confidence: correction.confidence,
            timestamp: Date.now(),
        });

        this.state.correctionsApplied++;
        this.state.lastCorrectionTime = Date.now();

        // Note: Actual application happens in SkeletonModel
        // This engine only proposes corrections
    }

    /**
     * Get anatomical constraints for a segment
     */
    private getConstraints(segment: string): { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number } | null {
        const DEG = Math.PI / 180;

        const constraints: Record<string, { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number }> = {
            // Knee - primarily flexion on X
            'tibia_l': { xMin: 0, xMax: 140 * DEG, yMin: -5 * DEG, yMax: 5 * DEG, zMin: -5 * DEG, zMax: 5 * DEG },
            'tibia_r': { xMin: 0, xMax: 140 * DEG, yMin: -5 * DEG, yMax: 5 * DEG, zMin: -5 * DEG, zMax: 5 * DEG },

            // Hip - multi-axis
            'thigh_l': { xMin: -30 * DEG, xMax: 120 * DEG, yMin: -45 * DEG, yMax: 45 * DEG, zMin: -45 * DEG, zMax: 30 * DEG },
            'thigh_r': { xMin: -30 * DEG, xMax: 120 * DEG, yMin: -45 * DEG, yMax: 45 * DEG, zMin: -30 * DEG, zMax: 45 * DEG },

            // Elbow
            'forearm_l': { xMin: 0, xMax: 145 * DEG, yMin: -90 * DEG, yMax: 90 * DEG, zMin: -5 * DEG, zMax: 5 * DEG },
            'forearm_r': { xMin: 0, xMax: 145 * DEG, yMin: -90 * DEG, yMax: 90 * DEG, zMin: -5 * DEG, zMax: 5 * DEG },
        };

        return constraints[segment] || null;
    }

    /**
     * Get current gyro bias for a sensor
     */
    getGyroBias(sensorId: string): THREE.Vector3 {
        return this.state.gyroBiases.get(sensorId)?.bias.clone() || new THREE.Vector3();
    }

    /**
     * Get stats for debugging
     */
    getStats(): {
        correctionsApplied: number;
        gyroBiasCount: number;
        lastCorrectionAge: number;
    } {
        return {
            correctionsApplied: this.state.correctionsApplied,
            gyroBiasCount: this.state.gyroBiases.size,
            lastCorrectionAge: this.state.lastCorrectionTime > 0
                ? Date.now() - this.state.lastCorrectionTime
                : -1,
        };
    }
}

// Singleton instance
export const autoCalEngine = new AutoCalEngine();
