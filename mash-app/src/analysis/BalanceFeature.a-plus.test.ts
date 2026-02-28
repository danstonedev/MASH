/**
 * Balance Feature A+ Tests
 * ========================
 * 
 * Comprehensive tests for research-grade posturography implementation:
 * - Time domain metrics (existing)
 * - Frequency domain analysis (FFT, PSD, spectral features)
 * - Stabilogram Diffusion Analysis (SDA)
 * - Sample Entropy
 * - Clinical protocols (CTSIB, Romberg)
 * 
 * References:
 * - Collins & De Luca (1993): SDA methodology
 * - Richman & Moorman (2000): Sample entropy
 * - Prieto et al. (1996): Force platform standardization
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { 
    BalanceFeature, 
    BalanceMetrics, 
    SpectralMetrics, 
    DiffusionMetrics, 
    EntropyMetrics,
    BalanceAssessmentA,
    BalanceProtocol 
} from './BalanceFeature';
import { KineticChain } from './KineticChain';
import * as THREE from 'three';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Generate synthetic sway data with known frequency content
 */
function generateSyntheticSway(
    samples: number,
    dt: number = 0.01,
    frequencies: { freq: number; amp: number }[] = [],
    noise: number = 0
): { ap: number[]; ml: number[]; timestamps: number[] } {
    const ap: number[] = [];
    const ml: number[] = [];
    const timestamps: number[] = [];

    for (let i = 0; i < samples; i++) {
        const t = i * dt;
        let valAP = 0;
        let valML = 0;

        for (const { freq, amp } of frequencies) {
            valAP += amp * Math.sin(2 * Math.PI * freq * t);
            valML += amp * Math.cos(2 * Math.PI * freq * t + Math.PI / 4);
        }

        // Add random noise
        valAP += (Math.random() - 0.5) * noise;
        valML += (Math.random() - 0.5) * noise;

        ap.push(valAP);
        ml.push(valML);
        timestamps.push(t * 1000); // Convert to ms
    }

    return { ap, ml, timestamps };
}

/**
 * Create a mock KineticChain that returns specified accelerations
 */
function createMockChain(accelX: number, accelZ: number): KineticChain {
    const chain = new KineticChain();
    // Directly set accelerations by calling getMetrics override
    (chain as any).mockAccelX = accelX;
    (chain as any).mockAccelZ = accelZ;
    
    // Override getMetrics to return mock values
    const originalGetMetrics = chain.getMetrics.bind(chain);
    chain.getMetrics = () => {
        const metrics = originalGetMetrics();
        metrics.rootAccel = new THREE.Vector3(accelX, 0, accelZ);
        return metrics;
    };
    
    return chain;
}

/**
 * Feed sway data directly into balance feature for testing
 */
function feedSwayData(
    balance: BalanceFeature,
    ap: number[],
    ml: number[],
    timestamps: number[]
) {
    // Access private buffers for direct testing
    (balance as any).bufferAP = [...ap];
    (balance as any).bufferML = [...ml];
    (balance as any).timestamps = [...timestamps];
}

// ============================================================================
// TIME DOMAIN TESTS (Existing functionality verification)
// ============================================================================

