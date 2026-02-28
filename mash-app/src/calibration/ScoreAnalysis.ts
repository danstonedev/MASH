/**
 * SCoRE (Symmetrical Center of Rotation Estimation)
 * ==================================================
 *
 * Research-grade joint center estimation algorithm.
 * Uses movement data from two adjacent body segments to find
 * the point that remains equidistant from both during rotation.
 *
 * Reference: Ehrig et al. 2006 - "A survey of formal methods for
 * determining the centre of rotation of ball joints"
 *
 * The SCoRE algorithm finds the point C such that:
 *   |C - P1(t)|² + |C - P2(t)|² is minimized for all frames t
 *
 * Where P1 and P2 are tracked points on proximal and distal segments.
 *
 * @module SCoRE
 */

import * as THREE from "three";

// ============================================================================
// TYPES
// ============================================================================

export interface SCoREInput {
  /** Proximal segment positions over time (parent side of joint) */
  proximalPositions: THREE.Vector3[];

  /** Distal segment positions over time (child side of joint) */
  distalPositions: THREE.Vector3[];

  /** Optional: Proximal segment orientations for coordinate transform */
  proximalOrientations?: THREE.Quaternion[];

  /** Optional: Distal segment orientations */
  distalOrientations?: THREE.Quaternion[];
}

export interface SCoREResult {
  /** Estimated joint center in proximal segment local coordinates */
  jointCenterProximal: THREE.Vector3;

  /** Estimated joint center in distal segment local coordinates */
  jointCenterDistal: THREE.Vector3;

  /** Estimation confidence (0-1) based on residual error */
  confidence: number;

  /** RMS error of fit (mm) */
  rmsError: number;

  /** Number of frames used */
  frameCount: number;
}

// ============================================================================
// SCORE ALGORITHM
// ============================================================================

/**
 * Estimate joint center using the SCoRE method.
 *
 * @param input - Movement data from adjacent segments
 * @returns Joint center estimation result
 */
export function estimateJointCenter(input: SCoREInput): SCoREResult | null {
  const {
    proximalPositions,
    distalPositions,
    proximalOrientations,
    distalOrientations,
  } = input;

  // Validate inputs
  if (proximalPositions.length < 10 || distalPositions.length < 10) {
    // console.debug('[SCoRE] Insufficient data points (need at least 10 frames)');
    return null;
  }

  if (proximalPositions.length !== distalPositions.length) {
    console.warn("[SCoRE] Mismatched frame counts");
    return null;
  }

  const n = proximalPositions.length;

  // Transform positions to local coordinates if orientations provided
  let localProximal: THREE.Vector3[] = [];
  let localDistal: THREE.Vector3[] = [];

  if (proximalOrientations && distalOrientations) {
    // Transform to segment-local coordinates
    for (let i = 0; i < n; i++) {
      const pInv = proximalOrientations[i].clone().invert();
      const dInv = distalOrientations[i].clone().invert();

      localProximal.push(proximalPositions[i].clone().applyQuaternion(pInv));
      localDistal.push(distalPositions[i].clone().applyQuaternion(dInv));
    }
  } else {
    localProximal = proximalPositions;
    localDistal = distalPositions;
  }

  // Compute centroids
  const centroidProximal = computeCentroid(localProximal);
  const centroidDistal = computeCentroid(localDistal);

  // Center the data
  const centeredProximal = localProximal.map((p) =>
    p.clone().sub(centroidProximal),
  );
  const centeredDistal = localDistal.map((p) => p.clone().sub(centroidDistal));

  // Build the linear system: Ax = b
  // Where x = [cx, cy, cz] is the joint center in a combined frame
  //
  // For each frame i:
  //   |C - P1i|² = |C - P2i|² (equal distance constraint)
  //
  // Expanding:
  //   2(P2i - P1i) · C = |P2i|² - |P1i|²

  // Build A matrix (n x 3)
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < n; i++) {
    const p1 = centeredProximal[i];
    const p2 = centeredDistal[i];

    const diff = new THREE.Vector3().subVectors(p2, p1).multiplyScalar(2);

    A.push([diff.x, diff.y, diff.z]);
    b.push(p2.lengthSq() - p1.lengthSq());
  }

  // Solve using least squares: x = (A^T A)^(-1) A^T b
  const solution = solveLeastSquares(A, b);

  if (!solution) {
    console.warn("[SCoRE] Failed to solve linear system");
    return null;
  }

  const jointCenterCombined = new THREE.Vector3(
    solution[0],
    solution[1],
    solution[2],
  );

  // Transform back to segment-local coordinates
  const jointCenterProximal = jointCenterCombined.clone().add(centroidProximal);
  const jointCenterDistal = jointCenterCombined.clone().add(centroidDistal);

  // Calculate fit error
  let totalError = 0;
  for (let i = 0; i < n; i++) {
    const distProx = jointCenterCombined.distanceTo(centeredProximal[i]);
    const distDist = jointCenterCombined.distanceTo(centeredDistal[i]);
    totalError += Math.pow(distProx - distDist, 2);
  }
  const rmsError = Math.sqrt(totalError / n);

  // Confidence based on RMS error (lower = better)
  // < 5mm = excellent, < 15mm = good, > 30mm = poor
  const confidence = Math.max(0, Math.min(1, 1 - rmsError / 30));

  return {
    jointCenterProximal,
    jointCenterDistal,
    confidence,
    rmsError,
    frameCount: n,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Compute the centroid of a set of 3D points.
 */
function computeCentroid(points: THREE.Vector3[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  for (const p of points) {
    sum.add(p);
  }
  return sum.divideScalar(points.length);
}

/**
 * Solve Ax = b using least squares (normal equations).
 * Returns null if system is singular.
 */
function solveLeastSquares(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const m = A[0].length; // Should be 3

  // Compute A^T A (m x m matrix)
  const AtA: number[][] = Array(m)
    .fill(null)
    .map(() => Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += A[k][i] * A[k][j];
      }
      AtA[i][j] = sum;
    }
  }

  // Compute A^T b (m x 1 vector)
  const Atb: number[] = Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += A[k][i] * b[k];
    }
    Atb[i] = sum;
  }

  // Solve AtA * x = Atb using Gaussian elimination
  return gaussianElimination(AtA, Atb);
}

