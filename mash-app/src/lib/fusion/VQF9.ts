/**
 * VQF9 - 9-Axis Versatile Quaternion-based Filter
 * 
 * Enhanced sensor fusion with magnetometer support for heading correction.
 * Extends the 6-axis VQF with:
 * - Magnetometer fusion with hard/soft iron calibration
 * - Magnetic disturbance detection and rejection
 * - Adaptive correction gains based on motion state
 * - External acceleration detection
 * 
 * References:
 * - Laidig et al. 2021: VQF: Highly Accurate IMU Orientation Estimation
 * - Madgwick 2010: An efficient orientation filter for inertial and inertial/magnetic sensor arrays
 * - Kok et al. 2017: Using inertial sensors for position and orientation estimation
 * 
 * @module lib/fusion/VQF9
 */

import * as THREE from 'three';
import { MagnetometerCalibrator, type MagCalibrationResult } from './MagnetometerCalibration';
import { MagneticDisturbanceDetector, type MagDisturbanceState } from './MagneticDisturbanceDetector';

// ============================================================================
// INTERFACES
// ============================================================================

export interface VQF9Params {
    // Accelerometer parameters
    /** Time constant for accelerometer correction (s). Default 1.5 */
    tauAcc: number;
    /** Acceleration threshold for rest detection (m/s²). Default 0.2 */
    restThAcc: number;
    
    // Gyroscope parameters
    /** Gyroscope threshold for rest detection (rad/s). Default 0.03 */
    restThGyro: number;
    /** Initial gyro bias (rad/s). Default [0,0,0] */
    initialBias: [number, number, number];
    
    // Magnetometer parameters
    /** Time constant for magnetometer correction (s). Default 9.0 */
    tauMag: number;
    /** Whether magnetometer is enabled. Default true */
    magEnabled: boolean;
    /** Expected magnetic field magnitude (µT). Default 50 */
    expectedMagMagnitude: number;
    /** Expected magnetic dip angle (degrees). Default 60 */
    expectedMagDip: number;
    
    // Adaptive gain parameters
    /** Correction gain during rest. Default 0.05 */
    restGain: number;
    /** Correction gain during motion. Default 0.005 */
    motionGain: number;
    /** Gyro threshold for motion detection (rad/s). Default 0.1 */
    motionThreshold: number;
    
    // External acceleration detection
    /** Enable external acceleration detection. Default true */
    externalAccelDetection: boolean;
    /** Tolerance for external acceleration detection. Default 0.15 (15%) */
    externalAccelTolerance: number;
}

export interface VQF9State {
    /** Current orientation quaternion */
    quaternion: THREE.Quaternion;
    /** Estimated gyro bias (rad/s) */
    gyroBias: THREE.Vector3;
    /** Whether at rest */
    isRest: boolean;
    /** Whether external acceleration detected */
    externalAccelDetected: boolean;
    /** Whether magnetic disturbance detected */
    magDisturbed: boolean;
    /** Current adaptive gain being used */
    currentGain: number;
    /** Heading uncertainty (degrees) */
    headingUncertainty: number;
    /** Update count */
    updateCount: number;
}

export interface VQF9Diagnostics {
    /** Tilt error angle (degrees) */
    tiltErrorDeg: number;
    /** Heading correction applied this frame */
    headingCorrectionDeg: number;
    /** Frames since last heading correction */
    framesSinceHeadingCorrection: number;
    /** Magnetic disturbance state */
    magState: MagDisturbanceState | null;
    /** Current state */
    state: VQF9State;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

export class VQF9 {
    // Core state
    private quat: THREE.Quaternion = new THREE.Quaternion(0, 0, 0, 1);
    private gyroBias: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    
    // Parameters
    private params: VQF9Params;
    
    // Motion state detection
    private isRest: boolean = false;
    private externalAccelDetected: boolean = false;
    private currentGain: number = 0.005;
    
