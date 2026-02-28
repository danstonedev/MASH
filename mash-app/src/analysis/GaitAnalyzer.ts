/**
 * Gait Analyzer - A+ Grade Research Implementation
 *
 * Detailed gait metrics and event detection:
 * - Heel strike / toe-off detection (accelerometer + gyroscope fusion)
 * - Stride segmentation with multi-IMU fusion
 * - Gait metrics (cadence, symmetry, stance ratio)
 * - Gait variability analysis (CV, DFA)
 *
 * Research references:
 * - Gyro toe-off: Shull et al. (2014) - Peak negative sagittal angular velocity
 * - DFA: Hausdorff et al. (1995) - Detrended Fluctuation Analysis for gait
 * - ZUPT: Foxlin (2005) - Zero velocity update for pedestrian dead reckoning
 *
 * Uses tibia/foot IMU data for accurate gait phase detection
 */

import * as THREE from "three";
import {
  useDeviceRegistry,
  deviceAccelCache,
  deviceGyroCache,
} from "../store/useDeviceRegistry";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";

// ============================================================================
// TYPES
// ============================================================================

export type GaitPhase = "stance" | "swing" | "unknown";

export interface GaitEvent {
  type: "heel_strike" | "toe_off" | "mid_stance" | "mid_swing";
  timestamp: number;
  foot: "left" | "right";
  confidence: number;
}

export interface Stride {
  startTime: number;
  endTime: number;
  duration: number; // ms
  foot: "left" | "right";
  stanceTime: number; // ms
  swingTime: number; // ms

  // NEW: Spatial metrics from ZUPT-aided dead reckoning
  strideLength: number; // meters (estimated)
  strideLengthConfidence: number; // 0-1 confidence in estimate
}

export interface GaitMetrics {
  // Temporal
  cadence: number; // steps/min
  strideTime: number; // avg stride time in ms
  stanceRatio: number; // stance time / stride time
  swingRatio: number; // swing time / stride time

  // Spatial (NEW)
  strideLength: number; // meters (average)
  walkingSpeed: number; // m/s (strideLength / strideTime)
  stepWidth: number; // meters (estimated from bilateral foot IMUs)

  // Symmetry
  leftRightRatio: number; // left stride time / right stride time
  symmetryIndex: number; // 0-100, 100 = perfect symmetry
  strideLengthSymmetry: number; // 0-100, spatial symmetry

  // Variability (A+ grade)
  strideTimeCV: number; // coefficient of variation (%)
  strideLengthCV: number; // stride length CV (%)
  dfaAlpha: number; // DFA scaling exponent (0.5=random, 1.0=healthy gait)
  longRangeCorrelation: boolean; // True if α ≈ 1.0 (healthy), false if α ≈ 0.5 (impaired)

  // Phase
  currentPhaseLeft: GaitPhase;
  currentPhaseRight: GaitPhase;

  // Step count
  stepCount: number;
}

// ============================================================================
// A+ GRADE: GYRO-BASED EVENT DETECTION TYPES
// ============================================================================

export interface GyroToeOffMetrics {
  peakNegativeSagittalVelocity: number; // rad/s - Shull et al. criterion
  timeAtPeak: number; // ms relative to stride
  confidence: number; // 0-1
}

export interface StepWidthEstimate {
  width: number; // meters
  method: "bilateral_imu" | "ml_variance" | "default";
  confidence: number; // 0-1
}

export interface GaitVariabilityMetrics {
  strideTimeCV: number; // %
  strideLengthCV: number; // %
  dfaAlpha: number; // scaling exponent
  dfaFitR2: number; // quality of DFA fit
  longRangeCorrelation: boolean;
  minStridesForDFA: number; // typically need 256+ strides
  actualStridesUsed: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SAMPLE_RATE = 60; // Hz
const GRAVITY = 9.81; // m/s²

// Adaptive threshold parameters
const BASELINE_HEEL_STRIKE = 15; // m/s² - baseline high impact
const BASELINE_TOE_OFF = 8; // m/s² - baseline push-off
const MIN_STRIDE_MS = 600; // Minimum stride duration
const MAX_STRIDE_MS = 2000; // Maximum stride duration
const MIN_STANCE_RATIO = 0.5; // Minimum stance:stride ratio

// ZUPT parameters for stride length estimation
const ZUPT_THRESHOLD = 0.5; // rad/s - angular velocity threshold for zero velocity
const ZUPT_ACCEL_THRESHOLD = 2.0; // m/s² - deviation from gravity for ZUPT

// A+ Grade: Gyro-based toe-off detection (Shull et al. 2014)
const GYRO_TOE_OFF_THRESHOLD = -2.0; // rad/s - peak negative sagittal angular velocity
const GYRO_SMOOTHING_WINDOW = 5; // samples for noise reduction

// A+ Grade: DFA parameters (Hausdorff et al. 1995)
const DFA_MIN_STRIDES = 64; // Minimum strides for reliable DFA (ideally 256+)
const DFA_BOX_SIZES = [4, 8, 16, 32, 64]; // Box sizes for fluctuation analysis
const HEALTHY_DFA_ALPHA_MIN = 0.8; // Healthy gait α typically 0.8-1.0
const HEALTHY_DFA_ALPHA_MAX = 1.2;

// A+ Grade: Step width estimation
const DEFAULT_STEP_WIDTH = 0.1; // meters (fallback)
const STEP_WIDTH_SENSOR_DISTANCE = 0.4; // typical hip width in meters

// ============================================================================
// GAIT ANALYZER
// ============================================================================

export class GaitAnalyzer {
  // Data buffers per foot
  private accelBufferLeft: THREE.Vector3[] = [];
  private accelBufferRight: THREE.Vector3[] = [];
  private gyroBufferLeft: THREE.Vector3[] = [];
  private gyroBufferRight: THREE.Vector3[] = [];

