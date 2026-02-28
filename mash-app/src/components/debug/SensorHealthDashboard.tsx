import { useEffect, useState, useCallback } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Radio,
  RotateCcw,
} from "lucide-react";
import {
  getSensorHealthSnapshot,
  resetSensorHealth,
  resetAllStats,
  type SensorStreamStatus,
} from "../../lib/connection/SyncedSampleStats";
import { useNetworkStore } from "../../store/useNetworkStore";
import { cn } from "../../lib/utils";

// ============================================================================
// Sensor Health Dashboard
//
// Shows whether each sensor is connected and streaming from the gateway.
// Uses frame sequence continuity (ground truth) — NOT JavaScript Hz timing.
//
// Three states per sensor:
//   Streaming  — data arriving, frame sequence intact
//   Stale      — no data for >1.5s (brief dropout)
//   Offline    — no data for >5s
// ============================================================================

const POLL_MS = 1000;

interface SensorDisplayInfo {
  sensorId: number;
  status: SensorStreamStatus;
  nodeName: string;
}

export function SensorHealthDashboard() {
  const [sensors, setSensors] = useState<SensorDisplayInfo[]>([]);
  const getNodeNameForSensor = useNetworkStore((s) => s.getNodeNameForSensor);

  // Poll for display updates (SyncedSampleStats is always running — no start needed)
  useEffect(() => {
    const interval = setInterval(() => {
      const snapshot = getSensorHealthSnapshot();
      const display: SensorDisplayInfo[] = snapshot.map((s) => ({
        sensorId: s.sensorId,
        status: s.status,
        nodeName: getNodeNameForSensor(s.sensorId) ?? "Unknown Node",
      }));
      setSensors(display);
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [getNodeNameForSensor]);

  const handleReset = useCallback(() => {
    resetSensorHealth();
    setSensors([]);
  }, []);

  // Group by node
  const nodeGroups = new Map<string, SensorDisplayInfo[]>();
  for (const s of sensors) {
    if (!nodeGroups.has(s.nodeName)) nodeGroups.set(s.nodeName, []);
    nodeGroups.get(s.nodeName)!.push(s);
  }

  // Counts
  const total = sensors.length;
  const streaming = sensors.filter((s) => s.status === "streaming").length;
  const stale = sensors.filter((s) => s.status === "stale").length;
  const offline = sensors.filter((s) => s.status === "offline").length;
  const allHealthy = total > 0 && streaming === total;

  return (
    <div className="bg-bg-elevated border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border bg-bg-surface/50">
        <div className="flex items-center gap-2">
          <Radio
            className={cn(
              "w-4 h-4",
              allHealthy
                ? "text-green-400"
                : total === 0
                  ? "text-text-tertiary"
                  : "text-amber-400",
            )}
          />
          <h3 className="text-xs font-bold text-text-secondary uppercase tracking-wider">
            Sensor Health
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {total > 0 && (
            <span
              className={cn(
                "text-[10px] px-2 py-0.5 rounded-full font-medium",
                allHealthy
                  ? "bg-green-500/10 text-green-400 border border-green-500/20"
                  : "bg-amber-500/10 text-amber-400 border border-amber-500/20",
              )}
            >
              {streaming}/{total} Streaming
            </span>
          )}
          <button
            onClick={handleReset}
            className="text-text-tertiary hover:text-text-secondary transition-colors"
            title="Reset tracking"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Summary */}
      {total > 0 && (
        <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
          <SummaryCell
            label="Streaming"
            count={streaming}
            icon={CheckCircle2}
            activeColor="text-green-400"
          />
          <SummaryCell
            label="Stale"
            count={stale}
            icon={AlertTriangle}
            activeColor="text-amber-400"
          />
          <SummaryCell
            label="Offline"
            count={offline}
            icon={XCircle}
            activeColor="text-red-400"
          />
        </div>
      )}

      {/* Per-node groups */}
      <div className="p-3 space-y-3">
        {total === 0 ? (
          <div className="text-center py-6 text-text-tertiary text-xs italic">
            Waiting for gateway connection...
          </div>
        ) : (
          [...nodeGroups.entries()].map(([name, group]) => (
            <NodeGroup key={name} nodeName={name} sensors={group} />
          ))
        )}
      </div>

      {/* Footer */}
      {total > 0 && (
        <div className="px-3 pb-2">
          <div className="text-[9px] text-text-tertiary text-center">
            200 Hz TDMA sync from gateway &middot; Frame sequence tracking
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Node Group
// ============================================================================

function NodeGroup({
  nodeName,
  sensors,
}: {
  nodeName: string;
  sensors: SensorDisplayInfo[];
}) {
  const allOk = sensors.every((s) => s.status === "streaming");

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <div
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            allOk ? "bg-green-500" : "bg-amber-500",
          )}
        />
        <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
          {nodeName}
        </span>
        <span className="text-[10px] text-text-tertiary">
          ({sensors.length} sensor{sensors.length !== 1 ? "s" : ""})
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
        {sensors.map((s) => (
          <SensorTile key={s.sensorId} sensor={s} />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Sensor Tile
// ============================================================================

const CFG = {
  streaming: {
    icon: CheckCircle2,
    label: "Streaming",
    color: "text-green-400",
    border: "border-green-500/30",
    bg: "bg-green-500/5",
  },
  stale: {
    icon: AlertTriangle,
    label: "Stale",
    color: "text-amber-400",
    border: "border-amber-500/30",
    bg: "bg-amber-500/5",
  },
  offline: {
    icon: XCircle,
    label: "Offline",
    color: "text-red-400",
    border: "border-red-500/30",
    bg: "bg-red-500/5",
  },
} as const;

function SensorTile({ sensor }: { sensor: SensorDisplayInfo }) {
  const cfg = CFG[sensor.status];
  const Icon = cfg.icon;

  return (
    <div
      className={cn(
        "p-1.5 rounded border flex items-center gap-1.5",
        cfg.border,
        cfg.bg,
      )}
    >
      <Icon className={cn("w-3 h-3 shrink-0", cfg.color)} />
      <span className="text-[11px] font-mono font-bold text-text-primary">
        #{sensor.sensorId}
      </span>
    </div>
  );
}

// ============================================================================
// Summary Cell
// ============================================================================

function SummaryCell({
  label,
  count,
  icon: Icon,
  activeColor,
}: {
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
  activeColor: string;
}) {
  const color = count > 0 ? activeColor : "text-text-tertiary";
  return (
    <div className="flex items-center justify-center gap-1.5 py-2 bg-bg-surface/20">
      <Icon className={cn("w-3 h-3", color)} />
      <span className={cn("text-xs font-mono font-bold", color)}>{count}</span>
      <span className="text-[9px] text-text-tertiary">{label}</span>
    </div>
  );
}
