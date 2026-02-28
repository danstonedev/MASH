/**
 * Drift Monitor Module
 * ====================
 * 
 * Monitors yaw drift in real-time for research quality assessment.
 * Essential for 6-axis IMU systems without magnetometer.
 * 
 * Features:
 * - Real-time drift rate estimation
 * - ZUPT detection and drift reset
 * - Historical drift logging
 * - Quality threshold alerts
 * 
 * @module DriftMonitor
 */

import { deviceGyroCache, deviceQuaternionCache, useDeviceRegistry } from '../store/useDeviceRegistry';
import { getUncertaintyTracker } from '../lib/math/uncertainty';
import * as THREE from 'three';

// ============================================================================
// TYPES
// ============================================================================

export interface DriftState {
    /** Device ID */
    deviceId: string;

    /** Current estimated yaw drift rate (deg/min) */
    driftRateDegPerMin: number;

    /** Accumulated yaw drift since last ZUPT (degrees) */
    accumulatedDrift: number;

    /** Time since last stillness detection (ms) */
    timeSinceZUPT: number;

    /** Historical yaw values for trend analysis */
    yawHistory: { timestamp: number; yaw: number }[];

    /** Quality status */
    quality: 'excellent' | 'good' | 'acceptable' | 'poor';

    /** Is currently in stillness (ZUPT candidate) */
    isStationary: boolean;
}

export interface DriftAlert {
    type: 'drift_warning' | 'drift_critical' | 'zupt_applied' | 'recalibrate_needed';
    message: string;
    timestamp: number;
    driftRate: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** 
 * Get stillness threshold from unified settings (rad/s)
 * FIX #14: Use single source of truth for ZUPT threshold
 */
function getStillnessThreshold(): number {
    const thresholdDegS = useDeviceRegistry.getState().zuptThreshold;
    return thresholdDegS * (Math.PI / 180); // Convert deg/s to rad/s
}

/** Minimum stillness duration for ZUPT (ms) */
const MIN_STILLNESS_MS = 500;

/** Drift rate threshold for "acceptable" quality (deg/min) */
const DRIFT_THRESHOLD_ACCEPTABLE = 3.0;

/** Drift rate threshold for "poor" quality (deg/min) */
const DRIFT_THRESHOLD_POOR = 5.0;

/** Maximum yaw history samples to keep */
const MAX_HISTORY_SAMPLES = 600; // ~10 min at 1Hz

// ============================================================================
// DRIFT MONITOR CLASS
// ============================================================================

/**
 * Monitors yaw drift for a single device.
 */
export class DriftMonitor {
    private deviceId: string;
    private yawHistory: { timestamp: number; yaw: number }[] = [];
    private lastYaw: number = 0;
    private stillnessStartTime: number | null = null;
    private lastZUPTTime: number = Date.now();
    private accumulatedDrift: number = 0;
    private callbacks: ((state: DriftState) => void)[] = [];
    private alertCallbacks: ((alert: DriftAlert) => void)[] = [];

    /** Cumulative yaw correction to apply (degrees) */
    private yawCorrection: number = 0;

    /** Yaw at last ZUPT for correction calculation */
    private zuptYaw: number = 0;

    /** Whether drift correction is enabled */
    private correctionEnabled: boolean = true;

    constructor(deviceId: string) {
        this.deviceId = deviceId;
    }

    /**
     * Enable or disable drift correction.
     */
    setCorrectionEnabled(enabled: boolean): void {
        this.correctionEnabled = enabled;
    }

    /**
     * Get current yaw correction angle (degrees).
     * Apply this to orientation yaw to compensate for drift.
     */
    getYawCorrection(): number {
        return this.correctionEnabled ? this.yawCorrection : 0;
    }

    /**
     * Process a frame of data (call every ~100ms or so).
     */
    processFrame(): DriftState {
        const now = Date.now();

        // Get current sensor data
        const gyro = deviceGyroCache.get(this.deviceId);
        const quat = deviceQuaternionCache.get(this.deviceId);

        if (!quat) {
            return this.getState();
        }

        // Extract yaw from quaternion
        const [w, x, y, z] = quat;
        const threeQuat = new THREE.Quaternion(x, y, z, w);
        const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'YXZ');
        const yaw = euler.y * (180 / Math.PI);

        // Track yaw history
        this.yawHistory.push({ timestamp: now, yaw });
        if (this.yawHistory.length > MAX_HISTORY_SAMPLES) {
            this.yawHistory.shift();
        }

        // Detect stillness
        let isStationary = false;
        if (gyro) {
            const gyroMag = Math.sqrt(gyro[0] ** 2 + gyro[1] ** 2 + gyro[2] ** 2);
            isStationary = gyroMag < getStillnessThreshold();

            if (isStationary) {
                if (this.stillnessStartTime === null) {
                    this.stillnessStartTime = now;
                } else if (now - this.stillnessStartTime >= MIN_STILLNESS_MS) {
                    // Apply ZUPT
                    this.applyZUPT();
                }
            } else {
                this.stillnessStartTime = null;
            }
        }

        // Calculate accumulated drift since last ZUPT
        const yawDelta = Math.abs(yaw - this.lastYaw);
        if (yawDelta < 180) { // Avoid wraparound issues
            this.accumulatedDrift += yawDelta;
        }
        this.lastYaw = yaw;

        const state = this.getState();

