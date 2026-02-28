/**
 * IMU Simulator: Generates biomechanically accurate IMU data for development.
 *
 * Walking gait cycle based on clinical biomechanics:
 * - Hip: 30° flexion at heel strike → 10° extension at terminal stance
 * - Knee: 0° at heel strike → 15-20° loading response → 60° swing
 * - Ankle: 0° → 20° plantarflex (foot flat) → 10° dorsiflex (toe off)
 *
 * Squat mechanics:
 * - Hip: 0° → 120° flexion
 * - Knee: 0° → 120° flexion
 * - Ankle: 0° → 25° dorsiflexion
 */

import type { SegmentId } from "./segmentRegistry";

export interface SimulatedIMUData {
  segmentId: SegmentId;
  quaternion: [number, number, number, number]; // [w, x, y, z]
  accelerometer: [number, number, number];
  battery: number;
  timestamp: number;
}

interface SimulatorConfig {
  segments: SegmentId[];
  updateRate: number;
  motionPattern: "idle" | "walking" | "squatting" | "custom";
}

type DataCallback = (data: SimulatedIMUData) => void;

// Convert degrees to radians
const deg2rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Gait Cycle Phases (normalized 0-1):
 * 0.00 - Initial Contact (Heel Strike)
 * 0.10 - Loading Response
 * 0.30 - Mid Stance
 * 0.50 - Terminal Stance
 * 0.62 - Pre-Swing
 * 0.75 - Initial/Mid Swing
 * 1.00 - Terminal Swing (back to heel strike)
 */
interface GaitAngles {
  hip: number; // flexion (+) / extension (-)
  knee: number; // flexion (+)
  ankle: number; // dorsiflex (+) / plantarflex (-)
}

/**
 * Get biomechanically accurate joint angles for a given gait phase
 */
function getGaitAngles(phase: number): GaitAngles {
  // Normalize phase to 0-1
  phase = phase % 1;

  let hip: number, knee: number, ankle: number;

  if (phase < 0.1) {
    // Initial Contact → Loading Response
    const t = phase / 0.1;
    hip = 30 - t * 10; // 30° → 20° (still flexed)
    knee = 0 + t * 15; // 0° → 15° (loading flexion)
    ankle = 0 - t * 10; // 0° → -10° (plantarflex to foot flat)
  } else if (phase < 0.3) {
    // Loading Response → Mid Stance
    const t = (phase - 0.1) / 0.2;
    hip = 20 - t * 20; // 20° → 0° (extending)
    knee = 15 - t * 15; // 15° → 0° (extending)
    ankle = -10 + t * 15; // -10° → 5° (dorsiflexing)
  } else if (phase < 0.5) {
    // Mid Stance → Terminal Stance
    const t = (phase - 0.3) / 0.2;
    hip = 0 - t * 10; // 0° → -10° (hyperextension)
    knee = 0 + t * 5; // 0° → 5° (slight flex)
    ankle = 5 + t * 5; // 5° → 10° (max dorsiflex)
  } else if (phase < 0.62) {
    // Terminal Stance → Pre-Swing (Toe Off)
    const t = (phase - 0.5) / 0.12;
    hip = -10 + t * 10; // -10° → 0° (returning)
    knee = 5 + t * 35; // 5° → 40° (rapid flexion)
    ankle = 10 - t * 25; // 10° → -15° (push off plantar)
  } else if (phase < 0.75) {
    // Initial Swing → Mid Swing
    const t = (phase - 0.62) / 0.13;
    hip = 0 + t * 25; // 0° → 25° (flexing forward)
    knee = 40 + t * 20; // 40° → 60° (max flexion)
    ankle = -15 + t * 15; // -15° → 0° (dorsiflexing for clearance)
  } else {
    // Mid Swing → Terminal Swing (prepare for heel strike)
    const t = (phase - 0.75) / 0.25;
    hip = 25 + t * 5; // 25° → 30° (max flex before strike)
    knee = 60 - t * 60; // 60° → 0° (extending)
    ankle = 0; // 0° (neutral for heel strike)
  }

  return { hip, knee, ankle };
}

