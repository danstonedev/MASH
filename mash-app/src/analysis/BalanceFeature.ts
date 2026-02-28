/**
 * Balance Feature (A+ Research Grade)
 * ====================================
 *
 * Comprehensive clinical posturography implementation based on:
 * - Moe-Nilssen (1998): Accelerometric sway measurement
 * - Collins & De Luca (1993): Stabilogram Diffusion Analysis
 * - Richman & Moorman (2000): Sample Entropy
 * - Prieto et al. (1996): Force platform standardization
 *
 * ## Time Domain Metrics
 * - 95% Confidence Ellipse (PCA-based)
 * - Sway Velocity (AP/ML)
 * - Path Length
 * - RMS Sway
 * - Range (AP/ML excursions)
 *
 * ## Frequency Domain Metrics (A+ Enhancement)
 * - Power Spectral Density (FFT-based)
 * - Low frequency band: 0.02-0.2 Hz (visual/vestibular)
 * - Medium frequency band: 0.2-2.0 Hz (proprioceptive)
 * - High frequency band: 2.0-10 Hz (noise/neuromuscular)
 * - Median Frequency, Frequency Centroid, Spectral Entropy
 *
 * ## Nonlinear Metrics (A+ Enhancement)
 * - Stabilogram Diffusion Analysis (SDA)
 * - Sample Entropy (complexity measure)
 *
 * ## Clinical Protocols
 * - Eyes open / Eyes closed (Romberg)
 * - Firm / Foam surface (CTSIB)
 * - Bipedal / Tandem / Single-leg stance
 *
 * @module analysis/BalanceFeature
 */

import * as THREE from "three";
import { KineticChain } from "./KineticChain";

// ============================================================================
// INTERFACES
// ============================================================================

export interface BalanceMetrics {
  // Core sway metrics (time domain)
  swayArea95: number; // mm² (95% confidence ellipse area)
  swayVelocityAP: number; // mm/s (anterior-posterior)
  swayVelocityML: number; // mm/s (medio-lateral)
  pathLength: number; // mm (total path length)

  // Ellipse parameters
  ellipseAxisMajor: number; // mm
  ellipseAxisMinor: number; // mm
  ellipseAngle: number; // degrees (orientation of major axis)

  // RMS metrics
  rmsAP: number; // mm/s² (RMS acceleration AP)
  rmsML: number; // mm/s² (RMS acceleration ML)

  // Range metrics
  rangeAP: number; // mm (max - min AP excursion)
  rangeML: number; // mm (max - min ML excursion)

  // Clinical scores
  score: number; // 0-100 (100 = very stable)
  rombergRatio: number; // Eyes closed / Eyes open (if both recorded)

  // Recording info
  duration: number; // seconds
  condition: BalanceCondition | "unknown";
  surface: BalanceSurface;
  stance: BalanceStance;
}

/**
 * A+ Frequency Domain Metrics
 * Based on Prieto et al. (1996) and clinical posturography standards
 */
export interface SpectralMetrics {
  // Power in frequency bands (mm²)
  lowFreqPowerAP: number; // 0.02-0.2 Hz (visual/vestibular control)
  lowFreqPowerML: number;
  medFreqPowerAP: number; // 0.2-2.0 Hz (proprioceptive control)
  medFreqPowerML: number;
  highFreqPowerAP: number; // 2.0-10 Hz (noise/neuromuscular tremor)
  highFreqPowerML: number;

  // Total power
  totalPowerAP: number; // mm²
  totalPowerML: number;

  // Spectral features
  medianFreqAP: number; // Hz (frequency below which 50% power)
  medianFreqML: number;
  freqCentroidAP: number; // Hz (weighted average frequency)
  freqCentroidML: number;
  spectralEntropyAP: number; // 0-1 (normalized complexity)
  spectralEntropyML: number;

  // Band ratios (clinical significance)
  lowMedRatioAP: number; // Low/Med ratio (visual dependence)
  lowMedRatioML: number;
}

/**
 * A+ Stabilogram Diffusion Analysis (Collins & De Luca, 1993)
 * Reveals open-loop vs closed-loop postural control mechanisms
 */
export interface DiffusionMetrics {
  // Diffusion coefficients (mm²/s)
  shortTermDiffusionAP: number; // Open-loop (ballistic) control
  shortTermDiffusionML: number;
  longTermDiffusionAP: number; // Closed-loop (feedback) control
  longTermDiffusionML: number;

  // Critical point (transition between control modes)
  criticalTimeAP: number; // seconds
  criticalTimeML: number;
  criticalDisplacementAP: number; // mm²
  criticalDisplacementML: number;

  // Scaling exponents (Hurst-like)
  scalingExponentShortAP: number; // <0.5 = anti-persistent, >0.5 = persistent
  scalingExponentShortML: number;
  scalingExponentLongAP: number;
  scalingExponentLongML: number;
}

/**
 * A+ Sample Entropy (Richman & Moorman, 2000)
 * Measures complexity/regularity of postural control
 */
export interface EntropyMetrics {
  sampleEntropyAP: number; // Higher = more complex/irregular
  sampleEntropyML: number;
  sampleEntropy2D: number; // Combined AP+ML entropy

