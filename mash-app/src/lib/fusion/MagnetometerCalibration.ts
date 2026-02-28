/**
 * MagnetometerCalibration.ts
 * 
 * Hard and soft iron calibration for magnetometers.
 * Essential for accurate heading estimation in IMU-based motion capture.
 * 
 * Hard iron: DC offset from nearby ferromagnetic materials
 * Soft iron: Distortion of field shape from nearby materials
 * 
 * References:
 * - Renaudin et al. 2010: Complete triaxis magnetometer calibration in the magnetic domain
 * - Gebre-Egziabher et al. 2006: Magnetometer autocalibration leveraging measurement locus constraints
 * 
 * @module lib/fusion/MagnetometerCalibration
 */

import * as THREE from 'three';

// ============================================================================
// INTERFACES
// ============================================================================

export interface MagCalibrationResult {
    /** Hard iron offset vector (µT) */
    hardIron: THREE.Vector3;
    /** Soft iron correction matrix (3x3) */
    softIron: THREE.Matrix3;
    /** Expected field magnitude after calibration (µT) */
    expectedMagnitude: number;
    /** Fit residual (lower = better) */
    residual: number;
    /** Number of samples used */
    sampleCount: number;
    /** Calibration quality score 0-1 */
    quality: number;
    /** Whether calibration is valid for use */
    isValid: boolean;
    /** Timestamp of calibration */
    timestamp: number;
}

export interface MagSample {
    /** Raw magnetometer reading [x, y, z] in µT */
    raw: [number, number, number];
    /** Timestamp */
    timestamp: number;
}

export interface MagCalibrationConfig {
    /** Minimum samples for calibration (default: 200) */
    minSamples: number;
    /** Target sphere coverage for good calibration (0-1, default: 0.7) */
    minSphereCoverage: number;
    /** Maximum residual for valid calibration (default: 5.0 µT) */
    maxResidual: number;
    /** Expected local field magnitude (default: 50 µT, varies by location) */
    expectedMagnitude: number;
    /** Tolerance for magnitude check (default: 20%) */
    magnitudeTolerance: number;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

export class MagnetometerCalibrator {
    private samples: MagSample[] = [];
    private config: MagCalibrationConfig;
    private calibration: MagCalibrationResult | null = null;
    
    // Calibration state
    private isCalibrating: boolean = false;
    
    // For sphere coverage estimation
    private sectorCoverage: boolean[] = new Array(26).fill(false); // 26 sectors of unit sphere
    
    private static readonly MAX_SAMPLES = 1000;
    
    constructor(config?: Partial<MagCalibrationConfig>) {
        this.config = {
            minSamples: 200,
            minSphereCoverage: 0.6,
            maxResidual: 5.0,
            expectedMagnitude: 50.0, // Typical Earth field magnitude
            magnitudeTolerance: 0.20,
            ...config
        };
    }
    
    /**
     * Start calibration data collection.
     * User should rotate sensor slowly in all directions.
     */
    public startCalibration(): void {
        this.samples = [];
        this.sectorCoverage.fill(false);
        this.isCalibrating = true;
        this.calibration = null;
    }
    
    /**
     * Add a magnetometer sample during calibration.
     */
    public addSample(mag: [number, number, number]): void {
        if (!this.isCalibrating) return;
        
        const sample: MagSample = {
            raw: [...mag],
            timestamp: Date.now()
        };
        
        this.samples.push(sample);
        
        // Update sphere coverage
        this.updateSphereCoverage(mag);
        
        // Trim if too many samples
        if (this.samples.length > MagnetometerCalibrator.MAX_SAMPLES) {
            // Remove oldest samples but keep spatial diversity
            this.samples = this.samples.slice(-MagnetometerCalibrator.MAX_SAMPLES);
        }
    }
    
