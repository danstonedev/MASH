/**
 * ActivityEngine - Real-time Human Activity Recognition
 *
 * Uses a sliding-window approach with statistical feature extraction
 * to classify activities: Idle, Walking, Squatting, Jumping.
 *
 * Pipeline:
 * 1. Push IMU samples into a circular buffer
 * 2. On each window (128 samples @ ~50Hz = ~2.5s), extract features
 * 3. Classify using decision thresholds (expandable to TensorFlow.js)
 * 4. Smooth output via majority voting
 */

import type { IMUDataPacket } from "../ble/DeviceInterface";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const WINDOW_SIZE = 128; // Samples per classification window
const WINDOW_OVERLAP = 0.5; // 50% overlap → classify every 64 samples
const VOTE_HISTORY_SIZE = 5; // Majority voting buffer
const MIN_CONFIDENCE = 0.6; // Minimum confidence to emit activity change

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export type ActivityLabel =
  | "idle"
  | "walking"
  | "squatting"
  | "jumping"
  | "unknown";

export interface ActivityResult {
  activity: ActivityLabel;
  confidence: number;
  features?: FeatureVector; // For debugging/logging
}

interface FeatureVector {
  // Accelerometer magnitude stats
  accelMean: number;
  accelStd: number;
  accelMin: number;
  accelMax: number;
  accelRange: number;
  // Signal Magnitude Area (normalized by window size)
  sma: number;
  // Gyroscope stats (if available)
  gyroMean: number;
  gyroStd: number;
  // Zero-crossing rate for accel Z (step detection)
  zcr: number;
  // Dominant frequency (simple FFT peak, 0 = DC)
  dominantFreqHz: number;
}

type ActivityCallback = (result: ActivityResult) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function magnitude(v: [number, number, number]): number {
  return Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
}

/**
 * Remove gravity from acceleration vector using orientation.
 * Returns linear acceleration (body movement only, no gravity).
 *
 * Formula: a_linear = R^(-1) * (a_sensor - g_world)
 *
 * @param accel - Accelerometer reading [x, y, z] in m/s²
 * @param quat - Orientation quaternion [w, x, y, z] (sensor → world)
 * @returns Linear acceleration [x, y, z] in m/s²
 */
export function removeGravity(
  accel: [number, number, number],
  quat: [number, number, number, number],
): [number, number, number] {
  const GRAVITY = 9.81;
  const [w, x, y, z] = quat;

  // Gravity in world frame (Y-up)
  const gWorld = { x: 0, y: GRAVITY, z: 0 };

  // Rotate gravity to sensor frame using inverse quaternion
  // For unit quaternion, inverse = conjugate = [w, -x, -y, -z]
  const qConj = { w, x: -x, y: -y, z: -z };

  // Apply quaternion rotation: q * v * q^(-1)
  // First, q * v (v as pure quaternion [0, vx, vy, vz])
  const qv = {
    w: -(qConj.x * gWorld.x + qConj.y * gWorld.y + qConj.z * gWorld.z),
    x: qConj.w * gWorld.x + qConj.y * gWorld.z - qConj.z * gWorld.y,
    y: qConj.w * gWorld.y + qConj.z * gWorld.x - qConj.x * gWorld.z,
    z: qConj.w * gWorld.z + qConj.x * gWorld.y - qConj.y * gWorld.x,
  };

  // Then (q * v) * q^(-1) = qv * q (since we used conjugate)
  const gSensor = {
    x: qv.w * -qConj.x + qv.x * qConj.w + qv.y * -qConj.z - qv.z * -qConj.y,
    y: qv.w * -qConj.y + qv.y * qConj.w + qv.z * -qConj.x - qv.x * -qConj.z,
    z: qv.w * -qConj.z + qv.z * qConj.w + qv.x * -qConj.y - qv.y * -qConj.x,
  };

  // Linear acceleration = measured - gravity (in sensor frame)
  return [accel[0] - gSensor.x, accel[1] - gSensor.y, accel[2] - gSensor.z];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[], meanVal?: number): number {
  if (arr.length < 2) return 0;
  const m = meanVal ?? mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function zeroCrossingRate(arr: number[], baseline?: number): number {
  if (arr.length < 2) return 0;
  const b = baseline ?? mean(arr);
  let crossings = 0;
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i - 1] - b) * (arr[i] - b) < 0) crossings++;
  }
  return crossings / (arr.length - 1);
}

