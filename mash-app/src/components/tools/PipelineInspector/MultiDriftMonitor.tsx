/**
 * MultiDriftMonitor.tsx — Simultaneous drift recording for ALL connected sensors.
 *
 * Architecture (streamlined):
 *   - Single rAF loop samples all devices (replaces N independent per-card loops)
 *   - Single VQF diagnostics poll for all devices
 *   - DriftSensorCard is a pure display component (no hooks)
 *   - Auto-tune runs centrally when recording stops
 *   - Export All generates real reports from live data
 *   - Secondary charts (pitch/roll/accel/gyro) are collapsible per card
 *
 * VQF config is global — applying a tune from any card updates all filters.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import {
  deviceQuaternionCache,
  deviceGyroCache,
  deviceRawAccelCache,
  useDeviceRegistry,
  getVqfFilterDiagnostics,
  type VQFParams,
} from "../../../store/useDeviceRegistry";
import {
  Play,
  StopCircle,
  RotateCcw,
  Copy,
  Check,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Zap,
  Radio,
  Layers,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import clsx from "clsx";
import {
  type DriftSample,
  type TuneResult,
  type LiveVQFState,
  computeAutoTune,
  MiniChart,
  TunePanel,
  quatToEuler,
  unwrapAngle,
  driftColor,
  driftBorder,
  gradeColor,
  MAX_SAMPLES,
  SAMPLE_HZ,
  SAMPLE_INTERVAL_MS,
} from "./driftShared";

// ─── Per-device mutable state (lives in a ref, not React state) ───────────────

interface DeviceRecordingState {
  samples: DriftSample[];
  prevYaw: number;
  prevPitch: number;
  prevRoll: number;
  startTime: number;
}

// ─── useMultiDriftRecording ───────────────────────────────────────────────────
/**
 * Single rAF loop that samples ALL devices simultaneously.
 * Replaces N independent per-card recording hooks.
 */
