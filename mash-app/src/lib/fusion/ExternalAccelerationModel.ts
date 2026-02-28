/**
 * External Acceleration Model
 *
 * Detects and estimates external accelerations to improve sensor fusion accuracy.
 * Key insight: When under external acceleration, accelerometer no longer measures
 * only gravity, so tilt correction should be reduced or disabled.
 *
 * Methods:
 * 1. Magnitude check: |accel| ≠ g indicates external forces
 * 2. High-pass filtering: Extracts dynamic acceleration component
 * 3. Jerk detection: High rate of acceleration change indicates impacts
 * 4. Frequency analysis: Gravity is DC, movement creates AC
 *
 * Applications:
 * - Jump detection (freefall + impact)
 * - Running impact detection
 * - Rapid direction changes
 * - Falling detection
 *
 * @module lib/fusion/ExternalAccelerationModel
 */

// ============================================================================
// INTERFACES
// ============================================================================

export interface ExternalAccelState {
  /** Whether external acceleration is currently detected */
  isExternal: boolean;
  /** Estimated gravity vector in sensor frame */
  gravityEstimate: [number, number, number];
  /** Estimated external acceleration in sensor frame */
  externalAccel: [number, number, number];
  /** Magnitude of external acceleration (m/s²) */
  externalMagnitude: number;
  /** Current motion type */
  motionType: MotionType;
  /** Confidence in gravity estimate (0-1) */
  gravityConfidence: number;
  /** Timestamp of last update */
  timestamp: number;
}

export type MotionType =
  | "static" // No movement, pure gravity
  | "lowMotion" // Small movements (standing sway)
  | "walking" // Regular periodic motion
  | "running" // Higher impact periodic motion
  | "freefall" // Gravity-free state (jumping)
  | "impact" // High g impact (landing)
  | "highMotion"; // Unpredictable high acceleration

export interface ExternalAccelConfig {
  /** Gravity constant (m/s²). Default 9.81 */
  gravity: number;
  /** Tolerance for static detection (fraction). Default 0.05 */
  staticTolerance: number;
  /** Threshold for freefall detection (m/s²). Default 2.0 */
  freefallThreshold: number;
  /** Threshold for impact detection (m/s²). Default 15.0 */
  impactThreshold: number;
  /** Jerk threshold for impact detection (m/s³). Default 200 */
  jerkThreshold: number;
  /** High-pass filter cutoff (Hz). Default 0.5 */
  highPassCutoff: number;
  /** Low-pass filter for gravity (Hz). Default 0.1 */
  gravityLowPassCutoff: number;
  /** Window size for motion classification (samples). Default 50 */
  classificationWindow: number;
}

interface FilterState {
  x: number;
  y: number;
  z: number;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

export class ExternalAccelerationModel {
  // Configuration
  private config: ExternalAccelConfig;

  // State
  private gravityEstimate: [number, number, number] = [0, 9.81, 0];
  private externalAccel: [number, number, number] = [0, 0, 0];
  private prevAccel: [number, number, number] = [0, 9.81, 0];
  private prevTimestamp: number = 0;
  private motionType: MotionType = "static";
  private gravityConfidence: number = 1.0;

  // Filter state
  private highPassState: FilterState = { x: 0, y: 0, z: 0 };
  private lowPassState: FilterState = { x: 0, y: 9.81, z: 0 };
  private filteredAccel: [number, number, number] = [0, 0, 0];

  // Motion classification
  private magnitudeHistory: number[] = [];
  private jerkHistory: number[] = [];
  private freefallCounter: number = 0;
  private impactCounter: number = 0;

  constructor(config?: Partial<ExternalAccelConfig>) {
    this.config = {
      gravity: 9.81,
      staticTolerance: 0.05,
      freefallThreshold: 2.0,
      impactThreshold: 15.0,
      jerkThreshold: 200,
      highPassCutoff: 0.5,
      gravityLowPassCutoff: 0.1,
      classificationWindow: 50,
      ...config,
    };
  }

