import * as THREE from "three";

/**
 * VQF (Versatile Quaternion-based Filter) — 6-Axis IMU Fusion
 *
 * Produces orientation from accelerometer + gyroscope without magnetometer.
 *
 * Architecture:
 *   1. Gyro input clamping (reject physically impossible readings)
 *   2. Gyro integration with internal bias correction
 *   3. Quaternion rate limiting (clamp angular velocity to human limits)
 *   4. Variance-based rest detection with sustained-confirmation
 *   5. Adaptive heading reference update on rest transition
 *   6. Residual bias refinement + heading drift correction during rest
 *   7. Continuous-confidence accelerometer tilt correction
 *   8. Error-proportional recovery boost for large errors
 *   9. Output smoothing (1-pole SLERP low-pass)
 *
 * Heading strategy (single 6-axis IMU, no magnetometer):
 *   The heading reference updates to the current yaw each time rest is
 *   first confirmed after a movement period. This means intentional head
 *   turns are preserved — only residual gyro drift during sustained rest
 *   is corrected. Without this, the anchor would always pull yaw back
 *   to the calibration-time heading, fighting intentional rotations.
 *
 * Zero inner-loop allocations via object pooling.
 */

export interface VQFParams {
  tauAcc: number;
  tauMag: number;
  restThAcc: number;
  restThGyro: number;
}

// ─── PHYSICAL CONSTANTS ───
const GRAVITY = 9.81;
const DEG2RAD = Math.PI / 180;

// ─── GYRO INPUT CLAMP ───
// Human head peak ≈ 800°/s even in whiplash. ICM-20649 saturates at 4000°/s.
// Anything above 1000°/s is physically impossible or sensor noise — reject it.
const GYRO_CLAMP_RAD = 1000 * DEG2RAD; // 17.45 rad/s

// ─── QUATERNION RATE LIMIT ───
// Max angular change per frame. At 60 Hz, 800°/s → 13.3° per frame.
// At 200 Hz (IMU rate), 800°/s → 4° per frame.
// Uses velocity × dt so it adapts to any frame rate.
const MAX_ANGULAR_RATE_RAD = 800 * DEG2RAD; // rad/s

// ─── REST DETECTION (variance-based) ───
const REST_WINDOW = 120; // 2s at 60Hz
const REST_GYRO_VAR_TH = 0.0004; // (rad/s)²
const REST_ACCEL_VAR_TH = 0.01; // (m/s²)²
const REST_ACCEL_MAG_TH = 0.5; // |accelMag - g| threshold
const REST_SUSTAIN = 45; // 0.75s sustained rest before corrections
// BIAS_ALPHA DISABLED — external gyro bias is subtracted BEFORE VQF input.
// VQF's internal bias must stay zero to prevent double-subtraction drift.
// const BIAS_ALPHA = 0.005;

// ─── HEADING ANCHOR ───
const HEADING_ALPHA = 0.03; // ~3s convergence (fast enough to fight drift, slow enough to avoid jitter)

// ─── ACCEL CONFIDENCE ───
const ACCEL_TOLERANCE = 0.3; // ±30% from 1G → confidence = 0 (was 0.2; more tolerant during gentle motion)
const GYRO_DECAY_RATE = 1.2; // Exponential suppression during rotation (was 2.0; allows more accel trust in motion)

// ─── ADAPTIVE GAIN ───
// The tilt correction gain determines how quickly the filter corrects
// gyro-integrated pitch/roll using the accelerometer gravity reference.
// REST_GAIN: applied when stationary — fast convergence to true tilt.
// MOTION_GAIN: applied during movement — must be high enough to prevent
//   drift accumulation over a movement cycle, but low enough not to
//   distort dynamic motion. At 0.005 (old), a 5° error took hundreds of
//   frames to correct. At 0.02, ~50 frames (< 1s) for meaningful correction.
const REST_GAIN = 0.06;
const MOTION_GAIN = 0.02;
const MOTION_BLEND_TH = 0.5; // rad/s

