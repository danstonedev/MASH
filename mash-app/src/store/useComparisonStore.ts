/**
 * Comparison Store
 * ================
 *
 * Manages state for dual-viewport event comparison:
 * - Two independent playback states (A and B)
 * - Synchronized or independent playback
 * - Event segment extraction from session
 */

import { create } from "zustand";
import { dataManager, type RecordedFrame } from "../lib/db";
import { useTimelineStore } from "./useTimelineStore";

// ============================================================================
// TYPES
// ============================================================================

export interface ComparisonSegment {
  eventId: string;
  eventType: string;
  sessionId: string;
  startTime: number; // Absolute time in session
  endTime: number;
  duration: number;
  frames: RecordedFrame[];
  sensorIds: number[];

  // Playback state
  currentTime: number; // Relative to segment start
  isPlaying: boolean;
  playbackSpeed: number;
}

export interface ComparisonState {
  // Segments
  segmentA: ComparisonSegment | null;
  segmentB: ComparisonSegment | null;

  // Sync
  isSynced: boolean; // Play both together

  // Actions
  loadEventA: (eventId: string, contextMs?: number) => Promise<boolean>;
  loadEventB: (eventId: string, contextMs?: number) => Promise<boolean>;
  unloadA: () => void;
  unloadB: () => void;
  swapSegments: () => void;

  // Playback (individual or synced)
  playA: () => void;
  pauseA: () => void;
  playB: () => void;
  pauseB: () => void;
  playBoth: () => void;
  pauseBoth: () => void;

  seekA: (time: number) => void;
  seekB: (time: number) => void;
  seekBoth: (time: number) => void;

  setSpeedA: (speed: number) => void;
  setSpeedB: (speed: number) => void;
  setSpeedBoth: (speed: number) => void;

  toggleSync: () => void;

  // Tick for animation
  tick: (deltaTime: number) => void;

