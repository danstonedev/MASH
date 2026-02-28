/**
 * Signal Processor
 *
 * Research-grade signal processing utilities for IMU data analysis.
 * Includes FFT, filtering, and biomechanics-specific calculations.
 */

// @ts-ignore - fft.js doesn't have types
import FFT from "fft.js";

// ============================================
// Types
// ============================================

export interface PowerSpectrum {
  frequencies: number[];
  power: number[];
  dominantFrequency: number;
  totalPower: number;
}

export interface FilteredSignal {
  filtered: number[];
  original: number[];
}

export interface SymmetryResult {
  /** Symmetry Index (0-100%, 100 = perfect symmetry) */
  symmetryIndex: number;
  /** Ratio of Asymmetry (smaller/larger) */
  ratioOfAsymmetry: number;
  /** Gait Asymmetry (percentage difference from perfect) */
  gaitAsymmetry: number;
}

// ============================================
// FFT and Spectral Analysis
// ============================================

/**
 * Compute power spectrum using FFT
 * @param signal - Time series data
 * @param sampleRate - Sampling rate in Hz
 */
export function computePowerSpectrum(
  signal: number[],
  sampleRate: number,
): PowerSpectrum {
  // Pad to next power of 2
  const n = Math.pow(2, Math.ceil(Math.log2(signal.length)));
  const paddedSignal = new Array(n).fill(0);
  signal.forEach((v, i) => (paddedSignal[i] = v));

  // Create FFT instance
  const fft = new FFT(n);
  const out = fft.createComplexArray();
  fft.realTransform(out, paddedSignal);

  // Calculate power spectrum (only positive frequencies)
  const numBins = n / 2;
  const frequencies: number[] = [];
  const power: number[] = [];

  for (let i = 0; i < numBins; i++) {
    frequencies.push((i * sampleRate) / n);
    // Power = magnitude squared
    const real = out[2 * i];
    const imag = out[2 * i + 1];
    power.push((real * real + imag * imag) / n);
  }

  // Find dominant frequency (excluding DC component)
  let maxPower = 0;
  let dominantIdx = 1;
  for (let i = 1; i < power.length; i++) {
    if (power[i] > maxPower) {
      maxPower = power[i];
      dominantIdx = i;
    }
  }

  const totalPower = power.reduce((a, b) => a + b, 0);

  return {
    frequencies,
    power,
    dominantFrequency: frequencies[dominantIdx],
    totalPower,
  };
}

/**
 * Calculate spectral centroid (center of mass of spectrum)
 * Useful for fatigue detection - shifts lower with fatigue
 */
export function spectralCentroid(signal: number[], sampleRate: number): number {
  const spectrum = computePowerSpectrum(signal, sampleRate);

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < spectrum.frequencies.length; i++) {
    numerator += spectrum.frequencies[i] * spectrum.power[i];
    denominator += spectrum.power[i];
  }

  return denominator > 0 ? numerator / denominator : 0;
}

// ============================================
// Filtering
// ============================================

/**
 * Simple moving average filter
 */
export function movingAverage(signal: number[], windowSize: number): number[] {
  const result: number[] = [];
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = 0; i < signal.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(signal.length, i + halfWindow + 1);
    const window = signal.slice(start, end);
    result.push(window.reduce((a, b) => a + b, 0) / window.length);
  }

  return result;
}

/**
 * Butterworth low-pass filter (2nd order approximation)
 */
export function lowPassFilter(
  signal: number[],
  cutoffFreq: number,
  sampleRate: number,
): number[] {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffFreq);
  const alpha = dt / (rc + dt);

  const result: number[] = [signal[0]];
  for (let i = 1; i < signal.length; i++) {
    result.push(result[i - 1] + alpha * (signal[i] - result[i - 1]));
  }

  return result;
}

/**
 * Butterworth high-pass filter (2nd order approximation)
 */
export function highPassFilter(
  signal: number[],
  cutoffFreq: number,
  sampleRate: number,
): number[] {
  const lowPassed = lowPassFilter(signal, cutoffFreq, sampleRate);
  return signal.map((v, i) => v - lowPassed[i]);
}

/**
 * Band-pass filter combining high and low pass
 */
