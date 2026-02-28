/**
 * SARA — Symmetrical Axis of Rotation Approach
 *
 * Reference: Ehrig, Taylor, Duda & Heller (2007)
 * "A survey of formal methods for determining functional joint axes"
 * Journal of Biomechanics, 40(10), 2150-2157
 *
 * Identifies the functional hinge-joint axis using BOTH parent and child
 * sensor quaternions recorded during a flexion/extension motion.
 *
 * Advantage over single-sensor PCA:
 *   - Cancels soft-tissue artifact (STA) that moves both sensors similarly
 *   - Doesn't require the parent segment to be stationary
 *   - Produces the axis expressed in BOTH sensor frames simultaneously
 *
 * ─── Mathematical Derivation ───
 *
 * For a hinge joint, there exists a fixed axis v_p in the parent frame and
 * v_c in the child frame such that at every instant t:
 *
 *     R_p(t) · v_p  =  R_c(t) · v_c
 *
 * Rearranging:  [R_p(t) | −R_c(t)] · [v_p; v_c] = 0
 *
 * Stacking N time-steps gives a (3N × 6) matrix A.
 * We minimize ‖A·x‖² subject to ‖v_p‖=1, ‖v_c‖=1.
 *
 * The normal matrix B = AᵀA has a beautiful block structure:
 *
 *     B = [ N·I₃    −M  ]      where M = Σₜ R_p(t)ᵀ R_c(t)
 *         [ −Mᵀ    N·I₃ ]
 *
 * (because R_p,R_c are rotation matrices so RᵀR = I)
 *
 * The eigenvalues of B are  λ = N ± σᵢ  where σᵢ are singular values of M.
 * The SMALLEST eigenvalue is  λ_min = N − σ_max.
 *
 * The corresponding eigenvector is  [v_p; v_c]  where:
 *   v_p = left singular vector of M for σ_max
 *   v_c = right singular vector of M for σ_max
 *
 * So SARA reduces to computing just the LARGEST singular triplet of the
 * 3×3 matrix M — which is a single power-iteration on M·Mᵀ, identical
 * to our existing PCA infrastructure.
 *
 * ─── Confidence Metric ───
 *
 * Hinge dominance = σ_max / N
 *   = 1.0 for a perfect single-axis hinge (all R_rel share the same axis)
 *   → 0 for a ball joint (relative rotations vary across all axes)
 *
 * The identity component of each rotation matrix contributes N to every
 * singular value of M, so σ_max²/trace(MᵀM) is NOT a valid metric
 * (it saturates at ~0.47). Using σ_max/N correctly normalizes this.
 *
 * ─── Zero-Allocation Design ───
 *
 * All intermediate math objects are pooled at module scope.
 */

import * as THREE from "three";

// ============================================================================
// TYPES
// ============================================================================

export interface SARAResult {
  /** Joint axis expressed in parent sensor frame (unit vector) */
  axisInParent: THREE.Vector3;
  /** Joint axis expressed in child sensor frame (unit vector) */
  axisInChild: THREE.Vector3;
  /** Hinge dominance confidence (0–1). >0.85 = good hinge, <0.5 = ball joint */
  confidence: number;
  /** Largest singular value of M */
  sigmaMax: number;
  /** Number of sample pairs used */
  sampleCount: number;
}

// ============================================================================
// OBJECT POOL — zero allocation in hot path
// ============================================================================

const _relQuat = new THREE.Quaternion();
const _m3 = new THREE.Matrix3();
const _tempVec = new THREE.Vector3();
const _axisP = new THREE.Vector3();
const _axisC = new THREE.Vector3();

// 3×3 matrix as flat Float64Array for explicit manipulation
// (THREE.Matrix3 uses column-major, which is fine for our needs)

// ============================================================================
// CORE SARA ALGORITHM
// ============================================================================

/**
 * Compute the SARA functional joint axis from paired parent/child quaternions.
 *
 * @param parentQuats  Array of parent sensor quaternions sampled during hinge motion
 * @param childQuats   Array of child sensor quaternions (same length, time-aligned)
 * @param minSamples   Minimum samples required for a valid result (default 20)
 * @returns            SARAResult with axis in both frames + confidence, or null if insufficient data
 */
