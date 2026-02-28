/**
 * Movement Analysis Store
 * 
 * Zustand store for movement analysis state:
 * - Activity detection results
 * - Gait metrics
 * - Session statistics
 */

import { create } from 'zustand';
import {
    movementEngine,
    type ActivityClass,
    type ActivityDetection,
    type MovementStats
} from '../analysis/MovementAnalysisEngine';
import {
    gaitAnalyzer,
    type GaitMetrics,
    type GaitEvent
} from '../analysis/GaitAnalyzer';

// ============================================================================
// TYPES
// ============================================================================

interface MovementState {
    // Engine state
    isActive: boolean;

    // Activity
    currentActivity: ActivityClass;
    activityConfidence: number;
    activityHistory: ActivityDetection[];

    // Gait
    gaitMetrics: GaitMetrics | null;
    recentGaitEvents: GaitEvent[];

    // Session stats
    sessionStats: MovementStats | null;

    // Actions
    start: () => void;
    stop: () => void;
    reset: () => void;
    processFrame: () => void;

    // For UI updates
    lastUpdate: number;
}

// ============================================================================
// STORE
// ============================================================================

export const useMovementStore = create<MovementState>((set, get) => ({
    isActive: false,
    currentActivity: 'unknown',
    activityConfidence: 0,
    activityHistory: [],
    gaitMetrics: null,
    recentGaitEvents: [],
    sessionStats: null,
    lastUpdate: 0,

    start: () => {
        movementEngine.reset();
        gaitAnalyzer.reset();

        // Set up activity change callback
        movementEngine.setOnActivityChange((detection) => {
            const history = get().activityHistory;
            set({
                currentActivity: detection.activity,
                activityConfidence: detection.confidence,
                activityHistory: [...history.slice(-49), detection],
            });
        });

        // Set up gait event callback
        gaitAnalyzer.setOnGaitEvent((event) => {
            const events = get().recentGaitEvents;
            set({
                recentGaitEvents: [...events.slice(-19), event],
            });
        });

        set({ isActive: true });
    },

    stop: () => {
        set({ isActive: false });
    },

    reset: () => {
        movementEngine.reset();
        gaitAnalyzer.reset();
        set({
            isActive: false,
            currentActivity: 'unknown',
            activityConfidence: 0,
            activityHistory: [],
            gaitMetrics: null,
            recentGaitEvents: [],
            sessionStats: null,
            lastUpdate: 0,
        });
    },

    processFrame: () => {
        if (!get().isActive) return;

        const now = Date.now();

        // Process movement analysis
        const detection = movementEngine.processFrame();
        if (detection) {
            set({
                currentActivity: detection.activity,
                activityConfidence: detection.confidence,
            });
        }

        // Process gait analysis (only when walking/running)
        const currentActivity = get().currentActivity;
        if (currentActivity === 'walking' || currentActivity === 'running') {
            gaitAnalyzer.processFrame();
        }

        // Update metrics every 500ms
        if (now - get().lastUpdate > 500) {
            set({
                sessionStats: movementEngine.getStats(),
                gaitMetrics: gaitAnalyzer.getMetrics(),
                lastUpdate: now,
            });
        }
    },
}));