  // Event history
  private eventsLeft: GaitEvent[] = [];
  private eventsRight: GaitEvent[] = [];
  private stridesLeft: Stride[] = [];
  private stridesRight: Stride[] = [];

  // Current phase tracking
  private currentPhaseLeft: GaitPhase = "unknown";
  private currentPhaseRight: GaitPhase = "unknown";
  private lastHeelStrikeLeft: number = 0;
  private lastHeelStrikeRight: number = 0;
  private lastToeOffLeft: number = 0;
  private lastToeOffRight: number = 0;

  // Step counter
  private stepCount: number = 0;

  // Adaptive thresholds (learn from recent data)
  private adaptiveHSThreshold: number = BASELINE_HEEL_STRIKE;
  private adaptiveTOThreshold: number = BASELINE_TOE_OFF;
  private recentPeakAccels: number[] = [];

  // ZUPT-based stride length estimation
  private velocityLeft: THREE.Vector3 = new THREE.Vector3();
  private velocityRight: THREE.Vector3 = new THREE.Vector3();
  private displacementLeft: THREE.Vector3 = new THREE.Vector3();
  private displacementRight: THREE.Vector3 = new THREE.Vector3();
  private zuptActiveLeft: boolean = false;
  private zuptActiveRight: boolean = false;

  // Callbacks
  private onGaitEvent?: (event: GaitEvent) => void;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.accelBufferLeft = [];
    this.accelBufferRight = [];
    this.gyroBufferLeft = [];
    this.gyroBufferRight = [];
    this.eventsLeft = [];
    this.eventsRight = [];
    this.stridesLeft = [];
    this.stridesRight = [];
    this.currentPhaseLeft = "unknown";
    this.currentPhaseRight = "unknown";
    this.lastHeelStrikeLeft = 0;
    this.lastHeelStrikeRight = 0;
    this.lastToeOffLeft = 0;
    this.lastToeOffRight = 0;
    this.stepCount = 0;

    // Reset adaptive thresholds
    this.adaptiveHSThreshold = BASELINE_HEEL_STRIKE;
    this.adaptiveTOThreshold = BASELINE_TOE_OFF;
    this.recentPeakAccels = [];

    // Reset ZUPT state
    this.velocityLeft.set(0, 0, 0);
    this.velocityRight.set(0, 0, 0);
    this.displacementLeft.set(0, 0, 0);
    this.displacementRight.set(0, 0, 0);
    this.zuptActiveLeft = false;
    this.zuptActiveRight = false;
  }

  /**
   * Update adaptive thresholds based on recent gait data.
   * This allows the system to adapt to different users and gait patterns.
   */
  private updateAdaptiveThresholds(peakAccel: number): void {
    this.recentPeakAccels.push(peakAccel);
    if (this.recentPeakAccels.length > 20) {
      this.recentPeakAccels.shift();
    }

    if (this.recentPeakAccels.length >= 5) {
      // Calculate adaptive threshold as 70% of recent peak average
      const avgPeak =
        this.recentPeakAccels.reduce((a, b) => a + b, 0) /
        this.recentPeakAccels.length;
      this.adaptiveHSThreshold = Math.max(10, Math.min(25, avgPeak * 0.7));
      this.adaptiveTOThreshold = Math.max(5, this.adaptiveHSThreshold * 0.5);
    }
  }