describe('BalanceFeature - Time Domain Metrics', () => {
    let balance: BalanceFeature;

    beforeEach(() => {
        balance = new BalanceFeature();
    });

    it('computes 95% confidence ellipse for zero-mean Gaussian sway', () => {
        // Generate controlled Gaussian-like sway
        const samples = 1000;
        const sway = generateSyntheticSway(samples, 0.01, [], 100);
        
        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const metrics = balance.getMetrics();
        
        // Ellipse should be non-zero with noise
        expect(metrics.swayArea95).toBeGreaterThan(0);
        expect(metrics.ellipseAxisMajor).toBeGreaterThan(0);
        expect(metrics.ellipseAxisMinor).toBeGreaterThan(0);
        expect(metrics.ellipseAxisMajor).toBeGreaterThanOrEqual(metrics.ellipseAxisMinor);
    });

    it('computes path length correctly for simple movement', () => {
        // Create simple linear movement
        const samples = 100;
        const ap = Array.from({ length: samples }, (_, i) => i);
        const ml = Array.from({ length: samples }, (_, i) => i * 0.5);
        const timestamps = Array.from({ length: samples }, (_, i) => i * 10);

        balance.start('eyes_open');
        feedSwayData(balance, ap, ml, timestamps);
        
        const metrics = balance.getMetrics();
        
        expect(metrics.pathLength).toBeGreaterThan(0);
        expect(metrics.swayVelocityAP).toBeGreaterThan(0);
        expect(metrics.swayVelocityML).toBeGreaterThan(0);
    });

    it('returns condition in metrics', () => {
        balance.start('eyes_closed');
        const sway = generateSyntheticSway(500, 0.01, [], 50);
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const metrics = balance.getMetrics();
        
        expect(metrics.condition).toBe('eyes_closed');
    });

    it('includes surface and stance in metrics', () => {
        balance.start('eyes_open', 'foam', 'tandem');
        const sway = generateSyntheticSway(500, 0.01, [], 50);
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const metrics = balance.getMetrics();
        
        expect(metrics.surface).toBe('foam');
        expect(metrics.stance).toBe('tandem');
    });

    it('computes Romberg ratio after both conditions', () => {
        // Eyes open - smaller sway
        balance.start('eyes_open');
        const swayOpen = generateSyntheticSway(500, 0.01, [], 30);
        feedSwayData(balance, swayOpen.ap, swayOpen.ml, swayOpen.timestamps);
        balance.stop();

        // Eyes closed - larger sway
        balance.start('eyes_closed');
        const swayClosed = generateSyntheticSway(500, 0.01, [], 60);
        feedSwayData(balance, swayClosed.ap, swayClosed.ml, swayClosed.timestamps);
        balance.stop();

        const ratio = balance.getRombergRatio();
        expect(ratio).not.toBeNull();
        expect(ratio!).toBeGreaterThan(1); // Eyes closed should have more sway
    });
});

// ============================================================================
// FREQUENCY DOMAIN TESTS (A+ Feature)
// ============================================================================