// ─── ERROR RECOVERY ───
const ERROR_BOOST_START = Math.PI / 18; // 10° (was 15° — kick in sooner)
const ERROR_BOOST_MAX = 0.2; // 20% max gain (was 15%)

// ─── OUTPUT SMOOTHING ───
// 1-pole SLERP low-pass. 0.75 = 75% new + 25% old.
// Was 0.6 — too much lag, slowing convergence of accel correction.
const OUTPUT_SMOOTH_ALPHA = 0.75;

// ─── DIAGNOSTIC LOG INTERVAL ───
const DIAG_INTERVAL = 600; // ~10s at 60Hz

export class VQF {
  // ─── State ───
  private quat = new THREE.Quaternion(0, 0, 0, 1);
  private bias = new THREE.Vector3(0, 0, 0);
  private prevOutput = new THREE.Quaternion(0, 0, 0, 1);
  private smoothedOutput = new THREE.Quaternion(0, 0, 0, 1);
  private prevQuat = new THREE.Quaternion(0, 0, 0, 1);

  // ─── Config ───
  private params: VQFParams;

  // ─── Rest detection ───
  private restDetected = false;
  private restConfirmedFrames = 0;
  private gyroMagWindow: number[] = [];
  private accelXWindow: number[] = [];
  private accelYWindow: number[] = [];
  private accelZWindow: number[] = [];

  // ─── Heading anchor ───
  private headingAnchor: THREE.Quaternion | null = null;
  private headingUpdatedThisRest = false; // Tracks whether heading ref updated for current rest period

  // ─── Diagnostics ───
  private _updateCount = 0;
  private _lastErrorAngle = 0;
  private _maxErrorAngle = 0;

  // ─── Object pool (zero allocations in hot loop) ───
  private _gyroStep = new THREE.Vector3();
  private _quatStep = new THREE.Quaternion();
  private _accelNorm = new THREE.Vector3();
  private _accelWorld = new THREE.Vector3();
  private _worldUp = new THREE.Vector3(0, 1, 0);
  private _correctionQuat = new THREE.Quaternion();
  private _incrementalCtx = new THREE.Quaternion();
  private _tempVector = new THREE.Vector3();
  private _headingTwist = new THREE.Quaternion();
  private _headingRefTwist = new THREE.Quaternion();
  private _headingCorrection = new THREE.Quaternion();
  private _rateLimitDelta = new THREE.Quaternion();
  private _identity = new THREE.Quaternion(0, 0, 0, 1);

  constructor(params?: Partial<VQFParams>) {
    this.params = {
      tauAcc: 1.5,
      tauMag: 9.0,
      restThAcc: 0.5,
      restThGyro: 0.15,
      ...params,
    };
  }

  /**
   * Update the filter with new IMU data.
   * @param dt Delta time in seconds
   * @param gyro Gyroscope [x, y, z] in rad/s (bulk bias subtracted externally)
   * @param accel Accelerometer [x, y, z] in m/s²
   */
  update(
    dt: number,
    gyro: [number, number, number],
    accel: [number, number, number],
  ): void {
    const finiteInput =
      Number.isFinite(dt) &&
      Number.isFinite(gyro[0]) &&
      Number.isFinite(gyro[1]) &&
      Number.isFinite(gyro[2]) &&
      Number.isFinite(accel[0]) &&
      Number.isFinite(accel[1]) &&
      Number.isFinite(accel[2]);
    if (!finiteInput || dt <= 0) {
      return;
    }

    // ── STAGE 1: GYRO INPUT CLAMPING ──
    const gx = Math.max(-GYRO_CLAMP_RAD, Math.min(GYRO_CLAMP_RAD, gyro[0]));
    const gy = Math.max(-GYRO_CLAMP_RAD, Math.min(GYRO_CLAMP_RAD, gyro[1]));
    const gz = Math.max(-GYRO_CLAMP_RAD, Math.min(GYRO_CLAMP_RAD, gyro[2]));
    const [ax, ay, az] = accel;

    // ── STAGE 2: GYRO INTEGRATION ──
    // NOTE: External gyro bias is already subtracted in useDeviceRegistry.ts
    // before gyro data reaches VQF. Do NOT subtract this.bias again here —
    // that causes double-subtraction drift where the filter over-corrects
    // and accumulates offset with each movement cycle.
    this.prevQuat.copy(this.quat);
    this._gyroStep.set(gx, gy, gz);
    const angle = this._gyroStep.length() * dt;
    if (angle > 0) {
      this._gyroStep.normalize();
      this._quatStep.setFromAxisAngle(this._gyroStep, angle);
      this.quat.multiply(this._quatStep).normalize();
    }

    // ── STAGE 3: QUATERNION RATE LIMITING ──
    const maxAngle = MAX_ANGULAR_RATE_RAD * dt;
    this._rateLimitDelta.copy(this.prevQuat).invert().multiply(this.quat);
    VQF.ensurePositiveW(this._rateLimitDelta);
    const deltaAngle = 2 * Math.acos(Math.min(1, this._rateLimitDelta.w));
    if (deltaAngle > maxAngle && deltaAngle > 0.0001) {
      const clampFraction = maxAngle / deltaAngle;
      this.quat.copy(this.prevQuat).slerp(this.quat, clampFraction).normalize();
    }

    // ── STAGE 4: VARIANCE-BASED REST DETECTION ──
    const accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
    const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);

