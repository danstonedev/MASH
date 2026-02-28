/**
 * Comparison View
 * ===============
 * 
 * Side-by-side comparison of two events with:
 * - Dual 3D viewports (synchronized or independent)
 * - Event metrics charts
 * - Playback controls
 */

import { useEffect, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, PerspectiveCamera } from '@react-three/drei';
import {
    Play, Pause, SkipBack, Link2, Unlink2,
    ArrowLeftRight, X, ZoomIn
} from 'lucide-react';
import { useComparisonStore, type ComparisonSegment } from '../../store/useComparisonStore';
import { useTimelineStore } from '../../store/useTimelineStore';
import { cn } from '../../lib/utils';

// ============================================================================
// HELPERS
// ============================================================================

function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const sec = totalSec % 60;
    const cs = Math.floor((ms % 1000) / 10);
    return `${sec}.${cs.toString().padStart(2, '0')}`;
}

// ============================================================================
// MINI 3D VIEWPORT
// ============================================================================

interface MiniViewportProps {
    segment: ComparisonSegment | null;
    label: 'A' | 'B';
    color: string;
}

function MiniViewport({ segment, label, color }: MiniViewportProps) {
    if (!segment) {
        return (
            <div className={`flex items-center justify-center h-full bg-bg-elevated border-2 border-dashed rounded-lg ${color === 'yellow' ? 'border-yellow-500/30' : 'border-cyan-500/30'}`}>
                <span className="text-text-secondary text-sm">
                    Select event {label}
                </span>
            </div>
        );
    }

    return (
        <div className="relative h-full rounded-lg overflow-hidden">
            <Canvas
                gl={{ antialias: true, alpha: true }}
                dpr={[1, 2]}
            >
                <PerspectiveCamera makeDefault position={[0, 1.5, 3]} fov={50} />
                <OrbitControls
                    enablePan={false}
                    minDistance={1.5}
                    maxDistance={5}
                    target={[0, 0.9, 0]}
                />

                {/* Lighting */}
                <ambientLight intensity={0.4} />
                <directionalLight position={[5, 5, 5]} intensity={0.8} />

                {/* Ground grid */}
                <Grid
                    args={[10, 10]}
                    position={[0, 0, 0]}
                    cellColor="#333"
                    sectionColor="#555"
                />

                {/* Placeholder skeleton - in real implementation, would render actual skeleton */}
                <mesh position={[0, 0.9, 0]}>
                    <capsuleGeometry args={[0.15, 1, 8, 16]} />
                    <meshStandardMaterial color={color === 'yellow' ? '#F59E0B' : '#06B6D4'} />
                </mesh>

                {/* Event indicator */}
                <mesh position={[0, 0.1, 0]}>
                    <ringGeometry args={[0.4, 0.5, 32]} />
                    <meshBasicMaterial color={color === 'yellow' ? '#F59E0B' : '#06B6D4'} opacity={0.5} transparent />
                </mesh>
            </Canvas>

            {/* Overlay info */}
            <div className={`absolute top-2 left-2 px-2 py-1 rounded text-xs font-bold ${color === 'yellow' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-cyan-500/20 text-cyan-400'}`}>
                {label}
            </div>
            <div className="absolute bottom-2 left-2 right-2 text-[10px] text-white bg-black/50 rounded px-2 py-1">
                <div className="flex justify-between">
                    <span>{segment.eventType}</span>
                    <span>{formatTime(segment.currentTime)} / {formatTime(segment.duration)}</span>
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// SEGMENT CONTROLS
// ============================================================================

interface SegmentControlsProps {
    segment: ComparisonSegment | null;
    label: 'A' | 'B';
    onPlay: () => void;
    onPause: () => void;
    onSeek: (time: number) => void;
    onUnload: () => void;
}

function SegmentControls({ segment, label, onPlay, onPause, onSeek, onUnload }: SegmentControlsProps) {
    if (!segment) return null;

    const progress = segment.duration > 0 ? segment.currentTime / segment.duration : 0;

    return (
        <div className="flex items-center gap-2 p-2 bg-bg-elevated rounded-lg">
            {/* Play/Pause */}
            <button
                onClick={segment.isPlaying ? onPause : onPlay}
                className="p-1.5 rounded hover:bg-white/10"
            >
                {segment.isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>

            {/* Reset */}
            <button
                onClick={() => onSeek(0)}
                className="p-1.5 rounded hover:bg-white/10"
            >
                <SkipBack className="w-3 h-3" />
            </button>

            {/* Timeline */}
            <div
                className="flex-1 h-2 bg-bg-surface rounded cursor-pointer"
                onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const percent = (e.clientX - rect.left) / rect.width;
                    onSeek(segment.duration * percent);
                }}
            >
                <div
                    className={`h-full rounded ${label === 'A' ? 'bg-yellow-500' : 'bg-cyan-500'}`}
                    style={{ width: `${progress * 100}%` }}
                />
            </div>

            {/* Time */}
            <span className="text-[10px] text-text-secondary font-mono w-16 text-right">
                {formatTime(segment.currentTime)}
            </span>

            {/* Close */}
            <button
                onClick={onUnload}
                className="p-1 rounded hover:bg-white/10 text-text-secondary hover:text-red-400"
            >
                <X className="w-3 h-3" />
            </button>
        </div>
    );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function ComparisonView() {
    const segmentA = useComparisonStore(state => state.segmentA);
    const segmentB = useComparisonStore(state => state.segmentB);
    const isSynced = useComparisonStore(state => state.isSynced);

    const playA = useComparisonStore(state => state.playA);
    const pauseA = useComparisonStore(state => state.pauseA);
    const playB = useComparisonStore(state => state.playB);
    const pauseB = useComparisonStore(state => state.pauseB);
    const playBoth = useComparisonStore(state => state.playBoth);
    const pauseBoth = useComparisonStore(state => state.pauseBoth);
    const seekA = useComparisonStore(state => state.seekA);
    const seekB = useComparisonStore(state => state.seekB);
    const seekBoth = useComparisonStore(state => state.seekBoth);
    const unloadA = useComparisonStore(state => state.unloadA);
    const unloadB = useComparisonStore(state => state.unloadB);
    const swapSegments = useComparisonStore(state => state.swapSegments);
    const toggleSync = useComparisonStore(state => state.toggleSync);
    const tick = useComparisonStore(state => state.tick);

    const comparison = useTimelineStore(state => state.comparison);
    const loadEventA = useComparisonStore(state => state.loadEventA);
    const loadEventB = useComparisonStore(state => state.loadEventB);

    const lastTimeRef = useRef<number>(0);
    const animationRef = useRef<number | null>(null);

    // Animation loop
    useEffect(() => {
        const animate = (time: number) => {
            const delta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0;
            lastTimeRef.current = time;
            tick(delta);
            animationRef.current = requestAnimationFrame(animate);
        };

        if (segmentA?.isPlaying || segmentB?.isPlaying) {
            lastTimeRef.current = 0;
            animationRef.current = requestAnimationFrame(animate);
        }

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        };
    }, [segmentA?.isPlaying, segmentB?.isPlaying, tick]);

    // Auto-load from timeline comparison selection
    useEffect(() => {
        if (comparison.eventA && !segmentA) {
            loadEventA(comparison.eventA);
        }
        if (comparison.eventB && !segmentB) {
            loadEventB(comparison.eventB);
        }
    }, [comparison.eventA, comparison.eventB, segmentA, segmentB, loadEventA, loadEventB]);

    const hasAny = segmentA || segmentB;
    const hasBoth = segmentA && segmentB;

    if (!hasAny) {
        return (
            <div className="flex flex-col items-center justify-center h-full p-8 text-center">
                <ZoomIn className="w-12 h-12 text-text-secondary/30 mb-4" />
                <h3 className="text-lg font-semibold mb-2">Event Comparison</h3>
                <p className="text-sm text-text-secondary max-w-sm">
                    Select two events in the timeline to compare them side-by-side with synchronized 3D playback.
                </p>
                <p className="text-xs text-text-secondary mt-4">
                    Click events and use the A/B buttons to select
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-bg-surface">
            {/* Top controls */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
                <span className="text-sm font-medium">Event Comparison</span>

                <div className="flex items-center gap-2">
                    {/* Sync toggle */}
                    <button
                        onClick={toggleSync}
                        className={cn(
                            "flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors",
                            isSynced ? "bg-accent/20 text-accent" : "bg-white/5 text-text-secondary"
                        )}
                    >
                        {isSynced ? <Link2 className="w-3 h-3" /> : <Unlink2 className="w-3 h-3" />}
                        {isSynced ? 'Synced' : 'Independent'}
                    </button>

                    {/* Swap */}
                    {hasBoth && (
                        <button
                            onClick={swapSegments}
                            className="p-1.5 rounded hover:bg-white/10 text-text-secondary"
                            title="Swap A and B"
                        >
                            <ArrowLeftRight className="w-4 h-4" />
                        </button>
                    )}

                    {/* Play both */}
                    {hasBoth && (
                        <button
                            onClick={(segmentA?.isPlaying && segmentB?.isPlaying) ? pauseBoth : playBoth}
                            className="flex items-center gap-1 px-3 py-1.5 bg-accent text-white rounded text-xs"
                        >
                            {(segmentA?.isPlaying && segmentB?.isPlaying)
                                ? <><Pause className="w-3 h-3" /> Pause All</>
                                : <><Play className="w-3 h-3" /> Play Both</>
                            }
                        </button>
                    )}
                </div>
            </div>

            {/* Main content: 2x2 grid */}
            <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-2 p-2">
                {/* Event A - Top row */}
                <div className="flex flex-col gap-2">
                    <SegmentControls
                        segment={segmentA}
                        label="A"
                        onPlay={playA}
                        onPause={pauseA}
                        onSeek={seekA}
                        onUnload={unloadA}
                    />
                    {/* Could add event metrics chart here */}
                </div>
                <div className="row-span-1">
                    <MiniViewport segment={segmentA} label="A" color="yellow" />
                </div>

                {/* Event B - Bottom row */}
                <div className="flex flex-col gap-2">
                    <SegmentControls
                        segment={segmentB}
                        label="B"
                        onPlay={playB}
                        onPause={pauseB}
                        onSeek={seekB}
                        onUnload={unloadB}
                    />
                    {/* Could add event metrics chart here */}
                </div>
                <div className="row-span-1">
                    <MiniViewport segment={segmentB} label="B" color="cyan" />
                </div>
            </div>

            {/* Metrics comparison footer */}
            {hasBoth && segmentA && segmentB && (
                <div className="px-4 py-2 border-t border-border bg-bg-elevated">
                    <div className="grid grid-cols-3 gap-4 text-center text-[10px]">
                        <div>
                            <p className="text-text-secondary">Duration</p>
                            <p className="font-mono">
                                <span className="text-yellow-400">{formatTime(segmentA.duration)}</span>
                                {' vs '}
                                <span className="text-cyan-400">{formatTime(segmentB.duration)}</span>
                            </p>
                        </div>
                        <div>
                            <p className="text-text-secondary">Δ Duration</p>
                            <p className="font-mono text-accent">
                                {((segmentB.duration - segmentA.duration) / 1000).toFixed(2)}s
                            </p>
                        </div>
                        <div>
                            <p className="text-text-secondary">Event Type</p>
                            <p>
                                <span className="text-yellow-400">{segmentA.eventType}</span>
                                {' / '}
                                <span className="text-cyan-400">{segmentB.eventType}</span>
                            </p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
