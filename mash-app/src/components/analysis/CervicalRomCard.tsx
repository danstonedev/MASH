/**
 * Cervical ROM Card
 * ==================
 *
 * Composite component showing full cervical ROM analysis:
 *   - Three RomHeatmapBars (dwell-time density)
 *   - Symmetry gauge (semicircular arc)
 *   - Mirror bars (L/R balance at a glance)
 *   - Expandable per-plane directional detail tables
 *   - Summary metrics
 *
 * @module CervicalRomCard
 */

import { useMemo, useState } from 'react';
import {
    ArrowLeftRight,
    ChevronDown,
    ChevronRight,
    RotateCw,
    MoveVertical,
} from 'lucide-react';
import { RomHeatmapBar } from './RomHeatmapBar';
import { SymmetryGauge } from './SymmetryGauge';
import { MetricCompareBar } from './MetricCompareBar';
import { DwellSplitBar } from './DwellSplitBar';
import type {
    CervicalRomResult,
    PlaneRom,
    MasterSymmetry,
} from '../../analysis/CervicalRomAnalyzer';
import { cn } from '../../lib/utils';

// ============================================================================
// COLOUR HELPERS
// ============================================================================

const GRADE_COLOURS: Record<MasterSymmetry['grade'], string> = {
    excellent: 'text-accent',
    good:      'text-accent',
    fair:      'text-warning',
    poor:      'text-danger',
};

function scorePill(score: number): string {
    if (score >= 90) return 'text-accent';
    if (score >= 75) return 'text-accent/80';
    if (score >= 55) return 'text-warning';
    return 'text-danger';
}

// ============================================================================
// SMALL METRIC PILL
// ============================================================================