    this.gyroMagWindow.push(gyroMag);
    this.accelXWindow.push(ax);
    this.accelYWindow.push(ay);
    this.accelZWindow.push(az);
    if (this.gyroMagWindow.length > REST_WINDOW) {
      this.gyroMagWindow.shift();
      this.accelXWindow.shift();
      this.accelYWindow.shift();
      this.accelZWindow.shift();
    }

    if (this.gyroMagWindow.length >= REST_WINDOW) {
      const gyroVar = VQF.variance(this.gyroMagWindow);
      const accelVarTotal =
        VQF.variance(this.accelXWindow) +
        VQF.variance(this.accelYWindow) +
        VQF.variance(this.accelZWindow);
      const accelDeviation = Math.abs(accelMag - GRAVITY);

      this.restDetected =
        gyroVar < REST_GYRO_VAR_TH &&
        accelVarTotal < REST_ACCEL_VAR_TH &&
        accelDeviation < REST_ACCEL_MAG_TH;
    } else {
      this.restDetected = false;
    }

    // ── STAGE 5: REST-ONLY CORRECTIONS ──
    if (this.restDetected) {
      this.restConfirmedFrames++;
      if (this.restConfirmedFrames >= REST_SUSTAIN) {
        // On FIRST confirmed-rest frame after movement: update heading
        // reference to current yaw. This preserves intentional rotations
        // while still fighting drift during sustained rest.
        if (!this.headingUpdatedThisRest && this.headingAnchor) {
          this.updateHeadingReference();
          this.headingUpdatedThisRest = true;
        }
        // BIAS LEARNING DISABLED — external bias is subtracted before VQF.
        // Internal bias stays at zero to prevent double-subtraction drift.
        // (Previously: this.bias.lerp(gyro, BIAS_ALPHA) which learned a
        //  second bias on top of the already-corrected signal)

        // Heading drift correction (toward recently-updated reference)
        this.applyHeadingCorrection();
      }
    } else {
      this.restConfirmedFrames = 0;
      this.headingUpdatedThisRest = false;
    }

    // ── STAGE 6: ACCELEROMETER TILT CORRECTION ──
    this._accelNorm.set(ax, ay, az).normalize();
    this._accelWorld.copy(this._accelNorm).applyQuaternion(this.quat);

    const dotProduct = this._accelWorld.dot(this._worldUp);
    const errorAngle = Math.acos(Math.min(1, Math.max(-1, dotProduct)));

    // Accel confidence: quadratic falloff from 1G
    const accelRatio = accelMag / GRAVITY;
    const accelDevFromG = Math.abs(accelRatio - 1.0);
    const accelConfidence = Math.max(
      0,
      1 - (accelDevFromG / ACCEL_TOLERANCE) ** 2,
    );

