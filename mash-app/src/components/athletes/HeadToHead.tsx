/**
 * Head-to-Head Athlete Comparison
 * ================================
 * 
 * Compare two athletes side-by-side with stats and metrics.
 */

import { useState, useMemo } from 'react';
import { Users, ArrowLeftRight, TrendingUp } from 'lucide-react';
import { useAthleteStore, type AthleteProfile } from '../../store/useAthleteStore';
import { cn } from '../../lib/utils';

// ============================================================================
// COMPARISON METRICS
// ============================================================================

interface ComparisonMetric {
    key: keyof AthleteProfile;
    label: string;
    unit: string;
    higherIsBetter: boolean;
}

const COMPARISON_METRICS: ComparisonMetric[] = [
    { key: 'height', label: 'Height', unit: 'cm', higherIsBetter: true },
    { key: 'weight', label: 'Weight', unit: 'kg', higherIsBetter: false },
    { key: 'wingspan', label: 'Wingspan', unit: 'cm', higherIsBetter: true },
    { key: 'legLength', label: 'Leg Length', unit: 'cm', higherIsBetter: true },
    { key: 'maxJumpHeight', label: 'Max Jump', unit: 'cm', higherIsBetter: true },
    { key: 'baseStrideLength', label: 'Stride Length', unit: 'cm', higherIsBetter: true },
    { key: 'yearsExperience', label: 'Experience', unit: 'yrs', higherIsBetter: true },
];

// ============================================================================
// ATHLETE SELECTOR
// ============================================================================

interface AthleteSelectorProps {
    selectedId: string | null;
    onSelect: (id: string) => void;
    excludeId?: string | null;
    label: string;
    color: string;
}

