import { BodyRole } from "../../biomech/topology/SensorRoles";
import { useSensorAssignmentStore } from "../../store/useSensorAssignmentStore";

interface BodyMap2DProps {
  onRoleSelect?: (role: BodyRole) => void;
  selectedRole?: BodyRole | null;
  highlightedRoles?: BodyRole[];
}

// Hitbox Paths matching the T-Pose "mannequin_preview.png"
// Coordinate Space: 0 0 100 100 (Percentage-based relative to square container)
const HITBOXES: Record<string, string> = {
  // Head & Torso
  [BodyRole.HEAD]: "M50,2 C45,2 43,12 50,14 C57,12 55,2 50,2 Z",
  [BodyRole.CHEST]: "M42,15 L58,15 L55,35 L45,35 Z",
  [BodyRole.SPINE_LOW]: "M45,35 L55,35 L55,45 L45,45 Z",
  [BodyRole.PELVIS]: "M43,45 L57,45 L55,52 L45,52 Z",

  // Left Arm (Viewer's Left - Anatomical Right)
  [BodyRole.SHOULDER_R]: "M30,16 L42,15 L42,20 L30,22 Z",
  [BodyRole.ARM_R]: "M15,18 L30,18 L32,24 L15,22 Z",
  [BodyRole.FOREARM_R]: "M5,20 L15,20 L15,24 L5,24 Z", // Far left
  [BodyRole.HAND_R]: "M0,20 L5,20 L5,25 L0,25 Z",

  // Right Arm (Viewer's Right - Anatomical Left)
  [BodyRole.SHOULDER_L]: "M58,15 L70,16 L70,22 L58,20 Z",
  [BodyRole.ARM_L]: "M70,18 L85,18 L85,22 L72,24 Z",
  [BodyRole.FOREARM_L]: "M85,20 L95,20 L95,24 L85,24 Z",
  [BodyRole.HAND_L]: "M95,20 L100,20 L100,25 L95,25 Z",

  // Legs
  // Note: In T-pose, Hip/Thigh is upper leg, Knee/Tibia is lower leg.
  // Anatomical Right Leg (Viewer Left)
  [BodyRole.HIP_R]: "M44,52 L50,52 L49,75 L43,75 Z", // Thigh R
  [BodyRole.KNEE_R]: "M43,75 L49,75 L48,93 L44,93 Z", // Tibia R
  [BodyRole.FOOT_R]: "M42,93 L48,93 L50,98 L40,98 Z",

  // Anatomical Left Leg (Viewer Right)
  [BodyRole.HIP_L]: "M50,52 L56,52 L57,75 L51,75 Z", // Thigh L
  [BodyRole.KNEE_L]: "M51,75 L57,75 L56,93 L52,93 Z", // Tibia L
  [BodyRole.FOOT_L]: "M52,93 L58,93 L60,98 L50,98 Z",
};

export function BodyMap2D({
  onRoleSelect,
  selectedRole,
  highlightedRoles,
}: BodyMap2DProps) {
  const { getAssignedRoles } = useSensorAssignmentStore();
  const assignedRoles = getAssignedRoles(); // Returns Set<BodyRole>

  const getNodeState = (role: BodyRole) => {
    const isAssigned = assignedRoles.has(role); // Fix: Use .has() for Set
    const isSelected = selectedRole === role;
    const isHighlighted = highlightedRoles
      ? highlightedRoles.includes(role)
      : false;

    // Colors for the OVERLAY
    let fillColor = "transparent";
    let strokeColor = "transparent";
    let opacity = 0; // Default: completely invisible

    if (isAssigned) {
      fillColor = "rgba(34, 197, 94, 0.4)"; // Green-500 @ 40%
      strokeColor = "#22c55e";
      opacity = 1;
    } else if (isHighlighted) {
      fillColor = "rgba(59, 130, 246, 0.3)"; // Blue-500 @ 30%
      strokeColor = "#3b82f6";
      opacity = 1;
    } else if (isSelected) {
      fillColor = "rgba(234, 179, 8, 0.4)"; // Yellow-500 @ 40%
      strokeColor = "#eab308";
      opacity = 1;
    }

    // Hover Effect handled entirely by CSS group-hover logic below
    return {
      fillColor,
      strokeColor,
      opacity,
      isHighlighted,
      isAssigned,
      isSelected,
    };
  };

  return (
    <div className="w-full h-full flex items-center justify-center p-4">
      {/* Container maintaining Image Aspect Ratio */}
      <div className="relative h-full max-h-[500px] aspect-[3/4] select-none">
        {" "}
        {/* Taller aspect for standing model */}
        {/* Background Image */}
        <img
          src="/assets/mannequin_preview.png"
          alt="Body Selector"
          className="absolute inset-0 w-full h-full object-contain opacity-90"
          draggable={false}
          onError={(e) => {
            // Fallback purely for dev if image missing
            console.warn(
              "BodyMap2D: Image not found, ensure /assets/mannequin_preview.png exists",
            );
            e.currentTarget.style.opacity = "0.2";
          }}
        />
        {/* SVG Overlay */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
          style={{ zIndex: 10 }}
        >
          {Object.entries(HITBOXES).map(([roleKey, pathData]) => {
            const role = roleKey as BodyRole;
            const {
              fillColor,
              strokeColor,
              opacity,
              isHighlighted,
              isAssigned,
            } = getNodeState(role);
            const animClass =
              isHighlighted && !isAssigned ? "animate-pulse" : "";

            return (
              <g
                key={role}
                onClick={() => onRoleSelect && onRoleSelect(role)}
                className={`cursor-pointer group ${animClass}`}
              >
                {/* The Hitbox/Overlay */}
                <path
                  d={pathData}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth="0.5"
                  shapeRendering="geometricPrecision"
                  // Use 'style' for opacity to allow hover override
                  style={{ opacity: opacity }}
                  // Hover: Make semi-visible white if normally invisible, or brighten if visible
                  className="transition-all duration-200 group-hover:fill-white/30 group-hover:opacity-100 group-hover:stroke-white/50"
                />
                <title>{role}</title>
              </g>
            );
          })}
        </svg>
        {/* Legend */}
        <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-4 text-[10px] text-slate-400 font-mono pointer-events-none bg-black/60 backdrop-blur-md py-1.5 px-4 rounded-full mx-auto w-max border border-white/5">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full border border-slate-500 bg-transparent"></div>
            Hover
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-500/60 border border-green-500"></div>
            Assigned
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-blue-500/60 border border-blue-500"></div>
            Next
          </div>
        </div>
      </div>
    </div>
  );
}