class IMUSimulatorClass {
  private config: SimulatorConfig | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private callbacks: DataCallback[] = [];
  private startTime: number = 0;
  private batteryLevels: Map<SegmentId, number> = new Map();

  start(config: SimulatorConfig): void {
    this.stop();
    this.config = config;
    this.startTime = Date.now();

    config.segments.forEach((seg) => {
      this.batteryLevels.set(seg, 80 + Math.random() * 20);
    });

    const intervalMs = 1000 / config.updateRate;

    this.intervalId = setInterval(() => {
      this.generateFrame();
    }, intervalMs);

    console.debug(
      `[Simulator] Started with ${config.segments.length} segments at ${config.updateRate}Hz`,
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.config = null;
    console.debug("[Simulator] Stopped");
  }

  subscribe(callback: DataCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  private generateFrame(): void {
    if (!this.config) return;

    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;

    for (const segmentId of this.config.segments) {
      const data = this.generateSegmentData(segmentId, elapsed, now);
      this.callbacks.forEach((cb) => cb(data));
    }
  }

  private generateSegmentData(
    segmentId: SegmentId,
    elapsed: number,
    timestamp: number,
  ): SimulatedIMUData {
    const pattern = this.config?.motionPattern || "idle";
    let quaternion: [number, number, number, number];
    let accelerometer: [number, number, number];

    switch (pattern) {
      case "walking":
        quaternion = this.generateWalkingQuaternion(segmentId, elapsed);
        accelerometer = this.generateWalkingAccel(segmentId, elapsed);
        break;
      case "squatting":
        quaternion = this.generateSquattingQuaternion(segmentId, elapsed);
        accelerometer = [0, 0, 9.81];
        break;
      default:
        quaternion = this.generateIdleQuaternion(segmentId, elapsed);
        accelerometer = [0, 0, 9.81];
    }

    const currentBattery = this.batteryLevels.get(segmentId) || 100;
    this.batteryLevels.set(segmentId, Math.max(0, currentBattery - 0.0001));

    return {
      segmentId,
      quaternion,
      accelerometer,
      battery: Math.round(currentBattery),
      timestamp,
    };
  }

  private generateIdleQuaternion(
    segmentId: SegmentId,
    elapsed: number,
  ): [number, number, number, number] {
    const noise = 0.02;
    const x = Math.sin(elapsed * 0.5 + segmentId.charCodeAt(0)) * noise;
    const y = Math.cos(elapsed * 0.3 + segmentId.charCodeAt(1)) * noise;
    const z = Math.sin(elapsed * 0.4 + segmentId.charCodeAt(2)) * noise;
    const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    return [w, x, y, z];
  }

  /**
   * Biomechanically accurate walking gait
   */
  private generateWalkingQuaternion(
    segmentId: SegmentId,
    elapsed: number,
  ): [number, number, number, number] {
    const cadence = 1.0; // Steps per second (60 steps/min = normal walking)
    const gaitCycleDuration = 1 / cadence; // seconds per full cycle (2 steps)

    const isLeft = segmentId.includes("_l");

    // Left and right legs are 180° out of phase
    const phaseOffset = isLeft ? 0 : 0.5;
    const phase = (elapsed / gaitCycleDuration + phaseOffset) % 1;

    const gait = getGaitAngles(phase);

    let angleRad = 0;
    let axisX = 1,
      axisY = 0,
      axisZ = 0; // Default rotation around X (sagittal plane)

    switch (segmentId) {
      case "pelvis":
        // Pelvis tilts forward/back with gait (~5° each way)
        angleRad = deg2rad(Math.sin(phase * Math.PI * 2) * 3);
        // Also some lateral tilt
        axisZ = Math.sin(phase * Math.PI * 2) * 0.1;
        break;

      case "thigh_l":
      case "thigh_r":
        // Hip flexion/extension
        angleRad = deg2rad(gait.hip);
        break;

      case "tibia_l":
      case "tibia_r":
        // Knee flexion (negative to bend backwards/posterior)
        angleRad = deg2rad(-gait.knee);
        break;

      case "foot_l":
      case "foot_r":
        // Ankle dorsi/plantar flexion
        angleRad = deg2rad(-gait.ankle); // Negative because foot rotates opposite
        break;

      case "torso":
        // Counter-rotation of upper body
        angleRad = deg2rad(Math.sin(phase * Math.PI * 2) * -2);
        axisY = 0.3; // Some twist
        break;

      case "head":
        // Head stays relatively stable (vestibular reflex)
        angleRad = deg2rad(Math.sin(phase * Math.PI * 2) * 1);
        break;

      default:
        angleRad = 0;
    }

    // Convert axis-angle to quaternion
    const halfAngle = angleRad / 2;
    const sinHalf = Math.sin(halfAngle);
    // Normalize axis
    const axisLen = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
    if (axisLen > 0) {
      axisX /= axisLen;
      axisY /= axisLen;
      axisZ /= axisLen;
    }

    return [
      Math.cos(halfAngle),
      axisX * sinHalf,
      axisY * sinHalf,
      axisZ * sinHalf,
    ];
  }

  /**
   * Walking accelerometer with heel strike impact
   */
  private generateWalkingAccel(
    segmentId: SegmentId,
    elapsed: number,
  ): [number, number, number] {
    const cadence = 1.0;
    const gaitCycleDuration = 1 / cadence;

    const isLeft = segmentId.includes("_l");
    const phaseOffset = isLeft ? 0 : 0.5;
    const phase = (elapsed / gaitCycleDuration + phaseOffset) % 1;

    // Heel strike creates impact at phase ~0 and ~0.5
    const impactPhase = phase < 0.1 ? phase / 0.1 : 0;
    const impactMag = Math.exp(-impactPhase * 5) * 3; // Exponential decay

    // Different segments feel different impacts
    let zAccel = 9.81;

    if (segmentId.includes("foot") || segmentId.includes("tibia")) {
      zAccel += impactMag;
    } else if (segmentId.includes("thigh")) {
      zAccel += impactMag * 0.5;
    }

    return [0, 0, zAccel];
  }

  /**
   * Biomechanically accurate deep squat
   */
  private generateSquattingQuaternion(
    segmentId: SegmentId,
    elapsed: number,
  ): [number, number, number, number] {
    const cycleSpeed = 0.4; // Hz (2.5 seconds per squat)
    const phase = (elapsed * cycleSpeed) % 1;

    // Smooth sinusoidal depth: 0 = standing, 1 = full squat
    const depth = (1 - Math.cos(phase * Math.PI * 2)) / 2;

    let angleRad = 0;

    switch (segmentId) {
      case "pelvis":
        // Pelvis tilts forward in squat
        angleRad = deg2rad(depth * 20); // 0° → 20°
        break;

      case "thigh_l":
      case "thigh_r":
        // Hip flexion: 0° → 120°
        angleRad = deg2rad(depth * 120);
        break;

      case "tibia_l":
      case "tibia_r":
        // Knee flexion: 0° → 120° (negative to bend backwards)
        angleRad = deg2rad(-depth * 120);
        break;

      case "foot_l":
      case "foot_r":
        // Ankle dorsiflexion: 0° → 25°
        angleRad = deg2rad(depth * -25); // Negative for dorsiflexion
        break;

      case "torso":
        // Torso leans forward to maintain balance
        angleRad = deg2rad(depth * 30);
        break;

      case "head":
        // Head compensates to look forward
        angleRad = deg2rad(depth * -15);
        break;

      default:
        angleRad = 0;
    }

    const halfAngle = angleRad / 2;
    return [Math.cos(halfAngle), Math.sin(halfAngle), 0, 0];
  }
}

// Singleton instance
export const IMUSimulator = new IMUSimulatorClass();
