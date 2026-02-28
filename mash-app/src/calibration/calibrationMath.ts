/**
 * Calibration Math Module
 *
 * Provides enhanced calibration algorithms based on industry best practices:
 * - Single-pose (T-Pose) calibration for quick setup
 * - Dual-pose (T-Pose + N-Pose) calibration for improved heading
 * - PCA-based functional axis estimation for joint axes
 * - Quality metrics for calibration validation
 */
import * as THREE from "three";

// ============================================================================
// TYPES
// ============================================================================

export interface CalibrationResult {
  /** Final calibration offset quaternion */
  offset: THREE.Quaternion;
  /** Tilt alignment component (from T-pose) */
  alignmentQuat: THREE.Quaternion;
  /** Heading correction component (from N-pose) */
  headingCorrection: THREE.Quaternion;
  /** Quality score 0-100 */
  quality: number;
  /** Method used for calibration */
  method: "single-pose" | "dual-pose" | "functional";
}

export interface CalibrationQuality {
  /** Overall quality score 0-100 */
  score: number;
  /** Individual metrics */
  metrics: {
    /** Angular difference from expected in degrees */
    angularError: number;
    /** Sensor stability during capture (lower is better) */
    sensorNoise: number;
    /** Pose consistency between captures */
    poseConsistency: number;
  };
  /** Warning messages if any */
  warnings: string[];
}

export interface FunctionalAxisResult {
  /** Primary rotation axis in sensor frame */
  axis: THREE.Vector3;
  /** Confidence in axis estimation (0-1) */
  confidence: number;
  /** Number of samples used */
  sampleCount: number;
}

// ============================================================================
// SINGLE-POSE CALIBRATION (Current Implementation)
// ============================================================================

/**
 * Compute calibration offset from a single static pose (T-Pose).
 *
 * Formula: offset = inv(q_sensor) * q_target
 * At runtime: bone = sensor * offset
 *
 * @param sensorQuat - Sensor orientation during calibration pose
 * @param targetQuat - Desired bone orientation in calibration pose
 * @returns Calibration offset quaternion
 */
export function computeSinglePoseOffset(
  sensorQuat: THREE.Quaternion,
  targetQuat: THREE.Quaternion,
): THREE.Quaternion {
  // offset = inv(sensor) * target
  return sensorQuat.clone().invert().multiply(targetQuat);
}

/**
 * Apply calibration offset to sensor reading at runtime.
 *
 * @param sensorQuat - Current sensor orientation
 * @param offset - Calibration offset from computeSinglePoseOffset
 * @returns Calibrated bone orientation
 */
export function applyCalibrationOffset(
  sensorQuat: THREE.Quaternion,
  offset: THREE.Quaternion,
): THREE.Quaternion {
  // bone = sensor * offset
  return sensorQuat.clone().multiply(offset);
}

// ============================================================================
// DUAL-POSE CALIBRATION (Enhanced - Xsens/Noraxon Style)
// ============================================================================

/**
 * Compute calibration using two poses for improved heading accuracy.
 *
 * Uses T-Pose for tilt alignment (roll/pitch) and N-Pose for heading (yaw).
 * This addresses the issue where single T-pose cannot determine sensor heading
 * relative to the body's forward direction.
 *
 * Protocol (based on Xsens MVN):
 * 1. Capture T-Pose (arms horizontal) for tilt reference
 * 2. Walk forward 5 steps to initialize heading
 * 3. Capture N-Pose (neutral standing, arms at sides)
 *
 * @param tPoseSensor - Sensor quaternion during T-Pose
 * @param tPoseTarget - Target bone quaternion for T-Pose
 * @param nPoseSensor - Sensor quaternion during N-Pose (after walking)
 * @param nPoseTarget - Target bone quaternion for N-Pose
 * @returns Complete calibration result with quality metrics
 */