  // Entropy parameters used
  embeddingDimension: number; // m (typically 2)
  tolerance: number; // r (typically 0.2 * SD)
}

/**
 * Complete A+ Balance Assessment
 */
export interface BalanceAssessmentA {
  // Time domain
  timeMetrics: BalanceMetrics;

  // Frequency domain
  spectralMetrics: SpectralMetrics;

  // Nonlinear
  diffusionMetrics: DiffusionMetrics;
  entropyMetrics: EntropyMetrics;

  // Clinical interpretation
  clinicalScore: number; // 0-100 composite
  fallRiskLevel: "low" | "moderate" | "high";
  controlStrategy: "ankle" | "hip" | "mixed";
  sensorySystems: {
    visual: number; // 0-100 contribution estimate
    vestibular: number;
    proprioceptive: number;
  };
}

export type BalanceCondition = "eyes_open" | "eyes_closed";
export type BalanceSurface = "firm" | "foam" | "unknown";
export type BalanceStance =
  | "bipedal"
  | "tandem"
  | "single_left"
  | "single_right"
  | "unknown";

/**
 * Clinical protocol configuration
 */
export interface BalanceProtocol {
  condition: BalanceCondition;
  surface: BalanceSurface;
  stance: BalanceStance;
  durationSeconds: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SAMPLE_RATE_HZ = 100;
const DEFAULT_BUFFER_SIZE = 3000; // 30 seconds @ 100Hz

// Frequency bands (Hz)
const FREQ_LOW_MIN = 0.02;
const FREQ_LOW_MAX = 0.2;
const FREQ_MED_MIN = 0.2;
const FREQ_MED_MAX = 2.0;
const FREQ_HIGH_MIN = 2.0;
const FREQ_HIGH_MAX = 10.0;

// Sample entropy parameters
const SAMPEN_M = 2; // Embedding dimension
const SAMPEN_R_FACTOR = 0.2; // Tolerance factor (r = 0.2 * SD)

// SDA parameters
const SDA_MAX_INTERVAL = 10.0; // seconds
const SDA_STEP = 0.05; // seconds

// ============================================================================
// MAIN CLASS
// ============================================================================

export class BalanceFeature {
  // Buffers
  private bufferAP: number[] = [];
  private bufferML: number[] = [];
  private timestamps: number[] = [];

  private BUFFER_SIZE = DEFAULT_BUFFER_SIZE;
  private isRecording = false;
  private currentCondition: BalanceCondition | "unknown" = "unknown";
  private currentSurface: BalanceSurface = "unknown";
  private currentStance: BalanceStance = "unknown";

  // Store results for multi-condition comparison
  private storedResults: Map<string, BalanceAssessmentA> = new Map();
  private eyesOpenMetrics: BalanceMetrics | null = null;
  private eyesClosedMetrics: BalanceMetrics | null = null;

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  reset() {
    this.bufferAP = [];
    this.bufferML = [];
    this.timestamps = [];
    this.isRecording = false;
    this.currentCondition = "unknown";
    this.currentSurface = "unknown";
    this.currentStance = "unknown";
  }

  /**
   * Start recording with full protocol specification
   */
  start(
    condition: BalanceCondition = "eyes_open",
    surface: BalanceSurface = "firm",
    stance: BalanceStance = "bipedal",
  ) {
    this.reset();
    this.isRecording = true;
    this.currentCondition = condition;
    this.currentSurface = surface;
    this.currentStance = stance;
  }

  /**
   * Start from a protocol object
   */
  startProtocol(protocol: BalanceProtocol) {
    this.start(protocol.condition, protocol.surface, protocol.stance);
  }

  stop(): BalanceMetrics {
    this.isRecording = false;
    const metrics = this.getMetrics();

    // Store for Romberg comparison
    if (this.currentCondition === "eyes_open") {
      this.eyesOpenMetrics = metrics;
    } else if (this.currentCondition === "eyes_closed") {
      this.eyesClosedMetrics = metrics;
    }

    // Store full assessment
    const key = `${this.currentCondition}_${this.currentSurface}_${this.currentStance}`;
    const fullAssessment = this.getFullAssessment();
    this.storedResults.set(key, fullAssessment);

    return metrics;
  }

  /**
   * Get Romberg ratio if both conditions have been recorded
   */
  getRombergRatio(): number | null {
    if (!this.eyesOpenMetrics || !this.eyesClosedMetrics) {
      return null;
    }
    if (this.eyesOpenMetrics.swayArea95 <= 0) {
      return null;
    }
    return this.eyesClosedMetrics.swayArea95 / this.eyesOpenMetrics.swayArea95;
  }

  update(coreChain: KineticChain, timestamp: number) {
    if (!this.isRecording) return;

    const metrics = coreChain.getMetrics();

    // Convert acceleration to mm/s² for posturography convention
    const apAccel = metrics.rootAccel.z * 1000;
    const mlAccel = metrics.rootAccel.x * 1000;

    this.bufferML.push(mlAccel);
    this.bufferAP.push(apAccel);
    this.timestamps.push(timestamp);

    if (this.bufferML.length > this.BUFFER_SIZE) {
      this.bufferML.shift();
      this.bufferAP.shift();
      this.timestamps.shift();
    }
  }