function MetricPill({
    label,
    value,
    unit,
    className,
    valueClassName,
}: {
    label: string;
    value: string | number;
    unit?: string;
    className?: string;
    valueClassName?: string;
}) {
    return (
        <div className={cn(
            'bg-bg-elevated rounded-lg px-3 py-2 ring-1 ring-border flex flex-col items-center',
            className,
        )}>
            <span className="text-[10px] text-text-secondary uppercase tracking-wider">
                {label}
            </span>
            <span className={cn('text-sm font-semibold text-text-primary mt-0.5', valueClassName)}>
                {value}
                {unit && <span className="text-[10px] text-text-secondary ml-0.5">{unit}</span>}
            </span>
        </div>
    );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface CervicalRomCardProps {
    result: CervicalRomResult;
    className?: string;
}

export function CervicalRomCard({ result, className }: CervicalRomCardProps) {
    const { masterSymmetry } = result;

    // Average velocity across all planes
    const avgVelocity = useMemo(() => {
        const v = (result.sagittal.avgVelocityDegS
            + result.frontal.avgVelocityDegS
            + result.transverse.avgVelocityDegS) / 3;
        return Math.round(v * 10) / 10;
    }, [result]);

    return (
        <div className={cn('space-y-3', className)}>
            {/* ── Section header ── */}
            <h4 className="text-xs font-semibold text-text-secondary flex items-center gap-1">
                <MoveVertical className="w-3 h-3" />
                Cervical Range of Motion
            </h4>

            {/* ── Heatmap bars (dwell-time density) ── */}
            <div className="space-y-3">
                <RomHeatmapBar plane={result.sagittal} />
                <RomHeatmapBar plane={result.frontal} />
                <RomHeatmapBar plane={result.transverse} />
            </div>

            {/* ── Symmetry gauge ── */}
            <SymmetryGauge symmetry={masterSymmetry} />

            {/* ── Per-plane detail cards with integrated mirror bars ── */}
            <div className="space-y-2">
                <PlaneSymmetryDetail
                    plane={result.sagittal}
                    icon={<MoveVertical className="w-3 h-3" />}
                />
                <PlaneSymmetryDetail
                    plane={result.frontal}
                    icon={<ArrowLeftRight className="w-3 h-3" />}
                />
                <PlaneSymmetryDetail
                    plane={result.transverse}
                    icon={<RotateCw className="w-3 h-3" />}
                />
            </div>

            {/* ── Summary metrics ── */}
            <div className="grid grid-cols-3 gap-2">
                <MetricPill
                    label="Active"
                    value={result.activePercent.toFixed(0)}
                    unit="%"
                />
                <MetricPill
                    label="Avg Speed"
                    value={avgVelocity}
                    unit="°/s"
                />
                <MetricPill
                    label="Symmetry"
                    value={masterSymmetry.score.toFixed(1)}
                    unit="%"
                    valueClassName={GRADE_COLOURS[masterSymmetry.grade]}
                />
            </div>
        </div>
    );
}

// ============================================================================
// PLANE SYMMETRY DETAIL
// ============================================================================

function PlaneSymmetryDetail({
    plane,
    icon,
}: {
    plane: PlaneRom;
    icon: React.ReactNode;
}) {
    const [expanded, setExpanded] = useState(false);

    // Scale maximums for consistent bar sizing
    const romScale = Math.max(plane.neg.normalRom, plane.pos.normalRom, plane.neg.rom, plane.pos.rom);
    const speedScale = Math.max(plane.neg.avgVelocityDegS, plane.pos.avgVelocityDegS, 0.1);
    const peakScale = Math.max(plane.neg.peakVelocityDegS, plane.pos.peakVelocityDegS, 0.1);
    const repScale = Math.max(plane.neg.reps, plane.pos.reps, 1);

    return (
        <div className="bg-bg-elevated rounded-lg ring-1 ring-border overflow-hidden">
            {/* Header row */}
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border">
                <span className="text-text-secondary flex-shrink-0">{icon}</span>
                <span className="text-[11px] text-text-primary font-medium flex-1 truncate">
                    {plane.label}
                </span>
                <span className={cn('text-[11px] font-bold tabular-nums', scorePill(plane.symmetry.compositeScore))}>
                    {plane.symmetry.compositeScore.toFixed(1)}%
                </span>
                <span className="text-[9px] text-text-secondary/50">sym</span>
            </div>

            {/* Toggle for full visual detail */}
            <button
                onClick={() => setExpanded(o => !o)}
                className="w-full flex items-center gap-1 px-2 py-1.5 text-[10px] text-text-secondary hover:text-text-primary transition-colors"
            >
                {expanded
                    ? <ChevronDown className="w-2.5 h-2.5" />
                    : <ChevronRight className="w-2.5 h-2.5" />
                }
                <span className="font-medium">Details</span>
            </button>

            {expanded && (
                <div className="px-2 pb-2 space-y-1.5 border-t border-border/30">
                    {/* Column headers — once at the top */}
                    <div className="flex items-center pt-1.5">
                        <span className="w-12" />
                        <div className="flex-1 flex">
                            <span className="w-1/2 text-center text-[10px] text-text-secondary font-semibold">{plane.negLabel}</span>
                            <span className="w-1/2 text-center text-[10px] text-text-secondary font-semibold">{plane.posLabel}</span>
                        </div>
                        <span className="w-12" />
                    </div>

                    {/* ROM */}
                    <MetricCompareBar
                        label="Range of Motion"
                        negValue={plane.neg.rom}
                        posValue={plane.pos.rom}
                        unit="°"
                        scaleMax={romScale}
                    />

                    {/* Avg speed */}
                    <MetricCompareBar
                        label="Average Speed"
                        negValue={plane.neg.avgVelocityDegS}
                        posValue={plane.pos.avgVelocityDegS}
                        unit="°/s"
                        scaleMax={speedScale}
                        decimals={1}
                    />

                    {/* Peak speed */}
                    <MetricCompareBar
                        label="Peak Speed"
                        negValue={plane.neg.peakVelocityDegS}
                        posValue={plane.pos.peakVelocityDegS}
                        unit="°/s"
                        scaleMax={peakScale}
                    />

                    {/* Repetitions */}
                    <MetricCompareBar
                        label="Repetitions"
                        negValue={plane.neg.reps}
                        posValue={plane.pos.reps}
                        unit=""
                        scaleMax={repScale}
                    />

                    {/* Dwell time */}
                    <DwellSplitBar
                        negPercent={plane.neg.dwellPercent}
                        posPercent={plane.pos.dwellPercent}
                    />

                    {/* Symmetry sub-scores */}
                    <div className="pt-1 border-t border-border/30 space-y-1">
                        <SymmetryScoreBar label="ROM Symmetry" value={plane.symmetry.romSymmetry} />
                        <SymmetryScoreBar label="Speed Symmetry" value={plane.symmetry.velocitySymmetry} />
                    </div>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// SYMMETRY SCORE BAR (0-100% progress bar with colour coding)
// ============================================================================

function SymmetryScoreBar({ label, value }: { label: string; value: number }) {
    const hex = value >= 90 ? '#009A44'
        : value >= 75 ? '#009A44'
            : value >= 55 ? '#F59E0B'
                : '#EF4444';

    const textCol = value >= 90 ? 'text-accent'
        : value >= 75 ? 'text-accent'
            : value >= 55 ? 'text-warning'
                : 'text-danger';

    return (
        <div className="space-y-0.5">
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-text-secondary font-medium">{label}</span>
                <span className={cn('text-[10px] tabular-nums font-semibold', textCol)}>
                    {value.toFixed(0)}%
                </span>
            </div>
            <div className="w-full h-2.5 rounded-sm overflow-hidden bg-border/30">
                <div
                    className="h-full rounded-sm"
                    style={{ width: `${Math.min(value, 100)}%`, backgroundColor: hex }}
                />
            </div>
        </div>
    );
}
