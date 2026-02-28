/**
 * Leaderboard Component
 * =====================
 * 
 * Ranked athlete metrics with filtering by team and metric type.
 */

import { useState, useMemo } from 'react';
import { Trophy, ChevronDown, Medal, TrendingUp } from 'lucide-react';
import { useAthleteStore } from '../../store/useAthleteStore';
import { cn } from '../../lib/utils';

// ============================================================================
// METRICS
// ============================================================================

const METRICS = [
    { id: 'maxJumpHeight', label: 'Max Jump Height', unit: 'cm', icon: TrendingUp },
    { id: 'strideLength', label: 'Stride Length', unit: 'cm', icon: TrendingUp },
    { id: 'height', label: 'Height', unit: 'cm', icon: TrendingUp },
];

// ============================================================================
// LEADERBOARD
// ============================================================================

export function Leaderboard() {
    const teams = useAthleteStore(state => state.teams);
    const getLeaderboard = useAthleteStore(state => state.getLeaderboard);

    const [selectedMetric, setSelectedMetric] = useState('maxJumpHeight');
    const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>(undefined);

    const teamList = Array.from(teams.values());
    const leaderboard = useMemo(
        () => getLeaderboard(selectedMetric, selectedTeamId),
        [getLeaderboard, selectedMetric, selectedTeamId]
    );

    const metricInfo = METRICS.find(m => m.id === selectedMetric)!;

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-glass">
                <div className="flex items-center gap-2">
                    <Trophy className="w-5 h-5 text-yellow-500" />
                    <h2 className="text-lg font-bold">Leaderboard</h2>
                </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2 p-3 border-b border-border/30">
                {/* Metric selector */}
                <div className="relative flex-1">
                    <select
                        value={selectedMetric}
                        onChange={(e) => setSelectedMetric(e.target.value)}
                        className="w-full appearance-none bg-bg-elevated border border-border rounded px-3 py-1.5 pr-8 text-sm"
                    >
                        {METRICS.map(m => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary pointer-events-none" />
                </div>

                {/* Team filter */}
                <div className="relative">
                    <select
                        value={selectedTeamId || ''}
                        onChange={(e) => setSelectedTeamId(e.target.value || undefined)}
                        className="appearance-none bg-bg-elevated border border-border rounded px-3 py-1.5 pr-8 text-sm"
                    >
                        <option value="">All Teams</option>
                        {teamList.map(team => (
                            <option key={team.id} value={team.id}>{team.name}</option>
                        ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary pointer-events-none" />
                </div>
            </div>

            {/* Leaderboard List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {leaderboard.map((entry, idx) => (
                    <div
                        key={entry.athleteId}
                        className={cn(
                            "flex items-center gap-3 p-2 rounded-lg transition-colors",
                            idx === 0 ? "bg-yellow-500/10 border border-yellow-500/30" :
                                idx === 1 ? "bg-gray-400/10 border border-gray-400/30" :
                                    idx === 2 ? "bg-amber-700/10 border border-amber-700/30" :
                                        "bg-bg-elevated/50"
                        )}
                    >
                        {/* Rank */}
                        <div className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm",
                            idx === 0 ? "bg-yellow-500 text-black" :
                                idx === 1 ? "bg-gray-400 text-black" :
                                    idx === 2 ? "bg-amber-700 text-white" :
                                        "bg-bg-surface text-text-secondary"
                        )}>
                            {idx < 3 ? <Medal className="w-4 h-4" /> : entry.rank}
                        </div>

                        {/* Name */}
                        <div className="flex-1 truncate">
                            <span className="font-medium text-sm">{entry.athleteName}</span>
                        </div>

                        {/* Value */}
                        <div className="text-right">
                            <span className="font-mono font-bold text-accent">
                                {entry.value}
                            </span>
                            <span className="text-[10px] text-text-secondary ml-1">
                                {metricInfo.unit}
                            </span>
                        </div>
                    </div>
                ))}

                {leaderboard.length === 0 && (
                    <div className="text-center text-text-secondary py-8">
                        <Trophy className="w-12 h-12 mx-auto mb-3 opacity-30" />
                        <p className="text-sm">No data available</p>
                    </div>
                )}
            </div>
        </div>
    );
}
