/**
 * Analysis Results Panel
 * =======================
 *
 * Displays comprehensive analysis results for a loaded session:
 * - Activity breakdown (pie chart)
 * - Gait metrics dashboard
 * - Data quality indicators
 * - Fatigue analysis summary
 */

import { useState, useEffect } from "react";
import {
  Activity,
  Footprints,
  BarChart3,
  AlertCircle,
  CheckCircle,
  Clock,
  Gauge,
  TrendingUp,
  TrendingDown,
  Loader2,
} from "lucide-react";
import {
  sessionAnalyzer,
  type SessionAnalysisResult,
} from "../../analysis/SessionAnalyzer";
import {
  fatigueAnalyzer,
  type FatigueState,
} from "../../analysis/FatigueAnalyzer";
import {
  analyzeCervicalRom,
  type CervicalRomResult,
} from "../../analysis/CervicalRomAnalyzer";
import { CervicalRomCard } from "./CervicalRomCard";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useTareStore } from "../../store/useTareStore";
import { cn } from "../../lib/utils";

// ============================================================================
// ACTIVITY COLORS
// ============================================================================

const ACTIVITY_COLORS: Record<string, string> = {
  standing: "#3b82f6", // blue
  idle: "#6b7280", // gray
  walking: "#22c55e", // green
  running: "#f59e0b", // amber
  jumping: "#ef4444", // red
  exercising: "#f97316", // orange
  skating: "#3b82f6", // blue
  sitting: "#a855f7", // purple
  transitioning: "#6b7280", // gray
  squat: "#ec4899", // pink
  unknown: "#9ca3af", // gray
};

/** Human-readable label for sensor region */
const REGION_LABELS: Record<string, string> = {
  head: "Head / Cervical",
  upper_body: "Upper Body",
  lower_body: "Lower Body",
  full_body: "Full Body",
  unknown: "General",
};

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

interface MetricCardProps {
  label: string;
  value: string | number;
  unit?: string;
  icon: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  className?: string;
}

