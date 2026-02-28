/**
 * Movement Analysis Card
 * 
 * UI component displaying:
 * - Current activity with icon
 * - Session statistics
 * - Gait metrics when walking/running
 */

import React, { useEffect } from 'react';
import { useMovementStore } from '../../store/useMovementStore';
import { useCalibrationStore } from '../../store/useCalibrationStore';
import { cn } from '../../lib/cn';
import {
    Activity,
    Footprints,
    Timer,
    Target,
    Play,
    Pause,
    RotateCcw
} from 'lucide-react';

// Activity icons and colors
const ACTIVITY_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
    standing: { icon: '🧍', label: 'Standing', color: 'text-blue-400' },
    walking: { icon: '🚶', label: 'Walking', color: 'text-green-400' },
    running: { icon: '🏃', label: 'Running', color: 'text-yellow-400' },
    sitting: { icon: '🪑', label: 'Sitting', color: 'text-purple-400' },
    exercising: { icon: '💪', label: 'Exercising', color: 'text-orange-400' },
    squat: { icon: '🏋️', label: 'Squat', color: 'text-red-400' },
    jumping: { icon: '🦘', label: 'Jumping', color: 'text-pink-400' },
    skating: { icon: '⛸️', label: 'Skating', color: 'text-cyan-400' },
    transitioning: { icon: '↔️', label: 'Transitioning', color: 'text-gray-400' },
    unknown: { icon: '❓', label: 'Unknown', color: 'text-gray-500' },
};

export const MovementCard: React.FC = () => {
    const {
        isActive,
        currentActivity,
        activityConfidence,
        sessionStats,
        gaitMetrics,
        start,
        stop,
        reset,
        processFrame,
    } = useMovementStore();

    const isCalibrated = useCalibrationStore(state => state.calibrationStep === 'calibrated');

    // Process frame in animation loop
    useEffect(() => {
        if (!isActive) return;

        let animationId: number;
        const animate = () => {
            processFrame();
            animationId = requestAnimationFrame(animate);
        };
        animationId = requestAnimationFrame(animate);

        return () => cancelAnimationFrame(animationId);
    }, [isActive, processFrame]);

    // Auto-start when calibrated
    useEffect(() => {
        if (isCalibrated && !isActive) {
            start();
        }
    }, [isCalibrated, isActive, start]);

    const config = ACTIVITY_CONFIG[currentActivity];

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    return (
        <div className="movement-card bg-bg-elevated rounded-lg border border-border overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-border">
                <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-accent" />
                    <span className="text-sm font-semibold text-white">Movement Analysis</span>
                </div>
                <div className="flex gap-1">
                    <button
                        onClick={() => isActive ? stop() : start()}
                        className={cn(
                            "p-1.5 rounded text-xs transition-colors",
                            isActive
                                ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                                : "bg-accent/20 text-accent hover:bg-accent/30"
                        )}
                        disabled={!isCalibrated}
                    >
                        {isActive ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    </button>
                    <button
                        onClick={reset}
                        className="p-1.5 rounded bg-bg-tertiary text-text-secondary hover:text-white transition-colors"
                    >
                        <RotateCcw className="h-3 w-3" />
                    </button>
                </div>
            </div>

            {!isCalibrated ? (
                <div className="p-4 text-center text-text-tertiary text-sm">
                    Calibrate to enable movement analysis
                </div>
            ) : (
                <div className="p-3 space-y-3">
                    {/* Current Activity */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <span className="text-3xl">{config.icon}</span>
                            <div>
                                <div className={cn("font-bold text-lg", config.color)}>
                                    {config.label}
                                </div>
                                <div className="text-xs text-text-tertiary">
                                    {Math.round(activityConfidence * 100)}% confidence
                                </div>
                            </div>
                        </div>
                        {sessionStats && (
                            <div className="text-right">
                                <div className="text-2xl font-bold text-white">
                                    {sessionStats.stepCount}
                                </div>
                                <div className="text-xs text-text-tertiary">steps</div>
                            </div>
                        )}
                    </div>

                    {/* Session Stats */}
                    {sessionStats && (
                        <div className="grid grid-cols-3 gap-2 text-center">
                            <div className="bg-bg-tertiary rounded p-2">
                                <div className="text-xs text-text-tertiary">Walking</div>
                                <div className="text-sm font-semibold text-green-400">
                                    {formatTime(sessionStats.activityDuration)}
                                </div>
                            </div>
                            <div className="bg-bg-tertiary rounded p-2">
                                <div className="text-xs text-text-tertiary">Standing</div>
                                <div className="text-sm font-semibold text-blue-400">
                                    {formatTime(0)}
                                </div>
                            </div>
                            <div className="bg-bg-tertiary rounded p-2">
                                <div className="text-xs text-text-tertiary">Cadence</div>
                                <div className="text-sm font-semibold text-white">
                                    {sessionStats.cadence} <span className="text-text-tertiary text-xs">spm</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Gait Metrics (when walking/running) */}
                    {gaitMetrics && (currentActivity === 'walking' || currentActivity === 'running') && (
                        <div className="border-t border-border pt-3">
                            <div className="flex items-center gap-1 text-xs text-text-tertiary mb-2">
                                <Footprints className="h-3 w-3" />
                                <span>Gait Analysis</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-text-tertiary">Stride Time</span>
                                    <span className="text-white">{gaitMetrics.strideTime}ms</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-text-tertiary">Symmetry</span>
                                    <span className={cn(
                                        gaitMetrics.symmetryIndex >= 90 ? "text-green-400" :
                                            gaitMetrics.symmetryIndex >= 75 ? "text-yellow-400" :
                                                "text-red-400"
                                    )}>
                                        {gaitMetrics.symmetryIndex}%
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-text-tertiary">Stance</span>
                                    <span className="text-white">{Math.round(gaitMetrics.stanceRatio * 100)}%</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-text-tertiary">Variability</span>
                                    <span className={cn(
                                        gaitMetrics.strideTimeCV <= 5 ? "text-green-400" :
                                            gaitMetrics.strideTimeCV <= 10 ? "text-yellow-400" :
                                                "text-red-400"
                                    )}>
                                        {gaitMetrics.strideTimeCV}%
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default MovementCard;
