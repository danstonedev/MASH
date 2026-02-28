/**
 * Drift Test Wizard Component
 * ===========================
 * 
 * Guided UI for drift characterization protocol.
 * Walks user through 5-minute static test and displays results.
 */

import { useState, useEffect, useCallback } from 'react';
import { Play, Square, Clock, TrendingDown, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { DriftTestEngine, type DriftTestState, type DriftTestResult } from '../../lib/validation/driftCharacterization';

interface DriftTestWizardProps {
    deviceId: string;
    onComplete?: (result: DriftTestResult) => void;
    onClose?: () => void;
}

export function DriftTestWizard({ deviceId, onComplete, onClose }: DriftTestWizardProps) {
    const [engine, setEngine] = useState<DriftTestEngine | null>(null);
    const [state, setState] = useState<DriftTestState>({
        phase: 'idle',
        progress: 0,
        elapsedSeconds: 0,
        currentYaw: 0,
        currentDriftRate: 0,
        result: null,
        error: null,
    });

    useEffect(() => {
        const e = new DriftTestEngine({ deviceId, durationSeconds: 300 });
        setEngine(e);

        const unsubscribe = e.onStateChange(setState);

        return () => {
            unsubscribe();
            e.destroy();
        };
    }, [deviceId]);

    const handleStart = useCallback(() => {
        engine?.start();
    }, [engine]);

    const handleStop = useCallback(() => {
        engine?.stop();
    }, [engine]);

    useEffect(() => {
        if (state.phase === 'complete' && state.result && onComplete) {
            onComplete(state.result);
        }
    }, [state.phase, state.result, onComplete]);

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const getQualityColor = (quality: string) => {
        switch (quality) {
            case 'excellent': return '#22c55e';
            case 'good': return '#84cc16';
            case 'acceptable': return '#eab308';
            case 'poor': return '#ef4444';
            default: return '#6b7280';
        }
    };

    return (
        <div className="bg-bg-elevated rounded-lg border border-border overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <TrendingDown className="h-4 w-4 text-accent" />
                    <span className="text-sm font-bold text-text-primary uppercase tracking-wide">
                        Drift Characterization
                    </span>
                </div>
                {onClose && (
                    <button
                        onClick={onClose}
                        className="text-text-secondary hover:text-text-primary"
                    >
                        ✕
                    </button>
                )}
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
                {/* Idle State - Instructions */}
                {state.phase === 'idle' && (
                    <div className="space-y-4">
                        <div className="p-3 bg-accent/10 rounded-lg border border-accent/30">
                            <h3 className="text-sm font-bold text-accent mb-2">Instructions</h3>
                            <ol className="text-xs text-text-secondary space-y-1 list-decimal list-inside">
                                <li>Place the sensor on a stable, flat surface</li>
                                <li>Ensure no vibrations or movement nearby</li>
                                <li>Click "Start Test" and wait 5 minutes</li>
                                <li>Do not move the sensor during the test</li>
                            </ol>
                        </div>

                        <button
                            onClick={handleStart}
                            className="w-full flex items-center justify-center gap-2 py-3 text-sm font-bold rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors"
                        >
                            <Play className="h-4 w-4" />
                            Start 5-Minute Test
                        </button>
                    </div>
                )}

                {/* Recording State */}
                {(state.phase === 'preparing' || state.phase === 'recording') && (
                    <div className="space-y-4">
                        <div className="text-center">
                            <div className="text-4xl font-mono font-bold text-text-primary mb-1">
                                {formatTime(state.elapsedSeconds)}
                            </div>
                            <div className="text-xs text-text-secondary">
                                / {formatTime(300)} remaining
                            </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full h-2 bg-border rounded-full overflow-hidden">
                            <div
                                className="h-full bg-accent rounded-full transition-all duration-300"
                                style={{ width: `${state.progress}%` }}
                            />
                        </div>

                        {/* Current Stats */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="p-3 bg-bg-card rounded-lg border border-border">
                                <div className="text-[10px] text-text-secondary uppercase mb-1">Current Yaw</div>
                                <div className="text-lg font-mono font-bold text-text-primary">
                                    {state.currentYaw.toFixed(1)}°
                                </div>
                            </div>
                            <div className="p-3 bg-bg-card rounded-lg border border-border">
                                <div className="text-[10px] text-text-secondary uppercase mb-1">Drift Rate</div>
                                <div className="text-lg font-mono font-bold text-text-primary">
                                    {state.currentDriftRate.toFixed(2)}°/min
                                </div>
                            </div>
                        </div>

                        {/* Warning */}
                        <div className="flex items-center gap-2 text-xs text-warning">
                            <AlertTriangle className="h-4 w-4" />
                            Keep sensor stationary
                        </div>

                        <button
                            onClick={handleStop}
                            className="w-full flex items-center justify-center gap-2 py-2 text-sm font-bold rounded-lg bg-danger/20 text-danger border border-danger hover:bg-danger/30 transition-colors"
                        >
                            <Square className="h-4 w-4" />
                            Stop Test
                        </button>
                    </div>
                )}

                {/* Processing State */}
                {state.phase === 'processing' && (
                    <div className="text-center py-8">
                        <Clock className="h-8 w-8 text-accent mx-auto mb-2 animate-spin" />
                        <div className="text-sm text-text-secondary">Processing results...</div>
                    </div>
                )}

                {/* Complete State */}
                {state.phase === 'complete' && state.result && (
                    <div className="space-y-4">
                        {/* Quality Badge */}
                        <div
                            className="flex items-center justify-center gap-2 py-2 px-4 rounded-lg mx-auto w-fit"
                            style={{
                                backgroundColor: `${getQualityColor(state.result.quality)}20`,
                                color: getQualityColor(state.result.quality),
                            }}
                        >
                            {state.result.quality === 'excellent' || state.result.quality === 'good' ? (
                                <CheckCircle className="h-5 w-5" />
                            ) : (
                                <AlertTriangle className="h-5 w-5" />
                            )}
                            <span className="font-bold uppercase">{state.result.quality}</span>
                        </div>

                        {/* Results */}
                        <div className="space-y-2">
                            <div className="flex justify-between items-center py-2 border-b border-border">
                                <span className="text-xs text-text-secondary uppercase">Drift Rate</span>
                                <span className="text-sm font-mono font-bold text-text-primary">
                                    {state.result.driftRateDegPerMin.toFixed(2)}°/min
                                </span>
                            </div>
                            <div className="flex justify-between items-center py-2 border-b border-border">
                                <span className="text-xs text-text-secondary uppercase">95% CI</span>
                                <span className="text-xs font-mono text-text-secondary">
                                    [{state.result.driftRateCI95[0].toFixed(2)}, {state.result.driftRateCI95[1].toFixed(2)}]°/min
                                </span>
                            </div>
                            <div className="flex justify-between items-center py-2 border-b border-border">
                                <span className="text-xs text-text-secondary uppercase">Total Drift</span>
                                <span className="text-sm font-mono font-bold text-text-primary">
                                    {state.result.totalDrift.toFixed(1)}°
                                </span>
                            </div>
                            <div className="flex justify-between items-center py-2">
                                <span className="text-xs text-text-secondary uppercase">Samples</span>
                                <span className="text-xs font-mono text-text-secondary">
                                    {state.result.yawSamples.length}
                                </span>
                            </div>
                        </div>

                        {/* Message */}
                        <div className="p-3 bg-bg-card rounded-lg border border-border">
                            <p className="text-xs text-text-secondary">
                                {state.result.qualityMessage}
                            </p>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2">
                            <button
                                onClick={handleStart}
                                className="flex-1 py-2 text-xs font-bold rounded-lg bg-bg-card text-text-primary border border-border hover:border-accent transition-colors"
                            >
                                Run Again
                            </button>
                            {onClose && (
                                <button
                                    onClick={onClose}
                                    className="flex-1 py-2 text-xs font-bold rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors"
                                >
                                    Done
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Error State */}
                {state.phase === 'error' && (
                    <div className="text-center py-4">
                        <XCircle className="h-8 w-8 text-danger mx-auto mb-2" />
                        <div className="text-sm text-danger mb-2">Test Failed</div>
                        <div className="text-xs text-text-secondary mb-4">{state.error}</div>
                        <button
                            onClick={handleStart}
                            className="py-2 px-4 text-xs font-bold rounded-lg bg-bg-card text-text-primary border border-border hover:border-accent transition-colors"
                        >
                            Try Again
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