  // Frame access for renderers
  getFrameA: (sensorId: number) => RecordedFrame | null;
  getFrameB: (sensorId: number) => RecordedFrame | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONTEXT_MS = 2000; // 2 seconds before/after event

// ============================================================================
// HELPERS
// ============================================================================

function findClosestFrame(
  frames: RecordedFrame[],
  targetTime: number,
  baseTime: number,
): RecordedFrame | null {
  if (frames.length === 0) return null;

  const targetTimestamp = baseTime + targetTime;

  let left = 0;
  let right = frames.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (frames[mid].timestamp < targetTimestamp) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  if (left > 0) {
    const prevDiff = Math.abs(frames[left - 1].timestamp - targetTimestamp);
    const currDiff = Math.abs(frames[left].timestamp - targetTimestamp);
    if (prevDiff < currDiff) {
      return frames[left - 1];
    }
  }

  return frames[left];
}

// ============================================================================
// STORE
// ============================================================================

export const useComparisonStore = create<ComparisonState>((set, get) => ({
  segmentA: null,
  segmentB: null,
  isSynced: true,

  // ========================================================================
  // LOADING
  // ========================================================================

  loadEventA: async (eventId: string, contextMs = DEFAULT_CONTEXT_MS) => {
    const segment = await loadEventSegment(eventId, contextMs);
    if (segment) {
      set({ segmentA: segment });
      return true;
    }
    return false;
  },

  loadEventB: async (eventId: string, contextMs = DEFAULT_CONTEXT_MS) => {
    const segment = await loadEventSegment(eventId, contextMs);
    if (segment) {
      set({ segmentB: segment });
      return true;
    }
    return false;
  },

  unloadA: () => set({ segmentA: null }),
  unloadB: () => set({ segmentB: null }),

  swapSegments: () => {
    const { segmentA, segmentB } = get();
    set({ segmentA: segmentB, segmentB: segmentA });
  },

  // ========================================================================
  // PLAYBACK
  // ========================================================================

  playA: () => {
    const { segmentA } = get();
    if (segmentA) {
      set({ segmentA: { ...segmentA, isPlaying: true } });
    }
  },

  pauseA: () => {
    const { segmentA } = get();
    if (segmentA) {
      set({ segmentA: { ...segmentA, isPlaying: false } });
    }
  },

  playB: () => {
    const { segmentB } = get();
    if (segmentB) {
      set({ segmentB: { ...segmentB, isPlaying: true } });
    }
  },

  pauseB: () => {
    const { segmentB } = get();
    if (segmentB) {
      set({ segmentB: { ...segmentB, isPlaying: false } });
    }
  },

  playBoth: () => {
    const { segmentA, segmentB } = get();
    set({
      segmentA: segmentA ? { ...segmentA, isPlaying: true } : null,
      segmentB: segmentB ? { ...segmentB, isPlaying: true } : null,
    });
  },

  pauseBoth: () => {
    const { segmentA, segmentB } = get();
    set({
      segmentA: segmentA ? { ...segmentA, isPlaying: false } : null,
      segmentB: segmentB ? { ...segmentB, isPlaying: false } : null,
    });
  },

  seekA: (time: number) => {
    const { segmentA, isSynced, segmentB } = get();
    if (segmentA) {
      const clamped = Math.max(0, Math.min(segmentA.duration, time));
      set({ segmentA: { ...segmentA, currentTime: clamped } });

      if (isSynced && segmentB) {
        const clampedB = Math.max(0, Math.min(segmentB.duration, time));
        set({ segmentB: { ...segmentB, currentTime: clampedB } });
      }
    }
  },

  seekB: (time: number) => {
    const { segmentB, isSynced, segmentA } = get();
    if (segmentB) {
      const clamped = Math.max(0, Math.min(segmentB.duration, time));
      set({ segmentB: { ...segmentB, currentTime: clamped } });

      if (isSynced && segmentA) {
        const clampedA = Math.max(0, Math.min(segmentA.duration, time));
        set({ segmentA: { ...segmentA, currentTime: clampedA } });
      }
    }
  },

  seekBoth: (time: number) => {
    const { segmentA, segmentB } = get();
    set({
      segmentA: segmentA
        ? {
            ...segmentA,
            currentTime: Math.max(0, Math.min(segmentA.duration, time)),
          }
        : null,
      segmentB: segmentB
        ? {
            ...segmentB,
            currentTime: Math.max(0, Math.min(segmentB.duration, time)),
          }
        : null,
    });
  },

  setSpeedA: (speed: number) => {
    const { segmentA } = get();
    if (segmentA) {
      set({ segmentA: { ...segmentA, playbackSpeed: speed } });
    }
  },

  setSpeedB: (speed: number) => {
    const { segmentB } = get();
    if (segmentB) {
      set({ segmentB: { ...segmentB, playbackSpeed: speed } });
    }
  },

  setSpeedBoth: (speed: number) => {
    const { segmentA, segmentB } = get();
    set({
      segmentA: segmentA ? { ...segmentA, playbackSpeed: speed } : null,
      segmentB: segmentB ? { ...segmentB, playbackSpeed: speed } : null,
    });
  },

  toggleSync: () => set((state) => ({ isSynced: !state.isSynced })),

  // ========================================================================
  // TICK
  // ========================================================================

  tick: (deltaTime: number) => {
    const { segmentA, segmentB, isSynced } = get();
    let newA = segmentA;
    let newB = segmentB;

    if (segmentA?.isPlaying) {
      const newTime =
        segmentA.currentTime + deltaTime * 1000 * segmentA.playbackSpeed;
      if (newTime >= segmentA.duration) {
        newA = { ...segmentA, currentTime: 0, isPlaying: false };
      } else {
        newA = { ...segmentA, currentTime: newTime };
      }
    }

    if (segmentB?.isPlaying) {
      if (isSynced && newA) {
        // Sync B to A's time
        newB = segmentB
          ? {
              ...segmentB,
              currentTime: Math.min(newA.currentTime, segmentB.duration),
            }
          : null;
      } else {
        const newTime =
          segmentB.currentTime + deltaTime * 1000 * segmentB.playbackSpeed;
        if (newTime >= segmentB.duration) {
          newB = { ...segmentB, currentTime: 0, isPlaying: false };
        } else {
          newB = { ...segmentB, currentTime: newTime };
        }
      }
    }

    if (newA !== segmentA || newB !== segmentB) {
      set({ segmentA: newA, segmentB: newB });
    }
  },

  // ========================================================================
  // FRAME ACCESS
  // ========================================================================

  getFrameA: (sensorId: number) => {
    const { segmentA } = get();
    if (!segmentA) return null;

    const sensorFrames = segmentA.frames.filter(
      (f) => (f.sensorId ?? 0) === sensorId,
    );
    return findClosestFrame(
      sensorFrames,
      segmentA.currentTime,
      segmentA.startTime,
    );
  },

  getFrameB: (sensorId: number) => {
    const { segmentB } = get();
    if (!segmentB) return null;

    const sensorFrames = segmentB.frames.filter(
      (f) => (f.sensorId ?? 0) === sensorId,
    );
    return findClosestFrame(
      sensorFrames,
      segmentB.currentTime,
      segmentB.startTime,
    );
  },
}));

// ============================================================================
// HELPER: Load event segment from DB
// ============================================================================

async function loadEventSegment(
  eventId: string,
  contextMs: number,
): Promise<ComparisonSegment | null> {
  const timeline = useTimelineStore.getState();
  const event = timeline.getEventById(eventId);

  if (!event) {
    console.warn(`[Comparison] Event not found: ${eventId}`);
    return null;
  }

  const sessionId = timeline.sessionId;
  if (!sessionId) {
    console.warn("[Comparison] No session loaded");
    return null;
  }

  // Calculate segment bounds with context
  const startTime = Math.max(0, event.startTime - contextMs);
  const endTime = (event.endTime || event.startTime) + contextMs;
  const duration = endTime - startTime;

  try {
    // Load frames in range
    // Load frames in range
    const allFrames = await dataManager.exportSessionData(sessionId);

    // Filter to segment range (need to find base timestamp first)
    const sessionFrames = allFrames.filter((f) => f.sessionId === sessionId);
    if (sessionFrames.length === 0) return null;

    const baseTimestamp = Math.min(...sessionFrames.map((f) => f.timestamp));

    const frames = sessionFrames.filter((f) => {
      const relTime = f.timestamp - baseTimestamp;
      return relTime >= startTime && relTime <= endTime;
    });

    const sensorIds = [...new Set(frames.map((f) => f.sensorId ?? 0))];

    console.debug(
      `[Comparison] Loaded segment for ${event.type}: ${frames.length} frames, ${duration}ms`,
    );

    return {
      eventId,
      eventType: event.type,
      sessionId,
      startTime: baseTimestamp + startTime,
      endTime: baseTimestamp + endTime,
      duration,
      frames,
      sensorIds,
      currentTime: contextMs, // Start at event time
      isPlaying: false,
      playbackSpeed: 1,
    };
  } catch (err) {
    console.error("[Comparison] Failed to load segment:", err);
    return null;
  }
}