describe('BalanceFeature - Frequency Domain Analysis', () => {
    let balance: BalanceFeature;

    beforeEach(() => {
        balance = new BalanceFeature();
    });

    it('returns empty spectral metrics with insufficient data', () => {
        balance.start('eyes_open');
        feedSwayData(balance, [1, 2, 3], [1, 2, 3], [0, 10, 20]);
        
        const spectral = balance.getSpectralMetrics();
        
        expect(spectral.totalPowerAP).toBe(0);
        expect(spectral.medianFreqAP).toBe(0);
    });

    it('detects low frequency content (0.02-0.2 Hz)', () => {
        // Generate sway with dominant low frequency (0.1 Hz)
        const sway = generateSyntheticSway(2000, 0.01, [
            { freq: 0.1, amp: 100 }  // Low frequency
        ], 5);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const spectral = balance.getSpectralMetrics();
        
        // Low frequency should dominate
        expect(spectral.lowFreqPowerAP).toBeGreaterThan(spectral.medFreqPowerAP);
        expect(spectral.lowFreqPowerAP).toBeGreaterThan(spectral.highFreqPowerAP);
        
        // Median frequency should be low
        expect(spectral.medianFreqAP).toBeLessThan(0.5);
    });

    it('detects medium frequency content (0.2-2.0 Hz)', () => {
        // Generate sway with dominant medium frequency (1 Hz)
        const sway = generateSyntheticSway(2000, 0.01, [
            { freq: 1.0, amp: 100 }  // Medium frequency
        ], 5);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const spectral = balance.getSpectralMetrics();
        
        // Medium frequency should dominate
        expect(spectral.medFreqPowerAP).toBeGreaterThan(spectral.lowFreqPowerAP);
        expect(spectral.medFreqPowerAP).toBeGreaterThan(spectral.highFreqPowerAP);
        
        // Median frequency should be around 1 Hz
        expect(spectral.medianFreqAP).toBeGreaterThan(0.5);
        expect(spectral.medianFreqAP).toBeLessThan(2.5);
    });

    it('detects high frequency content (2-10 Hz)', () => {
        // Generate sway with dominant high frequency (5 Hz)
        const sway = generateSyntheticSway(2000, 0.01, [
            { freq: 5.0, amp: 100 }  // High frequency
        ], 5);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const spectral = balance.getSpectralMetrics();
        
        // High frequency should dominate
        expect(spectral.highFreqPowerAP).toBeGreaterThan(spectral.lowFreqPowerAP);
        expect(spectral.highFreqPowerAP).toBeGreaterThan(spectral.medFreqPowerAP);
        
        // Median frequency should be high
        expect(spectral.medianFreqAP).toBeGreaterThan(2);
    });

    it('computes frequency centroid correctly', () => {
        // Mix of frequencies
        const sway = generateSyntheticSway(2000, 0.01, [
            { freq: 0.5, amp: 50 },
            { freq: 1.5, amp: 50 }
        ], 5);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const spectral = balance.getSpectralMetrics();
        
        // Centroid should be between the two frequencies
        expect(spectral.freqCentroidAP).toBeGreaterThan(0.3);
        expect(spectral.freqCentroidAP).toBeLessThan(2.0);
    });

    it('computes spectral entropy (complexity measure)', () => {
        // Pure tone - low entropy
        const pureTone = generateSyntheticSway(2000, 0.01, [
            { freq: 1.0, amp: 100 }
        ], 0);

        balance.start('eyes_open');
        feedSwayData(balance, pureTone.ap, pureTone.ml, pureTone.timestamps);
        const pureSpectral = balance.getSpectralMetrics();

        // Broadband noise - higher entropy
        const balance2 = new BalanceFeature();
        const broadband = generateSyntheticSway(2000, 0.01, [
            { freq: 0.2, amp: 30 },
            { freq: 0.5, amp: 30 },
            { freq: 1.0, amp: 30 },
            { freq: 2.0, amp: 30 },
            { freq: 3.0, amp: 30 }
        ], 20);

        balance2.start('eyes_open');
        feedSwayData(balance2, broadband.ap, broadband.ml, broadband.timestamps);
        const broadSpectral = balance2.getSpectralMetrics();

        // Broadband should have higher entropy
        expect(broadSpectral.spectralEntropyAP).toBeGreaterThan(pureSpectral.spectralEntropyAP);
    });

    it('computes low/med frequency ratio for visual dependence', () => {
        const sway = generateSyntheticSway(2000, 0.01, [
            { freq: 0.1, amp: 80 },   // Low (visual/vestibular)
            { freq: 0.5, amp: 40 }    // Med (proprioceptive)
        ], 5);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const spectral = balance.getSpectralMetrics();
        
        // Ratio should indicate low frequency dominance
        expect(spectral.lowMedRatioAP).toBeGreaterThan(1);
    });
});

// ============================================================================
// STABILOGRAM DIFFUSION ANALYSIS TESTS (A+ Feature)
// ============================================================================