  /**
   * Get time-domain metrics (backward compatible)
   */
  getMetrics(): BalanceMetrics {
    if (this.bufferML.length < 50) return this.emptyMetrics();

    const n = this.bufferAP.length;

    // 1. Calculate Mean and Center
    const meanAP = this.avg(this.bufferAP);
    const meanML = this.avg(this.bufferML);

    // 2. Zero-center the data
    const centeredAP = this.bufferAP.map((v) => v - meanAP);
    const centeredML = this.bufferML.map((v) => v - meanML);

    // 3. Covariance Matrix for PCA
    let varML = 0,
      varAP = 0,
      cov = 0;

    for (let i = 0; i < n; i++) {
      varML += centeredML[i] * centeredML[i];
      varAP += centeredAP[i] * centeredAP[i];
      cov += centeredML[i] * centeredAP[i];
    }
    varML /= n - 1;
    varAP /= n - 1;
    cov /= n - 1;

    // 4. Eigenvalues for Ellipse Axes
    const trace = varML + varAP;
    const term = Math.sqrt(Math.pow(varML - varAP, 2) + 4 * cov * cov);
    const lambda1 = (trace + term) / 2;
    const lambda2 = (trace - term) / 2;

    // 95% Confidence Ellipse Area
    const chiSquare95 = 5.991;
    const axisMajor = Math.sqrt(chiSquare95 * Math.max(0, lambda1));
    const axisMinor = Math.sqrt(chiSquare95 * Math.max(0, lambda2));
    const area = Math.PI * axisMajor * axisMinor;

    // Ellipse angle
    const ellipseAngle =
      cov !== 0
        ? Math.atan2(2 * cov, varML - varAP) * 0.5 * (180 / Math.PI)
        : 0;

    // 5. Path Length and Velocity
    let pathLengthAP = 0;
    let pathLengthML = 0;
    const totalTime =
      (this.timestamps[this.timestamps.length - 1] - this.timestamps[0]) / 1000;
    const duration = Math.max(0.1, totalTime);

    for (let i = 1; i < n; i++) {
      pathLengthAP += Math.abs(centeredAP[i] - centeredAP[i - 1]);
      pathLengthML += Math.abs(centeredML[i] - centeredML[i - 1]);
    }

    const velAP = pathLengthAP / duration;
    const velML = pathLengthML / duration;
    const totalPathLength = pathLengthAP + pathLengthML;

    // 6. RMS calculations
    const rmsAP = Math.sqrt(varAP);
    const rmsML = Math.sqrt(varML);

    // 7. Range
    const rangeAP = Math.max(...centeredAP) - Math.min(...centeredAP);
    const rangeML = Math.max(...centeredML) - Math.min(...centeredML);

    // 8. Clinical Score
    const areaScore = Math.max(0, 100 - area / 10);
    const velScore = Math.max(0, 100 - (velAP + velML));
    const score = Math.round(areaScore * 0.6 + velScore * 0.4);

    // 9. Romberg ratio
    const rombergRatio = this.getRombergRatio() || 1.0;

    return {
      swayArea95: Math.round(area * 100) / 100,
      swayVelocityAP: Math.round(velAP * 100) / 100,
      swayVelocityML: Math.round(velML * 100) / 100,
      pathLength: Math.round(totalPathLength * 100) / 100,
      ellipseAxisMajor: Math.round(axisMajor * 100) / 100,
      ellipseAxisMinor: Math.round(axisMinor * 100) / 100,
      ellipseAngle: Math.round(ellipseAngle * 10) / 10,
      rmsAP: Math.round(rmsAP * 100) / 100,
      rmsML: Math.round(rmsML * 100) / 100,
      rangeAP: Math.round(rangeAP * 100) / 100,
      rangeML: Math.round(rangeML * 100) / 100,
      score: Math.max(0, Math.min(100, score)),
      rombergRatio: Math.round(rombergRatio * 100) / 100,
      duration: Math.round(duration * 10) / 10,
      condition: this.currentCondition,
      surface: this.currentSurface,
      stance: this.currentStance,
    };
  }

  // ========================================================================
  // A+ FREQUENCY DOMAIN ANALYSIS
  // ========================================================================