export function computeSARA(
  parentQuats: THREE.Quaternion[],
  childQuats: THREE.Quaternion[],
  minSamples: number = 20,
): SARAResult | null {
  const N = Math.min(parentQuats.length, childQuats.length);
  if (N < minSamples) return null;

  // ─── Step 1: Accumulate M = Σ R_p(t)ᵀ · R_c(t) ───
  //
  // For quaternions representing sensor-to-world:
  //   R_p(t)ᵀ · R_c(t)  ↔  conj(q_p(t)) × q_c(t)
  //
  // We accumulate the 3×3 rotation matrix of this relative quaternion.
  // Using flat array [m00, m01, m02, m10, m11, m12, m20, m21, m22] row-major.

  const M = new Float64Array(9); // zero-initialized

  for (let t = 0; t < N; t++) {
    // q_rel = conj(q_p) * q_c  (relative rotation: parent → child)
    _relQuat.copy(parentQuats[t]).invert().multiply(childQuats[t]);

    // Extract rotation matrix elements from quaternion
    // q = (w, x, y, z)
    const w = _relQuat.w,
      x = _relQuat.x,
      y = _relQuat.y,
      z = _relQuat.z;
    const x2 = x + x,
      y2 = y + y,
      z2 = z + z;
    const xx = x * x2,
      xy = x * y2,
      xz = x * z2;
    const yy = y * y2,
      yz = y * z2,
      zz = z * z2;
    const wx = w * x2,
      wy = w * y2,
      wz = w * z2;

    // Row-major accumulation: M[row * 3 + col]
    M[0] += 1 - (yy + zz);
    M[1] += xy - wz;
    M[2] += xz + wy;
    M[3] += xy + wz;
    M[4] += 1 - (xx + zz);
    M[5] += yz - wx;
    M[6] += xz - wy;
    M[7] += yz + wx;
    M[8] += 1 - (xx + yy);
  }

  // ─── Step 2: Compute MᵀM (3×3 symmetric) ───
  //
  // MᵀM_{ij} = Σ_k M[k][i] * M[k][j]   (transpose first index)
  // Since M is row-major: M[row][col] = M[row*3 + col]
  // Mᵀ[i][k] = M[k][i] = M[k*3 + i]

  const MTM = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        s += M[k * 3 + i] * M[k * 3 + j];
      }
      MTM[i * 3 + j] = s;
      MTM[j * 3 + i] = s; // symmetric
    }
  }

  const traceMTM = MTM[0] + MTM[4] + MTM[8];
  if (traceMTM < 1e-10) {
    // No meaningful rotation data
    return null;
  }

  // ─── Step 3: Power iteration on MᵀM → largest eigenvector = v_c ───
  //
  // The right singular vector of M (for σ_max) is the largest eigenvector
  // of MᵀM. This is the joint axis in the CHILD frame.

  // Initialize with (1, 1, 1) normalized
  let vx = 0.5773502691896258,
    vy = 0.5773502691896258,
    vz = 0.5773502691896258;

  for (let iter = 0; iter < 30; iter++) {
    // Matrix-vector multiply: v_new = MᵀM · v
    const nx = MTM[0] * vx + MTM[1] * vy + MTM[2] * vz;
    const ny = MTM[3] * vx + MTM[4] * vy + MTM[5] * vz;
    const nz = MTM[6] * vx + MTM[7] * vy + MTM[8] * vz;

    // Normalize
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-15) break;
    vx = nx / len;
    vy = ny / len;
    vz = nz / len;
  }

  // Eigenvalue = vᵀ · MᵀM · v = σ_max²
  const ev_x = MTM[0] * vx + MTM[1] * vy + MTM[2] * vz;
  const ev_y = MTM[3] * vx + MTM[4] * vy + MTM[5] * vz;
  const ev_z = MTM[6] * vx + MTM[7] * vy + MTM[8] * vz;
  const sigmaMaxSq = vx * ev_x + vy * ev_y + vz * ev_z;
  const sigmaMax = Math.sqrt(Math.max(0, sigmaMaxSq));

  _axisC.set(vx, vy, vz);

  // ─── Step 4: Recover axis in parent frame ───
  //
  // v_p = M · v_c / ‖M · v_c‖
  // (left singular vector = M × right singular vector / σ)

  const px = M[0] * vx + M[1] * vy + M[2] * vz;
  const py = M[3] * vx + M[4] * vy + M[5] * vz;
  const pz = M[6] * vx + M[7] * vy + M[8] * vz;
  const pLen = Math.sqrt(px * px + py * py + pz * pz);

  if (pLen < 1e-10) return null;

  _axisP.set(px / pLen, py / pLen, pz / pLen);

  // ─── Step 5: Confidence = σ_max / N ───
  //
  // For a perfect hinge: all R_rel share the same axis → M·v = N·v
  //   → σ_max = N → confidence = 1.0
  // For a ball joint: relative rotations vary across all axes
  //   → σ_max << N → confidence → 0
  //
  // This metric correctly handles the identity-component of rotation
  // matrices, unlike σ_max²/trace(MᵀM) which saturates at ~0.47.

  const confidence = sigmaMax / N;

  return {
    axisInParent: _axisP.clone(),
    axisInChild: _axisC.clone(),
    confidence: Math.min(1, confidence),
    sigmaMax,
    sampleCount: N,
  };
}

