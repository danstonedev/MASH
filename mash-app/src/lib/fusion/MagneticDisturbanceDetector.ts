/**
 * MagneticDisturbanceDetector.ts
 * 
 * Detects magnetic field anomalies from ferromagnetic materials,
 * electronic devices, or structural steel that would corrupt heading estimates.
 * 
 * Strategies:
 * 1. Magnitude check: Earth field ~25-65 µT depending on location
 * 2. Gradient check: Field should change slowly during normal motion
 * 3. Dip angle check: Inclination should be relatively constant
 * 4. Consistency check: Field direction should agree with accelerometer tilt
 * 
 * References:
 * - Kok et al. 2017: Using inertial sensors for position and orientation estimation
 * - Solin et al. 2018: Inertial odometry on handheld smartphones
 * 
 * @module lib/fusion/MagneticDisturbanceDetector
 */

import * as THREE from 'three';

// ============================================================================
// INTERFACES
// ============================================================================

export interface MagDisturbanceState {
    /** Whether disturbance is currently detected */
    isDisturbed: boolean;
    /** Confidence that field is undisturbed (0-1) */
    cleanConfidence: number;
    /** Type of disturbance detected */
    disturbanceType: 'none' | 'magnitude' | 'gradient' | 'dip' | 'inconsistent' | 'multiple';
    /** Current field magnitude (µT) */
    magnitude: number;
    /** Expected magnitude (µT) */
    expectedMagnitude: number;
    /** Current dip angle (degrees) */
    dipAngle: number;
    /** Expected dip angle (degrees) */
    expectedDipAngle: number;
    /** How long disturbance has persisted (ms) */
    disturbanceDuration: number;
    /** Time since last clean field (ms) */
    timeSinceClean: number;
}

export interface MagDisturbanceConfig {
    /** Expected field magnitude (µT), varies by location */
    expectedMagnitude: number;
    /** Tolerance for magnitude as fraction (default: 0.25 = ±25%) */
    magnitudeTolerance: number;
    /** Expected magnetic dip/inclination angle (degrees), varies by location */
    expectedDipAngle: number;
    /** Tolerance for dip angle (degrees, default: 15°) */
    dipAngleTolerance: number;
    /** Maximum allowed magnitude change rate (µT/s, default: 50) */
    maxGradient: number;
    /** Time constant for smoothing (seconds, default: 0.5) */
    smoothingTau: number;
    /** Minimum clean time before trusting heading (ms, default: 500) */
    minCleanDuration: number;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

export class MagneticDisturbanceDetector {
    private config: MagDisturbanceConfig;
    
    // State
    private lastMag: THREE.Vector3 | null = null;
    private lastTimestamp: number = 0;
    private smoothedMagnitude: number = 0;
    private smoothedDip: number = 0;
    private disturbanceStartTime: number = 0;
    private lastCleanTime: number = 0;
    private isDisturbed: boolean = false;
    private disturbanceType: MagDisturbanceState['disturbanceType'] = 'none';
    
    // Exponential moving average state
    private initialized: boolean = false;
    
    // Configurable thresholds based on location
    // Default values for mid-latitudes
    private static readonly DEFAULT_MAGNITUDE = 50; // µT
    private static readonly DEFAULT_DIP = 60; // degrees (typical for ~45° latitude)
    
    constructor(config?: Partial<MagDisturbanceConfig>) {
        this.config = {
            expectedMagnitude: MagneticDisturbanceDetector.DEFAULT_MAGNITUDE,
            magnitudeTolerance: 0.25,
            expectedDipAngle: MagneticDisturbanceDetector.DEFAULT_DIP,
            dipAngleTolerance: 15,
            maxGradient: 50,
            smoothingTau: 0.5,
            minCleanDuration: 500,
            ...config
        };
    }
    