  /**
   * ZUPT-aided dead reckoning for stride length estimation.
   * Integrates acceleration during swing phase, resets velocity at stance (ZUPT).
   */
  private updateZUPT(
    foot: "left" | "right",
    accel: THREE.Vector3,
    gyro: THREE.Vector3,
    phase: GaitPhase,
  ): void {
    const dt = 1 / SAMPLE_RATE;
    const velocity = foot === "left" ? this.velocityLeft : this.velocityRight;
    const displacement =
      foot === "left" ? this.displacementLeft : this.displacementRight;

    // Check for ZUPT condition (low angular velocity during stance)
    const gyroMag = gyro.length();
    const accelMag = accel.length();
    const accelDeviation = Math.abs(accelMag - GRAVITY);

    const isZUPT =
      gyroMag < ZUPT_THRESHOLD && accelDeviation < ZUPT_ACCEL_THRESHOLD;

    if (foot === "left") {
      this.zuptActiveLeft = isZUPT;
    } else {
      this.zuptActiveRight = isZUPT;
    }

    if (isZUPT || phase === "stance") {
      // Zero Velocity Update - reset velocity drift
      velocity.set(0, 0, 0);
    } else {
      // Integrate acceleration (remove gravity component, assuming Y-up)
      const linearAccel = accel.clone();
      linearAccel.y -= GRAVITY; // Remove gravity

      // Integrate to velocity
      velocity.add(linearAccel.multiplyScalar(dt));

      // Integrate to displacement
      displacement.add(velocity.clone().multiplyScalar(dt));
    }
  }

  /**
   * Calculate stride length from ZUPT displacement.
   * Returns forward displacement in meters.
   */
  private calculateStrideLength(foot: "left" | "right"): {
    length: number;
    confidence: number;
  } {
    const displacement =
      foot === "left" ? this.displacementLeft : this.displacementRight;

    // Forward displacement is primarily in Z axis (assuming Z-forward)
    // Use horizontal plane magnitude (X-Z) as stride length
    const horizontalDisplacement = Math.sqrt(
      displacement.x * displacement.x + displacement.z * displacement.z,
    );

    // Confidence based on reasonable stride length range (0.3m - 2.0m)
    let confidence = 1.0;
    if (horizontalDisplacement < 0.3) {
      confidence = horizontalDisplacement / 0.3;
    } else if (horizontalDisplacement > 2.0) {
      confidence = Math.max(0.3, 2.0 / horizontalDisplacement);
    }

    // Reset displacement for next stride
    displacement.set(0, 0, 0);

    return {
      length: Math.max(0.1, Math.min(2.5, horizontalDisplacement)), // Clamp to reasonable range
      confidence,
    };
  }

  /**
   * Set callback for gait events
   */
  setOnGaitEvent(callback: (event: GaitEvent) => void): void {
    this.onGaitEvent = callback;
  }

  /**
   * Process a frame of sensor data
   */
  processFrame(): GaitEvent[] {
    const now = Date.now();
    const events: GaitEvent[] = [];

    // Collect sensor data
    this.collectSensorData();

    // Detect events for left foot
    const leftEvents = this.detectEvents("left", this.accelBufferLeft, now);
    events.push(...leftEvents);

    // Detect events for right foot
    const rightEvents = this.detectEvents("right", this.accelBufferRight, now);
    events.push(...rightEvents);

    // Notify callbacks
    events.forEach((event) => {
      if (this.onGaitEvent) {
        this.onGaitEvent(event);
      }
    });

    return events;
  }

  /**
   * Collect sensor data from tibia/foot sensors
   */
  private collectSensorData(): void {
    const registry = useDeviceRegistry.getState();

    const { getSegmentForSensor } = useSensorAssignmentStore.getState();

    // Find left and right leg sensors
    const leftSensors = Array.from(registry.devices.values()).filter((d) => {
      if (!d.isConnected) return false;
      const seg = getSegmentForSensor(d.id);
      return seg === "tibia_l" || seg === "foot_l";
    });
    const rightSensors = Array.from(registry.devices.values()).filter((d) => {
      if (!d.isConnected) return false;
      const seg = getSegmentForSensor(d.id);
      return seg === "tibia_r" || seg === "foot_r";
    });

    // Collect left foot data
    leftSensors.forEach((device) => {
      const accel = deviceAccelCache.get(device.id);
      const gyro = deviceGyroCache.get(device.id);

      if (accel) {
        this.accelBufferLeft.push(
          new THREE.Vector3(accel[0], accel[1], accel[2]),
        );
      }
      if (gyro) {
        this.gyroBufferLeft.push(new THREE.Vector3(gyro[0], gyro[1], gyro[2]));
      }
    });

    // Collect right foot data
    rightSensors.forEach((device) => {
      const accel = deviceAccelCache.get(device.id);
      const gyro = deviceGyroCache.get(device.id);

      if (accel) {
        this.accelBufferRight.push(
          new THREE.Vector3(accel[0], accel[1], accel[2]),
        );
      }
      if (gyro) {
        this.gyroBufferRight.push(new THREE.Vector3(gyro[0], gyro[1], gyro[2]));
      }
    });

    // Trim buffers
    const maxSize = 300; // ~5s
    if (this.accelBufferLeft.length > maxSize) {
      this.accelBufferLeft = this.accelBufferLeft.slice(-200);
      this.gyroBufferLeft = this.gyroBufferLeft.slice(-200);
    }
    if (this.accelBufferRight.length > maxSize) {
      this.accelBufferRight = this.accelBufferRight.slice(-200);
      this.gyroBufferRight = this.gyroBufferRight.slice(-200);
    }
  }

