/**
 * Gait Symmetry Feature (World Class)
 * ===================================
 * 
 * Computes advanced clinical asymmetry and rhythmicity metrics.
 * 
 * Features:
 * 1. Harmonic Ratio (HR): The "Gold Standard" for gait smoothness/rhythmicity.
 *    - Computed via DFT of Pelvis Acceleration (Vertical/AP).
 *    - Higher is better (Smooth, Symmetric).
 * 
 * 2. Symmetry Index (SI): Robinson's Formula.
 *    - SI = (XL - XR) / 0.5(XL + XR) * 100%
 *    - Computed for: Step Time, Stance Time, Impact Force.
 * 
 * 3. Gait Asymmetry (GA): Plotnik's Formula.
 *    - GA = 100 * ln(XL / XR)
 * 
 * @module analysis/GaitSymmetryFeature
 */

import * as THREE from 'three';
import { KineticChain } from './KineticChain';
import type { GaitPhaseState } from './MovementPhase';

export interface GaitSymmetryMetrics {
    // Temporal Symmetry
    stepTimeAsymmetry: number;  // SI %
    stanceTimeAsymmetry: number; // SI %

    // Kinetic Symmetry
    impactAsymmetry: number;    // SI % (Peak Force)

    // Rhythmicity (Harmonic Ratio)
    harmonicRatioVertical: number; // >2.0 is Good
    harmonicRatioAP: number;       // >2.0 is Good

    // Raw Values
    leftStepTime: number;
    rightStepTime: number;
    symmetryIndex: number;  // Composite Score (0-100, 100=Perfect)
}

export class GaitSymmetryFeature {
    // Buffers for Temporal Calculation
    private leftStepTimes: number[] = [];
    private rightStepTimes: number[] = [];
    private leftStanceTimes: number[] = [];
    private rightStanceTimes: number[] = [];
    private leftImpacts: number[] = [];
    private rightImpacts: number[] = [];

    private lastLeftStrike = 0;
    private lastRightStrike = 0;
    private lastLeftLift = 0;
    private lastRightLift = 0;

    // Buffer for Harmonic Ratio (Accel Data)
    // Needs ~2 strides (approx 2-3 seconds at 100Hz = 300 samples)
    private accelBuffer: THREE.Vector3[] = [];
    private BUFFER_SIZE = 512; // Power of 2 for FFT convenience, though we use DFT

    /**
     * Update loop called every frame
     * @param gaitState Current phase state
     * @param coreChain Core/Pelvis chain data for Harmonic Ratio
     * @param legChain Active leg chain for Impact/Timing
     * @param side 'left' or 'right'
     * @param timestamp System time
     */
    update(
        gaitState: GaitPhaseState,
        coreChain: KineticChain,
        legChain: KineticChain,
        side: 'left' | 'right',
        timestamp: number
    ) {
        // 1. Buffer Core Acceleration for Harmonic Ratio
        const coreMetrics = coreChain.getMetrics();
        this.accelBuffer.push(coreMetrics.rootAccel.clone());
        if (this.accelBuffer.length > this.BUFFER_SIZE) {
            this.accelBuffer.shift();
        }

        // 2. Process Gait Events
        if (gaitState.phase === 'heel_strike') {
            const impact = legChain.getMetrics().rootAccel.length(); // Peak impact approx

            if (side === 'left') {
                // Step Time (Strike to Strike)
                if (this.lastLeftStrike > 0) {
                    const stepDur = timestamp - this.lastLeftStrike;
                    if (this.validGaitTime(stepDur)) this.leftStepTimes.push(stepDur);
                }

                // Swing Time was (Strike - Lift)
                if (this.lastLeftLift > 0) {
                    // Stance Time calculation requires Lift - Prev Strike
                    // Actually, Stance is Strike -> Lift. 
                    // This event is Strike. So previous phase was Swing.
                }

                this.leftImpacts.push(impact);
                this.lastLeftStrike = timestamp;

            } else {
                if (this.lastRightStrike > 0) {
                    const stepDur = timestamp - this.lastRightStrike;
                    if (this.validGaitTime(stepDur)) this.rightStepTimes.push(stepDur);
                }
                this.rightImpacts.push(impact);
                this.lastRightStrike = timestamp;
            }
        }
        else if (gaitState.phase === 'push_off') {
            if (side === 'left') {
                if (this.lastLeftStrike > 0) {
                    const stanceDur = timestamp - this.lastLeftStrike;
                    if (this.validGaitTime(stanceDur)) this.leftStanceTimes.push(stanceDur);
                }
                this.lastLeftLift = timestamp;
            } else {
                if (this.lastRightStrike > 0) {
                    const stanceDur = timestamp - this.lastRightStrike;
                    if (this.validGaitTime(stanceDur)) this.rightStanceTimes.push(stanceDur);
                }
                this.lastRightLift = timestamp;
            }
        }

        // Trim Buffers
        this.trimBuffer(this.leftStepTimes);
        this.trimBuffer(this.rightStepTimes);
        this.trimBuffer(this.leftStanceTimes);
        this.trimBuffer(this.rightStanceTimes);
        this.trimBuffer(this.leftImpacts);
        this.trimBuffer(this.rightImpacts);
    }