export function computeDualPoseCalibration(
  tPoseSensor: THREE.Quaternion,
  tPoseTarget: THREE.Quaternion,
  nPoseSensor: THREE.Quaternion,
  nPoseTarget: THREE.Quaternion,
): CalibrationResult {
  // Step 1: Compute tilt alignment from T-Pose
  const alignmentQuat = computeSinglePoseOffset(tPoseSensor, tPoseTarget);

  // Step 2: Apply tilt alignment to N-Pose sensor reading
  const nPoseSensorCorrected = nPoseSensor.clone().multiply(alignmentQuat);

  // Step 3: Extract heading error from N-Pose
  // Get forward direction in world space from corrected sensor
  const sensorForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
    nPoseSensorCorrected,
  );
  const targetForward = new THREE.Vector3(0, 0, 1).applyQuaternion(nPoseTarget);

  // Project onto XZ plane (remove Y component) for yaw calculation
  sensorForward.y = 0;
  targetForward.y = 0;

  // Handle edge case where forward is pointing straight up/down
  if (sensorForward.length() < 0.01) sensorForward.set(0, 0, 1);
  if (targetForward.length() < 0.01) targetForward.set(0, 0, 1);

  sensorForward.normalize();
  targetForward.normalize();

  // Calculate yaw correction
  const headingCorrection = new THREE.Quaternion().setFromUnitVectors(
    sensorForward,
    targetForward,
  );

  // Step 4: Combine tilt alignment and heading correction
  // Final offset = alignment * heading (apply tilt first, then heading)
  const offset = alignmentQuat.clone().premultiply(headingCorrection);

  // Step 5: Calculate quality based on how well the calibration aligns
  const tposeResult = tPoseSensor.clone().multiply(offset);
  const quality = computeCalibrationQuality(tposeResult, tPoseTarget);

  return {
    offset,
    alignmentQuat,
    headingCorrection,
    quality: quality.score,
    method: "dual-pose",
  };
}

// ============================================================================
// QUALITY METRICS
// ============================================================================

/**
 * Compute calibration quality based on angular error.
 *
 * @param actual - Actual bone orientation after applying calibration
 * @param expected - Expected bone orientation
 * @returns Quality assessment with score and metrics
 */
export function computeCalibrationQuality(
  actual: THREE.Quaternion,
  expected: THREE.Quaternion,
): CalibrationQuality {
  // Angular difference in degrees
  const angleDiff = actual.angleTo(expected) * (180 / Math.PI);

  // Quality scoring (based on biomechanics research):
  // 0-2°  = Excellent (100-95)
  // 2-5°  = Good (95-80)
  // 5-10° = Acceptable (80-50)
  // 10-20° = Poor (50-0)
  // >20° = Unacceptable (0)
  let score: number;
  if (angleDiff <= 2) {
    score = 100 - angleDiff * 2.5;
  } else if (angleDiff <= 5) {
    score = 95 - (angleDiff - 2) * 5;
  } else if (angleDiff <= 10) {
    score = 80 - (angleDiff - 5) * 6;
  } else if (angleDiff <= 20) {
    score = 50 - (angleDiff - 10) * 5;
  } else {
    score = 0;
  }

  const warnings: string[] = [];
  if (angleDiff > 10) {
    warnings.push(`High angular error: ${angleDiff.toFixed(1)}°`);
  }
  if (angleDiff > 20) {
    warnings.push("Calibration may be invalid - consider recalibrating");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    metrics: {
      angularError: angleDiff,
      sensorNoise: 0, // TODO: Calculate from sensor variance during capture
      poseConsistency: 100 - angleDiff * 2,
    },
    warnings,
  };
}

/**
 * Assess sensor stability during calibration capture.
 *
 * @param samples - Array of quaternion samples captured during pose hold
 * @returns Stability score 0-100 (higher is more stable)
 */
export function assessSensorStability(samples: THREE.Quaternion[]): number {
  if (samples.length < 2) return 100;

  // Calculate mean quaternion
  const mean = samples[0].clone();

  // Calculate angular variance from mean
  let totalVariance = 0;
  for (const sample of samples) {
    const angleDiff = sample.angleTo(mean) * (180 / Math.PI);
    totalVariance += angleDiff * angleDiff;
  }
  const stdDev = Math.sqrt(totalVariance / samples.length);

  // Score: 0° stdDev = 100, 5° stdDev = 0
  return Math.max(0, Math.min(100, 100 - stdDev * 20));
}

// ============================================================================
// PCA-BASED FUNCTIONAL CALIBRATION
// ============================================================================

/**
 * Estimate primary rotation axis from angular velocity samples using PCA.
 *
 * Used for functional calibration where subject performs joint motion
 * (e.g., knee flexion). The principal component of angular velocity
 * indicates the primary rotation axis.
 *
 * @param angularVelocities - Array of angular velocity vectors [rad/s]
 * @returns Estimated axis and confidence
 */
/**
 * Estimate primary rotation axis from angular velocity samples using PCA.
 *
 * Used for functional calibration where subject performs joint motion
 * (e.g., knee flexion). The principal component of angular velocity
 * indicates the primary rotation axis.
 *
 * Includes Soft Tissue Artifact (STA) filtering to remove >6Hz wobble.
 *
 * @param angularVelocities - Array of angular velocity vectors [rad/s]
 * @returns Estimated axis and confidence
 */
