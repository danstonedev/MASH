/**
 * FootContactDetector - ZUPT (Zero-velocity Update) Implementation
 * ================================================================
 *
 * Detects foot ground contact (stance phase) using IMU sensor data.
 *
 * ZUPT Theory:
 * - During stance phase, the foot has near-zero velocity
 * - Accelerometer magnitude ≈ gravity (9.81 m/s²) + small noise
 * - Gyroscope magnitude ≈ 0 (no rotation)
 *
 * This module provides:
 * 1. Per-foot contact detection
 * 2. Gait phase estimation (stance/swing)
 * 3. Ground contact events for external systems
 *
 * Industry Reference: Xsens MVN HD uses similar approach for foot contact
 *
 * @module skeleton/FootContactDetector
 */

// No THREE import needed - pure TypeScript module

// ============================================================================
// TYPES
// ============================================================================

export interface FootContactState {
  /** True if foot is in contact with ground (stance phase) */
  isGrounded: boolean;
  /** Confidence of contact detection (0-1) */
  confidence: number;
  /** Time since last contact event (ms) */
  timeSinceLastContact: number;
  /** Time since last liftoff event (ms) */
  timeSinceLastLiftoff: number;
}

export interface FootContactEvent {
  foot: "left" | "right";
  type: "contact" | "liftoff";
  timestamp: number;
  confidence: number;
}

export interface ZUPTConfig {
  /** Accelerometer magnitude threshold relative to gravity (ratio) */
  accelThreshold: number;
  /** Gyroscope magnitude threshold (rad/s) */
  gyroThreshold: number;
  /** Minimum duration to confirm contact (ms) */
  minContactDuration: number;
  /** Minimum duration to confirm liftoff (ms) */
  minLiftoffDuration: number;
  /** Smoothing factor for state transitions (0-1) */
  smoothingFactor: number;
}

const DEFAULT_CONFIG: ZUPTConfig = {
  accelThreshold: 0.15, // 15% deviation from gravity
  gyroThreshold: 0.5, // rad/s - fairly permissive for walking
  minContactDuration: 30, // ms - quick detection
  minLiftoffDuration: 50, // ms - slightly slower to prevent jitter
  smoothingFactor: 0.3,
};

// ============================================================================
// FOOT CONTACT DETECTOR CLASS
// ============================================================================

export class FootContactDetector {
  private config: ZUPTConfig;

  // Per-foot state
  private leftFootState: FootContactState;
  private rightFootState: FootContactState;

  // Transition tracking
  private leftTransitionStart: number | null = null;
  private rightTransitionStart: number | null = null;
  private leftPendingState: boolean = false;
  private rightPendingState: boolean = false;

  // Event listeners
  private eventListeners: Array<(event: FootContactEvent) => void> = [];

  // Debug
  private debugEnabled: boolean = false;
  private frameCounter: number = 0;

  constructor(config: Partial<ZUPTConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.leftFootState = this.getInitialState();
    this.rightFootState = this.getInitialState();
  }

  private getInitialState(): FootContactState {
    return {
      isGrounded: true, // Assume starting on ground
      confidence: 0.5,
      timeSinceLastContact: 0,
      timeSinceLastLiftoff: Infinity,
    };
  }

