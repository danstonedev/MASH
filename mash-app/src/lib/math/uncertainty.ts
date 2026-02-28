/**
 * Uncertainty Quantification Module
 * ==================================
 * 
 * Provides statistical uncertainty estimates for IMU orientations.
 * Essential for research-quality output - no journal accepts kinematics
 * without error bounds.
 * 
 * Key concepts:
 * - Gyroscope noise propagates to orientation uncertainty
 * - Accelerometer corrections reduce uncertainty (when stationary)
 * - Yaw drift accumulates unbounded without magnetometer
 * 
 * References:
 * - Titterton & Weston, "Strapdown Inertial Navigation Technology"
 * - Madgwick, "An efficient orientation filter for inertial sensors"
 * 
 * @module uncertainty
 */

import * as THREE from 'three';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Orientation with uncertainty estimate.
 * 
 * The uncertainty is expressed as angular standard deviation (1σ)
 * for each Euler axis. This is a simplified representation -
 * a full treatment would use the orientation error quaternion covariance.
 */
export interface OrientationWithUncertainty {
    /** Orientation quaternion */
    quaternion: THREE.Quaternion;

    /** Angular uncertainty (1σ) in radians for [roll, pitch, yaw] */
    uncertaintyRPY: [number, number, number];

    /** Timestamp of this estimate */
    timestamp: number;

    /** Quality score 0-1 (based on recent sensor activity) */
    quality: number;
}

/**
 * Sensor noise parameters (calibrated per device).
 */
export interface SensorNoiseParams {
    /** Gyroscope noise density (rad/s/√Hz) */
    gyroNoiseDensity: number;

    /** Gyroscope random walk (rad/s²/√Hz) */
    gyroRandomWalk: number;

    /** Accelerometer noise density (m/s²/√Hz) */
    accelNoiseDensity: number;

    /** Sample rate (Hz) */
    sampleRate: number;
}

/**
 * Drift metrics for yaw characterization.
 */
export interface DriftMetrics {
    /** Estimated yaw drift rate (rad/s) */
    yawDriftRate: number;

    /** Yaw drift rate in degrees per minute */
    yawDriftDegPerMin: number;

    /** Time since last ZUPT correction (ms) */
    timeSinceZUPT: number;

    /** Accumulated yaw uncertainty since last ZUPT (rad) */
    accumulatedYawUncertainty: number;
}

// ============================================================================
// DEFAULT PARAMETERS
// ============================================================================

/**
 * Typical MEMS IMU noise parameters.
 * 
 * These are reasonable defaults for ICM-20649 class sensors.
 * Should be calibrated per-device for research use.
 */
export const DEFAULT_NOISE_PARAMS: SensorNoiseParams = {
    // ICM-20649 typical values from datasheet
    gyroNoiseDensity: 0.004,      // rad/s/√Hz (~0.23 °/s/√Hz)
    gyroRandomWalk: 0.00003,      // rad/s²/√Hz (bias instability)
    accelNoiseDensity: 0.0004,    // m/s²/√Hz (~0.04 mg/√Hz)
    sampleRate: 200,              // Hz (industry standard for sports)
};

// ============================================================================
// UNCERTAINTY PROPAGATION
// ============================================================================

/**
 * Uncertainty propagation state.
 * 
 * Tracks angular uncertainty as it accumulates from gyro integration
 * and decreases from accelerometer corrections.
 */
export class UncertaintyTracker {
    /** Current uncertainty variance for [roll, pitch, yaw] in rad² */
    private varianceRPY: [number, number, number] = [0, 0, 0];

    /** Noise parameters */
    private params: SensorNoiseParams;

    /** Last ZUPT time for drift tracking */
    private lastZUPTTime: number = 0;

    /** Accumulated yaw variance since ZUPT */
    private yawVarianceSinceZUPT: number = 0;

    constructor(params: SensorNoiseParams = DEFAULT_NOISE_PARAMS) {
        this.params = params;
        this.lastZUPTTime = Date.now();
    }

    /**
     * Update uncertainty after gyro integration.
     * 
     * Gyro noise increases orientation uncertainty:
     * σ²(t+dt) = σ²(t) + (σ_gyro)² * dt
     * 
     * @param dt Time step in seconds
     */
    propagateGyro(dt: number): void {
        const gyroVariancePerSample = Math.pow(this.params.gyroNoiseDensity, 2) / this.params.sampleRate;

        // All axes accumulate uncertainty from gyro noise
        this.varianceRPY[0] += gyroVariancePerSample * dt;
        this.varianceRPY[1] += gyroVariancePerSample * dt;
        this.varianceRPY[2] += gyroVariancePerSample * dt;

        // Yaw also accumulates bias drift
        const biasWalkVariance = Math.pow(this.params.gyroRandomWalk, 2) * dt;
        this.varianceRPY[2] += biasWalkVariance;
        this.yawVarianceSinceZUPT += gyroVariancePerSample * dt + biasWalkVariance;
    }

    /**
     * Update uncertainty after accelerometer correction.
     * 
     * When the accelerometer provides a gravity reference,
     * roll and pitch uncertainty decreases. Yaw is unobservable
     * from accelerometer alone.
     * 
     * @param correctionStrength How much the filter trusted accel (0-1)
     */
    applyAccelCorrection(correctionStrength: number): void {
        // Accelerometer can only correct tilt (roll/pitch), not yaw
        const accelVariance = Math.pow(this.params.accelNoiseDensity, 2);

        // Kalman-style update: reduce variance based on correction strength
        // σ²_new = (1 - K) * σ²_old + K * σ²_accel
        // K = correctionStrength (effective Kalman gain)
        const K = Math.min(1, correctionStrength);

        this.varianceRPY[0] = (1 - K) * this.varianceRPY[0] + K * accelVariance;
        this.varianceRPY[1] = (1 - K) * this.varianceRPY[1] + K * accelVariance;
        // Yaw unchanged - accelerometer can't observe it
    }