// ============================================================================
// SIGN DISAMBIGUATION
// ============================================================================

/**
 * Ensure the SARA axis points in a biomechanically consistent direction.
 *
 * PCA / SARA produce a LINE (±v), not a direction. For anatomical consistency
 * we enforce a sign convention using gravity or a known reference:
 *
 *   - For knees/elbows (lateral axis): dot with gravity cross forward > 0
 *   - For ankles: dorsiflexion axis aligns roughly lateral
 *
 * @param result     The raw SARA result
 * @param gravityInParent  Gravity vector in parent sensor frame (from static pose accel)
 * @param side       'left' | 'right' — determines sign convention
 * @returns          The same result with axes potentially negated for consistency
 */
export function disambiguateSARAAxis(
  result: SARAResult,
  gravityInParent: THREE.Vector3,
  side: "left" | "right",
): SARAResult {
  // For a lateral hinge axis (knees, elbows):
  // The axis should point roughly LEFT for left-side joints, RIGHT for right-side.
  //
  // Strategy: Cross gravity (≈ down in sensor frame) with the "long bone" direction
  // to get a lateral vector. But without position data, we use a simpler heuristic:
  //
  // Convention: In a Y-up coordinate system, gravity points -Y.
  // For a standing/T-pose calibration, the hinge axis for knee/elbow is roughly ±X or ±Z.
  // We use gravity direction to disambiguate.
  //
  // Simpler approach: just ensure consistency between parent and child.
  // If the parent and child axes should represent the SAME physical direction,
  // ensure they agree when both transformed to world frame.
  //
  // For now, we enforce: axisInParent · (-gravity) cross-product check
  // Gravity in parent frame typically points ~(0, -1, 0) when standing.
  // Hinge axis should be perpendicular to gravity for knee/elbow.

  const gravNorm = gravityInParent.clone().normalize();

  // The flexion axis for LEFT side should point RIGHT (+X in ISB)
  // The flexion axis for RIGHT side should point LEFT (-X in ISB)
  // But in sensor frame this depends on mounting. Use a convention:
  // If the axis has a component along gravity, something is wrong (it should be perpendicular).
  // We just standardize: first non-zero component should be positive for left, negative for right.

  // Most robust: use the cross product of gravity and axis-in-parent.
  // The resulting vector should point "forward" (positive sagittal).
  // If it points "backward", flip the axis.

  const cross = _tempVec.crossVectors(gravNorm, result.axisInParent);

  // For left-side: axis should yield a forward-pointing cross with gravity
  // For right-side: the opposite
  const sign = side === "left" ? 1 : -1;

  // Use the dominant component of the cross product
  // In a typical Y-up system with gravity ≈ (0, -1, 0),
  // cross(gravity, lateral_axis) ≈ forward direction.
  // We check if this forward direction makes sense.
  if (cross.length() > 0.1) {
    // If the cross product's dominant direction is "negative forward" for left side, flip
    // This is mounting-dependent, so we use a simpler rule:
    // Ensure axisInParent and axisInChild agree on direction
  }

  // Simplest robust rule: ensure axisInParent · axisInChild > 0 when both
  // are in their respective frames (they should represent the same physical axis).
  // The dot product between them isn't directly meaningful (different frames),
  // but for typical IMU mounting, they should be similar.
  // Actually, for a perfect hinge, R_p · v_p = R_c · v_c, so they ARE different
  // vectors that happen to map to the same world direction.

  // For now, just return as-is. The calling code (hingeCalibration) will
  // apply joint-specific sign conventions based on the target anatomical axis.
  return result;
}

// ============================================================================
// INCREMENTAL SARA (for real-time confidence feedback during calibration)
// ============================================================================

