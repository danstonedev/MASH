import { useEffect, useRef, useState } from "react";
import { useCalibrationStore } from "../../../store/useCalibrationStore";
import type { CalibrationReport } from "../../../store/useCalibrationStore";
import { cervicalCalManager } from "../../../calibration/CervicalCalibrationFunctions";
import { useSensorAssignmentStore } from "../../../store/useSensorAssignmentStore";
import { BodyRole } from "../../../biomech/topology/SensorRoles";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import {
  CheckCircle,
  Play,
  X,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Clock,
  Activity,
  Crosshair,
} from "lucide-react";
import { cn } from "../../../lib/utils";

export const CervicalCalibrationPanel = () => {
  const cervicalStep = useCalibrationStore((state) => state.cervicalStep);
  const frameRef = useRef<number | undefined>(undefined);

  // 1. Animation Loop (runs when step changes or re-renders)
  useEffect(() => {
    const loop = () => {
      cervicalCalManager.update();
      frameRef.current = requestAnimationFrame(loop);
    };

    if (cervicalStep !== "idle" && cervicalStep !== "verification") {
      loop();
    }

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [cervicalStep]);

  // 2. Unmount Cleanup (runs ONLY when component acts unmount)
  useEffect(() => {
    return () => {
      // Stop the manager if we unmount mid-calibration
      const currentStep = useCalibrationStore.getState().cervicalStep;
      if (currentStep !== "idle" && currentStep !== "verification") {
        cervicalCalManager.stop();
      }
    };
  }, []);

  const handleStart = () => {
    cervicalCalManager.start();
  };

  const handleStop = () => {
    cervicalCalManager.stop();
  };

  if (cervicalStep === "idle") {
    const headSensor = useSensorAssignmentStore
      .getState()
      .getSensorForRole(BodyRole.HEAD);
    return (
      <Card className="p-6 flex flex-col items-center gap-4 text-center">
        <h3 className="text-xl font-bold">Cervical Range of Motion</h3>
        <p className="text-gray-400">
          Calibrate a single head sensor using functional movements.
          <br />
          <span className="text-sm text-yellow-500">
            Wear the sensor anywhere on your head.
          </span>
        </p>
        {headSensor ? (
          <p className="text-xs text-gray-500">
            Using sensor:{" "}
            <span className="font-mono text-gray-300">{headSensor}</span>
          </p>
        ) : (
          <p className="text-xs text-yellow-400">
            No sensor assigned to HEAD — assign one in the mapping panel above.
          </p>
        )}
        <Button
          onClick={handleStart}
          className="w-full max-w-xs"
          variant="cyber"
          disabled={!headSensor}
        >
          <Play className="w-4 h-4 mr-2" />
          Start Calibration
        </Button>
      </Card>
    );
  }

  if (cervicalStep === "verification") {
    return <VerificationGame />;
  }

  return (
    <Card className="p-6 flex flex-col items-center gap-6 text-center animate-in fade-in slide-in-from-bottom-4">
      <StepIndicator step={cervicalStep} />

      <div className="min-h-[120px] flex flex-col justify-center">
        <InstructionContent step={cervicalStep} />
      </div>

      <Button
        onClick={handleStop}
        variant="outline"
        className="mt-4 border-red-500 text-red-400 hover:bg-red-950"
      >
        <X className="w-4 h-4 mr-2" />
        Cancel
      </Button>
    </Card>
  );
};

const StepIndicator = ({ step }: { step: string }) => {
  const steps = ["stationary_start", "rom_nod", "rom_shake", "calculating"];
  const currentIdx = steps.indexOf(step);

  // Map internal steps to progress index
  let displayIdx = currentIdx;
  if (step === "stationary_end") displayIdx = 2; // Treat as part of shake phase or just end

  return (
    <div className="flex gap-2 w-full justify-center">
      {steps.map((s, i) => (
        <div
          key={s}
          className={cn(
            "h-2 flex-1 rounded-full transition-all",
            i < displayIdx
              ? "bg-green-500"
              : i === displayIdx
                ? "bg-blue-500 animate-pulse"
                : "bg-gray-700",
          )}
        />
      ))}
    </div>
  );
};

const InstructionContent = ({ step }: { step: string }) => {
  switch (step) {
    case "stationary_start":
      return (
        <>
          <h2 className="text-2xl font-bold mb-2">Hold Still</h2>
          <p className="text-gray-400">Look straight ahead, hold still...</p>
          <div className="text-4xl mt-4">🛑</div>
        </>
      );
    case "rom_nod":
      return (
        <>
          <h2 className="text-2xl font-bold mb-2">Nod "YES" × 3</h2>
          <p className="text-gray-400">
            Nod up and down 3 times, then hold still.
          </p>
          <div className="text-4xl mt-4 animate-bounce">↕️</div>
        </>
      );
    case "rom_shake":
      return (
        <>
          <h2 className="text-2xl font-bold mb-2">Shake "NO" × 3</h2>
          <p className="text-gray-400">
            Shake left and right 3 times, then hold still.
          </p>
          <div className="text-4xl mt-4">↔️</div>
        </>
      );
    case "rom_tilt":
      return (
        <>
          <h2 className="text-2xl font-bold mb-2">Tilt Head</h2>
          <p className="text-gray-400">Ear to shoulder, Left and Right.</p>
          <div className="text-4xl mt-4">⤵️</div>
        </>
      );
    case "stationary_end":
      return (
        <>
          <h2 className="text-2xl font-bold mb-2">Hold Still</h2>
          <p className="text-gray-400">Verifying drift...</p>
          <div className="text-4xl mt-4">🛑</div>
        </>
      );
    case "calculating":
      return (
        <>
          <h2 className="text-2xl font-bold mb-2">Calculating</h2>
          <p className="text-gray-400">Aligning head frame...</p>
          <RefreshCw className="w-12 h-12 mx-auto mt-4 animate-spin text-blue-500" />
        </>
      );
    default:
      return null;
  }
};

const VerificationGame = () => {
  const report = useCalibrationStore((state) => state.calibrationReport);
  const [showDetails, setShowDetails] = useState(false);

  const handleReset = () => {
    cervicalCalManager.stop();
  };

  const isPoor = report ? report.pcaConfidence < 0.5 : false;
  const hasTimeouts = report
    ? report.steps.some((s) => s.status === "timeout")
    : false;

  return (
    <Card
      className={cn(
        "p-6 flex flex-col items-center gap-4 text-center",
        isPoor
          ? "border-yellow-500/30 bg-yellow-950/10"
          : "border-green-500/30 bg-green-950/10",
      )}
    >
      {isPoor ? (
        <AlertTriangle className="w-12 h-12 text-yellow-500" />
      ) : (
        <CheckCircle className="w-12 h-12 text-green-500" />
      )}
      <h3 className="text-xl font-bold">
        {isPoor ? "Calibration Needs Improvement" : "Calibration Complete"}
      </h3>
      <p className="text-gray-400">
        {isPoor ? (
          <>
            Calibration quality is low{hasTimeouts ? " (steps timed out)" : ""}.
            <br />
            <span className="text-yellow-400 text-sm">
              Try again with more deliberate nod/shake motions then hold
              completely still.
            </span>
          </>
        ) : (
          <>
            Sensor is now aligned to your head.
            <br />
            Try moving your head to verify the model matches.
          </>
        )}
      </p>

      {report && (
        <CalibrationReportCard
          report={report}
          showDetails={showDetails}
          setShowDetails={setShowDetails}
        />
      )}

      <Button
        onClick={handleReset}
        variant="outline"
        className={cn(
          "w-full",
          isPoor && "border-yellow-500 text-yellow-400 hover:bg-yellow-950",
        )}
      >
        <RefreshCw className="w-4 h-4 mr-2" />
        {isPoor ? "Try Again" : "Recalibrate"}
      </Button>
    </Card>
  );
};

/** Confidence badge color */
const confidenceColor = (conf: number) => {
  if (conf >= 0.85) return "text-green-400 bg-green-900/40 border-green-500/30";
  if (conf >= 0.7) return "text-blue-400 bg-blue-900/40 border-blue-500/30";
  if (conf >= 0.5)
    return "text-yellow-400 bg-yellow-900/40 border-yellow-500/30";
  return "text-red-400 bg-red-900/40 border-red-500/30";
};

/** Format ms to human-readable */
const fmtMs = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const CalibrationReportCard = ({
  report,
  showDetails,
  setShowDetails,
}: {
  report: CalibrationReport;
  showDetails: boolean;
  setShowDetails: (v: boolean) => void;
}) => {
  const hasTimeouts = report.steps.some((s) => s.status === "timeout");

  return (
    <div className="w-full text-left space-y-3">
      {/* Summary Bar */}
      <div className="flex items-center justify-between gap-2">
        <div
          className={cn(
            "px-3 py-1 rounded-full text-sm font-semibold border",
            confidenceColor(report.pcaConfidence),
          )}
        >
          {report.pcaConfidenceLabel} ({(report.pcaConfidence * 100).toFixed(0)}
          %)
        </div>
        <div className="flex items-center gap-1.5 text-gray-400 text-sm">
          <Clock className="w-3.5 h-3.5" />
          {fmtMs(report.totalDurationMs)}
        </div>
        {hasTimeouts && (
          <div className="flex items-center gap-1 text-yellow-400 text-xs">
            <AlertTriangle className="w-3.5 h-3.5" />
            Timeout
          </div>
        )}
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="bg-gray-800/50 rounded px-3 py-2">
          <div className="text-gray-500 text-xs">Nod Samples</div>
          <div className="font-mono text-gray-200">{report.nodSamples}</div>
        </div>
        <div className="bg-gray-800/50 rounded px-3 py-2">
          <div className="text-gray-500 text-xs">Shake Samples</div>
          <div className="font-mono text-gray-200">{report.shakeSamples}</div>
        </div>
      </div>

      {/* Gyro Bias */}
      <div className="bg-gray-800/50 rounded px-3 py-2 text-sm">
        <div className="flex items-center gap-1.5 text-gray-500 text-xs mb-1">
          <Activity className="w-3 h-3" />
          Gyro Bias Correction
        </div>
        {report.hasBiasCorrection && report.gyroBias ? (
          <div className="font-mono text-green-400 text-xs">
            [{report.gyroBias.x.toFixed(4)}, {report.gyroBias.y.toFixed(4)},{" "}
            {report.gyroBias.z.toFixed(4)}] rad/s
          </div>
        ) : (
          <div className="text-yellow-400 text-xs">
            No bias captured (first run)
          </div>
        )}
      </div>

      {/* Step Timing */}
      <div className="space-y-1">
        <div className="text-gray-500 text-xs font-medium flex items-center gap-1">
          <Clock className="w-3 h-3" />
          Step Timing
        </div>
        {report.steps.map((step, i) => (
          <div
            key={i}
            className="flex items-center justify-between text-xs bg-gray-800/30 rounded px-2 py-1"
          >
            <span className="text-gray-300">
              {step.name.replace(/_/g, " ")}
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-gray-400">
                {fmtMs(step.durationMs)}
              </span>
              <span
                className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] font-medium",
                  step.status === "completed"
                    ? "bg-green-900/40 text-green-400"
                    : step.status === "timeout"
                      ? "bg-yellow-900/40 text-yellow-400"
                      : "bg-gray-700 text-gray-400",
                )}
              >
                {step.status}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Expandable Details */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors w-full justify-center"
      >
        {showDetails ? (
          <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
        {showDetails ? "Hide" : "Show"} Transform Details
      </button>

      {showDetails && (
        <div className="space-y-2 text-xs border-t border-gray-700/50 pt-2">
          <div className="flex items-center gap-1.5 text-gray-500 text-xs mb-1">
            <Crosshair className="w-3 h-3" />
            Transform Quaternions
          </div>
          {[
            { label: "Axis Alignment", q: report.axisAlignment },
            { label: "Frame Alignment", q: report.frameAlignment },
            { label: "Heading Tare", q: report.headingTare },
            { label: "Mounting Tare", q: report.mountingTare },
          ].map(({ label, q }) => (
            <div key={label} className="bg-gray-800/30 rounded px-2 py-1">
              <div className="text-gray-500 mb-0.5">{label}</div>
              <div className="font-mono text-gray-300">
                [{q.w.toFixed(4)}, {q.x.toFixed(4)}, {q.y.toFixed(4)},{" "}
                {q.z.toFixed(4)}]
              </div>
            </div>
          ))}
          {report.sensorId && (
            <div className="bg-gray-800/30 rounded px-2 py-1">
              <div className="text-gray-500 mb-0.5">Sensor ID</div>
              <div className="font-mono text-gray-300">{report.sensorId}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