function useMultiDriftRecording(
  deviceIds: string[],
  isRecording: boolean,
  vqfConfig: VQFParams,
) {
  const [samplesMap, setSamplesMap] = useState<Map<string, DriftSample[]>>(
    new Map(),
  );
  const [vqfMap, setVqfMap] = useState<Map<string, LiveVQFState>>(new Map());
  const [tuneMap, setTuneMap] = useState<Map<string, TuneResult>>(new Map());

  const stateRef = useRef(new Map<string, DeviceRecordingState>());
  const rafRef = useRef(0);
  const lastSampleMsRef = useRef(0);
  const isRecordingRef = useRef(false);
  const deviceIdsRef = useRef(deviceIds);
  const vqfConfigRef = useRef(vqfConfig);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);
  useEffect(() => {
    deviceIdsRef.current = deviceIds;
  }, [deviceIds]);
  useEffect(() => {
    vqfConfigRef.current = vqfConfig;
  }, [vqfConfig]);

  // Detect start / stop transitions
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    const wasRec = wasRecordingRef.current;
    wasRecordingRef.current = isRecording;

    if (!wasRec && isRecording) {
      // Started: reset all state
      stateRef.current.clear();
      setSamplesMap(new Map());
      setVqfMap(new Map());
      setTuneMap(new Map());
    } else if (wasRec && !isRecording) {
      // Stopped: compute auto-tune for all devices with enough data
      const tunes = new Map<string, TuneResult>();
      for (const [id, state] of stateRef.current) {
        if (state.samples.length >= 20) {
          tunes.set(id, computeAutoTune(state.samples, vqfConfigRef.current));
        }
      }
      setTuneMap(tunes);
    }
  }, [isRecording]);

  // Single rAF loop for ALL devices
  useEffect(() => {
    if (!isRecording) return;
    lastSampleMsRef.current = 0;

    const loop = (now: number) => {
      if (!isRecordingRef.current) return;

      if (now - lastSampleMsRef.current >= SAMPLE_INTERVAL_MS) {
        lastSampleMsRef.current = now;
        const updates = new Map<string, DriftSample[]>();

        for (const deviceId of deviceIdsRef.current) {
          const q = deviceQuaternionCache.get(deviceId);
          const g = deviceGyroCache.get(deviceId);
          const rawA = deviceRawAccelCache.get(deviceId);

          if (!q) {
            // No data yet — carry forward existing samples
            const existing = stateRef.current.get(deviceId);
            if (existing) updates.set(deviceId, existing.samples);
            continue;
          }

          let state = stateRef.current.get(deviceId);
          if (!state) {
            // First quaternion for this device — initialize
            const euler = quatToEuler(q[0], q[1], q[2], q[3]);
            state = {
              samples: [],
              prevYaw: euler.yaw,
              prevPitch: euler.pitch,
              prevRoll: euler.roll,
              startTime: now,
            };
            stateRef.current.set(deviceId, state);
          }

          const t = (now - state.startTime) / 1000;
          const euler = quatToEuler(q[0], q[1], q[2], q[3]);

          const yaw = unwrapAngle(state.prevYaw, euler.yaw);
          const pitch = unwrapAngle(state.prevPitch, euler.pitch);
          const roll = unwrapAngle(state.prevRoll, euler.roll);
          state.prevYaw = yaw;
          state.prevPitch = pitch;
          state.prevRoll = roll;

          const gyroMag = g ? Math.sqrt(g[0] ** 2 + g[1] ** 2 + g[2] ** 2) : 0;
          const accelMag = rawA
            ? Math.sqrt(rawA[0] ** 2 + rawA[1] ** 2 + rawA[2] ** 2)
            : 9.81;

          const first = state.samples[0];
          const sample: DriftSample = {
            t,
            yaw: yaw - (first?.yaw ?? yaw),
            pitch: pitch - (first?.pitch ?? pitch),
            roll: roll - (first?.roll ?? roll),
            gyroMag,
            accelDev: accelMag - 9.81,
          };

          state.samples = [...state.samples.slice(-(MAX_SAMPLES - 1)), sample];
          updates.set(deviceId, state.samples);
        }

        setSamplesMap(new Map(updates));
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isRecording]);

  // Single VQF diagnostics poll (200 ms)
  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => {
      const map = new Map<string, LiveVQFState>();
      for (const deviceId of deviceIdsRef.current) {
        const diag = getVqfFilterDiagnostics(deviceId);
        if (diag) {
          map.set(deviceId, {
            restDetected: diag.restDetected,
            restConfirmedFrames: diag.restConfirmedFrames,
            lastErrorDeg: diag.lastErrorDeg,
            maxErrorDeg: diag.maxErrorDeg,
          });
        }
      }
      setVqfMap(map);
    }, 200);
    return () => clearInterval(id);
  }, [isRecording]);

  const clear = useCallback(() => {
    stateRef.current.clear();
    setSamplesMap(new Map());
    setVqfMap(new Map());
    setTuneMap(new Map());
  }, []);

  return { samplesMap, vqfMap, tuneMap, clear };
}

// ─── DriftSensorCard (pure display) ───────────────────────────────────────────

interface DriftSensorCardProps {
  deviceName: string;
  samples: DriftSample[];
  isRecording: boolean;
  liveVQF: LiveVQFState | null;
  tuneResult: TuneResult | null;
  showTunePanel: boolean;
  showApplied: boolean;
  onApplyTune: () => void;
  onDismissTune: () => void;
}