    // Magnetometer components
    private magCalibrator: MagnetometerCalibrator;
    private magDisturbanceDetector: MagneticDisturbanceDetector;
    private magEnabled: boolean = true;
    
    // Heading tracking
    private headingUncertainty: number = 180; // Start with maximum uncertainty
    private framesSinceHeadingCorrection: number = 0;
    private lastHeadingCorrectionDeg: number = 0;
    
    // Diagnostics
    private updateCount: number = 0;
    private lastTiltError: number = 0;
    
    // Object pool (allocation-free updates)
    private readonly _gyroStep = new THREE.Vector3();
    private readonly _accelNorm = new THREE.Vector3();
    private readonly _magNorm = new THREE.Vector3();
    private readonly _quatStep = new THREE.Quaternion();
    private readonly _correctionQuat = new THREE.Quaternion();
    private readonly _accelWorld = new THREE.Vector3();
    private readonly _magWorld = new THREE.Vector3();
    private readonly _worldUp = new THREE.Vector3(0, 1, 0);
    private readonly _worldNorth = new THREE.Vector3(0, 0, -1); // -Z is north
    private readonly _tempVec = new THREE.Vector3();
    private readonly _tempQuat = new THREE.Quaternion();
    
    constructor(params?: Partial<VQF9Params>) {
        this.params = {
            tauAcc: 1.5,
            restThAcc: 0.2,
            restThGyro: 0.03,
            initialBias: [0, 0, 0],
            tauMag: 9.0,
            magEnabled: true,
            expectedMagMagnitude: 50,
            expectedMagDip: 60,
            restGain: 0.05,
            motionGain: 0.005,
            motionThreshold: 0.1,
            externalAccelDetection: true,
            externalAccelTolerance: 0.15,
            ...params
        };
        
        // Initialize gyro bias
        this.gyroBias.set(...this.params.initialBias);
        
        // Initialize magnetometer components
        this.magCalibrator = new MagnetometerCalibrator({
            expectedMagnitude: this.params.expectedMagMagnitude
        });
        
        this.magDisturbanceDetector = new MagneticDisturbanceDetector({
            expectedMagnitude: this.params.expectedMagMagnitude,
            expectedDipAngle: this.params.expectedMagDip
        });
        
        this.magEnabled = this.params.magEnabled;
    }
    
