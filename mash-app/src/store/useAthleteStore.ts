/**
 * Athlete Store
 * =============
 *
 * Manages athletes, teams, and user roles.
 * Currently uses mock data - will connect to Azure later.
 */

import { create } from "zustand";
import * as THREE from "three";
import {
  getCalibrationStore,
  getTareStore,
  registerAthleteStore,
} from "./StoreRegistry";

// ============================================================================
// TYPES
// ============================================================================

export type UserRole = "admin" | "coach" | "athlete" | "guest";

export type Sport = "speed_skating" | "hockey" | "figure_skating" | "other";

export type AthleteStatus = "active" | "injured" | "resting" | "inactive";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl?: string;
  athleteId?: string; // If role is 'athlete', links to profile
}

export interface AthleteProfile {
  id: string;
  userId: string;

  // Basic
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  gender?: "male" | "female" | "other";
  status: AthleteStatus;

  // Anthropometrics (all in metric)
  height?: number; // cm
  weight?: number; // kg
  wingspan?: number; // cm
  legLength?: number; // cm
  footLength?: number; // cm
  shoeSize?: number;
  skateSize?: number;

  // Computed
  bmi?: number;

  // Sport-specific
  sport: Sport;
  position?: string; // e.g., "Forward", "Defense", "Sprinter"
  skillLevel?: "beginner" | "intermediate" | "advanced" | "elite";
  yearsExperience?: number;
  jerseyNumber?: number;

  // Team
  teamId?: string;

  // Equipment preferences
  dominantSide?: "left" | "right";

  // Performance baselines
  maxJumpHeight?: number; // cm
  baseStrideLength?: number; // cm

  // Medical (optional)
  injuryHistory?: string[];
  currentLimitations?: string;

  // ========================================================================
  // CALIBRATION STORAGE - For Quick-Calibrate Feature
  // ========================================================================

  /** Saved calibration offsets (Level 1 mounting tares) */
  savedCalibration?: {
    segmentId: string;
    offset: [number, number, number, number]; // [w, x, y, z]
    quality: number;
    method: string;
    capturedAt: number;
  }[];

  /** Saved tare states (full 3-level pipeline) */
  savedTareStates?: {
    segmentId: string;
    mountingTare: [number, number, number, number];
    headingTare: [number, number, number, number];
    jointTare: { flexion: number; abduction: number; rotation: number };
    mountingTareTime: number;
    headingTareTime: number;
    jointTareTime: number;
  }[];

  /** Last time calibration was saved for this athlete */
  calibrationSavedAt?: number;

  // Metadata
  avatarUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Team {
  id: string;
  name: string;
  sport: Sport;
  coachIds: string[];
  athleteIds: string[];
  createdAt: number;
}

// Leaderboard entry
export interface LeaderboardEntry {
  athleteId: string;
  athleteName: string;
  value: number;
  rank: number;
}

export interface AthleteState {
  // Current user
  currentUser: User | null;

  // Data
  athletes: Map<string, AthleteProfile>;
  teams: Map<string, Team>;
  users: Map<string, User>;

  // Actions
  setCurrentUser: (user: User | null) => void;

  // Athletes
  getAthlete: (id: string) => AthleteProfile | undefined;
  getAthletesByTeam: (teamId: string) => AthleteProfile[];
  getAthletesByCoach: (coachId: string) => AthleteProfile[];
  addAthlete: (profile: AthleteProfile) => void;
  updateAthlete: (id: string, updates: Partial<AthleteProfile>) => void;
  deleteAthlete: (id: string) => void;

  // Teams
  getTeam: (id: string) => Team | undefined;
  getTeamsByCoach: (coachId: string) => Team[];
  addTeam: (team: Team) => void;
  updateTeam: (id: string, updates: Partial<Team>) => void;

  // Leaderboards (mock implementation)
  getLeaderboard: (metric: string, teamId?: string) => LeaderboardEntry[];

  // Calibration Management
  saveCalibrationToAthlete: (athleteId: string) => boolean;
  loadCalibrationFromAthlete: (athleteId: string) => boolean;
  hasStoredCalibration: (athleteId: string) => boolean;