function DriftSensorCard({
  deviceName,
  samples,
  isRecording,
  liveVQF,
  tuneResult,
  showTunePanel,
  showApplied,
  onApplyTune,
  onDismissTune,
}: DriftSensorCardProps) {
  const [chartsExpanded, setChartsExpanded] = useState(false);

  const hasData = samples.length > 1;
  const last = hasData ? samples[samples.length - 1] : null;
  const yawDrift = last?.yaw ?? 0;
  const pitchDrift = last?.pitch ?? 0;
  const rollDrift = last?.roll ?? 0;
  const duration = last?.t ?? 0;
  const driftRate = duration > 1 ? (yawDrift / duration) * 60 : 0;

  return (
    <div className="w-[340px] shrink-0 flex flex-col h-full font-mono text-sm border border-white/10 rounded-xl bg-black/40 backdrop-blur-md overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between bg-white/[0.03] shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {isRecording ? (
            <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse shrink-0" />
          ) : (
            <Radio size={11} className="text-purple-400 shrink-0" />
          )}
          <span className="text-[11px] font-bold text-white/80 truncate">
            {deviceName}
          </span>
        </div>
        {isRecording && (
          <span className="text-[9px] text-red-300/70 shrink-0">
            {samples.length}/{MAX_SAMPLES} · {SAMPLE_HZ} Hz
          </span>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 p-3 space-y-3 overflow-y-auto custom-scrollbar">
        {/* Drift rate — big number */}
        <div
          className={clsx(
            "p-3 rounded-lg border text-center transition-colors",
            driftBorder(driftRate, hasData),
          )}
        >
          <div className="text-[9px] text-white/30 uppercase tracking-widest mb-1">
            Yaw Drift Rate
          </div>
          <div
            className={clsx(
              "text-3xl font-bold tabular-nums",
              driftColor(driftRate, hasData),
            )}
          >
            {!hasData
              ? "—"
              : `${driftRate >= 0 ? "+" : ""}${driftRate.toFixed(2)}`}
          </div>
          <div
            className={clsx(
              "text-[10px] mt-0.5",
              driftColor(driftRate, hasData),
            )}
          >
            {!hasData ? "no data" : "°/min"}
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-1.5 text-[9px]">
          <div className="p-1.5 rounded bg-white/[0.04] border border-white/[0.06] text-center">
            <div className="text-white/25 mb-0.5">Duration</div>
            <div className="font-bold text-white/70">
              {duration.toFixed(1)}s
            </div>
          </div>
          <div className="p-1.5 rounded bg-white/[0.04] border border-white/[0.06] text-center">
            <div className="text-white/25 mb-0.5">Pitch Δ</div>
            <div
              className={clsx(
                "font-bold",
                driftColor(pitchDrift, hasData, 1, 3),
              )}
            >
              {pitchDrift >= 0 ? "+" : ""}
              {pitchDrift.toFixed(2)}°
            </div>
          </div>
          <div className="p-1.5 rounded bg-white/[0.04] border border-white/[0.06] text-center">
            <div className="text-white/25 mb-0.5">Roll Δ</div>
            <div
              className={clsx(
                "font-bold",
                driftColor(rollDrift, hasData, 1, 3),
              )}
            >
              {rollDrift >= 0 ? "+" : ""}
              {rollDrift.toFixed(2)}°
            </div>
          </div>
        </div>

        {/* Live VQF state strip (while recording) */}
        {liveVQF && (
          <div className="grid grid-cols-4 gap-1 text-[8px]">
            <div
              className={clsx(
                "px-1 py-1 rounded border text-center",
                liveVQF.restDetected
                  ? "bg-green-500/15 border-green-500/25 text-green-400"
                  : "bg-white/[0.04] border-white/[0.06] text-white/25",
              )}
            >
              <div className="text-[7px] text-white/20 mb-0.5">REST</div>
              {liveVQF.restDetected ? "YES" : "NO"}
            </div>
            <div className="px-1 py-1 rounded border bg-white/[0.04] border-white/[0.06] text-center">
              <div className="text-[7px] text-white/20 mb-0.5">CNF</div>
              <span className="text-white/50">
                {liveVQF.restConfirmedFrames}
              </span>
            </div>
            <div
              className={clsx(
                "px-1 py-1 rounded border text-center",
                liveVQF.lastErrorDeg > 10
                  ? "bg-red-500/15 border-red-500/25 text-red-400"
                  : liveVQF.lastErrorDeg > 3
                    ? "bg-yellow-500/15 border-yellow-500/25 text-yellow-400"
                    : "bg-white/[0.04] border-white/[0.06] text-white/40",
              )}
            >
              <div className="text-[7px] text-white/20 mb-0.5">TILT</div>
              {liveVQF.lastErrorDeg.toFixed(1)}°
            </div>
            <div className="px-1 py-1 rounded border bg-white/[0.04] border-white/[0.06] text-center">
              <div className="text-[7px] text-white/20 mb-0.5">PEAK</div>
              <span className="text-white/40">
                {liveVQF.maxErrorDeg.toFixed(1)}°
              </span>
            </div>
          </div>
        )}

        {/* Grade badge (after stop) */}
        {tuneResult && !isRecording && (
          <div className="flex items-center gap-1.5 text-[10px]">
            {tuneResult.grade === "research" ? (
              <CheckCircle2 size={11} className="text-green-400" />
            ) : tuneResult.grade === "marginal" ? (
              <AlertTriangle size={11} className="text-yellow-400" />
            ) : (
              <XCircle size={11} className="text-red-400" />
            )}
            <span
              className={clsx(
                "font-bold uppercase",
                gradeColor(tuneResult.grade),
              )}
            >
              {tuneResult.grade} grade
            </span>
            <span className="text-white/25">
              · {tuneResult.yawDriftRate.toFixed(1)} °/min
            </span>
          </div>
        )}

        {/* Auto-tune panel */}
        {showTunePanel && tuneResult && (
          <TunePanel
            result={tuneResult}
            onApply={onApplyTune}
            onDismiss={onDismissTune}
          />
        )}

        {/* Applied confirmation */}
        {showApplied && (
          <div className="flex items-center gap-1 text-[9px] text-green-400">
            <CheckCircle2 size={10} />
            Params applied — record again to verify
          </div>
        )}

        {/* Yaw chart (always visible) */}
        <MiniChart
          data={samples.map((s) => s.yaw)}
          color="#a78bfa"
          label="Yaw Drift"
          unit="°"
          warnThreshold={2}
          badThreshold={5}
        />

        {/* Expandable secondary charts */}
        <button
          onClick={() => setChartsExpanded((v) => !v)}
          className="flex items-center gap-1 text-[9px] text-white/30 hover:text-white/60 transition-colors w-full"
        >
          {chartsExpanded ? (
            <ChevronDown size={10} />
          ) : (
            <ChevronRight size={10} />
          )}
          {chartsExpanded ? "Hide" : "Show"} pitch, roll, accel, gyro
        </button>

        {chartsExpanded && (
          <div className="space-y-3">
            <MiniChart
              data={samples.map((s) => s.pitch)}
              color="#60a5fa"
              label="Pitch"
              unit="°"
              warnThreshold={1}
              badThreshold={3}
            />
            <MiniChart
              data={samples.map((s) => s.roll)}
              color="#34d399"
              label="Roll"
              unit="°"
              warnThreshold={1}
              badThreshold={3}
            />
            <MiniChart
              data={samples.map((s) => s.accelDev)}
              color="#fb923c"
              label="|G| Dev"
              unit=" m/s²"
              showZeroLine
              warnThreshold={0.15}
              badThreshold={0.5}
            />
            <MiniChart
              data={samples.map((s) => s.gyroMag)}
              color="#f472b6"
              label="Gyro Mag"
              unit=" rad/s"
              showZeroLine={false}
              warnThreshold={0.05}
              badThreshold={0.2}
            />
          </div>
        )}

        {/* Legend */}
        <div className="pt-2 border-t border-white/[0.06] text-[8px] text-white/20 space-y-0.5">
          <div>
            <span className="text-green-400/50">&lt;1°/min</span> research ·{" "}
            <span className="text-yellow-400/50">&lt;5°/min</span> marginal ·{" "}
            <span className="text-red-400/50">&gt;5°/min</span> unacceptable
          </div>
          <div>All curves relative to t=0. Yaw angle-unwrapped.</div>
        </div>
      </div>
    </div>
  );
}

