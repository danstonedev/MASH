/**
 * PlaybackOverlay - Floating playback controls at bottom of 3D viewport
 * Improved visual design with glassmorphism and better hierarchy
 */

import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Clock,
  RotateCcw,
  Repeat,
  X,
  RefreshCw,
} from "lucide-react";
import { useRef, useState, useMemo } from "react";
import { usePlaybackStore } from "../../store/usePlaybackStore";

export function PlaybackOverlay() {
  const sessionId = usePlaybackStore((state) => state.sessionId);
  const isPlaybackMode = usePlaybackStore((state) => !!state.sessionId); // Used to confirm mode
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const duration = usePlaybackStore((state) => state.duration);
  const playbackSpeed = usePlaybackStore((state) => state.playbackSpeed);
  const isLooping = usePlaybackStore((state) => state.isLooping);

  const play = usePlaybackStore((state) => state.play);
  const pause = usePlaybackStore((state) => state.pause);
  const seek = usePlaybackStore((state) => state.seek);
  const setSpeed = usePlaybackStore((state) => state.setSpeed);
  const toggleLooping = usePlaybackStore((state) => state.toggleLooping);
  const unloadSession = usePlaybackStore((state) => state.unloadSession);

  // State
  const [isDragging, setIsDragging] = useState(false);
  const progressBarRef = useRef<HTMLDivElement>(null);

  // Don't render if no session loaded
  if (!sessionId) return null;

  const formatTime = (ms: number) => {
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Detect "ended" state: paused at the end with loop off (YouTube-style replay)
  const isEnded =
    !isPlaying && !isLooping && duration > 0 && currentTime >= duration - 1;

  // Helper to calculate time from pointer position
  const getTimeFromPointer = (e: React.PointerEvent | PointerEvent) => {
    if (!progressBarRef.current) return 0;
    const rect = progressBarRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width)); // Clamp to bounds
    const percent = x / rect.width;
    return percent * duration;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); // Prevent text selection
    setIsDragging(true);

    // Pause while dragging for smooth seeking
    if (isPlaying) pause();

    // Immediate update to click position
    seek(getTimeFromPointer(e));

    // Capture pointer to handle dragging even outside the element
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    seek(getTimeFromPointer(e));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;

    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);

    // Intentionally keep paused (don't resume) to allow inspecting the selected frame
    // User must click play to resume
  };

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 w-[95%] max-w-xl">
      {/* Close / Return to Live View Button */}
      <div className="absolute -top-14 right-0 pointer-events-auto">
        <button
          onClick={unloadSession}
          className="flex items-center gap-2 px-4 py-2 bg-red-500/80 hover:bg-red-500 text-white rounded-full shadow-lg backdrop-blur-sm transition-all font-medium text-sm group"
        >
          <X className="w-4 h-4 group-hover:scale-110 transition-transform" />
          <span>Exit Playback</span>
        </button>
      </div>

      {/* Main Glass Container - Compact without header */}
      <div className="bg-[#1a1b26]/90 backdrop-blur-md border border-white/10 rounded-2xl shadow-2xl overflow-visible ring-1 ring-black/50">
        {/* Progress Bar Area - Now moved to top with slight padding */}
        <div className="px-4 pt-4 pb-1">
          <div
            ref={progressBarRef}
            className="group relative h-2 bg-black/40 rounded-full cursor-pointer touch-none select-none ring-1 ring-white/5"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp} // Safety fallback
          >
            {/* Interactive Hit Area (Invisible, larger) */}
            <div className="absolute -inset-y-3 inset-x-0 z-20" />

            {/* Progress Fill */}
            <div
              className="h-full bg-accent/30 rounded-full relative transition-all duration-75 ease-out"
              style={{
                width: `${progress}%`,
                transition: isDragging ? "none" : "width 75ms ease-out",
              }}
            >
              {/* UND Green Dot Scrubber - Forced Color */}
              <div
                className={`absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-4 h-4 bg-[#009A44] rounded-full shadow-[0_0_10px_rgba(0,154,68,0.8)] border-2 border-[#1a1b26] z-10 scale-100 transition-transform ${isDragging || "group-hover:scale-110"}`}
              />
            </div>
          </div>

          {/* Time Indicators */}
          <div className="flex justify-between mt-2 text-[10px] font-mono font-medium text-white/40">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Controls Row */}
        <div className="flex items-center justify-between px-4 pb-4 pt-2 relative gap-4">
          {/* Speed Control (Embedded Horizontal Slider) */}
          <div className="flex flex-col gap-1 w-28 group">
            <div className="flex justify-between items-center px-0.5">
              <span className="text-[10px] text-white/40 font-medium group-hover:text-white/60 transition-colors">
                SPEED
              </span>
              <span className="text-xs font-mono text-accent font-bold">
                {playbackSpeed}x
              </span>
            </div>
            <input
              type="range"
              min="0.1"
              max="4.0"
              step="0.1"
              value={playbackSpeed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#009A44] [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(0,154,68,0.5)] hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-95 transition-all"
            />
          </div>

          {/* Transport Controls (Centered) */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => seek(0)}
              className="p-2 text-white/40 hover:text-white hover:bg-white/5 rounded-full transition-all active:scale-90"
              title="Restart"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => seek(Math.max(0, currentTime - 1000))}
              className="p-2 text-white/40 hover:text-white hover:bg-white/5 rounded-full transition-all active:scale-90"
              title="Back 1s"
            >
              <SkipBack className="w-5 h-5" />
            </button>

            <button
              onClick={() => {
                if (isEnded) {
                  seek(0);
                  play();
                } else if (isPlaying) {
                  pause();
                } else {
                  play();
                }
              }}
              className={`
                                w-10 h-10 flex items-center justify-center rounded-full transition-all shadow-lg
                                hover:scale-105 active:scale-95
                                ${
                                  isPlaying
                                    ? "bg-white text-black hover:bg-white/90 shadow-white/20"
                                    : isEnded
                                      ? "bg-accent text-white hover:bg-accent/90 shadow-accent/40 animate-pulse"
                                      : "bg-accent text-white hover:bg-accent/90 shadow-accent/40"
                                }
                            `}
              title={isEnded ? "Replay" : isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="w-4 h-4 fill-current" />
              ) : isEnded ? (
                <RefreshCw className="w-4 h-4" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </button>

            <button
              onClick={() => seek(Math.min(duration, currentTime + 1000))}
              className="p-2 text-white/40 hover:text-white hover:bg-white/5 rounded-full transition-all active:scale-90"
              title="Forward 1s"
            >
              <SkipForward className="w-5 h-5" />
            </button>

            <button
              onClick={toggleLooping}
              className={`p-2 rounded-full transition-all active:scale-90 ${isLooping ? "text-accent bg-accent/10 shadow-[0_0_10px_rgba(var(--accent),0.2)]" : "text-white/40 hover:text-white hover:bg-white/5"}`}
              title="Toggle Loop"
            >
              <Repeat className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Additional Info / Spacer to balance Speed Control */}
          <div className="w-24 flex justify-end">
            <div className="flex items-center gap-1.5 text-[10px] text-white/30 font-mono bg-white/5 px-2 py-1 rounded-md border border-white/5">
              <Clock className="w-3 h-3" />
              <span>{(currentTime / 1000).toFixed(2)}s</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