export function estimateFunctionalAxis(
  angularVelocities: THREE.Vector3[],
  enableSmoothing: boolean = true,
): FunctionalAxisResult {
  if (angularVelocities.length < 10) {
    return {
      axis: new THREE.Vector3(1, 0, 0),
      confidence: 0,
      sampleCount: angularVelocities.length,
    };
  }

  // STA Filtering: Apply Low-Pass Filter (~8Hz cutoff at 50 Hz)
  // sigma=1 → σ_t=20 ms → -3 dB at ~8 Hz.
  // This removes soft-tissue artifact (> ~8 Hz) while preserving functional
  // calibration motions (typically 1–3 Hz). sigma=2 (~4 Hz) was over-aggressive
  // and rounded the peaks of fast swings, biasing the PCA axis.
  const filteredSamples = enableSmoothing
    ? applyGaussianSmoothing(angularVelocities, 1)
    : angularVelocities;

  // Filter out near-zero samples (sensor at rest)
  const significantSamples = filteredSamples.filter(
    (v) => v.length() > 0.1, // rad/s threshold
  );

  if (significantSamples.length < 5) {
    return {
      axis: new THREE.Vector3(1, 0, 0),
      confidence: 0,
      sampleCount: significantSamples.length,
    };
  }

  // Compute covariance matrix
  // For angular velocity, principal component = primary rotation axis
  const n = significantSamples.length;

  // Step 1: Center the data (subtract mean)
  const mean = new THREE.Vector3();
  for (const v of significantSamples) {
    mean.add(v);
  }
  mean.divideScalar(n);

  // Step 2: Compute Covariance Matrix using centered data
  let xx = 0,
    xy = 0,
    xz = 0,
    yy = 0,
    yz = 0,
    zz = 0;

  for (const v of significantSamples) {
    // Centered vector
    const cx = v.x - mean.x;
    const cy = v.y - mean.y;
    const cz = v.z - mean.z;

    xx += cx * cx;
    xy += cx * cy;
    xz += cx * cz;
    yy += cy * cy;
    yz += cy * cz;
    zz += cz * cz;
  }

  xx /= n - 1;
  xy /= n - 1;
  xz /= n - 1;
  yy /= n - 1;
  yz /= n - 1;
  zz /= n - 1;

  // Power iteration to find largest eigenvector (principal component)
  let axis = new THREE.Vector3(1, 1, 1).normalize();
  const covMatrix = new THREE.Matrix3().set(xx, xy, xz, xy, yy, yz, xz, yz, zz);

  // 20 iterations usually sufficient for convergence
  for (let i = 0; i < 20; i++) {
    axis.applyMatrix3(covMatrix).normalize();
  }

  const eigenvalue1 = axis.clone().applyMatrix3(covMatrix).length();
  const trace = xx + yy + zz;
  const confidence = trace > 0 ? eigenvalue1 / trace : 0;

  return {
    axis: axis.normalize(),
    confidence: Math.min(1, confidence),
    sampleCount: significantSamples.length,
  };
}

/**
 * Apply simple Gaussian smoothing to vector array.
 * Acts as a low-pass filter for Soft Tissue Artifacts.
 * sigma=2 roughly corresponds to ~6-10Hz cutoff at 60Hz sampling.
 */
function applyGaussianSmoothing(
  samples: THREE.Vector3[],
  sigma: number = 2,
): THREE.Vector3[] {
  const output: THREE.Vector3[] = [];
  const kernelSize = Math.ceil(sigma * 3) * 2 + 1; // 3-sigma rule
  const kernel: number[] = [];
  let kernelSum = 0;

  // Generate Gaussian kernel
  for (let i = 0; i < kernelSize; i++) {
    const x = i - Math.floor(kernelSize / 2);
    const val = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel.push(val);
    kernelSum += val;
  }

  // Convolve
  const halfKernel = Math.floor(kernelSize / 2);
  for (let i = 0; i < samples.length; i++) {
    const smoothed = new THREE.Vector3(0, 0, 0);
    let weightSum = 0;

    for (let k = 0; k < kernelSize; k++) {
      const idx = i + k - halfKernel;
      if (idx >= 0 && idx < samples.length) {
        const w = kernel[k];
        smoothed.add(samples[idx].clone().multiplyScalar(w));
        weightSum += w;
      }
    }

    output.push(smoothed.divideScalar(weightSum));
  }

  return output;
}