  /**
   * Update with new accelerometer reading.
   *
   * @param accel Accelerometer reading [x, y, z] in m/s²
   * @param timestamp Current timestamp in ms
   * @param dt Time step in seconds (optional, computed if not provided)
   */
  public update(
    accel: [number, number, number],
    timestamp: number,
    dt?: number,
  ): ExternalAccelState {
    // Calculate dt if not provided
    if (dt === undefined) {
      dt =
        this.prevTimestamp > 0 ? (timestamp - this.prevTimestamp) / 1000 : 0.01;
    }
    dt = Math.max(0.001, Math.min(0.1, dt)); // Clamp to reasonable range

    const [ax, ay, az] = accel;
    const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);

    // =====================================================================
    // 1. UPDATE FILTERS
    // =====================================================================

    // High-pass filter (extract dynamic/external component)
    const hpAlpha = this.computeFilterAlpha(dt, this.config.highPassCutoff);
    this.highPassState = {
      x: hpAlpha * (this.highPassState.x + ax - this.prevAccel[0]),
      y: hpAlpha * (this.highPassState.y + ay - this.prevAccel[1]),
      z: hpAlpha * (this.highPassState.z + az - this.prevAccel[2]),
    };

    // Low-pass filter (estimate gravity)
    const lpAlpha = this.computeFilterAlpha(
      dt,
      this.config.gravityLowPassCutoff,
    );
    this.lowPassState = {
      x: lpAlpha * ax + (1 - lpAlpha) * this.lowPassState.x,
      y: lpAlpha * ay + (1 - lpAlpha) * this.lowPassState.y,
      z: lpAlpha * az + (1 - lpAlpha) * this.lowPassState.z,
    };

    // =====================================================================
    // 2. CALCULATE JERK (Rate of Acceleration Change)
    // =====================================================================

    const jerk = Math.sqrt(
      Math.pow((ax - this.prevAccel[0]) / dt, 2) +
        Math.pow((ay - this.prevAccel[1]) / dt, 2) +
        Math.pow((az - this.prevAccel[2]) / dt, 2),
    );

    // =====================================================================
    // 3. UPDATE HISTORIES
    // =====================================================================

    this.magnitudeHistory.push(magnitude);
    if (this.magnitudeHistory.length > this.config.classificationWindow) {
      this.magnitudeHistory.shift();
    }

    this.jerkHistory.push(jerk);
    if (this.jerkHistory.length > this.config.classificationWindow) {
      this.jerkHistory.shift();
    }

    // =====================================================================
    // 4. CLASSIFY MOTION TYPE
    // =====================================================================

    this.motionType = this.classifyMotion(magnitude, jerk);

    // =====================================================================
    // 5. ESTIMATE GRAVITY AND EXTERNAL ACCELERATION
    // =====================================================================

    this.updateGravityEstimate(accel, magnitude);

    // External acceleration = measured - gravity
    this.externalAccel = [
      ax - this.gravityEstimate[0],
      ay - this.gravityEstimate[1],
      az - this.gravityEstimate[2],
    ];

    // =====================================================================
    // 6. UPDATE STATE
    // =====================================================================

    this.filteredAccel = [
      this.highPassState.x,
      this.highPassState.y,
      this.highPassState.z,
    ];

    this.prevAccel = [ax, ay, az];
    this.prevTimestamp = timestamp;

    // Return state
    const externalMag = Math.sqrt(
      this.externalAccel[0] ** 2 +
        this.externalAccel[1] ** 2 +
        this.externalAccel[2] ** 2,
    );

    return {
      isExternal:
        externalMag > this.config.gravity * this.config.staticTolerance,
      gravityEstimate: [...this.gravityEstimate],
      externalAccel: [...this.externalAccel],
      externalMagnitude: externalMag,
      motionType: this.motionType,
      gravityConfidence: this.gravityConfidence,
      timestamp,
    };
  }

