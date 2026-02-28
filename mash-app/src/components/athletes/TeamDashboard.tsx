/**
 * Team Dashboard
 * ==============
 * 
 * Coach view for managing athletes:
 * - Athlete grid with status
 * - Quick stats
 * - Team selector
 */

import { useState, useMemo } from 'react';
import {
    Users, AlertTriangle,
    ChevronDown, User
} from 'lucide-react';
import { useAthleteStore, type AthleteProfile, type AthleteStatus, type Sport } from '../../store/useAthleteStore';
import { cn } from '../../lib/utils';

// ============================================================================
// STATUS BADGE
// ============================================================================

const STATUS_COLORS: Record<AthleteStatus, string> = {
    active: 'bg-green-500',
    injured: 'bg-red-500',
    resting: 'bg-yellow-500',
    inactive: 'bg-gray-500',
};

function StatusBadge({ status }: { status: AthleteStatus }) {
    return (
        <span className={cn("inline-block w-2 h-2 rounded-full", STATUS_COLORS[status])} />
    );
}

// ============================================================================
// ATHLETE CARD
// ============================================================================

interface AthleteCardProps {
    athlete: AthleteProfile;
    onClick: () => void;
    selected?: boolean;
}

function AthleteCard({ athlete, onClick, selected }: AthleteCardProps) {
    return (
        <div
            onClick={onClick}
            className={cn(
                "p-3 rounded-lg border cursor-pointer transition-all",
                "hover:border-accent/50 hover:bg-white/5",
                selected ? "border-accent bg-accent/10" : "border-border/50 bg-bg-elevated/50"
            )}
        >
            <div className="flex items-start gap-3">
                {/* Avatar */}
                <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-accent font-bold">
                    {athlete.firstName[0]}{athlete.lastName[0]}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate">
                            {athlete.firstName} {athlete.lastName}
                        </span>
                        <StatusBadge status={athlete.status} />
                    </div>
                    <div className="text-[10px] text-text-secondary flex items-center gap-2">
                        <span>{athlete.position}</span>
                        {athlete.jerseyNumber && <span>#{athlete.jerseyNumber}</span>}
                    </div>
                </div>

                {/* Quick stats */}
                {athlete.maxJumpHeight && (
                    <div className="text-right text-[10px]">
                        <div className="text-text-secondary">Jump</div>
                        <div className="font-mono text-accent">{athlete.maxJumpHeight}cm</div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// TEAM DASHBOARD
// ============================================================================

export function TeamDashboard() {
    const currentUser = useAthleteStore(state => state.currentUser);
    const teams = useAthleteStore(state => state.teams);
    const getAthletesByTeam = useAthleteStore(state => state.getAthletesByTeam);
    const getTeamsByCoach = useAthleteStore(state => state.getTeamsByCoach);

    const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
    const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);

    // Get available teams for current user
    const availableTeams = useMemo(() => {
        if (!currentUser) return Array.from(teams.values());
        if (currentUser.role === 'admin') return Array.from(teams.values());
        if (currentUser.role === 'coach') return getTeamsByCoach(currentUser.id);
        return [];
    }, [currentUser, teams, getTeamsByCoach]);

    // Default to first team if none selected
    const activeTeamId = selectedTeamId || availableTeams[0]?.id;
    const activeTeam = activeTeamId ? teams.get(activeTeamId) : null;
    const athletes = activeTeamId ? getAthletesByTeam(activeTeamId) : [];

    // Stats
    const stats = useMemo(() => {
        const active = athletes.filter(a => a.status === 'active').length;
        const injured = athletes.filter(a => a.status === 'injured').length;
        const resting = athletes.filter(a => a.status === 'resting').length;
        return { total: athletes.length, active, injured, resting };
    }, [athletes]);

    const selectedAthlete = selectedAthleteId
        ? athletes.find(a => a.id === selectedAthleteId)
        : null;

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-glass">
                <div className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-accent" />
                    <h2 className="text-lg font-bold">Team Dashboard</h2>
                </div>

                {/* Team Selector */}
                {availableTeams.length > 1 && (
                    <div className="relative">
                        <select
                            value={activeTeamId || ''}
                            onChange={(e) => setSelectedTeamId(e.target.value)}
                            className="appearance-none bg-bg-elevated border border-border rounded px-3 py-1.5 pr-8 text-sm"
                        >
                            {availableTeams.map(team => (
                                <option key={team.id} value={team.id}>{team.name}</option>
                            ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary pointer-events-none" />
                    </div>
                )}
            </div>

            {/* Stats Bar */}
            <div className="grid grid-cols-4 gap-2 p-3 border-b border-border/30">
                <div className="text-center">
                    <div className="text-lg font-bold">{stats.total}</div>
                    <div className="text-[9px] text-text-secondary">TOTAL</div>
                </div>
                <div className="text-center">
                    <div className="text-lg font-bold text-green-400">{stats.active}</div>
                    <div className="text-[9px] text-text-secondary">ACTIVE</div>
                </div>
                <div className="text-center">
                    <div className="text-lg font-bold text-red-400">{stats.injured}</div>
                    <div className="text-[9px] text-text-secondary">INJURED</div>
                </div>
                <div className="text-center">
                    <div className="text-lg font-bold text-yellow-400">{stats.resting}</div>
                    <div className="text-[9px] text-text-secondary">RESTING</div>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-3">
                {/* Athlete Grid */}
                <div className="space-y-2">
                    {athletes.map(athlete => (
                        <AthleteCard
                            key={athlete.id}
                            athlete={athlete}
                            onClick={() => setSelectedAthleteId(
                                selectedAthleteId === athlete.id ? null : athlete.id
                            )}
                            selected={selectedAthleteId === athlete.id}
                        />
                    ))}
                </div>

                {/* Selected Athlete Details */}
                {selectedAthlete && (
                    <div className="mt-4 p-3 bg-bg-elevated rounded-lg border border-border">
                        <h4 className="font-semibold mb-2 flex items-center gap-2">
                            <User className="w-4 h-4" />
                            {selectedAthlete.firstName} {selectedAthlete.lastName}
                        </h4>

                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                            {selectedAthlete.height && (
                                <div>
                                    <span className="text-text-secondary">Height:</span>{' '}
                                    <span>{selectedAthlete.height} cm</span>
                                </div>
                            )}
                            {selectedAthlete.weight && (
                                <div>
                                    <span className="text-text-secondary">Weight:</span>{' '}
                                    <span>{selectedAthlete.weight} kg</span>
                                </div>
                            )}
                            {selectedAthlete.legLength && (
                                <div>
                                    <span className="text-text-secondary">Leg Length:</span>{' '}
                                    <span>{selectedAthlete.legLength} cm</span>
                                </div>
                            )}
                            {selectedAthlete.wingspan && (
                                <div>
                                    <span className="text-text-secondary">Wingspan:</span>{' '}
                                    <span>{selectedAthlete.wingspan} cm</span>
                                </div>
                            )}
                            {selectedAthlete.maxJumpHeight && (
                                <div>
                                    <span className="text-text-secondary">Max Jump:</span>{' '}
                                    <span className="text-accent">{selectedAthlete.maxJumpHeight} cm</span>
                                </div>
                            )}
                            {selectedAthlete.baseStrideLength && (
                                <div>
                                    <span className="text-text-secondary">Stride:</span>{' '}
                                    <span className="text-accent">{selectedAthlete.baseStrideLength} cm</span>
                                </div>
                            )}
                        </div>

                        {selectedAthlete.currentLimitations && (
                            <div className="mt-2 p-2 bg-red-500/10 rounded text-[10px] text-red-400 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                {selectedAthlete.currentLimitations}
                            </div>
                        )}
                    </div>
                )}

                {/* Empty state */}
                {athletes.length === 0 && (
                    <div className="text-center text-text-secondary py-8">
                        <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
                        <p className="text-sm">No athletes in this team</p>
                    </div>
                )}
            </div>
        </div>
    );
}
