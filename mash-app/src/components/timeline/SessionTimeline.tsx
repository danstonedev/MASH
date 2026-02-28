/**
 * Session Timeline Component
 * ==========================
 * 
 * Master timeline container:
 * - Renders all visible tracks
 * - Time ruler with markers
 * - Zoom/pan controls
 * - Playhead sync with playback
 * - Event comparison panel
 */

import { useEffect, useRef, useCallback } from 'react';
import {
    ZoomIn, ZoomOut, Maximize2, ChevronLeft, ChevronRight,
    Layers, Activity, Snowflake, Footprints, Dumbbell
} from 'lucide-react';
import {
    useTimelineStore,
    type TrackType,
    type SportMode,
} from '../../store/useTimelineStore';
import { usePlaybackStore } from '../../store/usePlaybackStore';
import { TimelineTrack } from './TimelineTrack';
import { cn } from '../../lib/utils';

// ============================================================================
// HELPERS
// ============================================================================

function formatTimeRuler(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ============================================================================
// SPORT MODE ICONS
// ============================================================================

const SPORT_MODE_ICONS: Record<SportMode, React.ReactNode> = {
    general: <Activity className="w-3 h-3" />,
    skating: <Snowflake className="w-3 h-3" />,
    running: <Footprints className="w-3 h-3" />,
    training: <Dumbbell className="w-3 h-3" />,
};

// ============================================================================
// COMPONENT
// ============================================================================

export function SessionTimeline() {
    const containerRef = useRef<HTMLDivElement>(null);

    // Timeline state
    const sessionId = useTimelineStore(state => state.sessionId);
    const sessionDuration = useTimelineStore(state => state.sessionDuration);
    const viewStart = useTimelineStore(state => state.viewStart);
    const viewEnd = useTimelineStore(state => state.viewEnd);
    const zoom = useTimelineStore(state => state.zoom);
    const tracks = useTimelineStore(state => state.tracks);
    const sportMode = useTimelineStore(state => state.sportMode);
    const comparison = useTimelineStore(state => state.comparison);

    // Actions
    const zoomIn = useTimelineStore(state => state.zoomIn);
    const zoomOut = useTimelineStore(state => state.zoomOut);
    const zoomToFit = useTimelineStore(state => state.zoomToFit);
    const panLeft = useTimelineStore(state => state.panLeft);
    const panRight = useTimelineStore(state => state.panRight);
    const setSportMode = useTimelineStore(state => state.setSportMode);
    const setViewRange = useTimelineStore(state => state.setViewRange);
    const getComparisonEvents = useTimelineStore(state => state.getComparisonEvents);

    // Playback sync
    const playbackTime = usePlaybackStore(state => state.currentTime);
    const isPlaying = usePlaybackStore(state => state.isPlaying);
    const seek = usePlaybackStore(state => state.seek);

    // Calculate container width
    const containerWidth = containerRef.current?.clientWidth || 600;
    const trackWidth = containerWidth - 24; // Account for padding

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            switch (e.key) {
                case '+':
                case '=':
                    e.preventDefault();
                    zoomIn();
                    break;
                case '-':
                case '_':
                    e.preventDefault();
                    zoomOut();
                    break;
                case '0':
                    e.preventDefault();
                    zoomToFit();
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [zoomIn, zoomOut, zoomToFit]);

    // Mouse wheel zoom
    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
                zoomIn();
            } else {
                zoomOut();
            }
        } else if (e.shiftKey) {
            // Horizontal scroll = pan
            e.preventDefault();
            if (e.deltaY < 0) {
                panLeft();
            } else {
                panRight();
            }
        }
    }, [zoomIn, zoomOut, panLeft, panRight]);

    // Click on timeline to seek
    const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left - 96; // Account for track header
        const percent = x / (rect.width - 96);
        const time = viewStart + (viewEnd - viewStart) * percent;
        seek(Math.max(0, Math.min(sessionDuration, time)));
    }, [viewStart, viewEnd, sessionDuration, seek]);

    // Calculate time ruler markers
    const viewRange = viewEnd - viewStart;
    const markerInterval = viewRange > 60000 ? 10000 : viewRange > 10000 ? 1000 : 100;
    const markers: number[] = [];
    let markerTime = Math.ceil(viewStart / markerInterval) * markerInterval;
    while (markerTime <= viewEnd) {
        markers.push(markerTime);
        markerTime += markerInterval;
    }

    // Playhead position
    const playheadX = sessionDuration > 0
        ? ((playbackTime - viewStart) / viewRange) * trackWidth
        : 0;
    const playheadVisible = playbackTime >= viewStart && playbackTime <= viewEnd;

    // Get visible tracks
    const visibleTracks = Array.from(tracks.entries())
        .filter(([_, track]) => track.visible)
        .map(([id]) => id);

    // Comparison events
    const [eventA, eventB] = getComparisonEvents();

    if (!sessionId) {
        return (
            <div className="p-4 text-center text-text-secondary">
                <p className="text-sm">No session loaded</p>
                <p className="text-xs mt-1">Load a session to view the timeline</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col bg-bg-surface rounded-lg border border-border overflow-hidden">
            {/* Header with controls */}
            <div className="flex items-center justify-between px-3 py-2 bg-bg-elevated border-b border-border">
                <div className="flex items-center gap-2">
                    <Layers className="w-4 h-4 text-accent" />
                    <span className="text-xs font-medium">Timeline</span>
                    <span className="text-[10px] text-text-secondary">
                        {formatTimeRuler(viewStart)} - {formatTimeRuler(viewEnd)}
                    </span>
                </div>

                <div className="flex items-center gap-1">
                    {/* Sport mode selector */}
                    <div className="flex items-center bg-bg-surface rounded border border-border/50">
                        {(['general', 'skating', 'running', 'training'] as SportMode[]).map(mode => (
                            <button
                                key={mode}
                                onClick={() => setSportMode(mode)}
                                className={cn(
                                    "p-1.5 transition-colors",
                                    sportMode === mode
                                        ? "bg-accent/20 text-accent"
                                        : "text-text-secondary hover:text-text-primary"
                                )}
                                title={mode.charAt(0).toUpperCase() + mode.slice(1)}
                            >
                                {SPORT_MODE_ICONS[mode]}
                            </button>
                        ))}
                    </div>

                    <div className="w-px h-4 bg-border mx-1" />

                    {/* Zoom controls */}
                    <button
                        onClick={panLeft}
                        className="p-1.5 text-text-secondary hover:text-text-primary"
                        title="Pan Left"
                    >
                        <ChevronLeft className="w-3 h-3" />
                    </button>
                    <button
                        onClick={zoomOut}
                        className="p-1.5 text-text-secondary hover:text-text-primary"
                        title="Zoom Out (-)"
                    >
                        <ZoomOut className="w-3 h-3" />
                    </button>
                    <span className="text-[10px] text-text-secondary w-10 text-center">
                        {zoom.toFixed(1)}x
                    </span>
                    <button
                        onClick={zoomIn}
                        className="p-1.5 text-text-secondary hover:text-text-primary"
                        title="Zoom In (+)"
                    >
                        <ZoomIn className="w-3 h-3" />
                    </button>
                    <button
                        onClick={zoomToFit}
                        className="p-1.5 text-text-secondary hover:text-text-primary"
                        title="Fit to View (0)"
                    >
                        <Maximize2 className="w-3 h-3" />
                    </button>
                    <button
                        onClick={panRight}
                        className="p-1.5 text-text-secondary hover:text-text-primary"
                        title="Pan Right"
                    >
                        <ChevronRight className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {/* Time ruler */}
            <div
                className="relative h-5 bg-bg-elevated/50 border-b border-border/30"
                style={{ marginLeft: 96 }}
            >
                {markers.map(time => {
                    const x = ((time - viewStart) / viewRange) * trackWidth;
                    return (
                        <div
                            key={time}
                            className="absolute top-0 flex flex-col items-center"
                            style={{ left: x }}
                        >
                            <div className="w-px h-2 bg-border" />
                            <span className="text-[8px] text-text-secondary">
                                {formatTimeRuler(time)}
                            </span>
                        </div>
                    );
                })}
            </div>

            {/* Tracks container */}
            <div
                ref={containerRef}
                className="relative"
                onClick={handleTimelineClick}
                onWheel={handleWheel}
            >
                {visibleTracks.map(trackId => (
                    <TimelineTrack
                        key={trackId}
                        trackId={trackId}
                        width={trackWidth}
                    />
                ))}

                {/* Playhead */}
                {playheadVisible && (
                    <div
                        className="absolute top-0 bottom-0 w-0.5 bg-accent pointer-events-none z-20"
                        style={{ left: 96 + playheadX }}
                    >
                        <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-accent rounded-full" />
                    </div>
                )}
            </div>

            {/* Footer with summary / comparison */}
            <div className="flex items-center justify-between px-3 py-2 bg-bg-elevated border-t border-border text-[10px] text-text-secondary">
                <span>
                    {visibleTracks.length} tracks • {
                        Array.from(tracks.values())
                            .filter(t => t.visible)
                            .reduce((sum, t) => sum + t.events.length, 0)
                    } events
                </span>

                {/* Comparison indicator */}
                {(comparison.eventA || comparison.eventB) && (
                    <div className="flex items-center gap-2">
                        <span>Compare:</span>
                        {eventA && (
                            <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                                A: {eventA.type}
                            </span>
                        )}
                        {eventB && (
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400">
                                B: {eventB.type}
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
