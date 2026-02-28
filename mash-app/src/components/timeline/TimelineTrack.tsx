/**
 * Timeline Track Component
 * ========================
 * 
 * Renders a single track in the timeline:
 * - Activity segments as colored bars
 * - Event markers (dots, spikes, bars)
 * - Annotations with labels
 * - Selection highlighting
 */

import { useMemo, useCallback } from 'react';
import { ChevronDown, ChevronRight, Tag, MessageSquare } from 'lucide-react';
import { useTimelineStore, type TimelineEvent, type TrackType } from '../../store/useTimelineStore';
import { cn } from '../../lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface TimelineTrackProps {
    trackId: TrackType;
    width: number;
    height?: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function TimelineTrack({ trackId, width, height = 40 }: TimelineTrackProps) {
    const track = useTimelineStore(state => state.tracks.get(trackId));
    const viewStart = useTimelineStore(state => state.viewStart);
    const viewEnd = useTimelineStore(state => state.viewEnd);
    const selectedEvents = useTimelineStore(state => state.selectedEvents);
    const comparison = useTimelineStore(state => state.comparison);
    const selectEvent = useTimelineStore(state => state.selectEvent);
    const setTrackCollapsed = useTimelineStore(state => state.setTrackCollapsed);

    // Calculate visible events
    const visibleEvents = useMemo(() => {
        if (!track) return [];
        const range = viewEnd - viewStart;
        if (range <= 0) return [];

        return track.events.filter(event => {
            const end = event.endTime || event.startTime;
            return event.startTime <= viewEnd && end >= viewStart;
        });
    }, [track, viewStart, viewEnd]);

    // Convert time to X position
    const timeToX = useCallback((time: number): number => {
        const range = viewEnd - viewStart;
        if (range <= 0) return 0;
        return ((time - viewStart) / range) * width;
    }, [viewStart, viewEnd, width]);

    // Handle event click
    const handleEventClick = useCallback((event: TimelineEvent, e: React.MouseEvent) => {
        e.stopPropagation();
        selectEvent(event.id, e.shiftKey);
    }, [selectEvent]);

    if (!track || !track.visible) return null;

    const isCollapsed = track.collapsed;
    const displayHeight = isCollapsed ? 24 : height;

    return (
        <div
            className="relative border-b border-border/50 group"
            style={{ height: displayHeight }}
        >
            {/* Track header */}
            <div
                className="absolute left-0 top-0 w-24 h-full flex items-center gap-1 px-2 bg-bg-surface/80 backdrop-blur-sm z-10 cursor-pointer border-r border-border/30"
                onClick={() => setTrackCollapsed(trackId, !isCollapsed)}
            >
                {isCollapsed ? (
                    <ChevronRight className="w-3 h-3 text-text-secondary" />
                ) : (
                    <ChevronDown className="w-3 h-3 text-text-secondary" />
                )}
                <span
                    className="text-[10px] font-medium truncate"
                    style={{ color: track.color }}
                >
                    {track.name}
                </span>
            </div>

            {/* Event container */}
            <div
                className="absolute left-24 right-0 top-0 h-full overflow-hidden"
                style={{ width: width - 96 }}
            >
                {!isCollapsed && visibleEvents.map(event => {
                    const isSelected = selectedEvents.has(event.id);
                    const isCompareA = comparison.eventA === event.id;
                    const isCompareB = comparison.eventB === event.id;

                    const x = timeToX(event.startTime);
                    const eventWidth = event.endTime
                        ? Math.max(2, timeToX(event.endTime) - x)
                        : 8;

                    // Determine render style based on track type
                    if (event.endTime) {
                        // Segment (activity, skate phases)
                        return (
                            <div
                                key={event.id}
                                onClick={(e) => handleEventClick(event, e)}
                                className={cn(
                                    "absolute top-1 bottom-1 rounded-sm cursor-pointer transition-all",
                                    "hover:brightness-110",
                                    isSelected && "ring-2 ring-white",
                                    isCompareA && "ring-2 ring-yellow-400",
                                    isCompareB && "ring-2 ring-cyan-400"
                                )}
                                style={{
                                    left: x,
                                    width: eventWidth,
                                    backgroundColor: track.color + '80',
                                    borderLeft: `2px solid ${track.color}`,
                                }}
                                title={`${event.type} (${formatTime(event.startTime)} - ${formatTime(event.endTime)})`}
                            >
                                {eventWidth > 50 && (
                                    <span className="text-[8px] text-white px-1 truncate">
                                        {event.type}
                                    </span>
                                )}
                                {event.annotation && (
                                    <Tag className="absolute top-0 right-0 w-2 h-2 text-yellow-400" />
                                )}
                            </div>
                        );
                    } else {
                        // Point event (gait, jump)
                        const dotSize = event.value ? Math.min(16, 6 + event.value / 5) : 8;

                        return (
                            <div
                                key={event.id}
                                onClick={(e) => handleEventClick(event, e)}
                                className={cn(
                                    "absolute rounded-full cursor-pointer transition-all hover:scale-125",
                                    isSelected && "ring-2 ring-white",
                                    isCompareA && "ring-2 ring-yellow-400",
                                    isCompareB && "ring-2 ring-cyan-400",
                                    event.foot === 'left' ? "top-1" : event.foot === 'right' ? "bottom-1" : "top-1/2 -translate-y-1/2"
                                )}
                                style={{
                                    left: x - dotSize / 2,
                                    width: dotSize,
                                    height: dotSize,
                                    backgroundColor: event.foot === 'left'
                                        ? '#EF4444' // Red for left
                                        : event.foot === 'right'
                                            ? '#3B82F6' // Blue for right
                                            : track.color,
                                }}
                                title={`${event.type}${event.value ? ` (${event.value.toFixed(1)})` : ''} @ ${formatTime(event.startTime)}`}
                            >
                                {event.annotation && (
                                    <MessageSquare className="absolute -top-1 -right-1 w-2 h-2 text-yellow-400" />
                                )}
                            </div>
                        );
                    }
                })}

                {/* Event count when collapsed */}
                {isCollapsed && (
                    <div className="flex items-center h-full px-2">
                        <span className="text-[9px] text-text-secondary">
                            {track.events.length} events
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}