/**
 * Simple FFT-based dominant frequency detection.
 * Returns the frequency (in Hz) of the largest magnitude bin.
 * Assumes ~50Hz sample rate.
 */
function dominantFrequency(arr: number[], sampleRateHz: number = 50): number {
  // Simple DFT for small arrays (not optimized, sufficient for 128 samples)
  const N = arr.length;
  if (N < 4) return 0;

  let maxMag = 0;
  let maxBin = 0;

  // Only check first half (Nyquist) and skip DC (bin 0)
  for (let k = 1; k < N / 2; k++) {
    let real = 0,
      imag = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      real += arr[n] * Math.cos(angle);
      imag -= arr[n] * Math.sin(angle);
    }
    const mag = Math.sqrt(real ** 2 + imag ** 2);
    if (mag > maxMag) {
      maxMag = mag;
      maxBin = k;
    }
  }

  // Convert bin to frequency
  return (maxBin * sampleRateHz) / N;
}

// ─────────────────────────────────────────────────────────────────────────────
// ActivityEngine Class
// ─────────────────────────────────────────────────────────────────────────────
class ActivityEngineClass {
  private buffer: IMUDataPacket[] = [];
  private samplesSinceLastClassify = 0;
  private voteHistory: ActivityLabel[] = [];
  private callbacks: ActivityCallback[] = [];

  private currentActivity: ActivityLabel = "unknown";
  private currentConfidence = 0;

  private isRunning = false;

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────
  start(): void {
    this.isRunning = true;
    this.buffer = [];
    this.samplesSinceLastClassify = 0;
    this.voteHistory = [];
    this.currentActivity = "unknown";
    this.currentConfidence = 0;
    console.debug("[ActivityEngine] Started");
  }

  stop(): void {
    this.isRunning = false;
    console.debug("[ActivityEngine] Stopped");
  }

  /**
   * Push a new IMU sample into the engine.
   * Classification runs automatically when enough samples are buffered.
   */
  push(packet: IMUDataPacket): void {
    if (!this.isRunning) return;

    this.buffer.push(packet);
    this.samplesSinceLastClassify++;

    // Maintain circular buffer
    if (this.buffer.length > WINDOW_SIZE) {
      this.buffer.shift();
    }

    // Classify at overlap interval
    const classifyInterval = Math.floor(WINDOW_SIZE * (1 - WINDOW_OVERLAP));
    if (
      this.buffer.length >= WINDOW_SIZE &&
      this.samplesSinceLastClassify >= classifyInterval
    ) {
      this.samplesSinceLastClassify = 0;
      this.classifyWindow();
    }
  }

