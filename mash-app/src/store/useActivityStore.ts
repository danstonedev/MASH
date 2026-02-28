/**
 * Activity Store - Zustand store for activity classification state
 * 
 * Tracks current detected activity, confidence, and history.
 * Subscribes to ActivityEngine for real-time updates.
 */

import { create } from 'zustand';
import { ActivityEngine, type ActivityLabel, type ActivityResult } from '../lib/analysis/ActivityEngine';

export interface ActivityHistoryEntry {
    activity: ActivityLabel;
    confidence: number;
    timestamp: number;
}

interface ActivityState {
    // Current classification
    currentActivity: ActivityLabel;
    confidence: number;

    // Detection control
    isDetecting: boolean;

    // Recent activity history (last N changes)
    history: ActivityHistoryEntry[];

    // Actions
    startDetection: () => void;
    stopDetection: () => void;
    toggleDetection: () => void;
}

const MAX_HISTORY = 50;

export const useActivityStore = create<ActivityState>((set, get) => {
    // Subscribe to ActivityEngine updates
    ActivityEngine.subscribe((result: ActivityResult) => {
        const state = get();
        const now = Date.now();

        // Only add to history if activity changed
        const shouldLog = result.activity !== state.currentActivity;

        set({
            currentActivity: result.activity,
            confidence: result.confidence,
            history: shouldLog
                ? [
                    { activity: result.activity, confidence: result.confidence, timestamp: now },
                    ...state.history.slice(0, MAX_HISTORY - 1),
                ]
                : state.history,
        });
    });

    return {
        currentActivity: 'unknown',
        confidence: 0,
        isDetecting: false,
        history: [],

        startDetection: () => {
            ActivityEngine.start();
            set({ isDetecting: true, history: [] });
        },

        stopDetection: () => {
            ActivityEngine.stop();
            set({ isDetecting: false });
        },

        toggleDetection: () => {
            const { isDetecting } = get();
            if (isDetecting) {
                get().stopDetection();
            } else {
                get().startDetection();
            }
        },
    };
});
