/**
 * Distance Tracker
 * ================
 *
 * Estimates travel distance from IMU data.
 *
 * Methods:
 * 1. Step-based: Count steps × estimated stride length
 * 2. Integration-based: Double integrate acceleration (with drift correction)
 * 3. Stride-based: Use detected gait strides × stride length
 *
 * Most reliable: Step counting with calibrated stride length
 */

import * as THREE from "three";
import {
  useDeviceRegistry,
  deviceAccelCache,
} from "../store/useDeviceRegistry";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";

// ============================================================================
// TYPES
// ============================================================================

export interface DistanceMetrics {
  // Total distance
  totalDistance: number; // meters

  // By method
  stepBasedDistance: number; // meters (from step count)
  strideBasedDistance: number; // meters (from gait analysis)

  // Step tracking
  stepCount: number;
  estimatedStrideLength: number; // meters

  // Speed
  currentSpeed: number; // m/s (smoothed)
  averageSpeed: number; // m/s (session average)
  maxSpeed: number; // m/s (peak)

  // Pace (for running/walking)
  currentPace: number; // min/km
}

export interface SpeedSample {
  timestamp: number;
  speed: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Default stride lengths (can be calibrated)
const DEFAULT_WALK_STRIDE_M = 0.75; // 75cm average walking stride
const DEFAULT_RUN_STRIDE_M = 1.2; // 120cm average running stride
const DEFAULT_SKATE_STRIDE_M = 2.0; // 200cm skating stride

// Step detection
const STEP_ACCEL_THRESHOLD = 11; // m/s² - acceleration peak for step
const MIN_STEP_INTERVAL_MS = 250; // Minimum time between steps
const MAX_STEP_INTERVAL_MS = 1500; // Maximum time between steps

// Speed smoothing
const SPEED_ALPHA = 0.2; // Exponential smoothing factor

// Buffer size
const ACCEL_BUFFER_SIZE = 60; // 1 second

// ============================================================================
// DISTANCE TRACKER CLASS
// ============================================================================

export class DistanceTracker {
  // Buffers
  private accelBuffer: number[] = [];

  // Step tracking
  private stepCount = 0;
  private lastStepTime = 0;
  private wasAboveThreshold = false;

  // Distance
  private stepBasedDistance = 0;
  private strideBasedDistance = 0;

  // Stride length (can be calibrated per user)
  private strideLength = DEFAULT_WALK_STRIDE_M;
  private activityType: "walk" | "run" | "skate" = "walk";

  // Speed tracking
  private speedSamples: SpeedSample[] = [];
  private currentSpeed = 0;
  private maxSpeed = 0;
  private totalTime = 0;
  private startTime = 0;

  // Velocity integration (experimental)
  private integratedVelocity = new THREE.Vector3();
  private integratedDistance = 0;

  // Callbacks
  private onStepDetected: ((count: number) => void) | null = null;

  /**
   * Reset tracker
   */
  reset(): void {
    this.accelBuffer = [];
    this.stepCount = 0;
    this.lastStepTime = 0;
    this.wasAboveThreshold = false;
    this.stepBasedDistance = 0;
    this.strideBasedDistance = 0;
    this.speedSamples = [];
    this.currentSpeed = 0;
    this.maxSpeed = 0;
    this.totalTime = 0;
    this.startTime = performance.now();
    this.integratedVelocity.set(0, 0, 0);
    this.integratedDistance = 0;
  }

  /**
   * Set activity type (adjusts stride length)
   */
  setActivityType(type: "walk" | "run" | "skate"): void {
    this.activityType = type;
    switch (type) {
      case "walk":
        this.strideLength = DEFAULT_WALK_STRIDE_M;
        break;
      case "run":
        this.strideLength = DEFAULT_RUN_STRIDE_M;
        break;
      case "skate":
        this.strideLength = DEFAULT_SKATE_STRIDE_M;
        break;
    }
  }

  /**
   * Calibrate stride length (user walks known distance)
   */
  calibrateStrideLength(knownDistanceM: number, stepsTaken: number): void {
    if (stepsTaken > 0) {
      this.strideLength = knownDistanceM / stepsTaken;
      console.debug(
        `[DistanceTracker] Calibrated stride: ${(this.strideLength * 100).toFixed(0)}cm`,
      );
    }
  }

  /**
   * Set callback for step detection
   */
  setOnStepDetected(callback: (count: number) => void): void {
    this.onStepDetected = callback;
  }

  /**
   * Add a stride from gait analyzer
   */
  addStride(lengthM: number): void {
    this.strideBasedDistance += lengthM;
  }