    /**
     * Track which sectors of the unit sphere have been sampled.
     */
    private updateSphereCoverage(mag: [number, number, number]): void {
        const [x, y, z] = mag;
        const norm = Math.sqrt(x*x + y*y + z*z);
        if (norm < 1) return;
        
        // Normalize to unit sphere
        const nx = x / norm;
        const ny = y / norm;
        const nz = z / norm;
        
        // Map to sector index (26 sectors: 3^3 - 1 center)
        const ix = nx > 0.33 ? 2 : nx < -0.33 ? 0 : 1;
        const iy = ny > 0.33 ? 2 : ny < -0.33 ? 0 : 1;
        const iz = nz > 0.33 ? 2 : nz < -0.33 ? 0 : 1;
        
        const sectorIndex = ix * 9 + iy * 3 + iz;
        if (sectorIndex !== 13) { // Skip center sector (13 = 1*9 + 1*3 + 1)
            const mappedIndex = sectorIndex > 13 ? sectorIndex - 1 : sectorIndex;
            if (mappedIndex >= 0 && mappedIndex < 26) {
                this.sectorCoverage[mappedIndex] = true;
            }
        }
    }
    
    /**
     * Get current sphere coverage (0-1).
     */
    public getSphereCoverage(): number {
        const covered = this.sectorCoverage.filter(s => s).length;
        return covered / 26;
    }
    
    /**
     * Get calibration progress info.
     */
    public getProgress(): {
        sampleCount: number;
        sphereCoverage: number;
        isReady: boolean;
        message: string;
    } {
        const coverage = this.getSphereCoverage();
        const isReady = this.samples.length >= this.config.minSamples &&
                        coverage >= this.config.minSphereCoverage;
        
        let message = '';
        if (this.samples.length < this.config.minSamples) {
            message = `Collecting samples: ${this.samples.length}/${this.config.minSamples}`;
        } else if (coverage < this.config.minSphereCoverage) {
            message = `Rotate more: ${(coverage * 100).toFixed(0)}% coverage (need ${(this.config.minSphereCoverage * 100).toFixed(0)}%)`;
        } else {
            message = 'Ready to calibrate';
        }
        
        return {
            sampleCount: this.samples.length,
            sphereCoverage: coverage,
            isReady,
            message
        };
    }
    
    /**
     * Finish calibration and compute parameters.
     * Uses ellipsoid fitting to find hard/soft iron correction.
     */
    public finishCalibration(): MagCalibrationResult {
        this.isCalibrating = false;
        
        if (this.samples.length < this.config.minSamples) {
            return this.createInvalidResult('Insufficient samples');
        }
        
        const coverage = this.getSphereCoverage();
        if (coverage < this.config.minSphereCoverage * 0.5) {
            return this.createInvalidResult('Poor sphere coverage');
        }
        
        // Extract raw data
        const rawData = this.samples.map(s => s.raw);
        
        // Step 1: Estimate hard iron (ellipsoid center) using iterative mean
        const hardIron = this.estimateHardIron(rawData);
        
        // Step 2: Correct for hard iron
        const centered = rawData.map(([x, y, z]) => [
            x - hardIron.x,
            y - hardIron.y,
            z - hardIron.z
        ] as [number, number, number]);
        
        // Step 3: Estimate soft iron (ellipsoid to sphere transformation)
        const { softIron, magnitude } = this.estimateSoftIron(centered);
        
        // Step 4: Calculate residual
        const residual = this.calculateResidual(rawData, hardIron, softIron, magnitude);
        
        // Step 5: Validate calibration
        const magnitudeValid = Math.abs(magnitude - this.config.expectedMagnitude) / 
                               this.config.expectedMagnitude < this.config.magnitudeTolerance;
        const residualValid = residual < this.config.maxResidual;
        const quality = this.calculateQuality(coverage, residual, magnitudeValid);
        
        this.calibration = {
            hardIron,
            softIron,
            expectedMagnitude: magnitude,
            residual,
            sampleCount: this.samples.length,
            quality,
            isValid: residualValid && quality > 0.5,
            timestamp: Date.now()
        };
        
        return this.calibration;
    }
    
    /**
     * Estimate hard iron offset as centroid of samples.
     * For a well-distributed sample set, this approximates the ellipsoid center.
     */
    private estimateHardIron(samples: Array<[number, number, number]>): THREE.Vector3 {
        let sumX = 0, sumY = 0, sumZ = 0;
        
        for (const [x, y, z] of samples) {
            sumX += x;
            sumY += y;
            sumZ += z;
        }
        
        const n = samples.length;
        return new THREE.Vector3(sumX / n, sumY / n, sumZ / n);
    }
    