        // Check for alerts
        if (state.driftRateDegPerMin > DRIFT_THRESHOLD_POOR) {
            this.emitAlert({
                type: 'drift_critical',
                message: `High yaw drift: ${state.driftRateDegPerMin.toFixed(1)}°/min`,
                timestamp: now,
                driftRate: state.driftRateDegPerMin,
            });
        } else if (state.driftRateDegPerMin > DRIFT_THRESHOLD_ACCEPTABLE) {
            this.emitAlert({
                type: 'drift_warning',
                message: `Moderate yaw drift: ${state.driftRateDegPerMin.toFixed(1)}°/min`,
                timestamp: now,
                driftRate: state.driftRateDegPerMin,
            });
        }

        // Notify subscribers
        this.callbacks.forEach(cb => cb(state));

        return state;
    }

    /**
     * Apply Zero-Velocity Update (ZUPT).
     */
    private applyZUPT(): void {
        const now = Date.now();
        const timeSinceLast = now - this.lastZUPTTime;

        // Only count as ZUPT if enough time has passed
        if (timeSinceLast < 1000) return;

        // Calculate drift rate from accumulated drift
        const driftRatePerMin = (this.accumulatedDrift / (timeSinceLast / 1000)) * 60;

        // Update uncertainty tracker
        const tracker = getUncertaintyTracker(this.deviceId);
        tracker.applyZUPT(0.5); // Moderate confidence

        // Emit alert
        this.emitAlert({
            type: 'zupt_applied',
            message: `ZUPT applied (drift was ${driftRatePerMin.toFixed(1)}°/min)`,
            timestamp: now,
            driftRate: driftRatePerMin,
        });

        // Apply yaw correction: compensate for drift since last ZUPT
        if (this.correctionEnabled) {
            const currentYaw = this.yawHistory.length > 0
                ? this.yawHistory[this.yawHistory.length - 1].yaw
                : 0;
            const yawDrift = currentYaw - this.zuptYaw;

            // Only correct if drift is significant (> 0.5°)
            if (Math.abs(yawDrift) > 0.5) {
                this.yawCorrection -= yawDrift;
            }

            this.zuptYaw = currentYaw;
        }

        // Reset tracking
        this.lastZUPTTime = now;
        this.accumulatedDrift = 0;
    }

    /**
     * Get current drift state.
     */
    getState(): DriftState {
        const now = Date.now();
        const timeSinceZUPT = now - this.lastZUPTTime;

        // Calculate drift rate
        const driftRateDegPerMin = timeSinceZUPT > 1000
            ? (this.accumulatedDrift / (timeSinceZUPT / 1000)) * 60
            : 0;

        // Determine quality
        let quality: DriftState['quality'] = 'excellent';
        if (driftRateDegPerMin > DRIFT_THRESHOLD_POOR) {
            quality = 'poor';
        } else if (driftRateDegPerMin > DRIFT_THRESHOLD_ACCEPTABLE) {
            quality = 'acceptable';
        } else if (driftRateDegPerMin > 1.0) {
            quality = 'good';
        }

        return {
            deviceId: this.deviceId,
            driftRateDegPerMin,
            accumulatedDrift: this.accumulatedDrift,
            timeSinceZUPT,
            yawHistory: this.yawHistory.slice(-60), // Last minute
            quality,
            isStationary: this.stillnessStartTime !== null,
        };
    }

    /**
     * Subscribe to state updates.
     */
    onStateChange(callback: (state: DriftState) => void): () => void {
        this.callbacks.push(callback);
        return () => {
            this.callbacks = this.callbacks.filter(cb => cb !== callback);
        };
    }

    /**
     * Subscribe to alerts.
     */
    onAlert(callback: (alert: DriftAlert) => void): () => void {
        this.alertCallbacks.push(callback);
        return () => {
            this.alertCallbacks = this.alertCallbacks.filter(cb => cb !== callback);
        };
    }

    /**
     * Emit alert to subscribers.
     */
    private emitAlert(alert: DriftAlert): void {
        this.alertCallbacks.forEach(cb => cb(alert));
    }

    /**
     * Reset drift tracking (e.g., after recalibration).
     */
    reset(): void {
        this.yawHistory = [];
        this.accumulatedDrift = 0;
        this.lastZUPTTime = Date.now();
        this.stillnessStartTime = null;
    }
}

// ============================================================================
// GLOBAL MONITORS
// ============================================================================

/** Drift monitors per device */
const monitors = new Map<string, DriftMonitor>();

/**
 * Get or create drift monitor for a device.
 */
export function getDriftMonitor(deviceId: string): DriftMonitor {
    if (!monitors.has(deviceId)) {
        monitors.set(deviceId, new DriftMonitor(deviceId));
    }
    return monitors.get(deviceId)!;
}

/**
 * Get drift state for a device.
 */
export function getDriftState(deviceId: string): DriftState | null {
    const monitor = monitors.get(deviceId);
    return monitor ? monitor.getState() : null;
}

/**
 * Format drift rate for display.
 */
export function formatDriftRate(driftRateDegPerMin: number): string {
    if (driftRateDegPerMin < 0.5) return '<0.5°/min';
    return `${driftRateDegPerMin.toFixed(1)}°/min`;
}

/**
 * Get color for drift quality.
 */
export function getDriftQualityColor(quality: DriftState['quality']): string {
    switch (quality) {
        case 'excellent': return '#22c55e';
        case 'good': return '#84cc16';
        case 'acceptable': return '#eab308';
        case 'poor': return '#ef4444';
    }
}
