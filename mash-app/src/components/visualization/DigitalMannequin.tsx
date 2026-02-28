import { useMemo, useState } from 'react';
import { createPortal } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { BodyRole } from '../../biomech/topology/SensorRoles';
import { useSensorAssignmentStore } from '../../store/useSensorAssignmentStore';
import { SkeletonUtils } from 'three-stdlib';

/**
 * Maps BodyRole enum to Mixamo Bone Names
 */
const ROLE_TO_BONE: Partial<Record<BodyRole, string>> = {
    [BodyRole.HEAD]: 'mixamorig1Head',
    [BodyRole.NECK]: 'mixamorig1Neck',
    [BodyRole.CHEST]: 'mixamorig1Spine2',
    [BodyRole.SPINE_LOW]: 'mixamorig1Spine',
    [BodyRole.PELVIS]: 'mixamorig1Hips',

    [BodyRole.SHOULDER_L]: 'mixamorig1LeftShoulder',
    [BodyRole.ARM_L]: 'mixamorig1LeftArm',
    [BodyRole.FOREARM_L]: 'mixamorig1LeftForeArm',
    [BodyRole.HAND_L]: 'mixamorig1LeftHand',

    [BodyRole.SHOULDER_R]: 'mixamorig1RightShoulder',
    [BodyRole.ARM_R]: 'mixamorig1RightArm',
    [BodyRole.FOREARM_R]: 'mixamorig1RightForeArm',
    [BodyRole.HAND_R]: 'mixamorig1RightHand',

    [BodyRole.HIP_L]: 'mixamorig1LeftUpLeg',
    [BodyRole.KNEE_L]: 'mixamorig1LeftLeg',
    [BodyRole.FOOT_L]: 'mixamorig1LeftFoot',
    [BodyRole.TOE_L]: 'mixamorig1LeftToeBase',

    [BodyRole.HIP_R]: 'mixamorig1RightUpLeg',
    [BodyRole.KNEE_R]: 'mixamorig1RightLeg',
    [BodyRole.FOOT_R]: 'mixamorig1RightFoot',
    [BodyRole.TOE_R]: 'mixamorig1RightToeBase',
};

interface DigitalMannequinProps {
    onRoleSelect?: (role: BodyRole) => void;
    selectedRole?: BodyRole | null;
}

export function DigitalMannequin({ onRoleSelect, selectedRole }: DigitalMannequinProps) {
    const { scene } = useGLTF('/models/Neutral_Model.glb');

    // Clone logic: Ensure we have a fresh instance with correct skeletal binding
    const clone = useMemo(() => {
        const clonedScene = SkeletonUtils.clone(scene);

        // Critical: Disable raycasting on the skin/meshes so they don't block 
        // pointer events to our internal BoneMarkers.
        clonedScene.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                // Disable raycast
                child.raycast = () => { };
                // Optional: Make it look a bit "ghostly" or standard
                // (child as THREE.Mesh).material = new THREE.MeshStandardMaterial({ color: 0x444444, transparent: true, opacity: 0.5 });
            }
        });

        return clonedScene;
    }, [scene]);

    // Use unified store
    const { getAssignedRoles } = useSensorAssignmentStore();
    const assignedRoles = getAssignedRoles();

    // We can pre-calculate the assigned set for O(1) lookups
    const assignedRoleSet = useMemo(() => new Set(assignedRoles), [assignedRoles]);

    const [hoveredBone, setHoveredBone] = useState<string | null>(null);

    // Create a map of BoneName -> BodyRole for reverse lookup
    const boneToRoleMap = useMemo(() => {
        const map = new Map<string, BodyRole>();
        Object.entries(ROLE_TO_BONE).forEach(([role, boneName]) => {
            map.set(boneName, role as BodyRole);
        });
        return map;
    }, []);

    // Helper to get color status
    const getBoneColor = (boneName: string) => {
        const role = boneToRoleMap.get(boneName);
        if (!role) return '#888888'; // Not an assignable bone

        // Is assigned?
        const isAssigned = assignedRoleSet.has(role);

        // Is selected?
        if (selectedRole === role) return '#FFFF00'; // Highlight
        // Is hovered?
        if (hoveredBone === boneName) return '#FFFFFF';

        if (isAssigned) return '#4CAF50'; // Green
        // Default color for unassigned bones
        return '#FF5252'; // Red (Missing)
    };

    return (
        <group>
            <primitive
                object={clone}
                scale={[1, 1, 1]}
            />

            {/* Render clickable markers attached to bones via Portal */}
            {Object.entries(ROLE_TO_BONE).map(([role, boneName]) => {
                const bone = clone.getObjectByName(boneName);
                if (!bone) return null;

                return (
                    <BoneMarker
                        key={role}
                        bone={bone as THREE.Bone}
                        boneName={boneName}
                        color={getBoneColor(boneName)}
                        onClick={() => onRoleSelect && onRoleSelect(role as BodyRole)}
                        onHover={(state: boolean) => setHoveredBone(state ? boneName : null)}
                    />
                );
            })}
        </group>
    );
}

interface BoneMarkerProps {
    bone: THREE.Bone;
    boneName: string;
    // role: BodyRole; // Unused
    color: string;
    onClick: () => void;
    onHover: (state: boolean) => void;
}

function BoneMarker({ bone, color, onClick, onHover }: BoneMarkerProps) {
    // Use createPortal to render the mesh INSIDE the bone's local space
    // This ensures it moves/rotates with the bone without breaking the skeleton hierarchy
    return createPortal(
        <mesh
            onPointerOver={(e) => { e.stopPropagation(); onHover(true); }}
            onPointerOut={(e) => { e.stopPropagation(); onHover(false); }}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            // ...
            renderOrder={999} // Always render on top
        >
            <sphereGeometry args={[0.08, 16, 16]} />
            <meshStandardMaterial
                color={color}
                transparent
                opacity={0.6}
                depthTest={false} // Visual always on top
                depthWrite={false}
            />
        </mesh>,
        bone
    );
}
