/**
 * Session Comparison Panel
 * ========================
 * 
 * Compares two sessions with statistical analysis:
 * - Effect sizes
 * - Metric delta visualization
 */

import { useState, useEffect, useCallback } from 'react';
import {
    Loader2,
    GitCompare,
    BarChart3,
    TrendingUp,
    TrendingDown,
    Minus,
    CheckCircle,
    XCircle
} from 'lucide-react';
import { sessionAnalyzer, type SessionAnalysisResult } from '../../analysis/SessionAnalyzer';
import { cohensD } from '../../lib/stats';
import { db } from '../../lib/db';
import { cn } from '../../lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface ComparisonResult {
    sessionA: SessionAnalysisResult;
    sessionB: SessionAnalysisResult;
    deltas: MetricDelta[];
    effectSize?: { d: number; magnitude: string };
}

interface MetricDelta {
    label: string;
    valueA: number;
    valueB: number;
    delta: number;
    percentChange: number;
    unit: string;
    isBetterWhenHigher: boolean;
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

interface MetricComparisonRowProps {
    metric: MetricDelta;
}

function MetricComparisonRow({ metric }: MetricComparisonRowProps) {
    const improved = metric.isBetterWhenHigher
        ? metric.delta > 0
        : metric.delta < 0;
    const unchanged = Math.abs(metric.percentChange) < 5;

    return (
        <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
            <span className="text-xs text-text-secondary flex-1">{metric.label}</span>
            <div className="flex items-center gap-3 text-xs">
                <span className="w-16 text-right font-mono">
                    {metric.valueA.toFixed(1)}{metric.unit}
                </span>
                <span className="text-text-secondary">→</span>
                <span className="w-16 text-right font-mono">
                    {metric.valueB.toFixed(1)}{metric.unit}
                </span>
                <span className={cn(
                    "w-20 flex items-center gap-1 justify-end font-bold",
                    unchanged && "text-text-secondary",
                    !unchanged && improved && "text-green-500",
                    !unchanged && !improved && "text-red-500"
                )}>
                    {unchanged ? (
                        <Minus className="w-3 h-3" />
                    ) : improved ? (
                        <TrendingUp className="w-3 h-3" />
                    ) : (
                        <TrendingDown className="w-3 h-3" />
                    )}
                    {metric.percentChange > 0 ? '+' : ''}{metric.percentChange.toFixed(0)}%
                </span>
            </div>
        </div>
    );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface SessionComparisonPanelProps {
    sessionIdA?: string;
    sessionIdB?: string;
}

export function SessionComparisonPanel({ sessionIdA, sessionIdB }: SessionComparisonPanelProps) {
    const [isComparing, setIsComparing] = useState(false);
    const [result, setResult] = useState<ComparisonResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedA, setSelectedA] = useState<string>(sessionIdA || '');
    const [selectedB, setSelectedB] = useState<string>(sessionIdB || '');
    const [sessions, setSessions] = useState<Array<{ id: string; name: string }>>([]);

    // Load available sessions
    useEffect(() => {
        const loadSessions = async () => {
            const allSessions = await db.sessions.orderBy('startTime').reverse().toArray();
            setSessions(allSessions.map(s => ({ id: s.id, name: s.name })));
        };
        loadSessions();
    }, []);

    // Run comparison
    const runComparison = useCallback(async () => {
        if (!selectedA || !selectedB) {
            setError('Please select two sessions to compare');
            return;
        }

        if (selectedA === selectedB) {
            setError('Please select different sessions');
            return;
        }

        setIsComparing(true);
        setError(null);
        setResult(null);

        try {
            // Analyze both sessions
            const [analysisA, analysisB] = await Promise.all([
                sessionAnalyzer.analyzeSession(selectedA),
                sessionAnalyzer.analyzeSession(selectedB)
            ]);

            if (!analysisA || !analysisB) {
                throw new Error('Failed to analyze one or both sessions');
            }

            // Calculate metric deltas
            const deltas: MetricDelta[] = [];

            // Duration
            deltas.push({
                label: 'Duration',
                valueA: analysisA.totalDuration / 1000,
                valueB: analysisB.totalDuration / 1000,
                delta: (analysisB.totalDuration - analysisA.totalDuration) / 1000,
                percentChange: ((analysisB.totalDuration - analysisA.totalDuration) / analysisA.totalDuration) * 100,
                unit: 's',
                isBetterWhenHigher: true
            });

            // Steps
            deltas.push({
                label: 'Total Steps',
                valueA: analysisA.totalSteps,
                valueB: analysisB.totalSteps,
                delta: analysisB.totalSteps - analysisA.totalSteps,
                percentChange: analysisA.totalSteps > 0
                    ? ((analysisB.totalSteps - analysisA.totalSteps) / analysisA.totalSteps) * 100
                    : 0,
                unit: '',
                isBetterWhenHigher: true
            });

            // Cadence
            deltas.push({
                label: 'Cadence',
                valueA: analysisA.averageCadence,
                valueB: analysisB.averageCadence,
                delta: analysisB.averageCadence - analysisA.averageCadence,
                percentChange: analysisA.averageCadence > 0
                    ? ((analysisB.averageCadence - analysisA.averageCadence) / analysisA.averageCadence) * 100
                    : 0,
                unit: ' spm',
                isBetterWhenHigher: true
            });

            // Gait metrics if available
            if (analysisA.overallGaitMetrics && analysisB.overallGaitMetrics) {
                if (analysisA.overallGaitMetrics.symmetryIndex !== undefined &&
                    analysisB.overallGaitMetrics.symmetryIndex !== undefined) {
                    deltas.push({
                        label: 'Symmetry',
                        valueA: analysisA.overallGaitMetrics.symmetryIndex,
                        valueB: analysisB.overallGaitMetrics.symmetryIndex,
                        delta: analysisB.overallGaitMetrics.symmetryIndex - analysisA.overallGaitMetrics.symmetryIndex,
                        percentChange: ((analysisB.overallGaitMetrics.symmetryIndex - analysisA.overallGaitMetrics.symmetryIndex) / analysisA.overallGaitMetrics.symmetryIndex) * 100,
                        unit: '%',
                        isBetterWhenHigher: true
                    });
                }
            }

            // Data quality
            deltas.push({
                label: 'Data Quality',
                valueA: 100 - (analysisA.dataQuality.missingFrames / analysisA.frameCount) * 100,
                valueB: 100 - (analysisB.dataQuality.missingFrames / analysisB.frameCount) * 100,
                delta: 0, // Will calculate
                percentChange: 0,
                unit: '%',
                isBetterWhenHigher: true
            });
            deltas[deltas.length - 1].delta = deltas[deltas.length - 1].valueB - deltas[deltas.length - 1].valueA;
            deltas[deltas.length - 1].percentChange = (deltas[deltas.length - 1].delta / deltas[deltas.length - 1].valueA) * 100;

            // Calculate effect size
            let effectResult;
            try {
                effectResult = await cohensD(
                    [analysisA.averageCadence, analysisA.totalSteps],
                    [analysisB.averageCadence, analysisB.totalSteps]
                );
            } catch (e) {
                console.warn('Effect size calculation not available:', e);
            }

            setResult({
                sessionA: analysisA,
                sessionB: analysisB,
                deltas,
                effectSize: effectResult
            });
        } catch (err) {
            console.error('Comparison failed:', err);
            setError(err instanceof Error ? err.message : 'Comparison failed');
        } finally {
            setIsComparing(false);
        }
    }, [selectedA, selectedB]);

    return (
        <div className="h-full overflow-y-auto p-3 space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2 text-accent">
                <GitCompare className="w-4 h-4" />
                <h3 className="text-sm font-bold">Session Comparison</h3>
            </div>

            {/* Session selectors */}
            <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                    <label className="text-xs text-text-secondary">Session A (Baseline)</label>
                    <select
                        value={selectedA}
                        onChange={(e) => setSelectedA(e.target.value)}
                        className="w-full bg-bg-elevated text-white text-xs p-2 rounded-lg ring-1 ring-border focus:ring-accent outline-none"
                    >
                        <option value="">Select session...</option>
                        {sessions.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </div>
                <div className="space-y-1">
                    <label className="text-xs text-text-secondary">Session B (Compare)</label>
                    <select
                        value={selectedB}
                        onChange={(e) => setSelectedB(e.target.value)}
                        className="w-full bg-bg-elevated text-white text-xs p-2 rounded-lg ring-1 ring-border focus:ring-accent outline-none"
                    >
                        <option value="">Select session...</option>
                        {sessions.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Compare button */}
            <button
                onClick={runComparison}
                disabled={isComparing || !selectedA || !selectedB}
                className={cn(
                    "w-full py-2 rounded-lg font-bold text-sm transition-all",
                    "flex items-center justify-center gap-2",
                    isComparing || !selectedA || !selectedB
                        ? "bg-accent/50 cursor-not-allowed"
                        : "bg-accent hover:bg-accent-hover active:scale-98"
                )}
            >
                {isComparing ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Comparing...
                    </>
                ) : (
                    <>
                        <GitCompare className="w-4 h-4" />
                        Compare Sessions
                    </>
                )}
            </button>

            {/* Error */}
            {error && (
                <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-center">
                    <XCircle className="w-5 h-5 mx-auto mb-1 text-red-500" />
                    <p className="text-xs text-red-400">{error}</p>
                </div>
            )}

            {/* Results */}
            {result && (
                <div className="space-y-4">
                    {/* Summary */}
                    <div className="bg-bg-elevated rounded-lg p-3 ring-1 ring-border">
                        <h4 className="text-xs font-semibold text-text-secondary mb-2 flex items-center gap-1">
                            <BarChart3 className="w-3 h-3" />
                            Metric Comparison
                        </h4>
                        <div className="divide-y divide-border/50">
                            {result.deltas.map((delta, i) => (
                                <MetricComparisonRow key={i} metric={delta} />
                            ))}
                        </div>
                    </div>

                    {/* Effect size */}
                    {result.effectSize && typeof result.effectSize.d === 'number' && (
                        <div className="bg-bg-elevated rounded-lg p-3 ring-1 ring-border">
                            <h4 className="text-xs font-semibold text-text-secondary mb-2">
                                Statistical Summary
                            </h4>
                            <div className="flex items-center justify-between">
                                <span className="text-xs">Cohen's d Effect Size</span>
                                <span className={cn(
                                    "text-sm font-bold",
                                    Math.abs(result.effectSize.d) >= 0.8 && "text-red-500",
                                    Math.abs(result.effectSize.d) >= 0.5 && Math.abs(result.effectSize.d) < 0.8 && "text-yellow-500",
                                    Math.abs(result.effectSize.d) < 0.5 && "text-green-500"
                                )}>
                                    d = {result.effectSize.d.toFixed(2)} ({result.effectSize.magnitude || 'N/A'})
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Overall verdict */}
                    <div className={cn(
                        "rounded-lg p-4 text-center",
                        result.deltas.filter(d => d.delta > 0).length > result.deltas.length / 2
                            ? "bg-green-500/20 border border-green-500/50"
                            : "bg-yellow-500/20 border border-yellow-500/50"
                    )}>
                        {result.deltas.filter(d => d.delta > 0).length > result.deltas.length / 2 ? (
                            <>
                                <CheckCircle className="w-6 h-6 mx-auto mb-1 text-green-500" />
                                <p className="text-sm font-bold text-green-400">Session B shows improvement</p>
                            </>
                        ) : (
                            <>
                                <Minus className="w-6 h-6 mx-auto mb-1 text-yellow-500" />
                                <p className="text-sm font-bold text-yellow-400">Mixed results between sessions</p>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