/**
 * Gaussian elimination with partial pivoting for 3x3 system.
 */
function gaussianElimination(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  // Forward elimination
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
        maxRow = row;
      }
    }

    // Swap rows
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    // Check for singular matrix
    if (Math.abs(aug[col][col]) < 1e-10) {
      return null;
    }

    // Eliminate column
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    x[i] = sum / aug[i][i];
  }

  return x;
}

// ============================================================================
// CALIBRATION MOVEMENT ANALYSIS
// ============================================================================

/**
 * Collects movement data for SCoRE calibration.
 * User performs star-arc movements (circles in different planes).
 */
export class SCoRECalibrator {
  private proximalData: THREE.Vector3[] = [];
  private distalData: THREE.Vector3[] = [];
  private proximalGyro: THREE.Vector3[] = [];
  private distalGyro: THREE.Vector3[] = [];
  private proximalQuats: THREE.Quaternion[] = [];
  private distalQuats: THREE.Quaternion[] = [];
  private timestamps: number[] = [];
  private isAccelMode: boolean = false; // Properly typed (was HACK)

  constructor(_jointId: string) {
    // Note: jointId intentionally unused - kept for API compatibility
  }

  /**
   * Add a frame of movement data.
   */
  addFrame(
    proximalPos: THREE.Vector3, // Can be accel for IMU-SCoRE
    distalPos: THREE.Vector3, // Can be accel for IMU-SCoRE
    proximalQuat?: THREE.Quaternion,
    distalQuat?: THREE.Quaternion,
    proximalGyro?: THREE.Vector3, // New
    distalGyro?: THREE.Vector3, // New
    isAccelData: boolean = false, // Flag to interpret pos as accel
    timestamp?: number, // New: Timestamp
  ): void {
    // Store input data type flag
    this.isAccelMode = isAccelData;

    // [RESEARCH: ArVEd (ArXiv 2402.04240v1) - Section III-B]
    // "Uncertainties appear in (5) when omega is negligible. In these points, M becomes antisymmetric,
    // so its determinant is zero and the system is undetermined."
    // We MUST filter out samples with low angular velocity to prevent numerical instability in the Least Squares solver.

    let avgVelocity = 0;
    if (proximalGyro && distalGyro) {
      avgVelocity = (proximalGyro.length() + distalGyro.length()) / 2;
    } else if (proximalGyro) {
      avgVelocity = proximalGyro.length();
    }

    // Threshold: 0.5 rad/s (approx 30 deg/s) as a safe lower bound for "active motion"
    if (isAccelData && avgVelocity < 0.5) {
      // Skip adding this frame to the buffers used for computation
      return;
    }

    this.proximalData.push(proximalPos.clone());
    this.distalData.push(distalPos.clone());

    if (proximalQuat) this.proximalQuats.push(proximalQuat.clone());
    if (distalQuat) this.distalQuats.push(distalQuat.clone());

    if (proximalGyro) this.proximalGyro.push(proximalGyro.clone());
    if (distalGyro) this.distalGyro.push(distalGyro.clone());

    if (timestamp !== undefined) this.timestamps.push(timestamp);
  }