    /**
     * Estimate soft iron correction matrix.
     * Uses eigenvalue decomposition of covariance to find principal axes.
     */
    private estimateSoftIron(centered: Array<[number, number, number]>): {
        softIron: THREE.Matrix3;
        magnitude: number;
    } {
        // Compute covariance matrix
        const cov = this.computeCovariance(centered);
        
        // Find eigenvalues/eigenvectors via power iteration
        const { eigenvalues, eigenvectors } = this.eigenDecomposition(cov);
        
        // Scale factors to make sphere
        const avgEigenvalue = (eigenvalues[0] + eigenvalues[1] + eigenvalues[2]) / 3;
        const scales = eigenvalues.map(e => Math.sqrt(avgEigenvalue / Math.max(0.01, e)));
        
        // Construct soft iron matrix: V * S * V^T
        // where V is eigenvector matrix, S is diagonal scale matrix
        const V = new THREE.Matrix3();
        V.set(
            eigenvectors[0].x, eigenvectors[1].x, eigenvectors[2].x,
            eigenvectors[0].y, eigenvectors[1].y, eigenvectors[2].y,
            eigenvectors[0].z, eigenvectors[1].z, eigenvectors[2].z
        );
        
        const S = new THREE.Matrix3();
        S.set(
            scales[0], 0, 0,
            0, scales[1], 0,
            0, 0, scales[2]
        );
        
        const VT = V.clone().transpose();
        
        // softIron = V * S * V^T
        const softIron = V.clone().multiply(S).multiply(VT);
        
        // Estimate magnitude from eigenvalues
        const magnitude = Math.sqrt(avgEigenvalue);
        
        return { softIron, magnitude };
    }
    
    private computeCovariance(data: Array<[number, number, number]>): number[][] {
        const n = data.length;
        const cov = [[0,0,0], [0,0,0], [0,0,0]];
        
        for (const [x, y, z] of data) {
            cov[0][0] += x * x;
            cov[0][1] += x * y;
            cov[0][2] += x * z;
            cov[1][1] += y * y;
            cov[1][2] += y * z;
            cov[2][2] += z * z;
        }
        
        // Symmetric
        cov[1][0] = cov[0][1];
        cov[2][0] = cov[0][2];
        cov[2][1] = cov[1][2];
        
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                cov[i][j] /= n;
            }
        }
        
