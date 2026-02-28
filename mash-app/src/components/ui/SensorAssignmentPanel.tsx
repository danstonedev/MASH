/**
 * Sensor Mapping Panel - Hybrid Interface
 * =======================================
 *
 * Best-in-class sensor assignment UX inspired by Xsens/Rokoko.
 * Features:
 * - Hybrid Control: Visual 3D picking + List-based Dropdowns
 * - Explicit Feedback: Clear status indicators and grouping
 * - Bulk Tools: Auto-Assign, Clear All, and Custom Profiles
 */

import { useCallback, memo, useState, useEffect, useMemo } from "react";
import { CheckCircle2, Battery, Signal, Link2Off } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useDeviceRegistry } from "../../store/useDeviceRegistry";
import { useNetworkStore } from "../../store/useNetworkStore";
import { isValidSensorId } from "../../lib/constants/HardwareRanges";
import { useSensorAssignmentStore } from "../../store/useSensorAssignmentStore";
import { BodyRole } from "../../biomech/topology/SensorRoles";
import { cn } from "../../lib/utils";
import {
  getFriendlyIndex,
  getSensorDisplayName,
  registerSensorIds,
} from "../../lib/sensorDisplayName";
// import { Button } from './Button'; // Removed if it causes issues, using HTML button is safer

/**
 * Extract numeric sensor ID from device ID string.
 * Supports both legacy format ('sensor_0') and new multi-device format ('IMU-Connect_Gateway_0').
 * Returns NaN if no valid numeric ID can be extracted.
 */
function extractSensorId(deviceId: string): number {
  // Try legacy format first: 'sensor_X'
  if (deviceId.startsWith("sensor_")) {
    return parseInt(deviceId.substring(7));
  }
  // New format: 'DeviceName_X' - extract the last numeric part after underscore
  const lastUnderscore = deviceId.lastIndexOf("_");
  if (lastUnderscore >= 0) {
    return parseInt(deviceId.substring(lastUnderscore + 1));
  }
  // Fallback: try to parse the whole thing as a number
  return parseInt(deviceId);
}

// Human-readable labels for BodyRoles (grouped)
const ROLE_OPTIONS = [
  { label: "Unassigned", value: "" },
  { label: "--- Legs ---", value: "disabled-legs", disabled: true },
  { label: "Pelvis", value: BodyRole.PELVIS },
  { label: "Left Thigh", value: BodyRole.HIP_L },
  { label: "Left Tibia", value: BodyRole.KNEE_L },
  { label: "Left Foot", value: BodyRole.FOOT_L },
  { label: "Right Thigh", value: BodyRole.HIP_R },
  { label: "Right Tibia", value: BodyRole.KNEE_R },
  { label: "Right Foot", value: BodyRole.FOOT_R },
  { label: "--- Upper Body ---", value: "disabled-upper", disabled: true },
  { label: "Torso", value: BodyRole.CHEST },
  { label: "Head", value: BodyRole.HEAD },
  { label: "Left Arm", value: BodyRole.ARM_L },
  { label: "Left Forearm", value: BodyRole.FOREARM_L },
  { label: "Left Hand", value: BodyRole.HAND_L },
  { label: "Right Arm", value: BodyRole.ARM_R },
  { label: "Right Forearm", value: BodyRole.FOREARM_R },
  { label: "Right Hand", value: BodyRole.HAND_R },
];