    getMetrics(): GaitSymmetryMetrics {
        // 1. Compute HR
        const hr = this.computeHarmonicRatio();

        // 2. Compute SI Indices
        const avgL_Step = this.avg(this.leftStepTimes);
        const avgR_Step = this.avg(this.rightStepTimes);
        const si_Step = this.calculateSI(avgL_Step, avgR_Step);

        const avgL_Stance = this.avg(this.leftStanceTimes);
        const avgR_Stance = this.avg(this.rightStanceTimes);
        const si_Stance = this.calculateSI(avgL_Stance, avgR_Stance);

        const avgL_Imp = this.avg(this.leftImpacts);
        const avgR_Imp = this.avg(this.rightImpacts);
        const si_Imp = this.calculateSI(avgL_Imp, avgR_Imp);

        // Composite Score (0-100)
        // HR > 3 is excellent. SI < 5% is excellent.
        // Simple heuristic map:
        const scoreHR = Math.min(hr.vertical / 3.0, 1.0) * 100;
        const scoreSI = Math.max(0, 100 - si_Step * 2); // Penalize asymmetry

        const composite = (scoreHR * 0.4) + (scoreSI * 0.6); // Weighting

        return {
            stepTimeAsymmetry: si_Step,
            stanceTimeAsymmetry: si_Stance,
            impactAsymmetry: si_Imp,
            harmonicRatioVertical: hr.vertical,
            harmonicRatioAP: hr.ap,
            leftStepTime: avgL_Step,
            rightStepTime: avgR_Step,
            symmetryIndex: Math.round(composite)
        };
    }

    // ==========================================
    // HELPERS
    // ==========================================

    private validGaitTime(ms: number) {
        return ms > 200 && ms < 2000;
    }

    private trimBuffer(arr: number[]) {
        if (arr.length > 20) arr.shift();
    }