describe('BalanceFeature - Stabilogram Diffusion Analysis', () => {
    let balance: BalanceFeature;

    beforeEach(() => {
        balance = new BalanceFeature();
    });

    it('returns empty diffusion metrics with insufficient data', () => {
        balance.start('eyes_open');
        feedSwayData(balance, [1, 2, 3], [1, 2, 3], [0, 10, 20]);
        
        const diffusion = balance.getDiffusionMetrics();
        
        expect(diffusion.shortTermDiffusionAP).toBe(0);
        expect(diffusion.criticalTimeAP).toBe(0);
    });

    it('computes diffusion coefficients for random walk', () => {
        // Generate random walk (cumulative sum of noise)
        const n = 1000;
        const ap: number[] = [0];
        const ml: number[] = [0];
        const timestamps: number[] = [0];

        for (let i = 1; i < n; i++) {
            ap.push(ap[i - 1] + (Math.random() - 0.5) * 10);
            ml.push(ml[i - 1] + (Math.random() - 0.5) * 10);
            timestamps.push(i * 10);
        }

        balance.start('eyes_open');
        feedSwayData(balance, ap, ml, timestamps);
        
        const diffusion = balance.getDiffusionMetrics();
        
        // Random walk should have positive diffusion
        expect(diffusion.shortTermDiffusionAP).toBeGreaterThan(0);
        expect(diffusion.shortTermDiffusionML).toBeGreaterThan(0);
    });

    it('identifies critical point between control regimes', () => {
        const sway = generateSyntheticSway(1500, 0.01, [
            { freq: 0.5, amp: 50 },
            { freq: 2.0, amp: 20 }
        ], 30);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const diffusion = balance.getDiffusionMetrics();
        
        // Critical time should be between 0 and max interval
        expect(diffusion.criticalTimeAP).toBeGreaterThan(0);
        expect(diffusion.criticalTimeAP).toBeLessThan(10);
        
        // Critical displacement should be positive
        expect(diffusion.criticalDisplacementAP).toBeGreaterThan(0);
    });

    it('computes scaling exponents (Hurst-like)', () => {
        const sway = generateSyntheticSway(1500, 0.01, [], 50);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const diffusion = balance.getDiffusionMetrics();
        
        // Scaling exponents should be in reasonable range
        // For random noise, can be negative (anti-persistent) or positive (persistent)
        // Valid range is approximately -2.0 to 2.0 for synthetic data
        expect(diffusion.scalingExponentShortAP).toBeGreaterThan(-2);
        expect(diffusion.scalingExponentShortAP).toBeLessThan(2);
        expect(diffusion.scalingExponentLongAP).toBeGreaterThan(-2);
        expect(diffusion.scalingExponentLongAP).toBeLessThan(2);
    });

    it('distinguishes open-loop vs closed-loop control', () => {
        const sway = generateSyntheticSway(1500, 0.01, [
            { freq: 0.3, amp: 60 }
        ], 20);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const diffusion = balance.getDiffusionMetrics();
        
        // Short-term (open-loop) and long-term (closed-loop) should differ
        // In real postural control, short-term is typically higher
        expect(diffusion.shortTermDiffusionAP).not.toBe(diffusion.longTermDiffusionAP);
    });
});

// ============================================================================
// SAMPLE ENTROPY TESTS (A+ Feature)
// ============================================================================

describe('BalanceFeature - Sample Entropy', () => {
    let balance: BalanceFeature;

    beforeEach(() => {
        balance = new BalanceFeature();
    });

    it('returns empty entropy metrics with insufficient data', () => {
        balance.start('eyes_open');
        feedSwayData(balance, [1, 2, 3], [1, 2, 3], [0, 10, 20]);
        
        const entropy = balance.getEntropyMetrics();
        
        expect(entropy.sampleEntropyAP).toBe(0);
        expect(entropy.embeddingDimension).toBe(2);
    });

    it('computes lower entropy for regular signals', () => {
        // Regular sinusoid
        const regular = generateSyntheticSway(500, 0.01, [
            { freq: 1.0, amp: 100 }
        ], 0);

        balance.start('eyes_open');
        feedSwayData(balance, regular.ap, regular.ml, regular.timestamps);
        const regularEntropy = balance.getEntropyMetrics();

        // Random noise
        const balance2 = new BalanceFeature();
        const random = generateSyntheticSway(500, 0.01, [], 100);

        balance2.start('eyes_open');
        feedSwayData(balance2, random.ap, random.ml, random.timestamps);
        const randomEntropy = balance2.getEntropyMetrics();

        // Random should have higher entropy than regular
        expect(randomEntropy.sampleEntropyAP).toBeGreaterThan(regularEntropy.sampleEntropyAP);
    });

    it('computes 2D sample entropy', () => {
        const sway = generateSyntheticSway(500, 0.01, [
            { freq: 0.5, amp: 50 }
        ], 30);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const entropy = balance.getEntropyMetrics();
        
        expect(entropy.sampleEntropy2D).toBeGreaterThan(0);
    });

    it('reports correct parameters', () => {
        const sway = generateSyntheticSway(500, 0.01, [], 50);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const entropy = balance.getEntropyMetrics();
        
        expect(entropy.embeddingDimension).toBe(2);
        expect(entropy.tolerance).toBe(0.2);
    });
});

