/**
 * DataMonitor.tsx — Real-time 2D data overlay for the Pipeline Inspector.
 *
 * Contains:
 *  - VQFTuningControls: Sliders for VQF sensor fusion parameters
 *  - LowPassFilterControls: Optional pre-filter noise reduction toggle
 *  - DataMonitor: Full data dashboard (raw/mapped accel, gyro, quaternion, snapshot)
 */

import { useState, useEffect } from "react";
import * as THREE from "three";
import {
  useDeviceRegistry,
  deviceAccelCache,
  deviceQuaternionCache,
  deviceGyroCache,
  deviceRawAccelCache,
  deviceRawGyroCache,
} from "../../../store/useDeviceRegistry";
import { Check, Activity, Copy } from "lucide-react";
import clsx from "clsx";
import { VQFCalibrationPanel, AxisAlignmentPanel } from "./Panels";

// ─── VQFTuningControls ───────────────────────────────────────────────────────

export function VQFTuningControls() {
  const vqfConfig = useDeviceRegistry((state) => state.vqfConfig);
  const setVQFConfig = useDeviceRegistry((state) => state.setVQFConfig);

  return (
    <div className="grid grid-cols-2 gap-3 text-[10px]">
      {/* Tau Accel */}
      <div>
        <label className="block mb-1 text-white/50">Tau Accel (s)</label>
        <input
          type="number"
          step="0.1"
          value={vqfConfig.tauAcc}
          onChange={(e) => setVQFConfig({ tauAcc: parseFloat(e.target.value) })}
          className="w-full px-2 py-1 text-white border rounded bg-white/5 border-white/10 focus:outline-hidden focus:border-accent"
        />
      </div>

      {/* Tau Mag */}
      <div>
        <label className="block mb-1 text-white/50">Tau Mag (s)</label>
        <input
          type="number"
          step="0.1"
          value={vqfConfig.tauMag}
          onChange={(e) => setVQFConfig({ tauMag: parseFloat(e.target.value) })}
          className="w-full px-2 py-1 text-white border rounded bg-white/5 border-white/10 focus:outline-hidden focus:border-accent"
        />
      </div>

      {/* Rest Th Accel */}
      <div>
        <label className="block mb-1 text-white/50">Rest Acc (m/s²)</label>
        <input
          type="number"
          step="0.05"
          value={vqfConfig.restThAcc}
          onChange={(e) =>
            setVQFConfig({ restThAcc: parseFloat(e.target.value) })
          }
          className="w-full px-2 py-1 text-white border rounded bg-white/5 border-white/10 focus:outline-hidden focus:border-accent"
        />
      </div>

      {/* Rest Th Gyro */}
      <div>
        <label className="block mb-1 text-white/50">Rest Gyro (rad/s)</label>
        <input
          type="number"
          step="0.01"
          value={vqfConfig.restThGyro}
          onChange={(e) =>
            setVQFConfig({ restThGyro: parseFloat(e.target.value) })
          }
          className="w-full px-2 py-1 text-white border rounded bg-white/5 border-white/10 focus:outline-hidden focus:border-accent"
        />
      </div>
    </div>
  );
}

// ─── LowPassFilterControls ───────────────────────────────────────────────────

export function LowPassFilterControls() {
  const lowPassEnabled = useDeviceRegistry((state) => state.lowPassEnabled);
  const lowPassCutoffHz = useDeviceRegistry((state) => state.lowPassCutoffHz);
  const setLowPassEnabled = useDeviceRegistry(
    (state) => state.setLowPassEnabled,
  );
  const setLowPassCutoffHz = useDeviceRegistry(
    (state) => state.setLowPassCutoffHz,
  );

  return (
    <div className="space-y-2 text-[10px]">
      {/* Enable Toggle */}
      <div className="flex items-center justify-between">
        <label className="text-white/50">Low-Pass Filter</label>
        <button
          onClick={() => setLowPassEnabled(!lowPassEnabled)}
          className={clsx(
            "px-2 py-1 rounded text-xs font-medium transition-colors",
            lowPassEnabled
              ? "bg-green-500/30 text-green-300 border border-green-500/50"
              : "bg-white/5 text-white/40 border border-white/10",
          )}
        >
          {lowPassEnabled ? "ON" : "OFF"}
        </button>
      </div>

      {/* Cutoff Frequency Slider (only shown when enabled) */}
      {lowPassEnabled && (
        <div>
          <div className="flex justify-between mb-1 text-white/50">
            <span>Cutoff Frequency</span>
            <span className="text-white">{lowPassCutoffHz} Hz</span>
          </div>
          <input
            type="range"
            min="1"
            max="60"
            step="1"
            value={lowPassCutoffHz}
            onChange={(e) => setLowPassCutoffHz(parseInt(e.target.value))}
            className="w-full h-1 rounded-lg appearance-none cursor-pointer bg-white/10 accent-accent"
          />
          <div className="flex justify-between text-white/30 text-[8px] mt-0.5">
            <span>1 Hz (smooth)</span>
            <span>60 Hz (responsive)</span>
          </div>
        </div>
      )}

      {/* Info */}
      <div className="text-white/30 text-[9px] italic">
        {lowPassEnabled
          ? "Reduces high-frequency noise. Lower cutoff = smoother but more lag."
          : "Enable to reduce sensor noise during tuning."}
      </div>
    </div>
  );
}

