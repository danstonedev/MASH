import { useRef, useEffect, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "../../lib/utils";
import type { SegmentId } from "../../biomech/segmentRegistry";

interface DeviceSelectProps {
  value: SegmentId | null;
  onChange: (value: SegmentId | null) => void;
  placeholder?: string;
  viewMode?: "full_body" | "skate";
}

const FULL_BODY_GROUPS = [
  {
    label: "Core",
    options: [
      { value: "pelvis", label: "Pelvis" },
      { value: "torso", label: "Torso" },
      { value: "head", label: "Head" },
    ],
  },
  {
    label: "Left Leg",
    options: [
      { value: "thigh_l", label: "Left Thigh" },
      { value: "tibia_l", label: "Left Tibia" },
      { value: "foot_l", label: "Left Foot" },
    ],
  },
  {
    label: "Right Leg",
    options: [
      { value: "thigh_r", label: "Right Thigh" },
      { value: "tibia_r", label: "Right Tibia" },
      { value: "foot_r", label: "Right Foot" },
    ],
  },
  {
    label: "Left Arm",
    options: [
      { value: "upper_arm_l", label: "L. Upper Arm" },
      { value: "forearm_l", label: "L. Forearm" },
      { value: "hand_l", label: "L. Hand" },
    ],
  },
  {
    label: "Right Arm",
    options: [
      { value: "upper_arm_r", label: "R. Upper Arm" },
      { value: "forearm_r", label: "R. Forearm" },
      { value: "hand_r", label: "R. Hand" },
    ],
  },
];

const SKATE_GROUPS = [
  {
    label: "Skate Components",
    options: [
      { value: "tibia_r", label: "Right Tibia" },
      { value: "tibia_l", label: "Left Tibia" },
      { value: "foot_r", label: "Right Skate" },
      { value: "foot_l", label: "Left Skate" },
    ],
  },
];

import { createPortal } from "react-dom";

// ... (other imports)

export function DeviceSelect({
  value,
  onChange,
  placeholder = "Unassigned",
  viewMode = "full_body",
}: DeviceSelectProps) {
  const SEGMENT_GROUPS = viewMode === "skate" ? SKATE_GROUPS : FULL_BODY_GROUPS;
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        // Check if click was inside the portal content (which we need another ref for, or just rely on state)
        // Actually, if we use a portal, the event.target might not be in the containerRef.
        // We need to check if the click target is inside the dropdown menu (which is in the portal).
        const dropdown = document.getElementById("device-select-dropdown");
        if (dropdown && dropdown.contains(event.target as Node)) return;

        setIsOpen(false);
      }
    }

    // Update position when scrolling or resizing
    function updatePosition() {
      if (containerRef.current && isOpen) {
        const rect = containerRef.current.getBoundingClientRect();
        // Check if we should open UP or DOWN based on space
        const spaceBelow = window.innerHeight - rect.bottom;
        const openUp = spaceBelow < 300; // If less than 300px below, open up

        setPosition({
          top: openUp ? rect.top - 10 : rect.bottom + 5, // Slight offset
          left: rect.left,
          width: rect.width,
        });
      }
    }

    if (isOpen) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true); // Capture scroll on all containers
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen]);

  const selectedLabel = value
    ? SEGMENT_GROUPS.flatMap((g) => g.options).find((o) => o.value === value)
        ?.label
    : placeholder;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-[120px] bg-bg-surface px-2 py-1 rounded text-[10px] text-text-primary border border-border hover:border-accent/50 focus:border-accent focus:shadow-[0_0_8px_rgba(0,154,68,0.2)] outline-none transition-all"
      >
        <span className="truncate mr-1">{selectedLabel}</span>
        <ChevronDown className="h-3 w-3 text-text-secondary" />
      </button>

      {isOpen &&
        createPortal(
          <div
            id="device-select-dropdown"
            className="fixed z-[9999] bg-[#111111] border border-zinc-600 rounded-md shadow-2xl animate-in fade-in zoom-in-95 duration-100 overflow-y-auto max-h-[300px]"
            style={{
              top: position.top,
              left: position.left + position.width - 192,
              width: 192,
              transform:
                position.top <
                (containerRef.current?.getBoundingClientRect().top || 0)
                  ? "translateY(-100%)"
                  : "none",
            }}
          >
            <div className="p-1">
              <button
                className={cn(
                  "w-full text-left px-2 py-1.5 rounded text-[10px] flex items-center transition-colors",
                  value === null
                    ? "bg-accent text-white font-medium"
                    : "text-text-secondary hover:bg-white/5 hover:text-text-primary",
                )}
                onClick={() => {
                  onChange(null);
                  setIsOpen(false);
                }}
              >
                <span className="flex-1">Unassigned</span>
                {value === null && <Check className="h-3 w-3" />}
              </button>

              {SEGMENT_GROUPS.map((group) => (
                <div key={group.label} className="mt-1">
                  <div className="px-2 py-1 text-[9px] font-semibold text-text-secondary uppercase tracking-wider bg-bg-surface/50">
                    {group.label}
                  </div>
                  {group.options.map((option) => (
                    <button
                      key={option.value}
                      className={cn(
                        "w-full text-left px-2 py-1.5 rounded text-[10px] flex items-center transition-colors",
                        value === option.value
                          ? "bg-accent text-white font-medium"
                          : "text-text-primary hover:bg-white/5 hover:text-white",
                      )}
                      onClick={() => {
                        onChange(option.value as SegmentId);
                        setIsOpen(false);
                      }}
                    >
                      <span className="flex-1">{option.label}</span>
                      {value === option.value && <Check className="h-3 w-3" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