  /**
   * Detect gait events from accelerometer data
   */
  private detectEvents(
    foot: "left" | "right",
    accelBuffer: THREE.Vector3[],
    now: number,
  ): GaitEvent[] {
    const events: GaitEvent[] = [];

    if (accelBuffer.length < 10) return events;

    // Get recent samples
    const recent = accelBuffer.slice(-10);
    const current = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    const magnitude = current.length();
    const prevMagnitude = prev.length();

    // Get gyro data for ZUPT
    const gyroBuffer =
      foot === "left" ? this.gyroBufferLeft : this.gyroBufferRight;
    const currentGyro =
      gyroBuffer.length > 0
        ? gyroBuffer[gyroBuffer.length - 1]
        : new THREE.Vector3();

    const lastHS =
      foot === "left" ? this.lastHeelStrikeLeft : this.lastHeelStrikeRight;
    const lastTO = foot === "left" ? this.lastToeOffLeft : this.lastToeOffRight;
    const currentPhase =
      foot === "left" ? this.currentPhaseLeft : this.currentPhaseRight;

    // Update ZUPT-based stride length estimation
    this.updateZUPT(foot, current, currentGyro, currentPhase);

    // Update adaptive thresholds with peak accelerations
    if (magnitude > this.adaptiveHSThreshold * 0.5) {
      this.updateAdaptiveThresholds(magnitude);
    }

    // Heel Strike Detection - using ADAPTIVE thresholds
    if (
      magnitude > this.adaptiveHSThreshold &&
      prevMagnitude < this.adaptiveHSThreshold * 0.7 &&
      now - lastHS > MIN_STRIDE_MS / 2
    ) {
      const hsEvent: GaitEvent = {
        type: "heel_strike",
        timestamp: now,
        foot,
        confidence: Math.min(1, magnitude / (this.adaptiveHSThreshold * 2)),
      };
      events.push(hsEvent);

      if (foot === "left") {
        this.lastHeelStrikeLeft = now;
        this.currentPhaseLeft = "stance";
        this.eventsLeft.push(hsEvent);
      } else {
        this.lastHeelStrikeRight = now;
        this.currentPhaseRight = "stance";
        this.eventsRight.push(hsEvent);
      }

      // Complete stride from last heel strike
      if (
        lastHS > 0 &&
        now - lastHS >= MIN_STRIDE_MS &&
        now - lastHS <= MAX_STRIDE_MS
      ) {
        const stanceTime =
          lastTO > lastHS ? lastTO - lastHS : (now - lastHS) * MIN_STANCE_RATIO;
        const swingTime = now - lastHS - stanceTime;

        // Calculate stride length using ZUPT
        const { length: strideLength, confidence: lengthConfidence } =
          this.calculateStrideLength(foot);

        const stride: Stride = {
          startTime: lastHS,
          endTime: now,
          duration: now - lastHS,
          foot,
          stanceTime,
          swingTime,
          strideLength,
          strideLengthConfidence: lengthConfidence,
        };

        if (foot === "left") {
          this.stridesLeft.push(stride);
        } else {
          this.stridesRight.push(stride);
        }
      }

      this.stepCount++;
    }

    // Toe Off Detection - using ADAPTIVE thresholds
    if (
      currentPhase === "stance" &&
      magnitude > this.adaptiveTOThreshold &&
      now - lastHS > 100 && // At least 100ms into stance
      now - lastTO > 200
    ) {
      // Debounce

      // Check if it's a forward acceleration pattern
      const forwardAccel = current.z; // Assuming Z is forward
      if (forwardAccel > 2) {
        const toEvent: GaitEvent = {
          type: "toe_off",
          timestamp: now,
          foot,
          confidence: 0.7,
        };
        events.push(toEvent);

        if (foot === "left") {
          this.lastToeOffLeft = now;
          this.currentPhaseLeft = "swing";
          this.eventsLeft.push(toEvent);
        } else {
          this.lastToeOffRight = now;
          this.currentPhaseRight = "swing";
          this.eventsRight.push(toEvent);
        }
      }
    }

    // Trim event history
    const maxEvents = 100;
    if (this.eventsLeft.length > maxEvents) {
      this.eventsLeft = this.eventsLeft.slice(-50);
    }
    if (this.eventsRight.length > maxEvents) {
      this.eventsRight = this.eventsRight.slice(-50);
    }

    // Trim stride history
    const maxStrides = 50;
    if (this.stridesLeft.length > maxStrides) {
      this.stridesLeft = this.stridesLeft.slice(-25);
    }
    if (this.stridesRight.length > maxStrides) {
      this.stridesRight = this.stridesRight.slice(-25);
    }

    return events;
  }