// ─── DataMonitor ──────────────────────────────────────────────────────────────

export function DataMonitor({ deviceId }: { deviceId: string }) {
  const [stats, setStats] = useState({
    // Mapped (Logical)
    ax: 0,
    ay: 0,
    az: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    // Raw (Physical)
    rawAx: 0,
    rawAy: 0,
    rawAz: 0,
    rawGx: 0,
    rawGy: 0,
    rawGz: 0,
    // Fusion
    qw: 1,
    qx: 0,
    qy: 0,
    qz: 0,
  });

  const [copied, setCopied] = useState(false);

  // Use standard rAF loop since this component lives outside the Canvas context
  useEffect(() => {
    let handle: number;
    const loop = () => {
      const a = deviceAccelCache.get(deviceId);
      const g = deviceGyroCache.get(deviceId);
      const q = deviceQuaternionCache.get(deviceId);

      // NEW: Read actual raw data from wire cache
      const rawA = deviceRawAccelCache.get(deviceId);
      const rawG = deviceRawGyroCache.get(deviceId);

      if (a && g && q) {
        // Use true raw if available, otherwise fallback to mapped (shouldn't happen)
        const rA = rawA || a;
        const rG = rawG || g;

        setStats({
          ax: a[0],
          ay: a[1],
          az: a[2],
          gx: g[0],
          gy: g[1],
          gz: g[2],
          rawAx: rA[0],
          rawAy: rA[1],
          rawAz: rA[2],
          rawGx: rG[0],
          rawGy: rG[1],
          rawGz: rG[2],
          qw: q[0],
          qx: q[1],
          qy: q[2],
          qz: q[3],
        });
      }
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [deviceId]);

  const val = (n: number) => n.toFixed(3);

  const handleSnapshot = () => {
    const { ax, ay, az, rawAx, rawAy, rawAz, qw, qx, qy, qz } = stats;
    const norm = Math.sqrt(rawAx * rawAx + rawAy * rawAy + rawAz * rawAz);

    const euler = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(qx, qy, qz, qw),
    );
    const r2d = (r: number) => ((r * 180) / Math.PI).toFixed(1);

    const report = `
### Pipeline Inspector Snapshot
**Device**: ${deviceId}
**Time**: ${new Date().toLocaleTimeString()}

**1. Physical Sensor (True Raw)**
- Vector: [${rawAx.toFixed(3)}, ${rawAy.toFixed(3)}, ${rawAz.toFixed(3)}]
- Magnitude: ${norm.toFixed(3)} m/s² (${Math.abs(norm - 9.81) < 0.5 ? "✅ Valid" : "⚠️ Invalid"})

**2. Mapped Output (Logical)**
- Vector: [${ax.toFixed(3)}, ${ay.toFixed(3)}, ${az.toFixed(3)}]
- (Should have +Y Up)

**3. Fusion Output**
- Quaternion: [${qw.toFixed(3)}, ${qx.toFixed(3)}, ${qy.toFixed(3)}, ${qz.toFixed(3)}]
- Euler: R=${r2d(euler.x)}° P=${r2d(euler.y)}° Y=${r2d(euler.z)}°
`.trim();

    navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Integrity Check
  const rawMag = Math.sqrt(
    stats.rawAx ** 2 + stats.rawAy ** 2 + stats.rawAz ** 2,
  );
  const isRawValid = Math.abs(rawMag - 9.81) < 1.0;

  return (
    <div className="p-4 font-mono text-sm border shadow-2xl bg-black/40 backdrop-blur-md border-white/10 rounded-xl text-white/90">
      <div className="flex items-center justify-between pb-2 mb-4 border-b border-white/10">
        <div className="flex items-center gap-2 text-accent">
          <Activity size={16} />
          <span className="font-bold">Pipeline Inspector</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleSnapshot}
            className={clsx(
              "p-1.5 rounded transition-all flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider",
              copied
                ? "bg-green-500/20 text-green-400"
                : "bg-white/5 hover:bg-white/10 text-white/70",
            )}
            title="Copy Snapshot to Clipboard"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "COPIED" : "SNAPSHOT"}
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {/* TRUE RAW SECTION */}
        <div>
          <div className="flex items-end justify-between mb-1">
            <div className="text-xs font-bold text-orange-400">
              PHYSICAL SENSOR (TRUE RAW)
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const registry = useDeviceRegistry.getState();
                  const currentScale = registry.sensorScales[deviceId] ?? 1.0;
                  // Protect against division by zero if sensor is dead
                  if (rawMag > 0.1) {
                    const newScale = currentScale * (9.81 / rawMag);
                    registry.setSensorScale(deviceId, newScale);
                  }
                }}
                className="px-1.5 py-0.5 rounded bg-orange-500/20 hover:bg-orange-500/30 text-[9px] text-orange-300 transition-colors uppercase font-bold border border-orange-500/30"
                title="Calibrate Magnitude to 1G (9.81 m/s²)"
              >
                Set 1G
              </button>
              <div
                className={clsx(
                  "text-[10px] px-1 rounded",
                  isRawValid
                    ? "bg-green-500/20 text-green-400"
                    : "bg-red-500/20 text-red-400",
                )}
              >
                |G| = {rawMag.toFixed(2)} {isRawValid ? "✅" : "⚠️"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 opacity-80">
            <div className="p-2 border rounded bg-orange-500/10 border-orange-500/20">
              <div className="text-[10px] text-orange-400">Phys X</div>
              {val(stats.rawAx)}
            </div>
            <div className="p-2 border rounded bg-orange-500/10 border-orange-500/20">
              <div className="text-[10px] text-orange-400">Phys Y</div>
              {val(stats.rawAy)}
            </div>
            <div className="p-2 border rounded bg-orange-500/10 border-orange-500/20">
              <div className="text-[10px] text-orange-400">Phys Z</div>
              {val(stats.rawAz)}
            </div>
          </div>
        </div>

        {/* LOGICAL MAPPED SECTION */}
        <div>
          <div className="flex items-end justify-between mb-1">
            <div className="text-xs font-bold text-blue-400">
              LOGICAL / MAPPED
            </div>
            <div className="text-[10px] text-white/40">Z-Up Map Active</div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="p-2 border rounded bg-white/5 border-white/5">
              <div className="text-[10px] text-red-400">Log X</div>
              {val(stats.ax)}
            </div>
            <div className="p-2 border rounded bg-white/5 border-white/5">
              <div className="text-[10px] text-green-400">Log Y (Up)</div>
              {val(stats.ay)}
            </div>
            <div className="p-2 border rounded bg-white/5 border-white/5">
              <div className="text-[10px] text-blue-400">Log Z</div>
              {val(stats.az)}
            </div>
          </div>
        </div>

        {/* FUSION QUAT SECTION */}
        <div>
          <div className="mb-1 text-xs font-bold text-purple-400">
            FUSION QUATERNION
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div className="p-2 border rounded bg-white/5 border-white/5">
              <div className="text-[10px] text-white/40">W</div>
              {val(stats.qw)}
            </div>
            <div className="p-2 border rounded bg-white/5 border-white/5">
              <div className="text-[10px] text-red-400">X</div>
              {val(stats.qx)}
            </div>
            <div className="p-2 border rounded bg-white/5 border-white/5">
              <div className="text-[10px] text-green-400">Y</div>
              {val(stats.qy)}
            </div>
            <div className="p-2 border rounded bg-white/5 border-white/5">
              <div className="text-[10px] text-blue-400">Z</div>
              {val(stats.qz)}
            </div>
          </div>
        </div>

        {/* CONTROLS */}
        <div className="pt-4 mt-4 border-t border-white/10">
          <div className="flex items-center justify-between mb-2 text-xs font-bold tracking-wider uppercase text-white/50">
            Fusion Tuning (VQF)
          </div>
          <VQFTuningControls />
        </div>

        {/* LOW-PASS FILTER */}
        <div className="pt-4 mt-4 border-t border-white/10">
          <div className="mb-2 text-xs font-bold tracking-wider uppercase text-white/50">
            Pre-Filter (Noise Reduction)
          </div>
          <LowPassFilterControls />
        </div>

        <VQFCalibrationPanel deviceId={deviceId} />
        <AxisAlignmentPanel deviceId={deviceId} />
      </div>
    </div>
  );
}
