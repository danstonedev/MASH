import * as THREE from "three";
import type {
  CalibrationData,
  CalibrationReport,
} from "../store/useCalibrationStore";
import { useCalibrationStore } from "../store/useCalibrationStore";
import {
  useDeviceRegistry,
  deviceGyroCache,
  deviceAccelCache,
  deviceQuaternionCache,
} from "../store/useDeviceRegistry";
import { computeHeadFrame, validateHeadCalibration } from "./HeadAlignment";
import { estimateFunctionalAxis } from "./calibrationMath";
import { firmwareToThreeVec } from "../lib/math/conventions";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";
import { BodyRole } from "../biomech/topology/SensorRoles";
import { useTareStore } from "../store/useTareStore";

// Configuration — Motion-Detected Cervical Calibration (Feb 2026)
// Instead of fixed timers, the system detects user motion and return-to-stillness.
// This gives the user control of pace and captures 3 stationary snapshots.
//
// Flow: Hold still → Nod 3×, hold still → Shake 3×, hold still → Calculate
// Each "hold still" is detected automatically (no countdown timers).
const STATIONARY_GYRO_THRESHOLD = 0.15; // rad/s — below this = "stationary" (~8.5°/s) [relaxed for MEMS noise]
const ROLLING_WINDOW_SIZE = 40; // Samples in rolling window (200ms at 200Hz)
const REQUIRED_STILL_RATIO = 0.85; // 85% of window must be below threshold
const MOTION_DETECT_THRESHOLD = 0.2; // rad/s — above this = "actively moving" (~11°/s) [lowered to catch slow motions]
const MIN_SIGNIFICANT_SAMPLES = 40; // Minimum samples with gyro > 0.1 rad/s before accepting return-to-still
const PCA_CONFIDENCE_THRESHOLD = 0.65; // PCA must exceed this to accept ROM step data
const ROM_SAFETY_TIMEOUT_MS = 10000; // Hard ceiling per ROM step (10s)
const INITIAL_SAFETY_TIMEOUT_MS = 5000; // Hard ceiling for initial hold-still (5s)

// State for data collection
interface CollectionBuffers {
  nodScalars: THREE.Vector3[];
  shakeScalars: THREE.Vector3[];
  tiltScalars: THREE.Vector3[]; // Gyro samples
  startGravity: THREE.Vector3 | null;
  startQuaternion: THREE.Quaternion | null;
  /** Raw gyro [x,y,z] samples accumulated during stationary_start for averaged bias */
  gyroAccumulator: Array<[number, number, number]>;
}

// Motion detection state for ROM steps
type MotionPhase =
  | "waiting_for_motion"
  | "collecting"
  | "waiting_for_stationary";

class CervicalCalibrationManager {
  private buffers: CollectionBuffers = {
    nodScalars: [],
    shakeScalars: [],
    tiltScalars: [],
    startGravity: null,
    startQuaternion: null,
    gyroAccumulator: [],
  };

  private safetyTimer: number | null = null;
  private stepStartTime: number = 0;

  // Explicit head sensor ID — set before start() by the UI sensor picker
  private _headSensorId: string | null = null;

  // Motion detection state
  private motionPhase: MotionPhase = "waiting_for_motion";
  private recentGyroMags: number[] = []; // Rolling window for stationary detection
  private significantMotionCount: number = 0;

  // Step timing for report
  private calStartTime: number = 0;
  private stepTimings: {
    name: string;
    startTime: number;
    endTime: number;
    status: "completed" | "timeout" | "skipped";
  }[] = [];
  private currentStepName: string = "";

  /**
   * Set the sensor to use for head calibration.
   * Must be called before start() when multiple sensors are connected.
   */
  public setHeadSensor(sensorId: string) {
    this._headSensorId = sensorId;
    console.debug(`[CervicalCal] Head sensor set to: ${sensorId}`);
  }

