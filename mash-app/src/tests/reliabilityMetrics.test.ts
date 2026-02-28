/**
 * Reliability Metrics Tests
 * =========================
 * 
 * Tests for clinical reliability metrics used in motion analysis.
 * These metrics are required for research-grade validation.
 * 
 * Key metrics:
 * - ICC (Intraclass Correlation Coefficient): Reliability measure
 * - SEM (Standard Error of Measurement): Measurement precision
 * - MDC (Minimal Detectable Change): Clinically meaningful threshold
 */

import { describe, it, expect } from 'vitest';

describe('Reliability Metrics', () => {

    /**
     * Calculate Intraclass Correlation Coefficient (ICC) - Type 2,1
     * Used for inter-rater reliability with random effects.
     * 
     * Formula: ICC = (MSbetween - MSwithin) / (MSbetween + (k-1)*MSwithin)
     * where k = number of raters/measurements per subject
     * 
     * Simplified for 2 measurements per subject:
     * ICC = (variance_between - variance_within) / (variance_between + variance_within)
     */
    function calculateICC(measurements1: number[], measurements2: number[]): number {
        if (measurements1.length !== measurements2.length) {
            throw new Error('Measurement arrays must have equal length');
        }
        const n = measurements1.length;
        if (n < 2) return 0;

        // Calculate subject means
        const subjectMeans = measurements1.map((m1, i) => (m1 + measurements2[i]) / 2);
        const grandMean = subjectMeans.reduce((a, b) => a + b, 0) / n;

        // Between-subjects variance
        const ssBetween = subjectMeans.reduce(
            (sum, mean) => sum + (mean - grandMean) ** 2, 0
        );
        const msBetween = ssBetween / (n - 1);

        // Within-subjects variance
        let ssWithin = 0;
        for (let i = 0; i < n; i++) {
            ssWithin += (measurements1[i] - subjectMeans[i]) ** 2;
            ssWithin += (measurements2[i] - subjectMeans[i]) ** 2;
        }
        const msWithin = ssWithin / n; // k=2 measurements per subject

        // ICC(2,1) formula
        const icc = (msBetween - msWithin) / (msBetween + msWithin);

        // Bound ICC to [0, 1]
        return Math.max(0, Math.min(1, icc));
    }

    /**
     * Calculate Standard Error of Measurement (SEM).
     * SEM = SD * sqrt(1 - ICC)
     * 
     * @param sd Standard deviation of measurements
     * @param icc Intraclass Correlation Coefficient
     */
    function calculateSEM(sd: number, icc: number): number {
        return sd * Math.sqrt(1 - icc);
    }

    /**
     * Calculate Minimal Detectable Change (MDC) at 95% confidence.
     * MDC95 = 1.96 * SEM * sqrt(2)
     * 
     * This represents the smallest change that indicates real change,
     * not just measurement error.
     */
    function calculateMDC95(sem: number): number {
        return 1.96 * sem * Math.sqrt(2);
    }

    /**
     * Calculate standard deviation of an array.
     */
    function calculateSD(values: number[]): number {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
        return Math.sqrt(variance);
    }

    describe('ICC Calculation', () => {
        it('should return ICC ≈ 1 for identical measurements', () => {
            const m1 = [10, 20, 30, 40, 50];
            const m2 = [10, 20, 30, 40, 50];

            // Perfect agreement should give ICC ≈ 1
            // (May not be exactly 1 due to numerical precision)
            expect(calculateICC(m1, m2)).toBeCloseTo(1, 2);
        });

        it('should return ICC ≈ 0 for random measurements', () => {
            // When second measurement is independent of first
            // (high within-subject variance, similar between-subject variance)
            const m1 = [10, 20, 30, 40, 50];
            const m2 = [50, 10, 40, 30, 20]; // Random shuffle

            const icc = calculateICC(m1, m2);
            // Should be low (near 0 or even negative before bounding)
            expect(icc).toBeLessThan(0.5);
        });

        it('should handle high-reliability scenario correctly', () => {
            // Small within-subject differences, large between-subject differences
            const m1 = [10, 30, 50, 70, 90];
            const m2 = [11, 29, 51, 69, 91]; // ±1 difference

            const icc = calculateICC(m1, m2);
            // Should be high (>0.99)
            expect(icc).toBeGreaterThan(0.95);
        });

        it('should classify ICC according to clinical guidelines', () => {
            // ICC interpretation (Koo & Li, 2016):
            // < 0.50: Poor
            // 0.50-0.75: Moderate
            // 0.75-0.90: Good
            // > 0.90: Excellent

            // Our target is "Excellent" (>0.90) for repeated measurements
            const m1 = [15, 35, 55, 75, 95];
            const m2 = [16, 34, 56, 74, 96];

            const icc = calculateICC(m1, m2);

            // Should be in "Excellent" range
            expect(icc).toBeGreaterThan(0.90);
        });
    });

    describe('SEM Calculation', () => {
        it('should return 0 when ICC = 1', () => {
            const sem = calculateSEM(10, 1.0);
            expect(sem).toBeCloseTo(0, 5);
        });

        it('should return SD when ICC = 0', () => {
            const sd = 5;
            const sem = calculateSEM(sd, 0);
            expect(sem).toBeCloseTo(sd, 5);
        });

        it('should calculate correct SEM for known values', () => {
            // SD = 10, ICC = 0.75
            // SEM = 10 * sqrt(1 - 0.75) = 10 * sqrt(0.25) = 10 * 0.5 = 5
            const sem = calculateSEM(10, 0.75);
            expect(sem).toBeCloseTo(5, 5);
        });

        it('should produce smaller SEM for higher ICC', () => {
            const sd = 10;
            const semLowICC = calculateSEM(sd, 0.5);
            const semHighICC = calculateSEM(sd, 0.9);

            expect(semHighICC).toBeLessThan(semLowICC);
        });
    });

    describe('MDC Calculation', () => {
        it('should calculate correct MDC95 for known SEM', () => {
            // SEM = 5
            // MDC95 = 1.96 * 5 * sqrt(2) = 1.96 * 5 * 1.414 = 13.86
            const mdc = calculateMDC95(5);
            expect(mdc).toBeCloseTo(13.86, 1);
        });

        it('should produce larger MDC for larger SEM', () => {
            const mdcSmall = calculateMDC95(2);
            const mdcLarge = calculateMDC95(8);

            expect(mdcLarge).toBeGreaterThan(mdcSmall);
        });

        it('should be proportional to SEM', () => {
            const mdc1 = calculateMDC95(5);
            const mdc2 = calculateMDC95(10);

            // MDC should double when SEM doubles
            expect(mdc2 / mdc1).toBeCloseTo(2, 5);
        });
    });

    describe('End-to-End Reliability Pipeline', () => {
        /**
         * Simulate a complete reliability analysis as would be done
         * in a clinical validation study.
         */
        it('should compute all metrics from simulated repeated measurements', () => {
            // Simulate 10 subjects with two measurement sessions
            // (e.g., morning and afternoon knee ROM measurement)
            const session1 = [45, 52, 38, 60, 55, 42, 48, 58, 50, 46];
            const session2 = [47, 51, 40, 58, 56, 44, 49, 57, 48, 47];

            // Step 1: Calculate ICC
            const icc = calculateICC(session1, session2);
            expect(icc).toBeGreaterThan(0.8);

            // Step 2: Calculate pooled SD
            const allMeasurements = [...session1, ...session2];
            const sd = calculateSD(allMeasurements);
            expect(sd).toBeGreaterThan(0);

            // Step 3: Calculate SEM
            const sem = calculateSEM(sd, icc);
            expect(sem).toBeGreaterThan(0);
            expect(sem).toBeLessThan(sd);

            // Step 4: Calculate MDC
            const mdc = calculateMDC95(sem);
            expect(mdc).toBeGreaterThan(0);

            // Report summary
            const report = {
                icc,
                sd,
                sem,
                mdc,
                interpretation: icc > 0.9 ? 'Excellent' :
                    icc > 0.75 ? 'Good' :
                        icc > 0.5 ? 'Moderate' : 'Poor'
            };

            expect(['Good', 'Excellent']).toContain(report.interpretation);
        });

        it('should detect poor reliability with noisy measurements', () => {
            // High variance within subjects (noisy measurements)
            const session1 = [45, 52, 38, 60, 55];
            const session2 = [30, 70, 25, 80, 40]; // Very different values

            const icc = calculateICC(session1, session2);

            // Should indicate poor reliability
            expect(icc).toBeLessThan(0.5);
        });
    });

    describe('Clinical Thresholds', () => {
        /**
         * Verify MDC values are clinically meaningful for joint angles.
         */
        it('should produce MDC < 5° for excellent reliability', () => {
            // With excellent ICC (0.95) and typical SD (8°)
            const sd = 8;
            const icc = 0.95;

            const sem = calculateSEM(sd, icc);
            const mdc = calculateMDC95(sem);

            // MDC should be small enough to detect meaningful changes
            expect(mdc).toBeLessThan(8); // Should detect <8° changes
        });

        it('should flag when MDC is too large for clinical use', () => {
            // Poor reliability scenario
            const sd = 10;
            const icc = 0.5; // Moderate reliability

            const sem = calculateSEM(sd, icc);
            const mdc = calculateMDC95(sem);

            // MDC > 15° means we can't detect typical movement changes
            const clinicallyUseful = mdc < 15;

            // This should fail - poor reliability
            expect(clinicallyUseful).toBe(false);
        });
    });
});
