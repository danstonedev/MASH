import { BodyRole, TopologyType } from './SensorRoles';

/**
 * CapabilityMatrix.ts
 * 
 * Defines what features are unlocked by a set of connected BodyRoles.
 * The system is no longer rigid; it adapts based on "Detected Nodes".
 */

export interface SystemCapabilities {
    instrumentTelemetry: boolean; // Skate/Blade analysis
    lowerBodyIK: boolean;         // Hips/Knees
    upperBodyIK: boolean;         // Arms/Spine
    spineAnalysis: boolean;       // Posture
    precisionKnee: boolean;       // Valgus/Varus (requires Thighs)
    propTracking: boolean;        // Object interaction
}

export class CapabilityMatrix {

    /**
     * Determine the TopologyType based on minimal set of active roles.
     */
    public static deduceTopology(activeRoles: Set<BodyRole>): TopologyType {
        // Full Body Check (17+)
        // Simple check: Do we have Head, Pelvis, and extremities?
        const hasCore = activeRoles.has(BodyRole.HEAD) && activeRoles.has(BodyRole.PELVIS);
        const hasLegs = activeRoles.has(BodyRole.FOOT_L) && activeRoles.has(BodyRole.FOOT_R)
            && activeRoles.has(BodyRole.KNEE_L) && activeRoles.has(BodyRole.KNEE_R);
        const hasArms = activeRoles.has(BodyRole.HAND_L) && activeRoles.has(BodyRole.HAND_R);

        if (hasCore && hasLegs && hasArms) return TopologyType.FULL_BODY;

        // Sparse Body Check (6)
        if (activeRoles.has(BodyRole.PELVIS) && activeRoles.has(BodyRole.HAND_L) && activeRoles.has(BodyRole.HAND_R)
            && activeRoles.has(BodyRole.FOOT_L) && activeRoles.has(BodyRole.FOOT_R)) {
            return TopologyType.SPARSE_BODY;
        }

        // Full Leg Check (7)
        if (activeRoles.has(BodyRole.PELVIS)
            && activeRoles.has(BodyRole.HIP_L) && activeRoles.has(BodyRole.KNEE_L) && activeRoles.has(BodyRole.FOOT_L)
            && activeRoles.has(BodyRole.HIP_R) && activeRoles.has(BodyRole.KNEE_R) && activeRoles.has(BodyRole.FOOT_R)) {
            return TopologyType.FULL_LEG;
        }

        // Upper Chain Check (4) - New
        if (activeRoles.has(BodyRole.CHEST) && activeRoles.has(BodyRole.HEAD)
            && activeRoles.has(BodyRole.HAND_L) && activeRoles.has(BodyRole.HAND_R)) {
            return TopologyType.SPARSE_ARM; // Or a specific UPPER_CHAIN type if needed
        }

        // Sparse Arm Check (3) - New
        if (activeRoles.has(BodyRole.CHEST) && activeRoles.has(BodyRole.HAND_L) && activeRoles.has(BodyRole.HAND_R)) {
            return TopologyType.SPARSE_ARM;
        }

        // Sparse Leg Check (3)
        if (activeRoles.has(BodyRole.PELVIS) && activeRoles.has(BodyRole.FOOT_L) && activeRoles.has(BodyRole.FOOT_R)) {
            return TopologyType.SPARSE_LEG;
        }

        // Dual Skate Check (2)
        if ((activeRoles.has(BodyRole.FOOT_L) || activeRoles.has(BodyRole.SKATE_L))
            && (activeRoles.has(BodyRole.FOOT_R) || activeRoles.has(BodyRole.SKATE_R))) {
            return TopologyType.DUAL_SKATE;
        }

        // Core Only Check (1) - New
        if (activeRoles.has(BodyRole.CHEST) || activeRoles.has(BodyRole.SPINE_LOW)) {
            return TopologyType.CORE;
        }

        // Default
        return activeRoles.size > 0 ? TopologyType.SINGLE_SENSOR : TopologyType.CUSTOM;
    }

    /**
     * Unlock feature flags based on roles.
     * This is more granular than TopologyType.
     */
    public static getCapabilities(activeRoles: Set<BodyRole>): SystemCapabilities {
        return {
            instrumentTelemetry: activeRoles.has(BodyRole.SKATE_L) || activeRoles.has(BodyRole.SKATE_R)
                || activeRoles.has(BodyRole.FOOT_L) || activeRoles.has(BodyRole.FOOT_R),

            lowerBodyIK: activeRoles.has(BodyRole.PELVIS)
                && (activeRoles.has(BodyRole.FOOT_L) || activeRoles.has(BodyRole.SKATE_L))
                && (activeRoles.has(BodyRole.FOOT_R) || activeRoles.has(BodyRole.SKATE_R)),

            upperBodyIK: activeRoles.has(BodyRole.CHEST)
                && activeRoles.has(BodyRole.HAND_L) && activeRoles.has(BodyRole.HAND_R),

            spineAnalysis: activeRoles.has(BodyRole.PELVIS) && activeRoles.has(BodyRole.CHEST),

            precisionKnee: activeRoles.has(BodyRole.HIP_L) && activeRoles.has(BodyRole.KNEE_L)
                && activeRoles.has(BodyRole.HIP_R) && activeRoles.has(BodyRole.KNEE_R),

            propTracking: activeRoles.has(BodyRole.PROP_1) || activeRoles.has(BodyRole.PROP_2)
        };
    }
}

/**
 * Standard sensor configurations for Guided Setup
 */
export const TOPOLOGY_REQUIREMENTS: Partial<Record<TopologyType, BodyRole[]>> = {
    [TopologyType.FULL_BODY]: [
        BodyRole.HEAD, BodyRole.CHEST, BodyRole.PELVIS,
        BodyRole.SHOULDER_L, BodyRole.ARM_L, BodyRole.FOREARM_L, BodyRole.HAND_L,
        BodyRole.SHOULDER_R, BodyRole.ARM_R, BodyRole.FOREARM_R, BodyRole.HAND_R,
        BodyRole.HIP_L, BodyRole.KNEE_L, BodyRole.FOOT_L,
        BodyRole.HIP_R, BodyRole.KNEE_R, BodyRole.FOOT_R
    ],
    // 6 Sensors
    [TopologyType.SPARSE_BODY]: [
        BodyRole.HEAD, BodyRole.PELVIS,
        BodyRole.HAND_L, BodyRole.HAND_R,
        BodyRole.FOOT_L, BodyRole.FOOT_R
    ],
    // 7 Sensors
    [TopologyType.FULL_LEG]: [
        BodyRole.PELVIS,
        BodyRole.HIP_L, BodyRole.KNEE_L, BodyRole.FOOT_L,
        BodyRole.HIP_R, BodyRole.KNEE_R, BodyRole.FOOT_R
    ],
    // 3 Sensors (Lower)
    [TopologyType.SPARSE_LEG]: [
        BodyRole.PELVIS,
        BodyRole.FOOT_L, BodyRole.FOOT_R
    ],
    // 3 Sensors (Upper)
    [TopologyType.SPARSE_ARM]: [
        BodyRole.CHEST,
        BodyRole.HAND_L, BodyRole.HAND_R
    ],
    // 2 Sensors
    [TopologyType.DUAL_SKATE]: [
        BodyRole.FOOT_L, BodyRole.FOOT_R
    ],
    // 1 Sensor
    [TopologyType.CORE]: [
        BodyRole.CHEST
    ]
};