  /**
   * Get current frame count.
   */
  getFrameCount(): number {
    return this.proximalData.length;
  }

  /**
   * Clear collected data.
   */
  reset(): void {
    this.proximalData = [];
    this.distalData = [];
    this.proximalGyro = [];
    this.distalGyro = [];
    this.proximalQuats = [];
    this.distalQuats = [];
    this.timestamps = [];
  }

  /**
   * Compute joint center from collected data.
   */
  compute(): SCoREResult | null {
    if ((this as any).isAccelMode) {
      // Use IMU-SCoRE (Seel et al.)
      if (this.proximalGyro.length !== this.proximalData.length) {
        console.warn("[SCoRE] IMU mode missing gyro data!");
        return null;
      }

      return estimateJointCenterIMU({
        proximalAccel: this.proximalData,
        distalAccel: this.distalData,
        proximalGyro: this.proximalGyro,
        distalGyro: this.distalGyro,
        proximalQuats: this.proximalQuats,
        distalQuats: this.distalQuats,
        timestamps: this.timestamps,
      });
    }

    const hasQuats =
      this.proximalQuats.length === this.proximalData.length &&
      this.distalQuats.length === this.distalData.length;

    return estimateJointCenter({
      proximalPositions: this.proximalData,
      distalPositions: this.distalData,
      proximalOrientations: hasQuats ? this.proximalQuats : undefined,
      distalOrientations: hasQuats ? this.distalQuats : undefined,
    });
  }
}

// ... (IMU-SCoRE Implementation below)

export interface IMUSCoREInput {
  proximalAccel: THREE.Vector3[];
  proximalGyro: THREE.Vector3[];
  proximalQuats: THREE.Quaternion[];
  distalAccel: THREE.Vector3[];
  distalGyro: THREE.Vector3[];
  distalQuats: THREE.Quaternion[];
  timestamps: number[]; // Added timestamps in seconds
}

/**
 * Estimate joint center using IMU data (Accel + Gyro).
 * Based on Seel et al. 2012: "IMU-Based Joint Angle Measurement for Gait Analysis"
 */