  subscribe(callback: ActivityCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  getState(): { activity: ActivityLabel; confidence: number } {
    return {
      activity: this.currentActivity,
      confidence: this.currentConfidence,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core Classification
  // ─────────────────────────────────────────────────────────────────────────
  private classifyWindow(): void {
    const features = this.extractFeatures(this.buffer);
    const rawResult = this.classifyFeatures(features);

    // Majority voting for stability
    this.voteHistory.push(rawResult.activity);
    if (this.voteHistory.length > VOTE_HISTORY_SIZE) {
      this.voteHistory.shift();
    }

    const votedActivity = this.majorityVote(this.voteHistory);
    const confidence = rawResult.confidence;

    // Only emit if confidence is high enough or activity changed
    if (
      confidence >= MIN_CONFIDENCE ||
      votedActivity !== this.currentActivity
    ) {
      this.currentActivity = votedActivity;
      this.currentConfidence = confidence;

      const result: ActivityResult = {
        activity: votedActivity,
        confidence,
        features,
      };

      this.callbacks.forEach((cb) => cb(result));
    }
  }

  private extractFeatures(window: IMUDataPacket[]): FeatureVector {
    // Accelerometer magnitude
    const accelMags = window.map((p) => magnitude(p.accelerometer));
    const accelMeanVal = mean(accelMags);
    const accelStdVal = std(accelMags, accelMeanVal);
    const accelMinVal = Math.min(...accelMags);
    const accelMaxVal = Math.max(...accelMags);

    // Signal Magnitude Area (sum of absolute values, normalized)
    let sma = 0;
    for (const p of window) {
      sma +=
        Math.abs(p.accelerometer[0]) +
        Math.abs(p.accelerometer[1]) +
        Math.abs(p.accelerometer[2]);
    }
    sma /= window.length;

    // Gyroscope magnitude (if available)
    const gyroMags = window
      .filter((p) => p.gyro)
      .map((p) => magnitude(p.gyro!));
    const gyroMeanVal = mean(gyroMags);
    const gyroStdVal = std(gyroMags, gyroMeanVal);

    // Zero-crossing rate on vertical (Z) acceleration
    const accelZ = window.map((p) => p.accelerometer[2]);
    const zcrVal = zeroCrossingRate(accelZ);

    // Dominant frequency from accelerometer magnitude
    const domFreq = dominantFrequency(accelMags, 50);

    return {
      accelMean: accelMeanVal,
      accelStd: accelStdVal,
      accelMin: accelMinVal,
      accelMax: accelMaxVal,
      accelRange: accelMaxVal - accelMinVal,
      sma,
      gyroMean: gyroMeanVal,
      gyroStd: gyroStdVal,
      zcr: zcrVal,
      dominantFreqHz: domFreq,
    };
  }

  /**
   * Heuristic classifier based on feature thresholds.
   * These thresholds are tuned for typical IMU dynamics and can be refined.
   */
  private classifyFeatures(f: FeatureVector): ActivityResult {
    let activity: ActivityLabel = "unknown";
    let confidence = 0.5;

    // Gravity-only scenario (accel ~9.8, low variation)
    const gravityMag = 9.81;
    const isStationary =
      Math.abs(f.accelMean - gravityMag) < 1.0 && f.accelStd < 0.5;

    // High-frequency peaks suggest walking (step cadence ~1-2Hz)
    const isWalkingFreq = f.dominantFreqHz >= 0.8 && f.dominantFreqHz <= 2.5;

    // Very low frequency (<0.5Hz) with larger range suggests slow movements like squats
    const isSquattingPattern =
      f.dominantFreqHz < 0.6 && f.accelRange > 2.0 && f.gyroStd > 0.3;

    // High accel peaks (>15 m/s²) suggest jumping
    const isJumpingPattern = f.accelMax > 15 && f.accelRange > 8;

    // Decision tree
    if (isStationary) {
      activity = "idle";
      confidence = 0.9 - f.accelStd; // Higher std = lower confidence
    } else if (isJumpingPattern) {
      activity = "jumping";
      confidence = Math.min(0.95, 0.6 + (f.accelMax - 15) * 0.05);
    } else if (isSquattingPattern) {
      activity = "squatting";
      confidence = 0.7 + f.gyroStd * 0.1;
    } else if (isWalkingFreq && f.zcr > 0.05) {
      activity = "walking";
      confidence = 0.6 + f.zcr * 2; // Higher ZCR = more steps = higher confidence
    } else {
      // Fallback: use SMA to guess
      if (f.sma > 12) {
        activity = "walking";
        confidence = 0.5 + (f.sma - 12) * 0.02;
      } else {
        activity = "idle";
        confidence = 0.5;
      }
    }

    return { activity, confidence: Math.min(1, Math.max(0, confidence)) };
  }

  private majorityVote(history: ActivityLabel[]): ActivityLabel {
    const counts: Record<ActivityLabel, number> = {
      idle: 0,
      walking: 0,
      squatting: 0,
      jumping: 0,
      unknown: 0,
    };

    for (const label of history) {
      counts[label]++;
    }

    let maxCount = 0;
    let winner: ActivityLabel = "unknown";
    for (const [label, count] of Object.entries(counts) as [
      ActivityLabel,
      number,
    ][]) {
      if (count > maxCount) {
        maxCount = count;
        winner = label;
      }
    }

    return winner;
  }
}

// Singleton export
export const ActivityEngine = new ActivityEngineClass();