    // Gyro confidence: exponential decay
    const gyroConfidence = Math.exp(-GYRO_DECAY_RATE * gyroMag);

    const accelTrust = accelConfidence * gyroConfidence;

    // Adaptive gain
    const motionBlend = Math.min(1, gyroMag / MOTION_BLEND_TH);
    const baseGain = REST_GAIN + motionBlend * (MOTION_GAIN - REST_GAIN);
    let adaptiveGain = baseGain * accelTrust;

    // Error-proportional recovery
    if (errorAngle > ERROR_BOOST_START) {
      const errorRatio = Math.min(
        1,
        (errorAngle - ERROR_BOOST_START) / (Math.PI / 2),
      );
      const errorBoost = errorRatio * errorRatio * ERROR_BOOST_MAX * accelTrust;
      adaptiveGain = Math.max(adaptiveGain, errorBoost);
    }

    if (adaptiveGain > 0.0001) {
      this._correctionQuat.setFromUnitVectors(this._accelWorld, this._worldUp);
      VQF.ensurePositiveW(this._correctionQuat);

      if (!VQF.hasNaN(this._correctionQuat)) {
        this._incrementalCtx
          .identity()
          .slerp(this._correctionQuat, adaptiveGain);
        this.quat.premultiply(this._incrementalCtx).normalize();
        VQF.ensurePositiveW(this.quat);
      }
    }

    this._lastErrorAngle = errorAngle;
    this._maxErrorAngle = Math.max(this._maxErrorAngle, errorAngle);

    // ── STAGE 7: OUTPUT SMOOTHING ──
    this.smoothedOutput
      .copy(this.prevOutput)
      .slerp(this.quat, OUTPUT_SMOOTH_ALPHA);
    VQF.ensurePositiveW(this.smoothedOutput);
    this.prevOutput.copy(this.smoothedOutput);