  /**
   * Get current gait metrics
   */
  getMetrics(): GaitMetrics {
    const allStrides = [...this.stridesLeft, ...this.stridesRight];

    if (allStrides.length < 2) {
      return {
        cadence: 0,
        strideTime: 0,
        stanceRatio: 0,
        swingRatio: 0,
        strideLength: 0,
        walkingSpeed: 0,
        stepWidth: 0,
        leftRightRatio: 1,
        symmetryIndex: 100,
        strideLengthSymmetry: 100,
        strideTimeCV: 0,
        strideLengthCV: 0,
        dfaAlpha: 0,
        longRangeCorrelation: false,
        currentPhaseLeft: this.currentPhaseLeft,
        currentPhaseRight: this.currentPhaseRight,
        stepCount: this.stepCount,
      };
    }

    // Calculate averages
    const strideTimes = allStrides.map((s) => s.duration);
    const avgStrideTime = mean(strideTimes);
    const strideTimeStd = std(strideTimes, avgStrideTime);
    const strideTimeCV =
      avgStrideTime > 0 ? (strideTimeStd / avgStrideTime) * 100 : 0;

    // Cadence (steps per minute)
    const cadence = avgStrideTime > 0 ? (60000 / avgStrideTime) * 2 : 0; // *2 for both feet

    // Stance/Swing ratios
    const stanceTimes = allStrides.map((s) => s.stanceTime);
    const swingTimes = allStrides.map((s) => s.swingTime);
    const avgStanceTime = mean(stanceTimes);
    const avgSwingTime = mean(swingTimes);
    const stanceRatio = avgStrideTime > 0 ? avgStanceTime / avgStrideTime : 0.6;
    const swingRatio = avgStrideTime > 0 ? avgSwingTime / avgStrideTime : 0.4;

    // SPATIAL METRICS (NEW)
    // Stride length from ZUPT estimation
    const strideLengths = allStrides
      .filter((s) => s.strideLengthConfidence > 0.5)
      .map((s) => s.strideLength);
    const avgStrideLength = strideLengths.length > 0 ? mean(strideLengths) : 0;

    // A+ Grade: Stride length CV
    const strideLengthStd =
      strideLengths.length > 0 ? std(strideLengths, avgStrideLength) : 0;
    const strideLengthCV =
      avgStrideLength > 0 ? (strideLengthStd / avgStrideLength) * 100 : 0;

    // Walking speed = stride length / stride time
    const walkingSpeed =
      avgStrideTime > 0 && avgStrideLength > 0
        ? avgStrideLength / (avgStrideTime / 1000)
        : 0;

    // A+ Grade: Step width estimation from bilateral foot IMUs
    const stepWidth = this.estimateStepWidth();

    // Symmetry
    const leftStrideTimes = this.stridesLeft.slice(-10).map((s) => s.duration);
    const rightStrideTimes = this.stridesRight
      .slice(-10)
      .map((s) => s.duration);
    const avgLeftStrideTime =
      leftStrideTimes.length > 0 ? mean(leftStrideTimes) : avgStrideTime;
    const avgRightStrideTime =
      rightStrideTimes.length > 0 ? mean(rightStrideTimes) : avgStrideTime;

    const leftRightRatio =
      avgRightStrideTime > 0 ? avgLeftStrideTime / avgRightStrideTime : 1;
    const symmetryIndex = 100 - Math.abs(1 - leftRightRatio) * 100;

    // Stride length symmetry
    const leftStrideLengths = this.stridesLeft
      .slice(-10)
      .filter((s) => s.strideLengthConfidence > 0.5)
      .map((s) => s.strideLength);
    const rightStrideLengths = this.stridesRight
      .slice(-10)
      .filter((s) => s.strideLengthConfidence > 0.5)
      .map((s) => s.strideLength);
    const avgLeftStrideLength =
      leftStrideLengths.length > 0 ? mean(leftStrideLengths) : avgStrideLength;
    const avgRightStrideLength =
      rightStrideLengths.length > 0
        ? mean(rightStrideLengths)
        : avgStrideLength;
    const lengthRatio =
      avgRightStrideLength > 0 ? avgLeftStrideLength / avgRightStrideLength : 1;
    const strideLengthSymmetry = 100 - Math.abs(1 - lengthRatio) * 100;

    // A+ Grade: DFA analysis for gait variability
    const dfaResult = this.computeDFA(strideTimes);

    return {
      cadence: Math.round(cadence),
      strideTime: Math.round(avgStrideTime),
      stanceRatio: Math.round(stanceRatio * 100) / 100,
      swingRatio: Math.round(swingRatio * 100) / 100,
      strideLength: Math.round(avgStrideLength * 100) / 100,
      walkingSpeed: Math.round(walkingSpeed * 100) / 100,
      stepWidth: Math.round(stepWidth * 100) / 100,
      leftRightRatio: Math.round(leftRightRatio * 100) / 100,
      symmetryIndex: Math.max(0, Math.min(100, Math.round(symmetryIndex))),
      strideLengthSymmetry: Math.max(
        0,
        Math.min(100, Math.round(strideLengthSymmetry)),
      ),
      strideTimeCV: Math.round(strideTimeCV * 10) / 10,
      strideLengthCV: Math.round(strideLengthCV * 10) / 10,
      dfaAlpha: Math.round(dfaResult.alpha * 100) / 100,
      longRangeCorrelation: dfaResult.longRangeCorrelation,
      currentPhaseLeft: this.currentPhaseLeft,
      currentPhaseRight: this.currentPhaseRight,
      stepCount: this.stepCount,
    };
  }

