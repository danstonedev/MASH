/**
 * GRF Panel - Ground Reaction Force Analysis
 * ===========================================
 * 
 * Sidebar panel showing real-time GRF metrics, gait phases,
 * and force visualization controls.
 */

import { useEffect, useState } from 'react';
import { Activity, Zap, Footprints, TrendingUp, Settings2 } from 'lucide-react';
import { Button } from '../../ui/Button';
import { useGRFStore } from '../../../store/useGRFStore';
import { GRFChart } from '../../visualization/GRFVisualization';
import { useCalibrationStore } from '../../../store/useCalibrationStore';
import type { GaitPhase } from '../../../biomech/InverseDynamics';

// ============================================================================
// CONSTANTS
// ============================================================================

const PHASE_LABELS: Record<GaitPhase, string> = {
    loading_response: 'Loading Response',
    mid_stance: 'Mid Stance',
    terminal_stance: 'Terminal Stance',
    pre_swing: 'Pre-Swing',
    initial_swing: 'Initial Swing',
    mid_swing: 'Mid Swing',
    terminal_swing: 'Terminal Swing',
    unknown: 'Unknown',
};

const PHASE_COLORS: Record<GaitPhase, string> = {
    loading_response: 'text-red-400',
    mid_stance: 'text-blue-400',
    terminal_stance: 'text-green-400',
    pre_swing: 'text-orange-400',
    initial_swing: 'text-purple-400',
    mid_swing: 'text-purple-400',
    terminal_swing: 'text-purple-400',
    unknown: 'text-gray-400',
};

// ============================================================================
// COMPONENT
// ============================================================================

export function GRFPanel() {
    const [showAdvanced, setShowAdvanced] = useState(false);

    // GRF store
    const {
        currentGRF,
        peakVertical,
        loadingRate,
        currentPhase,
        stepCount,
        supportLeg,
        isEnabled,
        setEnabled,
        initialize,
        reset,
    } = useGRFStore();

    // Get subject height/weight from calibration store
    const subjectHeight = useCalibrationStore(s => s.subjectHeight);
    const subjectWeight = 75;  // TODO: Add weight to calibration store

    // Initialize engine when height changes
    useEffect(() => {
        initialize(subjectHeight, subjectWeight, 'male');
    }, [subjectHeight, subjectWeight, initialize]);

    // Current force values
    const verticalForce = currentGRF?.normalizedForce.y ?? 0;
    const apForce = currentGRF?.normalizedForce.z ?? 0;
    const mlForce = currentGRF?.normalizedForce.x ?? 0;

    return (
        <div className="flex flex-col gap-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-accent" />
                    <span className="text-xs font-semibold text-white">Ground Reaction Force</span>
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => setEnabled(!isEnabled)}
                >
                    {isEnabled ? (
                        <Zap className="h-3 w-3 text-accent" />
                    ) : (
                        <Zap className="h-3 w-3 text-white/30" />
                    )}
                </Button>
            </div>

            {/* GRF Chart */}
            <GRFChart width={280} height={80} />

            {/* Current Values */}
            <div className="grid grid-cols-3 gap-2">
                <MetricCard
                    label="Vertical"
                    value={verticalForce.toFixed(2)}
                    unit="BW"
                    color={verticalForce > 2 ? 'text-red-400' : 'text-accent'}
                />
                <MetricCard
                    label="A/P"
                    value={apForce.toFixed(2)}
                    unit="BW"
                    color="text-blue-400"
                />
                <MetricCard
                    label="M/L"
                    value={mlForce.toFixed(2)}
                    unit="BW"
                    color="text-purple-400"
                />
            </div>

            {/* Gait Phase Indicator */}
            <div className="p-2 rounded-lg bg-white/5 border border-white/10">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Footprints className="h-3 w-3 text-white/50" />
                        <span className="text-[10px] text-white/50">Gait Phase</span>
                    </div>
                    <span className={`text-xs font-medium ${PHASE_COLORS[currentPhase]}`}>
                        {PHASE_LABELS[currentPhase]}
                    </span>
                </div>
                <div className="flex items-center justify-between mt-1">
                    <span className="text-[10px] text-white/30">Support</span>
                    <span className="text-[10px] text-white/60 uppercase">{supportLeg}</span>
                </div>
            </div>

            {/* Peak Metrics */}
            <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded-lg bg-white/5 text-center">
                    <div className="text-lg font-bold text-accent">{peakVertical.toFixed(2)}</div>
                    <div className="text-[10px] text-white/50">Peak vGRF (BW)</div>
                </div>
                <div className="p-2 rounded-lg bg-white/5 text-center">
                    <div className="text-lg font-bold text-white">{loadingRate.toFixed(1)}</div>
                    <div className="text-[10px] text-white/50">Loading Rate (BW/s)</div>
                </div>
            </div>

            {/* Step Counter */}
            <div className="flex items-center justify-between p-2 rounded-lg bg-accent/10 border border-accent/30">
                <div className="flex items-center gap-2">
                    <TrendingUp className="h-3 w-3 text-accent" />
                    <span className="text-xs text-white/80">Step Count</span>
                </div>
                <span className="text-sm font-bold text-accent">{stepCount}</span>
            </div>

            {/* Advanced Settings */}
            <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs"
                onClick={() => setShowAdvanced(!showAdvanced)}
            >
                <Settings2 className="h-3 w-3 mr-1" />
                {showAdvanced ? 'Hide Settings' : 'Show Settings'}
            </Button>

            {showAdvanced && (
                <div className="p-2 rounded-lg bg-white/5 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-white/50">Subject Height</span>
                        <span className="text-white">{subjectHeight} cm</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-white/50">Subject Weight</span>
                        <span className="text-white">{subjectWeight} kg</span>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-xs"
                        onClick={reset}
                    >
                        Reset Metrics
                    </Button>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

interface MetricCardProps {
    label: string;
    value: string;
    unit: string;
    color?: string;
}

function MetricCard({ label, value, unit, color = 'text-white' }: MetricCardProps) {
    return (
        <div className="p-2 rounded-lg bg-white/5 text-center">
            <div className={`text-sm font-bold ${color}`}>{value}</div>
            <div className="text-[10px] text-white/30">{label}</div>
            <div className="text-[8px] text-white/20">{unit}</div>
        </div>
    );
}