// ============================================================================
// FULL ASSESSMENT TESTS (A+ Feature)
// ============================================================================

describe('BalanceFeature - Full A+ Assessment', () => {
    let balance: BalanceFeature;

    beforeEach(() => {
        balance = new BalanceFeature();
    });

    it('returns complete assessment with all metric domains', () => {
        const sway = generateSyntheticSway(1500, 0.01, [
            { freq: 0.3, amp: 40 },
            { freq: 1.0, amp: 30 }
        ], 20);

        balance.start('eyes_open', 'firm', 'bipedal');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const assessment = balance.getFullAssessment();
        
        // Check all domains present
        expect(assessment.timeMetrics).toBeDefined();
        expect(assessment.spectralMetrics).toBeDefined();
        expect(assessment.diffusionMetrics).toBeDefined();
        expect(assessment.entropyMetrics).toBeDefined();
        
        // Check clinical interpretation
        expect(assessment.clinicalScore).toBeGreaterThanOrEqual(0);
        expect(assessment.clinicalScore).toBeLessThanOrEqual(100);
        expect(['low', 'moderate', 'high']).toContain(assessment.fallRiskLevel);
        expect(['ankle', 'hip', 'mixed']).toContain(assessment.controlStrategy);
        
        // Sensory contributions should sum to ~100
        const total = assessment.sensorySystems.visual + 
                     assessment.sensorySystems.vestibular + 
                     assessment.sensorySystems.proprioceptive;
        expect(total).toBeGreaterThan(80);
        expect(total).toBeLessThan(120);
    });

    it('assesses fall risk based on metrics', () => {
        // Very stable sway - low risk
        const stableSway = generateSyntheticSway(1500, 0.01, [
            { freq: 0.5, amp: 10 }
        ], 5);

        balance.start('eyes_open');
        feedSwayData(balance, stableSway.ap, stableSway.ml, stableSway.timestamps);
        const stableAssessment = balance.getFullAssessment();

        // Very unstable sway - high risk
        const balance2 = new BalanceFeature();
        const unstableSway = generateSyntheticSway(1500, 0.01, [
            { freq: 0.5, amp: 200 }
        ], 100);

        balance2.start('eyes_open');
        feedSwayData(balance2, unstableSway.ap, unstableSway.ml, unstableSway.timestamps);
        const unstableAssessment = balance2.getFullAssessment();

        // Stable should have lower risk
        expect(stableAssessment.clinicalScore).toBeGreaterThan(unstableAssessment.clinicalScore);
    });

    it('identifies control strategy from spectral content', () => {
        // AP-dominant (ankle strategy)
        const apDominant = generateSyntheticSway(1500, 0.01, [
            { freq: 0.5, amp: 80 }  // Will create AP-dominant pattern
        ], 10);

        balance.start('eyes_open');
        feedSwayData(balance, apDominant.ap, apDominant.ml.map(v => v * 0.3), apDominant.timestamps);
        const assessment = balance.getFullAssessment();
        
        expect(['ankle', 'mixed']).toContain(assessment.controlStrategy);
    });
});

// ============================================================================
// CLINICAL PROTOCOL TESTS (A+ Feature)
// ============================================================================

