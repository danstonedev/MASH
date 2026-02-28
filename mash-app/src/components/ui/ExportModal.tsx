/**
 * Export Modal - Apple-style sheet with format selection
 * Clean, focused, minimal options
 */

import { useRef, useState } from "react";
import {
  FileSpreadsheet,
  FileText,
  FileJson,
  Check,
  Download,
} from "lucide-react";
import { useRecordingStore } from "../../store/useRecordingStore";
import { dataManager } from "../../lib/db";
import { buildOpenSimStoArtifact } from "../../lib/export/OpenSimExporter";
import { exportAndDownloadSessionData } from "../../lib/export/ExportOrchestrator";
import { downloadFile } from "../../lib/export/download";
import {
  EXPORT_PROGRESS_STAGE,
  formatExportStage,
} from "../../lib/export/formatExportStage";

type ExportFormat = "csv" | "opensim" | "json";

interface ExportModalProps {
  onClose: () => void;
}

export function ExportModal({ onClose }: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState("");
  const [exported, setExported] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { currentSession, frameCount, duration } = useRecordingStore();

  const formats: {
    id: ExportFormat;
    icon: typeof FileSpreadsheet;
    label: string;
    desc: string;
  }[] = [
    {
      id: "csv",
      icon: FileSpreadsheet,
      label: "CSV",
      desc: "Universal format with metadata",
    },
    {
      id: "opensim",
      icon: FileText,
      label: "OpenSim",
      desc: "Biomechanics (.sto)",
    },
    {
      id: "json",
      icon: FileJson,
      label: "JSON",
      desc: "Full data with all frames",
    },
  ];

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleExport = async () => {
    if (!currentSession?.id) return;

    setIsExporting(true);
    setExportProgress(0);
    setExportStage(EXPORT_PROGRESS_STAGE.STARTING);
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      let content: string | null = null;
      let filename = "";

      switch (format) {
        case "opensim":
          const session = await dataManager.getSession(currentSession.id);
          if (!session) {
            throw new Error(`Session ${currentSession.id} not found`);
          }

          const frames = await dataManager.exportSessionData(currentSession.id);
          if (frames.length === 0) {
            throw new Error(`No frames found for session ${currentSession.id}`);
          }

          const artifact = buildOpenSimStoArtifact(frames, {
            sessionName: session.name,
            dataRate: session.sampleRate || 0,
          });

          content = artifact.content;
          filename = artifact.filename;
          break;
        case "csv":
          filename = `${currentSession.name || "session"}_${Date.now()}.csv`;
          await exportAndDownloadSessionData(
            {
              sessionId: currentSession.id,
              format: "csv",
              filename,
            },
            {
              signal: abortController.signal,
              onProgress: (progress, stage) => {
                setExportProgress(progress);
                setExportStage(stage);
              },
            },
          );
          break;
        case "json":
          filename = `${(currentSession.name || "session").replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.json`;
          await exportAndDownloadSessionData(
            {
              sessionId: currentSession.id,
              format: "json",
              jsonSchema: "full",
              filename,
            },
            {
              signal: abortController.signal,
              onProgress: (progress, stage) => {
                setExportProgress(progress);
                setExportStage(stage);
              },
            },
          );
          break;
      }

      if (format === "opensim" && content) {
        downloadFile(content, filename);
      }
      setExported(true);
      setTimeout(() => onClose(), 1000);
    } catch (err) {
      if (!(err instanceof Error && err.message === "Export cancelled")) {
        console.error("Export failed:", err);
      }
    } finally {
      abortRef.current = null;
      setIsExporting(false);
      setExportStage("");
    }
  };

  const handleCancelExport = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:max-w-sm bg-[#1C1C1E] sm:rounded-2xl rounded-t-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <button
            onClick={isExporting ? handleCancelExport : onClose}
            className="text-accent text-sm font-medium"
          >
            {isExporting ? "Cancel Export" : "Cancel"}
          </button>
          <span className="text-sm font-semibold text-white">Export</span>
          <div className="w-12" /> {/* Spacer for centering */}
        </div>

        {/* Session Info */}
        <div className="px-4 py-3 bg-white/5">
          <div className="text-sm font-medium text-white">
            {currentSession?.name || "Session"}
          </div>
          <div className="text-xs text-white/50 mt-0.5">
            {frameCount.toLocaleString()} frames • {formatDuration(duration)}
          </div>
        </div>

        {/* Format Selection */}
        <div className="px-4 py-2">
          <div className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2">
            Format
          </div>
          <div className="space-y-1">
            {formats.map((f) => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                className={`
                                    w-full flex items-center gap-3 p-3 rounded-xl
                                    transition-all duration-150
                                    ${
                                      format === f.id
                                        ? "bg-accent/10"
                                        : "hover:bg-white/5 active:bg-white/10"
                                    }
                                `}
              >
                <f.icon
                  className={`h-5 w-5 ${format === f.id ? "text-accent" : "text-white/50"}`}
                />
                <div className="flex-1 text-left">
                  <div
                    className={`text-sm font-medium ${format === f.id ? "text-accent" : "text-white"}`}
                  >
                    {f.label}
                  </div>
                  <div className="text-xs text-white/40">{f.desc}</div>
                </div>
                {format === f.id && <Check className="h-4 w-4 text-accent" />}
              </button>
            ))}
          </div>
        </div>

        {isExporting && format !== "opensim" && (
          <div className="px-4 pb-1">
            <div className="text-[10px] text-white/60 mb-1 flex items-center justify-between">
              <span>{formatExportStage(exportStage)}</span>
              <span>{Math.round(exportProgress)}%</span>
            </div>
            <div className="text-[10px] text-white/40">
              Progress updates are live while export runs.
            </div>
          </div>
        )}

        {/* Export Button */}
        <div className="p-4">
          <button
            onClick={handleExport}
            disabled={isExporting || exported}
            className={`
                            w-full py-3 rounded-xl font-semibold text-sm
                            flex items-center justify-center gap-2
                            transition-all duration-200
                            ${
                              exported
                                ? "bg-green-500/20 text-green-400"
                                : "bg-accent text-white hover:bg-accent/90 active:scale-[0.98]"
                            }
                        `}
          >
            {exported ? (
              <>
                <Check className="h-4 w-4" />
                Exported
              </>
            ) : isExporting ? (
              "Exporting..."
            ) : (
              <>
                <Download className="h-4 w-4" />
                Export {formats.find((f) => f.id === format)?.label}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
