/**
 * Magnetometer Calibration Card
 * ==============================
 *
 * UI component for calibrating the magnetometer sensor.
 * Guides user through figure-8 motion to collect hard/soft iron offsets.
 *
 * Auto-detects magnetometer from either:
 * - Network store (node info packets)
 * - Optional sensors store (environmental packets)
 */

import { useState, useEffect, useMemo } from "react";
import { Compass, Play, RotateCcw, CheckCircle2 } from "lucide-react";
import { Button } from "../ui/Button";
import { connectionManager } from "../../lib/connection/ConnectionManager";
import { useDeviceStore } from "../../store/useDeviceStore";
import { useNetworkStore } from "../../store/useNetworkStore";
import { useOptionalSensorsStore } from "../../store/useOptionalSensorsStore";

interface MagCalibrationStatus {
  hasMagnetometer: boolean;
  isCalibrating: boolean;
  isCalibrated: boolean;
  progress: number;
  hardIron?: { x: number; y: number; z: number };
  softIronScale?: { x: number; y: number; z: number };
  sampleCount?: number;
  currentReading?: { x: number; y: number; z: number; heading: number };
}

export function MagnetometerCalibrationCard() {
  const { isConnected } = useDeviceStore();
  const nodes = useNetworkStore((state) => state.nodes);

  // Check optional sensors store (gets updated from environmental packets)
  const optionalHasMag = useOptionalSensorsStore(
    (state) => state.hasMagnetometer,
  );

  // Find the first node that has magnetometer from network store
  const magnetometerNode = useMemo(() => {
    for (const [nodeId, node] of nodes) {
      if (node.hasMagnetometer) {
        return { nodeId, node };
      }
    }
    return null;
  }, [nodes]);

  // Magnetometer is available if either store reports it
  const hasMagnetometer = !!magnetometerNode || optionalHasMag;

  const [status, setStatus] = useState<MagCalibrationStatus | null>(() => ({
    hasMagnetometer: false,
    isCalibrating: false,
    isCalibrated: false,
    progress: 0,
  }));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calibrationDuration, setCalibrationDuration] = useState(15000); // 15 seconds default

  // Update status when magnetometer is detected
  useEffect(() => {
    if (hasMagnetometer) {
      setStatus((prev) => ({
        ...prev!,
        hasMagnetometer: true,
      }));
    }
  }, [hasMagnetometer]);

  // Listen for calibration progress updates
  useEffect(() => {
    const handleProgress = (event: Event) => {
      const customEvent = event as CustomEvent;
      const data = customEvent.detail;

      // Handle mag calibration progress
      if (data.type === "mag_calibration_progress") {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                progress: data.progress ?? 0,
                isCalibrating: data.isCalibrating ?? false,
                isCalibrated: data.isCalibrated ?? prev.isCalibrated,
              }
            : null,
        );
      }

      // Also handle mag_calibration type (firmware might use this)
      if (data.type === "mag_calibration") {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                progress: data.progress ?? prev.progress,
                isCalibrating: data.isCalibrating ?? prev.isCalibrating,
                isCalibrated: data.isCalibrated ?? prev.isCalibrated,
                hardIron: data.hardIron ?? prev.hardIron,
                softIronScale: data.softIronScale ?? prev.softIronScale,
                sampleCount: data.sampleCount ?? prev.sampleCount,
              }
            : null,
        );
      }
    };

    window.addEventListener("ble-json-packet", handleProgress);
    return () => window.removeEventListener("ble-json-packet", handleProgress);
  }, []);

  const startCalibration = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await connectionManager.sendCommand("CALIBRATE_MAG", {
        duration: calibrationDuration,
      });
      setStatus((prev) =>
        prev ? { ...prev, isCalibrating: true, progress: 0 } : null,
      );
    } catch (e) {
      setError("Failed to start calibration");
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const clearCalibration = async () => {
    setIsLoading(true);
    try {
      await connectionManager.sendCommand("CLEAR_MAG_CALIBRATION");
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              isCalibrated: false,
              hardIron: undefined,
              softIronScale: undefined,
            }
          : null,
      );
    } catch (e) {
      setError("Failed to clear calibration");
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  // No connected device
  if (!isConnected) {
    return null; // Don't render if not connected
  }

  // Always show when connected - firmware may not report magnetometer status until queried

  return (
    <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-text-secondary" />
          <span className="text-xs font-semibold text-text-secondary uppercase">
            Magnetometer Calibration
          </span>
        </div>
        <div className="flex items-center gap-2">
          {magnetometerNode && (
            <span className="text-[9px] text-accent bg-accent/10 px-1.5 py-0.5 rounded">
              {magnetometerNode.node.name}
            </span>
          )}
          {!hasMagnetometer && (
            <span className="text-[9px] text-warning bg-warning/10 px-1.5 py-0.5 rounded">
              Detecting...
            </span>
          )}
          {status?.isCalibrated && (
            <div className="flex items-center gap-1 text-success">
              <CheckCircle2 className="h-3 w-3" />
              <span className="text-[10px] font-medium">Calibrated</span>
            </div>
          )}
        </div>
      </div>

      {/* Calibration in progress */}
      {status?.isCalibrating && (
        <div className="space-y-2">
          <div className="p-3 bg-accent/10 border border-accent/20 rounded space-y-2">
            <p className="text-xs text-accent font-medium">
              Calibrating... Move sensor in figure-8 pattern
            </p>
            <p className="text-[10px] text-text-secondary">
              Slowly rotate the device through all orientations to capture the
              full magnetic field range.
            </p>

            {/* Progress bar */}
            <div className="h-2 bg-bg-primary rounded-full overflow-hidden">
              {/* eslint-disable-next-line react/forbid-component-props */}
              <div
                className={`h-full bg-accent transition-all duration-300 w-[${status.progress}%]`}
                style={{ width: `${status.progress}%` }}
              />
            </div>
            <p className="text-[10px] text-text-tertiary text-center">
              {status.progress}% complete
            </p>
          </div>

          {/* Current reading during calibration */}
          {status.currentReading && (
            <div className="grid grid-cols-4 gap-1 text-[9px] font-mono">
              <div className="bg-bg-primary p-1 rounded text-center">
                <span className="text-text-tertiary">X: </span>
                <span className="text-text-primary">
                  {status.currentReading.x.toFixed(1)}
                </span>
              </div>
              <div className="bg-bg-primary p-1 rounded text-center">
                <span className="text-text-tertiary">Y: </span>
                <span className="text-text-primary">
                  {status.currentReading.y.toFixed(1)}
                </span>
              </div>
              <div className="bg-bg-primary p-1 rounded text-center">
                <span className="text-text-tertiary">Z: </span>
                <span className="text-text-primary">
                  {status.currentReading.z.toFixed(1)}
                </span>
              </div>
              <div className="bg-bg-primary p-1 rounded text-center">
                <span className="text-text-tertiary">HDG: </span>
                <span className="text-accent">
                  {status.currentReading.heading.toFixed(0)}°
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Not calibrating - show status and controls */}
      {!status?.isCalibrating && (
        <>
          {/* Calibration data (if calibrated) */}
          {status?.isCalibrated && status.hardIron && (
            <div className="space-y-2 text-[10px]">
              <div className="p-2 bg-bg-primary rounded">
                <p className="text-text-tertiary mb-1">
                  Hard Iron Offsets (μT)
                </p>
                <div className="grid grid-cols-3 gap-2 font-mono">
                  <span>X: {status.hardIron.x.toFixed(2)}</span>
                  <span>Y: {status.hardIron.y.toFixed(2)}</span>
                  <span>Z: {status.hardIron.z.toFixed(2)}</span>
                </div>
              </div>
              {status.softIronScale && (
                <div className="p-2 bg-bg-primary rounded">
                  <p className="text-text-tertiary mb-1">Soft Iron Scale</p>
                  <div className="grid grid-cols-3 gap-2 font-mono">
                    <span>X: {status.softIronScale.x.toFixed(3)}</span>
                    <span>Y: {status.softIronScale.y.toFixed(3)}</span>
                    <span>Z: {status.softIronScale.z.toFixed(3)}</span>
                  </div>
                </div>
              )}
              {status.sampleCount && (
                <p className="text-text-tertiary">
                  Samples collected: {status.sampleCount}
                </p>
              )}
            </div>
          )}

          {/* Duration selector */}
          <div className="space-y-1">
            <label
              htmlFor="mag-calibration-duration"
              className="text-[10px] text-text-tertiary"
            >
              Calibration Duration
            </label>
            <select
              id="mag-calibration-duration"
              title="Select calibration duration"
              className="w-full bg-bg-primary border border-border rounded px-2 py-1.5 text-xs"
              value={calibrationDuration}
              onChange={(e) => setCalibrationDuration(Number(e.target.value))}
            >
              <option value={10000}>10 seconds (quick)</option>
              <option value={15000}>15 seconds (recommended)</option>
              <option value={20000}>20 seconds (thorough)</option>
              <option value={30000}>30 seconds (precision)</option>
            </select>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="gradient"
              className="flex-1"
              onClick={startCalibration}
              disabled={isLoading}
            >
              <Play className="h-3 w-3 mr-1" />
              {status?.isCalibrated ? "RECALIBRATE" : "START CALIBRATION"}
            </Button>
            {status?.isCalibrated && (
              <Button
                size="sm"
                variant="outline"
                onClick={clearCalibration}
                disabled={isLoading}
              >
                <RotateCcw className="h-3 w-3" />
              </Button>
            )}
          </div>

          {/* Instructions */}
          <div className="p-2 bg-bg-primary/50 rounded text-[9px] text-text-tertiary space-y-1">
            <p className="font-medium text-text-secondary">How to calibrate:</p>
            <ol className="list-decimal list-inside space-y-0.5">
              <li>Click "Start Calibration"</li>
              <li>Slowly rotate the sensor in a figure-8 pattern</li>
              <li>Cover all orientations (tilt, roll, yaw)</li>
              <li>Keep moving until calibration completes</li>
            </ol>
          </div>
        </>
      )}

      {/* Error message */}
      {error && (
        <div className="p-2 bg-error/10 border border-error/20 rounded">
          <p className="text-[10px] text-error">{error}</p>
        </div>
      )}
    </div>
  );
}
