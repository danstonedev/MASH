/**
 * Event Annotation Panel
 * ======================
 * 
 * Panel for annotating selected timeline events:
 * - Add labels and notes
 * - Add/remove tags
 * - View event details
 * - Compare two events side-by-side
 */

import { useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
    Tag, MessageSquare, X, Plus, Check,
    Copy, Diff, Trash2
} from 'lucide-react';
import {
    useTimelineStore,
    type TimelineAnnotation,
    type TimelineEvent
} from '../../store/useTimelineStore';
import { cn } from '../../lib/utils';;

// ... helpers ...

function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const cs = Math.floor((ms % 1000) / 10);
    return `${min}:${sec.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}

function generateId(): string {
    return Math.random().toString(36).substring(2, 9);
}

// ============================================================================
// COMPONENT
// ============================================================================

export function EventAnnotationPanel() {
    // Use useShallow to prevent infinite loops (getSelectedEvents returns new array)
    const selectedEvents = useTimelineStore(useShallow(state => state.getSelectedEvents()));
    const comparison = useTimelineStore(useShallow(state => state.comparison));

    // Select comparison events directly (returns [eventA, eventB])
    const [eventA, eventB] = useTimelineStore(useShallow(state => state.getComparisonEvents()));

    const annotateEvent = useTimelineStore(state => state.annotateEvent);
    const removeAnnotation = useTimelineStore(state => state.removeAnnotation);
    const setCompareA = useTimelineStore(state => state.setCompareA);
    const setCompareB = useTimelineStore(state => state.setCompareB);
    const clearComparison = useTimelineStore(state => state.clearComparison);
    const clearSelection = useTimelineStore(state => state.clearSelection);

    const [newTag, setNewTag] = useState('');
    const [editingEvent, setEditingEvent] = useState<string | null>(null);
    const [editLabel, setEditLabel] = useState('');
    const [editNotes, setEditNotes] = useState('');

    // Start editing an event
    const startEdit = useCallback((event: TimelineEvent) => {
        setEditingEvent(event.id);
        setEditLabel(event.annotation?.label || '');
        setEditNotes(event.annotation?.notes || '');
    }, []);

    // Save annotation
    const saveAnnotation = useCallback(() => {
        if (!editingEvent) return;

        const event = selectedEvents.find(e => e.id === editingEvent);
        const existingTags = event?.annotation?.tags || [];

        const annotation: TimelineAnnotation = {
            id: event?.annotation?.id || generateId(),
            label: editLabel,
            notes: editNotes,
            tags: existingTags,
            createdAt: event?.annotation?.createdAt || Date.now(),
        };

        annotateEvent(editingEvent, annotation);
        setEditingEvent(null);
    }, [editingEvent, editLabel, editNotes, selectedEvents, annotateEvent]);

    // Add tag to event
    const addTag = useCallback((eventId: string) => {
        if (!newTag.trim()) return;

        const event = selectedEvents.find(e => e.id === eventId);
        if (!event) return;

        const existingTags = event.annotation?.tags || [];
        if (existingTags.includes(newTag)) return;

        const annotation: TimelineAnnotation = {
            id: event.annotation?.id || generateId(),
            label: event.annotation?.label || '',
            notes: event.annotation?.notes || '',
            tags: [...existingTags, newTag.trim()],
            createdAt: event.annotation?.createdAt || Date.now(),
        };

        annotateEvent(eventId, annotation);
        setNewTag('');
    }, [newTag, selectedEvents, annotateEvent]);

    // Remove tag
    const removeTag = useCallback((eventId: string, tag: string) => {
        const event = selectedEvents.find(e => e.id === eventId);
        if (!event || !event.annotation) return;

        const annotation: TimelineAnnotation = {
            ...event.annotation,
            tags: event.annotation.tags.filter(t => t !== tag),
        };

        annotateEvent(eventId, annotation);
    }, [selectedEvents, annotateEvent]);

    if (selectedEvents.length === 0 && !eventA && !eventB) {
        return (
            <div className="p-4 text-center text-text-secondary text-xs">
                <p>Select events to annotate</p>
                <p className="mt-1 text-[10px]">Click on events in timeline</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3 p-3 bg-bg-surface rounded-lg border border-border">
            {/* Selected events */}
            {selectedEvents.map(event => (
                <div
                    key={event.id}
                    className="bg-bg-elevated rounded p-2 border border-border/50"
                >
                    {/* Event header */}
                    <div className="flex items-center justify-between mb-2">
                        <div>
                            <span className="text-xs font-medium">{event.type}</span>
                            <span className="text-[10px] text-text-secondary ml-2">
                                @ {formatTime(event.startTime)}
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => setCompareA(event.id)}
                                className={cn(
                                    "p-1 rounded text-[10px]",
                                    comparison.eventA === event.id
                                        ? "bg-yellow-500/20 text-yellow-400"
                                        : "hover:bg-white/10"
                                )}
                                title="Set as Compare A"
                            >
                                A
                            </button>
                            <button
                                onClick={() => setCompareB(event.id)}
                                className={cn(
                                    "p-1 rounded text-[10px]",
                                    comparison.eventB === event.id
                                        ? "bg-cyan-500/20 text-cyan-400"
                                        : "hover:bg-white/10"
                                )}
                                title="Set as Compare B"
                            >
                                B
                            </button>
                        </div>
                    </div>

                    {/* Annotation editing */}
                    {editingEvent === event.id ? (
                        <div className="space-y-2">
                            <input
                                type="text"
                                value={editLabel}
                                onChange={e => setEditLabel(e.target.value)}
                                placeholder="Label..."
                                className="w-full px-2 py-1 text-xs bg-bg-surface rounded border border-border"
                            />
                            <textarea
                                value={editNotes}
                                onChange={e => setEditNotes(e.target.value)}
                                placeholder="Notes..."
                                className="w-full px-2 py-1 text-xs bg-bg-surface rounded border border-border resize-none"
                                rows={2}
                            />
                            <div className="flex gap-1">
                                <button
                                    onClick={saveAnnotation}
                                    className="flex items-center gap-1 px-2 py-1 text-[10px] bg-accent rounded hover:bg-accent/80"
                                >
                                    <Check className="w-3 h-3" /> Save
                                </button>
                                <button
                                    onClick={() => setEditingEvent(null)}
                                    className="flex items-center gap-1 px-2 py-1 text-[10px] bg-white/10 rounded hover:bg-white/20"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div>
                            {event.annotation ? (
                                <div className="space-y-1">
                                    {event.annotation.label && (
                                        <p className="text-xs font-medium text-accent">
                                            {event.annotation.label}
                                        </p>
                                    )}
                                    {event.annotation.notes && (
                                        <p className="text-[10px] text-text-secondary">
                                            {event.annotation.notes}
                                        </p>
                                    )}
                                </div>
                            ) : null}
                            <button
                                onClick={() => startEdit(event)}
                                className="mt-2 flex items-center gap-1 text-[10px] text-text-secondary hover:text-text-primary"
                            >
                                <MessageSquare className="w-3 h-3" />
                                {event.annotation ? 'Edit' : 'Add'} annotation
                            </button>
                        </div>
                    )}

                    {/* Tags */}
                    <div className="flex flex-wrap items-center gap-1 mt-2">
                        {event.annotation?.tags?.map(tag => (
                            <span
                                key={tag}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] bg-accent/20 text-accent rounded"
                            >
                                <Tag className="w-2 h-2" />
                                {tag}
                                <button
                                    onClick={() => removeTag(event.id, tag)}
                                    className="ml-0.5 hover:text-red-400"
                                >
                                    <X className="w-2 h-2" />
                                </button>
                            </span>
                        ))}
                        <div className="flex items-center gap-0.5">
                            <input
                                type="text"
                                value={newTag}
                                onChange={e => setNewTag(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && addTag(event.id)}
                                placeholder="+ tag"
                                className="w-12 px-1 py-0.5 text-[9px] bg-transparent border-b border-border/50 focus:border-accent outline-none"
                            />
                            <button
                                onClick={() => addTag(event.id)}
                                className="p-0.5 text-text-secondary hover:text-accent"
                            >
                                <Plus className="w-2 h-2" />
                            </button>
                        </div>
                    </div>

                    {/* Event metrics */}
                    {event.value !== undefined && (
                        <div className="mt-2 text-[10px] text-text-secondary">
                            Value: <span className="text-text-primary">{event.value.toFixed(2)}</span>
                        </div>
                    )}
                </div>
            ))}

            {/* Comparison view */}
            {(eventA || eventB) && (
                <div className="border-t border-border pt-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium flex items-center gap-1">
                            <Diff className="w-3 h-3" /> Comparison
                        </span>
                        <button
                            onClick={clearComparison}
                            className="text-[10px] text-text-secondary hover:text-red-400"
                        >
                            Clear
                        </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                        <div className={cn("p-2 rounded border", eventA ? "border-yellow-500/50 bg-yellow-500/10" : "border-border/50")}>
                            <span className="text-yellow-400 font-medium">A:</span>
                            {eventA ? (
                                <div className="mt-1">
                                    <p>{eventA.type}</p>
                                    <p className="text-text-secondary">{formatTime(eventA.startTime)}</p>
                                    {eventA.value !== undefined && <p>Value: {eventA.value.toFixed(2)}</p>}
                                </div>
                            ) : <p className="text-text-secondary">Not set</p>}
                        </div>
                        <div className={cn("p-2 rounded border", eventB ? "border-cyan-500/50 bg-cyan-500/10" : "border-border/50")}>
                            <span className="text-cyan-400 font-medium">B:</span>
                            {eventB ? (
                                <div className="mt-1">
                                    <p>{eventB.type}</p>
                                    <p className="text-text-secondary">{formatTime(eventB.startTime)}</p>
                                    {eventB.value !== undefined && <p>Value: {eventB.value.toFixed(2)}</p>}
                                </div>
                            ) : <p className="text-text-secondary">Not set</p>}
                        </div>
                    </div>

                    {/* Comparison metrics */}
                    {eventA && eventB && eventA.value !== undefined && eventB.value !== undefined && (
                        <div className="mt-2 p-2 bg-bg-elevated rounded text-[10px]">
                            <p>Δ Value: <span className="text-accent">{(eventB.value - eventA.value).toFixed(2)}</span></p>
                            <p>Δ Time: <span className="text-accent">{((eventB.startTime - eventA.startTime) / 1000).toFixed(2)}s</span></p>
                        </div>
                    )}
                </div>
            )}

            {/* Footer actions */}
            {selectedEvents.length > 0 && (
                <div className="flex justify-end">
                    <button
                        onClick={clearSelection}
                        className="text-[10px] text-text-secondary hover:text-text-primary"
                    >
                        Clear selection
                    </button>
                </div>
            )}
        </div>
    );
}