export function bandPassFilter(
  signal: number[],
  lowCutoff: number,
  highCutoff: number,
  sampleRate: number,
): number[] {
  const highPassed = highPassFilter(signal, lowCutoff, sampleRate);
  return lowPassFilter(highPassed, highCutoff, sampleRate);
}

// ============================================
// Biomechanics Utilities
// ============================================

/**
 * Calculate symmetry indices between bilateral signals
 * Common in gait analysis research
 */
export function calculateSymmetry(
  leftValues: number[],
  rightValues: number[],
): SymmetryResult {
  if (leftValues.length !== rightValues.length) {
    throw new Error("Left and right arrays must have same length");
  }

  const meanLeft = leftValues.reduce((a, b) => a + b, 0) / leftValues.length;
  const meanRight = rightValues.reduce((a, b) => a + b, 0) / rightValues.length;

  // Symmetry Index (Robinson et al., 1987)
  // SI = (XR - XL) / (0.5 * (XR + XL)) * 100
  const si = ((meanRight - meanLeft) / (0.5 * (meanRight + meanLeft))) * 100;

  // Ratio of Asymmetry (smaller/larger)
  const ra = Math.min(meanLeft, meanRight) / Math.max(meanLeft, meanRight);

  // Gait Asymmetry (Herzog et al., 1989)
  // GA = (XL - XR) / max(XL, XR) * 100
  const ga = ((meanLeft - meanRight) / Math.max(meanLeft, meanRight)) * 100;

  return {
    symmetryIndex: Math.abs(si),
    ratioOfAsymmetry: ra,
    gaitAsymmetry: Math.abs(ga),
  };
}

/**
 * Calculate coefficient of variation (CV)
 * Standard measure of variability in gait research
 */
export function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;

  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(variance);

  return (sd / Math.abs(mean)) * 100;
}

/**
 * Detect peaks in signal (useful for gait events)
 */
export function detectPeaks(
  signal: number[],
  options: { minHeight?: number; minDistance?: number } = {},
): number[] {
  const { minHeight = 0, minDistance = 1 } = options;
  const peaks: number[] = [];

  for (let i = 1; i < signal.length - 1; i++) {
    if (signal[i] > signal[i - 1] && signal[i] > signal[i + 1]) {
      if (signal[i] >= minHeight) {
        // Check minimum distance from previous peak
        if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDistance) {
          peaks.push(i);
        }
      }
    }
  }

  return peaks;
}

/**
 * Calculate RMS (Root Mean Square) - common for EMG and acceleration analysis
 */
export function rms(values: number[]): number {
  if (values.length === 0) return 0;
  const sumSquares = values.reduce((a, b) => a + b * b, 0);
  return Math.sqrt(sumSquares / values.length);
}

/**
 * Calculate acceleration magnitude from 3-axis accelerometer
 */
export function accelerationMagnitude(acc: [number, number, number]): number {
  return Math.sqrt(acc[0] ** 2 + acc[1] ** 2 + acc[2] ** 2);
}

/**
 * Remove gravity component from accelerometer data
 * Assumes sensor is relatively stable and gravity is ~9.81 m/s²
 */
export function removeGravity(
  accMagnitudes: number[],
  gravity: number = 9.81,
): number[] {
  return accMagnitudes.map((m) => Math.max(0, m - gravity));
}

// ============================================
// Statistical Utilities (for quick analysis without WebR)
// ============================================

/**
 * Calculate descriptive statistics
 */
export function descriptiveStats(values: number[]): {
  n: number;
  mean: number;
  sd: number;
  se: number;
  min: number;
  max: number;
  median: number;
} {
  if (values.length === 0) {
    return { n: 0, mean: 0, sd: 0, se: 0, min: 0, max: 0, median: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);

  const mid = Math.floor(n / 2);
  const median =
    n % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    n,
    mean,
    sd,
    se,
    min: sorted[0],
    max: sorted[n - 1],
    median,
  };
}

// ============================================
// Soft Tissue Artifact (STA) Filter
// ============================================

