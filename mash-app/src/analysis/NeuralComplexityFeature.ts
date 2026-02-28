/**
 * Neural Complexity Feature (Next-Gen)
 * ====================================
 * 
 * Analyzes the non-linear dynamics of movement to assess the state of the 
 * neuromuscular system.
 * 
 * Concepts:
 * 1. Neural Complexity (Multiscale Entropy - MSE):
 *    - Healthy movement is "complex" (neither random nor rigid).
 *    - Reduced complexity correlates with injury history, fatigue, and aging.
 *    - Calculated using Sample Entropy across multiple time scales.
 * 
 * 2. Local Dynamic Stability (Lyapunov Exponent - LyE):
 *    - Measures the system's sensitivity to perturbations (Chaos Theory).
 *    - High LyE = Unstable (Chaotic).
 *    - Low LyE = Stable (Robust).
 * 
 * Implementation Notes:
 * - These are computationally heavy (O(N^2)).
 * - We use a buffered approach and run analysis periodically (e.g., every 3-5s).
 * - Optimized for real-time JS execution with small windows (N=300-500).
 * 
 * @module analysis/NeuralComplexityFeature
 */

import { KineticChain } from './KineticChain';

export interface NeuralComplexityMetrics {
    complexityScore: number;  // 0-100 (Higher is healthier/more adaptable)
    stabilityIndex: number;   // 0-10 (Lower is more stable)
    entropyByScale: number[]; // Debugging info
}

export class NeuralComplexityFeature {
    private buffer: number[] = [];
    private readonly WINDOW_SIZE = 400; // ~4 seconds @ 100Hz
    private readonly UPDATE_INTERVAL = 2000; // ms
    private lastUpdate = 0;

    private currentMetrics: NeuralComplexityMetrics = {
        complexityScore: 50, // Neutral start
        stabilityIndex: 0,
        entropyByScale: []
    };

    reset() {
        this.buffer = [];
        this.lastUpdate = 0;
        this.currentMetrics = { complexityScore: 50, stabilityIndex: 0, entropyByScale: [] };
    }

    update(coreChain: KineticChain, timestamp: number): NeuralComplexityMetrics {
        const metrics = coreChain.getMetrics();
        // Use Pelvis Accel Magnitude as the proxy for System Dynamics
        // We remove gravity roughly by assuming mean subtraction in the algo, 
        // or just use magnitude if orientation is noisy.
        // Magnitude is rotation-invariant, good for general complexity.
        const mag = metrics.rootAccel.length();

        this.buffer.push(mag);

        if (this.buffer.length > this.WINDOW_SIZE) {
            this.buffer.shift();
        }

        // Periodic Analysis
        if (timestamp - this.lastUpdate > this.UPDATE_INTERVAL && this.buffer.length >= this.WINDOW_SIZE) {
            this.analyze();
            this.lastUpdate = timestamp;
        }

        return this.currentMetrics;
    }

    private analyze() {
        const data = this.buffer;

        // 1. Multiscale Entropy (MSE)
        // Check scales 1, 2, 3, 4, 5.
        // Scale 1 = Raw data. Scale 5 = Coarse grained (avg of 5 samples).
        // Captures short-term vs long-term control.
        const scales = [1, 2, 3, 4, 5];
        const m = 2; // Embedding dimension (standard)
        const r = 0.15 * this.stdDev(data); // Tolerance (standard is 0.15 * SD)

        const entropies: number[] = [];
        let complexitySum = 0;

        for (const scale of scales) {
            const grained = this.coarseGrain(data, scale);
            const sampEn = this.computeSampleEntropy(grained, m, r);
            entropies.push(sampEn);
            complexitySum += sampEn;
        }

        // Complexity Index = Area under MSE curve (Sum of entropies).
        // Healthy gait typical SampEn is ~0.8 - 1.5 per scale.
        // Sum roughly 3.0 - 6.0?
        // Let's normalize to 0-100 heuristically.
        // Higher Complexity = Better.
        this.currentMetrics.complexityScore = Math.min(100, (complexitySum / scales.length) * 50);
        this.currentMetrics.entropyByScale = entropies;


        // 2. Lyapunov Estimate (Simplified)
        // True LyE requires constructing state space (delay embedding) and tracking NN divergence.
        // Computationally expensive.
        // Heuristic: Divergence rate of similar trajectories.
        // We will stick to MSE as the primary "Neural Complexity" metric for now 
        // as it is more robust for short time series and single-dimension data.
        // Stability Index -> Inverse of Complexity at Scale 1? Or Variance?
        // Let's use Scale 1 Entropy (Time-domain irregularity) vs Scale 5 (Structural complexity).

        // Actually, let's implement a very simple LyE proxy:
        // Div(t) = ln(dist(i, j))
        // We'll skip formal LyE in JS for now to preserve frame rate, 
        // relying on MSE as the superior "Health" metric.

        this.currentMetrics.stabilityIndex = entropies[0]; // Short-term irregularity is a proxy for instability/noise
    }

    /**
     * Compute Sample Entropy (SampEn)
     * O(N^2) complexity - keep N small!
     * 
     * @param data Time series
     * @param m Template length
     * @param r Tolerance
     */
    private computeSampleEntropy(data: number[], m: number, r: number): number {
        const N = data.length;
        if (N < m + 1) return 0;

        const countMatches = (L: number): number => {
            let B = 0;
            // Iterate all template vectors
            for (let i = 0; i < N - L; i++) {
                // Compare with all other vectors
                for (let j = 0; j < N - L; j++) {
                    if (i === j) continue; // Self-match exclusion

                    // Check Chebyshev distance (Max abs difference)
                    let match = true;
                    for (let k = 0; k < L; k++) {
                        if (Math.abs(data[i + k] - data[j + k]) > r) {
                            match = false;
                            break;
                        }
                    }
                    if (match) B++;
                }
            }
            return B;
        };

        const A = countMatches(m + 1); // Matches of length m+1
        const B = countMatches(m);     // Matches of length m

        if (A === 0 || B === 0) return 0;

        return -Math.log(A / B);
    }

    /**
     * Coarse Grain the time series (Average non-overlapping windows)
     */
    private coarseGrain(data: number[], scale: number): number[] {
        if (scale === 1) return data;

        const result: number[] = [];
        for (let i = 0; i < data.length - scale; i += scale) {
            let sum = 0;
            for (let k = 0; k < scale; k++) {
                sum += data[i + k];
            }
            result.push(sum / scale);
        }
        return result;
    }

    private stdDev(data: number[]): number {
        if (data.length === 0) return 0;
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        const variance = data.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / data.length;
        return Math.sqrt(variance);
    }
}