  /**
   * Start the Cervical Calibration Flow
   */
  public start() {
    const store = useCalibrationStore.getState();

    // Reset previous calibration to prevent "stacking" or contortion during new cal
    store.sensorOffsets.delete("head");
    useCalibrationStore.getState().reset(); // Reset general state

    // CRITICAL: Clear stale head tare state from previous calibration.
    // Without this, old mounting/heading/frameAlignment tares persist in memory
    // and localStorage, causing the model to use stale transforms.
    const tareStore = useTareStore.getState();
    const tareStates = new Map(tareStore.tareStates);
    tareStates.delete("head");
    useTareStore.setState({ tareStates });
    console.debug("[CervicalCal] Cleared stale head tare state");

    store.setCervicalStep("stationary_start");
    this.resetBuffers();
    this.resetMotionState();
    this.stepStartTime = Date.now();
    this.calStartTime = Date.now();
    this.stepTimings = [];
    this.currentStepName = "stationary_start";

    console.debug(
      "[CervicalCal] Started. Hold still — detecting stationary...",
    );

    // Safety timeout — if user doesn't settle within 5s, force advance
    this.safetyTimer = window.setTimeout(() => {
      console.warn(
        "[CervicalCal] Safety timeout on stationary_start — forcing advance",
      );
      // Record timeout
      this.stepTimings.push({
        name: "stationary_start",
        startTime: this.stepStartTime,
        endTime: Date.now(),
        status: "timeout",
      });
      this.currentStepName = "";
      this.captureStartGravity();
      this.advanceTo("rom_nod");
    }, INITIAL_SAFETY_TIMEOUT_MS);
  }

  /**
   * Advance to specific step
   */
  public advanceTo(
    step:
      | "rom_nod"
      | "rom_shake"
      | "rom_tilt"
      | "stationary_end"
      | "calculating"
      | "verification",
  ) {
    const store = useCalibrationStore.getState();
    store.setCervicalStep(step);
    // Record previous step timing
    if (this.currentStepName) {
      this.stepTimings.push({
        name: this.currentStepName,
        startTime: this.stepStartTime,
        endTime: Date.now(),
        status: "completed",
      });
    }
    this.currentStepName = step;
    this.stepStartTime = Date.now();
    this.clearTimers();
    this.resetMotionState();
    console.debug(`[CervicalCal] Step: ${step}`);

    if (step === "rom_nod" || step === "rom_shake") {
      // Safety timeout — if user doesn't complete motion + return to still in 10s, force advance
      this.safetyTimer = window.setTimeout(() => {
        const samples =
          step === "rom_nod"
            ? this.buffers.nodScalars.length
            : this.buffers.shakeScalars.length;
        console.warn(
          `[CervicalCal] Safety timeout on ${step} — forcing advance (${samples} samples)`,
        );
        // Record timeout
        this.stepTimings.push({
          name: step,
          startTime: this.stepStartTime,
          endTime: Date.now(),
          status: "timeout",
        });
        this.currentStepName = "";
        this.completeRomStep(step);
      }, ROM_SAFETY_TIMEOUT_MS);
    } else if (step === "calculating") {
      this.calculate();
    }
  }

  /**
   * Cancel / Stop
   */
  public stop() {
    this.clearTimers();
    useCalibrationStore.getState().setCervicalStep("idle");
  }

  /**
   * Complete a ROM step: capture stationary quaternion snapshot, advance to next step.
   */
  private completeRomStep(step: "rom_nod" | "rom_shake") {
    this.clearTimers();

    const elapsed = ((Date.now() - this.stepStartTime) / 1000).toFixed(1);
    const sampleCount =
      step === "rom_nod"
        ? this.buffers.nodScalars.length
        : this.buffers.shakeScalars.length;
    console.debug(
      `[CervicalCal] ${step} complete: ${sampleCount} samples in ${elapsed}s`,
    );

    // Capture stationary quaternion snapshot
    this.captureStationarySnapshot(step);

    if (step === "rom_nod") {
      this.advanceTo("rom_shake");
    } else {
      // Post-shake stationary snapshot IS our boresight → calculate directly (no stationary_end step)
      this.advanceTo("calculating");
    }
  }

  /**
   * Capture a quaternion snapshot at a stationary moment.
   * Post-nod: logged for drift estimation.
   * Post-shake: overwrites startQuaternion for use as boresight reference.
   */
  private captureStationarySnapshot(afterStep: "rom_nod" | "rom_shake") {
    const registry = useDeviceRegistry.getState();
    const headSensorId = this.findHeadSensor(registry);
    if (!headSensorId) return;

    const quat = deviceQuaternionCache.get(headSensorId);
    if (!quat) return;

    const freshQuat = new THREE.Quaternion(quat[1], quat[2], quat[3], quat[0]);

    if (this.buffers.startQuaternion) {
      const delta = this.buffers.startQuaternion
        .clone()
        .invert()
        .multiply(freshQuat.clone());
      const deltaEuler = new THREE.Euler().setFromQuaternion(delta, "XYZ");
      const r2d = (r: number) => ((r * 180) / Math.PI).toFixed(1);
      console.debug(
        `[CervicalCal] Stationary snapshot (post-${afterStep}): ` +
          `delta from start=[${r2d(deltaEuler.x)}°, ${r2d(deltaEuler.y)}°, ${r2d(deltaEuler.z)}°]`,
      );
    }

    if (afterStep === "rom_shake") {
      // Final snapshot → use as boresight reference (most recent neutral pose)
      this.buffers.startQuaternion = freshQuat;
      console.debug(
        "[CervicalCal] Final boresight quaternion captured (post-shake stationary)",
      );
    }
  }

