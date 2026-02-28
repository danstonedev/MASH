/**
 * Timeline Store
 * ==============
 * 
 * Manages timeline state for session playback visualization:
 * - Multi-track system with collapsible nested tracks
 * - Event management with annotations
 * - Zoom/pan controls
 * - Event selection and comparison
 * - Sport-specific mode presets
 */

import { create } from 'zustand';

// ============================================================================
// TYPES
// ============================================================================

export type TrackType =
    | 'activity'
    | 'gait'
    | 'skate'
    | 'jump'
    | 'quality'
    | 'rest'
    | 'custom';

export type SportMode = 'general' | 'skating' | 'running' | 'training';

export interface TimelineAnnotation {
    id: string;
    label: string;
    notes: string;
    tags: string[];
    createdAt: number;
    color?: string;
}

export interface TimelineEvent {
    id: string;
    track: TrackType;
    type: string;              // e.g., 'heel_strike', 'push_start', 'takeoff'
    startTime: number;         // ms from session start
    endTime?: number;          // For segments (activity, phases)
    duration?: number;         // Calculated

    // Metrics
    value?: number;            // e.g., jump height, quality score
    foot?: 'left' | 'right';   // For gait events

    // Research features
    annotation?: TimelineAnnotation;
    selected?: boolean;

    // Metadata
    metadata?: Record<string, any>;
}

export interface TimelineTrack {
    id: TrackType;
    name: string;
    visible: boolean;
    collapsed: boolean;
    events: TimelineEvent[];
    color: string;

    // Track-specific settings
    showLabels?: boolean;
    heightMultiplier?: number;
}

// Comparison mode: view 2 events side-by-side
export interface EventComparison {
    eventA: string | null;     // Event ID
    eventB: string | null;     // Event ID
}

export interface TimelineState {
    // Session
    sessionId: string | null;
    sessionDuration: number;

    // Tracks
    tracks: Map<TrackType, TimelineTrack>;

    // View control
    viewStart: number;         // Visible window start (ms)
    viewEnd: number;           // Visible window end (ms)
    zoom: number;              // 1 = fit session, higher = zoomed in

    // Selection
    selectedEvents: Set<string>;
    comparison: EventComparison;

    // Mode
    sportMode: SportMode;

    // Actions
    initForSession: (sessionId: string, duration: number) => void;
    reset: () => void;

    // Track management
    setTrackVisible: (track: TrackType, visible: boolean) => void;
    setTrackCollapsed: (track: TrackType, collapsed: boolean) => void;

    // Events
    addEvent: (event: TimelineEvent) => void;
    addEvents: (events: TimelineEvent[]) => void;
    removeEvent: (id: string) => void;
    clearTrack: (track: TrackType) => void;

    // Annotations
    annotateEvent: (eventId: string, annotation: TimelineAnnotation) => void;
    removeAnnotation: (eventId: string) => void;

    // Selection
    selectEvent: (id: string, append?: boolean) => void;
    deselectEvent: (id: string) => void;
    clearSelection: () => void;

    // Comparison
    setCompareA: (id: string | null) => void;
    setCompareB: (id: string | null) => void;
    clearComparison: () => void;

    // View
    setViewRange: (start: number, end: number) => void;
    zoomIn: () => void;
    zoomOut: () => void;
    zoomToFit: () => void;
    panLeft: () => void;
    panRight: () => void;

    // Mode
    setSportMode: (mode: SportMode) => void;

