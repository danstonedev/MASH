/**
 * Animation Store - Manages Mixamo animation playback.
 */

import { create } from 'zustand';

export interface AnimationInfo {
    id: string;
    name: string;
    file: string;
    duration?: number;
}

export const AVAILABLE_ANIMATIONS: AnimationInfo[] = [
    { id: 'walk', name: 'Walk', file: '/models/Walk.glb' },
    { id: 'stand', name: 'Stand', file: '/models/Stand.glb' },
    { id: 'sit', name: 'Sit', file: '/models/Sit.glb' },
    { id: 'sit_lknee', name: 'Sit L Knee Ext', file: '/models/Sit_Lknee_ex.glb' },
    { id: 'sit_rknee', name: 'Sit R Knee Ext', file: '/models/Sit_Rknee_ex.glb' },
    { id: 'longsit', name: 'Long Sit', file: '/models/LongSit.glb' },
    { id: 'limp', name: 'Limp', file: '/models/Limp.glb' },
    { id: 'kick', name: 'Kick', file: '/models/Manny_Kick.glb' },
    { id: 'kick_pass', name: 'Kick Pass', file: '/models/Kick_pass.glb' },
    { id: 'swim', name: 'Swim', file: '/models/Manny_Swim.glb' },
];

interface AnimationState {
    // Currently selected animation
    currentAnimation: AnimationInfo | null;

    // Playback state
    isPlaying: boolean;
    playbackSpeed: number;
    progress: number; // 0-1

    // Mode: 'simulator' uses fake IMU data, 'animation' plays GLB clips
    mode: 'simulator' | 'animation';

    // Actions
    setAnimation: (animation: AnimationInfo | null) => void;
    play: () => void;
    pause: () => void;
    stop: () => void;
    setPlaybackSpeed: (speed: number) => void;
    setProgress: (progress: number) => void;
    setMode: (mode: 'simulator' | 'animation') => void;
}

export const useAnimationStore = create<AnimationState>((set) => ({
    currentAnimation: null,
    isPlaying: false,
    playbackSpeed: 1.0,
    progress: 0,
    mode: 'simulator',

    setAnimation: (animation) => set({
        currentAnimation: animation,
        progress: 0,
        isPlaying: false,
    }),

    play: () => set({ isPlaying: true }),

    pause: () => set({ isPlaying: false }),

    stop: () => set({ isPlaying: false, progress: 0 }),

    setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

    setProgress: (progress) => set({ progress: Math.max(0, Math.min(1, progress)) }),

    setMode: (mode) => set({ mode, isPlaying: false, progress: 0 }),
}));
