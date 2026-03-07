/**
 * driftShared.tsx — Shared types, math, auto-tune logic, color utilities,
 * and reusable components for the drift monitoring system.
 */

import type { VQFParams } from "../../../store/useDeviceRegistry";
import { CheckCircle2, AlertTriangle, XCircle, Zap } from "lucide-react";
import clsx from "clsx";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriftSample {
  t: number;
  yaw: number;
  pitch: number;
  roll: number;
  gyroMag: number;
  accelDev: number;
}

export interface TuneRecommendation {
  param: keyof VQFParams;
  from: number;
  to: number;
  reason: string;
}

export interface TuneResult {
  grade: "research" | "marginal" | "poor";
  yawDriftRate: number;
  recommendations: TuneRecommendation[];
  proposedParams: Partial<VQFParams>;
  diagnosis: string;
}

export interface LiveVQFState {
  restDetected: boolean;
  restConfirmedFrames: number;
  lastErrorDeg: number;
  maxErrorDeg: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_SAMPLES = 600;
export const SAMPLE_HZ = 5;
export const SAMPLE_INTERVAL_MS = 1000 / SAMPLE_HZ;

// ─── Math Helpers ─────────────────────────────────────────────────────────────

function r2d(r: number) {
  return (r * 180) / Math.PI;
}

export function quatToEuler(qw: number, qx: number, qy: number, qz: number) {
  const roll = r2d(
    Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy)),
  );
  const sinP = 2 * (qw * qy - qz * qx);
  const pitch = r2d(Math.asin(Math.max(-1, Math.min(1, sinP))));
  const yaw = r2d(
    Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)),
  );
  return { roll, pitch, yaw };
}

export function unwrapAngle(prev: number, curr: number): number {
  let diff = curr - prev;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return prev + diff;
}

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx] ?? 0;
}

// ─── Color Helpers ────────────────────────────────────────────────────────────

export function driftColor(
  value: number,
  hasData: boolean,
  warn = 1,
  bad = 5,
): string {
  if (!hasData) return "text-white/20";
  return Math.abs(value) > bad
    ? "text-red-400"
    : Math.abs(value) > warn
      ? "text-yellow-400"
      : "text-green-400";
}

export function driftBorder(
  value: number,
  hasData: boolean,
  warn = 1,
  bad = 5,
): string {
  if (!hasData) return "border-white/[0.06]";
  return Math.abs(value) > bad
    ? "border-red-500/30 bg-red-500/5"
    : Math.abs(value) > warn
      ? "border-yellow-500/30 bg-yellow-500/5"
      : "border-green-500/30 bg-green-500/5";
}

export function gradeColor(grade?: TuneResult["grade"]): string {
  if (!grade) return "text-white/20";
  return grade === "research"
    ? "text-green-400"
    : grade === "marginal"
      ? "text-yellow-400"
      : "text-red-400";
}

// ─── Auto-Tune Algorithm ──────────────────────────────────────────────────────
/**
 * Analyses a drift recording and produces tuning recommendations.
 *
 * Root-cause tree:
 *  Yaw drift + low rest% -> restThGyro/restThAcc too tight
 *  Yaw drift + high rest% -> filter convergence too slow; lower tauAcc
 *  Pitch/roll drift       -> accel correction gain too low; lower tauAcc
 *  High accel noise + stable tilt -> tauAcc too low; raise it
 */