    /**
     * Main update function - processes IMU data and updates orientation.
     * 
     * @param dt Time step in seconds
     * @param gyro Gyroscope [x, y, z] in rad/s
     * @param accel Accelerometer [x, y, z] in m/s²
     * @param mag Optional magnetometer [x, y, z] in µT (calibrated)
     */
    public update(
        dt: number,
        gyro: [number, number, number],
        accel: [number, number, number],
        mag?: [number, number, number]
    ): void {
        const [gx, gy, gz] = gyro;
        const [ax, ay, az] = accel;
        
        // =====================================================================
        // 1. GYROSCOPE INTEGRATION (Prediction Step)
        // =====================================================================
        
        // Correct for estimated bias
        this._gyroStep.set(
            gx - this.gyroBias.x,
            gy - this.gyroBias.y,
            gz - this.gyroBias.z
        );
        
        // Integrate angular velocity
        const angle = this._gyroStep.length() * dt;
        if (angle > 1e-10) {
            const axis = this._gyroStep.clone().normalize();
            this._quatStep.setFromAxisAngle(axis, angle);
            this.quat.multiply(this._quatStep).normalize();
        }
        
        // =====================================================================
        // 2. MOTION STATE DETECTION
        // =====================================================================
        
        const gyroMag = Math.sqrt(gx*gx + gy*gy + gz*gz);
        const accelMag = Math.sqrt(ax*ax + ay*ay + az*az);
        const accelDeviation = Math.abs(accelMag - 9.81);
        
        // Rest detection
        this.isRest = accelDeviation < this.params.restThAcc && 
                      gyroMag < this.params.restThGyro;
        
        // External acceleration detection
        this.externalAccelDetected = this.params.externalAccelDetection &&
            (accelMag < 9.81 * (1 - this.params.externalAccelTolerance) ||
             accelMag > 9.81 * (1 + this.params.externalAccelTolerance));
        
        // Adaptive gain calculation
        const blendFactor = Math.min(1, gyroMag / this.params.motionThreshold);
        this.currentGain = this.params.restGain + 
                          blendFactor * (this.params.motionGain - this.params.restGain);
        
        // =====================================================================
        // 3. GYRO BIAS ESTIMATION (During Rest)
        // =====================================================================
        
        if (this.isRest) {
            const biasAlpha = 0.05;
            this._tempVec.set(gx, gy, gz);
            this.gyroBias.lerp(this._tempVec, biasAlpha);
        }
        
        // =====================================================================
        // 4. ACCELEROMETER CORRECTION (Tilt)
        // =====================================================================
        
        // Only correct when not under external acceleration and not rotating fast
        const shouldCorrectTilt = !this.externalAccelDetected && gyroMag < 0.26;
        
        if (shouldCorrectTilt) {
            // Normalize accelerometer (measured "up" in sensor frame)
            this._accelNorm.set(ax, ay, az).normalize();
            
            // Transform to world frame
            this._accelWorld.copy(this._accelNorm).applyQuaternion(this.quat);
            
            // Calculate tilt error
            const dotProduct = this._accelWorld.dot(this._worldUp);
            const tiltError = Math.acos(Math.min(1, Math.max(-1, dotProduct)));
            this.lastTiltError = tiltError;
            
            if (tiltError > 1e-6) {
                // Create correction quaternion
                this._correctionQuat.setFromUnitVectors(this._accelWorld, this._worldUp);
                
                // Ensure positive-w hemisphere
                if (this._correctionQuat.w < 0) {
                    this._correctionQuat.x *= -1;
                    this._correctionQuat.y *= -1;
                    this._correctionQuat.z *= -1;
                    this._correctionQuat.w *= -1;
                }
                
                // Apply partial correction
                this._tempQuat.identity().slerp(this._correctionQuat, this.currentGain);
                this.quat.premultiply(this._tempQuat).normalize();
                
                // Keep on positive-w hemisphere
                if (this.quat.w < 0) {
                    this.quat.x *= -1;
                    this.quat.y *= -1;
                    this.quat.z *= -1;
                    this.quat.w *= -1;
                }
            }
        }
        
        // =====================================================================
        // 5. MAGNETOMETER CORRECTION (Heading)
        // =====================================================================
        
        if (this.magEnabled && mag) {
            this.updateHeading(mag, accel, dt);
        } else {
            // Increase heading uncertainty when no mag data
            this.headingUncertainty = Math.min(180, this.headingUncertainty + dt * 1.0);
            this.framesSinceHeadingCorrection++;
        }
        
        this.updateCount++;
    }
    