export function estimateJointCenterIMU(
  input: IMUSCoREInput,
): SCoREResult | null {
  const {
    proximalAccel,
    proximalGyro,
    proximalQuats,
    distalAccel,
    distalGyro,
    distalQuats,
    timestamps,
  } = input;
  const n = Math.min(
    proximalAccel.length,
    proximalGyro.length,
    proximalQuats.length,
    timestamps ? timestamps.length : 0,
  );

  if (n < 50) {
    return null; // Insufficient data
  }

  if (!timestamps || timestamps.length < n) {
    console.error("[SCoRE] Missing or insufficient timestamps");
    return null;
  }

  // Build linear system A*x = b
  const A: number[][] = [];
  const b: number[] = [];

  // Skip first/last frame for derivative
  for (let i = 1; i < n - 1; i++) {
    const tPrev = timestamps[i - 1];
    const tNext = timestamps[i + 1];
    const dt = (tNext - tPrev) / 2; // Central difference time step

    if (dt <= 0.0001) continue; // Avoid division by zero or negative dt

    const q1 = proximalQuats[i];
    const q2 = distalQuats[i];
    const a1 = proximalAccel[i];
    const a2 = distalAccel[i];
    const w1 = proximalGyro[i];
    const w2 = distalGyro[i];

    // Angular acceleration (dw) using central difference
    const dw1 = new THREE.Vector3()
      .subVectors(proximalGyro[i + 1], proximalGyro[i - 1])
      .divideScalar(2 * dt);
    const dw2 = new THREE.Vector3()
      .subVectors(distalGyro[i + 1], distalGyro[i - 1])
      .divideScalar(2 * dt);

    // K matrices (Linearized dynamics terms)
    const K1 = computeKMatrix(w1, dw1);
    const K2 = computeKMatrix(w2, dw2);

    // Transform K to Global Frame: R * K
    const RK1 = applyRotationToMatrix(q1, K1);
    const RK2 = applyRotationToMatrix(q2, K2);

    // RHS: b = R2*a2 - R1*a1
    const a1_global = a1.clone().applyQuaternion(q1);
    const a2_global = a2.clone().applyQuaternion(q2);
    const rhs = new THREE.Vector3().subVectors(a2_global, a1_global);

    // Add 3 rows
    A.push([
      RK1[0][0],
      RK1[0][1],
      RK1[0][2],
      -RK2[0][0],
      -RK2[0][1],
      -RK2[0][2],
    ]);
    b.push(rhs.x);
    A.push([
      RK1[1][0],
      RK1[1][1],
      RK1[1][2],
      -RK2[1][0],
      -RK2[1][1],
      -RK2[1][2],
    ]);
    b.push(rhs.y);
    A.push([
      RK1[2][0],
      RK1[2][1],
      RK1[2][2],
      -RK2[2][0],
      -RK2[2][1],
      -RK2[2][2],
    ]);
    b.push(rhs.z);
  }

  const x = solveLeastSquares(A, b);

  if (!x || x.length < 6) {
    // Fallback or failure
    return null;
  }

  const jointCenterProximal = new THREE.Vector3(x[0], x[1], x[2]);
  const jointCenterDistal = new THREE.Vector3(x[3], x[4], x[5]);

  // RESEARCH-GRADE: Compute actual RMS Error from fit residuals
  // For each equation row, compute predicted - actual
  let totalResidualSq = 0;
  let residualCount = 0;

  for (let rowIdx = 0; rowIdx < A.length; rowIdx++) {
    const row = A[rowIdx];
    // predicted = row · x
    let predicted = 0;
    for (let j = 0; j < 6; j++) {
      predicted += row[j] * x[j];
    }
    const actual = b[rowIdx];
    const residual = predicted - actual;
    totalResidualSq += residual * residual;
    residualCount++;
  }

  // RMS error in m/s² (acceleration units)
  const rmsError =
    residualCount > 0 ? Math.sqrt(totalResidualSq / residualCount) : 999;

  // Confidence based on RMS error:
  // < 0.5 m/s² = excellent (conf ≈ 1.0)
  // 0.5-2.0 m/s² = good (conf 0.75-1.0)
  // 2.0-5.0 m/s² = marginal (conf 0.5-0.75)
  // > 5.0 m/s² = poor (conf < 0.5)
  const confidence = Math.max(0, Math.min(1, 1 - rmsError / 5));

  console.debug(
    `[SCoRE] Joint center: rms=${rmsError.toFixed(3)} m/s², conf=${(confidence * 100).toFixed(1)}%, frames=${n}`,
  );

  return {
    jointCenterProximal,
    jointCenterDistal,
    confidence,
    rmsError,
    frameCount: n,
  };
}

function computeKMatrix(w: THREE.Vector3, dw: THREE.Vector3): number[][] {
  // Skew(w)
  // [ 0 -z  y]
  // [ z  0 -x]
  // [-y  x  0]

  // w x (w x r) = (w . r)w - (w . w)r
  // Matrix form: w * w^T - |w|^2 * I

  const wx = w.x,
    wy = w.y,
    wz = w.z;
  const wSq = w.lengthSq();

  const WxW = [
    [wx * wx - wSq, wx * wy, wx * wz],
    [wy * wx, wy * wy - wSq, wy * wz],
    [wz * wx, wz * wy, wz * wz - wSq],
  ];

  // Skew(dw)
  const SkewDW = [
    [0, -dw.z, dw.y],
    [dw.z, 0, -dw.x],
    [-dw.y, dw.x, 0],
  ];

  // K = WxW + SkewDW
  return [
    [
      WxW[0][0] + SkewDW[0][0],
      WxW[0][1] + SkewDW[0][1],
      WxW[0][2] + SkewDW[0][2],
    ],
    [
      WxW[1][0] + SkewDW[1][0],
      WxW[1][1] + SkewDW[1][1],
      WxW[1][2] + SkewDW[1][2],
    ],
    [
      WxW[2][0] + SkewDW[2][0],
      WxW[2][1] + SkewDW[2][1],
      WxW[2][2] + SkewDW[2][2],
    ],
  ];
}

// Reusable objects for matrix operations to avoid GC
const _mat3_1 = new THREE.Matrix3();
const _mat3_2 = new THREE.Matrix3();
const _mat4_1 = new THREE.Matrix4();
const _vec3_1 = new THREE.Vector3();