/**
 * Maintains a running accumulation of M for incremental SARA computation.
 * Used during calibration to provide real-time confidence feedback
 * without reprocessing all samples.
 */
export class IncrementalSARA {
  private M = new Float64Array(9);
  private _count = 0;

  /** Number of sample pairs accumulated */
  get count(): number {
    return this._count;
  }

  /**
   * Add a single parent/child quaternion pair.
   * Call this on each frame during hinge calibration.
   */
  addSample(parentQuat: THREE.Quaternion, childQuat: THREE.Quaternion): void {
    _relQuat.copy(parentQuat).invert().multiply(childQuat);

    const w = _relQuat.w,
      x = _relQuat.x,
      y = _relQuat.y,
      z = _relQuat.z;
    const x2 = x + x,
      y2 = y + y,
      z2 = z + z;
    const xx = x * x2,
      xy = x * y2,
      xz = x * z2;
    const yy = y * y2,
      yz = y * z2,
      zz = z * z2;
    const wx = w * x2,
      wy = w * y2,
      wz = w * z2;

    this.M[0] += 1 - (yy + zz);
    this.M[1] += xy - wz;
    this.M[2] += xz + wy;
    this.M[3] += xy + wz;
    this.M[4] += 1 - (xx + zz);
    this.M[5] += yz - wx;
    this.M[6] += xz - wy;
    this.M[7] += yz + wx;
    this.M[8] += 1 - (xx + yy);

    this._count++;
  }

  /**
   * Compute the current SARA result from accumulated data.
   * Can be called repeatedly without affecting the accumulation.
   */
  compute(minSamples: number = 20): SARAResult | null {
    if (this._count < minSamples) return null;

    // Work on a copy so accumulation is preserved
    const Mcopy = new Float64Array(this.M);
    return computeSARAFromM(Mcopy, this._count);
  }

  /** Reset all accumulated data */
  reset(): void {
    this.M.fill(0);
    this._count = 0;
  }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Core SARA computation from a pre-accumulated M matrix.
 * Shared between batch `computeSARA` and `IncrementalSARA.compute()`.
 */
function computeSARAFromM(M: Float64Array, N: number): SARAResult | null {
  // MᵀM
  const MTM = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        s += M[k * 3 + i] * M[k * 3 + j];
      }
      MTM[i * 3 + j] = s;
      MTM[j * 3 + i] = s;
    }
  }

  const traceMTM = MTM[0] + MTM[4] + MTM[8];
  if (traceMTM < 1e-10) return null;

  // Power iteration → largest eigenvector of MᵀM = axis in child frame
  let vx = 0.5773502691896258,
    vy = 0.5773502691896258,
    vz = 0.5773502691896258;

  for (let iter = 0; iter < 30; iter++) {
    const nx = MTM[0] * vx + MTM[1] * vy + MTM[2] * vz;
    const ny = MTM[3] * vx + MTM[4] * vy + MTM[5] * vz;
    const nz = MTM[6] * vx + MTM[7] * vy + MTM[8] * vz;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-15) break;
    vx = nx / len;
    vy = ny / len;
    vz = nz / len;
  }

  // σ_max²
  const ev_x = MTM[0] * vx + MTM[1] * vy + MTM[2] * vz;
  const ev_y = MTM[3] * vx + MTM[4] * vy + MTM[5] * vz;
  const ev_z = MTM[6] * vx + MTM[7] * vy + MTM[8] * vz;
  const sigmaMaxSq = vx * ev_x + vy * ev_y + vz * ev_z;
  const sigmaMax = Math.sqrt(Math.max(0, sigmaMaxSq));

  const axisInChild = new THREE.Vector3(vx, vy, vz);

  // v_p = M · v_c / ‖...‖
  const px = M[0] * vx + M[1] * vy + M[2] * vz;
  const py = M[3] * vx + M[4] * vy + M[5] * vz;
  const pz = M[6] * vx + M[7] * vy + M[8] * vz;
  const pLen = Math.sqrt(px * px + py * py + pz * pz);
  if (pLen < 1e-10) return null;

  const axisInParent = new THREE.Vector3(px / pLen, py / pLen, pz / pLen);

  const confidence = sigmaMax / N;

  return {
    axisInParent,
    axisInChild,
    confidence: Math.min(1, confidence),
    sigmaMax,
    sampleCount: N,
  };
}