  // Initialize with mock data
  initMockData: () => void;
}

// ============================================================================
// MOCK DATA
// ============================================================================

const MOCK_ATHLETES: AthleteProfile[] = [
  // Speed Skating
  {
    id: "ath-001",
    userId: "user-ath-001",
    firstName: "Emma",
    lastName: "Lindberg",
    dateOfBirth: "2002-03-15",
    gender: "female",
    status: "active",
    height: 175,
    weight: 65,
    wingspan: 178,
    legLength: 88,
    sport: "speed_skating",
    position: "Sprinter",
    skillLevel: "elite",
    yearsExperience: 8,
    teamId: "team-skating",
    dominantSide: "right",
    maxJumpHeight: 45,
    baseStrideLength: 240,
    createdAt: Date.now() - 86400000 * 30,
    updatedAt: Date.now(),
  },
  {
    id: "ath-002",
    userId: "user-ath-002",
    firstName: "Marcus",
    lastName: "Johansson",
    dateOfBirth: "2000-07-22",
    gender: "male",
    status: "active",
    height: 183,
    weight: 78,
    wingspan: 188,
    legLength: 95,
    sport: "speed_skating",
    position: "Distance",
    skillLevel: "advanced",
    yearsExperience: 6,
    teamId: "team-skating",
    dominantSide: "left",
    maxJumpHeight: 52,
    baseStrideLength: 260,
    createdAt: Date.now() - 86400000 * 60,
    updatedAt: Date.now(),
  },
  {
    id: "ath-003",
    userId: "user-ath-003",
    firstName: "Sofia",
    lastName: "Ekstrom",
    dateOfBirth: "2004-11-08",
    gender: "female",
    status: "resting",
    height: 168,
    weight: 58,
    legLength: 84,
    sport: "speed_skating",
    position: "Sprinter",
    skillLevel: "intermediate",
    yearsExperience: 3,
    teamId: "team-skating",
    dominantSide: "right",
    maxJumpHeight: 38,
    baseStrideLength: 210,
    createdAt: Date.now() - 86400000 * 20,
    updatedAt: Date.now(),
  },
  // Hockey
  {
    id: "ath-004",
    userId: "user-ath-004",
    firstName: "Jake",
    lastName: "Morrison",
    dateOfBirth: "2001-05-12",
    gender: "male",
    status: "active",
    height: 188,
    weight: 92,
    wingspan: 195,
    legLength: 98,
    sport: "hockey",
    position: "Forward",
    skillLevel: "elite",
    yearsExperience: 12,
    jerseyNumber: 17,
    teamId: "team-hockey",
    dominantSide: "right",
    maxJumpHeight: 48,
    baseStrideLength: 220,
    createdAt: Date.now() - 86400000 * 90,
    updatedAt: Date.now(),
  },
  {
    id: "ath-005",
    userId: "user-ath-005",
    firstName: "Tyler",
    lastName: "Schmidt",
    dateOfBirth: "2003-02-28",
    gender: "male",
    status: "injured",
    height: 180,
    weight: 85,
    legLength: 92,
    sport: "hockey",
    position: "Defense",
    skillLevel: "advanced",
    yearsExperience: 8,
    jerseyNumber: 4,
    teamId: "team-hockey",
    dominantSide: "left",
    maxJumpHeight: 42,
    baseStrideLength: 205,
    injuryHistory: ["ACL (2023)"],
    currentLimitations: "Limited lateral movement",
    createdAt: Date.now() - 86400000 * 45,
    updatedAt: Date.now(),
  },
  {
    id: "ath-006",
    userId: "user-ath-006",
    firstName: "Mia",
    lastName: "Chen",
    dateOfBirth: "2002-09-03",
    gender: "female",
    status: "active",
    height: 165,
    weight: 62,
    legLength: 82,
    sport: "hockey",
    position: "Forward",
    skillLevel: "advanced",
    yearsExperience: 7,
    jerseyNumber: 22,
    teamId: "team-hockey",
    dominantSide: "right",
    maxJumpHeight: 40,
    baseStrideLength: 195,
    createdAt: Date.now() - 86400000 * 35,
    updatedAt: Date.now(),
  },
];

const MOCK_TEAMS: Team[] = [
  {
    id: "team-skating",
    name: "UND Speed Skating",
    sport: "speed_skating",
    coachIds: ["user-coach-001"],
    athleteIds: ["ath-001", "ath-002", "ath-003"],
    createdAt: Date.now() - 86400000 * 365,
  },
  {
    id: "team-hockey",
    name: "UND Hockey",
    sport: "hockey",
    coachIds: ["user-coach-001", "user-coach-002"],
    athleteIds: ["ath-004", "ath-005", "ath-006"],
    createdAt: Date.now() - 86400000 * 365,
  },
];

const MOCK_USERS: User[] = [
  {
    id: "user-admin",
    email: "admin@und.edu",
    name: "Admin User",
    role: "admin",
  },
  {
    id: "user-coach-001",
    email: "coach1@und.edu",
    name: "Coach Anderson",
    role: "coach",
  },
  {
    id: "user-coach-002",
    email: "coach2@und.edu",
    name: "Coach Williams",
    role: "coach",
  },
  {
    id: "user-ath-001",
    email: "emma.l@und.edu",
    name: "Emma Lindberg",
    role: "athlete",
    athleteId: "ath-001",
  },
  {
    id: "user-ath-002",
    email: "marcus.j@und.edu",
    name: "Marcus Johansson",
    role: "athlete",
    athleteId: "ath-002",
  },
  {
    id: "user-ath-003",
    email: "sofia.e@und.edu",
    name: "Sofia Ekstrom",
    role: "athlete",
    athleteId: "ath-003",
  },
  {
    id: "user-ath-004",
    email: "jake.m@und.edu",
    name: "Jake Morrison",
    role: "athlete",
    athleteId: "ath-004",
  },
  {
    id: "user-ath-005",
    email: "tyler.s@und.edu",
    name: "Tyler Schmidt",
    role: "athlete",
    athleteId: "ath-005",
  },
  {
    id: "user-ath-006",
    email: "mia.c@und.edu",
    name: "Mia Chen",
    role: "athlete",
    athleteId: "ath-006",
  },
];

// ============================================================================
// STORE
// ============================================================================

export const useAthleteStore = create<AthleteState>((set, get) => ({
  currentUser: null,
  athletes: new Map(),
  teams: new Map(),
  users: new Map(),

  setCurrentUser: (user) => set({ currentUser: user }),

  getAthlete: (id) => get().athletes.get(id),

  getAthletesByTeam: (teamId) => {
    const team = get().teams.get(teamId);
    if (!team) return [];
    return team.athleteIds
      .map((id) => get().athletes.get(id))
      .filter((a): a is AthleteProfile => !!a);
  },

  getAthletesByCoach: (coachId) => {
    const teams = get().getTeamsByCoach(coachId);
    const athleteIds = new Set<string>();
    teams.forEach((t) => t.athleteIds.forEach((id) => athleteIds.add(id)));
    return Array.from(athleteIds)
      .map((id) => get().athletes.get(id))
      .filter((a): a is AthleteProfile => !!a);
  },

  addAthlete: (profile) => {
    const athletes = new Map(get().athletes);
    athletes.set(profile.id, profile);
    set({ athletes });
  },

  updateAthlete: (id, updates) => {
    const athletes = new Map(get().athletes);
    const existing = athletes.get(id);
    if (existing) {
      athletes.set(id, { ...existing, ...updates, updatedAt: Date.now() });
      set({ athletes });
    }
  },

  deleteAthlete: (id) => {
    const athletes = new Map(get().athletes);
    athletes.delete(id);
    set({ athletes });
  },

  getTeam: (id) => get().teams.get(id),

  getTeamsByCoach: (coachId) => {
    return Array.from(get().teams.values()).filter((t) =>
      t.coachIds.includes(coachId),
    );
  },

  addTeam: (team) => {
    const teams = new Map(get().teams);
    teams.set(team.id, team);
    set({ teams });
  },

  updateTeam: (id, updates) => {
    const teams = new Map(get().teams);
    const existing = teams.get(id);
    if (existing) {
      teams.set(id, { ...existing, ...updates });
      set({ teams });
    }
  },

  getLeaderboard: (metric, teamId) => {
    let athletes = Array.from(get().athletes.values());

    if (teamId) {
      const team = get().teams.get(teamId);
      if (team) {
        athletes = athletes.filter((a) => team.athleteIds.includes(a.id));
      }
    }

    // Get metric value based on type
    const getMetricValue = (a: AthleteProfile): number => {
      switch (metric) {
        case "maxJumpHeight":
          return a.maxJumpHeight || 0;
        case "strideLength":
          return a.baseStrideLength || 0;
        case "height":
          return a.height || 0;
        default:
          return 0;
      }
    };

    return athletes
      .map((a) => ({
        athleteId: a.id,
        athleteName: `${a.firstName} ${a.lastName}`,
        value: getMetricValue(a),
        rank: 0,
      }))
      .sort((a, b) => b.value - a.value)
      .map((entry, idx) => ({ ...entry, rank: idx + 1 }));
  },

  initMockData: () => {
    const athletes = new Map<string, AthleteProfile>();
    MOCK_ATHLETES.forEach((a) => athletes.set(a.id, a));

    const teams = new Map<string, Team>();
    MOCK_TEAMS.forEach((t) => teams.set(t.id, t));

    const users = new Map<string, User>();
    MOCK_USERS.forEach((u) => users.set(u.id, u));

    // Default to coach view
    set({
      athletes,
      teams,
      users,
      currentUser: MOCK_USERS.find((u) => u.role === "coach") || null,
    });
  },

  // ========================================================================
  // CALIBRATION MANAGEMENT
  // ========================================================================

  saveCalibrationToAthlete: (athleteId: string): boolean => {
    const athlete = get().athletes.get(athleteId);
    if (!athlete) {
      console.error(`[AthleteStore] Athlete ${athleteId} not found`);
      return false;
    }

    // Get current calibration from stores via registry
    try {
      const calibState = getCalibrationStore().getState();
      const tareState = getTareStore().getState();

      // Serialize calibration offsets
      const savedCalibration: AthleteProfile["savedCalibration"] = [];
      calibState.sensorOffsets.forEach(
        (
          data: {
            offset: THREE.Quaternion;
            quality?: number;
            method?: string;
            capturedAt?: number;
          },
          segmentId: string,
        ) => {
          savedCalibration.push({
            segmentId,
            offset: [
              data.offset.w,
              data.offset.x,
              data.offset.y,
              data.offset.z,
            ],
            quality: data.quality || 0,
            method: data.method || "unknown",
            capturedAt: data.capturedAt || Date.now(),
          });
        },
      );

      // Serialize tare states
      const savedTareStates = tareState.serialize();

      // Update athlete profile
      const athletes = new Map(get().athletes);
      athletes.set(athleteId, {
        ...athlete,
        savedCalibration,
        savedTareStates,
        calibrationSavedAt: Date.now(),
        updatedAt: Date.now(),
      });

      set({ athletes });
      console.debug(
        `[AthleteStore] Saved calibration for ${athlete.firstName} ${athlete.lastName}`,
      );
      console.debug(`  - ${savedCalibration.length} calibration offsets`);
      console.debug(`  - ${savedTareStates.length} tare states`);

      return true;
    } catch (err) {
      console.error("[AthleteStore] Failed to save calibration:", err);
      return false;
    }
  },

  loadCalibrationFromAthlete: (athleteId: string): boolean => {
    const athlete = get().athletes.get(athleteId);
    if (!athlete) {
      console.error(`[AthleteStore] Athlete ${athleteId} not found`);
      return false;
    }

    if (!athlete.savedCalibration || athlete.savedCalibration.length === 0) {
      console.warn(
        `[AthleteStore] No saved calibration for ${athlete.firstName}`,
      );
      return false;
    }

    try {
      const calibStore = getCalibrationStore();
      const tareStore = getTareStore();

      // Convert saved calibration to format expected by applyUnifiedResults
      const results = new Map<
        string,
        {
          segmentId: string;
          offset: THREE.Quaternion;
          quality: number;
          method: string;
        }
      >();
      athlete.savedCalibration.forEach((saved) => {
        const offset = new THREE.Quaternion(
          saved.offset[1], // x
          saved.offset[2], // y
          saved.offset[3], // z
          saved.offset[0], // w
        );
        results.set(saved.segmentId, {
          segmentId: saved.segmentId,
          offset,
          quality: saved.quality,
          method: saved.method,
        });
      });

      // Apply using the unified results method
      calibStore.getState().applyUnifiedResults(results);

      // Restore tare states
      if (athlete.savedTareStates && athlete.savedTareStates.length > 0) {
        tareStore.getState().deserialize(athlete.savedTareStates);
      }

      console.debug(
        `[AthleteStore] Loaded calibration for ${athlete.firstName} ${athlete.lastName}`,
      );
      console.debug(
        `  - ${athlete.savedCalibration.length} calibration offsets restored`,
      );
      console.debug(
        `  - Saved at: ${new Date(athlete.calibrationSavedAt || 0).toLocaleString()}`,
      );

      return true;
    } catch (err) {
      console.error("[AthleteStore] Failed to load calibration:", err);
      return false;
    }
  },

  hasStoredCalibration: (athleteId: string): boolean => {
    const athlete = get().athletes.get(athleteId);
    return !!(athlete?.savedCalibration && athlete.savedCalibration.length > 0);
  },
}));

// Auto-initialize mock data
useAthleteStore.getState().initMockData();

// Register with StoreRegistry for cross-store access
registerAthleteStore(useAthleteStore);