    /**
     * Update with new magnetometer and accelerometer readings.
     * 
     * @param mag Calibrated magnetometer [x, y, z] in µT
     * @param accel Accelerometer [x, y, z] in m/s² (for dip angle calculation)
     * @param timestamp Current time in ms
     * @returns Disturbance state
     */
    public update(
        mag: [number, number, number],
        accel: [number, number, number],
        timestamp: number
    ): MagDisturbanceState {
        const magVec = new THREE.Vector3(...mag);
        const accelVec = new THREE.Vector3(...accel);
        
        const magnitude = magVec.length();
        const dipAngle = this.calculateDipAngle(magVec, accelVec);
        
        // Calculate time delta
        const dt = this.lastTimestamp > 0 ? (timestamp - this.lastTimestamp) / 1000 : 0;
        
        // Initialize smoothed values on first update
        if (!this.initialized) {
            this.smoothedMagnitude = magnitude;
            this.smoothedDip = dipAngle;
            this.lastCleanTime = timestamp;
            this.initialized = true;
        }
        
        // Exponential smoothing
        const alpha = dt > 0 ? 1 - Math.exp(-dt / this.config.smoothingTau) : 0.1;
        this.smoothedMagnitude = this.smoothedMagnitude * (1 - alpha) + magnitude * alpha;
        this.smoothedDip = this.smoothedDip * (1 - alpha) + dipAngle * alpha;
        
        // Check for disturbances
        const checks = this.performChecks(magVec, magnitude, dipAngle, dt);
        
        // Determine overall state
        const wasDisturbed = this.isDisturbed;
        this.isDisturbed = checks.magnitude || checks.gradient || checks.dip;
        
        // Update disturbance type
        if (this.isDisturbed) {
            const types: string[] = [];
            if (checks.magnitude) types.push('magnitude');
            if (checks.gradient) types.push('gradient');
            if (checks.dip) types.push('dip');
            
            this.disturbanceType = types.length > 1 ? 'multiple' : 
                                    types[0] as MagDisturbanceState['disturbanceType'];
            
            // Track disturbance duration
            if (!wasDisturbed) {
                this.disturbanceStartTime = timestamp;
            }
        } else {
            this.disturbanceType = 'none';
            this.lastCleanTime = timestamp;
        }
        
        // Calculate clean confidence
        const cleanConfidence = this.calculateCleanConfidence(magnitude, dipAngle, checks);
        
        // Update state for next iteration
        this.lastMag = magVec.clone();
        this.lastTimestamp = timestamp;
        
        return {
            isDisturbed: this.isDisturbed,
            cleanConfidence,
            disturbanceType: this.disturbanceType,
            magnitude: this.smoothedMagnitude,
            expectedMagnitude: this.config.expectedMagnitude,
            dipAngle: this.smoothedDip,
            expectedDipAngle: this.config.expectedDipAngle,
            disturbanceDuration: this.isDisturbed ? timestamp - this.disturbanceStartTime : 0,
            timeSinceClean: timestamp - this.lastCleanTime
        };
    }
    
    /**
     * Calculate magnetic dip/inclination angle.
     * This is the angle between the magnetic field and horizontal plane.
     */
    private calculateDipAngle(mag: THREE.Vector3, accel: THREE.Vector3): number {
        // Normalize vectors
        const magNorm = mag.clone().normalize();
        const accelNorm = accel.clone().normalize();
        
        // Gravity points down, so horizontal plane normal is accel direction
        // Dip angle is complement of angle between mag and horizontal
        const cosAngle = Math.abs(magNorm.dot(accelNorm));
        const dipRad = Math.asin(Math.min(1, cosAngle));
        
        return dipRad * 180 / Math.PI;
    }
    
    /**
     * Perform all disturbance checks.
     */
    private performChecks(
        mag: THREE.Vector3,
        magnitude: number,
        dipAngle: number,
        dt: number
    ): { magnitude: boolean; gradient: boolean; dip: boolean } {
        // Magnitude check
        const expectedMag = this.config.expectedMagnitude;
        const magTolerance = this.config.magnitudeTolerance;
        const magnitudeError = Math.abs(magnitude - expectedMag) / expectedMag;
        const magnitudeDisturbed = magnitudeError > magTolerance;
        
        // Gradient check (rate of change)
        let gradientDisturbed = false;
        if (this.lastMag && dt > 0) {
            const magChange = mag.clone().sub(this.lastMag).length();
            const gradient = magChange / dt;
            gradientDisturbed = gradient > this.config.maxGradient;
        }
        
        // Dip angle check
        const dipError = Math.abs(dipAngle - this.config.expectedDipAngle);
        const dipDisturbed = dipError > this.config.dipAngleTolerance;
        
        return {
            magnitude: magnitudeDisturbed,
            gradient: gradientDisturbed,
            dip: dipDisturbed
        };
    }
    
