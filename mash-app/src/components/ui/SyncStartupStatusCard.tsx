import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  Wifi,
  Radio,
  ShieldAlert,
  X,
} from "lucide-react";
import { useMemo, useState, useEffect, useRef } from "react";
import { useDeviceStore } from "../../store/useDeviceStore";
import { cn } from "../../lib/utils";

// ============================================================================
// Stepper Steps
// ============================================================================

interface StepDef {
  key: string;
  label: string;
}

const STEPS: StepDef[] = [
  { key: "connected", label: "Connected" },
  { key: "nodes", label: "Nodes Found" },
  { key: "syncing", label: "Synchronizing" },
  { key: "ready", label: "Ready" },
];

/** Map SyncPhase to a 0-based step index */
function phaseToStep(
  phase: string,
  nodeCount: number,
): { activeStep: number; failed: boolean } {
  switch (phase) {
    case "connecting":
      return { activeStep: 0, failed: false };
    case "discovering":
      return { activeStep: nodeCount > 0 ? 1 : 0, failed: false };
    case "syncing":
      return { activeStep: 2, failed: false };
    case "verifying":
      return { activeStep: 2, failed: false };
    case "ready":
      return { activeStep: 3, failed: false };
    case "timeout":
    case "error":
      return { activeStep: nodeCount > 0 ? 2 : 0, failed: true };
    default:
      return { activeStep: 0, failed: false };
  }
}

/** Dynamic ETA based on TDMA state */
function estimateRemainingSeconds(
  tdmaState: string,
  elapsedMs: number,
  completedFrames: number,
): string {
  if (tdmaState === "running" && completedFrames > 0) return "~1s";
  if (tdmaState === "running") return "~3s";
  if (tdmaState === "sync") return "~5s";
  if (tdmaState === "discovery") {
    const remainDiscovery = Math.max(0, 10 - Math.floor(elapsedMs / 1000));
    return `~${remainDiscovery + 3}s`;
  }
  return "~10s";
}

// ============================================================================
// Component
// ============================================================================