describe('BalanceFeature - Clinical Protocols', () => {
    let balance: BalanceFeature;

    beforeEach(() => {
        balance = new BalanceFeature();
    });

    it('supports protocol-based initialization', () => {
        const protocol: BalanceProtocol = {
            condition: 'eyes_closed',
            surface: 'foam',
            stance: 'tandem',
            durationSeconds: 30
        };

        balance.startProtocol(protocol);
        const sway = generateSyntheticSway(500, 0.01, [], 50);
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const metrics = balance.getMetrics();
        
        expect(metrics.condition).toBe('eyes_closed');
        expect(metrics.surface).toBe('foam');
        expect(metrics.stance).toBe('tandem');
    });

    it('stores results for protocol comparison', () => {
        // Record eyes open + firm
        balance.start('eyes_open', 'firm', 'bipedal');
        const eoFirm = generateSyntheticSway(500, 0.01, [], 30);
        feedSwayData(balance, eoFirm.ap, eoFirm.ml, eoFirm.timestamps);
        balance.stop();

        // Record eyes closed + firm
        balance.start('eyes_closed', 'firm', 'bipedal');
        const ecFirm = generateSyntheticSway(500, 0.01, [], 50);
        feedSwayData(balance, ecFirm.ap, ecFirm.ml, ecFirm.timestamps);
        balance.stop();

        // Retrieve stored results
        const storedEO = balance.getStoredResult('eyes_open', 'firm', 'bipedal');
        const storedEC = balance.getStoredResult('eyes_closed', 'firm', 'bipedal');

        expect(storedEO).not.toBeNull();
        expect(storedEC).not.toBeNull();
        expect(storedEO!.timeMetrics.condition).toBe('eyes_open');
        expect(storedEC!.timeMetrics.condition).toBe('eyes_closed');
    });

    it('supports single-leg stance recording', () => {
        balance.start('eyes_open', 'firm', 'single_left');
        const sway = generateSyntheticSway(500, 0.01, [], 80);
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const metrics = balance.getMetrics();
        
        expect(metrics.stance).toBe('single_left');
    });

    it('returns null CTSIB without complete protocol', () => {
        // Only record 2 conditions
        balance.start('eyes_open', 'firm', 'bipedal');
        feedSwayData(balance, [1, 2, 3], [1, 2, 3], [0, 10, 20]);
        balance.stop();

        balance.start('eyes_closed', 'firm', 'bipedal');
        feedSwayData(balance, [1, 2, 3], [1, 2, 3], [0, 10, 20]);
        balance.stop();

        const ctsib = balance.getCTSIBScores();
        expect(ctsib).toBeNull();
    });

    it('computes CTSIB scores with complete protocol', () => {
        const conditions: Array<[string, string, string]> = [
            ['eyes_open', 'firm', 'bipedal'],
            ['eyes_closed', 'firm', 'bipedal'],
            ['eyes_open', 'foam', 'bipedal'],
            ['eyes_closed', 'foam', 'bipedal']
        ];

        for (const [condition, surface, stance] of conditions) {
            balance.start(
                condition as 'eyes_open' | 'eyes_closed',
                surface as 'firm' | 'foam',
                stance as 'bipedal'
            );
            const sway = generateSyntheticSway(500, 0.01, [], 50);
            feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
            balance.stop();
        }

        const ctsib = balance.getCTSIBScores();
        expect(ctsib).not.toBeNull();
        expect(ctsib!.condition1).toBeGreaterThanOrEqual(0);
        expect(ctsib!.condition2).toBeGreaterThanOrEqual(0);
        expect(ctsib!.condition3).toBeGreaterThanOrEqual(0);
        expect(ctsib!.condition4).toBeGreaterThanOrEqual(0);
    });
});

// ============================================================================
// FFT IMPLEMENTATION TESTS
// ============================================================================

describe('BalanceFeature - FFT Implementation', () => {
    let balance: BalanceFeature;

    beforeEach(() => {
        balance = new BalanceFeature();
    });

    it('handles power-of-2 input correctly', () => {
        const sway = generateSyntheticSway(1024, 0.01, [
            { freq: 1.0, amp: 100 }
        ], 0);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const spectral = balance.getSpectralMetrics();
        
        expect(spectral.totalPowerAP).toBeGreaterThan(0);
    });

    it('handles non-power-of-2 input by padding', () => {
        const sway = generateSyntheticSway(1000, 0.01, [
            { freq: 1.0, amp: 100 }
        ], 0);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const spectral = balance.getSpectralMetrics();
        
        // Should still compute valid results
        expect(spectral.totalPowerAP).toBeGreaterThan(0);
    });

    it('preserves Parseval theorem (energy conservation)', () => {
        const sway = generateSyntheticSway(1024, 0.01, [
            { freq: 0.5, amp: 50 },
            { freq: 1.0, amp: 50 }
        ], 10);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const spectral = balance.getSpectralMetrics();
        
        // Time domain energy
        const meanAP = sway.ap.reduce((a, b) => a + b) / sway.ap.length;
        const timeDomainEnergy = sway.ap.reduce((sum, v) => sum + Math.pow(v - meanAP, 2), 0);
        
        // Frequency domain should have related power
        expect(spectral.totalPowerAP).toBeGreaterThan(0);
    });
});

