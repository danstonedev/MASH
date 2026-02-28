#!/usr/bin/env node
/**
 * Offline Fusion Tuner
 *
 * Reads DebugPanel exports (schema: imu-connect.debug.capture.v1), replays a
 * 6-DoF AHRS filter on the captured accel/gyro stream, and searches for
 * parameter settings that minimize drift/jitter during stationary periods.
 *
 * Why this exists:
 * - Tune parameters without UI trial-and-error.
 * - Produce firmware-friendly settings (beta / kp / ki / ZUPT thresholds).
 *
 * Usage:
 *   node scripts/fusion_tuner.mjs <capture.json> [--device <id>] [--filter madgwick|mahony]
 *     [--trials 200] [--seed 1] [--out out.json]
 *
 * Notes:
 * - Inputs assume: gyro in rad/s, accel in m/s^2.
 * - Uses capture sampleHz / timestamps to estimate dt.
 */

import fs from 'node:fs';
import path from 'node:path';

const GRAVITY_MAGNITUDE = 9.81;
const EPS = 1e-8;

function printHelp(exitCode = 0) {
  // Keep help short; we’ll print defaults when running.
  // eslint-disable-next-line no-console
  console.log(`\nOffline Fusion Tuner\n\n` +
    `Usage:\n  node scripts/fusion_tuner.mjs <capture.json> [options]\n\n` +
    `Options:\n` +
    `  --device <id>            DeviceId to tune (default: first in file)\n` +
    `  --filter <name>          madgwick | mahony (default: madgwick)\n` +
    `  --trials <n>             Random search trials (default: 200)\n` +
    `  --seed <n>               RNG seed (default: 1)\n` +
    `  --out <file>             Write best settings + summary JSON\n` +
    `  --dump-stationary        Print stationary ratio and thresholds used\n` +
    `  -h, --help               Show help\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    capturePath: null,
    deviceId: null,
    filter: 'madgwick',
    trials: 200,
    seed: 1,
    out: null,
    dumpStationary: false,
  };

  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') printHelp(0);
    if (a === '--device') { args.deviceId = argv[++i]; continue; }
    if (a === '--filter') { args.filter = (argv[++i] || '').toLowerCase(); continue; }
    if (a === '--trials') { args.trials = Number(argv[++i]); continue; }
    if (a === '--seed') { args.seed = Number(argv[++i]); continue; }
    if (a === '--out') { args.out = argv[++i]; continue; }
    if (a === '--dump-stationary') { args.dumpStationary = true; continue; }
    if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    }
    positional.push(a);
  }

  if (positional.length > 0) args.capturePath = positional[0];
  return args;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function dot4(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function normalizeQuat(q) {
  const n = Math.sqrt(dot4(q, q));
  if (!Number.isFinite(n) || n < EPS) return [1, 0, 0, 0];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function quatMul(a, b) {
  // a ⊗ b
  const aw = a[0], ax = a[1], ay = a[2], az = a[3];
  const bw = b[0], bx = b[1], by = b[2], bz = b[3];
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

function quatConj(q) {
  return [q[0], -q[1], -q[2], -q[3]];
}

function rotateVectorByQuat(v, q) {
  // v' = q ⊗ [0,v] ⊗ conj(q)
  const vq = [0, v[0], v[1], v[2]];
  const out = quatMul(quatMul(q, vq), quatConj(q));
  return [out[1], out[2], out[3]];
}

function quatDeltaAngleRad(qPrev, qNext) {
  const dp = Math.abs(dot4(qPrev, qNext));
  const d = clamp(dp, -1, 1);
  return 2 * Math.acos(d);
}

function lcg(seed) {
  // Simple deterministic RNG.
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ============================================================================
// Filters (JS implementations matching src/lib/math)
// ============================================================================

class Madgwick6Dof {
  constructor(sampleFreq = 60.0, beta = 0.1) {
    this.sampleFreq = sampleFreq;
    this.beta = Math.max(0, beta);
    this.q = [1, 0, 0, 0];
    this.bias = [0, 0, 0];
    this.lastGatingFactor = 1.0;
    this.isStationary = false;
  }

  setBeta(beta) { if (Number.isFinite(beta)) this.beta = Math.max(0, beta); }
  getBeta() { return this.beta; }
  getLastGatingFactor() { return this.lastGatingFactor; }
  setGyroBias(bx, by, bz) { this.bias = [bx, by, bz]; }
  setStationary(s) { this.isStationary = !!s; }
  setQuaternion(q) { this.q = normalizeQuat(q); }
  getQuaternion() { return this.q; }

  computeGatingFactor(aNorm) {
    const deviation = Math.abs(aNorm - GRAVITY_MAGNITUDE);
    const GATING_THRESHOLD = 2.0; // m/s^2 (matches TS)
    if (deviation < GATING_THRESHOLD) return 1.0;
    const factor = 1.0 / (1.0 + 0.5 * deviation * deviation);
    return Math.max(0.01, factor);
  }

  expMap(wx, wy, wz, dt) {
    const omegaNorm = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const halfAngle = omegaNorm * dt * 0.5;
    if (omegaNorm < EPS) {
      return [1.0, wx * dt * 0.5, wy * dt * 0.5, wz * dt * 0.5];
    }
    const s = Math.sin(halfAngle) / omegaNorm;
    return [Math.cos(halfAngle), wx * s, wy * s, wz * s];
  }

  updateWithDelta(gx, gy, gz, ax, ay, az, dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.sampleFreq = 1.0 / dt;
    this.update(gx, gy, gz, ax, ay, az);
  }

  update(gx, gy, gz, ax, ay, az) {
    if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz) ||
        !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) {
      return;
    }

    if (this.isStationary) return;

    const dt = 1.0 / this.sampleFreq;

    const gxCorr = gx - this.bias[0];
    const gyCorr = gy - this.bias[1];
    const gzCorr = gz - this.bias[2];

    const aNorm = Math.sqrt(ax * ax + ay * ay + az * az);
    this.lastGatingFactor = this.computeGatingFactor(aNorm);
    const effectiveBeta = this.beta * this.lastGatingFactor;

    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;

    if (aNorm > 0.1) {
      const recip = 1.0 / aNorm;
      const axn = ax * recip;
      const ayn = ay * recip;
      const azn = az * recip;

      const [q0, q1, q2, q3] = this.q;
      const _2q0 = 2.0 * q0;
      const _2q1 = 2.0 * q1;
      const _2q2 = 2.0 * q2;
      const _2q3 = 2.0 * q3;
      const _4q0 = 4.0 * q0;
      const _4q1 = 4.0 * q1;
      const _4q2 = 4.0 * q2;
      const _8q1 = 8.0 * q1;
      const _8q2 = 8.0 * q2;
      const q0q0 = q0 * q0;
      const q1q1 = q1 * q1;
      const q2q2 = q2 * q2;
      const q3q3 = q3 * q3;

      s0 = _4q0 * q2q2 + _2q2 * axn + _4q0 * q1q1 - _2q1 * ayn;
      s1 = _4q1 * q3q3 - _2q3 * axn + 4.0 * q0q0 * q1 - _2q0 * ayn - _4q1 +
        _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * azn;
      s2 = 4.0 * q0q0 * q2 + _2q0 * axn + _4q2 * q3q3 - _2q3 * ayn - _4q2 +
        _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * azn;
      s3 = 4.0 * q1q1 * q3 - _2q1 * axn + 4.0 * q2q2 * q3 - _2q2 * ayn;

      const sNorm = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
      if (sNorm > EPS) {
        const sRecip = 1.0 / sNorm;
        s0 *= sRecip; s1 *= sRecip; s2 *= sRecip; s3 *= sRecip;
      }
    }

    const [q0, q1, q2, q3] = this.q;

    const omegaX = gxCorr - effectiveBeta * (2.0 * (-q1 * s0 + q0 * s1 - q3 * s2 + q2 * s3));
    const omegaY = gyCorr - effectiveBeta * (2.0 * (-q2 * s0 + q3 * s1 + q0 * s2 - q1 * s3));
    const omegaZ = gzCorr - effectiveBeta * (2.0 * (-q3 * s0 - q2 * s1 + q1 * s2 + q0 * s3));

    const delta = this.expMap(omegaX, omegaY, omegaZ, dt);
    this.q = normalizeQuat(quatMul(this.q, delta));
  }
}

class Mahony6Dof {
  constructor(sampleFreq = 60.0, kp = 1.0, ki = 0.0) {
    this.sampleFreq = sampleFreq;
    this.kp = Math.max(0, kp);
    this.ki = Math.max(0, ki);
    this.q = [1, 0, 0, 0];
    this.exInt = 0;
    this.eyInt = 0;
    this.ezInt = 0;
    this.isStationary = false;
  }

  setGains(kp, ki) {
    if (Number.isFinite(kp)) this.kp = Math.max(0, kp);
    if (Number.isFinite(ki)) this.ki = Math.max(0, ki);
  }

  getGains() { return { kp: this.kp, ki: this.ki }; }
  setStationary(s) { this.isStationary = !!s; }
  setQuaternion(q) { this.q = normalizeQuat(q); }
  getQuaternion() { return this.q; }

  updateWithDelta(gx, gy, gz, ax, ay, az, dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.sampleFreq = 1.0 / dt;
    this.update(gx, gy, gz, ax, ay, az);
  }

  update(gx, gy, gz, ax, ay, az) {
    if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz) ||
        !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) {
      return;
    }

    if (this.isStationary) return;

    const dt = 1.0 / this.sampleFreq;

    const aNorm = Math.sqrt(ax * ax + ay * ay + az * az);
    if (aNorm < EPS) return;

    const axn = ax / aNorm;
    const ayn = ay / aNorm;
    const azn = az / aNorm;

    const [q0, q1, q2, q3] = this.q;

    // estimated direction of gravity from quaternion
    const vx = 2 * (q1 * q3 - q0 * q2);
    const vy = 2 * (q0 * q1 + q2 * q3);
    const vz = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3;

    // error is cross product between measured and estimated gravity
    const ex = (ayn * vz - azn * vy);
    const ey = (azn * vx - axn * vz);
    const ez = (axn * vy - ayn * vx);

    if (this.ki > 0) {
      this.exInt += ex * dt;
      this.eyInt += ey * dt;
      this.ezInt += ez * dt;
    }

    const gxCorr = gx + this.kp * ex + this.ki * this.exInt;
    const gyCorr = gy + this.kp * ey + this.ki * this.eyInt;
    const gzCorr = gz + this.kp * ez + this.ki * this.ezInt;

    const halfDt = 0.5 * dt;
    const nq0 = q0 + (-q1 * gxCorr - q2 * gyCorr - q3 * gzCorr) * halfDt;
    const nq1 = q1 + (q0 * gxCorr + q2 * gzCorr - q3 * gyCorr) * halfDt;
    const nq2 = q2 + (q0 * gyCorr - q1 * gzCorr + q3 * gxCorr) * halfDt;
    const nq3 = q3 + (q0 * gzCorr + q1 * gyCorr - q2 * gxCorr) * halfDt;

    this.q = normalizeQuat([nq0, nq1, nq2, nq3]);

    // bleed integrator when far from 1g
    const deviation = Math.abs(aNorm - GRAVITY_MAGNITUDE);
    if (deviation > 3.0) {
      this.exInt *= 0.98;
      this.eyInt *= 0.98;
      this.ezInt *= 0.98;
    }
  }
}

// ============================================================================
// Capture parsing + scoring
// ============================================================================

function loadCapture(capturePath) {
  const text = fs.readFileSync(capturePath, 'utf8');
  const parsed = JSON.parse(text);
  if (!parsed || parsed.schema !== 'imu-connect.debug.capture.v1') {
    throw new Error(`Unsupported capture schema. Expected imu-connect.debug.capture.v1, got ${parsed?.schema}`);
  }
  if (!Array.isArray(parsed.samples) || parsed.samples.length < 5) {
    throw new Error('Capture missing samples or too short.');
  }
  return parsed;
}

function listDevices(samples) {
  const seen = new Map();
  for (const s of samples) {
    for (const d of (s.devices || [])) {
      if (!seen.has(d.deviceId)) {
        seen.set(d.deviceId, { deviceId: d.deviceId, name: d.name || d.deviceId });
      }
    }
  }
  return Array.from(seen.values());
}

function extractSeries(samples, deviceId) {
  const t = [];
  const accel = [];
  const gyro = [];
  const fwQuat = [];

  for (const s of samples) {
    const dev = (s.devices || []).find(d => d.deviceId === deviceId);
    if (!dev) continue;
    if (!Array.isArray(dev.accelerometer) || !Array.isArray(dev.gyro) || dev.accelerometer.length !== 3 || dev.gyro.length !== 3) continue;
    t.push(s.tSystemMs);
    accel.push(dev.accelerometer);
    gyro.push(dev.gyro);
    if (Array.isArray(dev.quaternion) && dev.quaternion.length === 4) fwQuat.push(dev.quaternion);
    else fwQuat.push(null);
  }

  if (t.length < 10) {
    throw new Error(`Not enough samples for device ${deviceId}. Found ${t.length}.`);
  }

  return { t, accel, gyro, fwQuat };
}

function estimateDtSec(tMs, declaredHz) {
  if (Number.isFinite(declaredHz) && declaredHz > 0) return 1.0 / declaredHz;
  // median delta
  const deltas = [];
  for (let i = 1; i < tMs.length; i++) {
    const d = (tMs[i] - tMs[i - 1]) / 1000.0;
    if (Number.isFinite(d) && d > 0 && d < 1) deltas.push(d);
  }
  deltas.sort((a, b) => a - b);
  const mid = deltas[Math.floor(deltas.length / 2)] || (1 / 50);
  return mid;
}

function computeStationaryFlags(accel, gyro, params) {
  const { zuptGyroThreshRad, zuptAccelThreshMs2, zuptMinFrames } = params;

  const flags = new Array(accel.length).fill(false);
  let run = 0;

  for (let i = 0; i < accel.length; i++) {
    const [ax, ay, az] = accel[i];
    const [gx, gy, gz] = gyro[i];

    const gMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
    const aMag = Math.sqrt(ax * ax + ay * ay + az * az);
    const aDiff = Math.abs(aMag - GRAVITY_MAGNITUDE);

    const isStat = (gMag < zuptGyroThreshRad) && (aDiff < zuptAccelThreshMs2);
    if (isStat) run++;
    else run = 0;

    flags[i] = run >= zuptMinFrames;
  }

  return flags;
}

function scoreRun({ accel, gyro, dt, filterType, params, stationaryFlags }) {
  // Build filter
  let filter;
  if (filterType === 'mahony') {
    filter = new Mahony6Dof(1 / dt, params.mahonyKp, params.mahonyKi);
  } else {
    filter = new Madgwick6Dof(1 / dt, params.madgwickBeta);
  }

  // Seed: identity (we can later seed with firmware quaternion if desired)
  filter.setQuaternion([1, 0, 0, 0]);

  let lastQ = filter.getQuaternion();
  let stationaryCount = 0;
  let stationaryAngleRateSum = 0;
  let stationaryAngleRateSqSum = 0;
  let gravityAlignSum = 0;

  for (let i = 0; i < accel.length; i++) {
    const stat = !!stationaryFlags[i];
    filter.setStationary(stat);

    const [ax, ay, az] = accel[i];
    const [gx, gy, gz] = gyro[i];

    filter.updateWithDelta(gx, gy, gz, ax, ay, az, dt);
    const q = filter.getQuaternion();

    if (stat) {
      const ang = quatDeltaAngleRad(lastQ, q);
      const rate = ang / dt;
      stationaryAngleRateSum += rate;
      stationaryAngleRateSqSum += rate * rate;

      // gravity alignment error when accel magnitude near 1g
      const aMag = Math.sqrt(ax * ax + ay * ay + az * az);
      if (aMag > EPS) {
        const aDir = [ax / aMag, ay / aMag, az / aMag];
        // predicted gravity direction in body frame: rotate world down into body.
        // assuming q is body->world, body gravity is inv(q) * [0,0,1]
        const gBody = rotateVectorByQuat([0, 0, 1], quatConj(q));
        const gNorm = Math.sqrt(gBody[0] ** 2 + gBody[1] ** 2 + gBody[2] ** 2) || 1;
        const gDir = [gBody[0] / gNorm, gBody[1] / gNorm, gBody[2] / gNorm];
        const dp = clamp(aDir[0] * gDir[0] + aDir[1] * gDir[1] + aDir[2] * gDir[2], -1, 1);
        const err = Math.acos(dp);
        gravityAlignSum += err;
      }

      stationaryCount++;
    }

    lastQ = q;
  }

  if (stationaryCount < 10) {
    // Not enough stationary data; penalize so optimizer prefers usable captures
    return { cost: 1e6, stationaryRatio: stationaryCount / accel.length };
  }

  const meanRate = stationaryAngleRateSum / stationaryCount;
  const varRate = Math.max(0, (stationaryAngleRateSqSum / stationaryCount) - meanRate * meanRate);
  const stdRate = Math.sqrt(varRate);

  const meanGravityErr = gravityAlignSum / stationaryCount;

  // Cost: keep it simple and interpretable.
  // - meanRate: drift/jitter in rad/s while stationary
  // - stdRate: penalty for jitter spikes
  // - meanGravityErr: tilt error (rad)
  const cost = (1.0 * meanRate) + (0.5 * stdRate) + (0.8 * meanGravityErr);

  return {
    cost,
    stationaryRatio: stationaryCount / accel.length,
    diagnostics: { meanRateRadPerSec: meanRate, stdRateRadPerSec: stdRate, meanGravityErrRad: meanGravityErr },
  };
}

function sampleParams(rng, filterType) {
  // Log-uniform for beta-ish gains, uniform for thresholds.
  function logUniform(min, max) {
    const u = rng();
    return Math.exp(Math.log(min) + u * (Math.log(max) - Math.log(min)));
  }

  const zuptGyroThreshRad = logUniform(0.01, 0.3);
  const zuptAccelThreshMs2 = logUniform(0.2, 4.0);
  const zuptMinFrames = Math.round(3 + rng() * 20); // 3..23

  if (filterType === 'mahony') {
    const mahonyKp = logUniform(0.1, 5.0);
    const mahonyKi = logUniform(0.0001, 0.5);
    return { filterType, mahonyKp, mahonyKi, zuptGyroThreshRad, zuptAccelThreshMs2, zuptMinFrames };
  }

  const madgwickBeta = logUniform(0.005, 1.0);
  return { filterType, madgwickBeta, zuptGyroThreshRad, zuptAccelThreshMs2, zuptMinFrames };
}

function baselineParams(filterType) {
  // From firmware/node defaults (approx)
  const base = {
    filterType,
    zuptGyroThreshRad: 0.08,
    zuptAccelThreshMs2: 0.4,
    zuptMinFrames: 10,
  };
  if (filterType === 'mahony') return { ...base, mahonyKp: 1.0, mahonyKi: 0.0 };
  return { ...base, madgwickBeta: 0.1 };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(String(e?.message || e));
    printHelp(1);
    return;
  }

  if (!args.capturePath) printHelp(1);
  if (args.filter !== 'madgwick' && args.filter !== 'mahony') {
    // eslint-disable-next-line no-console
    console.error(`Invalid --filter ${args.filter}. Use madgwick or mahony.`);
    process.exit(1);
  }
  if (!Number.isFinite(args.trials) || args.trials < 1) args.trials = 200;

  const capturePath = path.resolve(process.cwd(), args.capturePath);
  const capture = loadCapture(capturePath);

  const devices = listDevices(capture.samples);
  if (devices.length === 0) throw new Error('No devices found in capture.');

  const deviceId = args.deviceId || devices[0].deviceId;
  const deviceMeta = devices.find(d => d.deviceId === deviceId) || devices[0];

  const series = extractSeries(capture.samples, deviceId);
  const dt = estimateDtSec(series.t, capture.sampleHz);

  // eslint-disable-next-line no-console
  console.log(`[tuner] Capture: ${path.basename(capturePath)} | device=${deviceMeta.name} (${deviceId}) | dt≈${dt.toFixed(4)}s | filter=${args.filter} | trials=${args.trials}`);

  const rng = lcg(args.seed);

  let best = null;

  // Evaluate baseline first
  {
    const p = baselineParams(args.filter);
    const stationaryFlags = computeStationaryFlags(series.accel, series.gyro, p);
    const res = scoreRun({ accel: series.accel, gyro: series.gyro, dt, filterType: args.filter, params: p, stationaryFlags });
    best = { params: p, ...res };
    if (args.dumpStationary) {
      // eslint-disable-next-line no-console
      console.log(`[tuner] baseline stationaryRatio=${res.stationaryRatio.toFixed(3)}`, p);
    }
  }

  for (let i = 0; i < args.trials; i++) {
    const p = sampleParams(rng, args.filter);
    const stationaryFlags = computeStationaryFlags(series.accel, series.gyro, p);
    const res = scoreRun({ accel: series.accel, gyro: series.gyro, dt, filterType: args.filter, params: p, stationaryFlags });

    if (!best || res.cost < best.cost) {
      best = { params: p, ...res };
      // eslint-disable-next-line no-console
      console.log(`[tuner] best@${i + 1}/${args.trials} cost=${best.cost.toFixed(6)} stationaryRatio=${best.stationaryRatio.toFixed(3)} diag=${JSON.stringify(best.diagnostics)}`);
    }
  }

  const report = {
    schema: 'imu-connect.fusion.tuning.v1',
    sourceCapture: path.basename(capturePath),
    deviceId,
    filter: args.filter,
    estimatedDtSec: dt,
    objective: {
      description: 'Minimize stationary drift/jitter (quat delta rate) and gravity alignment error.',
      terms: ['mean stationary angle rate (rad/s)', 'std stationary angle rate (rad/s)', 'mean gravity alignment error (rad)'],
      weights: { meanRate: 1.0, stdRate: 0.5, gravityErr: 0.8 },
    },
    best: {
      cost: best.cost,
      stationaryRatio: best.stationaryRatio,
      diagnostics: best.diagnostics,
      params: best.params,
    },
    baseline: baselineParams(args.filter),
    notes: [
      'Gyro units assumed rad/s; accel units assumed m/s^2.',
      'Stationary detection uses ZUPT thresholds from candidate params (run-length with minFrames).',
      'If your capture has little stationary time, results will be unreliable; include a 10-20s still segment.',
    ],
  };

  // eslint-disable-next-line no-console
  console.log(`\n[tuner] DONE. Best params:`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report.best, null, 2));

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[tuner] Wrote ${outPath}`);
  }
}

try {
  main();
} catch (e) {
  // eslint-disable-next-line no-console
  console.error(`[tuner] ERROR: ${String(e?.stack || e?.message || e)}`);
  process.exit(1);
}