        return cov;
    }
    
    /**
     * Simple eigenvalue decomposition via power iteration.
     */
    private eigenDecomposition(M: number[][]): {
        eigenvalues: number[];
        eigenvectors: THREE.Vector3[];
    } {
        const eigenvalues: number[] = [];
        const eigenvectors: THREE.Vector3[] = [];
        
        // Work on a copy
        const A = M.map(row => [...row]);
        
        for (let i = 0; i < 3; i++) {
            // Power iteration for largest remaining eigenvalue
            let v = new THREE.Vector3(1, 0, 0);
            
            for (let iter = 0; iter < 50; iter++) {
                // v = A * v
                const newV = new THREE.Vector3(
                    A[0][0] * v.x + A[0][1] * v.y + A[0][2] * v.z,
                    A[1][0] * v.x + A[1][1] * v.y + A[1][2] * v.z,
                    A[2][0] * v.x + A[2][1] * v.y + A[2][2] * v.z
                );
                
                const norm = newV.length();
                if (norm > 0.0001) {
                    v = newV.divideScalar(norm);
                }
            }
            
            // Rayleigh quotient for eigenvalue
            const Av = new THREE.Vector3(
                A[0][0] * v.x + A[0][1] * v.y + A[0][2] * v.z,
                A[1][0] * v.x + A[1][1] * v.y + A[1][2] * v.z,
                A[2][0] * v.x + A[2][1] * v.y + A[2][2] * v.z
            );
            const eigenvalue = v.dot(Av);
            
            eigenvalues.push(eigenvalue);
            eigenvectors.push(v.clone());
            
            // Deflate: A = A - λ * v * v^T
            for (let j = 0; j < 3; j++) {
                for (let k = 0; k < 3; k++) {
                    const vArr = [v.x, v.y, v.z];
                    A[j][k] -= eigenvalue * vArr[j] * vArr[k];
                }
            }
        }
        
        return { eigenvalues, eigenvectors };
    }
    
    /**
     * Calculate residual error after calibration.
     */
    private calculateResidual(
        raw: Array<[number, number, number]>,
        hardIron: THREE.Vector3,
        softIron: THREE.Matrix3,
        targetMagnitude: number
    ): number {
        let sumSquaredError = 0;
        
        for (const [x, y, z] of raw) {
            // Apply calibration
            const corrected = this.applyCalibrationInternal(
                [x, y, z], hardIron, softIron
            );
            
            // Calculate magnitude error
            const mag = Math.sqrt(
                corrected[0]**2 + corrected[1]**2 + corrected[2]**2
            );
            const error = mag - targetMagnitude;
            sumSquaredError += error * error;
        }
        
        return Math.sqrt(sumSquaredError / raw.length);
    }
    
    private applyCalibrationInternal(
        raw: [number, number, number],
        hardIron: THREE.Vector3,
        softIron: THREE.Matrix3
    ): [number, number, number] {
        // Remove hard iron
        const centered = new THREE.Vector3(
            raw[0] - hardIron.x,
            raw[1] - hardIron.y,
            raw[2] - hardIron.z
        );
        
        // Apply soft iron correction
        centered.applyMatrix3(softIron);
        
        return [centered.x, centered.y, centered.z];
    }
    
    private calculateQuality(
        coverage: number,
        residual: number,
        magnitudeValid: boolean
    ): number {
        // Coverage contribution (0-0.4)
        const coverageScore = Math.min(0.4, coverage * 0.4 / this.config.minSphereCoverage);
        
        // Residual contribution (0-0.4)
        const residualScore = Math.max(0, 0.4 * (1 - residual / this.config.maxResidual));
        
        // Magnitude contribution (0-0.2)
        const magnitudeScore = magnitudeValid ? 0.2 : 0;
        
        return coverageScore + residualScore + magnitudeScore;
    }
    
    private createInvalidResult(reason: string): MagCalibrationResult {
        console.warn(`[MagCalibrator] ${reason}`);
        return {
            hardIron: new THREE.Vector3(0, 0, 0),
            softIron: new THREE.Matrix3(),
            expectedMagnitude: this.config.expectedMagnitude,
            residual: Infinity,
            sampleCount: this.samples.length,
            quality: 0,
            isValid: false,
            timestamp: Date.now()
        };
    }
    
    // ========================================================================
    // PUBLIC API
    // ========================================================================
    
    /**
     * Apply calibration to a raw magnetometer reading.
     */
    public applyCalibration(raw: [number, number, number]): [number, number, number] {
        if (!this.calibration || !this.calibration.isValid) {
            return raw;
        }
        
        return this.applyCalibrationInternal(
            raw,
            this.calibration.hardIron,
            this.calibration.softIron
        );
    }
    
    /**
     * Get current calibration result.
     */
    public getCalibration(): MagCalibrationResult | null {
        return this.calibration;
    }
    
    /**
     * Check if calibration is valid and usable.
     */
    public hasValidCalibration(): boolean {
        return this.calibration !== null && this.calibration.isValid;
    }
    
    /**
     * Set calibration from external source (e.g., loaded from storage).
     */
    public setCalibration(cal: MagCalibrationResult): void {
        this.calibration = cal;
    }
    
    /**
     * Export calibration for persistence.
     */
    public exportCalibration(): string | null {
        if (!this.calibration) return null;
        
        return JSON.stringify({
            hardIron: [
                this.calibration.hardIron.x,
                this.calibration.hardIron.y,
                this.calibration.hardIron.z
            ],
            softIron: this.calibration.softIron.toArray(),
            expectedMagnitude: this.calibration.expectedMagnitude,
            residual: this.calibration.residual,
            sampleCount: this.calibration.sampleCount,
            quality: this.calibration.quality,
            isValid: this.calibration.isValid,
            timestamp: this.calibration.timestamp
        });
    }
    
    /**
     * Import calibration from persistence.
     */
    public importCalibration(json: string): boolean {
        try {
            const data = JSON.parse(json);
            
            const softIron = new THREE.Matrix3();
            softIron.fromArray(data.softIron);
            
            this.calibration = {
                hardIron: new THREE.Vector3(...data.hardIron),
                softIron,
                expectedMagnitude: data.expectedMagnitude,
                residual: data.residual,
                sampleCount: data.sampleCount,
                quality: data.quality,
                isValid: data.isValid,
                timestamp: data.timestamp
            };
            
            return true;
        } catch (e) {
            console.error('[MagCalibrator] Failed to import calibration:', e);
            return false;
        }
    }
}