    /**
     * Calculate confidence that the magnetic field is clean/undisturbed.
     */
    private calculateCleanConfidence(
        magnitude: number,
        dipAngle: number,
        checks: { magnitude: boolean; gradient: boolean; dip: boolean }
    ): number {
        // Magnitude contribution (0-0.4)
        const magError = Math.abs(magnitude - this.config.expectedMagnitude) / 
                         this.config.expectedMagnitude;
        const magScore = Math.max(0, 0.4 * (1 - magError / this.config.magnitudeTolerance));
        
        // Dip angle contribution (0-0.3)
        const dipError = Math.abs(dipAngle - this.config.expectedDipAngle);
        const dipScore = Math.max(0, 0.3 * (1 - dipError / this.config.dipAngleTolerance));
        
        // Gradient contribution (0-0.3)
        const gradientScore = checks.gradient ? 0 : 0.3;
        
        return Math.min(1, magScore + dipScore + gradientScore);
    }
    
    // ========================================================================
    // PUBLIC API
    // ========================================================================
    
    /**
     * Check if heading correction should be applied.
     * Returns true if field has been clean for minimum duration.
     */
    public shouldCorrectHeading(): boolean {
        if (this.isDisturbed) return false;
        
        const cleanDuration = Date.now() - this.disturbanceStartTime;
        return cleanDuration >= this.config.minCleanDuration;
    }
    
    /**
     * Get heading correction weight (0-1).
     * Smoothly reduces correction as confidence decreases.
     */
    public getHeadingCorrectionWeight(): number {
        if (this.isDisturbed) return 0;
        
        // Use last known timestamp instead of Date.now() for consistency
        const cleanDuration = this.lastTimestamp - this.lastCleanTime;
        
        // If clean duration is negative (timing issue), return low weight
        if (cleanDuration < 0) return 0.1;
        
        // Ramp up weight as clean duration increases
        if (cleanDuration < this.config.minCleanDuration) {
            return Math.max(0.1, cleanDuration / this.config.minCleanDuration * 0.5);
        }
        
        // Full weight after minimum clean duration
        return 1.0;
    }
    
    /**
     * Get current disturbance state.
     */
    public getState(): MagDisturbanceState {
        return {
            isDisturbed: this.isDisturbed,
            cleanConfidence: 0,
            disturbanceType: this.disturbanceType,
            magnitude: this.smoothedMagnitude,
            expectedMagnitude: this.config.expectedMagnitude,
            dipAngle: this.smoothedDip,
            expectedDipAngle: this.config.expectedDipAngle,
            disturbanceDuration: this.isDisturbed ? 
                Date.now() - this.disturbanceStartTime : 0,
            timeSinceClean: Date.now() - this.lastCleanTime
        };
    }
    
    /**
     * Set expected magnetic field parameters for current location.
     * Can be obtained from NOAA World Magnetic Model or similar.
     */
    public setLocalMagneticField(magnitude: number, dipAngle: number): void {
        this.config.expectedMagnitude = magnitude;
        this.config.expectedDipAngle = dipAngle;
    }
    
    /**
     * Reset detector state.
     */
    public reset(): void {
        this.lastMag = null;
        this.lastTimestamp = 0;
        this.smoothedMagnitude = this.config.expectedMagnitude;
        this.smoothedDip = this.config.expectedDipAngle;
        this.disturbanceStartTime = 0;
        this.lastCleanTime = Date.now();
        this.isDisturbed = false;
        this.disturbanceType = 'none';
        this.initialized = false;
    }
}