function MetricCard({
  label,
  value,
  unit,
  icon,
  trend,
  className,
}: MetricCardProps) {
  return (
    <div
      className={cn(
        "bg-bg-elevated rounded-lg p-3 ring-1 ring-border",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-text-secondary text-xs mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-xl font-bold">{value}</span>
        {unit && <span className="text-xs text-text-secondary">{unit}</span>}
        {trend &&
          trend !== "neutral" &&
          (trend === "up" ? (
            <TrendingUp className="w-3 h-3 text-green-500 ml-1" />
          ) : (
            <TrendingDown className="w-3 h-3 text-red-500 ml-1" />
          ))}
      </div>
    </div>
  );
}

interface ActivityBarProps {
  activities: Record<string, number>;
  totalDuration: number;
}

function ActivityBar({ activities, totalDuration }: ActivityBarProps) {
  const segments = Object.entries(activities)
    .filter(([_, duration]) => duration > 0)
    .map(([activity, duration]) => ({
      activity,
      percent: (duration / totalDuration) * 100,
      duration,
    }))
    .sort((a, b) => b.duration - a.duration);

  return (
    <div
      className="space-y-2"
      role="region"
      aria-label="Activity Breakdown Chart"
    >
      {/* Stacked bar */}
      <div className="h-4 rounded-full overflow-hidden flex bg-bg-elevated ring-1 ring-border">
        {segments.map((seg) => (
          <div
            key={seg.activity}
            style={{
              width: `${seg.percent}%`,
              backgroundColor: ACTIVITY_COLORS[seg.activity] || "#6b7280",
            }}
            className="h-full transition-all"
            title={`${seg.activity}: ${formatDuration(seg.duration)}`}
            role="img"
            aria-label={`${seg.activity}: ${seg.percent.toFixed(0)}%`}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2 text-xs" aria-hidden="true">
        {segments.map((seg) => (
          <div key={seg.activity} className="flex items-center gap-1">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: ACTIVITY_COLORS[seg.activity] || "#6b7280",
              }}
            />
            <span className="capitalize">{seg.activity}</span>
            <span className="text-text-secondary">
              ({seg.percent.toFixed(0)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface DataQualityProps {
  sensorCount: number;
  sampleRate: number;
  missingFrames: number;
  totalFrames: number;
}

function DataQualityIndicator({
  sensorCount,
  sampleRate,
  missingFrames,
  totalFrames,
}: DataQualityProps) {
  const qualityPercent =
    totalFrames > 0 ? ((totalFrames - missingFrames) / totalFrames) * 100 : 100;

  const isGood = qualityPercent > 95;
  const isWarning = qualityPercent > 85 && qualityPercent <= 95;

  return (
    <div
      className="bg-bg-elevated rounded-lg p-3 ring-1 ring-border space-y-2"
      role="status"
      aria-label={`Data Quality: ${qualityPercent.toFixed(1)}%. ${sensorCount} sensors active at ${sampleRate.toFixed(0)} Hertz.`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-secondary text-xs">
          {isGood ? (
            <CheckCircle className="w-4 h-4 text-green-500" />
          ) : isWarning ? (
            <AlertCircle className="w-4 h-4 text-yellow-500" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-500" />
          )}
          <span>Data Quality</span>
        </div>
        <span
          className={cn(
            "text-sm font-bold",
            isGood && "text-green-500",
            isWarning && "text-yellow-500",
            !isGood && !isWarning && "text-red-500",
          )}
        >
          {qualityPercent.toFixed(1)}%
        </span>
      </div>

      {/* Quality bar */}
      <div className="h-1 bg-bg rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full transition-all",
            isGood && "bg-green-500",
            isWarning && "bg-yellow-500",
            !isGood && !isWarning && "bg-red-500",
          )}
          style={{ width: `${qualityPercent}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-text-secondary">
        <span>{sensorCount} sensors</span>
        <span>{sampleRate.toFixed(0)} Hz</span>
      </div>
    </div>
  );
}

interface FatigueSummaryProps {
  fatigueState: FatigueState | null;
}

function FatigueSummary({ fatigueState }: FatigueSummaryProps) {
  if (!fatigueState) {
    return (
      <div className="bg-bg-elevated rounded-lg p-3 ring-1 ring-border text-center text-text-secondary text-xs">
        <Gauge className="w-6 h-6 mx-auto mb-1 opacity-30" />
        <p>Session too short for fatigue analysis</p>
      </div>
    );
  }

  const alertColors = {
    normal: "text-green-500",
    elevated: "text-yellow-500",
    high: "text-orange-500",
    critical: "text-red-500",
  };

  return (
    <div
      className="bg-bg-elevated rounded-lg p-3 ring-1 ring-border space-y-2"
      role="status"
      aria-label={`Fatigue Status: ${fatigueState.alertLevel}. Fatigue Index: ${fatigueState.fatigueIndex}%.`}
    >
      <div className="flex items-center justify-between" aria-hidden="true">
        <div className="flex items-center gap-2 text-text-secondary text-xs">
          <Gauge className="w-4 h-4" />
          <span>Fatigue Level</span>
        </div>
        <span
          className={cn(
            "text-sm font-bold capitalize",
            alertColors[fatigueState.alertLevel],
          )}
        >
          {fatigueState.alertLevel}
        </span>
      </div>

      {/* Fatigue gauge */}
      <div
        className="relative h-3 bg-gradient-to-r from-green-500 via-yellow-500 via-orange-500 to-red-500 rounded-full overflow-hidden"
        aria-hidden="true"
      >
        <div
          className="absolute top-0 bottom-0 w-1 bg-white shadow-lg"
          style={{ left: `${fatigueState.fatigueIndex}%` }}
        />
      </div>

      <div
        className="flex justify-between text-xs text-text-secondary"
        aria-hidden="true"
      >
        <span>Fresh</span>
        <span className="font-bold">{fatigueState.fatigueIndex}%</span>
        <span>Fatigued</span>
      </div>
    </div>
  );
}

// ============================================================================
// HELPERS
// ============================================================================

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function AnalysisResultsPanel() {
  const sessionId = usePlaybackStore((state) => state.sessionId);
  const frames = usePlaybackStore((state) => state.frames);
  const sessionName = usePlaybackStore((state) => state.sessionName);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [results, setResults] = useState<SessionAnalysisResult | null>(null);
  const [fatigueState, setFatigueState] = useState<FatigueState | null>(null);
  const [cervicalRom, setCervicalRom] = useState<CervicalRomResult | null>(
    null,
  );

  // Analyze session when loaded
  useEffect(() => {
    if (!sessionId) {
      setResults(null);
      setFatigueState(null);
      setCervicalRom(null);
      return;
    }

    setIsAnalyzing(true);

    const analyze = async () => {
      try {
        // Run session analyzer
        const analysisResult = await sessionAnalyzer.analyzeSession(sessionId);
        setResults(analysisResult);

        // Run cervical ROM analysis if head sensors detected
        if (
          analysisResult &&
          analysisResult.sensorRegion === "head" &&
          frames.length > 0
        ) {
          // Find head-sensor frames (by segment assignment or use all frames for single-sensor head sessions)
          const headFrames = frames.filter((f) => {
            if (f.segment && /head|cervical|neck/i.test(f.segment)) return true;
            return false;
          });
          // If no segment labels, use primary sensor frames (single-sensor head session)
          const romFrames = headFrames.length > 0 ? headFrames : frames;

          // Retrieve tare state for head segment (loaded into TareStore during session load)
          const headTareState = useTareStore.getState().getTareState("head");
          const hasTare =
            headTareState.mountingTareTime > 0 ||
            headTareState.headingTareTime > 0;

          const romResult = analyzeCervicalRom(romFrames, {
            tareState: hasTare ? headTareState : null,
          });
          setCervicalRom(romResult);
        } else {
          setCervicalRom(null);
        }

        // Run fatigue analyzer on frames
        if (frames.length > 0) {
          fatigueAnalyzer.reset();
          let lastState: FatigueState | null = null;

          for (const frame of frames) {
            const state = fatigueAnalyzer.processFrame(frame);
            if (state) lastState = state;
          }

          setFatigueState(lastState);
        }
      } catch (error) {
        console.error("Analysis failed:", error);
      } finally {
        setIsAnalyzing(false);
      }
    };

    analyze();
  }, [sessionId, frames]);

  // No session loaded
  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary p-4">
        <BarChart3 className="w-12 h-12 mb-3 opacity-30" />
        <p className="text-sm">No session loaded</p>
        <p className="text-xs mt-1">
          Load a session from History to see analysis
        </p>
      </div>
    );
  }

  // Loading state
  if (isAnalyzing) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary p-4">
        <Loader2 className="w-8 h-8 animate-spin mb-3 text-accent" />
        <p className="text-sm">Analyzing session...</p>
      </div>
    );
  }

  // No results
  if (!results) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary p-4">
        <AlertCircle className="w-12 h-12 mb-3 opacity-30" />
        <p className="text-sm">Analysis failed</p>
        <p className="text-xs mt-1">Session data may be corrupted</p>
      </div>
    );
  }

  // Determine if gait metrics make sense for this recording
  const canShowGait =
    results.sensorRegion === "lower_body" ||
    results.sensorRegion === "full_body";
  const showGaitMetrics =
    canShowGait && results.overallGaitMetrics && results.totalSteps > 0;

  // Build a human-readable context description
  const regionLabel = REGION_LABELS[results.sensorRegion] || "General";
  const segmentList =
    results.instrumentedSegments.length > 0
      ? results.instrumentedSegments.map((s) => s.replace(/_/g, " ")).join(", ")
      : `${results.dataQuality.sensorCount} sensor${results.dataQuality.sensorCount !== 1 ? "s" : ""}`;

  // Calculate dominant activity
  const dominantActivity = Object.entries(results.activitySummary)
    .filter(([_, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1])[0];
  const dominantLabel = dominantActivity
    ? dominantActivity[0].charAt(0).toUpperCase() + dominantActivity[0].slice(1)
    : "Unknown";

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 text-accent">
        <BarChart3 className="w-4 h-4" />
        <h3 className="text-sm font-bold">Session Analysis</h3>
      </div>

      {/* Session info */}
      <div className="text-xs text-text-secondary space-y-1">
        <div className="flex items-center gap-2">
          <Clock className="w-3 h-3" />
          <span>{sessionName}</span>
          <span className="text-text-secondary/50">&bull;</span>
          <span>{formatDuration(results.totalDuration)}</span>
        </div>
        <div className="flex items-center gap-2 text-text-secondary/70">
          <Activity className="w-3 h-3" />
          <span className="capitalize">{regionLabel}</span>
          {results.instrumentedSegments.length > 0 && (
            <>
              <span className="text-text-secondary/30">&bull;</span>
              <span className="capitalize">{segmentList}</span>
            </>
          )}
        </div>
      </div>

      {/* Activity breakdown */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-text-secondary flex items-center gap-1">
          <Activity className="w-3 h-3" />
          Activity Breakdown
        </h4>
        <ActivityBar
          activities={results.activitySummary}
          totalDuration={results.totalDuration}
        />
      </div>

      {/* Movement summary (always shown) */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-text-secondary flex items-center gap-1">
          <Gauge className="w-3 h-3" />
          Movement Summary
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <MetricCard
            label="Primary Activity"
            value={dominantLabel}
            icon={<Activity className="w-3 h-3" />}
          />
          <MetricCard
            label="Duration"
            value={formatDuration(results.totalDuration)}
            icon={<Clock className="w-3 h-3" />}
          />
          <MetricCard
            label="Sensors"
            value={results.dataQuality.sensorCount}
            icon={<BarChart3 className="w-3 h-3" />}
          />
          <MetricCard
            label="Frames"
            value={results.frameCount.toLocaleString()}
            icon={<TrendingUp className="w-3 h-3" />}
          />
        </div>
      </div>

      {/* Cervical ROM analysis - when head sensors are present */}
      {cervicalRom && results.sensorRegion === "head" && (
        <CervicalRomCard result={cervicalRom} />
      )}

      {/* Gait metrics - ONLY when lower body sensors are present */}
      {showGaitMetrics && results.overallGaitMetrics && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-text-secondary flex items-center gap-1">
            <Footprints className="w-3 h-3" />
            Gait Metrics
          </h4>
          <div className="grid grid-cols-2 gap-2">
            <MetricCard
              label="Cadence"
              value={results.averageCadence?.toFixed(0) || "--"}
              unit="steps/min"
              icon={<Footprints className="w-3 h-3" />}
            />
            <MetricCard
              label="Total Steps"
              value={results.totalSteps || "--"}
              icon={<Activity className="w-3 h-3" />}
            />
            {results.overallGaitMetrics.symmetryIndex !== undefined && (
              <MetricCard
                label="Symmetry"
                value={results.overallGaitMetrics.symmetryIndex.toFixed(1)}
                unit="%"
                icon={<BarChart3 className="w-3 h-3" />}
                trend={
                  results.overallGaitMetrics.symmetryIndex > 95 ? "up" : "down"
                }
              />
            )}
            {results.overallGaitMetrics.strideTimeCV !== undefined && (
              <MetricCard
                label="Stride CV"
                value={results.overallGaitMetrics.strideTimeCV.toFixed(1)}
                unit="%"
                icon={<TrendingUp className="w-3 h-3" />}
                trend={
                  results.overallGaitMetrics.strideTimeCV < 5 ? "up" : "down"
                }
              />
            )}
          </div>
        </div>
      )}

      {/* Info note when gait metrics are intentionally hidden */}
      {!canShowGait && results.activitySummary.walking > 0 && (
        <div className="bg-bg-elevated rounded-lg p-3 ring-1 ring-border text-xs text-text-secondary">
          <p className="flex items-center gap-1">
            <AlertCircle className="w-3 h-3 text-yellow-500 flex-shrink-0" />
            Gait metrics require pelvis or leg sensors. Current setup:{" "}
            {regionLabel.toLowerCase()}.
          </p>
        </div>
      )}

      {/* Data quality */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-text-secondary">
          Data Quality
        </h4>
        <DataQualityIndicator
          sensorCount={results.dataQuality.sensorCount}
          sampleRate={results.dataQuality.averageSampleRate}
          missingFrames={results.dataQuality.missingFrames}
          totalFrames={results.frameCount}
        />
      </div>

      {/* Fatigue summary */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-text-secondary">
          Fatigue Analysis
        </h4>
        <FatigueSummary fatigueState={fatigueState} />
      </div>
    </div>
  );
}