  /**
   * Compute Power Spectral Density using FFT
   * Returns spectral metrics for clinical interpretation
   */
  getSpectralMetrics(): SpectralMetrics {
    if (this.bufferAP.length < 256) return this.emptySpectralMetrics();

    // Prepare data (zero-center and window)
    const meanAP = this.avg(this.bufferAP);
    const meanML = this.avg(this.bufferML);
    const centeredAP = this.bufferAP.map((v) => v - meanAP);
    const centeredML = this.bufferML.map((v) => v - meanML);

    // Apply Hanning window to reduce spectral leakage
    const windowedAP = this.applyHanningWindow(centeredAP);
    const windowedML = this.applyHanningWindow(centeredML);

    // Compute FFT
    const fftAP = this.computeFFT(windowedAP);
    const fftML = this.computeFFT(windowedML);

    // Compute power spectrum (magnitude squared)
    const psdAP = this.computePSD(fftAP, windowedAP.length);
    const psdML = this.computePSD(fftML, windowedML.length);

    // Frequency resolution
    const freqResolution = SAMPLE_RATE_HZ / windowedAP.length;
    const frequencies = Array.from(
      { length: psdAP.length },
      (_, i) => i * freqResolution,
    );

    // Integrate power in bands
    const bandsAP = this.integratePowerBands(psdAP, frequencies);
    const bandsML = this.integratePowerBands(psdML, frequencies);

    // Compute spectral features
    const medianFreqAP = this.computeMedianFrequency(psdAP, frequencies);
    const medianFreqML = this.computeMedianFrequency(psdML, frequencies);
    const centroidAP = this.computeFrequencyCentroid(psdAP, frequencies);
    const centroidML = this.computeFrequencyCentroid(psdML, frequencies);
    const entropyAP = this.computeSpectralEntropy(psdAP);
    const entropyML = this.computeSpectralEntropy(psdML);

    return {
      lowFreqPowerAP: Math.round(bandsAP.low * 100) / 100,
      lowFreqPowerML: Math.round(bandsML.low * 100) / 100,
      medFreqPowerAP: Math.round(bandsAP.med * 100) / 100,
      medFreqPowerML: Math.round(bandsML.med * 100) / 100,
      highFreqPowerAP: Math.round(bandsAP.high * 100) / 100,
      highFreqPowerML: Math.round(bandsML.high * 100) / 100,
      totalPowerAP: Math.round(bandsAP.total * 100) / 100,
      totalPowerML: Math.round(bandsML.total * 100) / 100,
      medianFreqAP: Math.round(medianFreqAP * 1000) / 1000,
      medianFreqML: Math.round(medianFreqML * 1000) / 1000,
      freqCentroidAP: Math.round(centroidAP * 1000) / 1000,
      freqCentroidML: Math.round(centroidML * 1000) / 1000,
      spectralEntropyAP: Math.round(entropyAP * 1000) / 1000,
      spectralEntropyML: Math.round(entropyML * 1000) / 1000,
      lowMedRatioAP:
        bandsAP.med > 0
          ? Math.round((bandsAP.low / bandsAP.med) * 100) / 100
          : 0,
      lowMedRatioML:
        bandsML.med > 0
          ? Math.round((bandsML.low / bandsML.med) * 100) / 100
          : 0,
    };
  }

  // ========================================================================
  // A+ STABILOGRAM DIFFUSION ANALYSIS
  // ========================================================================

  /**
   * Stabilogram Diffusion Analysis (Collins & De Luca, 1993)
   * Computes mean squared displacement vs time interval to reveal
   * open-loop (short-term) vs closed-loop (long-term) control
   */
  getDiffusionMetrics(): DiffusionMetrics {
    if (this.bufferAP.length < 500) return this.emptyDiffusionMetrics();

    // Zero-center data
    const meanAP = this.avg(this.bufferAP);
    const meanML = this.avg(this.bufferML);
    const centeredAP = this.bufferAP.map((v) => v - meanAP);
    const centeredML = this.bufferML.map((v) => v - meanML);

    // Compute MSD for various time intervals
    const maxSamples = Math.min(
      Math.floor(SDA_MAX_INTERVAL * SAMPLE_RATE_HZ),
      Math.floor(centeredAP.length / 2),
    );
    const stepSamples = Math.max(1, Math.floor(SDA_STEP * SAMPLE_RATE_HZ));

    const intervals: number[] = [];
    const msdAP: number[] = [];
    const msdML: number[] = [];

    for (let dt = stepSamples; dt <= maxSamples; dt += stepSamples) {
      const timeInterval = dt / SAMPLE_RATE_HZ;
      intervals.push(timeInterval);

      let sumSqAP = 0,
        sumSqML = 0;
      let count = 0;

      for (let i = 0; i < centeredAP.length - dt; i++) {
        const diffAP = centeredAP[i + dt] - centeredAP[i];
        const diffML = centeredML[i + dt] - centeredML[i];
        sumSqAP += diffAP * diffAP;
        sumSqML += diffML * diffML;
        count++;
      }

      msdAP.push(count > 0 ? sumSqAP / count : 0);
      msdML.push(count > 0 ? sumSqML / count : 0);
    }

    // Find critical point (transition between control regimes)
    // Using change in slope of log-log MSD vs time
    const criticalAP = this.findCriticalPoint(intervals, msdAP);
    const criticalML = this.findCriticalPoint(intervals, msdML);

    // Compute diffusion coefficients from slope of MSD vs time
    // D = slope / 2 (from MSD = 2Dt for random walk)
    const shortTermAP = this.computeDiffusionCoefficient(
      intervals,
      msdAP,
      0,
      criticalAP.index,
    );
    const shortTermML = this.computeDiffusionCoefficient(
      intervals,
      msdML,
      0,
      criticalML.index,
    );
    const longTermAP = this.computeDiffusionCoefficient(
      intervals,
      msdAP,
      criticalAP.index,
      intervals.length - 1,
    );
    const longTermML = this.computeDiffusionCoefficient(
      intervals,
      msdML,
      criticalML.index,
      intervals.length - 1,
    );

    // Compute scaling exponents (Hurst-like from log-log slope)
    const scalingShortAP = this.computeScalingExponent(
      intervals,
      msdAP,
      0,
      criticalAP.index,
    );
    const scalingShortML = this.computeScalingExponent(
      intervals,
      msdML,
      0,
      criticalML.index,
    );
    const scalingLongAP = this.computeScalingExponent(
      intervals,
      msdAP,
      criticalAP.index,
      intervals.length - 1,
    );
    const scalingLongML = this.computeScalingExponent(
      intervals,
      msdML,
      criticalML.index,
      intervals.length - 1,
    );

    return {
      shortTermDiffusionAP: Math.round(shortTermAP * 100) / 100,
      shortTermDiffusionML: Math.round(shortTermML * 100) / 100,
      longTermDiffusionAP: Math.round(longTermAP * 100) / 100,
      longTermDiffusionML: Math.round(longTermML * 100) / 100,
      criticalTimeAP: Math.round(criticalAP.time * 1000) / 1000,
      criticalTimeML: Math.round(criticalML.time * 1000) / 1000,
      criticalDisplacementAP: Math.round(criticalAP.msd * 100) / 100,
      criticalDisplacementML: Math.round(criticalML.msd * 100) / 100,
      scalingExponentShortAP: Math.round(scalingShortAP * 1000) / 1000,
      scalingExponentShortML: Math.round(scalingShortML * 1000) / 1000,
      scalingExponentLongAP: Math.round(scalingLongAP * 1000) / 1000,
      scalingExponentLongML: Math.round(scalingLongML * 1000) / 1000,
    };
  }

