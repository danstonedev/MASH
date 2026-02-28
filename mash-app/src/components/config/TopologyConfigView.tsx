import { useState, useEffect } from "react";
import { Vibrate, ArrowRight, RotateCcw } from "lucide-react";

import { useShallow } from "zustand/react/shallow";
import {
  useDeviceRegistry,
  deviceAccelCache,
} from "../../store/useDeviceRegistry";
import { useSensorAssignmentStore } from "../../store/useSensorAssignmentStore";
import { BodyMap2D } from "../../components/visualization/BodyMap2D";
import { BodyRole, TopologyType } from "../../biomech/topology/SensorRoles";
import { TOPOLOGY_REQUIREMENTS } from "../../biomech/topology/CapabilityMatrix";

/**
 * TopologyConfigView
 *
 * Phase 10: "The Digital Mannequin"
 * Allows users to assign physical sensors to anatomical roles via a 3D interface.
 */
interface TopologyConfigViewProps {
  onComplete?: () => void;
}

export function TopologyConfigView({ onComplete }: TopologyConfigViewProps) {
  // Subscribe only to IDs to prevent re-renders on device data updates
  const connectedDeviceIds = useDeviceRegistry(
    useShallow((state) =>
      Array.from(state.devices.values())
        .filter((d) => d.isConnected)
        .map((d) => d.id),
    ),
  );

  // Get name for selected sensor (stable subscription)
  const selectedSensorName = useDeviceRegistry((state) =>
    selectedSensorId ? state.devices.get(selectedSensorId)?.name : undefined,
  );

  // Unified Store
  const { assign, unassign, clearAll, activeTopology, assignments } =
    useSensorAssignmentStore();

  // State
  const [selectedSensorId, setSelectedSensorId] = useState<string | null>(null);
  const [guideTopology, setGuideTopology] = useState<TopologyType | null>(null);

  // Derived
  const sensorCount = connectedDeviceIds.length;
  const assignmentCount = assignments.size;

  // Suggested Topologies
  const suggestedTopologies = Object.entries(TOPOLOGY_REQUIREMENTS)
    .filter(([_, roles]) => roles.length <= sensorCount)
    .sort((a, b) => b[1].length - a[1].length);

  // Shake Detection Logic (Ported from SensorAssignmentPanel)
  const [shakingId, setShakingId] = useState<string | null>(null);
  const SHAKE_THRESHOLD = 8; // m/s² (approx 0.8g dynamic)

  useEffect(() => {
    let frameId: number;
    const checkMotion = () => {
      let maxMotion = 0;
      let maxId = null;

      connectedDeviceIds.forEach((id) => {
        const accel = deviceAccelCache.get(id) as number[] | undefined;
        if (accel && accel.length >= 3) {
          const mag = Math.sqrt(accel[0] ** 2 + accel[1] ** 2 + accel[2] ** 2);
          const motion = Math.abs(mag - 9.8);
          if (motion > SHAKE_THRESHOLD && motion > maxMotion) {
            maxMotion = motion;
            maxId = id;
          }
        }
      });

      if (maxId && maxId !== shakingId) {
        setShakingId(maxId);
        // Auto-select the shaking sensor for convenience - DISABLED to prevent flashing
        // setSelectedSensorId(maxId);
      } else if (!maxId && shakingId) {
        setTimeout(() => setShakingId(null), 500); // Debounce clear
      }
      frameId = requestAnimationFrame(checkMotion);
    };
    frameId = requestAnimationFrame(checkMotion);
    return () => cancelAnimationFrame(frameId);
  }, [connectedDeviceIds, shakingId]);

  const handleSensorClick = (sensorId: string) => {
    if (selectedSensorId === sensorId) {
      setSelectedSensorId(null);
    } else {
      setSelectedSensorId(sensorId);
    }
  };

  const handleBoneClick = (role: BodyRole) => {
    if (selectedSensorId) {
      assign(selectedSensorId, role, "manual");
      setSelectedSensorId(null); // Auto-deselect after assignment for speed
    } else {
      // Find sensor on this role and unassign?
      // Reverse lookup: need to find sensor ID for this role
      // The Store has getSensorForRole but we need ID to unassign?
      // Actually unassign takes sensorId.
      // Let's find assignment by role
      const assignment = Array.from(assignments.values()).find(
        (a) => a.bodyRole === role,
      );
      if (assignment) {
        unassign(assignment.sensorId);
      }
    }
  };

  return (
    <div className="flex h-full gap-4">
      {/* LEFT PANEL: Sensor List */}
      <div className="w-[280px] flex flex-col gap-4 bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Vibrate className="w-5 h-5 text-orange-500" />
            Sensors
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Shake a sensor to identify it. Select a sensor, then click the body
            part.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 pr-2">
          {connectedDeviceIds.map((id) => (
            <SensorListItem
              key={id}
              id={id}
              isSelected={selectedSensorId === id}
              isShaking={shakingId === id}
              onClick={handleSensorClick}
            />
          ))}

          {connectedDeviceIds.length === 0 && (
            <div className="text-center py-8 text-slate-500 text-sm">
              No sensors connected.
            </div>
          )}
        </div>

        <div className="pt-4 border-t border-slate-700/50 flex flex-col gap-3">
          {/* Primary Action Button */}
          <button
            onClick={() => {
              if (onComplete) onComplete();
            }}
            disabled={assignmentCount === 0}
            className={`
                            w-full py-3 rounded font-bold transition-all text-sm
                            ${
                              assignmentCount > 0
                                ? "bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/50"
                                : "bg-slate-700 text-slate-500 cursor-not-allowed"
                            }
                        `}
          >
            {assignmentCount > 0 ? "Confirm & Calibrate" : "Assign Sensors"}
          </button>

          <button
            onClick={clearAll}
            className="w-full py-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded flex items-center justify-center gap-2 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Reset Mapping
          </button>

          <div className="text-center mt-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">
              Active Topology:{" "}
            </span>
            <span className="text-xs font-bold text-green-400">
              {activeTopology.replace("_", " ")}
            </span>
          </div>
        </div>
      </div>

      {/* CENTER PANEL: Body Map 2D */}
      <div className="flex-1 relative bg-gradient-to-b from-slate-900 to-slate-800 flex items-center justify-center h-full min-h-0 flex-col rounded-xl overflow-hidden border border-slate-700/50">
        {sensorCount > 0 && (
          <div className="absolute top-4 z-10 flex gap-2 overflow-x-auto max-w-full px-4 items-center mask-linear">
            <div className="text-xs text-slate-400 whitespace-nowrap mr-2">
              Quick Setups:
            </div>
            {suggestedTopologies.map(([typeStr, _roles]) => {
              const type = typeStr as TopologyType;
              const isActive = guideTopology === type;
              return (
                <button
                  key={type}
                  onClick={() => setGuideTopology(isActive ? null : type)}
                  className={`
                                         px-3 py-1 rounded-full text-xs font-bold border transition-all whitespace-nowrap
                                         ${
                                           isActive
                                             ? "bg-blue-600 border-blue-400 text-white shadow ring-2 ring-blue-500/50"
                                             : "bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700"
                                         }
                                     `}
                >
                  {type.replace("_", " ")}
                </button>
              );
            })}
          </div>
        )}

        <BodyMap2D
          onRoleSelect={handleBoneClick}
          selectedRole={null}
          highlightedRoles={
            guideTopology ? TOPOLOGY_REQUIREMENTS[guideTopology] : undefined
          }
        />

        {/* Overlay Instruction */}
        <div className="absolute top-16 left-0 right-0 text-center pointer-events-none">
          {selectedSensorId ? (
            <div className="inline-block bg-blue-600/90 text-white px-4 py-2 rounded-full shadow-lg backdrop-blur animate-bounce">
              Select Body Part for <b>{selectedSensorName}</b>...
            </div>
          ) : (
            !guideTopology && (
              <div className="inline-block bg-black/50 text-slate-300 px-4 py-1 rounded-full text-sm backdrop-blur">
                Select a sensor, then click a body part
              </div>
            )
          )}

          {guideTopology && !selectedSensorId && (
            <div className="inline-block bg-blue-900/80 text-blue-200 px-4 py-1 rounded-full text-sm backdrop-blur border border-blue-500/30 mt-2">
              Fill the <b>pulsing blue segments</b>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Extracted for performance
function SensorListItem({
  id,
  isSelected,
  isShaking,
  onClick,
}: {
  id: string;
  isSelected: boolean;
  isShaking: boolean;
  onClick: (id: string) => void;
}) {
  // Stable subscriptions
  const name = useDeviceRegistry((state) => state.devices.get(id)?.name);
  const assignedRole = useSensorAssignmentStore((state) =>
    state.getRoleForSensor(id),
  );

  // Formatting
  const formatRole = (r: string) => {
    const displayMap: Record<string, string> = {
      HIP_L: "Left Thigh",
      KNEE_L: "Left Tibia",
      HIP_R: "Right Thigh",
      KNEE_R: "Right Tibia",
      ARM_L: "Left Upper Arm",
      ARM_R: "Right Upper Arm",
      FOREARM_L: "Left Forearm",

      FOREARM_R: "Right Forearm",
      SHOULDER_L: "Left Shoulder",
      SHOULDER_R: "Right Shoulder",
      SKATE_L: "Left Skate",
      SKATE_R: "Right Skate",
    };
    return (
      displayMap[r] ||
      r
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (l) => l.toUpperCase())
    );
  };

  // "Node 27" -> "Sensor 27", or fallback
  const rawName = name || `IMU ${id.slice(-4)}`;
  const deviceName = rawName.replace(/^Node\s*/i, "IMU ");

  const primaryLabel = assignedRole ? formatRole(assignedRole) : deviceName;
  const secondaryLabel = assignedRole ? deviceName : id.slice(-4);

  return (
    <div
      onClick={() => onClick(id)}
      className={`
                p-3 rounded-lg border cursor-pointer transition-all flex items-center gap-3 relative overflow-hidden
                ${isSelected ? "bg-blue-600 border-blue-400 shadow-lg shadow-blue-900/50" : "bg-slate-800 border-slate-700 hover:border-slate-500"}
                ${isShaking ? "animate-pulse ring-2 ring-orange-500 ring-offset-2 ring-offset-slate-900" : ""}
            `}
    >
      <div
        className={`w-2 h-full absolute left-0 top-0 ${assignedRole ? "bg-green-500" : "bg-slate-600"}`}
      />

      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className="text-sm font-bold text-white truncate leading-tight">
          {primaryLabel}
        </div>
        <div
          className={`text-xs font-mono mt-0.5 truncate ${isSelected ? "text-blue-200" : "text-slate-400"}`}
        >
          {secondaryLabel}
        </div>
      </div>

      {isSelected && <ArrowRight className="w-4 h-4 text-white shrink-0" />}
    </div>
  );
}