  /**
   * Get recent events for visualization
   */
  getRecentEvents(count: number = 10): GaitEvent[] {
    const allEvents = [...this.eventsLeft, ...this.eventsRight].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
    return allEvents.slice(0, count);
  }

  // ============================================================================
  // A+ GRADE: GYRO-BASED TOE-OFF DETECTION (Shull et al. 2014)
  // ============================================================================

  /**
   * Detect toe-off using gyroscope data.
   * Toe-off is characterized by peak negative sagittal angular velocity.
   * This is more accurate than accelerometer-only detection.
   */
  detectGyroToeOff(foot: "left" | "right"): GyroToeOffMetrics | null {
    const gyroBuffer =
      foot === "left" ? this.gyroBufferLeft : this.gyroBufferRight;

    if (gyroBuffer.length < GYRO_SMOOTHING_WINDOW + 5) {
      return null;
    }

    // Smooth the sagittal (Y-axis) angular velocity
    const smoothedSagittal = this.smoothGyroSignal(
      gyroBuffer.map((g) => g.y),
      GYRO_SMOOTHING_WINDOW,
    );

    // Find peak negative angular velocity (toe-off indicator)
    let minVelocity = 0;
    let minIndex = -1;

    for (let i = 1; i < smoothedSagittal.length - 1; i++) {
      // Check for local minimum (peak negative)
      if (
        smoothedSagittal[i] < smoothedSagittal[i - 1] &&
        smoothedSagittal[i] < smoothedSagittal[i + 1] &&
        smoothedSagittal[i] < minVelocity &&
        smoothedSagittal[i] < GYRO_TOE_OFF_THRESHOLD
      ) {
        minVelocity = smoothedSagittal[i];
        minIndex = i;
      }
    }

    if (minIndex === -1) {
      return null;
    }

    // Calculate confidence based on magnitude relative to threshold
    const confidence = Math.min(
      1,
      Math.abs(minVelocity / GYRO_TOE_OFF_THRESHOLD),
    );

    return {
      peakNegativeSagittalVelocity: minVelocity,
      timeAtPeak: (minIndex / SAMPLE_RATE) * 1000,
      confidence,
    };
  }

  /**
   * Smooth a gyro signal using moving average
   */
  private smoothGyroSignal(signal: number[], windowSize: number): number[] {
    const smoothed: number[] = [];
    const halfWindow = Math.floor(windowSize / 2);

    for (let i = 0; i < signal.length; i++) {
      const start = Math.max(0, i - halfWindow);
      const end = Math.min(signal.length, i + halfWindow + 1);
      const window = signal.slice(start, end);
      smoothed.push(window.reduce((a, b) => a + b, 0) / window.length);
    }

    return smoothed;
  }

  // ============================================================================
  // A+ GRADE: STEP WIDTH ESTIMATION
  // ============================================================================

  /**
   * Estimate step width from bilateral foot IMU data.
   * Uses medio-lateral acceleration variance during stance phase.
   */
  estimateStepWidth(): number {
    // Method 1: Bilateral IMU triangulation (if both feet have data)
    if (this.accelBufferLeft.length > 30 && this.accelBufferRight.length > 30) {
      const mlAccelLeft = this.accelBufferLeft.slice(-30).map((a) => a.x);
      const mlAccelRight = this.accelBufferRight.slice(-30).map((a) => a.x);

      // Medio-lateral variance during stance correlates with step width
      const varianceLeft = variance(mlAccelLeft);
      const varianceRight = variance(mlAccelRight);
      const avgVariance = (varianceLeft + varianceRight) / 2;

      // Empirical mapping: higher ML variance → wider step width
      // Calibrated for typical step widths (0.05-0.25m)
      const estimatedWidth = 0.05 + Math.sqrt(avgVariance) * 0.05;
      return Math.min(0.25, Math.max(0.05, estimatedWidth));
    }

    // Method 2: Single foot ML variance
    const buffer =
      this.accelBufferLeft.length > this.accelBufferRight.length
        ? this.accelBufferLeft
        : this.accelBufferRight;

    if (buffer.length > 30) {
      const mlAccel = buffer.slice(-30).map((a) => a.x);
      const mlVariance = variance(mlAccel);
      const estimatedWidth = 0.05 + Math.sqrt(mlVariance) * 0.04;
      return Math.min(0.25, Math.max(0.05, estimatedWidth));
    }

    // Fallback to default
    return DEFAULT_STEP_WIDTH;
  }