    this._updateCount++;
  }

  // ═══════════════════════════════════════════════════════════════════
  // HEADING ANCHOR — private
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Update heading reference to current yaw twist.
   * Called once per rest period (on first confirmed-rest frame after movement).
   * This accepts intentional rotations — only subsequent drift is corrected.
   */
  private updateHeadingReference(): void {
    if (!this.headingAnchor) return;
    const qc = this.quat;
    const twistLen = Math.sqrt(qc.w * qc.w + qc.y * qc.y);
    if (twistLen < 0.0001) return;
    this.headingAnchor.set(0, qc.y / twistLen, 0, qc.w / twistLen);
    VQF.ensurePositiveW(this.headingAnchor);
  }

  /**
   * Swing-twist decomposition: extract yaw (twist around Y) from
   * current and reference, SLERP current toward reference.
   * Only corrects residual drift accumulated during the current rest period.
   */
  private applyHeadingCorrection(): void {
    if (!this.headingAnchor) return;

    // Extract yaw twist from current
    const qc = this.quat;
    const twistLenC = Math.sqrt(qc.w * qc.w + qc.y * qc.y);
    if (twistLenC < 0.0001) return;
    this._headingTwist.set(0, qc.y / twistLenC, 0, qc.w / twistLenC);
    VQF.ensurePositiveW(this._headingTwist);

    // Extract yaw twist from reference
    const qr = this.headingAnchor;
    const twistLenR = Math.sqrt(qr.w * qr.w + qr.y * qr.y);
    if (twistLenR < 0.0001) return;
    this._headingRefTwist.set(0, qr.y / twistLenR, 0, qr.w / twistLenR);
    VQF.ensurePositiveW(this._headingRefTwist);

    // Heading error: delta = inv(currentTwist) × refTwist
    this._headingCorrection
      .copy(this._headingTwist)
      .invert()
      .multiply(this._headingRefTwist);
    VQF.ensurePositiveW(this._headingCorrection);

    const headingError = 2 * Math.acos(Math.min(1, this._headingCorrection.w));
    if (headingError < DEG2RAD) return; // < 1°

    // Fractional correction
    this._headingCorrection.slerp(this._identity, 1 - HEADING_ALPHA);
    this.quat.premultiply(this._headingCorrection).normalize();
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════

  /** Smoothed output quaternion (typical use). */
  getQuaternion(): THREE.Quaternion {
    return this.smoothedOutput.clone();
  }

  /** Raw (unsmoothed) quaternion — calibration/diagnostics only. */
  getRawQuaternion(): THREE.Quaternion {
    return this.quat.clone();
  }

  getBias(): THREE.Vector3 {
    return this.bias.clone();
  }

  setBias(bias: THREE.Vector3): void {
    this.bias.copy(bias);
  }

  /**
   * Set heading anchor — VQF quaternion at calibrated neutral pose.
   * During rest, heading gently corrects toward this reference.
   */
  setHeadingAnchor(anchor: THREE.Quaternion): void {
    this.headingAnchor = anchor.clone();
    VQF.ensurePositiveW(this.headingAnchor);
    console.debug(
      `[VQF] Heading anchor set: [${anchor.w.toFixed(3)}, ${anchor.x.toFixed(3)}, ${anchor.y.toFixed(3)}, ${anchor.z.toFixed(3)}]`,
    );
  }

  clearHeadingAnchor(): void {
    this.headingAnchor = null;
  }

  getDiagnostics() {
    return {
      lastErrorDeg: this._lastErrorAngle * (180 / Math.PI),
      maxErrorDeg: this._maxErrorAngle * (180 / Math.PI),
      updateCount: this._updateCount,
      bias: this.bias.clone(),
      restDetected: this.restDetected,
    };
  }

  setParams(params: Partial<VQFParams>): void {
    this.params = { ...this.params, ...params };
  }

  /** Initialize orientation from accelerometer (assumes stationary). */
  initFromAccel(accel: [number, number, number]): void {
    const [ax, ay, az] = accel;
    const norm = Math.sqrt(ax * ax + ay * ay + az * az);
    if (norm < 0.1) return;

    const aNorm = new THREE.Vector3(ax, ay, az).divideScalar(norm);
    const dot = aNorm.dot(this._worldUp);

    if (dot > 0.999) {
      this.quat.set(0, 0, 0, 1);
    } else if (dot < -0.999) {
      this.quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    } else {
      this.quat.copy(
        new THREE.Quaternion().setFromUnitVectors(aNorm, this._worldUp),
      );
    }

    this.smoothedOutput.copy(this.quat);
    this.prevOutput.copy(this.quat);
    this.prevQuat.copy(this.quat);
  }

  reset(): void {
    this.quat.set(0, 0, 0, 1);
    this.bias.set(0, 0, 0);
    this.smoothedOutput.set(0, 0, 0, 1);
    this.prevOutput.set(0, 0, 0, 1);
    this.prevQuat.set(0, 0, 0, 1);
    this.restDetected = false;
    this.restConfirmedFrames = 0;
    this.gyroMagWindow.length = 0;
    this.accelXWindow.length = 0;
    this.accelYWindow.length = 0;
    this.accelZWindow.length = 0;
    this.headingAnchor = null;
    this.headingUpdatedThisRest = false;
    this._updateCount = 0;
    this._lastErrorAngle = 0;
    this._maxErrorAngle = 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // STATIC HELPERS
  // ═══════════════════════════════════════════════════════════════════

  private static ensurePositiveW(q: THREE.Quaternion): void {
    if (q.w < 0) {
      q.x *= -1;
      q.y *= -1;
      q.z *= -1;
      q.w *= -1;
    }
  }

  private static hasNaN(q: THREE.Quaternion): boolean {
    return (
      Number.isNaN(q.x) ||
      Number.isNaN(q.y) ||
      Number.isNaN(q.z) ||
      Number.isNaN(q.w)
    );
  }

  private static variance(arr: number[]): number {
    const n = arr.length;
    if (n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i];
    const mean = sum / n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (arr[i] - mean) * (arr[i] - mean);
    return v / n;
  }
}

