/**
 * Export Panel - Industry Format Data Export UI
 * ==============================================
 *
 * Provides one-click export to industry-standard formats:
 * - C3D (Vicon, Visual3D, OpenSim)
 * - OpenSim TRC/MOT (musculoskeletal simulation)
 * - BVH (Blender, Maya, Unity, Unreal)
 * - CSV (legacy/spreadsheet)
 */

import { useState, useMemo, useRef } from "react";
import { Download, Cog, Check, AlertCircle, FileArchive } from "lucide-react";
import { Button } from "../../ui/Button";
import { usePlaybackStore } from "../../../store/usePlaybackStore";
import { exportAndDownloadPlaybackData } from "../../../lib/export/ExportOrchestrator";
import {
  EXPORT_PROGRESS_STAGE,
  formatExportStage,
} from "../../../lib/export/formatExportStage";
import type { RecordedFrame } from "../../../lib/db/types";

// ============================================================================
// TYPES
// ============================================================================

type ExportFormat = "c3d" | "opensim" | "bvh" | "csv";

interface ExportOption {
  id: ExportFormat;
  name: string;
  description: string;
  icon: string;
  extensions: string[];
}

const EXPORT_OPTIONS: ExportOption[] = [
  {
    id: "c3d",
    name: "C3D",
    description: "Industry standard for biomechanics",
    icon: "🔬",
    extensions: [".c3d"],
  },
  {
    id: "opensim",
    name: "OpenSim",
    description: "Musculoskeletal simulation",
    icon: "🦴",
    extensions: [".trc", ".mot"],
  },
  {
    id: "bvh",
    name: "BVH",
    description: "Animation & game engines",
    icon: "🎬",
    extensions: [".bvh"],
  },
  {
    id: "csv",
    name: "CSV",
    description: "Spreadsheet export",
    icon: "📊",
    extensions: [".csv"],
  },
];

// ============================================================================
// EXPORT PANEL COMPONENT
// ============================================================================

