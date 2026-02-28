import { useState, useEffect } from 'react';
import { useJointAnglesStore } from '../../store/useJointAnglesStore';
import { JOINT_DEFINITIONS } from '../../biomech/jointAngles';
import { LineChart, Line, YAxis, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Check, Activity } from 'lucide-react';

const COLORS = ['#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6'];

export function JointBiomechanicsView() {
    // Subscribe to store updates (no selector = update on any change)
    const { jointData, isTracking } = useJointAnglesStore();
    const [selectedJoints, setSelectedJoints] = useState<Set<string>>(new Set());
    const [history, setHistory] = useState<any[]>([]);

    // History update loop (High Frequency 30Hz)
    useEffect(() => {
        if (selectedJoints.size === 0 || !isTracking) return;

        const interval = setInterval(() => {
            const now = Date.now();
            const newPoint: any = { timestamp: now };

            selectedJoints.forEach(jointId => {
                const data = useJointAnglesStore.getState().jointData.get(jointId);
                if (data) {
                    newPoint[`flexion_${jointId}`] = data.current.flexion;
                    newPoint[`abduction_${jointId}`] = data.current.abduction;
                    newPoint[`rotation_${jointId}`] = data.current.rotation;
                }
            });

            setHistory(prev => {
                const newHistory = [...prev, newPoint];
                if (newHistory.length > 300) return newHistory.slice(newHistory.length - 300);
                return newHistory;
            });
        }, 33);

        return () => clearInterval(interval);
    }, [selectedJoints, isTracking]);

    const toggleJoint = (jointId: string) => {
        const newSet = new Set(selectedJoints);
        if (newSet.has(jointId)) {
            newSet.delete(jointId);
        } else {
            if (newSet.size >= 4) return; // Limit to 4 for graph sanity
            newSet.add(jointId);
        }
        setSelectedJoints(newSet);
        if (newSet.size === 0) setHistory([]);
    };

    const selectedList = Array.from(selectedJoints);

    // Filter available definitions (All Joints)
    const allJoints = Object.keys(JOINT_DEFINITIONS);

    return (
        <div className="flex flex-col h-full bg-bg-surface overflow-hidden">
            {/* Top Section: Joint List (Multi-Select) */}
            <div className="flex-none h-[40%] overflow-y-auto border-b border-border bg-bg-elevated/30">
                <div className="p-2 space-y-1">
                    <div className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider px-1 mb-1 flex justify-between">
                        <span>Select Joints ({selectedList.length}/4) [{allJoints.length} Avail]</span>
                        <span>{isTracking ? '● LIVE' : 'paused'}</span>
                    </div>
                    {allJoints.length === 0 && (
                        <div className="p-4 text-xs text-red-400 text-center border border-red-500/30 rounded bg-red-500/10">
                            Critical Error: JOINT_DEFINITIONS is empty ({Object.keys(JOINT_DEFINITIONS || {}).length}).
                            Check imports.
                        </div>
                    )}
                    {allJoints.map(jointId => {
                        const data = jointData.get(jointId);
                        const def = JOINT_DEFINITIONS[jointId];
                        const isSelected = selectedJoints.has(jointId);
                        const isActive = !!data;

                        if (!def) return null;

                        return (
                            <button
                                key={jointId}
                                onClick={() => toggleJoint(jointId)}
                                className={`w-full text-left p-2 rounded border transition-all ${isSelected
                                    ? 'bg-accent/10 border-accent shadow-sm'
                                    : 'bg-bg-elevated border-border hover:border-text-secondary/50'
                                    }`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-accent' : 'bg-text-tertiary/30'}`} />
                                        <span className={`text-xs font-semibold ${isSelected ? 'text-accent' : isActive ? 'text-text-primary' : 'text-text-secondary'}`}>
                                            {def.name}
                                        </span>
                                    </div>
                                    {isSelected && <Check className="w-3 h-3 text-accent" />}
                                </div>

                                {/* Expanded ROM Bars */}
                                {isActive ? (
                                    <div className="space-y-1.5 mt-2">
                                        <RomBar
                                            label={def.flexionName || 'Flexion'}
                                            value={data.current.flexion}
                                            min={def.flexionRange?.[0] ?? -180}
                                            max={def.flexionRange?.[1] ?? 180}
                                        />
                                        <RomBar
                                            label={def.abductionName || 'Abduction'}
                                            value={data.current.abduction}
                                            min={def.abductionRange?.[0] ?? -180}
                                            max={def.abductionRange?.[1] ?? 180}
                                        />
                                        <RomBar
                                            label={def.rotationName || 'Rotation'}
                                            value={data.current.rotation}
                                            min={def.rotationRange?.[0] ?? -180}
                                            max={def.rotationRange?.[1] ?? 180}
                                        />
                                    </div>
                                ) : (
                                    <div className="text-center text-xs text-text-tertiary py-2 opacity-50">
                                        -- No Data --
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Bottom Section: Comparison Graphs */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2 bg-bg-surface">
                {selectedList.length > 0 ? (
                    <>
                        {/* Plane 1: Flexion Comparison */}
                        <MultiLineGraph
                            title="Flexion / Extension"
                            data={history}
                            dataKeyPrefix="flexion"
                            selectedJoints={selectedList}
                            domain={[-60, 140]}
                        />

                        {/* Plane 2: Abduction Comparison */}
                        <MultiLineGraph
                            title="Abduction / Adduction"
                            data={history}
                            dataKeyPrefix="abduction"
                            selectedJoints={selectedList}
                            domain={[-45, 45]}
                        />

                        {/* Plane 3: Rotation Comparison */}
                        <MultiLineGraph
                            title="Axial Rotation"
                            data={history}
                            dataKeyPrefix="rotation"
                            selectedJoints={selectedList}
                            domain={[-60, 60]}
                        />

                        {/* Legend */}
                        <div className="flex flex-wrap gap-2 px-2 pb-2">
                            {selectedList.map((id, idx) => (
                                <div key={id} className="flex items-center gap-1 text-[10px]">
                                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                                    <span className="text-text-secondary">{JOINT_DEFINITIONS[id]?.name}</span>
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center text-text-tertiary p-4 text-center">
                        <Activity className="w-8 h-8 mb-2 opacity-50" />
                        <p className="text-xs">Select joints above to compare kinematics</p>
                    </div>
                )}
            </div>
        </div>
    );
}

function MultiLineGraph({ title, data, dataKeyPrefix, selectedJoints, domain }: any) {
    return (
        <div className="bg-bg-elevated/50 rounded border border-border overflow-hidden flex flex-col h-[160px]">
            {/* ... (existing graph code) ... */}
            <div className="px-2 py-1 bg-bg-elevated border-b border-border/50">
                <span className="text-[10px] uppercase font-bold text-text-secondary tracking-wider">{title}</span>
            </div>
            <div className="flex-1 w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data}>
                        <ReferenceLine y={0} stroke="#444" strokeDasharray="3 3" />
                        <YAxis domain={domain} hide />
                        {selectedJoints.map((jointId: string, idx: number) => (
                            <Line
                                key={jointId}
                                type="monotone"
                                dataKey={`${dataKeyPrefix}_${jointId}`}
                                stroke={COLORS[idx % COLORS.length]}
                                strokeWidth={2}
                                dot={false}
                                isAnimationActive={false}
                            />
                        ))}
                    </LineChart>
                </ResponsiveContainer>
                {/* Labels */}
                <div className="absolute top-1 right-1 text-[8px] text-text-tertiary">{domain[1]}°</div>
                <div className="absolute bottom-1 right-1 text-[8px] text-text-tertiary">{domain[0]}°</div>
            </div>
        </div>
    );
}

function RomBar({ label, value, min, max }: { label: string, value: number, min: number, max: number }) {
    // 0. Compute normalized position (0 to 1)
    // Clamp value to min/max to prevent pip flying off
    const clampedValue = Math.max(min, Math.min(max, value));
    const range = max - min;
    const percentage = ((clampedValue - min) / range) * 100;

    // 1. Determine Zone Color
    // Simple logic: Green near 0, Yellow > 30%, Red > 80% of range (just a heuristic)
    // Better heuristic: "Green" is the middle 50% of the range? Or simply graded?
    // Let's use a dynamic HSL: Green(120) -> Red(0) based on distance from "neutral" (usually 0)
    // Most anatomical 0 is neutral. 
    // Normalized distance from 0:
    const distFromZero = Math.abs(value);
    // Max excursion (approx):
    const maxExcursion = Math.max(Math.abs(min), Math.abs(max));
    const normalizedStress = Math.min(1, distFromZero / (maxExcursion || 1));

    // Hue: 120 (Green) -> 0 (Red)
    const hue = 120 * (1 - normalizedStress);
    const color = `hsl(${hue}, 80%, 45%)`;

    return (
        <div className="w-full">
            <div className="flex justify-between text-[10px] items-end mb-0.5">
                <span className="text-text-secondary font-medium truncate max-w-[70%] leading-tight text-[9px] uppercase tracking-wide opacity-80">{label}</span>
                <span className="font-mono font-bold" style={{ color }}>{Math.round(value)}°</span>
            </div>

            {/* Bar Track */}
            <div className="h-2.5 w-full bg-bg-surface/50 rounded-sm relative border border-border/30 overflow-hidden">
                {/* Center marker (0 degrees) */}
                {min < 0 && max > 0 && (
                    <div
                        className="absolute top-0 bottom-0 w-[1px] bg-text-tertiary/20 z-0"
                        style={{ left: `${((0 - min) / range) * 100}%` }}
                    />
                )}

                {/* Colored Fill Bar - Optional? Or just a Pip? 
                    Let's do a pip design for precision, maybe with a faint "fill" from 0
                */}
                <div
                    className="absolute top-0 bottom-0 opacity-20"
                    style={{
                        left: value >= 0 ? `${((0 - min) / range) * 100}%` : `${percentage}%`,
                        width: Math.abs(((value - 0) / range) * 100) + '%',
                        backgroundColor: color
                    }}
                />

                {/* Pip Answer */}
                <div
                    className="absolute top-0 bottom-0 w-1 -ml-0.5 z-10 shadow-sm"
                    style={{
                        left: `${percentage}%`,
                        backgroundColor: color,
                        boxShadow: `0 0 4px ${color}`
                    }}
                />
            </div>
            {/* Min/Max Labels (faint) */}
            <div className="flex justify-between text-[8px] text-text-tertiary/30 mt-0.5 px-0.5">
                <span>{min}°</span>
                <span>{max}°</span>
            </div>
        </div>
    );
}