  private clearTimers() {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private resetMotionState() {
    this.motionPhase = "waiting_for_motion";
    this.recentGyroMags = [];
    this.significantMotionCount = 0;
  }

  /**
   * Rolling window stationary check.
   * Unlike the previous consecutive-counter, a single noise spike doesn't
   * reset all progress — we tolerate up to 15% of samples being above threshold.
   */
  private checkStationary(gyroMag: number): boolean {
    return this.checkStationaryWithThreshold(
      gyroMag,
      STATIONARY_GYRO_THRESHOLD,
    );
  }

  /**
   * Rolling window stationary check with configurable threshold.
   * Used with higher threshold during stationary_start when no gyro bias is available.
   */
  private checkStationaryWithThreshold(
    gyroMag: number,
    threshold: number,
  ): boolean {
    this.recentGyroMags.push(gyroMag);
    if (this.recentGyroMags.length > ROLLING_WINDOW_SIZE) {
      this.recentGyroMags.shift();
    }
    if (this.recentGyroMags.length < ROLLING_WINDOW_SIZE) return false;

    const stillCount = this.recentGyroMags.filter((m) => m < threshold).length;
    return stillCount / ROLLING_WINDOW_SIZE >= REQUIRED_STILL_RATIO;
  }

  /**
   * Per-frame update (called from CervicalCalibrationPanel animation loop).
   * Drives motion detection state machine and collects gyro data.
   *
   * Motion detection flow per ROM step:
   *   waiting_for_motion → user starts moving (gyro > 0.3 rad/s)
   *   collecting → accumulating samples, counting significant motion
   *   waiting_for_stationary → enough motion collected, waiting for user to hold still
   *   → stationary confirmed (gyro < 0.08 for 300ms) → PCA check → advance
   */
  public update() {
    const store = useCalibrationStore.getState();
    const step = store.cervicalStep;

    if (step === "idle" || step === "calculating" || step === "verification")
      return;

    const registry = useDeviceRegistry.getState();
    const headSensorId = this.findHeadSensor(registry);
    if (!headSensorId) return;

    const gyro = deviceGyroCache.get(headSensorId);
    if (!gyro) return;

    // CRITICAL: Subtract gyro bias before computing magnitude.
    // deviceGyroCache stores RAW gyro values. The bias is only subtracted
    // for VQF filter input (in useDeviceRegistry L870), NOT in the cache.
    // Without this, MEMS bias (~0.1-0.5 rad/s) keeps gyroMag permanently
    // above the stationary threshold, forcing safety timeout fallback.
    const bias = registry.gyroBias[headSensorId];
    const gx = gyro[0] - (bias?.x ?? 0);
    const gy = gyro[1] - (bias?.y ?? 0);
    const gz = gyro[2] - (bias?.z ?? 0);
    const gyroVec = new THREE.Vector3(gx, gy, gz);
    const gyroMag = gyroVec.length();

    // ─── STATIONARY_START: Detect stillness → capture bias/gravity/quat → advance ───
    // NOTE: During stationary_start, gyro bias may not yet be captured (it's captured
    // in captureStartGravity). For the FIRST calibration session, we use raw values
    // with the rolling window. For subsequent sessions, a previous bias may exist.
    if (step === "stationary_start") {
      // ACCUMULATE raw gyro samples for averaged bias capture.
      // Every frame during stationary_start, store the raw gyro vector.
      // When stationarity is confirmed, we average these for the bias.
      this.buffers.gyroAccumulator.push([gyro[0], gyro[1], gyro[2]]);

      // Always use VARIANCE-based stillness detection during stationary_start,
      // regardless of whether a prior bias exists. A prior bias from a previous
      // session may be stale (MEMS bias shifts with temperature/power cycle),
      // causing magnitude-based detection to never trigger. Variance detection
      // is immune to bias magnitude — it only measures signal stability.
      const rawGyroMag = new THREE.Vector3(gyro[0], gyro[1], gyro[2]).length();
      this.recentGyroMags.push(rawGyroMag);
      if (this.recentGyroMags.length > ROLLING_WINDOW_SIZE) {
        this.recentGyroMags.shift();
      }
      let isStationary = false;
      if (this.recentGyroMags.length >= ROLLING_WINDOW_SIZE) {
        const mean =
          this.recentGyroMags.reduce((a, b) => a + b, 0) /
          this.recentGyroMags.length;
        const variance =
          this.recentGyroMags.reduce((a, b) => a + (b - mean) ** 2, 0) /
          this.recentGyroMags.length;
        const stdDev = Math.sqrt(variance);
        isStationary = stdDev < 0.03; // rad/s — very stable signal at rest regardless of bias
      }
      if (isStationary) {
        this.captureStartGravity();
        this.advanceTo("rom_nod");
      }
      return;
    }

    // ─── ROM_NOD / ROM_SHAKE: Motion detection state machine ───
    if (step === "rom_nod" || step === "rom_shake") {
      // Track significant motion samples (gyro > 0.1 rad/s)
      if (gyroMag > 0.1) {
        this.significantMotionCount++;
      }

      switch (this.motionPhase) {
        case "waiting_for_motion":
          // User hasn't started moving yet — DO NOT collect samples (idle noise pollutes PCA)
          if (gyroMag > MOTION_DETECT_THRESHOLD) {
            this.motionPhase = "collecting";
          }
          break;

        case "collecting":
          // User is actively moving — collect gyro samples for PCA
          if (step === "rom_nod") {
            this.buffers.nodScalars.push(gyroVec);
          } else {
            this.buffers.shakeScalars.push(gyroVec);
          }

          // Wait for enough significant samples before looking for stillness
          if (this.significantMotionCount >= MIN_SIGNIFICANT_SAMPLES) {
            this.motionPhase = "waiting_for_stationary";
          }
          break;

        case "waiting_for_stationary":
          // Still collect samples during deceleration (contains useful axis info)
          if (step === "rom_nod") {
            this.buffers.nodScalars.push(gyroVec);
          } else {
            this.buffers.shakeScalars.push(gyroVec);
          }

          // User has moved enough — detect return to stillness (rolling window)
          if (this.checkStationary(gyroMag)) {
            // Stationary confirmed — advance immediately.
            // PCA quality is evaluated in calculate() and reported to the user.
            // Previously, a PCA quality gate here caused a trap: if PCA was weak,
            // we reset to waiting_for_motion, but the user was already still and
            // never triggered motion again → permanent stuck → safety timeout.
            this.completeRomStep(step);
          }
          break;
      }
    }
  }

  /**
   * Calculate Calibration Result (TWO-LAYER BIOMECHANICAL CALIBRATION)
   *
   * Layer 1: Axis Alignment (R_align) - Maps sensor axes to anatomical axes
   *   - From PCA: which sensor axis is pitch, which is yaw
   *   - Ensures nod → pitch rotation, shake → yaw rotation
   *
   * Layer 2: Boresight - Zeros calibration pose to neutral
   *   - boresight = inverse(q_cal)
   *
   * Combined formula for correct biomechanics:
   *   q_bone = R_align × q_sensor × boresight × inverse(R_align)
   *
   * This is achieved via the TareStore pipeline:
   *   - mountingTare = boresight × inverse(R_align)
   *   - headingTare = inverse(R_align)
   */
  private calculate() {
    useCalibrationStore.getState().setCervicalStep("calculating");

    console.debug("[CervicalCal] Calculating TWO-LAYER calibration...");

    if (!this.buffers.startQuaternion || !this.buffers.startGravity) {
      console.error("[CervicalCal] Missing stationary reference data");
      return;
    }

    // =====================================================================
    // LAYER 1: AXIS ALIGNMENT (from PCA)
    // =====================================================================
    let axisAlignment = new THREE.Quaternion(); // Identity = no axis remapping
    let pcaConfidence = 0.5;

    try {
      const pcaResult = computeHeadFrame(
        this.buffers.nodScalars,
        this.buffers.shakeScalars,
        this.buffers.startGravity,
        this.buffers.startQuaternion || undefined,
      );

      axisAlignment = pcaResult.axisAlignment;
      pcaConfidence = pcaResult.confidence;
    } catch (e) {
      console.warn(
        "[CervicalCal] PCA analysis failed, using identity axis alignment",
      );
    }

    // =====================================================================
    // LAYER 2: BORESIGHT (zeros calibration pose to neutral)
    // =====================================================================
    const boresight = this.buffers.startQuaternion.clone().invert();

    // =====================================================================
    // COMBINED OFFSET FOR PIPELINE - TWO-LAYER IMPLEMENTATION
    // =====================================================================
    //
    // GOAL: Transform sensor data so that:
    //   - At calibration: Model head faces forward (identity)
    //   - Nod (physical pitch) → Model pitch (rotate around X)
    //   - Shake (physical yaw) → Model yaw (rotate around Y)
    //   - Tilt (physical roll) → Model roll (rotate around Z)
    //
    // MATHEMATICAL APPROACH:
    //
    // Let:
    //   q_s = raw sensor quaternion
    //   q_cal = sensor quaternion at calibration (captured during stationary_start)
    //   R = axisAlignment (sensor frame → bone frame, from PCA)
    //
    // We want:
    //   q_world = R × q_s × inv(R) × inv(R × q_cal × inv(R))
    //           = R × q_s × inv(R) × R × inv(q_cal) × inv(R)
    //           = R × q_s × inv(q_cal) × inv(R)
    //
    // See below for the correct similarity transform decomposition.
    //
    // =========================================================================
    // HEAD CALIBRATION MATH - SIMILARITY TRANSFORM DECOMPOSITION
    // =========================================================================
    //
    // GOAL: Map sensor-frame rotations to bone-frame rotations via PCA alignment.
    //
    //   q_world = R × δ_body × inv(R)
    //
    // where:
    //   R = axisAlignment (sensor frame → bone frame, from PCA)
    //   δ_body = inv(q_cal) × q_sensor (body-frame delta from calibration pose)
    //
    // Expanded: q_world = R × inv(q_cal) × q_sensor × inv(R)
    //
    // PIPELINE DECOMPOSITION:
    //   Pipeline computes: q_world = inv(headingTare) × q_sensor × mountingTare × frameAlignment
    //
    //   Matching terms (with bindWorldQuat bake):
    //     inv(headingTare) = bindWorldQuat × R × inv(q_cal)
    //       → headingTare = q_cal × inv(R) × inv(bindWorldQuat)
    //     mountingTare = identity             (boresight absorbed into headingTare)
    //     frameAlignment = inv(R)             (right-side of similarity transform)
    //
    // PROOF (at calibration pose, q_sensor = q_cal):
    //   q_world = bindWorldQuat × R × inv(q_cal) × q_cal × inv(R) = bindWorldQuat ✓
    //
    // PROOF (user nods, creating δ_body around sensor pitch axis):
    //   q_world = bindWorldQuat × R × δ_body × inv(R)
    //   If R maps sensor_pitch_axis → bone_X, this yields bindWorldQuat + pure X rotation ✓
    //
    // WHY bindWorldQuat?
    //   applyToBone computes: bone.quaternion = inv(parentWorld) × q_world
    //   Without bindWorldQuat bake, q_world = identity at calibration, but
    //   inv(parentWorld) × identity ≠ bind_local → head snaps to wrong pose.
    //   With bake: inv(parentWorld) × bindWorldQuat = correct bind_local rotation.
    //
    // BUG FIX (2026-02-10): Previous code set mountingTare = inv(q_cal) × inv(R)
    // and frameAlignment = R, causing inv(R) × R to cancel. PCA had ZERO effect
    // on output — the system was just a simple boresight with no axis remapping.
    //
    // This ensures PCA actually remaps axes:
    //   - Nod → Pitch (rotation about bone X)
    //   - Shake → Yaw (rotation about bone Y)
    //   - Tilt → Roll (rotation about bone Z)
    // =========================================================================

    // Look up head bind-pose world quaternion from target neutral pose
    const { targetNeutralPose } = useCalibrationStore.getState();
    const bindWorldQuat =
      targetNeutralPose?.get("head" as any) ?? new THREE.Quaternion();
    if (bindWorldQuat.lengthSq() < 0.5) {
      console.warn(
        "[CervicalCal] bindWorldQuat for 'head' is zero/missing — falling back to identity",
      );
      bindWorldQuat.set(0, 0, 0, 1);
    }

    // frameAlignment = inv(R): right-side of similarity transform
    const frameAlignment = axisAlignment.clone().invert();
    // mountingTare = identity: boresight is absorbed into headingTare
    const mountingTare = new THREE.Quaternion(); // Identity
    // headingTare = q_cal × inv(R) × inv(bindWorldQuat)
    // When inverted in pipeline → bindWorldQuat × R × inv(q_cal) (left-side)
    const headingTare = this.buffers
      .startQuaternion!.clone()
      .multiply(axisAlignment.clone().invert())
      .multiply(bindWorldQuat.clone().invert());

    // ── Bind-pose verification ─────────────────────────────────────────────
    //   q_world = inv(headingTare) × q_cal × mountingTare × frameAlignment
    //   Should = bindWorldQuat at calibration pose.
    const verifyBone = this.buffers
      .startQuaternion!.clone()
      .multiply(mountingTare)
      .multiply(frameAlignment);
    const verifyWorld = headingTare.clone().invert().multiply(verifyBone);
    const bindPoseDeg = verifyWorld.angleTo(bindWorldQuat) * (180 / Math.PI);
    if (bindPoseDeg > 0.5) {
      console.warn(
        `[CervicalCal] ⚠ Bind-pose check: ${bindPoseDeg.toFixed(2)}° deviation from bindWorldQuat`,
      );
    } else {
      console.debug(
        `[CervicalCal] ✓ Bind-pose check passed: ${bindPoseDeg.toFixed(4)}° deviation`,
      );
    }

    // Consolidated calibration summary (single log for cleaner output)
    console.debug("[CervicalCal] Calibration computed:", {
      bindWorldQuat: `[${bindWorldQuat
        .toArray()
        .map((v) => v.toFixed(3))
        .join(", ")}]`,
      mountingTare: `[${mountingTare
        .toArray()
        .map((v) => v.toFixed(3))
        .join(", ")}]`,
      frameAlignment: `[${frameAlignment
        .toArray()
        .map((v) => v.toFixed(3))
        .join(", ")}]`,
      pcaConfidence: pcaConfidence.toFixed(3),
    });

    // For backward compatibility with existing pipeline that only uses "offset" as mountingTare
    // and we need to also set headingTare separately
    const result = {
      mountingTare: mountingTare,
      headingTare: headingTare,
      frameAlignment: frameAlignment, // NEW: Frame alignment for axis remapping
      axisAlignment: axisAlignment,
      confidence: pcaConfidence,
      axes: {
        pitch: new THREE.Vector3(1, 0, 0),
        yaw: new THREE.Vector3(0, 1, 0),
      },
    };

    // DEBUG DUMP
    const debugDump = {
      nod: this.buffers.nodScalars.map((v) => ({ x: v.x, y: v.y, z: v.z })),
      shake: this.buffers.shakeScalars.map((v) => ({ x: v.x, y: v.y, z: v.z })),
      gravity: this.buffers.startGravity
        ? {
            x: this.buffers.startGravity.x,
            y: this.buffers.startGravity.y,
            z: this.buffers.startGravity.z,
          }
        : null,
      startQuat: {
        w: this.buffers.startQuaternion.w,
        x: this.buffers.startQuaternion.x,
        y: this.buffers.startQuaternion.y,
        z: this.buffers.startQuaternion.z,
      },
      boresight: {
        w: boresight.w,
        x: boresight.x,
        y: boresight.y,
        z: boresight.z,
      },
      axisAlignment: {
        w: axisAlignment.w,
        x: axisAlignment.x,
        y: axisAlignment.y,
        z: axisAlignment.z,
      },
      frameAlignment: {
        w: frameAlignment.w,
        x: frameAlignment.x,
        y: frameAlignment.y,
        z: frameAlignment.z,
      },
      mountingTare: {
        w: mountingTare.w,
        x: mountingTare.x,
        y: mountingTare.y,
        z: mountingTare.z,
      },
      headingTare: {
        w: headingTare.w,
        x: headingTare.x,
        y: headingTare.y,
        z: headingTare.z,
      },
      confidence: pcaConfidence,
    };

    // SAVE to CalibrationStore
    const calData: CalibrationData = {
      segmentId: "head",
      offset: mountingTare, // This goes into the "offset" field for compatibility
      capturedQuaternion: this.buffers.startQuaternion.clone(),
      capturedAt: Date.now(),
      quality: pcaConfidence * 100,
      method: "functional",
    };
    // Use proper Zustand setter to ensure reactivity (avoid direct Map mutation)
    const calStore = useCalibrationStore.getState();
    const newOffsets = new Map(calStore.sensorOffsets);
    newOffsets.set("head", calData);
    useCalibrationStore.setState({ sensorOffsets: newOffsets });

    // SYNC TO TARE STORE with BOTH mounting and heading tares (SYNCHRONOUSLY)
    {
      const store = useTareStore.getState();
      const now = Date.now();

      // Get existing states
      const newStates = new Map(store.tareStates);
      const currentState = newStates.get("head") || {
        mountingTare: new THREE.Quaternion(),
        headingTare: new THREE.Quaternion(),
        jointTare: { flexion: 0, abduction: 0, rotation: 0 },
        mountingTareTime: 0,
        headingTareTime: 0,
        jointTareTime: 0,
      };

      // Update mounting tare, heading tare, AND frame alignment
      newStates.set("head", {
        ...currentState,
        mountingTare: mountingTare.clone(),
        headingTare: headingTare.clone(),
        frameAlignment: frameAlignment.clone(),
        mountingTareTime: now,
        headingTareTime: now,
        frameAlignmentTime: now,
      });

      // Directly update the store state
      useTareStore.setState({ tareStates: newStates });

      // Log for verification
      const verifyState = useTareStore.getState().getTareState("head");
      console.debug("[CervicalCal] Applied calibration to TareStore:", {
        mountingTareTime: verifyState?.mountingTareTime,
        headingTareTime: verifyState?.headingTareTime,
        frameAlignmentTime: verifyState?.frameAlignmentTime,
        mountingTare: verifyState?.mountingTare
          ? `[${verifyState.mountingTare.toArray().map((v) => v.toFixed(3))}]`
          : "none",
        headingTare: verifyState?.headingTare
          ? `[${verifyState.headingTare.toArray().map((v) => v.toFixed(3))}]`
          : "none",
        frameAlignment: verifyState?.frameAlignment
          ? `[${verifyState.frameAlignment.toArray().map((v) => v.toFixed(3))}]`
          : "none",
      });
    }

    // CRITICAL: Assign the sensor to the 'head' segment so SkeletonModel animates it
    const registry = useDeviceRegistry.getState();
    const headSensorId = this.findHeadSensor(registry);
    if (headSensorId) {
      useSensorAssignmentStore
        .getState()
        .assign(headSensorId, BodyRole.HEAD, "auto");
      console.debug(
        `[CervicalCal] Assigned sensor ${headSensorId} to HEAD role`,
      );
    }

    // ─── GENERATE CALIBRATION REPORT ───
    // Record the calculating step timing
    this.stepTimings.push({
      name: "calculating",
      startTime: this.stepStartTime,
      endTime: Date.now(),
      status: "completed",
    });

    const totalDurationMs = Date.now() - this.calStartTime;
    const bias = registry.gyroBias[headSensorId || ""];
    const confidenceLabel =
      pcaConfidence >= 0.85
        ? "Excellent"
        : pcaConfidence >= 0.7
          ? "Good"
          : pcaConfidence >= 0.5
            ? "Fair"
            : "Poor";

    const report: CalibrationReport = {
      timestamp: Date.now(),
      totalDurationMs,
      steps: this.stepTimings.map((s) => ({
        name: s.name,
        durationMs: s.endTime - s.startTime,
        status: s.status,
      })),
      nodSamples: this.buffers.nodScalars.length,
      shakeSamples: this.buffers.shakeScalars.length,
      pcaConfidence,
      pcaConfidenceLabel: confidenceLabel,
      hasBiasCorrection: !!bias,
      gyroBias: bias || null,
      axisAlignment: {
        w: axisAlignment.w,
        x: axisAlignment.x,
        y: axisAlignment.y,
        z: axisAlignment.z,
      },
      frameAlignment: {
        w: frameAlignment.w,
        x: frameAlignment.x,
        y: frameAlignment.y,
        z: frameAlignment.z,
      },
      headingTare: {
        w: headingTare.w,
        x: headingTare.x,
        y: headingTare.y,
        z: headingTare.z,
      },
      mountingTare: {
        w: mountingTare.w,
        x: mountingTare.x,
        y: mountingTare.y,
        z: mountingTare.z,
      },
      sensorId: headSensorId,
      success: true,
      failureReason: null,
    };

    useCalibrationStore.getState().setCalibrationReport(report);
    console.debug("[CervicalCal] Report generated:", {
      totalDuration: `${(totalDurationMs / 1000).toFixed(1)}s`,
      confidence: `${(pcaConfidence * 100).toFixed(0)}%`,
      quality: confidenceLabel,
      nodSamples: report.nodSamples,
      shakeSamples: report.shakeSamples,
      steps: report.steps
        .map(
          (s) => `${s.name}:${(s.durationMs / 1000).toFixed(1)}s(${s.status})`,
        )
        .join(", "),
    });

    // ─── SET HEADING ANCHOR (yaw drift correction) ───
    // After calibration completes, the user is in neutral pose.
    // Capture the VQF's current quaternion as the "zero heading" reference.
    // During future rest periods, VQF will gently correct heading drift
    // toward this reference (since accelerometer only corrects pitch/roll).
    if (headSensorId) {
      registry.setVQFHeadingAnchor(headSensorId);
    }

    useCalibrationStore.getState().setCervicalStep("verification"); // Go to game mode
  }

  private resetBuffers() {
    this.buffers = {
      nodScalars: [],
      shakeScalars: [],
      tiltScalars: [],
      startGravity: null,
      startQuaternion: null,
      gyroAccumulator: [],
    };
  }

  private captureStartGravity() {
    const registry = useDeviceRegistry.getState();
    const headSensorId = this.findHeadSensor(registry);
    if (headSensorId) {
      const accel = deviceAccelCache.get(headSensorId);
      if (accel) {
        // Capture reference gravity for alignment (Simple normalized vector)
        this.buffers.startGravity = new THREE.Vector3(
          accel[0],
          accel[1],
          accel[2],
        ).normalize();
      }

      // ─── AVERAGED GYRO BIAS ───
      // Instead of a single-sample bias (vulnerable to noise), average ALL
      // gyro samples accumulated during the stationary_start hold.
      // At 200Hz over ~0.5-2s, this can be 100-400+ samples.
      // Averaging reduces noise by √N, giving a much more accurate bias.
      const accumulated = this.buffers.gyroAccumulator;
      if (accumulated.length >= 10) {
        // Average the accumulated samples
        let sumX = 0,
          sumY = 0,
          sumZ = 0;
        for (const [x, y, z] of accumulated) {
          sumX += x;
          sumY += y;
          sumZ += z;
        }
        const n = accumulated.length;
        const gBias = { x: sumX / n, y: sumY / n, z: sumZ / n };
        registry.setGyroBias(headSensorId, gBias);
      } else {
        // Fallback: not enough accumulated samples (e.g. safety timeout)
        // Use the current single sample
        const gyro = deviceGyroCache.get(headSensorId);
        if (gyro) {
          const gBias = { x: gyro[0], y: gyro[1], z: gyro[2] };
          registry.setGyroBias(headSensorId, gBias);
        }
      }

      const quat = deviceQuaternionCache.get(headSensorId);
      if (quat) {
        // deviceQuaternionCache stores [w, x, y, z] in Y-up frame from firmware
        // THREE.Quaternion constructor is (x, y, z, w)
        this.buffers.startQuaternion = new THREE.Quaternion(
          quat[1],
          quat[2],
          quat[3],
          quat[0],
        );
      }
    }
  }

  /**
   * Capture a fresh reference quaternion at the END of calibration.
   * This replaces the stale startQuaternion with the user's current neutral pose,
   * ensuring the model starts at identity (no displacement) after calibration.
   */
  private captureEndQuaternion() {
    const registry = useDeviceRegistry.getState();
    const headSensorId = this.findHeadSensor(registry);
    if (!headSensorId) return;

    const quat = deviceQuaternionCache.get(headSensorId);
    if (quat) {
      const freshQuat = new THREE.Quaternion(
        quat[1],
        quat[2],
        quat[3],
        quat[0],
      );

      this.buffers.startQuaternion = freshQuat;
    }
  }

  private findHeadSensor(registry: any): string | null {
    // 1. Use explicitly selected sensor (from UI picker)
    if (this._headSensorId && registry.devices.has(this._headSensorId)) {
      return this._headSensorId;
    }

    // 2. Check sensor assignment store for existing HEAD role
    const assignedHead = useSensorAssignmentStore
      .getState()
      .getSensorForRole(BodyRole.HEAD);
    if (assignedHead && registry.devices.has(assignedHead)) {
      return assignedHead;
    }

    // 3. Fallback: first device (single-sensor setup)
    if (registry.devices.size === 1) {
      return registry.devices.keys().next().value;
    }

    // 4. Multiple sensors, none selected — log warning
    if (registry.devices.size > 1) {
      console.warn(
        `[CervicalCal] ${registry.devices.size} sensors connected but no head sensor selected!`,
      );
    }
    return null;
  }
}

export const cervicalCalManager = new CervicalCalibrationManager();