  /**
   * Process foot sensor data and update contact state.
   *
   * @param foot - Which foot (left/right)
   * @param accelData - Accelerometer [x, y, z] in m/s² (sensor frame)
   * @param gyroData - Gyroscope [x, y, z] in rad/s
   * @param deltaTime - Time since last update (seconds)
   * @returns Updated contact state
   */
  processFootSensor(
    foot: "left" | "right",
    accelData: [number, number, number],
    gyroData: [number, number, number],
    deltaTime: number,
    isExternalStationary?: boolean, // NEW: Trust The Edge
  ): FootContactState {
    const {
      accelThreshold,
      gyroThreshold,
      minContactDuration,
      minLiftoffDuration,
    } = this.config;

    const state = foot === "left" ? this.leftFootState : this.rightFootState;
    const now = Date.now();

    // Compute accelerometer magnitude
    const accelMag = Math.sqrt(
      accelData[0] ** 2 + accelData[1] ** 2 + accelData[2] ** 2,
    );
    const accelDeviation = Math.abs(accelMag - 9.81) / 9.81;

    // Compute gyroscope magnitude
    const gyroMag = Math.sqrt(
      gyroData[0] ** 2 + gyroData[1] ** 2 + gyroData[2] ** 2,
    );

    let sensorIndicatesContact = false;

    if (isExternalStationary !== undefined) {
      // TRUST THE EDGE: If firmware/upstream says it's stationary, we believe it.
      sensorIndicatesContact = isExternalStationary;
    } else {
      // FALLBACK: Client-side variance check
      const accelIsStatic = accelDeviation < accelThreshold;
      const gyroIsStatic = gyroMag < gyroThreshold;
      sensorIndicatesContact = accelIsStatic && gyroIsStatic;
    }

    // Compute confidence based on how clearly the criteria are met
    // More margin = higher confidence
    const accelMargin = Math.max(0, 1 - accelDeviation / accelThreshold);
    const gyroMargin = Math.max(0, 1 - gyroMag / gyroThreshold);
    const newConfidence = (accelMargin + gyroMargin) / 2;

    // Update confidence with smoothing
    state.confidence =
      state.confidence +
      (newConfidence - state.confidence) * this.config.smoothingFactor;

    // State transition logic with hysteresis
    const pendingState =
      foot === "left" ? this.leftPendingState : this.rightPendingState;
    const transitionStart =
      foot === "left" ? this.leftTransitionStart : this.rightTransitionStart;

    if (sensorIndicatesContact !== pendingState) {
      // New potential transition
      if (foot === "left") {
        this.leftPendingState = sensorIndicatesContact;
        this.leftTransitionStart = now;
      } else {
        this.rightPendingState = sensorIndicatesContact;
        this.rightTransitionStart = now;
      }
    } else if (sensorIndicatesContact === pendingState && transitionStart) {
      // Check if transition has been sustained long enough
      const transitionDuration = now - transitionStart;
      const requiredDuration = sensorIndicatesContact
        ? minContactDuration
        : minLiftoffDuration;

      if (
        transitionDuration >= requiredDuration &&
        state.isGrounded !== sensorIndicatesContact
      ) {
        // Confirm state change
        const wasGrounded = state.isGrounded;
        state.isGrounded = sensorIndicatesContact;

        // Fire event
        const event: FootContactEvent = {
          foot,
          type: sensorIndicatesContact ? "contact" : "liftoff",
          timestamp: now,
          confidence: state.confidence,
        };
        this.fireEvent(event);

        // Debug log state transition
        if (this.debugEnabled) {
          // Removed: per-transition log spam
        }

        // Update timing
        if (sensorIndicatesContact) {
          state.timeSinceLastContact = 0;
        } else {
          state.timeSinceLastLiftoff = 0;
        }

        // Reset transition tracker
        if (foot === "left") {
          this.leftTransitionStart = null;
        } else {
          this.rightTransitionStart = null;
        }
      }
    }

    // Update timing
    const deltaMs = deltaTime * 1000;
    if (state.isGrounded) {
      state.timeSinceLastLiftoff += deltaMs;
    } else {
      state.timeSinceLastContact += deltaMs;
    }

    // Debug logging removed (per-frame spam)

    return state;
  }

  /**
   * Get current state for a foot
   */
  getState(foot: "left" | "right"): FootContactState {
    return foot === "left"
      ? { ...this.leftFootState }
      : { ...this.rightFootState };
  }

  /**
   * Check if any foot is grounded
   */
  isAnyFootGrounded(): boolean {
    return this.leftFootState.isGrounded || this.rightFootState.isGrounded;
  }

  /**
   * Get the grounded foot(s)
   */
  getGroundedFoot(): "left" | "right" | "both" | "none" {
    const leftGrounded = this.leftFootState.isGrounded;
    const rightGrounded = this.rightFootState.isGrounded;

    if (leftGrounded && rightGrounded) return "both";
    if (leftGrounded) return "left";
    if (rightGrounded) return "right";
    return "none";
  }

  /**
   * Register event listener
   */
  addEventListener(listener: (event: FootContactEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: (event: FootContactEvent) => void): void {
    const idx = this.eventListeners.indexOf(listener);
    if (idx >= 0) this.eventListeners.splice(idx, 1);
  }

  private fireEvent(event: FootContactEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("[ZUPT] Event listener error:", e);
      }
    }
  }

  /**
   * Enable/disable debug logging
   */
  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.leftFootState = this.getInitialState();
    this.rightFootState = this.getInitialState();
    this.leftTransitionStart = null;
    this.rightTransitionStart = null;
    this.leftPendingState = false;
    this.rightPendingState = false;
  }

  /**
   * Update configuration at runtime
   */
  setConfig(config: Partial<ZUPTConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const footContactDetector = new FootContactDetector();

// Expose to window for debugging (development only)
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).footContactDetector =
    footContactDetector;
}
