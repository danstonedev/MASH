/**
 * Dwell Split Bar
 * ================
 *
 * A proportional split bar showing how time is divided between two directions.
 * The bar fills 100% — left portion = neg dwell, right = pos dwell.
 *
 *   [negPct%]  ██████████████|████████████  [posPct%]
 *              negLabel        posLabel
 *
 * Balanced ≈ 50/50 (green). Skewed → amber/red gradient.
 *
 * @module DwellSplitBar
 */

import { cn } from '../../lib/utils';

// ============================================================================
// COLOUR HELPERS — hex values to avoid tailwind-merge stripping
// ============================================================================

const DWELL_COLOURS = {
    green: { hex: '#009A44', text: 'text-accent' },
    amber: { hex: '#F59E0B', text: 'text-warning' },
    red:   { hex: '#EF4444', text: 'text-danger' },
} as const;

function dwellGrade(pct: number): keyof typeof DWELL_COLOURS {
    const deviation = Math.abs(pct - 50);
    if (deviation <= 10) return 'green';
    if (deviation <= 20) return 'amber';
    return 'red';
}

// ============================================================================
// COMPONENT
// ============================================================================

interface DwellSplitBarProps {
    /** Left direction percentage (0-100) */
    negPercent: number;
    /** Right direction percentage (0-100) */
    posPercent: number;
    /** Metric label shown above */
    label?: string;
    className?: string;
}

export function DwellSplitBar({
    negPercent,
    posPercent,
    label = 'Time Distribution',
    className,
}: DwellSplitBarProps) {
    // Ensure they sum to ~100
    const total = negPercent + posPercent || 1;
    const negNorm = (negPercent / total) * 100;
    const posNorm = (posPercent / total) * 100;

    const negGrade = dwellGrade(negPercent);
    const posGrade = dwellGrade(posPercent);

    return (
        <div className={cn('space-y-0.5', className)}>
            {/* Label */}
            <div className="text-[10px] text-text-secondary font-medium">{label}</div>

            {/* Bar row */}
            <div className="flex items-center gap-1 h-6">
                {/* Neg value */}
                <span className={cn('text-[10px] tabular-nums w-12 text-right font-semibold', DWELL_COLOURS[negGrade].text)}>
                    {negPercent.toFixed(0)}%
                </span>

                {/* Split bar */}
                <div className="flex-1 flex h-4 rounded-sm overflow-hidden bg-border/30">
                    <div
                        className="h-full"
                        style={{ width: `${negNorm}%`, background: `linear-gradient(to left, ${DWELL_COLOURS[negGrade].hex}, ${DWELL_COLOURS[negGrade].hex}CC 40%, ${DWELL_COLOURS[negGrade].hex}66)` }}
                    />
                    <div className="w-px bg-text-secondary/40 flex-shrink-0" />
                    <div
                        className="h-full"
                        style={{ width: `${posNorm}%`, background: `linear-gradient(to right, ${DWELL_COLOURS[posGrade].hex}, ${DWELL_COLOURS[posGrade].hex}CC 40%, ${DWELL_COLOURS[posGrade].hex}66)` }}
                    />
                </div>

                {/* Pos value */}
                <span className={cn('text-[10px] tabular-nums w-12 text-left font-semibold', DWELL_COLOURS[posGrade].text)}>
                    {posPercent.toFixed(0)}%
                </span>
            </div>
        </div>
    );
}
