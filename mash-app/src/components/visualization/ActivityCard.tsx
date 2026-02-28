/**
 * ActivityCard - Real-time activity visualization component
 * 
 * Displays the current detected activity with an animated icon,
 * confidence meter, and toggle control. Uses neo liquid glass styling.
 */

import { useActivityStore } from '../../store/useActivityStore';
import type { ActivityLabel } from '../../lib/analysis/ActivityEngine';

// Activity configuration
const ACTIVITY_CONFIG: Record<ActivityLabel, {
    icon: string;
    label: string;
    color: string;
    bgGradient: string;
}> = {
    idle: {
        icon: '🧍',
        label: 'Standing',
        color: '#64748B',
        bgGradient: 'linear-gradient(135deg, rgba(100, 116, 139, 0.2), rgba(71, 85, 105, 0.1))',
    },
    walking: {
        icon: '🚶',
        label: 'Walking',
        color: '#009A44',
        bgGradient: 'linear-gradient(135deg, rgba(0, 154, 68, 0.25), rgba(0, 120, 50, 0.1))',
    },
    squatting: {
        icon: '🏋️',
        label: 'Squatting',
        color: '#8B5CF6',
        bgGradient: 'linear-gradient(135deg, rgba(139, 92, 246, 0.25), rgba(109, 40, 217, 0.1))',
    },
    jumping: {
        icon: '🦘',
        label: 'Jumping',
        color: '#F97316',
        bgGradient: 'linear-gradient(135deg, rgba(249, 115, 22, 0.25), rgba(234, 88, 12, 0.1))',
    },
    unknown: {
        icon: '❓',
        label: 'Detecting...',
        color: '#475569',
        bgGradient: 'linear-gradient(135deg, rgba(71, 85, 105, 0.2), rgba(51, 65, 85, 0.1))',
    },
};

export function ActivityCard() {
    const { currentActivity, confidence, isDetecting, toggleDetection } = useActivityStore();
    const config = ACTIVITY_CONFIG[currentActivity];
    const confidencePercent = Math.round(confidence * 100);

    return (
        <div
            className="glass-card rounded-xl p-4 relative overflow-hidden transition-all duration-300"
            style={{ background: config.bgGradient }}
        >
            {/* Ambient glow effect */}
            <div
                className="absolute inset-0 opacity-20 blur-2xl pointer-events-none"
                style={{ backgroundColor: config.color }}
            />

            {/* Header */}
            <div className="flex justify-between items-center mb-3 relative z-10">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                    Activity
                </span>
                <button
                    onClick={toggleDetection}
                    className={`
                        px-2 py-0.5 rounded-full text-[10px] font-medium transition-all duration-200
                        ${isDetecting
                            ? 'bg-und-green/20 text-und-green border border-und-green/30'
                            : 'bg-white/5 text-text-secondary border border-white/10 hover:bg-white/10'
                        }
                    `}
                >
                    {isDetecting ? '⏹ Stop' : '▶ Start'}
                </button>
            </div>

            {/* Main Content */}
            <div className="flex items-center gap-4 relative z-10">
                {/* Icon */}
                <div
                    className="w-14 h-14 rounded-xl flex items-center justify-center text-3xl transition-transform duration-300"
                    style={{
                        background: `linear-gradient(145deg, ${config.color}22, ${config.color}11)`,
                        border: `1px solid ${config.color}33`,
                        transform: isDetecting ? 'scale(1)' : 'scale(0.9)',
                    }}
                >
                    {config.icon}
                </div>

                {/* Label and Confidence */}
                <div className="flex-1">
                    <div
                        className="text-lg font-bold transition-colors duration-300"
                        style={{ color: config.color }}
                    >
                        {config.label}
                    </div>

                    {/* Confidence Bar */}
                    <div className="mt-1.5">
                        <div className="flex justify-between items-center text-[10px] text-text-secondary mb-1">
                            <span>Confidence</span>
                            <span>{confidencePercent}%</span>
                        </div>
                        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                            <div
                                className="h-full rounded-full transition-all duration-500 ease-out"
                                style={{
                                    width: `${confidencePercent}%`,
                                    backgroundColor: config.color,
                                    boxShadow: `0 0 8px ${config.color}66`,
                                }}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Status indicator */}
            {isDetecting && (
                <div className="absolute top-3 right-12 flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-und-green animate-pulse" />
                </div>
            )}
        </div>
    );
}