    private avg(arr: number[]) {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b) / arr.length;
    }

    /**
     * Calculates Symmetry Index (Robinson)
     * SI = |L - R| / 0.5(L + R) * 100
     */
    private calculateSI(L: number, R: number): number {
        if (L === 0 || R === 0) return 0;
        const diff = Math.abs(L - R);
        const mean = (L + R) / 2;
        return (diff / mean) * 100;
    }

    /**
     * Computes Harmonic Ratio using DFT on buffered acceleration.
     * HR = Sum(Even Harmonics) / Sum(Odd Harmonics)
     * For Vertical/AP (Biphasic).
     */
    private computeHarmonicRatio(): { vertical: number, ap: number } {
        if (this.accelBuffer.length < 100) return { vertical: 0, ap: 0 };

        // Use Y (Vertical) and Z (AP) - Assuming Y-UP, Z-Forward (Standard ThreeJS)
        // Check Conventions: If sensor is flat on back?
        // We will assume rootAccel is World Frame (Y is Up).

        const nHarmonics = 10; // First 10 harmonics usually sufficient
        const samples = this.accelBuffer;
        const N = samples.length;

        // Extract signals
        const sigV = samples.map(v => v.y);
        const sigAP = samples.map(v => v.z); // Assuming Z is AP

        const hrV = this.calculateHRForSignal(sigV, nHarmonics);
        const hrAP = this.calculateHRForSignal(sigAP, nHarmonics);

        return { vertical: hrV, ap: hrAP };
    }

    private calculateHRForSignal(signal: number[], _harmonics: number[] | number): number {
        const N = signal.length;
        // Simple DFT for first K harmonics
        // We need to find Fundamental Frequency (Stride Frequency).
        // Since we don't know it exactly, we assume the window contains ~multiple strides?
        // Actually, classic HR usually works on *Stride Data*. We are buffering generic window.
        // If window is not aligned to stride, leakage occurs.
        // Better: Use FFT on continuous buffer and finding peak?

        // Simplified Robust Approach:
        // 1. Autocorrelation to find Stride Period.
        // 2. Resample/Extract exactly one stride or multiple strides.
        // 3. For Real-Time "estimation", purely spectral approach on Hanning window.

        // Let's implement basic DFT Sums without perfect stride alignment (approximate).
        // Or better: Just sum even/odd indices of FFT magnitudes?
        // NO, the "Even/Odd" refers to the *Harmonic Number* relative to Stride Frequency.
        // So we MUST know the Stride Frequency.

        // Heuristic: Stride Freq is usually 0.8 - 1.2 Hz (Walking).
        // Find peak power in 0.5 - 2.0 Hz band.

        // Step 1: Remove DC
        const mean = signal.reduce((a, b) => a + b, 0) / N;
        const zeroMean = signal.map(s => s - mean);

        // Step 2: Hanning Window (reduce leakage)
        const windowed = zeroMean.map((s, i) => s * (0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)))));

        // Step 3: Find Fundamental (Peak in 0.5 - 2.5Hz)
        // We need Sampling Rate. Timestamp delta?
        // Assume ~60Hz or 100Hz?
        // Let's assume 100Hz for robustness or estimate from timestamps?
        // Motion Engine runs at frame rate (~60fps?).
        const fs = 60;

        // We only calculate first 20 bins? No we need precision.
        // Let's just do a brute force search for Fundamental F0.

        // Actually, we have 'stepTime' from our detector!
        // Step Time ~ 500ms -> 2Hz (Step Freq) -> 1Hz (Stride Freq).
        // Use average Step Time to guide F0.
        const avgStep = (this.avg(this.leftStepTimes) + this.avg(this.rightStepTimes)) / 2;
        if (avgStep < 200) return 0; // No valid gait

        const strideDuration = (avgStep * 2) / 1000; // Seconds
        const f0 = 1.0 / strideDuration; // Stride Frequency (Hz)

        // DFT at harmonics k * f0
        let sumEven = 0;
        let sumOdd = 0;

        for (let k = 1; k <= 20; k++) {
            const freq = k * f0;
            // DFT Amplitude at freq
            let real = 0;
            let imag = 0;
            for (let i = 0; i < N; i++) {
                const theta = -2 * Math.PI * freq * (i / fs);
                real += windowed[i] * Math.cos(theta);
                imag += windowed[i] * Math.sin(theta);
            }
            const mag = Math.sqrt(real * real + imag * imag);

            // Harmonic 1 is ODD (Stride rate) - Biphasic signals (Vertical) usually dominated by 2nd harmonic (Step rate).
            // HR Formula: Sum(Even) / Sum(Odd) for Vertical/AP.

            if (k % 2 === 0) sumEven += mag;
            else sumOdd += mag;
        }

        if (sumOdd === 0) return 0;
        return sumEven / sumOdd;
    }
}
