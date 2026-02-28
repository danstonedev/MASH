/**
 * Analysis Panel
 * 
 * UI for analyzing recorded sessions:
 * - Session selection
 * - Analysis results display
 * - Activity timeline
 * - Export to Azure-ready JSON
 */

import React, { useState, useEffect } from 'react';
import { db, type RecordingSession } from '../../lib/db';
import { sessionAnalyzer, type SessionAnalysisResult } from '../../analysis/SessionAnalyzer';
import { cn } from '../../lib/utils';
import {
    BarChart3,
    Play,
    Download,
    Clock,
    Footprints,
    Activity,
    Loader2
} from 'lucide-react';

// Activity colors
const ACTIVITY_COLORS: Record<string, string> = {
    standing: '#3b82f6',   // blue
    walking: '#22c55e',    // green
    running: '#eab308',    // yellow
    sitting: '#a855f7',    // purple  
    exercising: '#f97316', // orange
    transitioning: '#6b7280', // gray
    unknown: '#374151',    // dark gray
};

export const AnalysisPanel: React.FC = () => {
    const [sessions, setSessions] = useState<RecordingSession[]>([]);
    const [selectedSession, setSelectedSession] = useState<string | null>(null);
    const [analysisResult, setAnalysisResult] = useState<SessionAnalysisResult | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // Load sessions
    useEffect(() => {
        const loadSessions = async () => {
            setIsLoading(true);
            const allSessions = await db.sessions.orderBy('startTime').reverse().toArray();
            setSessions(allSessions);
            setIsLoading(false);
        };
        loadSessions();
    }, []);

    // Analyze selected session
    const analyzeSession = async () => {
        if (!selectedSession) return;

        setIsAnalyzing(true);
        setAnalysisResult(null);

        try {
            const result = await sessionAnalyzer.analyzeSession(selectedSession);
            setAnalysisResult(result);
        } catch (error) {
            console.error('[AnalysisPanel] Analysis failed:', error);
        }

        setIsAnalyzing(false);
    };

    // Export to Azure-ready JSON
    const exportToAzure = () => {
        if (!analysisResult) return;

        const azureData = sessionAnalyzer.toAzureFormat(analysisResult);
        const blob = new Blob([JSON.stringify(azureData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `analysis_${analysisResult.sessionId}.json`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const formatDuration = (ms: number): string => {
        const seconds = Math.floor(ms / 1000);
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center p-8 text-text-secondary">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading sessions...
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-bg-surface overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-border">
                <div className="flex items-center gap-2 mb-3">
                    <BarChart3 className="h-5 w-5 text-accent" />
                    <h2 className="text-lg font-bold text-white">Session Analysis</h2>
                </div>

                {/* Session Selector */}
                <div className="flex gap-2">
                    <select
                        value={selectedSession || ''}
                        onChange={e => setSelectedSession(e.target.value || null)}
                        className="flex-1 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-white"
                    >
                        <option value="">Select a session...</option>
                        {sessions.map(session => (
                            <option key={session.id} value={session.id}>
                                {session.name} ({new Date(session.startTime).toLocaleDateString()})
                            </option>
                        ))}
                    </select>

                    <button
                        onClick={analyzeSession}
                        disabled={!selectedSession || isAnalyzing}
                        className={cn(
                            "px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2 transition-colors",
                            !selectedSession || isAnalyzing
                                ? "bg-bg-tertiary text-text-tertiary cursor-not-allowed"
                                : "bg-accent text-white hover:bg-accent/80"
                        )}
                    >
                        {isAnalyzing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Play className="h-4 w-4" />
                        )}
                        Analyze
                    </button>
                </div>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {analysisResult ? (
                    <>
                        {/* Summary Cards */}
                        <div className="grid grid-cols-2 gap-3">
                            <SummaryCard
                                icon={<Clock className="h-4 w-4" />}
                                label="Duration"
                                value={formatDuration(analysisResult.totalDuration)}
                            />
                            <SummaryCard
                                icon={<Footprints className="h-4 w-4" />}
                                label="Steps"
                                value={analysisResult.totalSteps.toString()}
                            />
                            <SummaryCard
                                icon={<Activity className="h-4 w-4" />}
                                label="Avg Cadence"
                                value={`${analysisResult.averageCadence} spm`}
                            />
                            <SummaryCard
                                icon={<BarChart3 className="h-4 w-4" />}
                                label="Frames"
                                value={analysisResult.frameCount.toString()}
                            />
                        </div>

                        {/* Activity Timeline */}
                        <div className="bg-bg-elevated rounded-lg p-4 border border-border">
                            <h3 className="text-sm font-semibold text-white mb-3">Activity Timeline</h3>
                            <div className="flex h-8 rounded overflow-hidden">
                                {analysisResult.activitySegments.map((segment, i) => {
                                    const widthPercent = (segment.duration / analysisResult.totalDuration) * 100;
                                    if (widthPercent < 1) return null;

                                    return (
                                        <div
                                            key={i}
                                            className="relative group"
                                            style={{
                                                width: `${widthPercent}%`,
                                                backgroundColor: ACTIVITY_COLORS[segment.activity],
                                            }}
                                            title={`${segment.activity}: ${formatDuration(segment.duration)}`}
                                        />
                                    );
                                })}
                            </div>

                            {/* Legend */}
                            <div className="flex flex-wrap gap-3 mt-3">
                                {Object.entries(analysisResult.activitySummary)
                                    .filter(([_, ms]) => ms > 0)
                                    .map(([activity, ms]) => (
                                        <div key={activity} className="flex items-center gap-1.5 text-xs">
                                            <span
                                                className="w-3 h-3 rounded"
                                                style={{ backgroundColor: ACTIVITY_COLORS[activity] }}
                                            />
                                            <span className="text-text-secondary capitalize">
                                                {activity}: {formatDuration(ms)}
                                            </span>
                                        </div>
                                    ))
                                }
                            </div>
                        </div>

                        {/* Gait Metrics */}
                        {analysisResult.overallGaitMetrics && (
                            <div className="bg-bg-elevated rounded-lg p-4 border border-border">
                                <h3 className="text-sm font-semibold text-white mb-3">Gait Analysis</h3>
                                <div className="grid grid-cols-2 gap-3 text-sm">
                                    <MetricRow
                                        label="Cadence"
                                        value={`${analysisResult.overallGaitMetrics.cadence} spm`}
                                    />
                                    <MetricRow
                                        label="Stride Time"
                                        value={`${analysisResult.overallGaitMetrics.strideTime} ms`}
                                    />
                                    <MetricRow
                                        label="Stance Ratio"
                                        value={`${Math.round(analysisResult.overallGaitMetrics.stanceRatio * 100)}%`}
                                    />
                                    <MetricRow
                                        label="Total Steps"
                                        value={analysisResult.totalSteps.toString()}
                                    />
                                </div>
                            </div>
                        )}

                        {/* Data Quality */}
                        <div className="bg-bg-elevated rounded-lg p-4 border border-border">
                            <h3 className="text-sm font-semibold text-white mb-3">Data Quality</h3>
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <MetricRow
                                    label="Sample Rate"
                                    value={`${analysisResult.dataQuality.averageSampleRate} Hz`}
                                />
                                <MetricRow
                                    label="Sensors"
                                    value={analysisResult.dataQuality.sensorCount.toString()}
                                />
                                <MetricRow
                                    label="Missing Frames"
                                    value={analysisResult.dataQuality.missingFrames.toString()}
                                />
                            </div>
                        </div>

                        {/* Export Button */}
                        <button
                            onClick={exportToAzure}
                            className="w-full py-3 bg-accent/20 border border-accent/30 rounded-lg text-accent font-semibold flex items-center justify-center gap-2 hover:bg-accent/30 transition-colors"
                        >
                            <Download className="h-4 w-4" />
                            Export for Azure (JSON)
                        </button>
                    </>
                ) : (
                    <div className="flex flex-col items-center justify-center flex-1 text-text-secondary py-12">
                        <BarChart3 className="h-12 w-12 mb-4 opacity-50" />
                        <p className="text-center">
                            Select a recorded session and click Analyze<br />
                            to see activity detection and gait metrics
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

// Helper components
const SummaryCard: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({
    icon, label, value
}) => (
    <div className="bg-bg-elevated rounded-lg p-3 border border-border">
        <div className="flex items-center gap-2 text-text-tertiary text-xs mb-1">
            {icon}
            {label}
        </div>
        <div className="text-xl font-bold text-white">{value}</div>
    </div>
);

const MetricRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="flex justify-between">
        <span className="text-text-secondary">{label}</span>
        <span className="text-white font-medium">{value}</span>
    </div>
);

export default AnalysisPanel;