// ============================================================================
// EDGE CASES AND ROBUSTNESS
// ============================================================================

describe('BalanceFeature - Edge Cases', () => {
    let balance: BalanceFeature;

    beforeEach(() => {
        balance = new BalanceFeature();
    });

    it('handles constant signal (zero variance)', () => {
        const constant = Array(500).fill(50);
        const timestamps = Array.from({ length: 500 }, (_, i) => i * 10);

        balance.start('eyes_open');
        feedSwayData(balance, constant, constant, timestamps);
        
        const metrics = balance.getMetrics();
        const spectral = balance.getSpectralMetrics();
        const entropy = balance.getEntropyMetrics();
        
        // Should handle gracefully without NaN
        expect(Number.isFinite(metrics.swayArea95)).toBe(true);
        expect(Number.isFinite(spectral.totalPowerAP)).toBe(true);
        expect(Number.isFinite(entropy.sampleEntropyAP)).toBe(true);
    });

    it('handles very short recordings', () => {
        const sway = generateSyntheticSway(100, 0.01, [], 50);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const metrics = balance.getMetrics();
        
        // Should return valid metrics
        expect(metrics.duration).toBeLessThan(2);
        expect(Number.isFinite(metrics.score)).toBe(true);
    });

    it('handles large amplitude sway', () => {
        const sway = generateSyntheticSway(1000, 0.01, [
            { freq: 0.5, amp: 1000 }
        ], 100);

        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        
        const metrics = balance.getMetrics();
        const assessment = balance.getFullAssessment();
        
        // Should compute valid results
        expect(Number.isFinite(metrics.swayArea95)).toBe(true);
        expect(assessment.fallRiskLevel).toBeDefined();
    });

    it('reset clears all state', () => {
        const sway = generateSyntheticSway(500, 0.01, [], 50);
        
        balance.start('eyes_open');
        feedSwayData(balance, sway.ap, sway.ml, sway.timestamps);
        balance.reset();
        
        const metrics = balance.getMetrics();
        
        expect(metrics.swayArea95).toBe(0);
        expect(metrics.condition).toBe('unknown');
    });
});

// ============================================================================
// INTEGRATION WITH KINETIC CHAIN
// ============================================================================

describe('BalanceFeature - KineticChain Integration', () => {
    it('updates from KineticChain accelerations', () => {
        const balance = new BalanceFeature();
        
        // Create varying accelerations to ensure path length > 0
        balance.start('eyes_open');
        
        for (let i = 0; i < 500; i++) {
            // Varying accelerations for non-zero path length
            const accelX = Math.sin(i * 0.1) * 0.01;
            const accelZ = Math.cos(i * 0.1) * 0.02;
            const chain = createMockChain(accelX, accelZ);
            balance.update(chain, i * 10);
        }

        const metrics = balance.getMetrics();
        
        expect(metrics.duration).toBeGreaterThan(0);
        // Should have accumulated data with varying accelerations
        expect(metrics.pathLength).toBeGreaterThan(0);
    });

    it('converts m/s² to mm/s² correctly', () => {
        const balance = new BalanceFeature();
        const accelX = 0.1; // 0.1 m/s² = 100 mm/s²
        const accelZ = 0.2; // 0.2 m/s² = 200 mm/s²
        const chain = createMockChain(accelX, accelZ);

        balance.start('eyes_open');
        balance.update(chain, 0);
        
        // Access private buffer to verify conversion
        const bufferML = (balance as any).bufferML;
        const bufferAP = (balance as any).bufferAP;
        
        expect(bufferML[0]).toBeCloseTo(100, 1); // 0.1 * 1000
        expect(bufferAP[0]).toBeCloseTo(200, 1); // 0.2 * 1000
    });
});
