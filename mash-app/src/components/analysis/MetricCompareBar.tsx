/**
 * Metric Compare Bar
 * ====================
 *
 * A compact inline visual showing two values extending from a centre line.
 * Used for side-by-side comparison of any metric (ROM, speed, reps, etc.)
 *
 * Layout:
 *   [negValue] ◀══════|══════▶ [posValue]
 *     negLabel              posLabel
 *
 * Bar length ∝ value / scaleMax.  Colour encodes quality:
 *   accent (green) = good, warning (amber) = moderate, danger (red) = deficit.
 *
 * @module MetricCompareBar
 */

import { cn } from '../../lib/utils';

// ============================================================================
// COLOUR HELPERS — gradients for visual balance communication
// ============================================================================

/** Gradient from centre outward: transparent → colour */
function gradientLeft(hex: string): string {
    return `linear-gradient(to left, ${hex}, ${hex}CC 40%, ${hex}66)`;
}
function gradientRight(hex: string): string {
    return `linear-gradient(to right, ${hex}, ${hex}CC 40%, ${hex}66)`;
}

const COLOURS = {
    green: { hex: '#009A44', text: 'text-accent' },
    amber: { hex: '#F59E0B', text: 'text-warning' },
    red:   { hex: '#EF4444', text: 'text-danger' },
} as const;

type BarColour = keyof typeof COLOURS;

// ============================================================================
// COMPONENT
// ============================================================================

interface MetricCompareBarProps {
    /** Metric name shown above the bar */
    label: string;
    /** Left side value */
    negValue: number;
    /** Right side value */
    posValue: number;
    /** Unit suffix (e.g. "°", "°/s", "") */
    unit: string;
    /** Max value for scaling bars; defaults to max(neg, pos) */
    scaleMax?: number;
    /** Optional colour override for left bar */
    negColour?: BarColour;
    /** Optional colour override for right bar */
    posColour?: BarColour;
    /** Number of decimal places for display (default 0) */
    decimals?: number;
    className?: string;
}

export function MetricCompareBar({
    label,
    negValue,
    posValue,
    unit,
    scaleMax,
    negColour,
    posColour,
    decimals = 0,
    className,
}: MetricCompareBarProps) {
    const max = scaleMax ?? Math.max(Math.abs(negValue), Math.abs(posValue), 0.01);
    const negPct = Math.min((Math.abs(negValue) / max) * 100, 100);
    const posPct = Math.min((Math.abs(posValue) / max) * 100, 100);

    // Default colour: whichever side is smaller gets amber, bigger gets green
    // If they're within 10% of each other, both green
    const ratio = max > 0.01 ? Math.min(negValue, posValue) / max : 1;
    const defaultNeg: BarColour = negValue < posValue && ratio < 0.9 ? (ratio < 0.5 ? 'red' : 'amber') : 'green';
    const defaultPos: BarColour = posValue < negValue && ratio < 0.9 ? (ratio < 0.5 ? 'red' : 'amber') : 'green';

    const nCol = negColour ?? defaultNeg;
    const pCol = posColour ?? defaultPos;

    const fmtNeg = negValue.toFixed(decimals);
    const fmtPos = posValue.toFixed(decimals);

    return (
        <div className={cn('space-y-0.5', className)}>
            {/* Metric label */}
            <div className="text-[10px] text-text-secondary font-medium">{label}</div>

            {/* Bar row */}
            <div className="flex items-center gap-1 h-6">
                {/* Neg value */}
                <span className={cn('text-[10px] tabular-nums w-12 text-right font-semibold', COLOURS[nCol].text)}>
                    {fmtNeg}{unit}
                </span>

                {/* Bar container (two halves from centre) */}
                <div className="flex-1 flex h-4 rounded-sm overflow-hidden bg-border/30">
                    {/* Left half — grows right-to-left */}
                    <div className="w-1/2 flex justify-end">
                        <div
                            className="h-full rounded-l-sm"
                            style={{ width: `${negPct}%`, background: gradientLeft(COLOURS[nCol].hex) }}
                        />
                    </div>
                    {/* Centre divider */}
                    <div className="w-px bg-text-secondary/40 flex-shrink-0" />
                    {/* Right half — grows left-to-right */}
                    <div className="w-1/2 flex justify-start">
                        <div
                            className="h-full rounded-r-sm"
                            style={{ width: `${posPct}%`, background: gradientRight(COLOURS[pCol].hex) }}
                        />
                    </div>
                </div>

                {/* Pos value */}
                <span className={cn('text-[10px] tabular-nums w-12 text-left font-semibold', COLOURS[pCol].text)}>
                    {fmtPos}{unit}
                </span>
            </div>
        </div>
    );
}
