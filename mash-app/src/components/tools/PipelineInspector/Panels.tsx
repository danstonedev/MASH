/**
 * Panels.tsx — Control panels for the Pipeline Inspector sidebar.
 *
 * Contains:
 *  - SegmentSelector: Dropdown to assign a body segment to a device
 *  - FrameOptionsPanel: Toggle sensor/body frame visibility
 *  - VQFCalibrationPanel: Auto-tune VQF rest-detection thresholds
 *  - AxisAlignmentPanel: Detect and fix axis permutations / tare
 */

import { useState, useMemo } from "react";
import {
  useDeviceRegistry,
  deviceAccelCache,
  deviceGyroCache,
} from "../../../store/useDeviceRegistry";
import {
  useSensorAssignmentStore,
  ROLE_TO_SEGMENT,
} from "../../../store/useSensorAssignmentStore";
import { BodyRole } from "../../../biomech/topology/SensorRoles";
import type { SegmentId } from "../../../biomech/segmentRegistry";
import { Link, Box } from "lucide-react";
import clsx from "clsx";

// ─── SegmentSelector ──────────────────────────────────────────────────────────

export function SegmentSelector({ deviceId }: { deviceId: string }) {
  const assignments = useSensorAssignmentStore((s) => s.assignments);
  const assign = useSensorAssignmentStore((s) => s.assign);
  // FIX: Use bodyRole as the source of truth for selection, as SegmentId is not unique (e.g. Foot vs Skate)
  const currentRole = assignments.get(deviceId)?.bodyRole;

  // Convert ROLE_TO_SEGMENT to list options
  const options = useMemo(() => {
    const list = Object.entries(ROLE_TO_SEGMENT).map(([role, segId]) => ({
      role: role as unknown as BodyRole,
      segmentId: segId as SegmentId,
      // Distinguish aliases (e.g. Foot vs Skate) in the label
      label: `${segId.toUpperCase().replace("_", " ")} (${role})`,
    }));
    // Sort alphabetically by label
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, []);

  return (
    <div className="pt-4 mt-4 border-t border-white/10">
      <div className="flex items-center gap-2 mb-2 text-xs font-bold tracking-wider uppercase text-white/50">
        <Link size={12} />
        Body Assignment
      </div>

      <div className="relative">
        <select
          value={currentRole || ""}
          onChange={(e) => {
            const role = e.target.value as BodyRole;
            // Direct assignment by Role (unambiguous)
            if (role) {
              assign(deviceId, role, "manual");
            }
          }}
          className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white focus:outline-hidden focus:border-accent appearance-none cursor-pointer hover:bg-white/10 transition-colors"
        >
          <option value="" disabled>
            -- Select Body Part --
          </option>
          {options.map((opt) => (
            // FIX: Use role as key (unique), not segmentId (duplicated for aliases)
            <option key={opt.role} value={opt.role}>
              {opt.label}
            </option>
          ))}
        </select>
        <div className="absolute -translate-y-1/2 pointer-events-none right-2 top-1/2 text-white/40">
          ▼
        </div>
      </div>
    </div>
  );
}

// ─── FrameOptionsPanel ────────────────────────────────────────────────────────

export function FrameOptionsPanel({
  options,
  setOptions,
}: {
  options: { showSensor: boolean; showBody: boolean };
  setOptions: React.Dispatch<
    React.SetStateAction<{ showSensor: boolean; showBody: boolean }>
  >;
}) {
  return (
    <div className="pt-4 mt-4 border-t border-white/10">
      <div className="flex items-center gap-2 mb-2 text-xs font-bold tracking-wider uppercase text-white/50">
        <Box size={12} />
        View Options
      </div>
      <div className="flex gap-2 text-[10px]">
        <button
          onClick={() =>
            setOptions((o) => ({ ...o, showSensor: !o.showSensor }))
          }
          className={clsx(
            "flex-1 py-1.5 px-2 rounded border transition-all",
            options.showSensor
              ? "bg-blue-500/20 border-blue-500/50 text-blue-300"
              : "bg-white/5 border-transparent text-white/50 hover:bg-white/10",
          )}
        >
          SENSOR FRAME
        </button>
        <button
          onClick={() => setOptions((o) => ({ ...o, showBody: !o.showBody }))}
          className={clsx(
            "flex-1 py-1.5 px-2 rounded border transition-all",
            options.showBody
              ? "bg-green-500/20 border-green-500/50 text-green-300"
              : "bg-white/5 border-transparent text-white/50 hover:bg-white/10",
          )}
        >
          BODY FRAME
        </button>
      </div>
    </div>
  );
}

// ─── VQFCalibrationPanel ──────────────────────────────────────────────────────

export function VQFCalibrationPanel({ deviceId }: { deviceId: string }) {
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<string | null>(null);

  const startCalibration = async () => {
    setIsCalibrating(true);
    setProgress(0);
    setResult(null);

    // Sampling arrays
    const accSamples: number[] = [];
    const gyroSamples: number[] = [];

    const startTime = Date.now();
    const duration = 3000; // 3 seconds

    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - startTime;
      const p = Math.min(100, (elapsed / duration) * 100);
      setProgress(p);

      const a = deviceAccelCache.get(deviceId);
      const g = deviceGyroCache.get(deviceId);

      if (a && g) {
        // Collect magnitude deviations/noise
        const aMag = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
        accSamples.push(Math.abs(aMag - 9.81));

        const gMag = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
        gyroSamples.push(gMag);
      }

      if (elapsed >= duration) {
        clearInterval(timer);
        finishCalibration(accSamples, gyroSamples);
      }
    }, 16); // ~60Hz sampling
  };

  const finishCalibration = (accNoise: number[], gyroNoise: number[]) => {
    setIsCalibrating(false);
    if (accNoise.length < 50) {
      setResult("Error: Not enough data");
      return;
    }

    const maxAcc = Math.max(...accNoise);
    const maxGyro = Math.max(...gyroNoise);

    // Apply safety factor (e.g. 2.5x to avoid false triggers)
    const newRestThAcc = Math.max(0.1, parseFloat((maxAcc * 2.5).toFixed(3)));
    const newRestThGyro = Math.max(
      0.02,
      parseFloat((maxGyro * 2.5).toFixed(3)),
    );

    useDeviceRegistry.getState().setVQFConfig({
      restThAcc: newRestThAcc,
      restThGyro: newRestThGyro,
    });

    setResult(`Updated: Acc=${newRestThAcc}, Gyro=${newRestThGyro}`);
  };

  return (
    <div className="pt-4 mt-4 border-t border-white/10">
      <button
        onClick={startCalibration}
        disabled={isCalibrating}
        className={clsx(
          "w-full py-2 rounded text-xs font-bold uppercase tracking-wider transition-colors",
          isCalibrating
            ? "bg-white/10 text-white/50"
            : "bg-accent/20 hover:bg-accent/40 text-accent",
        )}
      >
        {isCalibrating
          ? `Sampling Noise... ${Math.round(progress)}%`
          : "Auto-Tune VQF Thresholds"}
      </button>
      {result && (
        <div className="mt-2 text-[10px] text-green-400 text-center font-mono">
          {result}
        </div>
      )}
      <div className="mt-2 text-[10px] text-white/40 text-center">
        Keep device stationary during sampling.
      </div>
    </div>
  );
}