  /**
   * Process a frame
   */
  processFrame(deltaTime: number): boolean {
    const now = performance.now();

    // Update total time
    if (this.startTime === 0) {
      this.startTime = now;
    }
    this.totalTime = (now - this.startTime) / 1000;

    // Collect sensor data
    this.collectSensorData();

    if (this.accelBuffer.length < 3) return false;

    // Get current acceleration magnitude
    const currentMag = this.accelBuffer[this.accelBuffer.length - 1];

    // Step detection using peak detection
    let stepDetected = false;

    if (currentMag > STEP_ACCEL_THRESHOLD) {
      if (!this.wasAboveThreshold) {
        const timeSinceLastStep = now - this.lastStepTime;

        if (
          timeSinceLastStep >= MIN_STEP_INTERVAL_MS &&
          timeSinceLastStep <= MAX_STEP_INTERVAL_MS
        ) {
          // Valid step
          this.stepCount++;
          this.stepBasedDistance = this.stepCount * this.strideLength;
          this.lastStepTime = now;
          stepDetected = true;

          // Calculate speed from step frequency
          const stepFrequency = 1000 / timeSinceLastStep;
          const instantSpeed = stepFrequency * this.strideLength;

          // Smooth speed
          this.currentSpeed =
            SPEED_ALPHA * instantSpeed + (1 - SPEED_ALPHA) * this.currentSpeed;

          if (this.currentSpeed > this.maxSpeed) {
            this.maxSpeed = this.currentSpeed;
          }

          // Record sample
          this.speedSamples.push({ timestamp: now, speed: this.currentSpeed });

          // Trim old samples (keep 60 seconds)
          while (
            this.speedSamples.length > 0 &&
            now - this.speedSamples[0].timestamp > 60000
          ) {
            this.speedSamples.shift();
          }

          if (this.onStepDetected) {
            this.onStepDetected(this.stepCount);
          }
        } else if (this.lastStepTime === 0) {
          // First step
          this.lastStepTime = now;
        }
      }
      this.wasAboveThreshold = true;
    } else {
      this.wasAboveThreshold = false;
    }

    return stepDetected;
  }

  /**
   * Get current metrics
   */
  getMetrics(): DistanceMetrics {
    // Calculate average speed
    let avgSpeed = 0;
    if (this.totalTime > 0 && this.stepBasedDistance > 0) {
      avgSpeed = this.stepBasedDistance / this.totalTime;
    }

    // Calculate pace (min/km)
    let pace = 0;
    if (this.currentSpeed > 0) {
      pace = 1000 / this.currentSpeed / 60; // min per km
    }

    return {
      totalDistance: Math.max(this.stepBasedDistance, this.strideBasedDistance),
      stepBasedDistance: this.stepBasedDistance,
      strideBasedDistance: this.strideBasedDistance,
      stepCount: this.stepCount,
      estimatedStrideLength: this.strideLength,
      currentSpeed: this.currentSpeed,
      averageSpeed: avgSpeed,
      maxSpeed: this.maxSpeed,
      currentPace: pace,
    };
  }

  /**
   * Get speed history
   */
  getSpeedHistory(): SpeedSample[] {
    return [...this.speedSamples];
  }

  /**
   * Collect sensor data
   */
  private collectSensorData(): void {
    const playbackState = usePlaybackStore.getState();
    const isPlayback = playbackState.sessionId !== null;

    if (isPlayback) {
      for (const sensorId of playbackState.sensorIds) {
        const frame = playbackState.getFrameAtTime(sensorId);
        if (frame && frame.accelerometer) {
          this.addSample(new THREE.Vector3(...frame.accelerometer).length());
          break;
        }
      }
    } else {
      // Live - prefer pelvis/foot
      const devices = useDeviceRegistry.getState().devices;
      const { getSegmentForSensor } = useSensorAssignmentStore.getState();
      for (const [id, device] of devices) {
        const segment = getSegmentForSensor(device.id)?.toUpperCase() || "";
        if (
          segment === "PELVIS" ||
          segment.includes("FOOT") ||
          segment.includes("SKATE")
        ) {
          const accel = deviceAccelCache.get(id) || device.accelerometer;
          if (accel) {
            this.addSample(new THREE.Vector3(...accel).length());
            break;
          }
        }
      }
    }
  }

  /**
   * Add sample to buffer
   */
  private addSample(mag: number): void {
    this.accelBuffer.push(mag);
    while (this.accelBuffer.length > ACCEL_BUFFER_SIZE) {
      this.accelBuffer.shift();
    }
  }
}

// Singleton
export const distanceTracker = new DistanceTracker();