  // ========================================================================
  // A+ SAMPLE ENTROPY
  // ========================================================================

  /**
   * Sample Entropy (Richman & Moorman, 2000)
   * Measures regularity/complexity of time series
   * Lower = more regular, Higher = more complex/random
   */
  getEntropyMetrics(): EntropyMetrics {
    if (this.bufferAP.length < 200) return this.emptyEntropyMetrics();

    // Zero-center data
    const meanAP = this.avg(this.bufferAP);
    const meanML = this.avg(this.bufferML);
    const centeredAP = this.bufferAP.map((v) => v - meanAP);
    const centeredML = this.bufferML.map((v) => v - meanML);

    // Standard deviations for tolerance calculation
    const sdAP = Math.sqrt(this.variance(centeredAP));
    const sdML = Math.sqrt(this.variance(centeredML));

    // Tolerances
    const rAP = SAMPEN_R_FACTOR * sdAP;
    const rML = SAMPEN_R_FACTOR * sdML;
    const r2D = SAMPEN_R_FACTOR * Math.sqrt(sdAP * sdAP + sdML * sdML);

    // Compute sample entropy for each axis
    const sampEnAP = this.computeSampleEntropy(centeredAP, SAMPEN_M, rAP);
    const sampEnML = this.computeSampleEntropy(centeredML, SAMPEN_M, rML);

    // 2D sample entropy (combine both axes)
    const combined2D = centeredAP.map((v, i) => [v, centeredML[i]]);
    const sampEn2D = this.computeSampleEntropy2D(combined2D, SAMPEN_M, r2D);

    return {
      sampleEntropyAP: Math.round(sampEnAP * 1000) / 1000,
      sampleEntropyML: Math.round(sampEnML * 1000) / 1000,
      sampleEntropy2D: Math.round(sampEn2D * 1000) / 1000,
      embeddingDimension: SAMPEN_M,
      tolerance: SAMPEN_R_FACTOR,
    };
  }

  // ========================================================================
  // A+ FULL ASSESSMENT
  // ========================================================================

  /**
   * Get complete A+ balance assessment with all metrics
   */
  getFullAssessment(): BalanceAssessmentA {
    const timeMetrics = this.getMetrics();
    const spectralMetrics = this.getSpectralMetrics();
    const diffusionMetrics = this.getDiffusionMetrics();
    const entropyMetrics = this.getEntropyMetrics();

    // Compute clinical interpretation
    const clinicalScore = this.computeClinicalScore(
      timeMetrics,
      spectralMetrics,
      diffusionMetrics,
    );
    const fallRiskLevel = this.assessFallRisk(timeMetrics, spectralMetrics);
    const controlStrategy = this.identifyControlStrategy(
      spectralMetrics,
      diffusionMetrics,
    );
    const sensorySystems = this.estimateSensoryContributions(spectralMetrics);

    return {
      timeMetrics,
      spectralMetrics,
      diffusionMetrics,
      entropyMetrics,
      clinicalScore,
      fallRiskLevel,
      controlStrategy,
      sensorySystems,
    };
  }

  /**
   * Get stored results for a specific protocol
   */
  getStoredResult(
    condition: BalanceCondition,
    surface: BalanceSurface = "firm",
    stance: BalanceStance = "bipedal",
  ): BalanceAssessmentA | null {
    const key = `${condition}_${surface}_${stance}`;
    return this.storedResults.get(key) || null;
  }