function AthleteSelector({ selectedId, onSelect, excludeId, label, color }: AthleteSelectorProps) {
    const athletes = useAthleteStore(state => state.athletes);
    const athleteList = Array.from(athletes.values()).filter(a => a.id !== excludeId);

    const selected = selectedId ? athletes.get(selectedId) : null;

    return (
        <div className={cn("flex-1 p-3 rounded-lg border", `border-${color}-500/30 bg-${color}-500/5`)}>
            <div className={cn("text-[10px] font-bold mb-2", `text-${color}-400`)}>
                {label}
            </div>

            <select
                value={selectedId || ''}
                onChange={(e) => onSelect(e.target.value)}
                className="w-full bg-bg-elevated border border-border rounded px-2 py-1.5 text-sm"
            >
                <option value="">Select athlete...</option>
                {athleteList.map(a => (
                    <option key={a.id} value={a.id}>
                        {a.firstName} {a.lastName} ({a.sport === 'speed_skating' ? 'Skating' : 'Hockey'})
                    </option>
                ))}
            </select>

            {selected && (
                <div className="mt-3 text-center">
                    <div className={cn("w-16 h-16 mx-auto rounded-full flex items-center justify-center text-2xl font-bold", `bg-${color}-500/20 text-${color}-400`)}>
                        {selected.firstName[0]}{selected.lastName[0]}
                    </div>
                    <div className="mt-2 font-semibold">
                        {selected.firstName} {selected.lastName}
                    </div>
                    <div className="text-[10px] text-text-secondary">
                        {selected.position} • {selected.sport === 'speed_skating' ? 'Speed Skating' : 'Hockey'}
                    </div>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// COMPARISON BAR
// ============================================================================

interface ComparisonBarProps {
    metric: ComparisonMetric;
    valueA: number | undefined;
    valueB: number | undefined;
}

function ComparisonBar({ metric, valueA, valueB }: ComparisonBarProps) {
    // Calculate percentages for visualization
    const a = valueA || 0;
    const b = valueB || 0;
    const max = Math.max(a, b, 1);
    const pctA = (a / max) * 100;
    const pctB = (b / max) * 100;

    // Determine winner
    let winner: 'a' | 'b' | 'tie' = 'tie';
    if (a !== b) {
        winner = (a > b) === metric.higherIsBetter ? 'a' : 'b';
    }

    return (
        <div className="mb-3">
            <div className="flex items-center justify-between text-[10px] text-text-secondary mb-1">
                <span>{metric.label}</span>
                <span>{metric.unit}</span>
            </div>

            <div className="flex items-center gap-2">
                {/* Value A */}
                <div className={cn(
                    "w-16 text-right font-mono text-sm",
                    winner === 'a' ? "text-yellow-400 font-bold" : "text-text-primary"
                )}>
                    {valueA ?? '—'}
                    {winner === 'a' && <TrendingUp className="inline w-3 h-3 ml-1" />}
                </div>

                {/* Bar visualization */}
                <div className="flex-1 flex h-3 bg-bg-elevated rounded overflow-hidden">
                    <div
                        className="bg-yellow-500/60 transition-all"
                        style={{ width: `${pctA / 2}%` }}
                    />
                    <div className="flex-1" />
                    <div
                        className="bg-cyan-500/60 transition-all"
                        style={{ width: `${pctB / 2}%` }}
                    />
                </div>

                {/* Value B */}
                <div className={cn(
                    "w-16 text-left font-mono text-sm",
                    winner === 'b' ? "text-cyan-400 font-bold" : "text-text-primary"
                )}>
                    {winner === 'b' && <TrendingUp className="inline w-3 h-3 mr-1" />}
                    {valueB ?? '—'}
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// HEAD TO HEAD
// ============================================================================

export function HeadToHead() {
    const athletes = useAthleteStore(state => state.athletes);

    const [athleteAId, setAthleteAId] = useState<string | null>(null);
    const [athleteBId, setAthleteBId] = useState<string | null>(null);

    const athleteA = athleteAId ? athletes.get(athleteAId) : null;
    const athleteB = athleteBId ? athletes.get(athleteBId) : null;

    const swap = () => {
        setAthleteAId(athleteBId);
        setAthleteBId(athleteAId);
    };

    // Calculate win counts
    const { winsA, winsB } = useMemo(() => {
        if (!athleteA || !athleteB) return { winsA: 0, winsB: 0 };

        let a = 0, b = 0;
        COMPARISON_METRICS.forEach(m => {
            const valA = athleteA[m.key] as number | undefined;
            const valB = athleteB[m.key] as number | undefined;
            if (valA && valB && valA !== valB) {
                if ((valA > valB) === m.higherIsBetter) a++; else b++;
            }
        });
        return { winsA: a, winsB: b };
    }, [athleteA, athleteB]);

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-glass">
                <div className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-accent" />
                    <h2 className="text-lg font-bold">Head to Head</h2>
                </div>
            </div>

            {/* Athlete Selectors */}
            <div className="flex items-stretch gap-2 p-3 border-b border-border/30">
                <AthleteSelector
                    selectedId={athleteAId}
                    onSelect={setAthleteAId}
                    excludeId={athleteBId}
                    label="ATHLETE A"
                    color="yellow"
                />

                <button
                    onClick={swap}
                    disabled={!athleteAId || !athleteBId}
                    className="self-center p-2 rounded-full bg-bg-elevated hover:bg-white/10 disabled:opacity-50"
                >
                    <ArrowLeftRight className="w-4 h-4" />
                </button>

                <AthleteSelector
                    selectedId={athleteBId}
                    onSelect={setAthleteBId}
                    excludeId={athleteAId}
                    label="ATHLETE B"
                    color="cyan"
                />
            </div>

            {/* Score Summary */}
            {athleteA && athleteB && (
                <div className="flex items-center justify-center gap-4 py-3 border-b border-border/30">
                    <div className={cn(
                        "text-3xl font-bold",
                        winsA > winsB ? "text-yellow-400" : "text-text-secondary"
                    )}>
                        {winsA}
                    </div>
                    <div className="text-text-secondary">vs</div>
                    <div className={cn(
                        "text-3xl font-bold",
                        winsB > winsA ? "text-cyan-400" : "text-text-secondary"
                    )}>
                        {winsB}
                    </div>
                </div>
            )}

            {/* Comparison Bars */}
            <div className="flex-1 overflow-y-auto p-3">
                {athleteA && athleteB ? (
                    COMPARISON_METRICS.map(metric => (
                        <ComparisonBar
                            key={metric.key}
                            metric={metric}
                            valueA={athleteA[metric.key] as number | undefined}
                            valueB={athleteB[metric.key] as number | undefined}
                        />
                    ))
                ) : (
                    <div className="text-center text-text-secondary py-8">
                        <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
                        <p className="text-sm">Select two athletes to compare</p>
                    </div>
                )}
            </div>
        </div>
    );
}
