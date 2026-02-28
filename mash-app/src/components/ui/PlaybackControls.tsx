/**
 * Playback Controls
 * =================
 *
 * Video-player-style controls for session playback:
 * - Play/Pause (spacebar)
 * - Timeline scrubber
 * - Speed selector
 * - Frame stepping
 * - A-B loop
 */

import { useEffect, useCallback } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Repeat,
  X,
  Square,
  RefreshCw,
} from "lucide-react";
import {
  usePlaybackStore,
  PLAYBACK_SPEEDS,
} from "../../store/usePlaybackStore";
import { cn } from "../../lib/utils";

// ============================================================================
// HELPERS
// ============================================================================

function formatTime(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function PlaybackControls() {
  const {
    sessionId,
    sessionName,
    isPlaying,
    currentTime,
    duration,
    playbackSpeed,
    loopStart,
    loopEnd,
    isLooping,
    totalFrames,
    frameRate,
    sensorIds,

    togglePlayPause,
    stop,
    seek,
    stepForward,
    stepBackward,
    setSpeed,
    setLoopStart,
    setLoopEnd,
    clearLoop,
    toggleLooping,
    unloadSession,
    // NOTE: tick is NOT used here - PlaybackTicker component in ThreeView.tsx handles the animation loop
  } = usePlaybackStore();

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlayPause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          stepBackward();
          break;
        case "ArrowRight":
          e.preventDefault();
          stepForward();
          break;
        case "Home":
          e.preventDefault();
          seek(0);
          break;
        case "End":
          e.preventDefault();
          seek(duration);
          break;
        case "[":
          e.preventDefault();
          setLoopStart(currentTime);
          break;
        case "]":
          e.preventDefault();
          setLoopEnd(currentTime);
          break;
        case "l":
        case "L":
          e.preventDefault();
          toggleLooping();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    togglePlayPause,
    stepForward,
    stepBackward,
    seek,
    duration,
    currentTime,
    setLoopStart,
    setLoopEnd,
    toggleLooping,
  ]);

  // Timeline click handler
  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const percent = (e.clientX - rect.left) / rect.width;
      seek(duration * percent);
    },
    [duration, seek],
  );

  if (!sessionId) {
    return (
      <div className="p-4 text-center text-text-secondary">
        <p className="text-sm">No session loaded</p>
        <p className="text-xs mt-1">Select a session from History to replay</p>
      </div>
    );
  }

  const progress = duration > 0 ? currentTime / duration : 0;
  const isEnded =
    !isPlaying && !isLooping && duration > 0 && currentTime >= duration - 1;
  const loopStartPercent =
    loopStart !== null ? (loopStart / duration) * 100 : null;
  const loopEndPercent = loopEnd !== null ? (loopEnd / duration) * 100 : null;

  return (
    <div className="flex flex-col gap-3 p-3 bg-bg-elevated rounded-lg border border-border">
      {/* Session Info */}
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold truncate">
            {sessionName || "Untitled Session"}
          </h4>
          <p className="text-[10px] text-text-secondary">
            {totalFrames.toLocaleString()} frames • {sensorIds.length} sensors •{" "}
            {frameRate}Hz
          </p>
        </div>
        <button
          onClick={unloadSession}
          className="p-1.5 text-text-secondary hover:text-danger transition-colors"
          title="Close session"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Timeline */}
      <div
        className="relative h-8 bg-bg-surface rounded cursor-pointer group"
        onClick={handleTimelineClick}
      >
        {/* Loop region */}
        {loopStartPercent !== null && loopEndPercent !== null && (
          <div
            className="absolute top-0 bottom-0 bg-accent/20 border-l border-r border-accent"
            style={{
              left: `${loopStartPercent}%`,
              width: `${loopEndPercent - loopStartPercent}%`,
            }}
          />
        )}

        {/* Progress bar */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-accent/40 transition-all"
          style={{ width: `${progress * 100}%` }}
        />

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-accent shadow-lg"
          style={{ left: `${progress * 100}%` }}
        />

        {/* Hover indicator */}
        <div className="absolute inset-0 group-hover:bg-white/5 transition-colors" />
      </div>

      {/* Time display */}
      <div className="flex justify-between text-[10px] font-mono text-text-secondary">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>

      {/* Main controls */}
      <div className="flex items-center justify-center gap-2">
        {/* Stop */}
        <button
          onClick={stop}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          title="Stop (reset to start)"
        >
          <Square className="w-4 h-4" />
        </button>

        {/* Step back */}
        <button
          onClick={stepBackward}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          title="Step backward (←)"
        >
          <StepBack className="w-4 h-4" />
        </button>

        {/* Skip to start */}
        <button
          onClick={() => seek(0)}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          title="Skip to start (Home)"
        >
          <SkipBack className="w-4 h-4" />
        </button>

        {/* Play/Pause/Replay */}
        <button
          onClick={togglePlayPause}
          className={cn(
            "p-3 rounded-full transition-colors",
            isPlaying
              ? "bg-accent text-white hover:bg-accent/80"
              : isEnded
                ? "bg-accent text-white hover:bg-accent/80 animate-pulse"
                : "bg-accent text-white hover:bg-accent/80",
          )}
          title={isEnded ? "Replay (Space)" : "Play/Pause (Space)"}
        >
          {isPlaying ? (
            <Pause className="w-5 h-5" />
          ) : isEnded ? (
            <RefreshCw className="w-5 h-5" />
          ) : (
            <Play className="w-5 h-5 ml-0.5" />
          )}
        </button>

        {/* Skip to end */}
        <button
          onClick={() => seek(duration)}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          title="Skip to end (End)"
        >
          <SkipForward className="w-4 h-4" />
        </button>

        {/* Step forward */}
        <button
          onClick={stepForward}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          title="Step forward (→)"
        >
          <StepForward className="w-4 h-4" />
        </button>

        {/* Loop toggle */}
        <button
          onClick={toggleLooping}
          className={cn(
            "p-2 rounded-lg transition-colors",
            isLooping ? "bg-accent/30 text-accent" : "hover:bg-white/10",
          )}
          title="Toggle loop (L)"
        >
          <Repeat className="w-4 h-4" />
        </button>
      </div>

      {/* Speed selector */}
      <div className="flex items-center justify-center gap-1">
        {PLAYBACK_SPEEDS.map((speed) => (
          <button
            key={speed}
            onClick={() => setSpeed(speed)}
            className={cn(
              "px-2 py-1 text-[10px] font-mono rounded transition-colors",
              playbackSpeed === speed
                ? "bg-accent text-white"
                : "bg-white/5 hover:bg-white/10",
            )}
          >
            {speed}x
          </button>
        ))}
      </div>

      {/* Loop controls */}
      {(loopStart !== null || loopEnd !== null) && (
        <div className="flex items-center justify-between text-[10px] bg-accent/10 rounded px-2 py-1">
          <span>
            Loop: {loopStart !== null ? formatTime(loopStart) : "--"}→{" "}
            {loopEnd !== null ? formatTime(loopEnd) : "--"}
          </span>
          <button
            onClick={clearLoop}
            className="text-text-secondary hover:text-danger"
          >
            Clear
          </button>
        </div>
      )}

      {/* Keyboard hints */}
      <div className="text-[9px] text-text-secondary text-center space-x-2">
        <span>Space: Play</span>
        <span>←→: Step</span>
        <span>[]: Loop points</span>
        <span>L: Loop</span>
      </div>
    </div>
  );
}
