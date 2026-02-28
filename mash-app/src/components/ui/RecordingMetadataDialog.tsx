/**
 * Recording Metadata Dialog
 * =========================
 * 
 * Modal dialog shown after stopping a recording.
 * Allows user to edit session title, athlete, activity type, and notes
 * before the session is finalized and saved to the database.
 */

import { useState, useEffect } from 'react';
import { X, Save, Trash2, User, Tag, FileText, Activity } from 'lucide-react';
import { useAthleteStore } from '../../store/useAthleteStore';

interface RecordingMetadataDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (metadata: SessionMetadata) => void;
    onDiscard: () => void;
    initialData: {
        name: string;
        athleteId?: string;
        duration: number;
        frameCount: number;
        sensorCount: number;
    };
}

export interface SessionMetadata {
    name: string;
    athleteId: string | null;
    activityType: string;
    notes: string;
}

const ACTIVITY_TYPES = [
    { value: 'speed_skating', label: 'Speed Skating' },
    { value: 'hockey', label: 'Ice Hockey' },
    { value: 'running', label: 'Running' },
    { value: 'walking', label: 'Walking' },
    { value: 'cycling', label: 'Cycling' },
    { value: 'general', label: 'General Movement' },
    { value: 'rehabilitation', label: 'Rehabilitation' },
    { value: 'research', label: 'Research Trial' },
];

export function RecordingMetadataDialog({
    isOpen,
    onClose,
    onSave,
    onDiscard,
    initialData
}: RecordingMetadataDialogProps) {
    const [name, setName] = useState(initialData.name);
    const [athleteId, setAthleteId] = useState(initialData.athleteId || '');
    const [activityType, setActivityType] = useState('general');
    const [notes, setNotes] = useState('');

    const athletes = useAthleteStore(state => state.athletes);
    const athleteList = Array.from(athletes.values());

    // Reset form when opened with new data
    useEffect(() => {
        if (isOpen) {
            setName(initialData.name);
            setAthleteId(initialData.athleteId || '');
            setActivityType('general');
            setNotes('');
        }
    }, [isOpen, initialData]);

    const formatDuration = (ms: number) => {
        const seconds = ms / 1000;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}:${remainingSeconds.toFixed(2).padStart(5, '0')}`;
    };

    const handleSave = () => {
        onSave({
            name: name.trim() || initialData.name,
            athleteId: athleteId || null,
            activityType,
            notes: notes.trim()
        });
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/70 backdrop-blur-sm"
                onClick={onClose}
            />

            {/* Dialog */}
            <div className="relative w-full max-w-md mx-4 bg-[#1a1b26] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-white/5">
                    <div className="flex items-center gap-2">
                        <Save className="w-5 h-5 text-accent" />
                        <h2 className="text-lg font-semibold text-white">Save Recording</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 text-white/40 hover:text-white hover:bg-white/10 rounded-full transition-all"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-5 space-y-4">
                    {/* Session Title */}
                    <div className="space-y-1.5">
                        <label className="flex items-center gap-1.5 text-xs text-white/60 font-medium">
                            <FileText className="w-3.5 h-3.5" />
                            Session Title
                        </label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Enter session name"
                            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none transition-colors"
                        />
                    </div>

                    {/* Athlete Selection */}
                    <div className="space-y-1.5">
                        <label className="flex items-center gap-1.5 text-xs text-white/60 font-medium">
                            <User className="w-3.5 h-3.5" />
                            Athlete
                        </label>
                        <select
                            value={athleteId}
                            onChange={(e) => setAthleteId(e.target.value)}
                            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:border-accent focus:outline-none transition-colors [&>option]:bg-[#1a1a1a] [&>option]:text-white"
                        >
                            <option value="">No athlete (anonymous)</option>
                            {athleteList.map(a => (
                                <option key={a.id} value={a.id}>
                                    {a.firstName} {a.lastName} ({a.sport === 'speed_skating' ? 'Skating' : 'Hockey'})
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Activity Type */}
                    <div className="space-y-1.5">
                        <label className="flex items-center gap-1.5 text-xs text-white/60 font-medium">
                            <Activity className="w-3.5 h-3.5" />
                            Activity Type
                        </label>
                        <select
                            value={activityType}
                            onChange={(e) => setActivityType(e.target.value)}
                            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:border-accent focus:outline-none transition-colors [&>option]:bg-[#1a1a1a] [&>option]:text-white"
                        >
                            {ACTIVITY_TYPES.map(type => (
                                <option key={type.value} value={type.value}>
                                    {type.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Notes */}
                    <div className="space-y-1.5">
                        <label className="flex items-center gap-1.5 text-xs text-white/60 font-medium">
                            <Tag className="w-3.5 h-3.5" />
                            Notes (optional)
                        </label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Add any notes about this session..."
                            rows={2}
                            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:border-accent focus:outline-none transition-colors resize-none"
                        />
                    </div>

                    {/* Session Stats */}
                    <div className="grid grid-cols-3 gap-3 p-3 bg-white/5 rounded-lg border border-white/5">
                        <div className="text-center">
                            <div className="text-lg font-bold text-accent">{formatDuration(initialData.duration)}</div>
                            <div className="text-[9px] text-white/40 uppercase">Duration</div>
                        </div>
                        <div className="text-center">
                            <div className="text-lg font-bold text-white">{initialData.frameCount.toLocaleString()}</div>
                            <div className="text-[9px] text-white/40 uppercase">Frames</div>
                        </div>
                        <div className="text-center">
                            <div className="text-lg font-bold text-white">{initialData.sensorCount}</div>
                            <div className="text-[9px] text-white/40 uppercase">Sensors</div>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-5 py-4 border-t border-white/10 bg-white/5">
                    <button
                        onClick={onDiscard}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
                    >
                        <Trash2 className="w-4 h-4" />
                        Discard
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex items-center gap-1.5 px-6 py-2 text-sm font-medium text-white bg-accent hover:bg-accent/80 rounded-lg transition-colors"
                    >
                        <Save className="w-4 h-4" />
                        Save Session
                    </button>
                </div>
            </div>
        </div>
    );
}
