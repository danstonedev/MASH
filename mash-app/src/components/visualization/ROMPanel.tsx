import { Activity, RotateCcw, Play, Square } from 'lucide-react';
import { Button } from '../ui/Button';
import { useJointAnglesStore } from '../../store/useJointAnglesStore';
import { JOINT_DEFINITIONS, formatAngle } from '../../biomech/jointAngles';

export function ROMPanel() {
    const { jointData, isTracking, startTracking, stopTracking, resetMinMax } = useJointAnglesStore();


    // KinematicsEngine now drives the updates globally.
    // This panel only visualizes the data from the store.
    // The Play/Pause buttons toggle the store's isTracking state, 
    // which gates the updates in the store.

    // Get joint IDs to display (only show joints we have data for)
    const activeJoints = Array.from(jointData.keys());

    return (
        <div className="bg-bg-surface rounded-lg border border-border overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-2 border-b border-border">
                <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-accent" />
                    <span className="text-sm font-semibold text-text-primary">Joint Angles</span>
                    {isTracking && (
                        <span className="text-xs text-success animate-pulse">● LIVE</span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    {!isTracking ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-success"
                            onClick={startTracking}
                        >
                            <Play className="h-3 w-3" />
                        </Button>
                    ) : (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-danger"
                            onClick={stopTracking}
                        >
                            <Square className="h-3 w-3" />
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-text-secondary"
                        onClick={resetMinMax}
                        title="Reset"
                    >
                        <RotateCcw className="h-3 w-3" />
                    </Button>
                </div>
            </div>

            {/* Joint Angles - Compact 3-plane display */}
            <div className="p-2 space-y-1 max-h-72 overflow-y-auto text-xs">
                {activeJoints.length === 0 ? (
                    <p className="text-text-secondary text-center py-2">
                        Start simulator or animation
                    </p>
                ) : (
                    activeJoints.map(jointId => {
                        const data = jointData.get(jointId);
                        const def = JOINT_DEFINITIONS[jointId];
                        if (!data || !def) return null;

                        return (
                            <div key={jointId} className="bg-bg-elevated rounded p-2">
                                <div className="font-medium text-text-primary mb-1">{def.name}</div>
                                <div className="grid grid-cols-3 gap-2 text-[11px]">
                                    {/* Sagittal - Flexion/Extension (Red/X-axis) */}
                                    <div className="text-center">
                                        <div className="text-text-secondary truncate">{def.flexionName.split('/')[0]}</div>
                                        <div className="font-mono text-sm" style={{ color: '#EF4444' }}>{formatAngle(data.current.flexion)}</div>
                                    </div>
                                    {/* Frontal - Abduction/Adduction (Green/Y-axis) */}
                                    <div className="text-center">
                                        <div className="text-text-secondary truncate">{def.abductionName.split('/')[0]}</div>
                                        <div className="font-mono text-sm" style={{ color: '#10B981' }}>{formatAngle(data.current.abduction)}</div>
                                    </div>
                                    {/* Transverse - Rotation (Blue/Z-axis) */}
                                    <div className="text-center">
                                        <div className="text-text-secondary truncate">{def.rotationName.split('/')[0]}</div>
                                        <div className="font-mono text-sm" style={{ color: '#3B82F6' }}>{formatAngle(data.current.rotation)}</div>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