function applyRotationToMatrix(q: THREE.Quaternion, M: number[][]): number[][] {
  _mat3_1.set(
    M[0][0],
    M[0][1],
    M[0][2],
    M[1][0],
    M[1][1],
    M[1][2],
    M[2][0],
    M[2][1],
    M[2][2],
  );

  // Create rotation matrix from quaternion
  // setFromMatrix4 is necessary because makeRotationFromQuaternion returns Mat4
  _mat4_1.makeRotationFromQuaternion(q);
  _mat3_2.setFromMatrix4(_mat4_1);

  // Result = R * M
  _mat3_2.multiply(_mat3_1);

  const el = _mat3_2.elements;
  // Three.js elements are column-major: [0, 1, 2, 3...] => [c1r1, c1r2, c1r3, c2r1...]
  // We want row-major 2D array
  return [
    [el[0], el[3], el[6]],
    [el[1], el[4], el[7]],
    [el[2], el[5], el[8]],
  ];
}

function applyMatrixToVector(M: number[][], v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z,
    M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z,
    M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z,
  );
}

// ============================================================================
// ANATOMICAL JOINT CENTER DEFAULTS
// ============================================================================

/**
 * Default joint center offsets for common joints (mm).
 * Used when SCoRE calibration is not available.
 */
export const DEFAULT_JOINT_CENTERS: Record<
  string,
  { proximal: THREE.Vector3; distal: THREE.Vector3 }
> = {
  hip_l: {
    proximal: new THREE.Vector3(-80, -50, 0), // Relative to pelvis
    distal: new THREE.Vector3(0, 20, 0), // Relative to thigh
  },
  hip_r: {
    proximal: new THREE.Vector3(80, -50, 0),
    distal: new THREE.Vector3(0, 20, 0),
  },
  knee_l: {
    proximal: new THREE.Vector3(0, -200, 0), // Relative to thigh
    distal: new THREE.Vector3(0, 10, 0), // Relative to tibia
  },
  knee_r: {
    proximal: new THREE.Vector3(0, -200, 0),
    distal: new THREE.Vector3(0, 10, 0),
  },
  shoulder_l: {
    proximal: new THREE.Vector3(-150, 150, 0), // Relative to chest
    distal: new THREE.Vector3(0, 15, 0), // Relative to upper arm
  },
  shoulder_r: {
    proximal: new THREE.Vector3(150, 150, 0),
    distal: new THREE.Vector3(0, 15, 0),
  },
};

// ============================================================================
// SARA (Symmetrical Axis of Rotation Approach)
// ============================================================================

/**
 * Input for SARA hinge axis estimation.
 */
export interface SARAInput {
  /** Angular velocity vectors from proximal segment (parent side) in sensor local frame */
  proximalGyro: THREE.Vector3[];

  /** Angular velocity vectors from distal segment (child side) in sensor local frame */
  distalGyro: THREE.Vector3[];

  /** Proximal segment orientations (to transform axes to common frame) */
  proximalOrientations: THREE.Quaternion[];

  /** Distal segment orientations */
  distalOrientations: THREE.Quaternion[];
}

/**
 * Result of SARA axis estimation.
 */
export interface SARAResult {
  /** Hinge axis in proximal segment local coordinates */
  axisInProximal: THREE.Vector3;

  /** Hinge axis in distal segment local coordinates */
  axisInDistal: THREE.Vector3;

  /** Hinge axis in world frame (average orientation) */
  axisWorld: THREE.Vector3;

  /** Estimation confidence (0-1) based on axis agreement */
  confidence: number;

  /** Mean angular velocity magnitude during movement */
  meanAngularVelocity: number;

  /** Number of frames with significant motion used */
  frameCount: number;
}

/**
 * Estimate hinge joint axis using SARA method (Ehrig et al. 2007).
 *
 * RESEARCH-GRADE IMPLEMENTATION
 *
 * For a hinge joint, both segments rotate around the same physical axis.
 * We find axis j that minimizes: Σ ||ω₁(t) × j||² + ||ω₂(t) × j||²
 *
 * This is equivalent to finding the eigenvector with LARGEST eigenvalue
 * of the outer-product matrix: M = Σ (ω₁ ⊗ ω₁ᵀ + ω₂ ⊗ ω₂ᵀ)
 *
 * The axis is the direction where angular velocities concentrate.
 *
 * Reference: Ehrig et al. 2007 - "A survey of formal methods for
 * determining functional joint axes"
 *
 * @param input - Gyro data from parent and child sensors
 * @returns Estimated hinge axis with proper confidence, or null if estimation fails
 */