export const SensorAssignmentPanel = memo(function SensorAssignmentPanel() {
  const {
    assignments,
    selectedSensorId,
    setSelectedSensorId,
    assign,
    unassign,
  } = useSensorAssignmentStore();

  // Select stable map references from Zustand stores and derive arrays via useMemo.
  // Returning fresh arrays/objects directly from selectors can trigger
  // useSyncExternalStore snapshot loops in React dev mode.
  const devices = useDeviceRegistry((state) => state.devices);
  const nodes = useNetworkStore((state) => state.nodes);

  const connectedDeviceEntries = useMemo(() => {
    const entries: Array<{ id: string; sensorId: number; connected: boolean }> =
      [];
    devices.forEach((device, id) => {
      const numericId = extractSensorId(id);
      if (isNaN(numericId) || !isValidSensorId(numericId)) return;
      if (numericId === 73) return;
      entries.push({
        id,
        sensorId: numericId,
        connected: !!device.isConnected,
      });
    });
    return entries;
  }, [devices]);

  const topologySensorIds = useMemo(() => {
    const ids = new Set<number>();
    nodes.forEach((node) => {
      const count =
        typeof node.sensorCount === "number" && node.sensorCount > 0
          ? node.sensorCount
          : node.sensors.size;
      if (!count || count <= 0) return;
      for (let i = 0; i < count; i++) {
        ids.add((node.id + i) % 256);
      }
    });
    return Array.from(ids).sort((a, b) => a - b);
  }, [nodes]);

  // Build the panel list from topology + live devices so sensors are visible
  // even before their first IMU sample arrives.
  const connectedIds = useMemo(() => {
    const sensorToDeviceId = new Map<number, string>();

    // Prefer connected live device IDs when available.
    for (const entry of connectedDeviceEntries) {
      if (entry.connected) {
        sensorToDeviceId.set(entry.sensorId, entry.id);
      }
    }

    // Add topology-declared sensors that have no live packet yet.
    for (const sensorId of topologySensorIds) {
      if (!sensorToDeviceId.has(sensorId)) {
        sensorToDeviceId.set(sensorId, `sensor_${sensorId}`);
      }
    }

    // Fallback: if topology is still empty, show all connected devices.
    if (sensorToDeviceId.size === 0) {
      for (const entry of connectedDeviceEntries) {
        if (entry.connected) sensorToDeviceId.set(entry.sensorId, entry.id);
      }
    }

    return Array.from(sensorToDeviceId.entries())
      .sort(([a], [b]) => a - b)
      .map(([, deviceId]) => deviceId);
  }, [connectedDeviceEntries, topologySensorIds]);

  // Keep friendly sensor numbering consistent with the rest of the app.
  useEffect(() => {
    registerSensorIds(connectedIds.map((id) => extractSensorId(id)));
  }, [connectedIds]);

  // VIEW STATE
  // const assignedCount = connectedIds.filter(id => assignments.has(id)).length;
  // const hasCustomProfiles = Object.keys(savedProfiles).length > 0; // Unused without dropdown

  // EMPTY STATE
  if (connectedIds.length === 0) {
    return (
      <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-lg p-6 flex flex-col items-center text-center gap-3">
        <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
          <Link2Off className="w-5 h-5 text-white/30" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-white/80">
            No Sensors Connected
          </h3>
          <p className="text-[11px] text-white/40 mt-1">
            Connect devices to configure mapping.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* SENSOR LIST */}
      <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
        <div className="max-h-100 overflow-y-auto p-1 space-y-1">
          {connectedIds.map((id) => (
            <SensorRow
              key={id}
              id={id}
              displayIndex={getFriendlyIndex(extractSensorId(id))}
              rawSensorId={extractSensorId(id)}
              isSelected={selectedSensorId === id}
              onSelect={setSelectedSensorId}
              onAssign={assign}
              onUnassign={unassign}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

// ----------------------------------------------------------------------------
// SENSOR ROW COMPONENT
// ----------------------------------------------------------------------------

interface SensorRowProps {
  id: string;
  displayIndex: number;
  rawSensorId: number;
  isSelected: boolean;
  onSelect: (id: string | null) => void;
  onAssign: (id: string, role: BodyRole, method: "manual") => void;
  onUnassign: (id: string) => void;
}

const SensorRow = memo(function SensorRow({
  id,
  displayIndex,
  rawSensorId,
  isSelected,
  onSelect,
  onAssign,
  onUnassign,
}: SensorRowProps) {
  const [, forceUpdate] = useState(0); // Force re-render for timer

  // Subscribe to specific assignment for this sensor
  const assignment = useSensorAssignmentStore(
    useShallow((state) => state.assignments.get(id)),
  );
  const role = assignment?.bodyRole;

  // Subscribe to device name/battery (FIXED TYPES)
  const deviceState = useDeviceRegistry(
    useShallow((state) => {
      const d = state.devices.get(id);
      return {
        name: d?.name || getSensorDisplayName(rawSensorId),
        battery: d?.battery || 0, // Correct property: battery (number)
        lastTapTime: d?.lastTapTime || 0,
        connectionHealth: d?.connectionHealth || "offline",
      };
    }),
  );

  // Get node name for subtitle display
  const nodeName = useNetworkStore(
    useCallback(
      (state) => state.getNodeNameForSensor(rawSensorId),
      [rawSensorId],
    ),
  );

  // Tap Visual Feedback
  // Tap Visual Feedback
  const isTapped = Date.now() - deviceState.lastTapTime < 3000;

  // Force re-render when tap expires
  useEffect(() => {
    if (isTapped) {
      const timeLeft = 3000 - (Date.now() - deviceState.lastTapTime);
      if (timeLeft > 0) {
        const timer = setTimeout(() => forceUpdate((n) => n + 1), timeLeft);
        return () => clearTimeout(timer);
      }
    }
  }, [deviceState.lastTapTime]);

  const handleRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (!value) {
      onUnassign(id);
    } else {
      onAssign(id, value as BodyRole, "manual");
    }
  };

  const toggleSelection = () => {
    onSelect(isSelected ? null : id);
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-2 p-2 rounded border transition-all relative",
        isTapped
          ? "bg-green-500/50 border-green-400 shadow-[0_0_20px_rgba(34,197,94,0.6)] scale-[1.02] z-10"
          : isSelected
            ? "bg-accent/10 border-accent/50 shadow-[0_0_10px_rgba(234,179,8,0.1)]"
            : "bg-white/5 border-transparent hover:bg-white/10 hover:border-white/10",
      )}
    >
      {/* 1. SELECTION INDICATOR (Click target for 3D picking visualization) */}
      <div onClick={toggleSelection} className="cursor-pointer">
        {role ? (
          <div className="w-8 h-8 rounded bg-success/20 flex items-center justify-center border border-success/30">
            <CheckCircle2 className="w-4 h-4 text-success" />
          </div>
        ) : (
          <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center border border-white/10 group-hover:border-white/20">
            <span className="text-[10px] font-mono font-bold text-white/30">
              {displayIndex > 0 ? displayIndex : "-"}
            </span>
          </div>
        )}
      </div>

      {/* 2. SENSOR INFO */}
      <div
        className="flex-1 min-w-0 flex flex-col justify-center"
        onClick={toggleSelection}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-white/90 truncate">
            Sensor {displayIndex > 0 ? displayIndex : rawSensorId}
          </span>
          {/* Tiny Status Icons */}
          <div className="flex items-center gap-1 opacity-40">
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                deviceState.connectionHealth === "active"
                  ? "bg-green-400"
                  : deviceState.connectionHealth === "stale"
                    ? "bg-yellow-400"
                    : "bg-red-400",
              )}
              title={`Status: ${deviceState.connectionHealth}`}
            />
            <Signal className="w-2.5 h-2.5" />
            <Battery className="w-2.5 h-2.5" />
          </div>
        </div>
        <div className="text-[9px] text-white/40">
          {nodeName ? `${nodeName} • ` : ""}
          ID: {rawSensorId}
          {deviceState.battery > 0 && deviceState.battery < 100
            ? ` • ${deviceState.battery}%`
            : ""}
        </div>
      </div>

      {/* 3. ASSIGNMENT DROPDOWN */}
      <div className="w-27.5">
        <div className="relative">
          <select
            value={role || ""}
            onChange={handleRoleChange}
            aria-label={`Assign sensor ${displayIndex > 0 ? displayIndex : rawSensorId} to body segment`}
            className={cn(
              "w-full bg-[#1a1a1a] text-[10px] rounded px-2 py-1.5 appearance-none cursor-pointer outline-none border transition-colors",
              role
                ? "text-success border-success/30 font-medium"
                : "text-white/40 border-white/10 hover:border-white/30",
            )}
          >
            {ROLE_OPTIONS.map((opt) => (
              <option
                key={opt.value + opt.label}
                value={opt.value}
                disabled={opt.disabled}
                className={
                  opt.disabled
                    ? "bg-white/10 text-white/30 font-bold pt-2 pb-1"
                    : ""
                }
              >
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Visual Flash on Selection */}
      {isSelected && (
        <div className="absolute inset-0 border border-accent rounded pointer-events-none animate-pulse opacity-50" />
      )}
    </div>
  );
});
