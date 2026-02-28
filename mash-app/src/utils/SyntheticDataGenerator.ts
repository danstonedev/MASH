import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { RecordingSession, RecordedFrame } from "../lib/db";
import { SEGMENT_TO_BONE } from "../biomech/boneMapping";
import { BODY_TEMPLATES } from "../biomech/bodyTemplates";
import { threeQuatToFirmware, GRAVITY_GLOBAL } from "../lib/math/conventions";

/**
 * Synthetic Data Generator
 * ========================
 *
 * Derives "perfect" IMU data by simulating a GLB animation frame-by-frame.
 * This ensures the 3D model in the app matches the data 1:1.
 */
export class SyntheticDataGenerator {
  private loader = new GLTFLoader();
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private boneMap: Map<string, THREE.Bone> = new Map();

  /**
   * Load the base neutral model to get the skeleton
   */
  async loadModel(url: string = "/models/Neutral_Model.glb"): Promise<void> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          // Clone the scene to ensure isolated instance
          const model = SkeletonUtils.clone(gltf.scene) as THREE.Object3D;
          this.model = model;

          // Find all bones
          model.traverse((obj) => {
            if (obj instanceof THREE.Bone) {
              this.boneMap.set(obj.name, obj);
            }
          });

          // Setup mixer
          this.mixer = new THREE.AnimationMixer(model);
          resolve();
        },
        undefined,
        reject,
      );
    });
  }

  /**
   * Generate a session from an animation file
   */
  async generateSession(
    animationUrl: string,
    sessionName: string,
    onProgress?: (progress: number) => void,
  ): Promise<{ session: RecordingSession; frames: RecordedFrame[] }> {
    if (!this.model || !this.mixer) {
      throw new Error("Model not loaded. Call loadModel() first.");
    }

    // 1. Load Animation Clip
    const clip = await this.loadAnimationClip(animationUrl);

    // 2. Prepare Simulation
    const action = this.mixer.clipAction(clip);
    action.reset().play();

    // 3. Simulation Parameters
    const fps = 60;
    const dt = 1 / fps;
    const duration = clip.duration;
    const totalFrames = Math.floor(duration * fps);
    const sensorMapping = this.getFullBodyMapping();
    const frames: RecordedFrame[] = [];

    // State tracking for physics (SensorID -> State)
    interface SensorState {
      prevPos: THREE.Vector3;
      prevVel: THREE.Vector3; // For acceleration
      prevQuat: THREE.Quaternion; // For gyroscope
    }
    const states = new Map<number, SensorState>();

    // Initialize states at t=0
    this.mixer.setTime(0);
    this.model.updateMatrixWorld(true);

    Object.entries(sensorMapping).forEach(([idStr, segment]) => {
      const id = parseInt(idStr);
      const boneName = SEGMENT_TO_BONE[segment];
      const bone = this.boneMap.get(boneName);
      if (!bone) return;

      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      bone.getWorldPosition(worldPos);
      bone.getWorldQuaternion(worldQuat);

      states.set(id, {
        prevPos: worldPos.clone(),
        prevVel: new THREE.Vector3(0, 0, 0), // Assume rest initially? Or calculate from first few frames?
        // Actually, best to step once to get velocity?
        // We'll handle first frame derivative gracefully (0).
        prevQuat: worldQuat.clone(),
      });
    });

    // 4. Run Simulation Loop
    for (let i = 0; i < totalFrames; i++) {
      const time = i * dt;
      const systemTime = Date.now() + time * 1000; // Simulated wall clock

      // Step Animation
      this.mixer.setTime(time);
      // Force update world matrices
      this.model.updateMatrixWorld(true);

      // Report progress
      if (onProgress && i % 10 === 0) {
        onProgress(i / totalFrames);
      }

      // Capture data for each sensor
      Object.entries(sensorMapping).forEach(([idStr, segment]) => {
        const id = parseInt(idStr);
        const boneName = SEGMENT_TO_BONE[segment];
        const bone = this.boneMap.get(boneName);
        if (!bone) return;

        const state = states.get(id)!;

        // Current Kinematics (World Frame)
        const currPos = new THREE.Vector3();
        const currQuat = new THREE.Quaternion();
        bone.getWorldPosition(currPos);
        bone.getWorldQuaternion(currQuat);

        // --- Gyroscope Calculation (rad/s) ---
        // dq = q_prev_inv * q_curr
        // axis * angle = 2 * log(dq)
        const qDiff = state.prevQuat.clone().invert().multiply(currQuat);

        // Extract angle and axis from qDiff
        // q = [cos(a/2), sin(a/2)*x, sin(a/2)*y, sin(a/2)*z]
        // 2 * acos(w) gives angle.
        const halfAngle = Math.acos(Math.min(Math.max(qDiff.w, -1), 1));
        const angle = 2 * halfAngle;
        const sinHalfAngle = Math.sin(halfAngle);

        const axis = new THREE.Vector3(qDiff.x, qDiff.y, qDiff.z);
        if (sinHalfAngle > 1e-6) {
          axis.divideScalar(sinHalfAngle);
        } else {
          axis.set(1, 0, 0); // Check degenerate case
        }

        // Angular velocity in Body Frame (because qDiff is local rotation step)
        // omega_body = axis * (angle / dt)
        const gyroVec = axis.clone().multiplyScalar(angle / dt);

        // --- Accelerometer Calculation (m/s²) ---
        // a_kinematic = (v_curr - v_prev) / dt
        // v_curr = (pos_curr - pos_prev) / dt

        const velocity = currPos.clone().sub(state.prevPos).divideScalar(dt);
        const accelKinematic = velocity
          .clone()
          .sub(state.prevVel)
          .divideScalar(dt);

        // Accelerometer measures: a_kinematic - gravity
        // In World Frame: a_meas_world = a_kinematic - (0, -9.81, 0)
        const accelMeasWorld = accelKinematic.clone().sub(GRAVITY_GLOBAL);

        // Transform to Sensor Frame (Body Frame)
        // a_body = R_world_body * a_meas_world
        // a_body = q_curr_inv * a_meas_world
        const accelVec = accelMeasWorld
          .clone()
          .applyQuaternion(currQuat.clone().invert());

        // --- Frame Construction ---
        // Convert to Firmware Conventions
        // Gyro: Firmware is rad/s.
        // Accel: Firmware is m/s².

        // Ensure array format for DB
        const frame: RecordedFrame = {
          sessionId: "pending", // Will be overwritten
          sensorId: id,
          systemTime: systemTime,
          timestamp: i * (1000 / fps),
          // Convert World Quat -> Sensor Convention [w, x, y, z]
          quaternion: threeQuatToFirmware(currQuat),
          accelerometer: [accelVec.x, accelVec.y, accelVec.z],
          gyro: [gyroVec.x, gyroVec.y, gyroVec.z],
          battery: 100,
        };
        frames.push(frame);

        // Update State
        state.prevPos.copy(currPos);
        state.prevVel.copy(velocity);
        state.prevQuat.copy(currQuat);
      });
    }

    action.stop();

    // 5. Build Session Object
    const sessionId = `syn-${sessionName.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).substring(2, 9)}`;
    frames.forEach((f) => (f.sessionId = sessionId));

    const session: RecordingSession = {
      id: sessionId,
      name: `Synthetic: ${sessionName}`,
      startTime: Date.now(),
      endTime: Date.now() + duration * 1000,
      sensorCount: Object.keys(sensorMapping).length,
      sensorMapping: sensorMapping,
      notes: `Synthetic session from ${animationUrl}`,
      tags: ["synthetic"],
    };

    return { session, frames };
  }

  private async loadAnimationClip(url: string): Promise<THREE.AnimationClip> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          if (gltf.animations && gltf.animations.length > 0) {
            resolve(gltf.animations[0]);
          } else {
            reject(new Error(`No animations found in ${url}`));
          }
        },
        undefined,
        reject,
      );
    });
  }

  private getFullBodyMapping(): Record<number, string> {
    const mapping: Record<number, string> = {};
    const segments = BODY_TEMPLATES.full_body.segments;
    segments.forEach((segment, index) => {
      mapping[index + 1] = segment;
    });
    return mapping;
  }
}