/**
 * Real-time STA filter for joint angles.
 *
 * Soft Tissue Artifact is 2-10 Hz noise from skin/muscle movement relative to bone.
 * Typical joint motion is 0-6 Hz. A 6 Hz low-pass removes STA while preserving motion.
 *
 * Uses 2nd-order Butterworth approximation for zero-phase equivalent response.
 *
 * OpenSim best practice:
 * - Cut-off: 6 Hz for general motion, 10-12 Hz for impacts/jumping
 * - Filter both forward and backward for zero phase shift (offline only)
 * - For real-time, use simple IIR with slight phase lag
 */
export class STAFilter {
  private alpha: number;
  private cutoffHz: number;
  private sampleRateHz: number;
  private previousFiltered: number[] = [];
  private initialized: boolean = false;

  /**
   * Create an STA filter
   * @param cutoffHz Cutoff frequency (default 6 Hz for general motion)
   * @param sampleRateHz Sample rate (default 60 Hz)
   */
  constructor(cutoffHz: number = 6, sampleRateHz: number = 60) {
    this.cutoffHz = cutoffHz;
    this.sampleRateHz = sampleRateHz;
    this.alpha = this.computeAlpha(cutoffHz, sampleRateHz);
  }

  private computeAlpha(cutoffHz: number, sampleRateHz: number): number {
    const dt = 1 / sampleRateHz;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    return dt / (rc + dt);
  }

  /**
   * Update cutoff frequency
   */
  setCutoff(cutoffHz: number): void {
    this.cutoffHz = cutoffHz;
    this.alpha = this.computeAlpha(cutoffHz, this.sampleRateHz);
  }

  /**
   * Update sample rate
   */
  setSampleRate(sampleRateHz: number): void {
    this.sampleRateHz = sampleRateHz;
    this.alpha = this.computeAlpha(this.cutoffHz, sampleRateHz);
  }

  /**
   * Filter a single sample (real-time streaming)
   * @param values Array of values to filter (e.g., [flexion, abduction, rotation])
   * @returns Filtered values
   */
  filterSample(values: number[]): number[] {
    if (!this.initialized || this.previousFiltered.length !== values.length) {
      // Initialize with first sample
      this.previousFiltered = [...values];
      this.initialized = true;
      return values;
    }

    // Apply IIR low-pass: y[n] = y[n-1] + alpha * (x[n] - y[n-1])
    const filtered = values.map((v, i) => {
      const prev = this.previousFiltered[i];
      return prev + this.alpha * (v - prev);
    });

    this.previousFiltered = filtered;
    return filtered;
  }

  /**
   * Filter a complete signal (batch/offline processing with zero-phase)
   * Uses forward-backward filtering to eliminate phase shift.
   * @param signal Array of samples, each sample is an array of values
   * @returns Filtered signal
   */
  filterBatch(signal: number[][]): number[][] {
    if (signal.length === 0) return [];

    const numChannels = signal[0].length;

    // Process each channel independently
    const result: number[][] = [];

    for (let ch = 0; ch < numChannels; ch++) {
      // Extract channel
      const channelData = signal.map((s) => s[ch]);

      // Forward pass
      const forward: number[] = [channelData[0]];
      for (let i = 1; i < channelData.length; i++) {
        forward.push(
          forward[i - 1] + this.alpha * (channelData[i] - forward[i - 1]),
        );
      }

      // Backward pass (zero-phase)
      const backward: number[] = new Array(channelData.length);
      backward[backward.length - 1] = forward[forward.length - 1];
      for (let i = channelData.length - 2; i >= 0; i--) {
        backward[i] =
          backward[i + 1] + this.alpha * (forward[i] - backward[i + 1]);
      }

      // Store result
      for (let i = 0; i < signal.length; i++) {
        if (!result[i]) result[i] = new Array(numChannels);
        result[i][ch] = backward[i];
      }
    }

    return result;
  }

  /**
   * Reset filter state (call when starting new recording)
   */
  reset(): void {
    this.previousFiltered = [];
    this.initialized = false;
  }

  /**
   * Get current filter parameters
   */
  getParams(): { cutoffHz: number; sampleRateHz: number; alpha: number } {
    return {
      cutoffHz: this.cutoffHz,
      sampleRateHz: this.sampleRateHz,
      alpha: this.alpha,
    };
  }
}