// ─── MultiDriftMonitor ────────────────────────────────────────────────────────

interface MultiDriftMonitorProps {
  deviceIds: string[];
  deviceNames: Map<string, string>;
}

export function MultiDriftMonitor({
  deviceIds,
  deviceNames,
}: MultiDriftMonitorProps) {
  const vqfConfig = useDeviceRegistry((s) => s.vqfConfig);
  const setVQFConfig = useDeviceRegistry((s) => s.setVQFConfig);

  const [globalRecording, setGlobalRecording] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);
  const [appliedTunes, setAppliedTunes] = useState<Set<string>>(new Set());
  const [dismissedTunes, setDismissedTunes] = useState<Set<string>>(new Set());

  const { samplesMap, vqfMap, tuneMap, clear } = useMultiDriftRecording(
    deviceIds,
    globalRecording,
    vqfConfig,
  );

  const handleToggleAll = useCallback(() => {
    if (!globalRecording) {
      // Starting — clear old tune UI state
      setAppliedTunes(new Set());
      setDismissedTunes(new Set());
    }
    setGlobalRecording((prev) => !prev);
  }, [globalRecording]);

  const handleClearAll = useCallback(() => {
    setGlobalRecording(false);
    clear();
    setAppliedTunes(new Set());
    setDismissedTunes(new Set());
  }, [clear]);

  const handleExportAll = useCallback(() => {
    if (deviceIds.length === 0) return;

    const sections = deviceIds.map((id) => {
      const name = deviceNames.get(id) ?? id;
      const samples = samplesMap.get(id);
      const tune = tuneMap.get(id);

      if (!samples || samples.length < 2) {
        return `### ${name} (${id})\n_No recording data available._`;
      }

      const last = samples[samples.length - 1];
      const dur = last.t;
      const rate = dur > 0 ? (last.yaw / dur) * 60 : 0;

      const lines = [
        `### ${name} (${id})`,
        `Duration: ${dur.toFixed(1)}s · Samples: ${samples.length}`,
        `Yaw drift: ${last.yaw >= 0 ? "+" : ""}${last.yaw.toFixed(3)}° · Rate: ${rate >= 0 ? "+" : ""}${rate.toFixed(1)} °/min`,
        `Pitch Δ: ${last.pitch.toFixed(3)}° · Roll Δ: ${last.roll.toFixed(3)}°`,
      ];

      if (tune) {
        lines.push(
          `Grade: **${tune.grade.toUpperCase()}** · ${tune.diagnosis}`,
        );
        for (const r of tune.recommendations) {
          lines.push(
            `  - \`${r.param}\`: ${r.from.toFixed(4)} → ${r.to.toFixed(4)} — ${r.reason}`,
          );
        }
      }

      return lines.join("\n");
    });

    const combined = [
      `# Multi-Sensor Drift Report`,
      `**Date**: ${new Date().toLocaleString()}`,
      `**Sensors**: ${deviceIds.length}`,
      `**VQF Config**: tauAcc=${vqfConfig.tauAcc.toFixed(4)}s  restThGyro=${vqfConfig.restThGyro.toFixed(4)}rad/s  restThAcc=${vqfConfig.restThAcc.toFixed(4)}m/s²`,
      ``,
      `---`,
      ``,
      sections.join("\n\n---\n\n"),
    ].join("\n");

    navigator.clipboard.writeText(combined);
    setExportCopied(true);
    setTimeout(() => setExportCopied(false), 2500);
  }, [deviceIds, deviceNames, samplesMap, tuneMap, vqfConfig]);

  if (deviceIds.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 text-sm text-white/30">
        No sensors connected
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* Control bar */}
      <div className="h-12 flex items-center gap-3 px-4 border-b border-white/10 bg-[#111] shrink-0">
        <div className="flex items-center gap-1.5 text-purple-400 mr-1">
          <Layers size={14} />
          <span className="text-xs font-bold tracking-wider uppercase">
            Multi-Sensor Drift
          </span>
        </div>

        <div className="w-px h-5 bg-white/10" />

        <button
          onClick={handleToggleAll}
          className={clsx(
            "px-3 py-1.5 rounded text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all",
            globalRecording
              ? "bg-red-500/20 text-red-400 border border-red-500/40"
              : "bg-purple-500/20 text-purple-300 border border-purple-500/40 hover:bg-purple-500/30",
          )}
        >
          {globalRecording ? (
            <>
              <StopCircle size={12} /> Stop All
            </>
          ) : (
            <>
              <Play size={12} /> Rec All
            </>
          )}
        </button>

        <button
          onClick={handleClearAll}
          className="px-2.5 py-1.5 rounded text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 bg-white/5 hover:bg-white/10 text-white/50 hover:text-white/80 border border-transparent transition-all"
        >
          <RotateCcw size={12} /> Clear All
        </button>

        <button
          onClick={handleExportAll}
          className={clsx(
            "px-2.5 py-1.5 rounded text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all",
            exportCopied
              ? "bg-green-500/20 text-green-400 border border-green-500/30"
              : "bg-white/5 hover:bg-white/10 text-white/50 hover:text-white/80 border border-transparent",
          )}
        >
          {exportCopied ? <Check size={12} /> : <Copy size={12} />}
          {exportCopied ? "Copied!" : "Export All"}
        </button>

        <div className="ml-auto flex items-center gap-2 text-[10px] text-white/25">
          <span>
            {deviceIds.length} sensor{deviceIds.length !== 1 ? "s" : ""}
          </span>
          {globalRecording && (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-300/70">Recording</span>
            </>
          )}
        </div>

        <div className="text-[9px] text-white/20 font-mono hidden xl:block">
          tauAcc={vqfConfig.tauAcc.toFixed(3)}s · restThGyro=
          {vqfConfig.restThGyro.toFixed(4)} · restThAcc=
          {vqfConfig.restThAcc.toFixed(4)}
        </div>
      </div>

      {/* VQF shared-config note */}
      <div className="px-4 py-1.5 text-[9px] text-white/20 bg-white/[0.01] border-b border-white/[0.04] shrink-0 flex items-center gap-1.5">
        <Zap size={9} className="text-purple-400/40" />
        VQF config is shared across all sensors. Applying a tune from any card
        updates all filters simultaneously.
      </div>

      {/* Horizontally scrollable sensor cards */}
      <div className="flex-1 p-4 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full gap-4" style={{ minWidth: "max-content" }}>
          {deviceIds.map((id) => {
            const tune = tuneMap.get(id) ?? null;
            const isApplied = appliedTunes.has(id);
            const isDismissed = dismissedTunes.has(id);
            return (
              <DriftSensorCard
                key={id}
                deviceName={deviceNames.get(id) ?? id}
                samples={samplesMap.get(id) ?? []}
                isRecording={globalRecording}
                liveVQF={vqfMap.get(id) ?? null}
                tuneResult={tune}
                showTunePanel={
                  tune != null && !globalRecording && !isApplied && !isDismissed
                }
                showApplied={isApplied && !globalRecording}
                onApplyTune={() => {
                  if (tune) {
                    setVQFConfig(tune.proposedParams);
                    setAppliedTunes((prev) => new Set(prev).add(id));
                  }
                }}
                onDismissTune={() => {
                  setDismissedTunes((prev) => new Set(prev).add(id));
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
