/**
 * BoneTarget.tsx
 * ==============
 * Interactive 3D sphere target rendered at bone centers for V2 sensor assignment.
 * Click a target to assign the currently selected sensor to that body segment.
 */

import { useRef, useState } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { BodyRole } from "../../biomech/topology/SensorRoles";
import { useSensorAssignmentStore } from "../../store/useSensorAssignmentStore";

interface BoneTargetProps {
  role: BodyRole;
  bone: THREE.Bone | null;
  offset: THREE.Vector3;
  isSelected?: boolean;
}

// Map roles to display labels
const ROLE_LABELS: Partial<Record<BodyRole, string>> = {
  [BodyRole.HEAD]: "Head",
  [BodyRole.CHEST]: "Chest",
  [BodyRole.SPINE_LOW]: "Lower Back",
  [BodyRole.PELVIS]: "Pelvis",
  [BodyRole.HIP_L]: "L Thigh",
  [BodyRole.KNEE_L]: "L Shin",
  [BodyRole.FOOT_L]: "L Foot",
  [BodyRole.SKATE_L]: "L Skate",
  [BodyRole.HIP_R]: "R Thigh",
  [BodyRole.KNEE_R]: "R Shin",
  [BodyRole.FOOT_R]: "R Foot",
  [BodyRole.SKATE_R]: "R Skate",
  [BodyRole.SHOULDER_L]: "L Shoulder",
  [BodyRole.ARM_L]: "L Upper Arm",
  [BodyRole.FOREARM_L]: "L Forearm",
  [BodyRole.HAND_L]: "L Hand",
  [BodyRole.SHOULDER_R]: "R Shoulder",
  [BodyRole.ARM_R]: "R Upper Arm",
  [BodyRole.FOREARM_R]: "R Forearm",
  [BodyRole.HAND_R]: "R Hand",
};

export function BoneTarget({ role, bone, offset }: BoneTargetProps) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const [isHovered, setIsHovered] = useState(false);

  // Use unified store
  const { assign, getSensorForRole, selectedSensorId } =
    useSensorAssignmentStore();

  // Check if this role is already assigned
  const assignedSensorId = getSensorForRole(role);
  const isAssigned = !!assignedSensorId;

  // Update mesh position to follow bone
  useFrame(() => {
    if (!bone || !meshRef.current) return;

    // Get bone's world position
    const worldPos = new THREE.Vector3();
    bone.getWorldPosition(worldPos);

    // Apply offset in WORLD SPACE (not rotated by bone)
    // This ensures targets stay at consistent visual positions
    meshRef.current.position.set(
      worldPos.x + offset.x,
      worldPos.y + offset.y,
      worldPos.z + offset.z,
    );
  });

  const handleClick = () => {
    if (selectedSensorId) {
      // Assign the selected sensor to this role - Store handles segmentId translation internally
      assign(selectedSensorId, role, "manual");
      console.debug(`[BoneTarget] Assigned ${selectedSensorId} to ${role}`);
    } else if (isAssigned) {
      // If no sensor selected and target is assigned, show info
      console.debug(`[BoneTarget] ${role} is assigned to ${assignedSensorId}`);
    }
  };

  // Visual styling based on state
  const getColor = () => {
    if (isAssigned) return "#22c55e"; // Green
    if (isHovered) return "#ffffff"; // White
    return "#00bfff"; // Bright cyan for visibility
  };

  const getOpacity = () => {
    if (isAssigned) return 0.9;
    if (isHovered) return 0.95;
    return 0.7; // Much more visible
  };

  const label = ROLE_LABELS[role] || role;

  return (
    <mesh
      ref={meshRef}
      renderOrder={999} // Render on top of everything
      onClick={(e) => {
        e.stopPropagation();
        handleClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setIsHovered(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setIsHovered(false);
        document.body.style.cursor = "auto";
      }}
    >
      <sphereGeometry args={[0.04, 16, 16]} />
      <meshBasicMaterial
        color={getColor()}
        transparent
        opacity={getOpacity()}
        depthTest={false} // Render through other objects
        depthWrite={false} // Don't block other objects
      />

      {/* Label on hover */}
      {isHovered && (
        <Html
          center
          style={{
            pointerEvents: "none",
            transform: "translateY(-30px)",
          }}
        >
          <div className="px-2 py-1 bg-black/80 text-white text-[10px] rounded whitespace-nowrap">
            {label}
            {isAssigned && <span className="text-green-400 ml-1">✓</span>}
          </div>
        </Html>
      )}
    </mesh>
  );
}