  /**
   * Get CTSIB (Clinical Test of Sensory Interaction in Balance) scores
   * Requires all 4 conditions to be recorded
   */
  getCTSIBScores(): {
    condition1: number;
    condition2: number;
    condition3: number;
    condition4: number;
  } | null {
    const eoFirm = this.getStoredResult("eyes_open", "firm", "bipedal");
    const ecFirm = this.getStoredResult("eyes_closed", "firm", "bipedal");
    const eoFoam = this.getStoredResult("eyes_open", "foam", "bipedal");
    const ecFoam = this.getStoredResult("eyes_closed", "foam", "bipedal");

    if (!eoFirm || !ecFirm || !eoFoam || !ecFoam) {
      return null;
    }

    return {
      condition1: eoFirm.timeMetrics.score,
      condition2: ecFirm.timeMetrics.score,
      condition3: eoFoam.timeMetrics.score,
      condition4: ecFoam.timeMetrics.score,
    };
  }

  // ========================================================================
  // PRIVATE HELPERS - FFT
  // ========================================================================

  private applyHanningWindow(data: number[]): number[] {
    const n = data.length;
    return data.map(
      (v, i) => v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))),
    );
  }

  /**
   * Simple radix-2 FFT implementation
   * For production, consider using a library like fft.js
   */
  private computeFFT(data: number[]): { real: number[]; imag: number[] } {
    // Pad to nearest power of 2
    const n = Math.pow(2, Math.ceil(Math.log2(data.length)));
    const real = new Array(n).fill(0);
    const imag = new Array(n).fill(0);

    // Copy data
    for (let i = 0; i < data.length; i++) {
      real[i] = data[i];
    }

    // Bit reversal
    for (let i = 0; i < n; i++) {
      const j = this.bitReverse(i, Math.log2(n));
      if (j > i) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    // Cooley-Tukey FFT
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2;
      const angle = (-2 * Math.PI) / size;

      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const cos = Math.cos(angle * j);
          const sin = Math.sin(angle * j);

          const tReal =
            cos * real[i + j + halfSize] - sin * imag[i + j + halfSize];
          const tImag =
            sin * real[i + j + halfSize] + cos * imag[i + j + halfSize];

          real[i + j + halfSize] = real[i + j] - tReal;
          imag[i + j + halfSize] = imag[i + j] - tImag;
          real[i + j] += tReal;
          imag[i + j] += tImag;
        }
      }
    }

    return { real, imag };
  }

  private bitReverse(n: number, bits: number): number {
    let result = 0;
    for (let i = 0; i < bits; i++) {
      result = (result << 1) | (n & 1);
      n >>= 1;
    }
    return result;
  }

  private computePSD(
    fft: { real: number[]; imag: number[] },
    originalLength: number,
  ): number[] {
    const n = fft.real.length;
    const psd = new Array(Math.floor(n / 2)).fill(0);

    // Power = |FFT|² / (N * fs) for proper scaling
    const scale = 1 / (originalLength * SAMPLE_RATE_HZ);

    for (let i = 0; i < psd.length; i++) {
      psd[i] = (fft.real[i] * fft.real[i] + fft.imag[i] * fft.imag[i]) * scale;
    }

    return psd;
  }

  private integratePowerBands(
    psd: number[],
    frequencies: number[],
  ): { low: number; med: number; high: number; total: number } {
    let low = 0,
      med = 0,
      high = 0;
    const df = frequencies[1] - frequencies[0]; // Frequency resolution

    for (let i = 0; i < psd.length; i++) {
      const f = frequencies[i];
      if (f >= FREQ_LOW_MIN && f < FREQ_LOW_MAX) {
        low += psd[i] * df;
      } else if (f >= FREQ_MED_MIN && f < FREQ_MED_MAX) {
        med += psd[i] * df;
      } else if (f >= FREQ_HIGH_MIN && f < FREQ_HIGH_MAX) {
        high += psd[i] * df;
      }
    }

    return { low, med, high, total: low + med + high };
  }

  private computeMedianFrequency(psd: number[], frequencies: number[]): number {
    const totalPower = psd.reduce((a, b) => a + b, 0);
    if (totalPower <= 0) return 0;

    let cumPower = 0;
    for (let i = 0; i < psd.length; i++) {
      cumPower += psd[i];
      if (cumPower >= totalPower / 2) {
        return frequencies[i];
      }
    }
    return frequencies[frequencies.length - 1];
  }

  private computeFrequencyCentroid(
    psd: number[],
    frequencies: number[],
  ): number {
    let weightedSum = 0;
    let totalPower = 0;

    for (let i = 0; i < psd.length; i++) {
      weightedSum += frequencies[i] * psd[i];
      totalPower += psd[i];
    }

    return totalPower > 0 ? weightedSum / totalPower : 0;
  }

  private computeSpectralEntropy(psd: number[]): number {
    const totalPower = psd.reduce((a, b) => a + b, 0);
    if (totalPower <= 0) return 0;

    // Normalize to probability distribution
    const prob = psd.map((p) => p / totalPower);

    // Shannon entropy: H = -Σ p * log(p)
    let entropy = 0;
    for (const p of prob) {
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    // Normalize by max entropy (log2(N))
    const maxEntropy = Math.log2(psd.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  // ========================================================================
  // PRIVATE HELPERS - SDA
  // ========================================================================

  private findCriticalPoint(
    intervals: number[],
    msd: number[],
  ): { index: number; time: number; msd: number } {
    if (intervals.length < 10) {
      return {
        index: Math.floor(intervals.length / 2),
        time: intervals[Math.floor(intervals.length / 2)] || 0,
        msd: msd[Math.floor(intervals.length / 2)] || 0,
      };
    }

    // Find maximum curvature in log-log plot
    const logT = intervals.map((t) => Math.log(t + 0.001));
    const logMSD = msd.map((m) => Math.log(Math.max(m, 0.001)));

    let maxCurvature = 0;
    let criticalIndex = Math.floor(intervals.length / 2);

    // Compute second derivative (curvature) using central differences
    for (let i = 2; i < logMSD.length - 2; i++) {
      const d2 =
        (logMSD[i + 1] - 2 * logMSD[i] + logMSD[i - 1]) /
        Math.pow(logT[i + 1] - logT[i - 1], 2);
      const curvature = Math.abs(d2);

      if (curvature > maxCurvature) {
        maxCurvature = curvature;
        criticalIndex = i;
      }
    }

    return {
      index: criticalIndex,
      time: intervals[criticalIndex],
      msd: msd[criticalIndex],
    };
  }

  private computeDiffusionCoefficient(
    intervals: number[],
    msd: number[],
    startIdx: number,
    endIdx: number,
  ): number {
    if (endIdx <= startIdx || startIdx < 0 || endIdx >= intervals.length) {
      return 0;
    }

    // Linear regression of MSD vs time to get slope
    // D = slope / 2
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumXX = 0;
    let n = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const x = intervals[i];
      const y = msd[i];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
      n++;
    }

    if (n < 2) return 0;

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return Math.max(0, slope / 2);
  }

  private computeScalingExponent(
    intervals: number[],
    msd: number[],
    startIdx: number,
    endIdx: number,
  ): number {
    if (endIdx <= startIdx || startIdx < 0 || endIdx >= intervals.length) {
      return 0.5;
    }

    // Linear regression in log-log space: log(MSD) = H * log(t) + c
    // Scaling exponent H (Hurst-like)
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumXX = 0;
    let n = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      if (intervals[i] > 0 && msd[i] > 0) {
        const x = Math.log(intervals[i]);
        const y = Math.log(msd[i]);
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumXX += x * x;
        n++;
      }
    }

    if (n < 2) return 0.5;

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return slope / 2; // Divide by 2 because MSD ~ t^(2H) for fractional Brownian motion
  }

  // ========================================================================
  // PRIVATE HELPERS - SAMPLE ENTROPY
  // ========================================================================

  private computeSampleEntropy(data: number[], m: number, r: number): number {
    const n = data.length;
    if (n < m + 2) return 0;

    // Count template matches for embedding dimensions m and m+1
    let B = 0; // Matches for dimension m
    let A = 0; // Matches for dimension m+1

    for (let i = 0; i < n - m; i++) {
      for (let j = i + 1; j < n - m; j++) {
        // Check m-length match
        let matchM = true;
        for (let k = 0; k < m; k++) {
          if (Math.abs(data[i + k] - data[j + k]) > r) {
            matchM = false;
            break;
          }
        }

        if (matchM) {
          B++;
          // Check (m+1)-length match
          if (Math.abs(data[i + m] - data[j + m]) <= r) {
            A++;
          }
        }
      }
    }

    if (B === 0) return 0;

    // Sample entropy = -ln(A/B)
    return -Math.log(A / B);
  }

  private computeSampleEntropy2D(
    data: number[][],
    m: number,
    r: number,
  ): number {
    const n = data.length;
    if (n < m + 2) return 0;

    let B = 0;
    let A = 0;

    for (let i = 0; i < n - m; i++) {
      for (let j = i + 1; j < n - m; j++) {
        // Check m-length match using Chebyshev distance
        let matchM = true;
        for (let k = 0; k < m; k++) {
          const dist = Math.max(
            Math.abs(data[i + k][0] - data[j + k][0]),
            Math.abs(data[i + k][1] - data[j + k][1]),
          );
          if (dist > r) {
            matchM = false;
            break;
          }
        }

        if (matchM) {
          B++;
          // Check (m+1)-length match
          const distM1 = Math.max(
            Math.abs(data[i + m][0] - data[j + m][0]),
            Math.abs(data[i + m][1] - data[j + m][1]),
          );
          if (distM1 <= r) {
            A++;
          }
        }
      }
    }

    if (B === 0) return 0;
    return -Math.log(A / B);
  }

  // ========================================================================
  // PRIVATE HELPERS - CLINICAL INTERPRETATION
  // ========================================================================

  private computeClinicalScore(
    time: BalanceMetrics,
    spectral: SpectralMetrics,
    diffusion: DiffusionMetrics,
  ): number {
    // Composite score from multiple domains
    const areaScore = Math.max(0, 100 - time.swayArea95 / 10);
    const velScore = Math.max(
      0,
      100 - (time.swayVelocityAP + time.swayVelocityML) / 2,
    );
    const entropyScore =
      spectral.spectralEntropyAP > 0
        ? Math.max(0, 100 * (1 - Math.abs(spectral.spectralEntropyAP - 0.6)))
        : 50;

    return Math.round(areaScore * 0.4 + velScore * 0.4 + entropyScore * 0.2);
  }

  private assessFallRisk(
    time: BalanceMetrics,
    spectral: SpectralMetrics,
  ): "low" | "moderate" | "high" {
    // Based on clinical literature thresholds
    const highRiskFactors = [
      time.swayArea95 > 800,
      time.swayVelocityAP > 40,
      time.pathLength > 2000,
      spectral.totalPowerAP > 500,
    ].filter(Boolean).length;

    if (highRiskFactors >= 3) return "high";
    if (highRiskFactors >= 1) return "moderate";
    return "low";
  }

  private identifyControlStrategy(
    spectral: SpectralMetrics,
    diffusion: DiffusionMetrics,
  ): "ankle" | "hip" | "mixed" {
    // High AP/ML ratio suggests ankle strategy (sagittal plane dominant)
    // Low ratio suggests hip strategy (frontal plane involvement)
    const apmlRatio =
      spectral.totalPowerML > 0
        ? spectral.totalPowerAP / spectral.totalPowerML
        : 1;

    if (apmlRatio > 1.5) return "ankle";
    if (apmlRatio < 0.7) return "hip";
    return "mixed";
  }

  private estimateSensoryContributions(spectral: SpectralMetrics): {
    visual: number;
    vestibular: number;
    proprioceptive: number;
  } {
    // Estimate based on frequency band distribution
    // Low freq (0.02-0.2 Hz) → visual/vestibular
    // Med freq (0.2-2 Hz) → proprioceptive
    const totalAP =
      spectral.lowFreqPowerAP +
      spectral.medFreqPowerAP +
      spectral.highFreqPowerAP;

    if (totalAP <= 0) {
      return { visual: 33, vestibular: 33, proprioceptive: 34 };
    }

    const lowPct = (spectral.lowFreqPowerAP / totalAP) * 100;
    const medPct = (spectral.medFreqPowerAP / totalAP) * 100;

    // Low frequency split between visual and vestibular
    return {
      visual: Math.round(lowPct * 0.6),
      vestibular: Math.round(lowPct * 0.4),
      proprioceptive: Math.round(medPct),
    };
  }

  // ========================================================================
  // PRIVATE HELPERS - GENERAL
  // ========================================================================

  private avg(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b) / arr.length;
  }

  private variance(arr: number[]): number {
    if (arr.length < 2) return 0;
    const mean = this.avg(arr);
    return (
      arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (arr.length - 1)
    );
  }

  // ========================================================================
  // EMPTY METRICS FACTORIES
  // ========================================================================

  private emptyMetrics(): BalanceMetrics {
    return {
      swayArea95: 0,
      swayVelocityAP: 0,
      swayVelocityML: 0,
      pathLength: 0,
      ellipseAxisMajor: 0,
      ellipseAxisMinor: 0,
      ellipseAngle: 0,
      rmsAP: 0,
      rmsML: 0,
      rangeAP: 0,
      rangeML: 0,
      score: 0,
      rombergRatio: 1.0,
      duration: 0,
      condition: "unknown",
      surface: "unknown",
      stance: "unknown",
    };
  }

  private emptySpectralMetrics(): SpectralMetrics {
    return {
      lowFreqPowerAP: 0,
      lowFreqPowerML: 0,
      medFreqPowerAP: 0,
      medFreqPowerML: 0,
      highFreqPowerAP: 0,
      highFreqPowerML: 0,
      totalPowerAP: 0,
      totalPowerML: 0,
      medianFreqAP: 0,
      medianFreqML: 0,
      freqCentroidAP: 0,
      freqCentroidML: 0,
      spectralEntropyAP: 0,
      spectralEntropyML: 0,
      lowMedRatioAP: 0,
      lowMedRatioML: 0,
    };
  }

  private emptyDiffusionMetrics(): DiffusionMetrics {
    return {
      shortTermDiffusionAP: 0,
      shortTermDiffusionML: 0,
      longTermDiffusionAP: 0,
      longTermDiffusionML: 0,
      criticalTimeAP: 0,
      criticalTimeML: 0,
      criticalDisplacementAP: 0,
      criticalDisplacementML: 0,
      scalingExponentShortAP: 0.5,
      scalingExponentShortML: 0.5,
      scalingExponentLongAP: 0.5,
      scalingExponentLongML: 0.5,
    };
  }

  private emptyEntropyMetrics(): EntropyMetrics {
    return {
      sampleEntropyAP: 0,
      sampleEntropyML: 0,
      sampleEntropy2D: 0,
      embeddingDimension: SAMPEN_M,
      tolerance: SAMPEN_R_FACTOR,
    };
  }
}
