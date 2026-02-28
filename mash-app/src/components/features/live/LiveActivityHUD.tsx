import React, { useEffect, useState } from 'react';
import { Card } from '../../ui/Card';
import { useMovementAnalysis } from '../../../hooks/useMovementAnalysis'; // Placeholder hook
import { SkatingMonitor } from './SkatingMonitor';
import { SquatGauge } from './SquatGauge';
import { BalanceRing } from './BalanceRing';
import type { ActivityDetection } from '../../../analysis/MovementAnalysisEngine';

export const LiveActivityHUD: React.FC = () => {
    // Assuming useMovementAnalysis provides the latest "ActivityDetection" object
    // In reality, we might poll the engine or subscribe.
    const { activity, metrics } = useMovementAnalysis();

    if (!activity) return null;

    return (

        <div className="absolute top-4 right-4 w-64 space-y-4 pointer-events-none" role="complementary" aria-label="Real-time Activity Feedback">
            {/* Main Activity Indicator */}
            <Card className="p-4 bg-black/80 backdrop-blur border-none shadow-xl">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-wider" id="activity-label">
                        Current Activity
                    </span>
                    <span
                        className={`px-2 py-0.5 rounded text-xs font-bold ${activity.confidence > 0.8 ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}
                        aria-label={`Confidence: ${Math.round(activity.confidence * 100)}%`}
                    >
                        {Math.round(activity.confidence * 100)}%
                    </span>
                </div>
                <h2
                    className="text-2xl font-black text-white capitalize"
                    aria-labelledby="activity-label"
                    aria-live="polite" // Announce activity changes politely
                >
                    {activity.activity}
                </h2>
            </Card>

            {/* Context Aware Panels */}
            {activity.activity === 'skating' && (
                <div role="status" aria-label="Skating Metrics">
                    <SkatingMonitor strokeRate={metrics?.strokeRate} efficiency={metrics?.glideEfficiency} />
                </div>
            )}

            {activity.activity === 'squat' && (
                <div role="status" aria-label="Squat Form">
                    <SquatGauge depth={metrics?.squatDepth} formScore={metrics?.spineAngle} />
                </div>
            )}

            {activity.activity === 'standing' && (
                <div role="status" aria-label="Balance Metrics">
                    <BalanceRing sway={metrics?.swayArea} score={metrics?.swayScore} />
                </div>
            )}

            {activity.activity === 'jumping' && metrics?.jumpHeight && (
                <Card
                    className="p-4 bg-blue-600/90 text-white animate-bounce-in"
                    role="alert" // Urgent update for jump result
                    aria-live="assertive"
                >
                    <div className="text-xs uppercase opacity-80">Last Jump</div>
                    <div className="text-4xl font-bold" aria-label={`Jump Height: ${metrics.jumpHeight.toFixed(1)} centimeters`}>
                        {metrics.jumpHeight.toFixed(1)} cm
                    </div>
                    <div className="text-sm mt-1" aria-label={`Reactive Strength Index: ${metrics.rsiMod?.toFixed(2)}`}>
                        RSI: {metrics.rsiMod?.toFixed(2)}
                    </div>
                </Card>
            )}

            {/* Neural Health (Global) */}
            {metrics?.complexityScore && (
                <div
                    className="flex items-center justify-end space-x-2 opacity-50"
                    role="status"
                    aria-label={`Neural Load: ${metrics.complexityScore.toFixed(0)} percent`}
                >
                    <span className="text-[10px] text-white" aria-hidden="true">Neural Load</span>
                    <div className="w-16 h-1 bg-gray-700 rounded-full overflow-hidden" aria-hidden="true">
                        <div
                            className="h-full bg-purple-500 transition-all duration-1000"
                            style={{ width: `${metrics.complexityScore}%` }}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};
