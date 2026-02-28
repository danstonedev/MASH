/**
 * Unified Sensor Assignment Store
 * ================================
 *
 * Single source of truth for sensor-to-body mapping.
 * Replaces the dual data model (TopologyManager + DeviceRegistry.segment).
 *
 * Key features:
 * - BodyRole ↔ SegmentId translation layer
 * - Configurable assignment profiles
 * - Persistence across page refreshes
 * - Integration with CapabilityMatrix
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { BodyRole, TopologyType } from "../biomech/topology/SensorRoles";
import {
  CapabilityMatrix,
  type SystemCapabilities,
} from "../biomech/topology/CapabilityMatrix";
import type { SegmentId } from "../biomech/segmentRegistry";

// ============================================================================
// TRANSLATION LAYER: BodyRole ↔ SegmentId
// ============================================================================

/**
 * Maps ISB-standard BodyRole to internal SegmentId.
 * BodyRole = anatomical marker position (HIP_L = sensor on thigh)
 * SegmentId = skeletal segment for rendering (thigh_l = thigh bone mesh)
 */
export const ROLE_TO_SEGMENT: Partial<Record<BodyRole, SegmentId>> = {
  // Central Chain
  [BodyRole.HEAD]: "head",
  [BodyRole.NECK]: "neck", // C7 - cervical
  [BodyRole.SPINE_UPPER]: "spine_upper", // T2 - upper thoracic
  [BodyRole.CHEST]: "torso", // T7/Sternum - mid torso
  [BodyRole.PELVIS]: "pelvis",

  // Left Leg
  [BodyRole.HIP_L]: "thigh_l", // Hip sensor → Thigh segment
  [BodyRole.KNEE_L]: "tibia_l", // Knee sensor → Tibia segment
  [BodyRole.FOOT_L]: "foot_l",
  [BodyRole.SKATE_L]: "foot_l", // Alias for skating

  // Right Leg
  [BodyRole.HIP_R]: "thigh_r",
  [BodyRole.KNEE_R]: "tibia_r",
  [BodyRole.FOOT_R]: "foot_r",
  [BodyRole.SKATE_R]: "foot_r",

  // Left Arm
  [BodyRole.ARM_L]: "upper_arm_l",
  [BodyRole.FOREARM_L]: "forearm_l",
  [BodyRole.HAND_L]: "hand_l",

  // Right Arm
  [BodyRole.ARM_R]: "upper_arm_r",
  [BodyRole.FOREARM_R]: "forearm_r",
  [BodyRole.HAND_R]: "hand_r",
};

/**
 * Reverse lookup: SegmentId → BodyRole
 */
export const SEGMENT_TO_ROLE: Partial<Record<SegmentId, BodyRole>> = {};
for (const [role, segment] of Object.entries(ROLE_TO_SEGMENT)) {
  if (segment) {
    SEGMENT_TO_ROLE[segment as SegmentId] = role as BodyRole;
  }
}

// ============================================================================
// ASSIGNMENT PROFILES
// ============================================================================

export type AssignmentProfile =
  | "auto" // Use provisioned names or disabled
  | "lower_body_7" // Pelvis + 2x(thigh, tibia, foot)
  | "lower_body_3" // Pelvis + feet only
  | "upper_body_3" // Torso + hands
  | "skate_dual" // Left/Right foot only
  | "full_body_17" // ISB full body
  | "custom"; // Manual assignment only

/**
 * Profile-based sensor ID → BodyRole mappings.
 * Used for auto-assignment when sensors connect.
 */
export const PROFILE_MAPPINGS: Record<
  AssignmentProfile,
  Record<number, BodyRole>
> = {
  auto: {}, // No auto-mapping, rely on provisioned names

  lower_body_7: {
    0: BodyRole.PELVIS,
    1: BodyRole.HIP_L,
    2: BodyRole.KNEE_L,
    3: BodyRole.FOOT_L,
    4: BodyRole.HIP_R,
    5: BodyRole.KNEE_R,
    6: BodyRole.FOOT_R,
  },

  lower_body_3: {
    0: BodyRole.PELVIS,
    1: BodyRole.FOOT_L,
    2: BodyRole.FOOT_R,
  },

  upper_body_3: {
    0: BodyRole.CHEST,
    1: BodyRole.HAND_L,
    2: BodyRole.HAND_R,
  },

  skate_dual: {
    0: BodyRole.SKATE_L,
    1: BodyRole.SKATE_R,
  },

  full_body_17: {
    0: BodyRole.PELVIS,
    1: BodyRole.HIP_L,
    2: BodyRole.KNEE_L,
    3: BodyRole.FOOT_L,
    4: BodyRole.HIP_R,
    5: BodyRole.KNEE_R,
    6: BodyRole.FOOT_R,
    7: BodyRole.CHEST,
    8: BodyRole.HEAD,
    9: BodyRole.ARM_L,
    10: BodyRole.FOREARM_L,
    11: BodyRole.HAND_L,
    12: BodyRole.ARM_R,
    13: BodyRole.FOREARM_R,
    14: BodyRole.HAND_R,
  },

  custom: {}, // Manual assignment only
};

