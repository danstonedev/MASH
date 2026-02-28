import { useEffect, useState, useCallback } from "react";
import {
  Zap,
  StopCircle,
  FileJson,
  FileText,
  AlertTriangle,
  AlertOctagon,
  Info,
  ShieldCheck,
  Clock,
  Radio,
  Shield,
  Award,
} from "lucide-react";
import {
  streamAnalyzer,
  exportAnalysisToJSON,
  exportAnalysisReport,
} from "../../lib/diagnostics/StreamAnalyzer";
import type { StreamAnomaly, StreamAnalysisResult } from "../../lib/diagnostics/StreamAnalyzer";
import { getSensorDisplayName, registerSensorIds } from "../../lib/sensorDisplayName";
import { cn } from "../../lib/utils";

export function StreamAnalyzerControls() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [anomalyCount, setAnomalyCount] = useState(0);
  const [recentAnomalies, setRecentAnomalies] = useState<StreamAnomaly[]>([]);
  const [analysisResult, setAnalysisResult] = useState<StreamAnalysisResult | null>(null);
  const [showResults, setShowResults] = useState(false);

  // Check if analyzer was already running on mount
  const analyzerRunning = streamAnalyzer.getIsCapturing();
  useEffect(() => {
    if (analyzerRunning && !isCapturing) {
      setIsCapturing(true);
    }
  }, [analyzerRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for live stats during capture
  useEffect(() => {
    if (!isCapturing) return;

    const interval = setInterval(() => {
      setDuration(streamAnalyzer.getDurationSeconds());
      setFrameCount(streamAnalyzer.getFrameCount());
      setAnomalyCount(streamAnalyzer.getAnomalyCount());
      setRecentAnomalies(streamAnalyzer.getRecentAnomalies(4));
    }, 100);

    return () => clearInterval(interval);
  }, [isCapturing]);

  const startCapture = useCallback(() => {
    setAnalysisResult(null);
    setShowResults(false);
    streamAnalyzer.start();
    setIsCapturing(true);
    setDuration(0);
    setFrameCount(0);
    setAnomalyCount(0);
    setRecentAnomalies([]);
  }, []);

  const stopCapture = useCallback(() => {
    const result = streamAnalyzer.stop();
    setIsCapturing(false);
    setAnalysisResult(result);
    setShowResults(true);
  }, []);

  const downloadJSON = useCallback(() => {
    if (!analysisResult) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    exportAnalysisToJSON(analysisResult, `stream-analysis-${ts}.json`);
  }, [analysisResult]);

  const downloadReport = useCallback(() => {
    if (!analysisResult) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    exportAnalysisReport(analysisResult, `stream-analysis-${ts}.txt`);
  }, [analysisResult]);

  return (
    <div className="flex flex-col gap-2 p-3 bg-bg-elevated border border-border rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-cyan-400" />
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Stream Analyzer
          </h3>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono">
            Packet
          </span>
        </div>
        <div className="text-[10px] font-mono text-text-tertiary">
          {isCapturing ? (
            <span className="text-cyan-400 animate-pulse">
              ◉ {duration.toFixed(1)}s • {frameCount} frames
            </span>
          ) : analysisResult ? (
            <span className="text-green-400">Analysis ready</span>
          ) : (
            <span>High-speed packet analysis</span>
          )}
        </div>
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap gap-2">
        {!isCapturing ? (
          <button
            onClick={startCapture}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 text-xs font-medium transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            Start Capture
          </button>
        ) : (
          <button
            onClick={stopCapture}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 text-xs font-medium transition-colors animate-pulse"
          >
            <StopCircle className="w-3.5 h-3.5" />
            Stop & Analyze
          </button>
        )}

        {analysisResult && (
          <>
            <div className="w-px bg-border mx-1" />
            <button
              onClick={downloadJSON}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 text-[10px]"
              title="Download full analysis JSON"
            >
              <FileJson className="w-3 h-3" /> JSON
            </button>
            <button
              onClick={downloadReport}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 text-[10px]"
              title="Download diagnostic report"
            >
              <FileText className="w-3 h-3" /> Report
            </button>
          </>
        )}
      </div>

      {/* Live anomaly feed during capture */}
      {isCapturing && anomalyCount > 0 && (
        <div className="mt-1 p-2 rounded bg-black/20 border border-border/50">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-text-tertiary font-medium uppercase">Live Anomalies</span>
            <span className="text-[10px] font-mono text-amber-400">{anomalyCount} detected</span>
          </div>
          <div className="space-y-0.5 max-h-24 overflow-y-auto">
            {recentAnomalies.map((a, i) => (
              <AnomalyLine key={i} anomaly={a} />
            ))}
          </div>
        </div>
      )}

      {/* Analysis Results */}
      {showResults && analysisResult && (
        <AnalysisResults result={analysisResult} onClose={() => setShowResults(false)} />
      )}

      {/* Guidance when idle */}
      {!isCapturing && !analysisResult && (
        <div className="flex items-start gap-1.5 mt-1 px-1">
          <Info className="w-3 h-3 text-cyan-400 mt-0.5 shrink-0" />
          <span className="text-[10px] text-text-tertiary leading-tight">
            Captures each incoming packet with real-time anomaly detection. Run for 10-60s during live streaming to diagnose timing, dropouts, and integrity issues.
          </span>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ANOMALY LINE
// ============================================================================

function AnomalyLine({ anomaly }: { anomaly: StreamAnomaly }) {
  const icons = {
    critical: <AlertOctagon className="w-2.5 h-2.5 text-red-400 shrink-0" />,
    warning: <AlertTriangle className="w-2.5 h-2.5 text-amber-400 shrink-0" />,
    info: <Info className="w-2.5 h-2.5 text-blue-400 shrink-0" />,
  };

  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      {icons[anomaly.severity]}
      <span className="text-text-tertiary font-mono shrink-0">
        {(anomaly.timeMs / 1000).toFixed(1)}s
      </span>
      <span className="text-text-secondary truncate">{anomaly.message}</span>
    </div>
  );
}

// ============================================================================
// ANALYSIS RESULTS (inline panel)
// ============================================================================

function AnalysisResults({ result, onClose }: { result: StreamAnalysisResult; onClose: () => void }) {
  return (
    <div className="mt-1 p-2 rounded bg-black/30 border border-cyan-500/20 space-y-2">
      {/* Grade cards */}
      <div className="grid grid-cols-4 gap-1.5">
        <GradeCard label="Overall" grade={result.grades.overall} icon={Award} />
        <GradeCard label="Timing" grade={result.grades.timing} icon={Clock} />
        <GradeCard label="Reliability" grade={result.grades.reliability} icon={Radio} />
        <GradeCard label="Integrity" grade={result.grades.integrity} icon={Shield} />
      </div>

      {/* Sensor ranking */}
      <div className="space-y-1">
        <span className="text-[10px] text-text-tertiary font-medium uppercase">Sensor Ranking</span>
        {(() => { registerSensorIds(result.sensorRanking.map((s) => s.sensorId)); return null; })()}
        {result.sensorRanking.map((s) => (
          <div key={s.sensorId} className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-text-secondary w-12 shrink-0">
              {getSensorDisplayName(s.sensorId)}
            </span>
            <div className="flex-1 h-1.5 bg-black/40 rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  s.score >= 90
                    ? "bg-green-500"
                    : s.score >= 70
                      ? "bg-amber-500"
                      : "bg-red-500"
                )}
                style={{ width: `${s.score}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-text-tertiary w-6 text-right">
              {s.score.toFixed(0)}
            </span>
            <span
              className={cn(
                "text-[10px] font-bold w-6",
                s.grade.startsWith("A")
                  ? "text-green-400"
                  : s.grade.startsWith("B")
                    ? "text-blue-400"
                    : s.grade.startsWith("C")
                      ? "text-amber-400"
                      : "text-red-400"
              )}
            >
              {s.grade}
            </span>
          </div>
        ))}
      </div>

      {/* Timing distribution */}
      <div className="space-y-1">
        <span className="text-[10px] text-text-tertiary font-medium uppercase">Timing</span>
        <div className="flex gap-3 text-[10px] text-text-secondary font-mono">
          <span>μ={result.timing.meanDtMs.toFixed(1)}ms</span>
          <span>σ={result.timing.stdDevDtMs.toFixed(1)}ms</span>
          <span>range={result.timing.minDtMs.toFixed(0)}-{result.timing.maxDtMs.toFixed(0)}ms</span>
        </div>
        <div className="flex gap-0.5 h-4 items-end">
          {result.timing.histogram.map((b, i) => {
            const maxCount = Math.max(...result.timing.histogram.map((h) => h.count), 1);
            const height = (b.count / maxCount) * 100;
            return (
              <div
                key={i}
                className="flex-1 rounded-t bg-cyan-500/40 min-h-[1px]"
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${b.rangeLabel}: ${b.count} (${b.percent.toFixed(1)}%)`}
              />
            );
          })}
        </div>
        <div className="flex gap-0.5">
          {result.timing.histogram.map((b, i) => (
            <span key={i} className="flex-1 text-[7px] text-text-tertiary text-center truncate">
              {b.rangeLabel}
            </span>
          ))}
        </div>
      </div>

      {/* Anomaly summary */}
      {result.anomalySummary.total > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] text-text-tertiary font-medium uppercase">
            Anomalies ({result.anomalySummary.total})
          </span>
          <div className="flex gap-2 text-[10px]">
            {result.anomalySummary.critical > 0 && (
              <span className="text-red-400 font-medium">{result.anomalySummary.critical} critical</span>
            )}
            {result.anomalySummary.warning > 0 && (
              <span className="text-amber-400">{result.anomalySummary.warning} warning</span>
            )}
            {result.anomalySummary.info > 0 && (
              <span className="text-blue-400">{result.anomalySummary.info} info</span>
            )}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {result.recommendations.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] text-text-tertiary font-medium uppercase">Recommendations</span>
          <div className="space-y-1">
            {result.recommendations.map((rec, i) => (
              <div key={i} className="flex items-start gap-1 text-[10px] text-text-secondary leading-tight">
                <ShieldCheck className="w-2.5 h-2.5 text-green-400 mt-0.5 shrink-0" />
                <span>{rec}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Close */}
      <button
        onClick={onClose}
        className="w-full mt-1 text-[10px] text-text-tertiary hover:text-text-secondary py-1 transition-colors"
      >
        Collapse results
      </button>
    </div>
  );
}

// ============================================================================
// GRADE CARD
// ============================================================================

function GradeCard({
  label,
  grade,
  icon: Icon,
}: {
  label: string;
  grade: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const gradeColor = grade.startsWith("A")
    ? "text-green-400 border-green-500/20 bg-green-500/5"
    : grade.startsWith("B")
      ? "text-blue-400 border-blue-500/20 bg-blue-500/5"
      : grade.startsWith("C")
        ? "text-amber-400 border-amber-500/20 bg-amber-500/5"
        : grade === "-"
          ? "text-text-tertiary border-border bg-bg-surface"
          : "text-red-400 border-red-500/20 bg-red-500/5";

  return (
    <div className={cn("p-1.5 rounded border text-center", gradeColor)}>
      <Icon className="w-3 h-3 mx-auto mb-0.5 opacity-60" />
      <div className="text-sm font-bold font-mono">{grade}</div>
      <div className="text-[8px] uppercase opacity-60">{label}</div>
    </div>
  );
}
