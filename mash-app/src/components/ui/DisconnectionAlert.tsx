import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { useDeviceRegistry } from "../../store/useDeviceRegistry";
import { useDeviceStore } from "../../store/useDeviceStore";
import { useSensorAssignmentStore } from "../../store/useSensorAssignmentStore";
import { SEGMENT_DEFINITIONS } from "../../biomech/segmentRegistry";
import { unifiedCalibration } from "../../calibration/UnifiedCalibration";
import { useRecordingStore } from "../../store/useRecordingStore";
import { useCalibrationStore } from "../../store/useCalibrationStore";
import { useTareStore } from "../../store/useTareStore";

/**
 * Global Disconnection Alert
 * Displays a prominent warning when a sensor disconnects unexpectedly.
 * Also handles auto-stopping of critical processes (Calibration, Recording).
 */
export function DisconnectionAlert() {
  const lastDisconnectedDeviceId = useDeviceRegistry(
    (state) => state.lastDisconnectedDeviceId,
  );
  const lastDisconnectTime = useDeviceRegistry(
    (state) => state.lastDisconnectTime,
  );
  const connect = useDeviceStore((state) => state.connect);
  const isScanning = useDeviceStore((state) => state.isScanning);
  const isRecording = useRecordingStore((state) => state.isRecording);
  const isPaused = useRecordingStore((state) => state.isPaused);
  const pauseRecording = useRecordingStore((state) => state.pauseRecording);
  const getSegmentForSensor = useSensorAssignmentStore(
    (state) => state.getSegmentForSensor,
  );
  const [visible, setVisible] = useState(false);
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [resumeAfterReconnect, setResumeAfterReconnect] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const segmentLabel = useMemo(() => {
    if (!lastDisconnectedDeviceId) return "Sensor";
    const segment = getSegmentForSensor(lastDisconnectedDeviceId);
    if (segment && SEGMENT_DEFINITIONS[segment]) {
      return SEGMENT_DEFINITIONS[segment].name;
    }
    return lastDisconnectedDeviceId;
  }, [lastDisconnectedDeviceId, getSegmentForSensor]);

  useEffect(() => {
    if (lastDisconnectedDeviceId && lastDisconnectTime) {
      if (Date.now() - lastDisconnectTime < 15000) {
        setVisible(true);
        setErrorMessage(null);
        setReconnectBusy(false);

        const calState = unifiedCalibration.getState();
        if (
          calState.step !== "idle" &&
          calState.step !== "complete" &&
          calState.step !== "error"
        ) {
          console.debug(
            "[DisconnectionAlert] Aborting calibration due to sensor loss",
          );
          unifiedCalibration.fail(
            `Sensor ${lastDisconnectedDeviceId} disconnected during calibration`,
          );
        }

        if (isRecording && !isPaused) {
          console.debug(
            "[DisconnectionAlert] Pausing recording due to sensor loss",
          );
          pauseRecording();
          setResumeAfterReconnect(true);
        } else {
          setResumeAfterReconnect(false);
        }
      }
    }
  }, [
    isPaused,
    isRecording,
    lastDisconnectedDeviceId,
    lastDisconnectTime,
    pauseRecording,
  ]);

  const handleReconnectAndResume = async () => {
    setReconnectBusy(true);
    setErrorMessage(null);

    try {
      useTareStore.getState().resetAll();
      useCalibrationStore.getState().reset();

      await connect();

      if (resumeAfterReconnect) {
        useRecordingStore.getState().resumeRecording();
      }

      setVisible(false);
      setResumeAfterReconnect(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message || "Reconnect failed");
    } finally {
      setReconnectBusy(false);
    }
  };

  if (!visible || !lastDisconnectedDeviceId) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/15 bg-bg-elevated/95 shadow-2xl">
        <div className="flex items-start gap-4 border-b border-white/10 px-6 py-5">
          <div className="mt-0.5 rounded-full bg-danger/20 p-2 text-danger">
            <AlertCircle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-text-primary">
              {segmentLabel} Disconnected
            </h3>
            <p className="mt-1 text-sm text-text-secondary">
              Recording is paused while we recover the hardware connection.
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Sensor ID:{" "}
              <span className="font-mono">{lastDisconnectedDeviceId}</span>
            </p>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          {errorMessage && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {errorMessage}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleReconnectAndResume}
              disabled={reconnectBusy || isScanning}
              className="inline-flex items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RotateCcw className="h-4 w-4" />
              {reconnectBusy || isScanning
                ? "Reconnecting..."
                : resumeAfterReconnect
                  ? "Attempt Reconnect & Resume"
                  : "Attempt Reconnect"}
            </button>

            <button
              onClick={() => setVisible(false)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-white/5"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