export const PROFILE_DISPLAY_NAMES: Record<AssignmentProfile, string> = {
  auto: "Auto (Provisioned Names)",
  lower_body_7: "Lower Body (7 sensors)",
  lower_body_3: "Lower Body Sparse (3 sensors)",
  upper_body_3: "Upper Body (3 sensors)",
  skate_dual: "Skate Analysis (2 sensors)",
  full_body_17: "Full Body (17 sensors)",
  custom: "Custom (Manual)",
};

// ============================================================================
// STORE TYPES
// ============================================================================

export interface SensorAssignment {
  sensorId: string; // e.g., 'sensor_0'
  bodyRole: BodyRole; // e.g., BodyRole.HIP_L
  segmentId: SegmentId; // e.g., 'thigh_l' (derived from bodyRole)
  method: "auto" | "manual" | "provisioned";
  assignedAt: number;
}

interface SensorAssignmentState {
  // Core State
  assignments: Map<string, SensorAssignment>;
  activeProfile: AssignmentProfile | string; // Allow custom profile names
  savedProfiles: Record<string, Record<string, BodyRole>>; // Name -> { SensorID -> Role }

  // UI State (for click-to-assign workflow)
  selectedSensorId: string | null;

  // Computed (cached)
  activeTopology: TopologyType;
  capabilities: SystemCapabilities;

  // Actions
  assign: (
    sensorId: string,
    bodyRole: BodyRole,
    method?: "auto" | "manual" | "provisioned",
  ) => void;
  unassign: (sensorId: string) => void;
  clearAll: () => void;
  setProfile: (profile: AssignmentProfile | string) => void;
  saveProfile: (name: string) => void;
  loadProfile: (name: string) => void;
  deleteProfile: (name: string) => void;
  setSelectedSensorId: (id: string | null) => void;

  // Auto-assignment
  autoAssignByName: (sensorId: string, provisionedName: string) => boolean;

  // Getters
  getSegmentForSensor: (sensorId: string) => SegmentId | null;
  getSegmentByNumericId: (numericId: number) => SegmentId | null; // For playback fallback
  getRoleForSensor: (sensorId: string) => BodyRole | null;
  getSensorForRole: (role: BodyRole) => string | null;
  getSensorForSegment: (segment: SegmentId) => string | null;
  getAssignedRoles: () => Set<BodyRole>;
  getAssignedSegments: () => SegmentId[];

  // Internal
  _recalculateTopology: () => void;
}

// ============================================================================
// STORE IMPLEMENTATION
// ============================================================================