    /**
     * Update heading from magnetometer.
     */
    private updateHeading(
        mag: [number, number, number],
        accel: [number, number, number],
        dt: number
    ): void {
        // Apply magnetometer calibration if available
        const calibratedMag = this.magCalibrator.hasValidCalibration() ?
            this.magCalibrator.applyCalibration(mag) : mag;
        
        // Check for magnetic disturbance
        const disturbanceState = this.magDisturbanceDetector.update(
            calibratedMag, accel, Date.now()
        );
        
        if (disturbanceState.isDisturbed) {
            // Don't correct heading when disturbed
            this.headingUncertainty = Math.min(180, this.headingUncertainty + dt * 5.0);
            this.framesSinceHeadingCorrection++;
            return;
        }
        
        // Get heading correction weight from disturbance detector
        const correctionWeight = this.magDisturbanceDetector.getHeadingCorrectionWeight();
        if (correctionWeight < 0.1) {
            this.framesSinceHeadingCorrection++;
            return;
        }
        
        // Normalize magnetometer
        this._magNorm.set(...calibratedMag).normalize();
        
        // Transform to world frame
        this._magWorld.copy(this._magNorm).applyQuaternion(this.quat);
        
        // Project onto horizontal plane (remove vertical component)
        const verticalComponent = this._magWorld.dot(this._worldUp);
        this._magWorld.sub(this._tempVec.copy(this._worldUp).multiplyScalar(verticalComponent));
        
        const horizontalMag = this._magWorld.length();
        if (horizontalMag < 0.1) {
            // Mag vector is nearly vertical (at magnetic pole or error)
            this.framesSinceHeadingCorrection++;
            return;
        }
        
        this._magWorld.divideScalar(horizontalMag);
        
        // Calculate heading error (rotation around vertical axis)
        // We want mag to point toward _worldNorth
        const heading = Math.atan2(this._magWorld.x, -this._magWorld.z);
        const headingError = Math.abs(heading);
        
        if (headingError > 1e-6) {
            // Create heading correction (rotation around world up)
            this._correctionQuat.setFromAxisAngle(this._worldUp, -heading);
            
            // Apply weighted correction
            const magGain = this.currentGain * correctionWeight * 0.5; // Slower than tilt
            this._tempQuat.identity().slerp(this._correctionQuat, magGain);
            this.quat.premultiply(this._tempQuat).normalize();
            
            // Keep positive hemisphere
            if (this.quat.w < 0) {
                this.quat.x *= -1;
                this.quat.y *= -1;
                this.quat.z *= -1;
                this.quat.w *= -1;
            }
            
            // Update heading uncertainty
            this.lastHeadingCorrectionDeg = heading * 180 / Math.PI;
            this.headingUncertainty = Math.max(5, 
                this.headingUncertainty * 0.95 - headingError * 180 / Math.PI * 0.1
            );
            this.framesSinceHeadingCorrection = 0;
        }
    }
    
    // ========================================================================
    // MAGNETOMETER CALIBRATION API
    // ========================================================================
    
    /**
     * Start magnetometer calibration.
     */
    public startMagCalibration(): void {
        this.magCalibrator.startCalibration();
    }
    
    /**
     * Add sample during magnetometer calibration.
     */
    public addMagCalibrationSample(mag: [number, number, number]): void {
        this.magCalibrator.addSample(mag);
    }
    
    /**
     * Get magnetometer calibration progress.
     */
    public getMagCalibrationProgress(): {
        sampleCount: number;
        sphereCoverage: number;
        isReady: boolean;
        message: string;
    } {
        return this.magCalibrator.getProgress();
    }
    
    /**
     * Finish magnetometer calibration.
     */
    public finishMagCalibration(): MagCalibrationResult {
        return this.magCalibrator.finishCalibration();
    }
    
    /**
     * Import magnetometer calibration.
     */
    public importMagCalibration(json: string): boolean {
        return this.magCalibrator.importCalibration(json);
    }
    
    /**
     * Export magnetometer calibration.
     */
    public exportMagCalibration(): string | null {
        return this.magCalibrator.exportCalibration();
    }
    
    // ========================================================================
    // STATE ACCESSORS
    // ========================================================================
    
    /**
     * Get current orientation quaternion.
     */
    public getQuaternion(): THREE.Quaternion {
        return this.quat.clone();
    }
    
    /**
     * Get estimated gyro bias.
     */
    public getBias(): THREE.Vector3 {
        return this.gyroBias.clone();
    }
    
    /**
     * Get current filter state.
     */
    public getState(): VQF9State {
        return {
            quaternion: this.quat.clone(),
            gyroBias: this.gyroBias.clone(),
            isRest: this.isRest,
            externalAccelDetected: this.externalAccelDetected,
            magDisturbed: this.magDisturbanceDetector.getState().isDisturbed,
            currentGain: this.currentGain,
            headingUncertainty: this.headingUncertainty,
            updateCount: this.updateCount
        };
    }
    
