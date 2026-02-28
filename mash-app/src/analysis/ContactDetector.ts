/**
 * ContactDetector - Generalized ZUPT Implementation
 * =================================================
 * 
 * Detects physical contact with the environment (ground, walls, equipment)
 * using IMU sensor data (ZUPT - Zero Velocity Update).
 * 
 * generalized for ANY end-effector (Foot, Hand, etc.), enabling detection of:
 * - Foot strikes (Walking/Running)
 * - Hand plants (Pushups, Burpees)
 * - Static hold periods
 * 
 * @module analysis/ContactDetector
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ContactState {
    /** True if sensor is in contact with environment (stationary) */
    isContact: boolean;
    /** Confidence of contact detection (0-1) */
    confidence: number;
    /** Time since contact started (ms) */
    contactDuration: number;
    /** Time since last contact ended (ms) */
    airTime: number;
}

export interface ContactEvent {
    sourceId: string;       // ID of the sensor/limb (e.g., 'foot_l', 'hand_r')
    type: 'contact_start' | 'contact_end';
    timestamp: number;
    confidence: number;
}

export interface ZUPTConfig {
    /** Accelerometer magnitude threshold relative to gravity (ratio) */
    accelThreshold: number; // e.g., 0.15 = 15% deviation from 1g
    /** Gyroscope magnitude threshold (rad/s) */
    gyroThreshold: number;
    /** Minimum duration to confirm contact (ms) */
    minContactDuration: number;
    /** Minimum duration to confirm liftoff (ms) */
    minLiftoffDuration: number;
    /** Smoothing factor for confidence (0-1) */
    smoothingFactor: number;
}

export const DEFAULT_ZUPT_CONFIG: ZUPTConfig = {
    accelThreshold: 0.15,       // 15% deviation
    gyroThreshold: 0.8,         // rad/s - slightly higher tolerance for general movement
    minContactDuration: 40,     // ms
    minLiftoffDuration: 60,     // ms
    smoothingFactor: 0.3,
};

// ============================================================================
// CONTACT DETECTOR CLASS
// ============================================================================

export class ContactDetector {
    private config: ZUPTConfig;
    private state: ContactState;

    // Transition tracking
    private transitionStart: number | null = null;
    private pendingState: boolean = false;

    // History
    private lastUpdate: number = 0;

    constructor(config: Partial<ZUPTConfig> = {}) {
        this.config = { ...DEFAULT_ZUPT_CONFIG, ...config };
        this.state = {
            isContact: true, // Assume ground start
            confidence: 0.5,
            contactDuration: 0,
            airTime: 0,
        };
    }

    /**
     * Process sensor data for a frame
     * 
     * @param accel - Accelerometer [x, y, z] in m/s²
     * @param gyro - Gyroscope [x, y, z] in rad/s
     * @param timestamp - Current timestamp in ms
     * @returns Updated ContactState
     */
    update(
        accel: [number, number, number],
        gyro: [number, number, number],
        timestamp: number,
        externalStationary?: boolean
    ): ContactState {
        const dt = this.lastUpdate > 0 ? timestamp - this.lastUpdate : 16; // Default ~16ms
        this.lastUpdate = timestamp;

        const { accelThreshold, gyroThreshold, minContactDuration, minLiftoffDuration } = this.config;

        // 1. Calculate Magnitudes
        const accelMag = Math.sqrt(accel[0] ** 2 + accel[1] ** 2 + accel[2] ** 2);
        const gyroMag = Math.sqrt(gyro[0] ** 2 + gyro[1] ** 2 + gyro[2] ** 2);

        // 2. Determine Instantaneous State
        // Check 1: Accelerometer near 1g (9.81 m/s²)?
        const accelDeviation = Math.abs(accelMag - 9.81) / 9.81;
        const accelIsStatic = accelDeviation < accelThreshold;

        // Check 2: Gyroscope near 0 rad/s?
        const gyroIsStatic = gyroMag < gyroThreshold;

        const sensorIndicatesContact = (externalStationary === true) || (accelIsStatic && gyroIsStatic);

        // 3. Compute Confidence
        // Higher confidence if we are well within thresholds
        const accelMargin = Math.max(0, 1 - (accelDeviation / accelThreshold));
        const gyroMargin = Math.max(0, 1 - (gyroMag / gyroThreshold));
        const instantConfidence = (accelMargin + gyroMargin) / 2;

        // Smooth confidence
        this.state.confidence =
            this.state.confidence * (1 - this.config.smoothingFactor) +
            instantConfidence * this.config.smoothingFactor;

        // 4. State Machine (Debounce / Hysteresis)
        if (sensorIndicatesContact !== this.pendingState) {
            // State changed (instantaneous), start timer
            this.pendingState = sensorIndicatesContact;
            this.transitionStart = timestamp;
        } else if (this.transitionStart !== null) {
            const elapsed = timestamp - this.transitionStart;
            const required = sensorIndicatesContact ? minContactDuration : minLiftoffDuration;

            if (elapsed >= required) {
                // Confirmed transition
                if (this.state.isContact !== sensorIndicatesContact) {
                    this.state.isContact = sensorIndicatesContact;

                    // Reset counters on state switch
                    if (this.state.isContact) {
                        this.state.airTime = 0;
                    } else {
                        this.state.contactDuration = 0;
                    }
                }
                this.transitionStart = null; // Reset timer
            }
        }

        // 5. Update Durations
        if (this.state.isContact) {
            this.state.contactDuration += dt;
        } else {
            this.state.airTime += dt;
        }

        return { ...this.state };
    }

    /**
     * Force reset internal state
     */
    reset() {
        this.state = {
            isContact: true,
            confidence: 0.5,
            contactDuration: 0,
            airTime: 0
        };
        this.transitionStart = null;
        this.lastUpdate = 0;
    }
}