  /**
   * Classify current motion type based on acceleration patterns.
   */
  private classifyMotion(magnitude: number, jerk: number): MotionType {
    const g = this.config.gravity;

    // Check for freefall (very low g)
    if (magnitude < this.config.freefallThreshold) {
      this.freefallCounter++;
      this.impactCounter = 0;
      if (this.freefallCounter > 3) {
        // Need sustained freefall
        return "freefall";
      }
    } else {
      this.freefallCounter = 0;
    }

    // Check for impact (very high g)
    if (
      magnitude > this.config.impactThreshold ||
      jerk > this.config.jerkThreshold
    ) {
      this.impactCounter++;
      if (this.impactCounter > 1) {
        return "impact";
      }
    } else {
      this.impactCounter = Math.max(0, this.impactCounter - 1);
    }

    // Check for static (magnitude ≈ g, low jerk)
    const magDeviation = Math.abs(magnitude - g) / g;
    if (magDeviation < this.config.staticTolerance && jerk < 5) {
      return "static";
    }

    // Analyze recent history for patterns
    if (this.magnitudeHistory.length >= 10) {
      const avgMag = this.mean(this.magnitudeHistory.slice(-20));
      const stdMag = this.std(this.magnitudeHistory.slice(-20));
      const avgJerk = this.mean(this.jerkHistory.slice(-20));

      // Low motion: small variations
      if (stdMag < 0.5 && avgJerk < 20) {
        return "lowMotion";
      }

      // High motion: large unpredictable variations
      if (stdMag > 3.0 || avgJerk > 100) {
        return "highMotion";
      }

      // Walking vs running: based on peak magnitude and periodicity
      const maxMag = Math.max(...this.magnitudeHistory.slice(-20));
      if (maxMag > 20) {
        return "running";
      } else if (maxMag > 12) {
        return "walking";
      }
    }

    return "lowMotion";
  }

  /**
   * Update gravity estimate based on motion type.
   */
  private updateGravityEstimate(
    accel: [number, number, number],
    magnitude: number,
  ): void {
    const g = this.config.gravity;
    const [ax, ay, az] = accel;

    switch (this.motionType) {
      case "static":
        // Trust accelerometer fully - it's measuring gravity
        const staticAlpha = 0.1;
        this.gravityEstimate = [
          this.gravityEstimate[0] +
            staticAlpha * (ax - this.gravityEstimate[0]),
          this.gravityEstimate[1] +
            staticAlpha * (ay - this.gravityEstimate[1]),
          this.gravityEstimate[2] +
            staticAlpha * (az - this.gravityEstimate[2]),
        ];
        this.gravityConfidence = 0.95;
        break;

      case "lowMotion":
        // Mostly trust accelerometer with slower update
        const lowAlpha = 0.03;
        this.gravityEstimate = [
          this.gravityEstimate[0] + lowAlpha * (ax - this.gravityEstimate[0]),
          this.gravityEstimate[1] + lowAlpha * (ay - this.gravityEstimate[1]),
          this.gravityEstimate[2] + lowAlpha * (az - this.gravityEstimate[2]),
        ];
        this.gravityConfidence = 0.8;
        break;

      case "walking":
      case "running":
        // Use low-pass filtered value (average over stride)
        const moveAlpha = 0.01;
        this.gravityEstimate = [
          this.gravityEstimate[0] +
            moveAlpha * (this.lowPassState.x - this.gravityEstimate[0]),
          this.gravityEstimate[1] +
            moveAlpha * (this.lowPassState.y - this.gravityEstimate[1]),
          this.gravityEstimate[2] +
            moveAlpha * (this.lowPassState.z - this.gravityEstimate[2]),
        ];
        this.gravityConfidence = this.motionType === "walking" ? 0.6 : 0.4;
        break;

      case "freefall":
        // Don't update gravity estimate during freefall
        this.gravityConfidence = 0.1;
        break;

      case "impact":
        // Don't trust accelerometer during impact
        this.gravityConfidence = 0.05;
        break;

      case "highMotion":
        // Very slow update, low confidence
        const highAlpha = 0.005;
        this.gravityEstimate = [
          this.gravityEstimate[0] +
            highAlpha * (this.lowPassState.x - this.gravityEstimate[0]),
          this.gravityEstimate[1] +
            highAlpha * (this.lowPassState.y - this.gravityEstimate[1]),
          this.gravityEstimate[2] +
            highAlpha * (this.lowPassState.z - this.gravityEstimate[2]),
        ];
        this.gravityConfidence = 0.3;
        break;
    }

    // Normalize gravity estimate to expected magnitude
    const gravMag = Math.sqrt(
      this.gravityEstimate[0] ** 2 +
        this.gravityEstimate[1] ** 2 +
        this.gravityEstimate[2] ** 2,
    );
    if (gravMag > 0.1) {
      this.gravityEstimate = [
        (this.gravityEstimate[0] * g) / gravMag,
        (this.gravityEstimate[1] * g) / gravMag,
        (this.gravityEstimate[2] * g) / gravMag,
      ];
    }
  }

