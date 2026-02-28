/**
 * Athletes Panel
 * ==============
 * 
 * Sidebar panel with tabs for Team Dashboard, Leaderboard, and Head-to-Head.
 */

import { useState } from 'react';
import { Users, Trophy, GitCompare } from 'lucide-react';
import { TeamDashboard } from '../../athletes/TeamDashboard';
import { Leaderboard } from '../../athletes/Leaderboard';
import { HeadToHead } from '../../athletes/HeadToHead';
import { cn } from '../../../lib/utils';

type AthleteTab = 'team' | 'leaderboard' | 'compare';

const TABS = [
    { id: 'team' as const, icon: Users, label: 'Team' },
    { id: 'leaderboard' as const, icon: Trophy, label: 'Rankings' },
    { id: 'compare' as const, icon: GitCompare, label: 'Compare' },
];

export function AthletesPanel() {
    const [activeTab, setActiveTab] = useState<AthleteTab>('team');

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Sub-tabs */}
            <div className="flex border-b border-glass">
                {TABS.map(tab => {
                    const Icon = tab.icon;
                    const isActive = activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] font-medium transition-colors",
                                isActive
                                    ? "text-accent border-b-2 border-accent bg-accent/5"
                                    : "text-text-secondary hover:text-white hover:bg-white/5"
                            )}
                        >
                            <Icon className="w-3.5 h-3.5" />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden">
                {activeTab === 'team' && <TeamDashboard />}
                {activeTab === 'leaderboard' && <Leaderboard />}
                {activeTab === 'compare' && <HeadToHead />}
            </div>
        </div>
    );
}