export function estimateHingeAxis(input: SARAInput): SARAResult | null {
  const { proximalGyro, distalGyro, proximalOrientations, distalOrientations } =
    input;

  // Validate inputs
  const n = Math.min(
    proximalGyro.length,
    distalGyro.length,
    proximalOrientations.length,
    distalOrientations.length,
  );

  if (n < 30) {
    console.warn("[SARA] Insufficient data points (need at least 30 frames)");
    return null;
  }

  // Minimum angular velocity threshold (rad/s) - only use frames with significant motion
  const MIN_ANGULAR_VELOCITY = 0.3; // ~17 deg/s - lowered for sensitivity

  // Build the outer-product accumulation matrix (3x3)
  // M = Σ (ω_world ⊗ ω_worldᵀ) for both sensors
  let m00 = 0,
    m01 = 0,
    m02 = 0;
  let m11 = 0,
    m12 = 0,
    m22 = 0;

  // Also accumulate for residual calculation
  const worldGyros: THREE.Vector3[] = [];
  let totalWeight = 0;
  let validFrames = 0;

  for (let i = 0; i < n; i++) {
    const gp = proximalGyro[i];
    const gd = distalGyro[i];

    // Skip frames with low motion
    const magP = gp.length();
    const magD = gd.length();
    if (magP < MIN_ANGULAR_VELOCITY && magD < MIN_ANGULAR_VELOCITY) {
      continue;
    }

    // Transform to world frame
    const gpWorld = gp.clone().applyQuaternion(proximalOrientations[i]);
    const gdWorld = gd.clone().applyQuaternion(distalOrientations[i]);

    // Weight by angular velocity magnitude (more motion = more reliable)
    const weightP = magP;
    const weightD = magD;

    // Add proximal contribution to outer-product matrix
    if (magP >= MIN_ANGULAR_VELOCITY) {
      m00 += gpWorld.x * gpWorld.x * weightP;
      m01 += gpWorld.x * gpWorld.y * weightP;
      m02 += gpWorld.x * gpWorld.z * weightP;
      m11 += gpWorld.y * gpWorld.y * weightP;
      m12 += gpWorld.y * gpWorld.z * weightP;
      m22 += gpWorld.z * gpWorld.z * weightP;
      totalWeight += weightP;
      worldGyros.push(gpWorld.clone().normalize());
    }

    // Add distal contribution
    if (magD >= MIN_ANGULAR_VELOCITY) {
      m00 += gdWorld.x * gdWorld.x * weightD;
      m01 += gdWorld.x * gdWorld.y * weightD;
      m02 += gdWorld.x * gdWorld.z * weightD;
      m11 += gdWorld.y * gdWorld.y * weightD;
      m12 += gdWorld.y * gdWorld.z * weightD;
      m22 += gdWorld.z * gdWorld.z * weightD;
      totalWeight += weightD;
      worldGyros.push(gdWorld.clone().normalize());
    }

    validFrames++;
  }

  if (validFrames < 10 || totalWeight < 1) {
    console.warn(`[SARA] Insufficient motion frames (${validFrames} < 10)`);
    return null;
  }

  // Normalize the matrix
  m00 /= totalWeight;
  m01 /= totalWeight;
  m02 /= totalWeight;
  m11 /= totalWeight;
  m12 /= totalWeight;
  m22 /= totalWeight;

  // Find principal eigenvector using power iteration
  // The matrix M is symmetric positive semi-definite
  let axis = new THREE.Vector3(1, 1, 1).normalize();
  const M = new THREE.Matrix3().set(
    m00,
    m01,
    m02,
    m01,
    m11,
    m12,
    m02,
    m12,
    m22,
  );

  // Power iteration (30 iterations for good convergence)
  for (let iter = 0; iter < 30; iter++) {
    axis.applyMatrix3(M).normalize();
  }

  // Compute the principal eigenvalue (variance along axis)
  const eigenvalue = axis.clone().applyMatrix3(M).dot(axis);
  const trace = m00 + m11 + m22;

  // Explained variance ratio = how much of total variance is along this axis
  // For a perfect hinge, this should be close to 1.0
  const explainedVariance = trace > 0 ? eigenvalue / trace : 0;

  // Compute residual: average cross-product magnitude
  // For each sample, residual = |ω × axis|² = |ω|² - (ω·axis)²
  let totalResidual = 0;
  for (const g of worldGyros) {
    const dotProduct = g.dot(axis);
    const crossMagSq = 1 - dotProduct * dotProduct; // |g|=1, so simplified
    totalResidual += Math.max(0, crossMagSq);
  }
  const meanResidual =
    worldGyros.length > 0 ? totalResidual / worldGyros.length : 1;

  // Confidence based on:
  // 1. Explained variance (how much motion is along this axis)
  // 2. Mean residual (how well samples align with axis)
  // Perfect hinge: explainedVariance ≈ 1, meanResidual ≈ 0
  const confidence = Math.min(1, explainedVariance * (1 - meanResidual));

  // Transform final world axis back to segment local frames
  const avgProxQuat = averageQuaternions(proximalOrientations.slice(0, n));
  const avgDistQuat = averageQuaternions(distalOrientations.slice(0, n));

  const axisInProximal = axis
    .clone()
    .applyQuaternion(avgProxQuat.clone().invert());
  const axisInDistal = axis
    .clone()
    .applyQuaternion(avgDistQuat.clone().invert());

  // Mean angular velocity for diagnostics
  const meanAngularVelocity = totalWeight / (validFrames * 2);

  console.debug(
    `[SARA] Hinge axis: conf=${(confidence * 100).toFixed(1)}%, ` +
      `explained=${(explainedVariance * 100).toFixed(1)}%, residual=${meanResidual.toFixed(3)}, ` +
      `frames=${validFrames}, axis=[${axis.x.toFixed(3)}, ${axis.y.toFixed(3)}, ${axis.z.toFixed(3)}]`,
  );

  return {
    axisInProximal: axisInProximal.normalize(),
    axisInDistal: axisInDistal.normalize(),
    axisWorld: axis.normalize(),
    confidence,
    meanAngularVelocity,
    frameCount: validFrames,
  };
}