  // ========================================================================
  // STATE ACCESSORS
  // ========================================================================

  /**
   * Get current state.
   */
  public getState(): ExternalAccelState {
    const externalMag = Math.sqrt(
      this.externalAccel[0] ** 2 +
        this.externalAccel[1] ** 2 +
        this.externalAccel[2] ** 2,
    );

    return {
      isExternal:
        externalMag > this.config.gravity * this.config.staticTolerance,
      gravityEstimate: [...this.gravityEstimate],
      externalAccel: [...this.externalAccel],
      externalMagnitude: externalMag,
      motionType: this.motionType,
      gravityConfidence: this.gravityConfidence,
      timestamp: this.prevTimestamp,
    };
  }

  /**
   * Get high-pass filtered acceleration (dynamic component).
   */
  public getDynamicAcceleration(): [number, number, number] {
    return [...this.filteredAccel];
  }

  /**
   * Get acceleration correction weight for sensor fusion.
   * Returns 0-1 weight for how much to trust accelerometer for tilt correction.
   */
  public getAccelerometerCorrectionWeight(): number {
    switch (this.motionType) {
      case "static":
        return 1.0;
      case "lowMotion":
        return 0.8;
      case "walking":
        return 0.4;
      case "running":
        return 0.2;
      case "freefall":
        return 0.0;
      case "impact":
        return 0.0;
      case "highMotion":
        return 0.1;
      default:
        return 0.5;
    }
  }

  /**
   * Check if currently in freefall.
   */
  public isInFreefall(): boolean {
    return this.motionType === "freefall";
  }

  /**
   * Check if impact detected.
   */
  public isImpact(): boolean {
    return this.motionType === "impact";
  }

  /**
   * Reset state.
   */
  public reset(): void {
    this.gravityEstimate = [0, this.config.gravity, 0];
    this.externalAccel = [0, 0, 0];
    this.prevAccel = [0, this.config.gravity, 0];
    this.prevTimestamp = 0;
    this.motionType = "static";
    this.gravityConfidence = 1.0;
    this.highPassState = { x: 0, y: 0, z: 0 };
    this.lowPassState = { x: 0, y: this.config.gravity, z: 0 };
    this.filteredAccel = [0, 0, 0];
    this.magnitudeHistory = [];
    this.jerkHistory = [];
    this.freefallCounter = 0;
    this.impactCounter = 0;
  }

  // ========================================================================
  // UTILITY FUNCTIONS
  // ========================================================================

  /**
   * Compute low-pass/high-pass filter alpha from cutoff frequency.
   */
  private computeFilterAlpha(dt: number, cutoffHz: number): number {
    const rc = 1 / (2 * Math.PI * cutoffHz);
    return rc / (rc + dt);
  }