export function ExportPanel() {
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>("c3d");
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState<string>("");
  const [exportResult, setExportResult] = useState<"success" | "error" | null>(
    null,
  );
  const [includeCalibration, setIncludeCalibration] = useState(true);
  const [includeAnalog, setIncludeAnalog] = useState(true);
  const exportAbortRef = useRef<AbortController | null>(null);

  // Get current session from playback store
  const sessionId = usePlaybackStore((state) => state.sessionId);
  const sessionName = usePlaybackStore((state) => state.sessionName);
  const frames = usePlaybackStore((state) => state.frames);
  const frameRate = usePlaybackStore((state) => state.frameRate);

  const hasSession = sessionId !== null && frames.length > 0;

  // Session stats
  const stats = useMemo(() => {
    if (!hasSession) return null;

    const sensors = new Set(frames.map((f) => f.sensorId));
    const segments = new Set(frames.map((f) => f.segment).filter(Boolean));
    const duration =
      frames.length > 0
        ? (frames[frames.length - 1].timestamp - frames[0].timestamp) / 1000
        : 0;

    return {
      frameCount: frames.length,
      sensorCount: sensors.size,
      segmentCount: segments.size,
      duration: duration.toFixed(1),
    };
  }, [hasSession, frames]);

  const handleExport = async () => {
    if (!hasSession || !sessionName) return;

    setIsExporting(true);
    setExportProgress(0);
    setExportStage(EXPORT_PROGRESS_STAGE.STARTING);
    setExportResult(null);
    const abortController = new AbortController();
    exportAbortRef.current = abortController;

    try {
      const exportFrames = frames as RecordedFrame[];

      await exportAndDownloadPlaybackData(
        {
          format: selectedFormat,
          sessionName,
          frameRate,
          frames: exportFrames,
          includeAnalog,
        },
        {
          signal: abortController.signal,
          onProgress: (progress, stage) => {
            setExportProgress(progress);
            setExportStage(stage);
          },
        },
      );

      setExportResult("success");
      setTimeout(() => setExportResult(null), 3000);
    } catch (err) {
      if (err instanceof Error && err.message === "Export cancelled") {
        setExportResult(null);
      } else {
        console.error("[Export] Error:", err);
        setExportResult("error");
      }
    } finally {
      exportAbortRef.current = null;
      setIsExporting(false);
      setExportStage("");
    }
  };

  const handleCancelExport = () => {
    exportAbortRef.current?.abort();
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <FileArchive className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-white">Data Export</span>
        </div>
        <p className="text-[10px] text-white/40 mt-1">
          Export to industry-standard formats
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Session Info */}
        {hasSession && stats ? (
          <div className="p-3 rounded-lg bg-success/10 border border-success/30">
            <div className="flex items-center gap-2 text-success mb-2">
              <Check className="h-4 w-4" />
              <span className="text-xs font-medium">Session Loaded</span>
            </div>
            <p className="text-xs text-white/80">{sessionName}</p>
            <div className="grid grid-cols-2 gap-2 mt-2 text-[10px] text-white/60">
              <span>{stats.frameCount.toLocaleString()} frames</span>
              <span>{stats.sensorCount} sensors</span>
              <span>{stats.duration}s duration</span>
              <span>{frameRate} Hz</span>
            </div>
          </div>
        ) : (
          <div className="p-3 rounded-lg bg-warning/10 border border-warning/30">
            <div className="flex items-center gap-2 text-warning">
              <AlertCircle className="h-4 w-4" />
              <span className="text-xs font-medium">No Session Loaded</span>
            </div>
            <p className="text-[10px] text-white/60 mt-1">
              Load a recorded session from the Sessions tab to export
            </p>
          </div>
        )}

        {/* Format Selection */}
        <div className="space-y-2">
          <p className="text-xs text-white/60 font-medium">Export Format</p>
          <div className="grid grid-cols-2 gap-2">
            {EXPORT_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => setSelectedFormat(option.id)}
                className={`p-3 rounded-lg text-left transition-all ${
                  selectedFormat === option.id
                    ? "bg-accent/20 border-2 border-accent"
                    : "bg-white/5 border border-white/10 hover:bg-white/10"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">{option.icon}</span>
                  <span className="text-xs font-medium text-white">
                    {option.name}
                  </span>
                </div>
                <p className="text-[10px] text-white/50 mt-1">
                  {option.description}
                </p>
                <p className="text-[10px] text-accent mt-1">
                  {option.extensions.join(", ")}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Export Options */}
        <div className="space-y-2">
          <p className="text-xs text-white/60 font-medium">Options</p>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-white/80">
              <input
                type="checkbox"
                checked={includeCalibration}
                onChange={(e) => setIncludeCalibration(e.target.checked)}
                className="rounded border-white/20 bg-white/10"
              />
              Include calibration metadata
            </label>
            {selectedFormat === "c3d" && (
              <label className="flex items-center gap-2 text-xs text-white/80">
                <input
                  type="checkbox"
                  checked={includeAnalog}
                  onChange={(e) => setIncludeAnalog(e.target.checked)}
                  className="rounded border-white/20 bg-white/10"
                />
                Include analog data (accel/gyro)
              </label>
            )}
          </div>
        </div>

        {/* Format Info */}
        <FormatInfoCard format={selectedFormat} />

        {/* Progress */}
        {isExporting && (
          <div className="p-3 rounded-lg bg-white/5 border border-white/10 space-y-2">
            <div className="flex items-center justify-between text-[10px] text-white/70">
              <span>Stage: {formatExportStage(exportStage)}</span>
              <span>{Math.round(exportProgress)}%</span>
            </div>
            <div className="w-full h-1.5 bg-white/10 rounded overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-150"
                style={{
                  width: `${Math.max(0, Math.min(100, exportProgress))}%`,
                }}
              />
            </div>
            <button
              onClick={handleCancelExport}
              className="w-full py-1.5 rounded border border-white/20 text-[10px] text-white/70 hover:bg-white/10"
            >
              Cancel Export
            </button>
          </div>
        )}
      </div>

      {/* Export Button */}
      <div className="p-4 border-t border-white/10">
        <Button
          variant="gradient"
          size="sm"
          className="w-full"
          onClick={handleExport}
          disabled={!hasSession || isExporting}
        >
          {isExporting ? (
            <>
              <Cog className="h-4 w-4 mr-2 animate-spin" />
              Exporting...
            </>
          ) : exportResult === "success" ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Export Complete!
            </>
          ) : (
            <>
              <Download className="h-4 w-4 mr-2" />
              Export {EXPORT_OPTIONS.find((o) => o.id === selectedFormat)?.name}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// FORMAT INFO CARDS
// ============================================================================

function FormatInfoCard({ format }: { format: ExportFormat }) {
  const info = {
    c3d: {
      title: "C3D - Biomechanics Standard",
      bullets: [
        "Accepted by Vicon, Visual3D, OpenSim",
        "Binary format with marker + analog data",
        "Includes full calibration metadata",
        "Best for research publications",
      ],
    },
    opensim: {
      title: "OpenSim - Musculoskeletal Simulation",
      bullets: [
        "TRC file: 3D marker trajectories",
        "MOT file: Joint angles over time",
        "Works with OpenSim 4.x models",
        "Enables inverse dynamics analysis",
      ],
    },
    bvh: {
      title: "BVH - Animation Industry",
      bullets: [
        "Mixamo-compatible skeleton",
        "Imports into Blender, Maya, Unity",
        "Hierarchy rotation format",
        "Standard for game development",
      ],
    },
    csv: {
      title: "CSV - Spreadsheet Export",
      bullets: [
        "Human-readable text format",
        "Opens in Excel, Google Sheets",
        "Raw quaternion + sensor data",
        "Easy for custom analysis scripts",
      ],
    },
  };

  const currentInfo = info[format];

  return (
    <div className="p-3 rounded-lg bg-white/5 border border-white/10">
      <p className="text-xs font-medium text-white mb-2">{currentInfo.title}</p>
      <ul className="space-y-1">
        {currentInfo.bullets.map((bullet, idx) => (
          <li
            key={idx}
            className="flex items-start gap-2 text-[10px] text-white/60"
          >
            <span className="text-accent mt-0.5">•</span>
            {bullet}
          </li>
        ))}
      </ul>
    </div>
  );
}