/**
 * Compute weighted average axis direction.
 * Handles axis sign ambiguity by aligning all axes to first one.
 */
function computeWeightedAverageAxis(
  axes: THREE.Vector3[],
  weights: number[],
): THREE.Vector3 {
  if (axes.length === 0) return new THREE.Vector3(1, 0, 0);

  // Use first axis as reference direction
  const reference = axes[0].clone();
  const sum = new THREE.Vector3();
  let totalWeight = 0;

  for (let i = 0; i < axes.length; i++) {
    const axis = axes[i].clone();

    // Flip axis if pointing opposite to reference
    if (axis.dot(reference) < 0) {
      axis.negate();
    }

    sum.add(axis.multiplyScalar(weights[i]));
    totalWeight += weights[i];
  }

  return sum.divideScalar(totalWeight).normalize();
}

/**
 * Compute how consistently the axes point in the same direction.
 * Returns value 0-1 where 1 = perfect consistency.
 */
function computeAxisConsistency(
  axes: THREE.Vector3[],
  avgAxis: THREE.Vector3,
): number {
  if (axes.length === 0) return 0;

  let sumDot = 0;
  for (const axis of axes) {
    // Use absolute dot to handle axis sign ambiguity
    sumDot += Math.abs(axis.dot(avgAxis));
  }

  return sumDot / axes.length;
}

/**
 * Average quaternions using spherical interpolation.
 * Simple averaging for small datasets.
 */
function averageQuaternions(quats: THREE.Quaternion[]): THREE.Quaternion {
  if (quats.length === 0) return new THREE.Quaternion();
  if (quats.length === 1) return quats[0].clone();

  // Simple iterative averaging using slerp
  let avg = quats[0].clone();
  for (let i = 1; i < quats.length; i++) {
    const t = 1 / (i + 1);
    // Ensure quaternion is on same hemisphere
    if (avg.dot(quats[i]) < 0) {
      const inverted = quats[i].clone();
      inverted.x = -inverted.x;
      inverted.y = -inverted.y;
      inverted.z = -inverted.z;
      inverted.w = -inverted.w;
      avg.slerp(inverted, t);
    } else {
      avg.slerp(quats[i], t);
    }
  }

  return avg.normalize();
}

// ============================================================================
// SARA CALIBRATOR CLASS
// ============================================================================

/**
 * Collects dual-sensor movement data for SARA hinge axis estimation.
 * User performs flexion/extension movements at the joint.
 */
export class SARACalibrator {
  private proximalGyro: THREE.Vector3[] = [];
  private distalGyro: THREE.Vector3[] = [];
  private proximalQuats: THREE.Quaternion[] = [];
  private distalQuats: THREE.Quaternion[] = [];
  private jointId: string;