    /**
     * Get detailed diagnostics.
     */
    public getDiagnostics(): VQF9Diagnostics {
        return {
            tiltErrorDeg: this.lastTiltError * 180 / Math.PI,
            headingCorrectionDeg: this.lastHeadingCorrectionDeg,
            framesSinceHeadingCorrection: this.framesSinceHeadingCorrection,
            magState: this.magEnabled ? this.magDisturbanceDetector.getState() : null,
            state: this.getState()
        };
    }
    
    // ========================================================================
    // CONFIGURATION
    // ========================================================================
    
    /**
     * Enable or disable magnetometer.
     */
    public setMagEnabled(enabled: boolean): void {
        this.magEnabled = enabled;
        if (!enabled) {
            this.headingUncertainty = 180;
        }
    }
    
    /**
     * Check if magnetometer is enabled.
     */
    public isMagEnabled(): boolean {
        return this.magEnabled;
    }
    
    /**
     * Set expected local magnetic field parameters.
     */
    public setLocalMagneticField(magnitude: number, dipAngle: number): void {
        this.params.expectedMagMagnitude = magnitude;
        this.params.expectedMagDip = dipAngle;
        this.magDisturbanceDetector.setLocalMagneticField(magnitude, dipAngle);
    }
    
    /**
     * Update filter parameters.
     */
    public setParams(params: Partial<VQF9Params>): void {
        this.params = { ...this.params, ...params };
    }
    
    /**
     * Initialize from accelerometer (snap to gravity).
     */
    public initFromAccel(accel: [number, number, number]): void {
        const [ax, ay, az] = accel;
        const norm = Math.sqrt(ax*ax + ay*ay + az*az);
        if (norm < 0.1) return;
        
        this._accelNorm.set(ax, ay, az).divideScalar(norm);
        
        const dotWithUp = this._accelNorm.dot(this._worldUp);
        
        if (dotWithUp > 0.999) {
            this.quat.set(0, 0, 0, 1);
        } else if (dotWithUp < -0.999) {
            this.quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
        } else {
            this.quat.setFromUnitVectors(this._accelNorm, this._worldUp);
        }
    }
    
    /**
     * Initialize heading from magnetometer.
     */
    public initFromMag(
        mag: [number, number, number],
        accel: [number, number, number]
    ): void {
        // First initialize tilt from accel
        this.initFromAccel(accel);
        
        // Then set heading from mag
        const calibratedMag = this.magCalibrator.hasValidCalibration() ?
            this.magCalibrator.applyCalibration(mag) : mag;
        
        this._magNorm.set(...calibratedMag).normalize();
        this._magWorld.copy(this._magNorm).applyQuaternion(this.quat);
        
        // Project to horizontal
        const verticalComponent = this._magWorld.dot(this._worldUp);
        this._magWorld.sub(this._tempVec.copy(this._worldUp).multiplyScalar(verticalComponent));
        
        const horizontalMag = this._magWorld.length();
        if (horizontalMag > 0.1) {
            this._magWorld.divideScalar(horizontalMag);
            const heading = Math.atan2(this._magWorld.x, -this._magWorld.z);
            this._correctionQuat.setFromAxisAngle(this._worldUp, -heading);
            this.quat.premultiply(this._correctionQuat).normalize();
        }
        
        this.headingUncertainty = 30; // Good initial heading
    }
    
    /**
     * Reset filter state.
     */
    public reset(): void {
        this.quat.set(0, 0, 0, 1);
        this.gyroBias.set(0, 0, 0);
        this.isRest = false;
        this.externalAccelDetected = false;
        this.headingUncertainty = 180;
        this.framesSinceHeadingCorrection = 0;
        this.updateCount = 0;
        this.magDisturbanceDetector.reset();
    }
}