/**
 * Create rotation quaternion to align sensor axis with anatomical axis.
 *
 * @param sensorAxis - Axis estimated from functional movement (sensor frame)
 * @param anatomicalAxis - Target anatomical axis (e.g., knee flexion axis)
 * @returns Alignment quaternion
 */
export function computeAxisAlignment(
  sensorAxis: THREE.Vector3,
  anatomicalAxis: THREE.Vector3,
): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(
    sensorAxis.clone().normalize(),
    anatomicalAxis.clone().normalize(),
  );
}

// ============================================================================
// COORDINATE FRAME UTILITIES (Re-exported from conventions.ts)
// ============================================================================

/**
 * Create a full 3D coordinate frame using Gram-Schmidt process.
 *
 * Used to construct a stable sensor-to-bone alignment where:
 * 1. Primary axis (PCA) is preserved exactly.
 * 2. Secondary axis is derived from Gravity (or another ref) to fix the "spin".
 * 3. Resulting frame is orthogonal.
 *
 * standard:
 * X = (Gram-Schmidt from Gravity)
 * Y = (Primary Axis)
 * Z = X cross Y
 *
 * @param primaryAxis - The functional axis found via PCA (e.g. Knee Flexion Axis) [Sensor Frame]
 * @param referenceVector - A reference vector (usually Gravity from Static Pose) [Sensor Frame]
 * @param targetPrimaryAxis - The axis in the bone frame that primaryAxis should align to (e.g. Vector3(1,0,0))
 * @param targetSecondaryAxis - The axis in the bone frame that referenceVector should roughly align to.
 * @returns Alignment Quaternion
 */
export function constructGramSchmidtFrame(
  primaryAxis: THREE.Vector3,
  referenceVector: THREE.Vector3,
  targetPrimaryAxis: THREE.Vector3 = new THREE.Vector3(1, 0, 0), // Default: X-axis is primary
  targetSecondaryAxis: THREE.Vector3 = new THREE.Vector3(0, -1, 0), // Default: Gravity represents Down (-Y)
): THREE.Quaternion {
  // 1. Define Sensor Frame Basis
  // Construct Secondary Axis (X) using Gram-Schmidt vs Gravity
  // X_temp = Y x Gravity

  // Basis A (Sensor Derived):
  // u = primaryAxis (normalized)
  // v = referenceVector (normalized)

  const u = primaryAxis.clone().normalize(); // Primary (e.g. Flexion Axis)
  const ref = referenceVector.clone().normalize(); // Reference (e.g. Gravity)

  // Check for parallel vectors
  if (Math.abs(u.dot(ref)) > 0.99) {
    // Fallback if axis is vertical (aligned with gravity)
    ref.set(1, 0, 0);
    if (Math.abs(u.dot(ref)) > 0.99) ref.set(0, 1, 0);
  }

  // Gram-Schmidt / Cross-Product Step
  // If Primary = Knee Flexion (Z) and Ref = Gravity (Y) -> Forward (X)

  // We construct a Rotation Matrix from the Sensor Data
  const sensor_z = u; // Primary
  const sensor_x = new THREE.Vector3().crossVectors(u, ref).normalize(); // Perpendicular 1
  const sensor_y = new THREE.Vector3()
    .crossVectors(sensor_z, sensor_x)
    .normalize(); // Perpendicular 2 (Ortho Ref)

  const sensorBasis = new THREE.Matrix4().makeBasis(
    sensor_x,
    sensor_y,
    sensor_z,
  );

  // Target Bone definition
  const u_target = targetPrimaryAxis.clone().normalize();
  const ref_target = targetSecondaryAxis.clone().normalize();

  const target_z = u_target;
  const target_x = new THREE.Vector3()
    .crossVectors(u_target, ref_target)
    .normalize();
  const target_y = new THREE.Vector3()
    .crossVectors(target_z, target_x)
    .normalize();

  const targetBasis = new THREE.Matrix4().makeBasis(
    target_x,
    target_y,
    target_z,
  );

  // R * SensorBasis = TargetBasis => R = TargetBasis * inv(SensorBasis)
  const sensorBasisInv = sensorBasis.clone().invert();
  const rotationMatrix = targetBasis.multiply(sensorBasisInv);

  return new THREE.Quaternion()
    .setFromRotationMatrix(rotationMatrix)
    .normalize();
}

// Re-exports removed during cleanup