// ─── AxisAlignmentPanel ───────────────────────────────────────────────────────

export function AxisAlignmentPanel({ deviceId }: { deviceId: string }) {
  const [step, setStep] = useState<"idle" | "sampling" | "done">("idle");

  const handleAlign = () => {
    setStep("sampling");

    // Quick 1s sample
    setTimeout(() => {
      const a = deviceAccelCache.get(deviceId);
      if (!a) {
        setStep("idle");
        return;
      }

      // Find dominant axis
      const abs = a.map(Math.abs);
      const maxVal = Math.max(...abs);
      const maxIdx = abs.indexOf(maxVal); // 0=x, 1=y, 2=z

      // Real value (checking sign)
      const val = a[maxIdx];
      const sign = Math.sign(val);

      if (maxVal < 8.0) {
        alert(
          "Error: Gravity not detected (Magnitude too low). Ensure device is flat.",
        );
        setStep("idle");
        return;
      }

      // We want this axis to map to Y (Index 1) and be POSITIVE (Up = +9.81)
      console.debug(
        `[AxisAlign] Raw Accel: [${a.join(", ")}], Dominant Axis: ${maxIdx}, Value: ${val.toFixed(2)}, Sign: ${sign}`,
      );

      // Construct new mapping
      const newMap: [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2] = [0, 1, 2];
      const newSign: [1 | -1, 1 | -1, 1 | -1] = [1, 1, 1];

      // Logical Y gets the gravity axis
      newMap[1] = maxIdx as 0 | 1 | 2;
      newSign[1] = sign as 1 | -1;

      // Assign remaining axes
      const remaining = [0, 1, 2].filter((i) => i !== maxIdx);
      newMap[0] = remaining[0] as 0 | 1 | 2;
      newMap[2] = remaining[1] as 0 | 1 | 2;

      // RHS CHECK: Calculate Determinant of the Rotation Matrix
      const cross = (i1: number, i2: number) => {
        if (i1 === i2) return { axis: 0, sign: 0 };
        if (i1 === 0 && i2 === 1) return { axis: 2, sign: 1 };
        if (i1 === 1 && i2 === 2) return { axis: 0, sign: 1 };
        if (i1 === 2 && i2 === 0) return { axis: 1, sign: 1 };
        if (i1 === 1 && i2 === 0) return { axis: 2, sign: -1 };
        if (i1 === 2 && i2 === 1) return { axis: 0, sign: -1 };
        if (i1 === 0 && i2 === 2) return { axis: 1, sign: -1 };
        return { axis: 0, sign: 0 };
      };

      const c = cross(newMap[0], newMap[1]);
      const resZ_sign = c.sign * newSign[0] * newSign[1];

      if (newSign[2] !== resZ_sign) {
        console.debug(
          "[AxisAlign] Detected Left-Handed System (Det=-1). Swapping X and Z mapping to fix.",
        );
        const tmpMap = newMap[0];
        const tmpSign = newSign[0];
        newMap[0] = newMap[2];
        newSign[0] = newSign[2];
        newMap[2] = tmpMap;
        newSign[2] = tmpSign;
      }

      console.debug(
        `[AxisAlign] Final Config - Map: [${newMap}], Sign: [${newSign}]`,
      );

      // Apply
      useDeviceRegistry.getState().setAxisConfig(deviceId, {
        map: newMap,
        sign: newSign,
      });

      setStep("done");
      setTimeout(() => setStep("idle"), 2000);
    }, 1000);
  };

  const handleReset = () => {
    const reg = useDeviceRegistry.getState();
    reg.resetAxisConfig(deviceId);
    reg.setMountingOffset(deviceId, [1, 0, 0, 0]); // Reset Tare
    reg.setEKFConfig(0.005, 0.05); // Force reset
  };

  const axisConfig = useDeviceRegistry((s) => s.axisConfig[deviceId]);

  return (
    <div className="pt-4 mt-4 border-t border-white/10">
      <div className="mb-2 text-xs font-bold tracking-wider uppercase text-white/50">
        Data Alignment
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={handleAlign}
          disabled={step !== "idle"}
          className="py-2 text-xs font-bold text-blue-400 uppercase rounded bg-blue-500/20 hover:bg-blue-500/40"
        >
          {step === "sampling" ? "Detecting..." : "Align Up Axis"}
        </button>
        <button
          onClick={() => useDeviceRegistry.getState().tareDevice(deviceId)}
          className="py-2 text-xs font-bold uppercase rounded bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-400"
        >
          Tare Flat
        </button>
      </div>
      <div className="mt-2 text-[10px] text-white/40 text-center leading-tight">
        <strong>Align Up</strong>: Fixes 90° Axis Permutations.
        <br />
        <strong>Tare Flat</strong>: Fixes Tilt (Mounting Calibration).
      </div>

      {/* RESET */}
      <div className="pt-4 mt-4 text-center border-t border-white/10">
        <button
          onClick={handleReset}
          className="bg-white/5 hover:bg-white/10 text-white/60 py-1 px-3 rounded text-[10px] font-bold uppercase w-full"
        >
          Reset Axis & Tare
        </button>
      </div>

      {/* FUSION DIAGNOSTICS */}
      <div className="pt-4 mt-4 border-t border-white/10">
        <div className="mb-2 text-xs font-bold tracking-wider uppercase text-white/50">
          Fusion Tuning (Diagnose Fade)
        </div>
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="w-12 text-white/60">TauAcc</span>
            <input
              type="range"
              min="1.0"
              max="20.0"
              step="1.0"
              defaultValue={useDeviceRegistry.getState().vqfConfig.tauAcc}
              onChange={(e) => {
                useDeviceRegistry
                  .getState()
                  .setVQFConfig({ tauAcc: parseFloat(e.target.value) });
              }}
              className="flex-1 accent-blue-500"
            />
            <span className="w-8 text-right text-white/40">
              {useDeviceRegistry((s) => s.vqfConfig.tauAcc).toFixed(1)}s
            </span>
          </div>
          <div className="text-[9px] text-white/30 leading-tight">
            Higher Tau = Trust Accelerometer LESS.
            <br />
            If "Fade" stops at high Tau, Accel Axis is wrong.
          </div>
        </div>
      </div>

      {axisConfig && (
        <div className="mt-2 text-[9px] font-mono text-white/30 text-center">
          Map: {JSON.stringify(axisConfig.map)} | Sign:{" "}
          {JSON.stringify(axisConfig.sign)}
        </div>
      )}
    </div>
  );
}

