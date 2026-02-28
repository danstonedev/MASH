/**
 * Quality Metrics Card
 * ====================
 *
 * Displays research-quality metrics for connected sensors:
 * - Orientation uncertainty (±degrees)
 * - Yaw drift rate (deg/min)
 * - Overall quality score
 *
 * For Phase 1 of research-quality improvements.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Target, TrendingDown } from "lucide-react";
import {
  getDeviceUncertaintyDeg,
  getDeviceDriftMetrics,
  getDeviceQualityScore,
  useDeviceRegistry,
} from "../../store/useDeviceRegistry";
import {
  assessUncertainty,
  formatUncertainty,
} from "../../lib/math/uncertainty";
import {
  formatDriftRate,
  getDriftMonitor,
  getDriftQualityColor,
  getDriftState,
} from "../../calibration/DriftMonitor";
import { useSensorAssignmentStore } from "../../store/useSensorAssignmentStore";

interface QualityMetricsCardProps {
  /** If provided, show metrics for specific device; otherwise show aggregated */
  deviceId?: string;
  /** Compact mode for sidebar */
  compact?: boolean;
}

export function QualityMetricsCard({
  deviceId,
  compact = false,
}: QualityMetricsCardProps) {
  const [metrics, setMetrics] = useState<{
    uncertainty: [number, number, number] | null;
    quality: number;
    driftRate: number;
    yawCorrectionDeg: number;
    timeSinceZuptMs: number | null;
  } | null>(null);

  const formatZuptAge = (ms: number | null): string => {
    if (ms === null) return "N/A";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getZuptAgeColor = (ms: number | null): string => {
    if (ms === null) return "#9ca3af";
    if (ms < 2000) return "#22c55e";
    if (ms < 10000) return "#eab308";
    return "#ef4444";
  };

  const devices = useDeviceRegistry((state) => state.devices);

  useEffect(() => {
    const updateMetrics = () => {
      if (deviceId) {
        // Single device
        setMetrics({
          uncertainty: getDeviceUncertaintyDeg(deviceId),
          quality: getDeviceQualityScore(deviceId),
          driftRate: getDeviceDriftMetrics(deviceId)?.yawDriftDegPerMin || 0,
          yawCorrectionDeg: getDriftMonitor(deviceId).getYawCorrection(),
          timeSinceZuptMs: getDriftState(deviceId)?.timeSinceZUPT ?? null,
        });
      } else {
        // Aggregate across all devices
        let totalQuality = 0;
        let maxDrift = 0;
        let maxYawCorrection = 0;
        let maxZuptAge = 0;
        let hasZuptAge = false;
        let maxUncertainty: [number, number, number] = [0, 0, 0];
        let count = 0;

        devices.forEach((_, id) => {
          const q = getDeviceQualityScore(id);
          const d = getDeviceDriftMetrics(id)?.yawDriftDegPerMin || 0;
          const yawCorrection = Math.abs(
            getDriftMonitor(id).getYawCorrection(),
          );
          const driftState = getDriftState(id);
          const u = getDeviceUncertaintyDeg(id);

          if (q > 0) {
            totalQuality += q;
            maxDrift = Math.max(maxDrift, d);
            maxYawCorrection = Math.max(maxYawCorrection, yawCorrection);
            if (driftState) {
              hasZuptAge = true;
              maxZuptAge = Math.max(maxZuptAge, driftState.timeSinceZUPT);
            }
            if (u) {
              maxUncertainty = [
                Math.max(maxUncertainty[0], u[0]),
                Math.max(maxUncertainty[1], u[1]),
                Math.max(maxUncertainty[2], u[2]),
              ];
            }
            count++;
          }
        });

        if (count > 0) {
          setMetrics({
            uncertainty: maxUncertainty,
            quality: totalQuality / count,
            driftRate: maxDrift,
            yawCorrectionDeg: maxYawCorrection,
            timeSinceZuptMs: hasZuptAge ? maxZuptAge : null,
          });
        } else {
          setMetrics(null);
        }
      }
    };

    // Update every 500ms
    const interval = setInterval(updateMetrics, 500);
    updateMetrics();

    return () => clearInterval(interval);
  }, [deviceId, devices]);

  if (!metrics || devices.size === 0) {
    return compact ? null : (
      <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-lg p-3">
        <p className="text-[10px] text-white/50 text-center">
          Connect sensors to see quality metrics
        </p>
      </div>
    );
  }

  const avgUncertainty = metrics.uncertainty
    ? (metrics.uncertainty[0] +
        metrics.uncertainty[1] +
        metrics.uncertainty[2]) /
      3
    : 0;

  const assessment = assessUncertainty(avgUncertainty);
  const qualityPercent = Math.round(metrics.quality * 100);

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-[10px]">
        <div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: assessment.color }}
        />
        <span className="text-text-secondary">Quality:</span>
        <span className="font-mono text-text-primary">{qualityPercent}%</span>
        <span className="text-text-secondary ml-2">Drift:</span>
        <span
          className="font-mono"
          style={{
            color: getDriftQualityColor(
              metrics.driftRate < 3
                ? "good"
                : metrics.driftRate < 5
                  ? "acceptable"
                  : "poor",
            ),
          }}
        >
          {formatDriftRate(metrics.driftRate)}
        </span>
        <span className="text-text-secondary ml-2">Yaw Corr:</span>
        <span className="font-mono text-text-primary">
          {`${metrics.yawCorrectionDeg >= 0 ? "+" : ""}${metrics.yawCorrectionDeg.toFixed(1)}°`}
        </span>
        <span className="text-text-secondary ml-2">ZUPT Age:</span>
        <span
          className="font-mono"
          style={{ color: getZuptAgeColor(metrics.timeSinceZuptMs) }}
        >
          {formatZuptAge(metrics.timeSinceZuptMs)}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-green-400" />
          <span className="text-xs font-mono text-white/70 uppercase tracking-wider">
            Data Quality
          </span>
        </div>
        <div
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold"
          style={{
            backgroundColor: `${assessment.color}20`,
            color: assessment.color,
          }}
        >
          {assessment.level.toUpperCase()}
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="p-3 space-y-2">
        {/* Overall Quality */}
        <div className="flex justify-between items-center">
          <span className="text-[10px] text-text-secondary uppercase">
            Quality Score
          </span>
          <div className="flex items-center gap-2">
            <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${qualityPercent}%`,
                  backgroundColor: assessment.color,
                }}
              />
            </div>
            <span className="text-[10px] font-mono text-text-primary w-8 text-right">
              {qualityPercent}%
            </span>
          </div>
        </div>

        {/* Per-Sensor Quality Breakdown */}
        {!deviceId &&
          Array.from(devices.entries()).filter(([_, d]) => d.isConnected)
            .length > 1 && (
            <div className="pt-2 border-t border-white/10 mt-2">
              <span className="text-[9px] text-white/40 uppercase mb-1 block">
                Per Sensor
              </span>
              <div className="space-y-1">
                {Array.from(devices.entries())
                  .filter(([_, d]) => d.isConnected)
                  .map(([id, device]) => {
                    const segment = useSensorAssignmentStore
                      .getState()
                      .getSegmentForSensor(device.id);
                    const sensorQuality = getDeviceQualityScore(id);
                    const qualityPct = Math.round(sensorQuality);
                    const color =
                      sensorQuality >= 80
                        ? "#22c55e"
                        : sensorQuality >= 60
                          ? "#eab308"
                          : sensorQuality >= 40
                            ? "#f97316"
                            : "#ef4444";
                    return (
                      <div
                        key={id}
                        className="flex justify-between items-center"
                      >
                        <span className="text-[9px] text-white/60 truncate max-w-[100px]">
                          {segment || device.name || id}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <div className="w-10 h-1 bg-border rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${qualityPct}%`,
                                backgroundColor: color,
                              }}
                            />
                          </div>
                          <span
                            className="text-[9px] font-mono w-7 text-right"
                            style={{ color }}
                          >
                            {qualityPct}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

        {/* Uncertainty */}
        {metrics.uncertainty && (
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-text-secondary uppercase flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Uncertainty
            </span>
            <span
              className="text-[10px] font-mono"
              style={{ color: assessment.color }}
            >
              {formatUncertainty(avgUncertainty)}
            </span>
          </div>
        )}

        {/* Live Drift Correction (debug visibility for runtime correction path) */}
        <div className="flex justify-between items-center">
          <span className="text-[10px] text-text-secondary uppercase flex items-center gap-1">
            <TrendingDown className="h-3 w-3" />
            Yaw Correction
          </span>
          <span className="text-[10px] font-mono text-text-primary">
            {`${metrics.yawCorrectionDeg >= 0 ? "+" : ""}${metrics.yawCorrectionDeg.toFixed(2)}°`}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-[10px] text-text-secondary uppercase">
            Last ZUPT Age
          </span>
          <span
            className="text-[10px] font-mono"
            style={{ color: getZuptAgeColor(metrics.timeSinceZuptMs) }}
          >
            {formatZuptAge(metrics.timeSinceZuptMs)}
          </span>
        </div>

        {/* Yaw Drift */}
        <div className="flex justify-between items-center">
          <span className="text-[10px] text-text-secondary uppercase flex items-center gap-1">
            <TrendingDown className="h-3 w-3" />
            Yaw Drift
          </span>
          <span
            className="text-[10px] font-mono"
            style={{
              color: getDriftQualityColor(
                metrics.driftRate < 1
                  ? "excellent"
                  : metrics.driftRate < 3
                    ? "good"
                    : metrics.driftRate < 5
                      ? "acceptable"
                      : "poor",
              ),
            }}
          >
            {formatDriftRate(metrics.driftRate)}
          </span>
        </div>

        {/* Axis Breakdown (collapsed by default) */}
        {metrics.uncertainty && avgUncertainty > 2 && (
          <div className="pt-2 border-t border-white/10 mt-2 text-[9px] text-white/50">
            <div className="flex justify-between">
              <span>Roll: {formatUncertainty(metrics.uncertainty[0])}</span>
              <span>Pitch: {formatUncertainty(metrics.uncertainty[1])}</span>
              <span>Yaw: {formatUncertainty(metrics.uncertainty[2])}</span>
            </div>
          </div>
        )}
      </div>

      {/* Warning if quality is poor */}
      {assessment.level === "poor" && (
        <div className="px-3 py-2 bg-danger/10 border-t border-white/10 flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-danger" />
          <span className="text-[10px] text-danger">{assessment.message}</span>
        </div>
      )}
    </div>
  );
}