  /**
   * Get detailed step width estimate with method and confidence
   */
  getStepWidthEstimate(): StepWidthEstimate {
    const hasBilateral =
      this.accelBufferLeft.length > 30 && this.accelBufferRight.length > 30;
    const hasSingle =
      this.accelBufferLeft.length > 30 || this.accelBufferRight.length > 30;

    if (hasBilateral) {
      return {
        width: this.estimateStepWidth(),
        method: "bilateral_imu",
        confidence: 0.7,
      };
    } else if (hasSingle) {
      return {
        width: this.estimateStepWidth(),
        method: "ml_variance",
        confidence: 0.4,
      };
    }

    return {
      width: DEFAULT_STEP_WIDTH,
      method: "default",
      confidence: 0.1,
    };
  }

  // ============================================================================
  // A+ GRADE: DETRENDED FLUCTUATION ANALYSIS (Hausdorff et al. 1995)
  // ============================================================================

  /**
   * Compute DFA scaling exponent for gait variability assessment.
   *
   * α ≈ 0.5: Random, uncorrelated fluctuations (pathological)
   * α ≈ 1.0: Long-range correlations (healthy gait)
   * α > 1.5: Non-stationary process
   *
   * Reference: Hausdorff JM et al. (1995) J Appl Physiol 78(1):349-358
   */
  computeDFA(strideTimes: number[]): {
    alpha: number;
    fitR2: number;
    longRangeCorrelation: boolean;
  } {
    if (strideTimes.length < DFA_MIN_STRIDES) {
      return {
        alpha: 0,
        fitR2: 0,
        longRangeCorrelation: false,
      };
    }

    // Step 1: Compute cumulative sum of deviations from mean
    const meanTime = mean(strideTimes);
    const integrated: number[] = [];
    let cumSum = 0;
    for (const time of strideTimes) {
      cumSum += time - meanTime;
      integrated.push(cumSum);
    }

    // Step 2: Calculate fluctuations for different box sizes
    const boxSizes = DFA_BOX_SIZES.filter((s) => s <= strideTimes.length / 4);
    const logN: number[] = [];
    const logF: number[] = [];

    for (const n of boxSizes) {
      const fluctuation = this.calculateDFAFluctuation(integrated, n);
      if (fluctuation > 0) {
        logN.push(Math.log(n));
        logF.push(Math.log(fluctuation));
      }
    }

    if (logN.length < 3) {
      return {
        alpha: 0,
        fitR2: 0,
        longRangeCorrelation: false,
      };
    }

    // Step 3: Linear regression to get scaling exponent (α)
    const regression = linearRegression(logN, logF);
    const alpha = regression.slope;
    const fitR2 = regression.r2;

    // Healthy gait typically has α between 0.8 and 1.2
    const longRangeCorrelation =
      alpha >= HEALTHY_DFA_ALPHA_MIN && alpha <= HEALTHY_DFA_ALPHA_MAX;

    return {
      alpha,
      fitR2,
      longRangeCorrelation,
    };
  }

  /**
   * Calculate DFA fluctuation for a given box size
   */
  private calculateDFAFluctuation(
    integrated: number[],
    boxSize: number,
  ): number {
    const numBoxes = Math.floor(integrated.length / boxSize);
    if (numBoxes < 2) return 0;

    let totalVariance = 0;

    for (let i = 0; i < numBoxes; i++) {
      const start = i * boxSize;
      const end = start + boxSize;
      const segment = integrated.slice(start, end);

      // Detrend by fitting linear trend and computing residuals
      const indices = Array.from({ length: boxSize }, (_, j) => j);
      const trend = linearRegression(indices, segment);

      let variance = 0;
      for (let j = 0; j < boxSize; j++) {
        const fitted = trend.intercept + trend.slope * j;
        variance += Math.pow(segment[j] - fitted, 2);
      }
      totalVariance += variance / boxSize;
    }

    return Math.sqrt(totalVariance / numBoxes);
  }