// ─── FilterConfigPanel ────────────────────────────────────────────────────────

/** EKF noise parameters + ZUPT threshold — consolidated from DeveloperPanel */
export function FilterConfigPanel() {
  const ekfGyroNoise = useDeviceRegistry((s) => s.ekfGyroNoise);
  const ekfAccelNoise = useDeviceRegistry((s) => s.ekfAccelNoise);
  const zuptThreshold = useDeviceRegistry((s) => s.zuptThreshold);
  const setEKFConfig = useDeviceRegistry((s) => s.setEKFConfig);
  const setZuptThreshold = useDeviceRegistry((s) => s.setZuptThreshold);

  return (
    <div className="pt-4 mt-4 border-t border-white/10 space-y-4">
      {/* EKF Noise */}
      <div>
        <div className="mb-2 text-xs font-bold tracking-wider uppercase text-white/50">
          EKF Config
        </div>
        <div className="space-y-2">
          <div>
            <div className="flex justify-between text-[10px] text-white/60 mb-0.5">
              <span>Gyro Noise</span>
              <span className="font-mono">
                {ekfGyroNoise.toFixed(4)} rad/s/√Hz
              </span>
            </div>
            <input
              type="range"
              min="0.001"
              max="0.02"
              step="0.001"
              value={ekfGyroNoise}
              aria-label="EKF Gyro Noise"
              title="EKF Gyro Noise"
              className="w-full h-1 rounded-lg appearance-none cursor-pointer accent-blue-500"
              onChange={(e) =>
                setEKFConfig(parseFloat(e.target.value), ekfAccelNoise)
              }
            />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-white/60 mb-0.5">
              <span>Accel Noise</span>
              <span className="font-mono">
                {ekfAccelNoise.toFixed(4)} g/√Hz
              </span>
            </div>
            <input
              type="range"
              min="0.001"
              max="0.02"
              step="0.001"
              value={ekfAccelNoise}
              aria-label="EKF Accel Noise"
              title="EKF Accel Noise"
              className="w-full h-1 rounded-lg appearance-none cursor-pointer accent-blue-500"
              onChange={(e) =>
                setEKFConfig(ekfGyroNoise, parseFloat(e.target.value))
              }
            />
          </div>
        </div>
      </div>

      {/* ZUPT Threshold */}
      <div>
        <div className="flex justify-between mb-1">
          <span className="text-xs font-bold tracking-wider uppercase text-white/50">
            Stationary (ZUPT)
          </span>
          <span className="text-[10px] font-mono text-white/40">
            {zuptThreshold.toFixed(1)}°/s
          </span>
        </div>
        <input
          type="range"
          min="0.0"
          max="10.0"
          step="0.1"
          value={zuptThreshold}
          aria-label="Stationary gyro threshold (ZUPT)"
          title="Stationary gyro threshold (ZUPT)"
          className="w-full h-1 rounded-lg appearance-none cursor-pointer accent-blue-500"
          onChange={(e) => setZuptThreshold(parseFloat(e.target.value))}
        />
        <div className="text-[9px] text-white/30 mt-1">
          Gyro threshold used to freeze integration when stationary.
        </div>
      </div>
    </div>
  );
}
