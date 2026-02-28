/**
 * Center of Gravity (CoG) Tracker
 * ================================
 *
 * Simplified pelvis-based CoG estimation for balance and movement analysis.
 *
 * Method: The pelvis orientation is used to estimate body lean, which projects
 * to ground plane position. This is a first-order approximation that works
 * well for standing and walking analysis.
 *
 * Outputs:
 * - Lateral sway (left-right)
 * - Anterior-posterior sway (forward-back)
 * - Sway velocity
 * - Sway area (ellipse)
 */

import * as THREE from "three";
import {
  useDeviceRegistry,
  deviceQuaternionCache,
} from "../store/useDeviceRegistry";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { firmwareToThreeQuat } from "../lib/math/conventions";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";

// ============================================================================
// TYPES
// ============================================================================

export interface CoGState {
  // Position relative to neutral standing (in cm)
  lateral: number; // + = right, - = left
  anteriorPosterior: number; // + = forward, - = backward

  // Velocity (cm/s)
  lateralVelocity: number;
  apVelocity: number;

  // Derived metrics
  swayMagnitude: number; // Distance from center (cm)
  swayAngle: number; // Angle in degrees (0 = forward)

  // Time-based metrics (computed over window)
  swayArea: number; // Ellipse area (cm²)
  swayPath: number; // Total path length (cm)
  meanFrequency: number; // Dominant sway frequency (Hz)
}

export interface CoGSample {
  timestamp: number;
  lateral: number;
  ap: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Approximate height from pelvis to ground (cm)
// This affects the magnitude of sway - can be calibrated per user
const PELVIS_HEIGHT_CM = 100;

// Buffer for sway analysis (seconds at 60Hz)
const SAMPLE_BUFFER_SIZE = 300; // 5 seconds

// Smoothing factor for velocity calculation
const VELOCITY_ALPHA = 0.3;

// ============================================================================
// COG TRACKER CLASS
// ============================================================================

export class CoGTracker {
  private sampleBuffer: CoGSample[] = [];
  private lastState: CoGState | null = null;
  private lastTimestamp = 0;
  private lastLateral = 0;
  private lastAP = 0;
  private smoothedLateralVelocity = 0;
  private smoothedAPVelocity = 0;

  // Neutral reference (captured at calibration)
  private neutralQuat: THREE.Quaternion | null = null;
  private isTracking = false;

  /**
   * Start tracking CoG
   */
  start(): void {
    this.isTracking = true;
    this.sampleBuffer = [];
    this.lastTimestamp = performance.now();
    console.debug("[CoGTracker] Started tracking");
  }

  /**
   * Stop tracking
   */
  stop(): void {
    this.isTracking = false;
    console.debug("[CoGTracker] Stopped tracking");
  }

  /**
   * Capture current pelvis orientation as neutral reference
   */
  captureNeutral(): boolean {
    const pelvisQuat = this.getPelvisQuaternion();
    if (pelvisQuat) {
      this.neutralQuat = pelvisQuat.clone();
      console.debug("[CoGTracker] Captured neutral reference");
      return true;
    }
    console.warn("[CoGTracker] No pelvis data available for neutral capture");
    return false;
  }

  /**
   * Reset tracker state
   */
  reset(): void {
    this.sampleBuffer = [];
    this.lastState = null;
    this.neutralQuat = null;
    this.smoothedLateralVelocity = 0;
    this.smoothedAPVelocity = 0;
  }