export function computeAutoTune(
  samples: DriftSample[],
  currentParams: VQFParams,
): TuneResult {
  if (samples.length < 20) {
    return {
      grade: "poor",
      yawDriftRate: 0,
      recommendations: [],
      proposedParams: {},
      diagnosis:
        "Recording too short - record at least 10 seconds at rest, then Stop.",
    };
  }

  const duration = samples[samples.length - 1].t;
  const yawDrift = Math.abs(samples[samples.length - 1].yaw);
  const pitchDrift = Math.abs(samples[samples.length - 1].pitch);
  const rollDrift = Math.abs(samples[samples.length - 1].roll);
  const yawDriftRate = duration > 1 ? (yawDrift / duration) * 60 : 0;

  const gyroMags = samples.map((s) => s.gyroMag);
  const gyroP90 = percentile(gyroMags, 0.9);

  const accelDevAbs = samples.map((s) => Math.abs(s.accelDev));
  const accelDevMean = mean(accelDevAbs);
  const accelDevStd = stdDev(accelDevAbs);

  const pctAtRest =
    gyroMags.filter((m) => m < currentParams.restThGyro).length /
    gyroMags.length;

  const recs: TuneRecommendation[] = [];
  const newParams: Partial<VQFParams> = {};

  // Rule set 1 — Yaw drift
  if (yawDriftRate > 1.0) {
    if (pctAtRest < 0.4) {
      const newThGyro = parseFloat(Math.min(gyroP90 * 2.5, 0.6).toFixed(4));
      if (newThGyro > currentParams.restThGyro + 0.001) {
        recs.push({
          param: "restThGyro",
          from: currentParams.restThGyro,
          to: newThGyro,
          reason: `P90 gyro noise = ${gyroP90.toFixed(4)} rad/s - restThGyro is below sensor noise floor, so rest detection fires only ${Math.round(pctAtRest * 100)}% of the time; heading correction never runs`,
        });
        newParams.restThGyro = newThGyro;
      }

      if (currentParams.restThAcc < accelDevMean * 2.5) {
        const newThAcc = parseFloat(
          Math.min(accelDevMean * 4.0, 1.5).toFixed(3),
        );
        recs.push({
          param: "restThAcc",
          from: currentParams.restThAcc,
          to: newThAcc,
          reason: `Mean |G| deviation = ${accelDevMean.toFixed(3)} m/s2 - restThAcc is tighter than this sensor's accel noise floor; contributes to rest detection failures`,
        });
        newParams.restThAcc = newThAcc;
      }
    } else {
      if (currentParams.tauAcc > 0.5) {
        const newTau = parseFloat(
          Math.max(currentParams.tauAcc * 0.65, 0.3).toFixed(2),
        );
        recs.push({
          param: "tauAcc",
          from: currentParams.tauAcc,
          to: newTau,
          reason: `Rest detected ${Math.round(pctAtRest * 100)}% of the time but yaw still drifts at ${yawDriftRate.toFixed(1)}°/min - lowering tauAcc increases accel correction gain (dt/tauAcc) and speeds filter convergence`,
        });
        newParams.tauAcc = newTau;
      }
    }
  }

  // Rule set 2 — Tilt drift (pitch / roll)
  if (Math.max(pitchDrift, rollDrift) > 1.5) {
    const prevTau = (newParams.tauAcc as number) ?? currentParams.tauAcc;
    if (prevTau > 0.5) {
      const newTau = parseFloat(Math.max(prevTau * 0.65, 0.3).toFixed(2));
      if (newTau < prevTau) {
        if (newParams.tauAcc === undefined) {
          recs.push({
            param: "tauAcc",
            from: currentParams.tauAcc,
            to: newTau,
            reason: `Pitch/roll drift = ${Math.max(pitchDrift, rollDrift).toFixed(2)}° - accel correction gain too low; lowering tauAcc raises gain (gain = dt / tauAcc)`,
          });
        }
        newParams.tauAcc = newTau;
      }
    }
  }

  // Rule set 3 — Noisy accel, stable tilt
  if (accelDevStd > 0.3 && Math.max(pitchDrift, rollDrift) < 0.5) {
    const prevTau = (newParams.tauAcc as number) ?? currentParams.tauAcc;
    if (prevTau < 2.0 && newParams.tauAcc === undefined) {
      const newTau = parseFloat(Math.min(prevTau * 1.5, 3.0).toFixed(2));
      recs.push({
        param: "tauAcc",
        from: currentParams.tauAcc,
        to: newTau,
        reason: `Accel sigma = ${accelDevStd.toFixed(3)} m/s2 but tilt is stable - tauAcc is too low, injecting high-freq noise; raise to damp accel weight without losing tilt accuracy`,
      });
      newParams.tauAcc = newTau;
    }
  }

  const grade: TuneResult["grade"] =
    yawDriftRate < 1.0 && Math.max(pitchDrift, rollDrift) < 1.0
      ? "research"
      : yawDriftRate < 5.0
        ? "marginal"
        : "poor";

  let diagnosis = "";
  if (grade === "research") {
    diagnosis =
      "Filter already at research grade (< 1°/min yaw, < 1° tilt drift). No changes needed.";
  } else if (pctAtRest < 0.4 && yawDriftRate > 1.0) {
    diagnosis = `Rest detection only ${Math.round(pctAtRest * 100)}% of the time - heading correction is blocked because restThGyro/restThAcc are below the sensor's own noise floor. Relax the thresholds.`;
  } else if (yawDriftRate > 1.0) {
    diagnosis = `Rest is detected (${Math.round(pctAtRest * 100)}%) but yaw drifts ${yawDriftRate.toFixed(1)}°/min. Without a magnetometer this is the primary residual. Lowering tauAcc speeds the heading-anchor correction rate.`;
  } else if (Math.max(pitchDrift, rollDrift) > 1.5) {
    diagnosis = `Yaw is good but pitch/roll drifts - accel correction gain is too low for this sensor. Lower tauAcc.`;
  } else {
    diagnosis = `Drift within acceptable range but not fully research grade. Minor filter convergence improvement possible.`;
  }

  return {
    grade,
    yawDriftRate,
    recommendations: recs,
    proposedParams: newParams,
    diagnosis,
  };
}

// ─── MiniChart ────────────────────────────────────────────────────────────────

