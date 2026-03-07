/**
 * PipelineInspector/index.tsx — Main orchestrator component.
 *
 * This file is the clean entry point that composes the sub-components:
 *  - DeviceVisualizer (3D canvas scene)
 *  - DataMonitor (real-time data dashboard)
 *  - SegmentSelector, FrameOptionsPanel (control panels)
 *
 * Previously this was a single 1,400-line file. Now each sub-component
 * lives in its own file for maintainability.
 */

import { Canvas } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useState, Suspense } from "react";
import { createPortal } from "react-dom";
import { useDeviceRegistry } from "../../../store/useDeviceRegistry";
import { Activity, X } from "lucide-react";
import clsx from "clsx";

import { DeviceVisualizer } from "./Visualizer";
import { DataMonitor } from "./DataMonitor";
import { MultiDriftMonitor } from "./MultiDriftMonitor";
import {
  SegmentSelector,
  FrameOptionsPanel,
  FilterConfigPanel,
} from "./Panels";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PipelineInspectorProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── PipelineInspector ────────────────────────────────────────────────────────

export function PipelineInspector({ isOpen, onClose }: PipelineInspectorProps) {
  const devices = useDeviceRegistry((state) => state.devices);
  const connectedDevices = Array.from(devices.values()).filter(
    (d) => d.isConnected,
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  // Right-panel tab
  const [rightTab, setRightTab] = useState<"live" | "drift">("live");

  // View state options
  const [viewOptions, setViewOptions] = useState({
    showSensor: true,
    showBody: true,
  });

  // Auto-select first connected device (derived, no effect needed)
  const effectiveDeviceId =
    selectedDeviceId && connectedDevices.some((d) => d.id === selectedDeviceId)
      ? selectedDeviceId
      : connectedDevices.length > 0
        ? connectedDevices[0].id
        : null;

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col animate-in fade-in duration-200 font-sans">
      {/* Toolbar */}
      <div className="h-14 border-b border-white/10 flex items-center px-6 justify-between bg-[#1a1a1a]">
        <div className="flex items-center gap-4">
          <h2 className="flex items-center gap-2 text-lg font-bold text-white">
            <Activity className="text-accent" />
            Pipeline Inspector
          </h2>

          <div className="w-px h-6 mx-2 bg-white/10" />

          {/* Live / Drift tab switcher */}
          <div className="flex rounded overflow-hidden border border-white/10">
            <button
              onClick={() => setRightTab("live")}
              className={clsx(
                "px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors",
                rightTab === "live"
                  ? "bg-accent text-white"
                  : "text-white/40 hover:text-white/70 hover:bg-white/5",
              )}
            >
              Live
            </button>
            <button
              onClick={() => setRightTab("drift")}
              className={clsx(
                "px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors",
                rightTab === "drift"
                  ? "bg-purple-500/30 text-purple-300"
                  : "text-white/40 hover:text-white/70 hover:bg-white/5",
              )}
            >
              Drift
            </button>
          </div>

          <div className="w-px h-6 mx-2 bg-white/10" />

          <div className="flex gap-2">
            {connectedDevices.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedDeviceId(d.id)}
                className={clsx(
                  "px-3 py-1 rounded text-sm font-medium transition-colors border",
                  effectiveDeviceId === d.id
                    ? "bg-accent text-white border-accent"
                    : "bg-transparent text-white/60 border-transparent hover:bg-white/5",
                )}
              >
                {d.name || d.id}
              </button>
            ))}
            {connectedDevices.length === 0 && (
              <span className="py-1 text-sm italic text-white/40">
                No devices connected
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (
                confirm(
                  "Factory Reset: Clear all calibration, scaling, and axis maps?",
                )
              ) {
                useDeviceRegistry.getState().clear();
                localStorage.clear(); // FORCE WIPE
                window.location.reload();
              }
            }}
            className="px-3 py-1 text-xs font-bold text-red-400 uppercase transition-colors border rounded bg-red-500/20 hover:bg-red-500/30 border-red-500/30"
          >
            Factory Reset
          </button>
          <button
            onClick={onClose}
            className="p-2 transition-colors rounded-full hover:bg-white/10 text-white/60 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 relative bg-[#0a0a0a] overflow-hidden flex">
        {/* DRIFT TAB — full-width multi-sensor view */}
        {rightTab === "drift" && (
          <MultiDriftMonitor
            deviceIds={connectedDevices.map((d) => d.id)}
            deviceNames={
              new Map(connectedDevices.map((d) => [d.id, d.name || d.id]))
            }
          />
        )}

        {/* LIVE TAB — canvas + right panel */}
        {rightTab === "live" && (
          <>
        {/* LEFT CANVAS AREA */}
        <div className="relative flex-1 h-full">
          {effectiveDeviceId ? (
            <Canvas>
              <PerspectiveCamera makeDefault position={[3, 3, 3]} />
              <OrbitControls makeDefault />
              <ambientLight intensity={0.5} />
              <pointLight position={[10, 10, 10]} />
              <gridHelper args={[20, 20, 0x333333, 0x111111]} />

              <Suspense fallback={null}>
                <DeviceVisualizer
                  deviceId={effectiveDeviceId}
                  viewOptions={viewOptions}
                />
              </Suspense>
            </Canvas>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-white/40">
              Select a device to inspect
            </div>
          )}

          {/* Overlay Data Monitor (Floating) */}
          {effectiveDeviceId && (
            <div className="absolute pointer-events-none top-4 right-4">
              {/* Reserved for future floating overlays */}
            </div>
          )}
        </div>

        {/* RIGHT CONTROL PANEL */}
        {effectiveDeviceId && (
          <div className="w-[400px] border-l border-white/10 bg-[#111] flex flex-col">
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              <DataMonitor deviceId={effectiveDeviceId} />

                  {/* BODY ASSIGNMENT */}
                  <SegmentSelector deviceId={effectiveDeviceId} />

                  {/* VIEW OPTIONS */}
                  <FrameOptionsPanel
                    options={viewOptions}
                    setOptions={setViewOptions}
                  />

                  {/* FILTER TUNING (EKF + ZUPT) */}
                  <FilterConfigPanel />
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