  constructor(jointId: string) {
    this.jointId = jointId;
  }

  /**
   * Add a frame of dual-sensor movement data.
   */
  addFrame(
    proximalGyro: THREE.Vector3,
    distalGyro: THREE.Vector3,
    proximalQuat: THREE.Quaternion,
    distalQuat: THREE.Quaternion,
  ): void {
    this.proximalGyro.push(proximalGyro.clone());
    this.distalGyro.push(distalGyro.clone());
    this.proximalQuats.push(proximalQuat.clone());
    this.distalQuats.push(distalQuat.clone());
  }

  /**
   * Get current frame count.
   */
  getFrameCount(): number {
    return this.proximalGyro.length;
  }

  /**
   * Clear collected data.
   */
  reset(): void {
    this.proximalGyro = [];
    this.distalGyro = [];
    this.proximalQuats = [];
    this.distalQuats = [];
  }

  /**
   * Compute hinge axis from collected dual-sensor data.
   */
  compute(): SARAResult | null {
    return estimateHingeAxis({
      proximalGyro: this.proximalGyro,
      distalGyro: this.distalGyro,
      proximalOrientations: this.proximalQuats,
      distalOrientations: this.distalQuats,
    });
  }
}

// ============================================================================
// JOINT PAIR DEFINITIONS
// ============================================================================

/**
 * Defines which sensor segments form joint pairs for SCoRE/SARA.
 */
export interface JointPairDefinition {
  jointId: string;
  proximalSegment: string; // Parent side sensor
  distalSegment: string; // Child side sensor
  jointType: "hinge" | "ball";
  expectedAxis?: THREE.Vector3; // Expected hinge axis in world frame (for validation)
}

/**
 * Standard joint pairs for lower/upper body.
 * Used to identify which sensor pairs to analyze together.
 */
export const JOINT_PAIRS: JointPairDefinition[] = [
  // Lower body - hinge joints
  {
    jointId: "knee_l",
    proximalSegment: "thigh_l",
    distalSegment: "tibia_l",
    jointType: "hinge",
    expectedAxis: new THREE.Vector3(1, 0, 0), // Lateral axis (X in Three.js)
  },
  {
    jointId: "knee_r",
    proximalSegment: "thigh_r",
    distalSegment: "tibia_r",
    jointType: "hinge",
    expectedAxis: new THREE.Vector3(1, 0, 0),
  },
  {
    jointId: "ankle_l",
    proximalSegment: "tibia_l",
    distalSegment: "foot_l",
    jointType: "hinge",
    expectedAxis: new THREE.Vector3(1, 0, 0),
  },
  {
    jointId: "ankle_r",
    proximalSegment: "tibia_r",
    distalSegment: "foot_r",
    jointType: "hinge",
    expectedAxis: new THREE.Vector3(1, 0, 0),
  },

  // Lower body - ball joints
  {
    jointId: "hip_l",
    proximalSegment: "pelvis",
    distalSegment: "thigh_l",
    jointType: "ball",
  },
  {
    jointId: "hip_r",
    proximalSegment: "pelvis",
    distalSegment: "thigh_r",
    jointType: "ball",
  },

  // Upper body - hinge joints
  {
    jointId: "elbow_l",
    proximalSegment: "upper_arm_l",
    distalSegment: "forearm_l",
    jointType: "hinge",
    expectedAxis: new THREE.Vector3(1, 0, 0),
  },
  {
    jointId: "elbow_r",
    proximalSegment: "upper_arm_r",
    distalSegment: "forearm_r",
    jointType: "hinge",
    expectedAxis: new THREE.Vector3(1, 0, 0),
  },

  // Upper body - ball joints
  {
    jointId: "shoulder_l",
    proximalSegment: "torso",
    distalSegment: "upper_arm_l",
    jointType: "ball",
  },
  {
    jointId: "shoulder_r",
    proximalSegment: "torso",
    distalSegment: "upper_arm_r",
    jointType: "ball",
  },
];

/**
 * Find joint pairs that can be calibrated given a set of available segments.
 */
export function findCalibrableJoints(
  availableSegments: string[],
): JointPairDefinition[] {
  const segmentSet = new Set(availableSegments.map((s) => s.toLowerCase()));

  return JOINT_PAIRS.filter(
    (joint) =>
      segmentSet.has(joint.proximalSegment.toLowerCase()) &&
      segmentSet.has(joint.distalSegment.toLowerCase()),
  );
}