    // Query
    getEventsInRange: (start: number, end: number) => TimelineEvent[];
    getEventById: (id: string) => TimelineEvent | null;
    getSelectedEvents: () => TimelineEvent[];
    getComparisonEvents: () => [TimelineEvent | null, TimelineEvent | null];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const TRACK_COLORS: Record<TrackType, string> = {
    activity: '#3B82F6',   // Blue
    gait: '#10B981',       // Emerald
    skate: '#8B5CF6',      // Violet
    jump: '#F59E0B',       // Amber
    quality: '#EC4899',    // Pink
    rest: '#6B7280',       // Gray
    custom: '#14B8A6',     // Teal
};

const TRACK_NAMES: Record<TrackType, string> = {
    activity: 'Activity',
    gait: 'Gait Events',
    skate: 'Skate Phases',
    jump: 'Jumps',
    quality: 'Quality',
    rest: 'Rest Periods',
    custom: 'Custom',
};

const SPORT_MODE_TRACKS: Record<SportMode, TrackType[]> = {
    general: ['activity', 'gait', 'jump', 'rest'],
    skating: ['activity', 'skate', 'jump', 'quality'],
    running: ['activity', 'gait', 'quality', 'rest'],
    training: ['activity', 'jump', 'rest', 'quality'],
};

// ============================================================================
// STORE
// ============================================================================

function createDefaultTracks(): Map<TrackType, TimelineTrack> {
    const tracks = new Map<TrackType, TimelineTrack>();
    const trackTypes: TrackType[] = ['activity', 'gait', 'skate', 'jump', 'quality', 'rest', 'custom'];

    for (const type of trackTypes) {
        tracks.set(type, {
            id: type,
            name: TRACK_NAMES[type],
            visible: ['activity', 'gait', 'jump'].includes(type),
            collapsed: false,
            events: [],
            color: TRACK_COLORS[type],
        });
    }

    return tracks;
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
    // Initial state
    sessionId: null,
    sessionDuration: 0,
    tracks: createDefaultTracks(),
    viewStart: 0,
    viewEnd: 0,
    zoom: 1,
    selectedEvents: new Set(),
    comparison: { eventA: null, eventB: null },
    sportMode: 'general',

    // ========================================================================
    // SESSION
    // ========================================================================

    initForSession: (sessionId: string, duration: number) => {
        set({
            sessionId,
            sessionDuration: duration,
            viewStart: 0,
            viewEnd: duration,
            zoom: 1,
            tracks: createDefaultTracks(),
            selectedEvents: new Set(),
            comparison: { eventA: null, eventB: null },
        });
    },

    reset: () => {
        set({
            sessionId: null,
            sessionDuration: 0,
            tracks: createDefaultTracks(),
            viewStart: 0,
            viewEnd: 0,
            zoom: 1,
            selectedEvents: new Set(),
            comparison: { eventA: null, eventB: null },
        });
    },

    // ========================================================================
    // TRACK MANAGEMENT
    // ========================================================================

    setTrackVisible: (track: TrackType, visible: boolean) => {
        const tracks = get().tracks;
        const t = tracks.get(track);
        if (t) {
            tracks.set(track, { ...t, visible });
            set({ tracks: new Map(tracks) });
        }
    },

    setTrackCollapsed: (track: TrackType, collapsed: boolean) => {
        const tracks = get().tracks;
        const t = tracks.get(track);
        if (t) {
            tracks.set(track, { ...t, collapsed });
            set({ tracks: new Map(tracks) });
        }
    },

    // ========================================================================
    // EVENTS
    // ========================================================================

    addEvent: (event: TimelineEvent) => {
        const tracks = get().tracks;
        const track = tracks.get(event.track);
        if (track) {
            track.events.push(event);
            track.events.sort((a, b) => a.startTime - b.startTime);
            set({ tracks: new Map(tracks) });
        }
    },

    addEvents: (events: TimelineEvent[]) => {
        const tracks = get().tracks;
        for (const event of events) {
            const track = tracks.get(event.track);
            if (track) {
                track.events.push(event);
            }
        }
        // Sort all tracks
        for (const track of tracks.values()) {
            track.events.sort((a, b) => a.startTime - b.startTime);
        }
        set({ tracks: new Map(tracks) });
    },

    removeEvent: (id: string) => {
        const tracks = get().tracks;
        for (const track of tracks.values()) {
            const idx = track.events.findIndex(e => e.id === id);
            if (idx >= 0) {
                track.events.splice(idx, 1);
                break;
            }
        }
        set({ tracks: new Map(tracks) });
    },

    clearTrack: (trackType: TrackType) => {
        const tracks = get().tracks;
        const track = tracks.get(trackType);
        if (track) {
            track.events = [];
            set({ tracks: new Map(tracks) });
        }
    },

    // ========================================================================
    // ANNOTATIONS
    // ========================================================================

    annotateEvent: (eventId: string, annotation: TimelineAnnotation) => {
        const tracks = get().tracks;
        for (const track of tracks.values()) {
            const event = track.events.find(e => e.id === eventId);
            if (event) {
                event.annotation = annotation;
                break;
            }
        }
        set({ tracks: new Map(tracks) });
    },

    removeAnnotation: (eventId: string) => {
        const tracks = get().tracks;
        for (const track of tracks.values()) {
            const event = track.events.find(e => e.id === eventId);
            if (event) {
                event.annotation = undefined;
                break;
            }
        }
        set({ tracks: new Map(tracks) });
    },

    // ========================================================================
    // SELECTION
    // ========================================================================

    selectEvent: (id: string, append = false) => {
        const selectedEvents = append ? new Set(get().selectedEvents) : new Set<string>();
        selectedEvents.add(id);
        set({ selectedEvents });
    },

    deselectEvent: (id: string) => {
        const selectedEvents = new Set(get().selectedEvents);
        selectedEvents.delete(id);
        set({ selectedEvents });
    },

    clearSelection: () => {
        set({ selectedEvents: new Set() });
    },

    // ========================================================================
    // COMPARISON
    // ========================================================================

    setCompareA: (id: string | null) => {
        set(state => ({ comparison: { ...state.comparison, eventA: id } }));
    },

    setCompareB: (id: string | null) => {
        set(state => ({ comparison: { ...state.comparison, eventB: id } }));
    },

    clearComparison: () => {
        set({ comparison: { eventA: null, eventB: null } });
    },

    // ========================================================================
    // VIEW CONTROL
    // ========================================================================

    setViewRange: (start: number, end: number) => {
        const { sessionDuration } = get();
        const clampedStart = Math.max(0, start);
        const clampedEnd = Math.min(sessionDuration, end);
        set({ viewStart: clampedStart, viewEnd: clampedEnd });
    },

    zoomIn: () => {
        const { viewStart, viewEnd, sessionDuration } = get();
        const center = (viewStart + viewEnd) / 2;
        const range = viewEnd - viewStart;
        const newRange = range / 2;
        const minRange = sessionDuration / 100; // Max 100x zoom

        if (newRange >= minRange) {
            set({
                viewStart: center - newRange / 2,
                viewEnd: center + newRange / 2,
                zoom: sessionDuration / newRange,
            });
        }
    },

    zoomOut: () => {
        const { viewStart, viewEnd, sessionDuration } = get();
        const center = (viewStart + viewEnd) / 2;
        const range = viewEnd - viewStart;
        const newRange = Math.min(range * 2, sessionDuration);

        let newStart = center - newRange / 2;
        let newEnd = center + newRange / 2;

        // Clamp to bounds
        if (newStart < 0) {
            newStart = 0;
            newEnd = newRange;
        }
        if (newEnd > sessionDuration) {
            newEnd = sessionDuration;
            newStart = sessionDuration - newRange;
        }

        set({
            viewStart: Math.max(0, newStart),
            viewEnd: Math.min(sessionDuration, newEnd),
            zoom: sessionDuration / newRange,
        });
    },

    zoomToFit: () => {
        const { sessionDuration } = get();
        set({
            viewStart: 0,
            viewEnd: sessionDuration,
            zoom: 1,
        });
    },

    panLeft: () => {
        const { viewStart, viewEnd } = get();
        const range = viewEnd - viewStart;
        const panAmount = range * 0.25;

        if (viewStart > 0) {
            const newStart = Math.max(0, viewStart - panAmount);
            set({
                viewStart: newStart,
                viewEnd: newStart + range,
            });
        }
    },

    panRight: () => {
        const { viewStart, viewEnd, sessionDuration } = get();
        const range = viewEnd - viewStart;
        const panAmount = range * 0.25;

        if (viewEnd < sessionDuration) {
            const newEnd = Math.min(sessionDuration, viewEnd + panAmount);
            set({
                viewStart: newEnd - range,
                viewEnd: newEnd,
            });
        }
    },

    // ========================================================================
    // SPORT MODE
    // ========================================================================

    setSportMode: (mode: SportMode) => {
        const tracks = get().tracks;
        const visibleTracks = SPORT_MODE_TRACKS[mode];

        for (const [type, track] of tracks) {
            track.visible = visibleTracks.includes(type);
        }

        set({ sportMode: mode, tracks: new Map(tracks) });
    },

    // ========================================================================
    // QUERIES
    // ========================================================================

    getEventsInRange: (start: number, end: number) => {
        const { tracks } = get();
        const result: TimelineEvent[] = [];

        for (const track of tracks.values()) {
            if (!track.visible) continue;
            for (const event of track.events) {
                const eventEnd = event.endTime || event.startTime;
                if (event.startTime <= end && eventEnd >= start) {
                    result.push(event);
                }
            }
        }

        return result.sort((a, b) => a.startTime - b.startTime);
    },

    getEventById: (id: string) => {
        const { tracks } = get();
        for (const track of tracks.values()) {
            const event = track.events.find(e => e.id === id);
            if (event) return event;
        }
        return null;
    },

    getSelectedEvents: () => {
        const { selectedEvents } = get();
        const result: TimelineEvent[] = [];

        for (const id of selectedEvents) {
            const event = get().getEventById(id);
            if (event) result.push(event);
        }

        return result;
    },

    getComparisonEvents: () => {
        const { comparison } = get();
        const eventA = comparison.eventA ? get().getEventById(comparison.eventA) : null;
        const eventB = comparison.eventB ? get().getEventById(comparison.eventB) : null;
        return [eventA, eventB];
    },
}));
