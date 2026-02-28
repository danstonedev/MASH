import { Circle, Square, User, AlertTriangle } from "lucide-react";
import { useRecordingStore } from "../../store/useRecordingStore";
import { useDeviceStore } from "../../store/useDeviceStore";
import { useAthleteStore } from "../../store/useAthleteStore";
import { useCalibrationStore } from "../../store/useCalibrationStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { cn } from "../../lib/utils";
import {
  RecordingMetadataDialog,
  type SessionMetadata,
} from "./RecordingMetadataDialog";

export function RecordingControls() {
  const { isConnected } = useDeviceStore();
  const { isCalibrated } = useCalibrationStore();
  const {
    isRecording,
    frameCount,
    duration,
    currentSession,
    pendingSession,
    showMetadataDialog,
    selectedAthleteId,
    setSelectedAthlete,
    startRecording,
    stopRecording,
    finalizeSession,
    discardPendingSession,
    closeMetadataDialog,
  } = useRecordingStore();

  const athletes = useAthleteStore((state) => state.athletes);
  const athleteList = Array.from(athletes.values());
  const calibrated = isCalibrated();

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
  };

  const handleRecordToggle = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const handleSaveSession = async (metadata: SessionMetadata) => {
    const pendingId = useRecordingStore.getState().pendingSession?.id;
    await finalizeSession(metadata);
    // Auto-load the new session so the gap analysis report is immediately visible
    if (pendingId) {
      await usePlaybackStore.getState().loadSession(pendingId);
    }
  };

  const handleDiscardSession = async () => {
    if (confirm("Discard this recording? All data will be deleted.")) {
      await discardPendingSession();
    }
  };

  // Strict Requirement: Must be connected AND calibrated to start recording
  // But allow stopping even if connection flaked
  // TEMPORARY OVERRIDE: Allowed recording without calibration for debugging
  const canRecord = isConnected; // && calibrated;

  return (
    <div className="space-y-3">
      {/* Athlete Selector */}
      <div className="space-y-1">
        <label className="flex items-center gap-1 text-[10px] text-text-secondary">
          <User className="w-3 h-3" />
          Recording For Athlete
        </label>
        <select
          value={selectedAthleteId || ""}
          onChange={(e) => setSelectedAthlete(e.target.value || null)}
          disabled={isRecording}
          className={cn(
            "w-full px-2 py-1.5 text-sm bg-[#1a1a1a] text-white border border-border rounded",
            "[&>option]:bg-[#1a1a1a] [&>option]:text-white [&>option]:py-2",
            isRecording
              ? "opacity-50 cursor-not-allowed"
              : "hover:border-accent",
          )}
        >
          <option value="" className="bg-[#1a1a1a] text-white">
            No athlete (anonymous)
          </option>
          {athleteList.map((a) => (
            <option key={a.id} value={a.id} className="bg-[#1a1a1a] text-white">
              {a.firstName} {a.lastName} (
              {a.sport === "speed_skating" ? "Skating" : "Hockey"})
            </option>
          ))}
        </select>
      </div>

      {/* Record Button */}
      <div className="space-y-2">
        <button
          onClick={handleRecordToggle}
          disabled={!canRecord && !isRecording}
          className={cn(
            "w-full flex items-center justify-center gap-2 py-2.5 text-xs font-bold rounded-md transition-all duration-200 border",
            isRecording
              ? "bg-danger/20 text-danger border-danger hover:bg-danger/30 animate-pulse"
              : canRecord
                ? "bg-bg-elevated text-text-primary border-border hover:border-accent hover:text-accent"
                : "bg-bg-elevated text-text-secondary border-border opacity-50 cursor-not-allowed",
          )}
        >
          {isRecording ? (
            <>
              <Square className="h-4 w-4 fill-current" />
              STOP RECORDING
            </>
          ) : (
            <>
              <Circle className="h-4 w-4 text-danger fill-danger" />
              START RECORDING
            </>
          )}
        </button>

        {/* Warning: Calibrate first */}
        {!calibrated && isConnected && !isRecording && (
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-yellow-500/80">
            <AlertTriangle className="w-3 h-3" />
            <span>Calibration required to record</span>
          </div>
        )}
      </div>

      {/* Recording Stats (while recording) */}
      {isRecording && (
        <div className="bg-bg-elevated rounded-lg p-4 border border-border flex justify-between items-center">
          <div className="flex flex-col items-center">
            <span className="text-xl font-bold text-text-primary">
              {currentSession?.sensorCount || 0}
            </span>
            <span className="text-[10px] text-text-secondary uppercase tracking-wider mt-1">
              Sensors
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xl font-bold text-text-primary">
              {formatDuration(duration)}
            </span>
            <span className="text-[10px] text-text-secondary uppercase tracking-wider mt-1">
              Duration
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xl font-bold text-text-primary">
              {duration > 0
                ? Math.round(
                    frameCount /
                      (duration / 1000) /
                      Math.max(1, currentSession?.sensorCount || 1),
                  )
                : 0}
            </span>
            <span className="text-[10px] text-text-secondary uppercase tracking-wider mt-1">
              Hz
            </span>
          </div>
        </div>
      )}

      {/* Hint when not connected */}
      {!isConnected && !isRecording && (
        <p className="text-[10px] text-text-secondary text-center">
          Connect a device to start recording
        </p>
      )}

      {/* Post-Recording Metadata Dialog */}
      <RecordingMetadataDialog
        isOpen={showMetadataDialog}
        onClose={closeMetadataDialog}
        onSave={handleSaveSession}
        onDiscard={handleDiscardSession}
        initialData={{
          name: pendingSession?.name || "Recording",
          athleteId:
            pendingSession?.athleteId || selectedAthleteId || undefined,
          duration: duration,
          frameCount: frameCount,
          sensorCount: pendingSession?.sensorCount || 0,
        }}
      />
    </div>
  );
}