  /**
   * Process a frame and compute CoG state
   */
  processFrame(): CoGState | null {
    if (!this.isTracking) return this.lastState;

    const pelvisQuat = this.getPelvisQuaternion();
    if (!pelvisQuat) return this.lastState;

    const now = performance.now();
    const deltaTime = (now - this.lastTimestamp) / 1000;
    this.lastTimestamp = now;

    // Use neutral reference or identity
    const reference = this.neutralQuat || new THREE.Quaternion();

    // Compute relative rotation from neutral
    const relativeQuat = pelvisQuat
      .clone()
      .multiply(reference.clone().invert());

    // Extract tilt angles from quaternion
    // Roll = lateral tilt (around Z-axis in our convention)
    // Pitch = forward/back tilt (around X-axis)
    const euler = new THREE.Euler().setFromQuaternion(relativeQuat, "XYZ");

    // Convert tilt angles to ground displacement
    // Using small angle approximation: displacement ≈ height × tan(angle) ≈ height × angle
    const lateral = Math.sin(euler.z) * PELVIS_HEIGHT_CM; // Roll → lateral
    const anteriorPosterior = Math.sin(euler.x) * PELVIS_HEIGHT_CM; // Pitch → A/P

    // Calculate velocity with smoothing
    if (deltaTime > 0 && deltaTime < 0.1) {
      const rawLateralVel = (lateral - this.lastLateral) / deltaTime;
      const rawAPVel = (anteriorPosterior - this.lastAP) / deltaTime;

      this.smoothedLateralVelocity =
        VELOCITY_ALPHA * rawLateralVel +
        (1 - VELOCITY_ALPHA) * this.smoothedLateralVelocity;
      this.smoothedAPVelocity =
        VELOCITY_ALPHA * rawAPVel +
        (1 - VELOCITY_ALPHA) * this.smoothedAPVelocity;
    }

    this.lastLateral = lateral;
    this.lastAP = anteriorPosterior;

    // Add sample to buffer
    this.sampleBuffer.push({
      timestamp: now,
      lateral,
      ap: anteriorPosterior,
    });

    // Trim buffer to size
    while (this.sampleBuffer.length > SAMPLE_BUFFER_SIZE) {
      this.sampleBuffer.shift();
    }

    // Compute derived metrics
    const swayMagnitude = Math.sqrt(
      lateral * lateral + anteriorPosterior * anteriorPosterior,
    );
    const swayAngle = Math.atan2(lateral, anteriorPosterior) * (180 / Math.PI);

    // Compute time-based metrics from buffer
    const { area, pathLength } = this.computeSwayMetrics();

    const state: CoGState = {
      lateral,
      anteriorPosterior,
      lateralVelocity: this.smoothedLateralVelocity,
      apVelocity: this.smoothedAPVelocity,
      swayMagnitude,
      swayAngle,
      swayArea: area,
      swayPath: pathLength,
      meanFrequency: 0, // TODO: implement FFT for frequency
    };

    this.lastState = state;
    return state;
  }

  /**
   * Get current state without processing
   */
  getState(): CoGState | null {
    return this.lastState;
  }

  /**
   * Get sample buffer for visualization
   */
  getSampleBuffer(): CoGSample[] {
    return [...this.sampleBuffer];
  }

  /**
   * Get pelvis quaternion from live sensors or playback
   */
  private getPelvisQuaternion(): THREE.Quaternion | null {
    const playbackState = usePlaybackStore.getState();
    const isPlayback = playbackState.sessionId !== null;

    if (isPlayback) {
      // Playback mode - find pelvis sensor
      for (const sensorId of playbackState.sensorIds) {
        const frame = playbackState.getFrameAtTime(sensorId);
        if (frame) {
          // TODO: Need segment assignment in recorded data
          // For now, use first sensor as pelvis proxy
          return firmwareToThreeQuat(frame.quaternion);
        }
      }
      return null;
    }

    // Live mode - find pelvis sensor
    const devices = useDeviceRegistry.getState().devices;
    const { getSegmentForSensor } = useSensorAssignmentStore.getState();
    for (const [id, device] of devices) {
      const segment = getSegmentForSensor(device.id)?.toUpperCase();
      if (segment === "PELVIS" || segment === "HIPS") {
        const cached = deviceQuaternionCache.get(id);
        const quatArray = cached || device.quaternion;
        return firmwareToThreeQuat(quatArray);
      }
    }

    return null;
  }

  /**
   * Compute sway area (ellipse) and path length from buffer
   */
  private computeSwayMetrics(): { area: number; pathLength: number } {
    if (this.sampleBuffer.length < 10) {
      return { area: 0, pathLength: 0 };
    }

    // Calculate means
    let sumLat = 0,
      sumAP = 0;
    for (const s of this.sampleBuffer) {
      sumLat += s.lateral;
      sumAP += s.ap;
    }
    const meanLat = sumLat / this.sampleBuffer.length;
    const meanAP = sumAP / this.sampleBuffer.length;

    // Calculate standard deviations (semi-axes of ellipse)
    let sumLatSq = 0,
      sumAPSq = 0;
    let pathLength = 0;
    let prev: CoGSample | null = null;

    for (const s of this.sampleBuffer) {
      sumLatSq += (s.lateral - meanLat) ** 2;
      sumAPSq += (s.ap - meanAP) ** 2;

      if (prev) {
        const dx = s.lateral - prev.lateral;
        const dy = s.ap - prev.ap;
        pathLength += Math.sqrt(dx * dx + dy * dy);
      }
      prev = s;
    }

    const stdLat = Math.sqrt(sumLatSq / this.sampleBuffer.length);
    const stdAP = Math.sqrt(sumAPSq / this.sampleBuffer.length);

    // Ellipse area = π × a × b (using 2× std as semi-axes for 95% confidence)
    const area = Math.PI * (2 * stdLat) * (2 * stdAP);

    return { area, pathLength };
  }
}

// Singleton instance
export const cogTracker = new CoGTracker();