export const useSensorAssignmentStore = create<SensorAssignmentState>()(
  persist(
    (set, get) => ({
      assignments: new Map(),
      activeProfile: "lower_body_7",
      savedProfiles: {},
      selectedSensorId: null,
      activeTopology: TopologyType.SINGLE_SENSOR,
      capabilities: {
        instrumentTelemetry: false,
        lowerBodyIK: false,
        upperBodyIK: false,
        spineAnalysis: false,
        precisionKnee: false,
        propTracking: false,
      },

      // ----------------------------------------------------------------
      // ACTIONS
      // ----------------------------------------------------------------

      assign: (sensorId, bodyRole, method = "manual") => {
        const segmentId = ROLE_TO_SEGMENT[bodyRole];
        if (!segmentId) {
          console.warn(
            `[AssignmentStore] No segment mapping for role: ${bodyRole}`,
          );
          return;
        }

        const existingForSensor = get().assignments.get(sensorId);
        if (
          existingForSensor &&
          existingForSensor.bodyRole === bodyRole &&
          existingForSensor.segmentId === segmentId
        ) {
          return;
        }

        const assignments = new Map(get().assignments);

        // Remove any existing assignment for this sensor
        assignments.delete(sensorId);

        // Remove any existing assignment for this role (one sensor per role)
        for (const [existingSensorId, assignment] of assignments.entries()) {
          if (assignment.bodyRole === bodyRole) {
            assignments.delete(existingSensorId);
            console.debug(
              `[AssignmentStore] Unassigned ${existingSensorId} from ${bodyRole} (replaced)`,
            );
          }
        }

        // Create new assignment
        const assignment: SensorAssignment = {
          sensorId,
          bodyRole,
          segmentId,
          method,
          assignedAt: Date.now(),
        };

        assignments.set(sensorId, assignment);

        console.debug(
          `[AssignmentStore] Assigned ${sensorId} → ${bodyRole} (${segmentId})`,
        );

        set({
          assignments,
          selectedSensorId: null, // Auto-deselect after assignment
        });

        get()._recalculateTopology();
      },

      unassign: (sensorId) => {
        const assignments = new Map(get().assignments);
        const assignment = assignments.get(sensorId);

        if (assignment) {
          assignments.delete(sensorId);
          console.debug(
            `[AssignmentStore] Unassigned ${sensorId} from ${assignment.bodyRole}`,
          );

          set({ assignments });
          get()._recalculateTopology();
        }
      },

      clearAll: () => {
        console.debug("[AssignmentStore] Clearing all assignments");
        set({
          assignments: new Map(),
          selectedSensorId: null,
          activeTopology: TopologyType.SINGLE_SENSOR,
          capabilities: {
            instrumentTelemetry: false,
            lowerBodyIK: false,
            upperBodyIK: false,
            spineAnalysis: false,
            precisionKnee: false,
            propTracking: false,
          },
        });
      },

      setProfile: (profile) => {
        console.debug(`[AssignmentStore] Setting profile: ${profile}`);
        set({ activeProfile: profile });
      },

      saveProfile: (name) => {
        const { assignments, savedProfiles } = get();
        const profileMap: Record<string, BodyRole> = {};

        assignments.forEach((a, id) => {
          profileMap[id] = a.bodyRole;
        });

        set({
          savedProfiles: {
            ...savedProfiles,
            [name]: profileMap,
          },
          activeProfile: name,
        });
        console.debug(
          `[AssignmentStore] Saved profile '${name}' with ${Object.keys(profileMap).length} assignments`,
        );
      },

      loadProfile: (name) => {
        const { savedProfiles } = get();
        const profile = savedProfiles[name];

        if (!profile) {
          console.warn(`[AssignmentStore] Profile '${name}' not found`);
          return;
        }

        // Clear current and apply profile
        const newAssignments = new Map<string, SensorAssignment>();

        Object.entries(profile).forEach(([sensorId, bodyRole]) => {
          const segmentId = ROLE_TO_SEGMENT[bodyRole];
          if (segmentId) {
            newAssignments.set(sensorId, {
              sensorId,
              bodyRole,
              segmentId,
              method: "manual", // Loaded from custom profile treated as manual/saved
              assignedAt: Date.now(),
            });
          }
        });

        set({
          assignments: newAssignments,
          activeProfile: name,
        });
        get()._recalculateTopology();
        console.debug(`[AssignmentStore] Loaded profile '${name}'`);
      },

      deleteProfile: (name) => {
        const { savedProfiles } = get();
        const newProfiles = { ...savedProfiles };
        delete newProfiles[name];
        set({ savedProfiles: newProfiles });
      },

      setSelectedSensorId: (id) => {
        set({ selectedSensorId: id });
      },

      // ----------------------------------------------------------------
      // AUTO-ASSIGNMENT
      // ----------------------------------------------------------------

      autoAssignByName: (sensorId, provisionedName) => {
        // Parse IMU-* naming convention
        if (!provisionedName.startsWith("IMU-")) {
          return false;
        }

        const suffix = provisionedName.replace("IMU-", "").toLowerCase();

        // Mapping from provisioned name suffix to BodyRole
        const nameMapping: Record<string, BodyRole> = {
          pelvis: BodyRole.PELVIS,
          sacrum: BodyRole.PELVIS,
          torso: BodyRole.CHEST,
          chest: BodyRole.CHEST,
          sternum: BodyRole.CHEST,
          head: BodyRole.HEAD,

          // Left Leg
          leftthigh: BodyRole.HIP_L,
          thigh_l: BodyRole.HIP_L,
          lefttibia: BodyRole.KNEE_L,
          tibia_l: BodyRole.KNEE_L,
          leftfoot: BodyRole.FOOT_L,
          foot_l: BodyRole.FOOT_L,
          leftskate: BodyRole.SKATE_L,

          // Right Leg
          rightthigh: BodyRole.HIP_R,
          thigh_r: BodyRole.HIP_R,
          righttibia: BodyRole.KNEE_R,
          tibia_r: BodyRole.KNEE_R,
          rightfoot: BodyRole.FOOT_R,
          foot_r: BodyRole.FOOT_R,
          rightskate: BodyRole.SKATE_R,

          // Arms
          leftarm: BodyRole.ARM_L,
          leftforearm: BodyRole.FOREARM_L,
          lefthand: BodyRole.HAND_L,
          rightarm: BodyRole.ARM_R,
          rightforearm: BodyRole.FOREARM_R,
          righthand: BodyRole.HAND_R,
        };

        const role = nameMapping[suffix];
        if (role) {
          get().assign(sensorId, role, "provisioned");
          return true;
        }

        return false;
      },

      // ----------------------------------------------------------------
      // GETTERS
      // ----------------------------------------------------------------

      getSegmentForSensor: (sensorId) => {
        const assignment = get().assignments.get(sensorId);
        return assignment?.segmentId ?? null;
      },

      /**
       * Find segment for a numeric sensor ID by searching all assignments.
       * This handles various device ID formats like:
       * - "USB 239a:8143_190" → matches 190
       * - "sensor_190" → matches 190
       * Used for playback fallback when session has no sensorMapping.
       */
      getSegmentByNumericId: (numericId: number) => {
        for (const [deviceId, assignment] of get().assignments.entries()) {
          // Extract numeric suffix from device ID
          const match = deviceId.match(/(\d+)$/);
          if (match && parseInt(match[1], 10) === numericId) {
            return assignment.segmentId;
          }
        }
        return null;
      },

      getRoleForSensor: (sensorId) => {
        const assignment = get().assignments.get(sensorId);
        return assignment?.bodyRole ?? null;
      },

      getSensorForRole: (role) => {
        for (const [sensorId, assignment] of get().assignments.entries()) {
          if (assignment.bodyRole === role) {
            return sensorId;
          }
        }
        return null;
      },

      getSensorForSegment: (segment) => {
        for (const [sensorId, assignment] of get().assignments.entries()) {
          if (assignment.segmentId === segment) {
            return sensorId;
          }
        }
        return null;
      },

      getAssignedRoles: () => {
        const roles = new Set<BodyRole>();
        for (const assignment of get().assignments.values()) {
          roles.add(assignment.bodyRole);
        }
        return roles;
      },

      getAssignedSegments: () => {
        return Array.from(get().assignments.values()).map((a) => a.segmentId);
      },

      // ----------------------------------------------------------------
      // INTERNAL
      // ----------------------------------------------------------------

      _recalculateTopology: () => {
        const roles = get().getAssignedRoles();
        const topology = CapabilityMatrix.deduceTopology(roles);
        const capabilities = CapabilityMatrix.getCapabilities(roles);

        console.debug(`[AssignmentStore] Topology: ${topology}`, capabilities);

        set({ activeTopology: topology, capabilities });
      },
    }),
    {
      name: "imu-sensor-assignments",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Serialize Map to array for JSON storage
        assignments: Array.from(state.assignments.entries()),
        activeProfile: state.activeProfile,
        savedProfiles: state.savedProfiles,
      }),
      merge: (persistedState: unknown, currentState: SensorAssignmentState) => {
        const persisted = persistedState as {
          assignments?: [string, SensorAssignment][];
          activeProfile?: AssignmentProfile | string;
          savedProfiles?: Record<string, Record<string, BodyRole>>;
        };

        // Deserialize assignments array back to Map
        const assignments = new Map<string, SensorAssignment>(
          persisted?.assignments || [],
        );

        const merged = {
          ...currentState,
          assignments,
          activeProfile: persisted?.activeProfile || currentState.activeProfile,
          savedProfiles: persisted?.savedProfiles || currentState.savedProfiles,
        };

        // Recalculate derived state
        const roles = new Set<BodyRole>();
        for (const assignment of assignments.values()) {
          roles.add(assignment.bodyRole);
        }
        merged.activeTopology = CapabilityMatrix.deduceTopology(roles);
        merged.capabilities = CapabilityMatrix.getCapabilities(roles);

        return merged;
      },
    },
  ),
);

// ============================================================================
// COMPATIBILITY LAYER (for gradual migration)
// ============================================================================

/**
 * Hook that mimics TopologyManager interface for backward compatibility.
 * Components can switch to this before full migration.
 */
export function useTopologyManagerCompat() {
  const store = useSensorAssignmentStore();

  return {
    roleMap: new Map(
      Array.from(store.assignments.entries()).map(([id, a]) => [
        id,
        a.bodyRole,
      ]),
    ),
    inverseMap: new Map(
      Array.from(store.assignments.entries()).map(([id, a]) => [
        a.bodyRole,
        id,
      ]),
    ),
    activeTopology: store.activeTopology,
    capabilities: store.capabilities,
    selectedSensorId: store.selectedSensorId,
    setSelectedSensorId: store.setSelectedSensorId,
    assignRole: (sensorId: string, role: BodyRole) =>
      store.assign(sensorId, role, "manual"),
    unassignRole: store.unassign,
    clearAll: store.clearAll,
    getSensorForRole: store.getSensorForRole,
    recalculateTopology: store._recalculateTopology,
  };
}