export function SyncStartupStatusCard() {
  const { isConnected, syncReady, syncPhase, syncState, pollSyncStatus } =
    useDeviceStore();
  const [isHidden, setIsHidden] = useState(false);
  const [elapsedDisplay, setElapsedDisplay] = useState(0);
  const startRef = useRef<number | null>(null);

  // Local elapsed timer (smoother than relying on poll intervals)
  useEffect(() => {
    if (isConnected && !syncReady) {
      startRef.current = Date.now();
      const timer = setInterval(() => {
        setElapsedDisplay(
          Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000),
        );
      }, 500);
      return () => clearInterval(timer);
    }
    startRef.current = null;
    setElapsedDisplay(0);
  }, [isConnected, syncReady]);

  const shouldShow = isConnected && !syncReady && !isHidden;

  const derived = useMemo(() => {
    const nodes = syncState?.nodes ?? [];
    const aliveNodes = nodes.filter((n) => n.alive).length;
    const detectedSensors = nodes.reduce((s, n) => s + (n.sensorCount || 0), 0);
    const syncRate = syncState?.syncBuffer.trueSyncRate ?? 0;
    const completedFrames = syncState?.syncBuffer.completedFrames ?? 0;
    const failureReasons = syncState?.failureReasons ?? [];
    const failureReason =
      syncState?.failureReason ??
      (failureReasons.length > 0 ? failureReasons[0] : undefined);

    return {
      nodes,
      aliveNodes,
      detectedSensors,
      syncRate,
      completedFrames,
      failureReason,
      failureReasons,
    };
  }, [syncState]);

  if (!shouldShow) return null;

  const phase = syncPhase || "connecting";
  const { activeStep, failed } = phaseToStep(phase, syncState?.nodeCount ?? 0);
  const isFailure = failed;
  const tdmaState = syncState?.tdmaState ?? "idle";
  const eta = estimateRemainingSeconds(
    tdmaState,
    syncState?.elapsedMs ?? 0,
    derived.completedFrames,
  );

  return (
    <div className="fixed top-20 right-4 z-50 w-80 max-w-[calc(100vw-2rem)]">
      <div
        className={cn(
          "rounded-xl border bg-bg-surface/95 backdrop-blur-md shadow-2xl p-4",
          isFailure ? "border-danger/50" : "border-accent/30",
        )}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-4">
          <div className="flex items-center gap-2">
            {isFailure ? (
              <ShieldAlert className="h-5 w-5 text-danger shrink-0" />
            ) : (
              <Loader2 className="h-5 w-5 text-accent shrink-0 animate-spin" />
            )}
            <div>
              <div className="text-sm font-semibold text-text-primary">
                Starting Up
              </div>
              <div className="text-[11px] text-text-secondary">
                {elapsedDisplay}s elapsed
                {!isFailure && <> &middot; ETA {eta}</>}
              </div>
            </div>
          </div>
          <button
            onClick={() => setIsHidden(true)}
            className="p-1 hover:bg-bg-elevated rounded-md transition-colors"
            title="Hide"
          >
            <X className="h-4 w-4 text-text-secondary" />
          </button>
        </div>

        {/* Stepper */}
        <div className="flex items-center gap-0 mb-4">
          {STEPS.map((step, i) => {
            const completed = i < activeStep || (i === 3 && phase === "ready");
            const active = i === activeStep && !completed && !isFailure;
            const failedStep = isFailure && i === activeStep;

            return (
              <div
                key={step.key}
                className="flex items-center flex-1 last:flex-none"
              >
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      "h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all",
                      completed && "bg-success text-bg-surface",
                      active && "bg-accent text-bg-surface",
                      failedStep && "bg-danger text-bg-surface",
                      !completed &&
                        !active &&
                        !failedStep &&
                        "bg-bg-elevated text-text-secondary border border-border",
                    )}
                  >
                    {completed ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : failedStep ? (
                      <AlertCircle className="h-3.5 w-3.5" />
                    ) : active ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Circle className="h-3 w-3" />
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-[9px] mt-1 whitespace-nowrap",
                      completed || active
                        ? "text-text-primary font-medium"
                        : "text-text-secondary",
                    )}
                  >
                    {step.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "h-0.5 flex-1 mx-1 -mt-3.5 rounded-full transition-colors",
                      i < activeStep ? "bg-success" : "bg-border",
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Node Discovery List */}
        {derived.nodes.length > 0 && (
          <div className="rounded-lg border border-border bg-bg-elevated p-2 mb-3">
            <div className="text-[10px] text-text-secondary mb-1.5 uppercase tracking-wider font-medium">
              Discovered Nodes
            </div>
            <div className="space-y-1">
              {derived.nodes.map((node) => (
                <div
                  key={node.nodeId}
                  className="flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        node.alive ? "bg-success" : "bg-text-secondary/40",
                      )}
                    />
                    <span className="text-text-primary font-medium truncate max-w-30">
                      {node.name || `Node ${node.nodeId}`}
                    </span>
                  </div>
                  <span className="text-text-secondary">
                    {node.sensorCount} sensor{node.sensorCount !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sync Quality (once syncing) */}
        {activeStep >= 2 && derived.syncRate > 0 && (
          <div className="rounded-lg border border-border bg-bg-elevated p-2 mb-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary">Sync Rate</span>
              <span
                className={cn(
                  "font-semibold",
                  derived.syncRate >= 80
                    ? "text-success"
                    : derived.syncRate >= 50
                      ? "text-warning"
                      : "text-danger",
                )}
              >
                {derived.syncRate.toFixed(0)}%
              </span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-border overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  derived.syncRate >= 80
                    ? "bg-success"
                    : derived.syncRate >= 50
                      ? "bg-warning"
                      : "bg-danger",
                )}
                style={{ width: `${Math.min(100, derived.syncRate)}%` }}
              />
            </div>
          </div>
        )}

        {/* Failure Panel */}
        {isFailure && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-2 mb-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-danger mt-0.5 shrink-0" />
              <div className="text-xs text-text-primary">
                <div className="font-medium mb-1">Sync failed</div>
                <div>
                  {derived.failureReason ||
                    "Readiness checks did not complete."}
                </div>
                {derived.failureReasons.length > 1 && (
                  <ul className="mt-1.5 list-disc pl-4 space-y-0.5 text-text-secondary">
                    {derived.failureReasons.slice(1).map((reason, i) => (
                      <li key={`${reason}-${i}`}>{reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Retry button (visible on failure) */}
        {isFailure && (
          <button
            onClick={() => void pollSyncStatus()}
            className="w-full rounded-lg border border-border px-3 py-2 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            Retry Sync Check
          </button>
        )}
      </div>
    </div>
  );
}