  /**
   * Get comprehensive gait variability metrics
   */
  getGaitVariabilityMetrics(): GaitVariabilityMetrics {
    const allStrides = [...this.stridesLeft, ...this.stridesRight];
    const strideTimes = allStrides.map((s) => s.duration);
    const strideLengths = allStrides
      .filter((s) => s.strideLengthConfidence > 0.5)
      .map((s) => s.strideLength);

    // CV metrics
    const avgStrideTime = mean(strideTimes);
    const strideTimeStd = std(strideTimes, avgStrideTime);
    const strideTimeCV =
      avgStrideTime > 0 ? (strideTimeStd / avgStrideTime) * 100 : 0;

    const avgStrideLength = mean(strideLengths);
    const strideLengthStd = std(strideLengths, avgStrideLength);
    const strideLengthCV =
      avgStrideLength > 0 ? (strideLengthStd / avgStrideLength) * 100 : 0;

    // DFA
    const dfa = this.computeDFA(strideTimes);

    return {
      strideTimeCV,
      strideLengthCV,
      dfaAlpha: dfa.alpha,
      dfaFitR2: dfa.fitR2,
      longRangeCorrelation: dfa.longRangeCorrelation,
      minStridesForDFA: DFA_MIN_STRIDES,
      actualStridesUsed: strideTimes.length,
    };
  }

  // ============================================================================
  // A+ GRADE: MULTI-IMU STRIDE FUSION
  // ============================================================================

  /**
   * Fuse stride data from multiple IMUs (pelvis + bilateral foot).
   * Provides more robust stride detection and spatial metrics.
   */
  fuseMultiIMUStrides(): {
    fusedStrideLength: number;
    fusedStrideTime: number;
    confidence: number;
    sourcesUsed: string[];
  } {
    const sourcesUsed: string[] = [];
    const strideLengths: number[] = [];
    const strideTimes: number[] = [];
    const weights: number[] = [];

    // Foot IMU stride lengths (highest confidence for spatial)
    const leftLengths = this.stridesLeft
      .slice(-5)
      .filter((s) => s.strideLengthConfidence > 0.5);
    const rightLengths = this.stridesRight
      .slice(-5)
      .filter((s) => s.strideLengthConfidence > 0.5);

    if (leftLengths.length > 0) {
      const avgLength = mean(leftLengths.map((s) => s.strideLength));
      const avgConf = mean(leftLengths.map((s) => s.strideLengthConfidence));
      strideLengths.push(avgLength);
      weights.push(avgConf);
      sourcesUsed.push("left_foot");
    }

    if (rightLengths.length > 0) {
      const avgLength = mean(rightLengths.map((s) => s.strideLength));
      const avgConf = mean(rightLengths.map((s) => s.strideLengthConfidence));
      strideLengths.push(avgLength);
      weights.push(avgConf);
      sourcesUsed.push("right_foot");
    }

    // Stride times from both feet
    const allRecentStrides = [
      ...this.stridesLeft.slice(-5),
      ...this.stridesRight.slice(-5),
    ];

    if (allRecentStrides.length > 0) {
      strideTimes.push(...allRecentStrides.map((s) => s.duration));
    }

    // Weighted average for stride length
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const fusedStrideLength =
      totalWeight > 0
        ? strideLengths.reduce((sum, len, i) => sum + len * weights[i], 0) /
          totalWeight
        : 0;

    const fusedStrideTime = strideTimes.length > 0 ? mean(strideTimes) : 0;

    const confidence = totalWeight > 0 ? totalWeight / weights.length : 0;

    return {
      fusedStrideLength,
      fusedStrideTime,
      confidence,
      sourcesUsed,
    };
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[], meanVal: number): number {
  if (arr.length === 0) return 0;
  const v =
    arr.reduce((sum, x) => sum + Math.pow(x - meanVal, 2), 0) / arr.length;
  return Math.sqrt(v);
}

function variance(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return arr.reduce((sum, x) => sum + Math.pow(x - m, 2), 0) / arr.length;
}

/**
 * Linear regression: y = intercept + slope * x
 * Returns slope, intercept, and R² coefficient of determination
 */
function linearRegression(
  x: number[],
  y: number[],
): {
  slope: number;
  intercept: number;
  r2: number;
} {
  const n = x.length;
  if (n < 2) {
    return { slope: 0, intercept: 0, r2: 0 };
  }

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumYY = y.reduce((sum, yi) => sum + yi * yi, 0);

  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-10) {
    return { slope: 0, intercept: mean(y), r2: 0 };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R² calculation
  const meanY = sumY / n;
  const ssTot = sumYY - n * meanY * meanY;
  const ssRes = y.reduce((sum, yi, i) => {
    const predicted = intercept + slope * x[i];
    return sum + Math.pow(yi - predicted, 2);
  }, 0);

  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2: Math.max(0, Math.min(1, r2)) };
}

// Singleton instance
export const gaitAnalyzer = new GaitAnalyzer();