  /**
   * Calculate mean of array.
   */
  private mean(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /**
   * Calculate standard deviation of array.
   */
  private std(arr: number[]): number {
    if (arr.length < 2) return 0;
    const avg = this.mean(arr);
    const squaredDiffs = arr.map((v) => (v - avg) ** 2);
    return Math.sqrt(this.mean(squaredDiffs));
  }
}

/**
 * Detect jumps from acceleration data.
 * Returns detailed jump phases.
 */
export interface JumpPhase {
  phase: "ground" | "takeoff" | "flight" | "landing" | "recovery";
  startTime: number;
  peakAccel?: number;
  duration?: number;
}

export class JumpDetector {
  private model: ExternalAccelerationModel;
  private currentPhase: JumpPhase["phase"] = "ground";
  private phaseStartTime: number = 0;
  private peakAccel: number = 0;
  private lastJumpHeight: number = 0;

  constructor() {
    this.model = new ExternalAccelerationModel({
      freefallThreshold: 3.0, // More aggressive freefall detection
      impactThreshold: 18.0,
    });
  }

  /**
   * Update with accelerometer data.
   * @returns Current jump phase information
   */
  public update(accel: [number, number, number], timestamp: number): JumpPhase {
    const state = this.model.update(accel, timestamp);
    const magnitude = Math.sqrt(accel[0] ** 2 + accel[1] ** 2 + accel[2] ** 2);

    const prevPhase = this.currentPhase;

    // State machine for jump detection
    switch (this.currentPhase) {
      case "ground":
        if (state.motionType === "freefall") {
          this.currentPhase = "flight";
          this.phaseStartTime = timestamp;
          this.peakAccel = 0;
        } else if (magnitude > 15 && state.motionType !== "static") {
          // Could be takeoff preparation
          this.currentPhase = "takeoff";
          this.phaseStartTime = timestamp;
          this.peakAccel = magnitude;
        }
        break;

      case "takeoff":
        this.peakAccel = Math.max(this.peakAccel, magnitude);
        if (state.motionType === "freefall") {
          this.currentPhase = "flight";
          this.phaseStartTime = timestamp;
        } else if (timestamp - this.phaseStartTime > 500) {
          // Timeout - wasn't a jump
          this.currentPhase = "ground";
        }
        break;

      case "flight":
        if (state.motionType === "impact") {
          this.currentPhase = "landing";
          this.phaseStartTime = timestamp;
          this.peakAccel = magnitude;
          // Estimate jump height from flight time
          // h = 0.5 * g * (t/2)^2 where t is total flight time
          const flightTime = (timestamp - this.phaseStartTime) / 1000;
          this.lastJumpHeight = 0.5 * 9.81 * Math.pow(flightTime / 2, 2);
        }
        break;

      case "landing":
        this.peakAccel = Math.max(this.peakAccel, magnitude);
        if (state.motionType === "static" || state.motionType === "lowMotion") {
          this.currentPhase = "recovery";
          this.phaseStartTime = timestamp;
        } else if (timestamp - this.phaseStartTime > 1000) {
          // Extended landing - back to ground
          this.currentPhase = "ground";
        }
        break;

      case "recovery":
        if (state.motionType === "static") {
          // Recovery complete
          if (timestamp - this.phaseStartTime > 200) {
            this.currentPhase = "ground";
          }
        } else if (state.motionType === "freefall") {
          // Another jump!
          this.currentPhase = "flight";
          this.phaseStartTime = timestamp;
        }
        break;
    }

    return {
      phase: this.currentPhase,
      startTime: this.phaseStartTime,
      peakAccel: this.peakAccel,
      duration: timestamp - this.phaseStartTime,
    };
  }

  /**
   * Get last detected jump height (meters).
   */
  public getLastJumpHeight(): number {
    return this.lastJumpHeight;
  }

  /**
   * Check if currently in jump.
   */
  public isJumping(): boolean {
    return (
      this.currentPhase === "takeoff" ||
      this.currentPhase === "flight" ||
      this.currentPhase === "landing"
    );
  }

  /**
   * Reset state.
   */
  public reset(): void {
    this.model.reset();
    this.currentPhase = "ground";
    this.phaseStartTime = 0;
    this.peakAccel = 0;
    this.lastJumpHeight = 0;
  }
}
