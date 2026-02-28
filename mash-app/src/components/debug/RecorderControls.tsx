import { useEffect, useState, useCallback } from "react";
import { PlayCircle, StopCircle, FileJson, FileText, FileSpreadsheet, Info } from "lucide-react";
import {
  debugRecorder,
  exportRecordingToJSON,
  exportRecordingToCSV,
  exportRecordingToText,
} from "../../lib/diagnostics/DebugRecorder";

export function RecorderControls() {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [snapshotCount, setSnapshotCount] = useState(0);

  // Sync with recorder if it was started externally (e.g. via console)
  const recorderRunning = debugRecorder.getIsRecording();
  useEffect(() => {
    if (recorderRunning && !isRecording) {
      setIsRecording(true);
    }
  }, [recorderRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for live stats
  useEffect(() => {
    const interval = setInterval(() => {
      const running = debugRecorder.getIsRecording();
      if (running) {
        setDuration(debugRecorder.getCurrentDuration());
        setSnapshotCount(debugRecorder.getSnapshotCount());
      } else if (isRecording) {
        // Recorder stopped externally
        setIsRecording(false);
      }
      // Always show buffered count even when stopped
      if (!running) {
        setSnapshotCount(debugRecorder.getSnapshotCount());
      }
    }, 100);
    return () => clearInterval(interval);
  }, [isRecording]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      debugRecorder.stop();
      setIsRecording(false);
    } else {
      debugRecorder.clear();
      debugRecorder.start();
      setIsRecording(true);
      setDuration(0);
      setSnapshotCount(0);
    }
  }, [isRecording]);

  const download = useCallback((format: "json" | "csv" | "txt") => {
    const recording = debugRecorder.getRecording();
    if (!recording || recording.snapshots.length === 0) {
      alert("No recording data available. Start and stop a recording first.");
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `imu-debug-${timestamp}`;

    if (format === "json") {
      exportRecordingToJSON(recording, `${filename}.json`);
    } else if (format === "csv") {
      exportRecordingToCSV(recording, `${filename}.csv`);
    } else {
      exportRecordingToText(recording, `${filename}.txt`);
    }
  }, []);

  return (
    <div className="flex flex-col gap-2 p-3 bg-bg-elevated border border-border rounded-lg">
       <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Diagnostics Recorder</h3>
          <div className="text-[10px] font-mono text-text-tertiary">
            {isRecording ? (
              <span className="text-red-400 animate-pulse">● REC {duration.toFixed(1)}s</span>
            ) : (
              <span>{snapshotCount} samples buffered</span>
            )}
          </div>
       </div>

       <div className="flex flex-wrap gap-2">
          {!isRecording ? (
            <button
              onClick={toggleRecording}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-500/10 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 text-xs font-medium transition-colors"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              Start Recording
            </button>
          ) : (
            <button
              onClick={toggleRecording}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 text-xs font-medium transition-colors animate-pulse"
            >
              <StopCircle className="w-3.5 h-3.5" />
              Stop Recording
            </button>
          )}

          <div className="w-px bg-border mx-1" />

          <button
             onClick={() => download("json")}
             disabled={isRecording || snapshotCount === 0}
             className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 disabled:opacity-30 text-[10px]"
             title="Download JSON"
          >
            <FileJson className="w-3 h-3" /> JSON
          </button>
          <button
             onClick={() => download("csv")}
             disabled={isRecording || snapshotCount === 0}
             className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 disabled:opacity-30 text-[10px]"
             title="Download CSV"
          >
            <FileSpreadsheet className="w-3 h-3" /> CSV
          </button>
          <button
             onClick={() => download("txt")}
             disabled={isRecording || snapshotCount === 0}
             className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 disabled:opacity-30 text-[10px]"
             title="Download Report"
          >
            <FileText className="w-3 h-3" /> Report
          </button>
       </div>

       {/* Recording guidance */}
       {!isRecording && snapshotCount === 0 && (
         <div className="flex items-start gap-1.5 mt-1 px-1">
           <Info className="w-3 h-3 text-blue-400 mt-0.5 shrink-0" />
           <span className="text-[10px] text-text-tertiary leading-tight">
             Records stream health snapshots every 1s. Use to capture intermittent issues, export for analysis.
           </span>
         </div>
       )}
    </div>
  );
}