export interface MiniChartProps {
  data: number[];
  color: string;
  label: string;
  unit: string;
  height?: number;
  showZeroLine?: boolean;
  warnThreshold?: number;
  badThreshold?: number;
}

export function MiniChart({
  data,
  color,
  label,
  unit,
  height = 56,
  showZeroLine = true,
  warnThreshold,
  badThreshold,
}: MiniChartProps) {
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center border border-white/5 rounded bg-white/[0.02] text-[10px] text-white/20"
        style={{ height }}
      >
        No data - press REC
      </div>
    );
  }

  const W = 280;
  const H = height;
  const PAD = 4;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max === min ? 1 : max - min;

  const toX = (i: number) => PAD + (i / (data.length - 1)) * innerW;
  const toY = (v: number) => PAD + (1 - (v - min) / range) * innerH;
  const points = data
    .map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`)
    .join(" ");

  const lastVal = data[data.length - 1];
  const delta = lastVal - data[0];
  const zeroScreenY = showZeroLine && min <= 0 && max >= 0 ? toY(0) : null;

  let statusColor = "text-white/70";
  if (badThreshold !== undefined && Math.abs(lastVal) > badThreshold) {
    statusColor = "text-red-400";
  } else if (warnThreshold !== undefined && Math.abs(lastVal) > warnThreshold) {
    statusColor = "text-yellow-400";
  }

  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[9px]">
        <span className="font-bold uppercase" style={{ color }}>
          {label}
        </span>
        <span className="text-white/40">
          Δ{" "}
          <span className={statusColor}>
            {delta >= 0 ? "+" : ""}
            {delta.toFixed(2)}
            {unit}
          </span>{" "}
          · last:{" "}
          <span className="text-white/70">
            {lastVal >= 0 ? "+" : ""}
            {lastVal.toFixed(2)}
            {unit}
          </span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        className="overflow-visible block"
      >
        <rect
          x={0}
          y={0}
          width={W}
          height={H}
          rx={3}
          fill="rgba(255,255,255,0.025)"
        />
        {zeroScreenY !== null && (
          <line
            x1={PAD}
            y1={zeroScreenY}
            x2={W - PAD}
            y2={zeroScreenY}
            stroke="rgba(255,255,255,0.18)"
            strokeDasharray="3,4"
            strokeWidth={0.6}
          />
        )}
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={toX(data.length - 1)}
          cy={toY(lastVal)}
          r={2.5}
          fill={color}
        />
      </svg>
    </div>
  );
}

// ─── TunePanel ────────────────────────────────────────────────────────────────

export function TunePanel({
  result,
  onApply,
  onDismiss,
}: {
  result: TuneResult;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const icon =
    result.grade === "research" ? (
      <CheckCircle2 size={13} className="text-green-400" />
    ) : result.grade === "marginal" ? (
      <AlertTriangle size={13} className="text-yellow-400" />
    ) : (
      <XCircle size={13} className="text-red-400" />
    );

  return (
    <div className="p-3 rounded-lg border border-purple-500/30 bg-purple-900/10 space-y-2.5 text-[10px]">
      {/* Grade row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {icon}
          <span
            className={clsx(
              "font-bold uppercase tracking-wider",
              gradeColor(result.grade),
            )}
          >
            {result.grade} grade
          </span>
          <span className="text-white/30">
            · {result.yawDriftRate.toFixed(1)} °/min yaw
          </span>
        </div>
        <button
          onClick={onDismiss}
          className="text-white/25 hover:text-white/60 transition-colors leading-none"
        >
          x
        </button>
      </div>

      {/* Diagnosis */}
      <p className="text-white/50 leading-snug">{result.diagnosis}</p>

      {/* Recommendations */}
      {result.recommendations.length > 0 ? (
        <>
          <div className="space-y-1.5">
            {result.recommendations.map((r, i) => (
              <div
                key={i}
                className="p-2 rounded bg-white/[0.04] border border-white/[0.06] space-y-0.5"
              >
                <div className="flex items-center gap-1 font-bold text-purple-300 font-mono">
                  <span>{r.param}</span>
                  <span className="text-white/30">
                    {r.from.toFixed(r.param === "tauAcc" ? 3 : 4)} {"→"}{" "}
                    {r.to.toFixed(r.param === "tauAcc" ? 3 : 4)}
                  </span>
                  <span className="text-white/30 font-sans font-normal">
                    {r.param === "tauAcc"
                      ? "s"
                      : r.param === "restThGyro"
                        ? "rad/s"
                        : "m/s2"}
                  </span>
                </div>
                <div className="text-white/40 leading-snug font-sans">
                  {r.reason}
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={onApply}
            className="w-full py-1.5 rounded font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/30 transition-colors"
          >
            <Zap size={11} />
            Apply All Recommendations
          </button>
        </>
      ) : (
        <div className="text-green-400/70 text-center py-0.5">
          No parameter changes needed.
        </div>
      )}
    </div>
  );
}
