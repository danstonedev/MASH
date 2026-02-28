import { useState, useEffect, useRef } from "react";
import {
  Download,
  Trash2,
  User,
  ChevronRight,
  Database,
  ArrowLeft,
  Upload,
} from "lucide-react";
import { dataManager, type RecordingSession } from "../../lib/db/index";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useAthleteStore } from "../../store/useAthleteStore";
import {
  PlaybackTelemetryCharts,
  PlaybackJointAngleCharts,
} from "../visualization/PlaybackTelemetryChart";
import { GapAnalysisReport } from "./GapAnalysisReport";
import { exportAndDownloadSessionData } from "../../lib/export/ExportOrchestrator";
import {
  EXPORT_PROGRESS_STAGE,
  formatExportStage,
} from "../../lib/export/formatExportStage";
import { parseSessionImportPayload } from "../../lib/sessionImport";

/**
 * SessionManager - Database-style session browser with breadcrumb navigation
 *
 * Two states:
 * 1. List View: Compact table of all sessions (no session selected or click "Sessions" in breadcrumb)
 * 2. Detail View: Selected session details with more room for controls/analytics
 */
export function SessionManager() {
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadSession = usePlaybackStore((state) => state.loadSession);
  const unloadSession = usePlaybackStore((state) => state.unloadSession);
  const selectedSessionId = usePlaybackStore((state) => state.sessionId);
  const selectedSessionName = usePlaybackStore((state) => state.sessionName);
  const isLoadingPlaybackSession = usePlaybackStore(
    (state) => state.isLoadingSession,
  );
  const duration = usePlaybackStore((state) => state.duration);
  const sensorIds = usePlaybackStore((state) => state.sensorIds);
  const frameRate = usePlaybackStore((state) => state.frameRate);
  const athletes = useAthleteStore((state) => state.athletes);

  const getAthleteName = (athleteId?: string) => {
    if (!athleteId) return null;
    const athlete = athletes.get(athleteId);
    return athlete ? `${athlete.firstName} ${athlete.lastName}` : null;
  };

  const loadSessions = async () => {
    setIsLoading(true);
    const allSessions = await dataManager.getAllSessions();
    setSessions(allSessions);
    setIsLoading(false);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  // Helper to refresh list after deletion
  const refreshAfterDelete = () => {
    loadSessions();
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsLoading(true);
      const text = await file.text();
      const { session, imuFrames, environmentalFrames } =
        parseSessionImportPayload(JSON.parse(text));

      // Check if session exists
      const existing = await dataManager.getSession(session.id);
      if (existing) {
        if (!confirm(`Session "${session.name}" already exists. Overwrite?`)) {
          setIsLoading(false);
          return;
        }
        await dataManager.deleteSession(session.id);
      }

      await dataManager.createSession(session);
      await dataManager.bulkSaveFrames(imuFrames);
      if (environmentalFrames.length > 0) {
        await Promise.all(
          environmentalFrames.map((frame) => dataManager.saveEnvFrame(frame)),
        );
      }

      // Reload list
      await loadSessions();
      alert("Session imported successfully");
    } catch (err) {
      console.error("Import failed:", err);
      alert(
        `Import failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
      setIsLoading(false);
    } finally {
      // Reset input so same file can be selected again if needed
      if (event.target.value) event.target.value = "";
    }
  };

  const handleSelectSession = async (sessionId: string) => {
    if (selectedSessionId === sessionId || isLoadingPlaybackSession) return;
    await loadSession(sessionId);
  };

  const handleBackToList = () => {
    unloadSession();
  };

  const formatDuration = (session: RecordingSession) => {
    if (!session.endTime) return "--";
    const durationMs = session.endTime - session.startTime;
    return `${(durationMs / 1000).toFixed(2)}s`;
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  // =========================================================================
  // RENDER: SELECTED SESSION DETAIL VIEW
  // =========================================================================
  if (selectedSessionId) {
    const selectedSession = sessions.find((s) => s.id === selectedSessionId);
    const athleteName = selectedSession
      ? getAthleteName(selectedSession.athleteId)
      : null;

    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1 px-3 py-2 text-xs border-b border-border bg-bg-elevated/50">
          <button
            onClick={handleBackToList}
            className="flex items-center gap-1 text-text-secondary hover:text-accent transition-colors"
          >
            <Database className="w-3 h-3" />
            Sessions
          </button>
          <ChevronRight className="w-3 h-3 text-text-secondary/50" />
          <span className="text-accent font-medium truncate">
            {selectedSessionName}
          </span>
        </div>

        {/* Session Details */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {/* Session Info Card */}
          <div className="bg-bg-elevated/40 border border-border rounded-lg p-3">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">
                  {selectedSessionName}
                </h3>
                <p className="text-[10px] text-text-secondary mt-0.5">
                  {selectedSession && formatDate(selectedSession.startTime)} ·{" "}
                  {selectedSession && formatTime(selectedSession.startTime)}
                </p>
                {athleteName && (
                  <div className="flex items-center gap-1 mt-1">
                    <User className="w-3 h-3 text-accent" />
                    <span className="text-[10px] text-accent">
                      {athleteName}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-bg-surface rounded p-2">
                <div className="text-lg font-bold text-accent">
                  {sensorIds.length}
                </div>
                <div className="text-[9px] text-text-secondary uppercase">
                  Sensors
                </div>
              </div>
              <div className="bg-bg-surface rounded p-2">
                <div className="text-lg font-bold text-text-primary">
                  {(duration / 1000).toFixed(2)}s
                </div>
                <div className="text-[9px] text-text-secondary uppercase">
                  Duration
                </div>
              </div>
              <div className="bg-bg-surface rounded p-2">
                <div className="text-lg font-bold text-text-primary">
                  {frameRate}
                </div>
                <div className="text-[9px] text-text-secondary uppercase">
                  Hz
                </div>
              </div>
            </div>
          </div>

          {/* Data Integrity / Gap Analysis */}
          <GapAnalysisReport key={selectedSessionId} />

          {/* Telemetry Charts */}
          <PlaybackTelemetryCharts />

          {/* Joint Angle Charts */}
          <PlaybackJointAngleCharts />

          {/* Export Actions */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-text-secondary uppercase">
              Export
            </h4>
            <div className="flex gap-2">
              <ExportButton sessionId={selectedSessionId} format="csv" />
              <ExportButton sessionId={selectedSessionId} format="json" />
            </div>
          </div>

          {/* Danger Zone */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-text-secondary uppercase">
              Danger Zone
            </h4>
            <DeleteButton
              sessionId={selectedSessionId}
              sessionName={selectedSessionName || "Session"}
              onDelete={refreshAfterDelete}
            />
          </div>
        </div>

        {/* Back button at bottom */}
        <div className="p-3 border-t border-border">
          <button
            onClick={handleBackToList}
            className="w-full flex items-center justify-center gap-2 py-2 text-sm text-text-secondary hover:text-white transition-colors bg-bg-surface rounded"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Sessions
          </button>
        </div>
      </div>
    );
  }

  // =========================================================================
  // RENDER: SESSION LIST VIEW
  // =========================================================================
  if (isLoading) {
    return (
      <div className="p-4 text-center text-text-secondary text-sm">
        Loading sessions...
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center text-text-secondary text-sm opacity-60">
        <Database className="w-10 h-10 mb-2 opacity-30" />
        <p>No recorded sessions yet</p>
        <p className="text-xs mt-1">Record a session to see it here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="bg-bg-elevated/50 p-2 border-b border-border flex justify-between items-center">
        <div className="text-[10px] text-text-secondary uppercase font-semibold pl-1 flex items-center gap-2">
          Recorded Sessions
          <button
            onClick={async () => {
              if (
                !confirm(
                  "This will re-calculate Hz for all sessions to align with hardware metrics. Proceed?",
                )
              )
                return;
              setIsLoading(true);
              const allSessions = await dataManager.getAllSessions();
              for (const s of allSessions) {
                await loadSession(s.id); // Triggers heal on load
              }
              await loadSessions();
              alert("All sessions repaired!");
            }}
            className="text-[9px] lowercase text-accent/60 hover:text-accent transition-colors"
            disabled={isLoadingPlaybackSession}
          >
            (repair all)
          </button>
          {isLoadingPlaybackSession && (
            <span className="text-[9px] normal-case text-accent/80">
              loading…
            </span>
          )}
        </div>
        <button
          onClick={handleImportClick}
          className="flex items-center gap-1.5 px-2 py-1 rounded bg-bg-surface border border-border text-[10px] text-text-secondary hover:text-accent hover:border-accent/50 transition-all"
        >
          <Upload className="w-3 h-3" />
          Import
        </button>
      </div>

      {/* Hidden Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImportFile}
        accept=".json"
        aria-label="Import session JSON file"
        className="hidden"
      />

      {/* Table Header */}
      <div className="grid grid-cols-[1fr_55px_40px_35px] gap-2 px-3 py-2 text-[9px] text-text-secondary uppercase font-semibold border-b border-border bg-bg-elevated/30">
        <div>Session</div>
        <div className="text-right">Duration</div>
        <div className="text-center">#</div>
        <div className="text-center">Hz</div>
      </div>

      {/* Table Body - Scrollable */}
      <div className="flex-1 overflow-y-auto">
        {sessions.map((session) => {
          const athleteName = getAthleteName(session.athleteId);

          return (
            <div
              key={session.id}
              onClick={() => handleSelectSession(session.id)}
              className={`grid grid-cols-[1fr_55px_40px_35px] gap-2 px-3 py-2.5 transition-all border-b border-border/50 group ${
                isLoadingPlaybackSession
                  ? "cursor-wait opacity-80"
                  : "cursor-pointer hover:bg-accent/10"
              }`}
            >
              {/* Session name and date */}
              <div className="min-w-0">
                <div className="text-xs font-medium truncate text-text-primary group-hover:text-accent transition-colors">
                  {session.name}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-secondary">
                  <span>
                    {formatDate(session.startTime)} ·{" "}
                    {formatTime(session.startTime)}
                  </span>
                  {athleteName && (
                    <span className="flex items-center gap-0.5 text-accent/70">
                      <User className="w-2.5 h-2.5" />
                    </span>
                  )}
                </div>
              </div>

              {/* Duration */}
              <div className="text-right text-xs text-text-secondary self-center">
                {formatDuration(session)}
              </div>

              {/* Sensor count */}
              <div className="text-center text-xs text-text-secondary self-center">
                {session.sensorCount || "--"}
              </div>

              {/* Sample rate */}
              <div className="text-center text-xs text-text-secondary self-center">
                {session.sampleRate || "--"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

function ExportButton({
  sessionId,
  format,
}: {
  sessionId: string;
  format: "csv" | "json";
}) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    setExportProgress(0);
    setExportStage(EXPORT_PROGRESS_STAGE.STARTING);
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      await exportAndDownloadSessionData(
        {
          sessionId,
          format,
          jsonSchema: "legacy",
          filename: `${sessionId}.${format}`,
        },
        {
          signal: abortController.signal,
          onProgress: (progress, stage) => {
            setExportProgress(progress);
            setExportStage(stage);
          },
        },
      );
    } catch (err) {
      if (!(err instanceof Error && err.message === "Export cancelled")) {
        console.error("[SessionManager] Export failed:", err);
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
    <div className="flex-1 space-y-1">
      <button
        onClick={handleExport}
        disabled={isExporting}
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded bg-bg-surface border border-border text-xs hover:bg-white/5 transition-all"
      >
        <Download className="w-3.5 h-3.5" />
        {isExporting
          ? `${format.toUpperCase()} ${Math.round(exportProgress)}%`
          : format.toUpperCase()}
      </button>

      {isExporting && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-text-secondary truncate">
              {formatExportStage(exportStage)} · {Math.round(exportProgress)}%
            </span>
            <button
              onClick={handleCancelExport}
              className="text-[10px] text-text-secondary hover:text-accent"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function DeleteButton({
  sessionId,
  sessionName,
  onDelete,
}: {
  sessionId: string;
  sessionName: string;
  onDelete: () => void;
}) {
  const unloadSession = usePlaybackStore((state) => state.unloadSession);

  const handleDelete = async () => {
    if (!confirm(`Delete "${sessionName}"? This cannot be undone.`)) return;

    await dataManager.deleteSession(sessionId);
    unloadSession();
    onDelete();
  };

  return (
    <button
      onClick={handleDelete}
      className="w-full flex items-center justify-center gap-1.5 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-xs hover:bg-red-500/20 transition-all"
    >
      <Trash2 className="w-3.5 h-3.5" />
      Delete Session
    </button>
  );
}

// Legacy export for backwards compatibility
export { SessionManager as SessionList };
export { SessionManager as SelectedSessionPanel };
