/**
 * GapAnalysisReport.tsx - Vicon-Style Data Integrity Report
 *
 * Visual display of per-sensor gap analysis with:
 * - Overall quality grade badge
 * - Per-sensor coverage bars (like Vicon's gap-fill timeline)
 * - Gap table with severity indicators
 * - Summary statistics
 */

import { useState, useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Info,
  ChevronDown,
  ChevronUp,
  Activity,
} from "lucide-react";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import {
  analyzeGaps,
  coverageColor,
  gradeColor,
  severityBg,
  severityText,
  type GapAnalysisReport as GapReport,
  type SensorReport,
  type DataGap,
} from "../../analysis/GapAnalysis";
import {
  getSensorDisplayName,
  registerSensorIds,
} from "../../lib/sensorDisplayName";

// ============================================================================
// Main Component
// ============================================================================

export function GapAnalysisReport() {
  const sessionId = usePlaybackStore((s) => s.sessionId);
  const frames = usePlaybackStore((s) => s.frames);
  const frameRate = usePlaybackStore((s) => s.frameRate);
  const duration = usePlaybackStore((s) => s.duration);

  const [expanded, setExpanded] = useState(true);
  const [selectedSensor, setSelectedSensor] = useState<number | null>(null);

  // Run analysis when frames change
  const report = useMemo(() => {
    if (!sessionId || frames.length === 0) return null;
    return analyzeGaps(
      frames,
      sessionId,
      frameRate || undefined,
      duration || undefined,
    );
  }, [sessionId, frames, frameRate, duration]);

  if (!report) return null;

  return (
    <div className="bg-bg-elevated/40 border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-accent" />
          <span className="text-xs font-semibold text-text-primary uppercase tracking-wide">
            Data Integrity
          </span>
          <GradeBadge grade={report.overallGrade} score={report.overallScore} />
        </div>
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-text-secondary" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border p-3 space-y-3">
          {/* Summary Stats Row */}
          <SummaryStats report={report} />

          {/* Per-Sensor Coverage Bars */}
          <SensorCoverageBars
            report={report}
            selectedSensor={selectedSensor}
            onSelectSensor={setSelectedSensor}
          />

          {/* Gap Detail for Selected Sensor */}
          {selectedSensor !== null && (
            <SensorGapDetail
              sensorReport={
                report.sensorReports.find((s) => s.sensorId === selectedSensor)!
              }
            />
          )}

          {/* Notes */}
          {report.summaryNotes.length > 0 && (
            <div className="space-y-1">
              {report.summaryNotes.map((note, i) => (
                <div
                  key={i}
                  className="flex items-start gap-1.5 text-[10px] text-text-secondary"
                >
                  <Info className="w-3 h-3 mt-0.5 shrink-0 opacity-50" />
                  <span>{note}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-Components
// ============================================================================

function GradeBadge({
  grade,
  score,
}: {
  grade: GapReport["overallGrade"];
  score: number;
}) {
  const color = gradeColor(grade);
  const bgMap: Record<string, string> = {
    A: "bg-green-500/15 border-green-500/30",
    B: "bg-green-500/10 border-green-400/25",
    C: "bg-yellow-500/15 border-yellow-500/30",
    D: "bg-orange-500/15 border-orange-500/30",
    F: "bg-red-500/15 border-red-500/30",
  };

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${bgMap[grade]} ${color}`}
    >
      {grade}
      <span className="font-normal opacity-70">{score}%</span>
    </span>
  );
}

function SummaryStats({ report }: { report: GapReport }) {
  const totalGaps = report.sensorReports.reduce(
    (sum, s) => sum + s.gaps.length,
    0,
  );
  const criticalCount = report.sensorReports.reduce(
    (sum, s) => sum + s.gaps.filter((g) => g.severity === "critical").length,
    0,
  );

  return (
    <div className="grid grid-cols-4 gap-1.5">
      <StatCell
        label="Coverage"
        value={`${report.globalCoveragePercent}%`}
        className={coverageColor(report.globalCoveragePercent)}
      />
      <StatCell
        label="Sync"
        value={`${report.syncCoveragePercent}%`}
        className={coverageColor(report.syncCoveragePercent)}
      />
      <StatCell
        label="Gaps"
        value={totalGaps.toString()}
        className={totalGaps === 0 ? "text-green-400" : "text-yellow-400"}
      />
      <StatCell
        label="Critical"
        value={criticalCount.toString()}
        className={criticalCount === 0 ? "text-green-400" : "text-red-400"}
        icon={
          criticalCount > 0 ? (
            <AlertTriangle className="w-2.5 h-2.5" />
          ) : undefined
        }
      />
    </div>
  );
}

function StatCell({
  label,
  value,
  className,
  icon,
}: {
  label: string;
  value: string;
  className: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-bg-surface rounded px-2 py-1.5 text-center">
      <div
        className={`text-sm font-bold flex items-center justify-center gap-1 ${className}`}
      >
        {icon}
        {value}
      </div>
      <div className="text-[8px] text-text-secondary uppercase mt-0.5">
        {label}
      </div>
    </div>
  );
}

// ============================================================================
// Sensor Coverage Bars (Vicon-style gap visualization)
// ============================================================================

function SensorCoverageBars({
  report,
  selectedSensor,
  onSelectSensor,
}: {
  report: GapReport;
  selectedSensor: number | null;
  onSelectSensor: (id: number | null) => void;
}) {
  const { sensorReports, firstFrame, lastFrame } = report;
  const totalSpan = lastFrame - firstFrame + 1;

  // Register all raw sensor IDs so display names are sequential
  registerSensorIds(sensorReports.map((sr) => sr.sensorId));

  if (totalSpan <= 0) return null;

  return (
    <div className="space-y-1">
      <div className="text-[9px] text-text-secondary uppercase font-semibold mb-1">
        Sensor Coverage Timeline
      </div>
      {sensorReports.map((sr) => {
        const isSelected = selectedSensor === sr.sensorId;
        const label = sr.segment || getSensorDisplayName(sr.sensorId);

        return (
          <button
            key={sr.sensorId}
            onClick={() => onSelectSensor(isSelected ? null : sr.sensorId)}
            className={`w-full flex items-center gap-2 px-1.5 py-1 rounded transition-all ${
              isSelected
                ? "bg-accent/10 ring-1 ring-accent/30"
                : "hover:bg-white/5"
            }`}
          >
            {/* Sensor label */}
            <div className="w-16 text-left text-[10px] text-text-secondary truncate shrink-0">
              {label}
            </div>

            {/* Gap bar */}
            <div className="flex-1 h-4 bg-bg-surface rounded-sm overflow-hidden relative">
              <CoverageBar
                sensorReport={sr}
                firstFrame={firstFrame}
                totalSpan={totalSpan}
              />
            </div>

            {/* Coverage % */}
            <div
              className={`w-11 text-right text-[10px] font-mono shrink-0 ${coverageColor(sr.coveragePercent)}`}
            >
              {sr.coveragePercent.toFixed(1)}%
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Renders a single sensor's coverage bar.
 * Green = data present, red gaps = missing frames.
 * Similar to Vicon's trajectory gap display.
 */
function CoverageBar({
  sensorReport,
  firstFrame,
  totalSpan,
}: {
  sensorReport: SensorReport;
  firstFrame: number;
  totalSpan: number;
}) {
  const { gaps, firstFrame: sFirst, lastFrame: sLast } = sensorReport;

  // Calculate the sensor's active region within the global span
  const startPct = ((sFirst - firstFrame) / totalSpan) * 100;
  const endPct = ((sLast - firstFrame + 1) / totalSpan) * 100;
  const widthPct = endPct - startPct;

  return (
    <>
      {/* Active region background (green = data present) */}
      <div
        className="absolute top-0 h-full bg-green-500/40"
        style={{ left: `${startPct}%`, width: `${widthPct}%` }}
      />

      {/* Gap overlays (red marks) */}
      {gaps.map((gap, i) => {
        const gapStart = ((gap.startFrame - firstFrame) / totalSpan) * 100;
        const gapWidth = Math.max((gap.gapLength / totalSpan) * 100, 0.5); // min 0.5% for visibility

        const gapColor =
          gap.severity === "critical"
            ? "bg-red-500/80"
            : gap.severity === "moderate"
              ? "bg-orange-500/70"
              : "bg-yellow-500/50";

        return (
          <div
            key={i}
            className={`absolute top-0 h-full ${gapColor}`}
            style={{ left: `${gapStart}%`, width: `${gapWidth}%` }}
            title={`Gap: ${gap.gapLength} frames (${gap.gapDurationMs.toFixed(1)}ms)`}
          />
        );
      })}

      {/* No-data region indicator (before sensor starts / after sensor ends) */}
      {startPct > 0 && (
        <div
          className="absolute top-0 h-full bg-gray-600/30"
          style={{ left: "0%", width: `${startPct}%` }}
        />
      )}
      {endPct < 100 && (
        <div
          className="absolute top-0 h-full bg-gray-600/30"
          style={{ left: `${endPct}%`, width: `${100 - endPct}%` }}
        />
      )}
    </>
  );
}

// ============================================================================
// Gap Detail Table (for selected sensor)
// ============================================================================

function SensorGapDetail({ sensorReport }: { sensorReport: SensorReport }) {
  const {
    gaps,
    totalSamples,
    expectedSamples,
    missingFrames,
    longestGapFrames,
    longestGapMs,
  } = sensorReport;
  const label =
    sensorReport.segment ||
    sensorReport.sensorName ||
    `Sensor ${sensorReport.sensorId}`;

  return (
    <div className="bg-bg-surface rounded-lg border border-border p-2.5 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">
            {label}
          </span>
          <span className="text-[10px] text-text-secondary">
            {getSensorDisplayName(sensorReport.sensorId)} • HW:{" "}
            {sensorReport.sensorId}
          </span>
        </div>
        <div
          className={`flex items-center gap-1 text-[10px] ${coverageColor(sensorReport.coveragePercent)}`}
        >
          {sensorReport.coveragePercent >= 99 ? (
            <CheckCircle className="w-3 h-3" />
          ) : (
            <AlertTriangle className="w-3 h-3" />
          )}
          {sensorReport.coveragePercent}% coverage
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-4 gap-1 text-center text-[9px]">
        <MiniStat label="Received" value={totalSamples.toLocaleString()} />
        <MiniStat label="Expected" value={expectedSamples.toLocaleString()} />
        <MiniStat
          label="Missing"
          value={missingFrames.toLocaleString()}
          warn={missingFrames > 0}
        />
        <MiniStat
          label="Max Gap"
          value={
            longestGapFrames > 0
              ? `${longestGapFrames}f (${longestGapMs.toFixed(0)}ms)`
              : "—"
          }
          warn={longestGapFrames > 20}
        />
      </div>

      {/* Gap List */}
      {gaps.length === 0 ? (
        <div className="flex items-center justify-center gap-1.5 py-2 text-[10px] text-green-400">
          <CheckCircle className="w-3 h-3" />
          No gaps detected — continuous data stream
        </div>
      ) : (
        <div className="space-y-0.5 max-h-32 overflow-y-auto">
          <div className="grid grid-cols-[auto_1fr_1fr_70px_60px] gap-x-2 px-1.5 py-1 text-[8px] text-text-secondary uppercase font-semibold sticky top-0 bg-bg-surface">
            <div>Sev</div>
            <div>Start Frame</div>
            <div>End Frame</div>
            <div className="text-right">Length</div>
            <div className="text-right">Duration</div>
          </div>
          {gaps.map((gap, i) => (
            <GapRow key={i} gap={gap} />
          ))}
        </div>
      )}
    </div>
  );
}

function GapRow({ gap }: { gap: DataGap }) {
  return (
    <div
      className={`grid grid-cols-[auto_1fr_1fr_70px_60px] gap-x-2 px-1.5 py-1 rounded text-[10px] border ${severityBg(gap.severity)}`}
    >
      <SeverityDot severity={gap.severity} />
      <span className="text-text-secondary font-mono">
        {gap.startFrame.toLocaleString()}
      </span>
      <span className="text-text-secondary font-mono">
        {gap.endFrame.toLocaleString()}
      </span>
      <span className={`text-right font-mono ${severityText(gap.severity)}`}>
        {gap.gapLength}f
      </span>
      <span className="text-right text-text-secondary font-mono">
        {gap.gapDurationMs.toFixed(1)}ms
      </span>
    </div>
  );
}

function SeverityDot({ severity }: { severity: DataGap["severity"] }) {
  const dotColor: Record<string, string> = {
    minor: "bg-yellow-400",
    moderate: "bg-orange-400",
    critical: "bg-red-400",
  };
  return (
    <div className="flex items-center">
      <div className={`w-1.5 h-1.5 rounded-full ${dotColor[severity]}`} />
    </div>
  );
}

function MiniStat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="bg-bg-elevated/40 rounded px-1 py-1">
      <div
        className={`text-[10px] font-mono ${warn ? "text-orange-400" : "text-text-primary"}`}
      >
        {value}
      </div>
      <div className="text-[7px] text-text-secondary uppercase">{label}</div>
    </div>
  );
}
