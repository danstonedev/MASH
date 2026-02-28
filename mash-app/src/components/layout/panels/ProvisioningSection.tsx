import { useState } from "react";
import { Tag, RefreshCw, Check } from "lucide-react";
import { connectionManager } from "../../../lib/connection/ConnectionManager";
import { cn } from "../../../lib/utils";
import type { SegmentId } from "../../../biomech/segmentRegistry";

// Body part options for provisioning
const BODY_PARTS: { label: string; value: string; segment: SegmentId }[] = [
  { label: "Pelvis", value: "Pelvis", segment: "pelvis" },
  { label: "Torso", value: "Torso", segment: "torso" },
  { label: "Head", value: "Head", segment: "head" },
  { label: "Left Thigh", value: "LeftThigh", segment: "thigh_l" },
  { label: "Right Thigh", value: "RightThigh", segment: "thigh_r" },
  { label: "Left Tibia", value: "LeftTibia", segment: "tibia_l" },
  { label: "Right Tibia", value: "RightTibia", segment: "tibia_r" },
  { label: "Left Foot", value: "LeftFoot", segment: "foot_l" },
  { label: "Right Foot", value: "RightFoot", segment: "foot_r" },
  { label: "Left Arm", value: "LeftArm", segment: "upper_arm_l" },
  { label: "Right Arm", value: "RightArm", segment: "upper_arm_r" },
  { label: "Left Forearm", value: "LeftForearm", segment: "forearm_l" },
  { label: "Right Forearm", value: "RightForearm", segment: "forearm_r" },
];

type ProvisionStatus = "idle" | "sending" | "success" | "error";

export function ProvisioningSection() {
  const [selectedPart, setSelectedPart] = useState<string>("");
  const [status, setStatus] = useState<ProvisionStatus>("idle");

  const handleProvision = async () => {
    if (!selectedPart) return;

    setStatus("sending");

    try {
      await connectionManager.sendCommand("SET_NAME", {
        name: `IMU-${selectedPart}`,
      });
      setStatus("success");

      // Reset after showing success
      setTimeout(() => {
        setStatus("idle");
      }, 3000);
    } catch (error) {
      console.error("[Provisioning] Failed:", error);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  return (
    <div className="p-4 border-b border-border space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Tag className="h-4 w-4 text-text-secondary" />
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          Device Provisioning
        </span>
      </div>

      <p className="text-[10px] text-text-secondary leading-relaxed">
        Permanently assign this sensor to a body part. Device will reboot and
        auto-map on next connection.
      </p>

      <select
        value={selectedPart}
        onChange={(e) => setSelectedPart(e.target.value)}
        className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent"
        disabled={status === "sending"}
      >
        <option value="">Select body part...</option>
        {BODY_PARTS.map((part) => (
          <option key={part.value} value={part.value}>
            {part.label}
          </option>
        ))}
      </select>

      <button
        onClick={handleProvision}
        disabled={!selectedPart || status === "sending"}
        className={cn(
          "w-full flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-md transition-all duration-200 border",
          status === "success"
            ? "bg-success/20 text-success border-success/50"
            : status === "error"
              ? "bg-danger/20 text-danger border-danger/50"
              : selectedPart
                ? "bg-accent text-white border-accent hover:bg-accent/80"
                : "bg-bg-elevated text-text-secondary border-border cursor-not-allowed",
        )}
      >
        {status === "sending" ? (
          <>
            <RefreshCw className="h-4 w-4 animate-spin" />
            SENDING...
          </>
        ) : status === "success" ? (
          <>
            <Check className="h-4 w-4" />
            DEVICE REBOOTING
          </>
        ) : (
          <>
            <Tag className="h-4 w-4" />
            ASSIGN & RENAME
          </>
        )}
      </button>

      {status === "success" && (
        <div className="p-2 bg-success/10 border border-success/20 rounded text-[10px] text-success leading-tight animate-in fade-in">
          ✓ Name saved! Device is rebooting. It will appear as "IMU-
          {selectedPart}" on next scan.
        </div>
      )}
    </div>
  );
}