    /**
     * Apply ZUPT (Zero-velocity Update) to reduce yaw uncertainty.
     * 
     * During stillness, gyro bias can be estimated, reducing
     * the yaw drift rate temporarily.
     * 
     * @param biasConfidence How well the bias was estimated (0-1)
     */
    applyZUPT(biasConfidence: number): void {
        // Reduce yaw variance based on bias estimation quality
        const reduction = 0.5 * biasConfidence; // Up to 50% reduction
        this.varianceRPY[2] *= (1 - reduction);

        // Reset ZUPT tracking
        this.lastZUPTTime = Date.now();
        this.yawVarianceSinceZUPT = 0;
    }

    /**
     * Get current uncertainty as 1σ standard deviations.
     */
    getUncertaintyRPY(): [number, number, number] {
        return [
            Math.sqrt(this.varianceRPY[0]),
            Math.sqrt(this.varianceRPY[1]),
            Math.sqrt(this.varianceRPY[2]),
        ];
    }

    /**
     * Get uncertainty in degrees for display.
     */
    getUncertaintyDegrees(): [number, number, number] {
        const rad = this.getUncertaintyRPY();
        return [
            rad[0] * (180 / Math.PI),
            rad[1] * (180 / Math.PI),
            rad[2] * (180 / Math.PI),
        ];
    }

    /**
     * Get drift metrics for monitoring.
     */
    getDriftMetrics(): DriftMetrics {
        const timeSinceZUPT = Date.now() - this.lastZUPTTime;
        const accumulatedYawStd = Math.sqrt(this.yawVarianceSinceZUPT);

        // Estimate drift rate from accumulated uncertainty
        const driftRateRadPerSec = timeSinceZUPT > 0
            ? accumulatedYawStd / (timeSinceZUPT / 1000)
            : 0;

        return {
            yawDriftRate: driftRateRadPerSec,
            yawDriftDegPerMin: driftRateRadPerSec * (180 / Math.PI) * 60,
            timeSinceZUPT,
            accumulatedYawUncertainty: accumulatedYawStd,
        };
    }

    /**
     * Compute overall quality score based on uncertainty.
     * 
     * @returns Quality 0-1 (1 = excellent, 0 = poor)
     */
    getQualityScore(): number {
        const [rollStd, pitchStd, yawStd] = this.getUncertaintyDegrees();

        // Quality degrades as uncertainty increases
        // Thresholds based on typical biomechanics requirements:
        // - <2° = excellent
        // - 2-5° = good
        // - 5-10° = acceptable
        // - >10° = poor

        const avgUncertainty = (rollStd + pitchStd + yawStd) / 3;

        if (avgUncertainty < 2) return 1.0;
        if (avgUncertainty < 5) return 0.8 - (avgUncertainty - 2) * 0.05;
        if (avgUncertainty < 10) return 0.6 - (avgUncertainty - 5) * 0.08;
        return Math.max(0.1, 0.2 - (avgUncertainty - 10) * 0.02);
    }

    /**
     * Reset uncertainty state (e.g., after recalibration).
     */
    reset(): void {
        this.varianceRPY = [0, 0, 0];
        this.lastZUPTTime = Date.now();
        this.yawVarianceSinceZUPT = 0;
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format uncertainty for display.
 * 
 * @param uncertaintyDeg Uncertainty in degrees
 * @returns Human-readable string like "±2.3°"
 */
export function formatUncertainty(uncertaintyDeg: number): string {
    return `±${uncertaintyDeg.toFixed(1)}°`;
}

/**
 * Assess if uncertainty is acceptable for research.
 * 
 * Based on biomechanics literature, <5° is typically acceptable
 * for joint angle measurement.
 * 
 * @param uncertaintyDeg Uncertainty in degrees
 * @returns Assessment object
 */
export function assessUncertainty(uncertaintyDeg: number): {
    level: 'excellent' | 'good' | 'acceptable' | 'poor';
    message: string;
    color: string;
} {
    if (uncertaintyDeg < 2) {
        return { level: 'excellent', message: 'Research quality', color: '#22c55e' };
    } else if (uncertaintyDeg < 5) {
        return { level: 'good', message: 'Acceptable for analysis', color: '#84cc16' };
    } else if (uncertaintyDeg < 10) {
        return { level: 'acceptable', message: 'High uncertainty - use caution', color: '#eab308' };
    } else {
        return { level: 'poor', message: 'Unreliable - recalibrate', color: '#ef4444' };
    }
}

/**
 * Create an OrientationWithUncertainty from separate components.
 */
export function createOrientationWithUncertainty(
    quaternion: THREE.Quaternion,
    tracker: UncertaintyTracker
): OrientationWithUncertainty {
    return {
        quaternion: quaternion.clone(),
        uncertaintyRPY: tracker.getUncertaintyRPY(),
        timestamp: Date.now(),
        quality: tracker.getQualityScore(),
    };
}

// ============================================================================
// SINGLETON TRACKERS
// ============================================================================

/** 
 * Global uncertainty trackers per device.
 * Maps deviceId -> UncertaintyTracker
 */
export const deviceUncertaintyTrackers = new Map<string, UncertaintyTracker>();

/**
 * Get or create uncertainty tracker for a device.
 */
export function getUncertaintyTracker(deviceId: string): UncertaintyTracker {
    if (!deviceUncertaintyTrackers.has(deviceId)) {
        deviceUncertaintyTrackers.set(deviceId, new UncertaintyTracker());
    }
    return deviceUncertaintyTrackers.get(deviceId)!;
}
