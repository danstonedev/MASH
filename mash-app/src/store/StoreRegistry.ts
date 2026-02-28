/**
 * Store Registry - Centralized cross-store access
 * 
 * This solves circular import dependencies by using lazy getters.
 * Instead of importing stores directly (which creates cycles),
 * stores access each other through this registry.
 * 
 * Pattern:
 * 1. Each store registers itself on module load
 * 2. Other stores use getXxxStore() to access lazily
 * 3. TypeScript types are preserved (no `any` casts)
 */

import type { StoreApi, UseBoundStore } from 'zustand';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

// We define minimal interfaces for what we need from each store
// This avoids importing the full store types (which would create cycles)

interface CalibrationStoreState {
    calibrationStep: string;
    sensorOffsets: Map<string, any>;
    getCalibration: (segmentId: string) => any;
    reset: () => void;
    setCalibrationStep: (step: string) => void;
    applyUnifiedResults: (results: Map<string, any>) => void;
}

interface TareStoreState {
    tareStates: Map<string, any>;
    getTareState: (segmentId: string) => any;
    serialize: () => any[];
    deserialize: (data: any[]) => void;
    resetAll: () => void;
    captureGlobalHeadingTare: (segmentQuats: Map<string, any>) => void;
    captureGlobalJointTare: (segmentAngles: Map<string, any>) => void;
}

interface RecordingStoreState {
    isRecording: boolean;
    currentSession: any;
    selectedAthleteId: string | null;
}

interface AthleteStoreState {
    athletes: Map<string, any>;
    getAthlete: (id: string) => any;
    saveCalibrationToAthlete: (athleteId: string) => boolean;
    loadCalibrationFromAthlete: (athleteId: string) => boolean;
    hasStoredCalibration: (athleteId: string) => boolean;
}

interface SensorAssignmentStoreState {
    assignments: Map<string, any>;
    getSegmentForSensor: (sensorId: string) => string | null;
    getSensorForSegment: (segment: string) => string | null;
}

// Store types using Zustand's UseBoundStore
type CalibrationStore = UseBoundStore<StoreApi<CalibrationStoreState>>;
type TareStore = UseBoundStore<StoreApi<TareStoreState>>;
type RecordingStore = UseBoundStore<StoreApi<RecordingStoreState>>;
type AthleteStore = UseBoundStore<StoreApi<AthleteStoreState>>;
type SensorAssignmentStore = UseBoundStore<StoreApi<SensorAssignmentStoreState>>;

// ============================================================================
// REGISTRY
// ============================================================================

interface StoreRegistryMap {
    calibration: CalibrationStore | null;
    tare: TareStore | null;
    recording: RecordingStore | null;
    athlete: AthleteStore | null;
    sensorAssignment: SensorAssignmentStore | null;
}

const registry: StoreRegistryMap = {
    calibration: null,
    tare: null,
    recording: null,
    athlete: null,
    sensorAssignment: null,
};

// ============================================================================
// REGISTRATION FUNCTIONS
// Called by stores on module load to register themselves
// ============================================================================

export function registerCalibrationStore(store: CalibrationStore): void {
    registry.calibration = store;
}

export function registerTareStore(store: TareStore): void {
    registry.tare = store;
}

export function registerRecordingStore(store: RecordingStore): void {
    registry.recording = store;
}

export function registerAthleteStore(store: AthleteStore): void {
    registry.athlete = store;
}

export function registerSensorAssignmentStore(store: SensorAssignmentStore): void {
    registry.sensorAssignment = store;
}

// ============================================================================
// LAZY GETTERS
// Used by consuming code to access stores without import cycles
// These rely on stores being registered first (which happens on module load)
// ============================================================================

export function getCalibrationStore(): CalibrationStore {
    if (!registry.calibration) {
        throw new Error('[StoreRegistry] CalibrationStore not registered. Ensure useCalibrationStore is imported before this call.');
    }
    return registry.calibration;
}

export function getTareStore(): TareStore {
    if (!registry.tare) {
        throw new Error('[StoreRegistry] TareStore not registered. Ensure useTareStore is imported before this call.');
    }
    return registry.tare;
}

export function getRecordingStore(): RecordingStore {
    if (!registry.recording) {
        throw new Error('[StoreRegistry] RecordingStore not registered. Ensure useRecordingStore is imported before this call.');
    }
    return registry.recording;
}

export function getAthleteStore(): AthleteStore {
    if (!registry.athlete) {
        throw new Error('[StoreRegistry] AthleteStore not registered. Ensure useAthleteStore is imported before this call.');
    }
    return registry.athlete;
}

export function getSensorAssignmentStore(): SensorAssignmentStore {
    if (!registry.sensorAssignment) {
        throw new Error('[StoreRegistry] SensorAssignmentStore not registered. Ensure useSensorAssignmentStore is imported before this call.');
    }
    return registry.sensorAssignment;
}

// ============================================================================
// UTILITY
// ============================================================================

/**
 * Check if all stores are registered (for debugging)
 */
export function isRegistryComplete(): boolean {
    return Object.values(registry).every(store => store !== null);
}

/**
 * Get list of registered store names (for debugging)
 */
export function getRegisteredStores(): string[] {
    return Object.entries(registry)
        .filter(([, store]) => store !== null)
        .map(([name]) => name);
}
