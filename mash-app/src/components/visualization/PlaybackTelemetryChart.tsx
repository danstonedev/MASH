/**
 * Playback Telemetry Chart
 * ========================
 *
 * Displays time-series sensor data during session playback:
 * - Quaternion (w, x, y, z)
 * - Accelerometer (x, y, z)
 * - Gyroscope (x, y, z)
 *
 * Uses uPlot for high-performance rendering.
 * Syncs with playback timeline cursor.
 */

import { useEffect, useRef, useState, useMemo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import * as THREE from "three";
import { ChevronDown, ChevronRight, BarChart3 } from "lucide-react";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { getSensorDisplayName } from "../../lib/sensorDisplayName";

type DataMode = "quaternion" | "accelerometer" | "gyroscope";

const MODE_CONFIG: Record<
  DataMode,
  {
    label: string;
    series: { label: string; color: string; key: string }[];
    yRange: [number, number];
    unit: string;
  }
> = {
  quaternion: {
    label: "Orientation",
    series: [
      { label: "W", color: "#a855f7", key: "qw" },
      { label: "X", color: "#ef4444", key: "qx" },
      { label: "Y", color: "#22c55e", key: "qy" },
      { label: "Z", color: "#3b82f6", key: "qz" },
    ],
    yRange: [-1.1, 1.1],
    unit: "",
  },
  accelerometer: {
    label: "Acceleration",
    series: [
      { label: "X", color: "#ef4444", key: "ax" },
      { label: "Y", color: "#22c55e", key: "ay" },
      { label: "Z", color: "#3b82f6", key: "az" },
    ],
    yRange: [-20, 20],
    unit: "m/s²",
  },
  gyroscope: {
    label: "Angular Velocity",
    series: [
      { label: "X", color: "#ef4444", key: "gx" },
      { label: "Y", color: "#22c55e", key: "gy" },
      { label: "Z", color: "#3b82f6", key: "gz" },
    ],
    yRange: [-500, 500],
    unit: "°/s",
  },
};

interface PlaybackTelemetryChartProps {
  sensorId: number;
  className?: string;
}

export function PlaybackTelemetryChart({
  sensorId,
  className,
}: PlaybackTelemetryChartProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [mode, setMode] = useState<DataMode>("quaternion");

  const chartRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);

  const frames = usePlaybackStore((state) => state.frames);
  const framesBySensor = usePlaybackStore((state) => state.framesBySensor);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const duration = usePlaybackStore((state) => state.duration);

  const config = MODE_CONFIG[mode];

  // Get frames for this sensor
  const sensorFrames = useMemo(() => {
    return framesBySensor.get(sensorId) || [];
  }, [framesBySensor, sensorId]);

  // Get calibration offset for this sensor's segment
  const sensorMapping = usePlaybackStore((state) => state.sensorMapping);
  const calibrationOffsets = usePlaybackStore(
    (state) => state.calibrationOffsets,
  );

  const calibrationOffset = useMemo(() => {
    const segmentId = sensorMapping[sensorId];
    if (!segmentId) return null;
    const offset = calibrationOffsets.find(
      (o) => o.segmentId.toLowerCase() === segmentId.toLowerCase(),
    );
    if (!offset) return null;
    // Return the inverse for correcting orientation: calibratedQuat = offsetInv * rawQuat
    const offsetQuat = new THREE.Quaternion(
      offset.offset[1],
      offset.offset[2],
      offset.offset[3],
      offset.offset[0],
    );
    return offsetQuat.invert();
  }, [sensorMapping, sensorId, calibrationOffsets]);

  // Prepare chart data
  const chartData = useMemo((): uPlot.AlignedData | null => {
    if (sensorFrames.length === 0) return null;

    const baseTime = frames[0]?.timestamp || 0;
    const times: number[] = [];
    const dataColumns: number[][] = config.series.map(() => []);

    for (const frame of sensorFrames) {
      times.push((frame.timestamp - baseTime) / 1000); // Seconds

      // Apply calibration to quaternion if available
      let calibratedQuat: THREE.Quaternion | null = null;
      if (mode === "quaternion" && calibrationOffset) {
        const rawQuat = new THREE.Quaternion(
          frame.quaternion[1], // x
          frame.quaternion[2], // y
          frame.quaternion[3], // z
          frame.quaternion[0], // w
        );
        calibratedQuat = calibrationOffset.clone().multiply(rawQuat);
      }

      // Apply calibration to accelerometer vector (rotate to body segment frame)
      let calibratedAccel: THREE.Vector3 | null = null;
      if (
        mode === "accelerometer" &&
        calibrationOffset &&
        frame.accelerometer
      ) {
        const rawAccel = new THREE.Vector3(
          frame.accelerometer[0],
          frame.accelerometer[1],
          frame.accelerometer[2],
        );
        calibratedAccel = rawAccel.applyQuaternion(calibrationOffset);
      }

      // Apply calibration to gyroscope vector (rotate to body segment frame)
      let calibratedGyro: THREE.Vector3 | null = null;
      if (mode === "gyroscope" && calibrationOffset && frame.gyro) {
        const rawGyro = new THREE.Vector3(
          frame.gyro[0],
          frame.gyro[1],
          frame.gyro[2],
        );
        calibratedGyro = rawGyro.applyQuaternion(calibrationOffset);
      }

      config.series.forEach((s, i) => {
        let value = 0;
        if (s.key === "qw")
          value = calibratedQuat ? calibratedQuat.w : frame.quaternion[0];
        else if (s.key === "qx")
          value = calibratedQuat ? calibratedQuat.x : frame.quaternion[1];
        else if (s.key === "qy")
          value = calibratedQuat ? calibratedQuat.y : frame.quaternion[2];
        else if (s.key === "qz")
          value = calibratedQuat ? calibratedQuat.z : frame.quaternion[3];
        else if (s.key === "ax")
          value = calibratedAccel
            ? calibratedAccel.x
            : frame.accelerometer?.[0] || 0;
        else if (s.key === "ay")
          value = calibratedAccel
            ? calibratedAccel.y
            : frame.accelerometer?.[1] || 0;
        else if (s.key === "az")
          value = calibratedAccel
            ? calibratedAccel.z
            : frame.accelerometer?.[2] || 0;
        else if (s.key === "gx")
          value = calibratedGyro ? calibratedGyro.x : frame.gyro?.[0] || 0;
        else if (s.key === "gy")
          value = calibratedGyro ? calibratedGyro.y : frame.gyro?.[1] || 0;
        else if (s.key === "gz")
          value = calibratedGyro ? calibratedGyro.z : frame.gyro?.[2] || 0;

        dataColumns[i].push(value);
      });
    }

    return [times, ...dataColumns];
  }, [sensorFrames, frames, config.series, mode, calibrationOffset]);

  // Initialize uPlot
  useEffect(() => {
    if (!chartRef.current || !chartData) return;

    // Destroy existing chart
    if (uplotRef.current) {
      uplotRef.current.destroy();
      uplotRef.current = null;
    }

    const seriesConfig: uPlot.Series[] = [
      { label: "Time" },
      ...config.series.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: 1.5,
      })),
    ];

    const opts: uPlot.Options = {
      width: chartRef.current.clientWidth,
      height: 120,
      series: seriesConfig,
      scales: {
        x: { time: false },
        y: { range: config.yRange },
      },
      axes: [
        {
          show: true,
          stroke: "#888",
          grid: { stroke: "#333" },
          font: "10px sans-serif",
          size: 24,
        },
        {
          stroke: "#888",
          grid: { stroke: "#333", width: 1 },
          font: "10px sans-serif",
          size: 45,
          values: (_, vals) => vals.map((v) => `${v}${config.unit}`),
        },
      ],
      cursor: {
        show: true,
        x: true,
        y: false,
        drag: { x: false, y: false },
      },
      legend: { show: false },
    };

    const u = new uPlot(opts, chartData, chartRef.current);
    uplotRef.current = u;

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current && uplotRef.current) {
        uplotRef.current.setSize({
          width: chartRef.current.clientWidth,
          height: 120,
        });
      }
    });
    resizeObserver.observe(chartRef.current);

    return () => {
      resizeObserver.disconnect();
      if (uplotRef.current) {
        uplotRef.current.destroy();
        uplotRef.current = null;
      }
    };
  }, [chartData, config]);

  // Sync cursor with playback position
  useEffect(() => {
    if (!uplotRef.current || duration === 0) return;

    const timeInSeconds = currentTime / 1000;
    // Calculate pixel position for cursor
    const left = uplotRef.current.valToPos(timeInSeconds, "x");
    if (left >= 0) {
      uplotRef.current.setCursor({ left, top: 0 });
    }
  }, [currentTime, duration]);

  if (sensorFrames.length === 0) {
    return null;
  }

  return (
    <div
      className={`bg-bg-elevated/50 border border-border rounded-lg overflow-hidden ${className || ""}`}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-text-secondary" />
          )}
          <BarChart3 className="w-3.5 h-3.5 text-accent" />
          <span className="text-xs font-medium text-text-primary">
            {getSensorDisplayName(sensorId)} - {config.label}
          </span>
        </div>

        {/* Mode Selector */}
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          {(["quaternion", "accelerometer", "gyroscope"] as DataMode[]).map(
            (m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                  mode === m
                    ? "bg-accent/20 text-accent"
                    : "text-text-secondary hover:bg-white/5"
                }`}
              >
                {m === "quaternion"
                  ? "Quat"
                  : m === "accelerometer"
                    ? "Accel"
                    : "Gyro"}
              </button>
            ),
          )}
        </div>
      </div>

      {/* Chart */}
      {isExpanded && (
        <div className="px-2 pb-2">
          <div ref={chartRef} className="w-full" style={{ height: 120 }} />

          {/* Legend */}
          <div className="flex justify-center gap-4 mt-1">
            {config.series.map((s) => (
              <div key={s.key} className="flex items-center gap-1">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-[9px] text-text-secondary">
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Container component that shows charts for all sensors in the session
 */
export function PlaybackTelemetryCharts() {
  const sensorIds = usePlaybackStore((state) => state.sensorIds);
  const sessionId = usePlaybackStore((state) => state.sessionId);

  if (!sessionId || sensorIds.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-text-secondary uppercase px-1">
        Sensor Telemetry
      </h4>
      {sensorIds.map((id) => (
        <PlaybackTelemetryChart key={id} sensorId={id} />
      ))}
    </div>
  );
}

// =============================================================================
// JOINT ANGLE CHARTS
// =============================================================================

import { Activity } from "lucide-react";
import {
  JOINT_DEFINITIONS,
  calculateJointAngle,
  type JointAngles,
} from "../../biomech/jointAngles";

interface JointAngleChartConfig {
  jointId: string;
  name: string;
  series: { label: string; color: string; key: keyof JointAngles }[];
  yRange: [number, number];
}

const JOINT_CHART_CONFIGS: JointAngleChartConfig[] = [
  {
    jointId: "hip_l",
    name: "Left Hip",
    series: [
      { label: "Flex", color: "#ef4444", key: "flexion" },
      { label: "Abd", color: "#22c55e", key: "abduction" },
      { label: "Rot", color: "#3b82f6", key: "rotation" },
    ],
    yRange: [-60, 120],
  },
  {
    jointId: "hip_r",
    name: "Right Hip",
    series: [
      { label: "Flex", color: "#ef4444", key: "flexion" },
      { label: "Abd", color: "#22c55e", key: "abduction" },
      { label: "Rot", color: "#3b82f6", key: "rotation" },
    ],
    yRange: [-60, 120],
  },
  {
    jointId: "knee_l",
    name: "Left Knee",
    series: [
      { label: "Flex", color: "#ef4444", key: "flexion" },
      { label: "Varus", color: "#22c55e", key: "abduction" },
      { label: "Rot", color: "#3b82f6", key: "rotation" },
    ],
    yRange: [-20, 150],
  },
  {
    jointId: "knee_r",
    name: "Right Knee",
    series: [
      { label: "Flex", color: "#ef4444", key: "flexion" },
      { label: "Varus", color: "#22c55e", key: "abduction" },
      { label: "Rot", color: "#3b82f6", key: "rotation" },
    ],
    yRange: [-20, 150],
  },
];

interface PlaybackJointAngleChartProps {
  config: JointAngleChartConfig;
  className?: string;
}

export function PlaybackJointAngleChart({
  config,
  className,
}: PlaybackJointAngleChartProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const chartRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);

  const frames = usePlaybackStore((state) => state.frames);
  const sensorMapping = usePlaybackStore((state) => state.sensorMapping);
  const framesBySensor = usePlaybackStore((state) => state.framesBySensor);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const duration = usePlaybackStore((state) => state.duration);

  const jointDef = JOINT_DEFINITIONS[config.jointId];

  // Find sensor IDs for parent and child segments
  const parentSensorId = useMemo(() => {
    for (const [id, segment] of Object.entries(sensorMapping)) {
      if (segment.toLowerCase() === jointDef?.parentSegment.toLowerCase()) {
        return parseInt(id);
      }
    }
    return null;
  }, [sensorMapping, jointDef]);

  const childSensorId = useMemo(() => {
    for (const [id, segment] of Object.entries(sensorMapping)) {
      if (segment.toLowerCase() === jointDef?.childSegment.toLowerCase()) {
        return parseInt(id);
      }
    }
    return null;
  }, [sensorMapping, jointDef]);

  // Check if we have both sensors needed for this joint
  const hasRequiredSensors = parentSensorId !== null && childSensorId !== null;

  // Get calibration offsets for parent and child segments
  const calibrationOffsets = usePlaybackStore(
    (state) => state.calibrationOffsets,
  );

  const parentCalibrationOffset = useMemo(() => {
    if (!jointDef) return null;
    const offset = calibrationOffsets.find(
      (o) => o.segmentId.toLowerCase() === jointDef.parentSegment.toLowerCase(),
    );
    if (!offset) return null;
    const offsetQuat = new THREE.Quaternion(
      offset.offset[1],
      offset.offset[2],
      offset.offset[3],
      offset.offset[0],
    );
    return offsetQuat.invert();
  }, [calibrationOffsets, jointDef]);

  const childCalibrationOffset = useMemo(() => {
    if (!jointDef) return null;
    const offset = calibrationOffsets.find(
      (o) => o.segmentId.toLowerCase() === jointDef.childSegment.toLowerCase(),
    );
    if (!offset) return null;
    const offsetQuat = new THREE.Quaternion(
      offset.offset[1],
      offset.offset[2],
      offset.offset[3],
      offset.offset[0],
    );
    return offsetQuat.invert();
  }, [calibrationOffsets, jointDef]);

  // Compute joint angles from frame data
  const chartData = useMemo((): uPlot.AlignedData | null => {
    if (!hasRequiredSensors || !jointDef) return null;

    const parentFrames = framesBySensor.get(parentSensorId!) || [];
    const childFrames = framesBySensor.get(childSensorId!) || [];

    if (parentFrames.length === 0 || childFrames.length === 0) return null;

    const baseTime = frames[0]?.timestamp || 0;
    const times: number[] = [];
    const flexionData: number[] = [];
    const abductionData: number[] = [];
    const rotationData: number[] = [];

    // Use parent frames as reference timing (interpolate child)
    for (const parentFrame of parentFrames) {
      const time = parentFrame.timestamp;

      // Find nearest child frame
      let nearestChild = childFrames[0];
      let minDiff = Math.abs(childFrames[0].timestamp - time);
      for (const cf of childFrames) {
        const diff = Math.abs(cf.timestamp - time);
        if (diff < minDiff) {
          minDiff = diff;
          nearestChild = cf;
        }
      }

      // Create raw quaternions
      let parentQuat = new THREE.Quaternion(
        parentFrame.quaternion[1], // x
        parentFrame.quaternion[2], // y
        parentFrame.quaternion[3], // z
        parentFrame.quaternion[0], // w (first in array)
      );
      let childQuat = new THREE.Quaternion(
        nearestChild.quaternion[1],
        nearestChild.quaternion[2],
        nearestChild.quaternion[3],
        nearestChild.quaternion[0],
      );

      // Apply calibration offsets if available
      if (parentCalibrationOffset) {
        parentQuat = parentCalibrationOffset.clone().multiply(parentQuat);
      }
      if (childCalibrationOffset) {
        childQuat = childCalibrationOffset.clone().multiply(childQuat);
      }

      // Calculate joint angle
      const angles = calculateJointAngle(parentQuat, childQuat, config.jointId);

      times.push((time - baseTime) / 1000);
      flexionData.push(angles.flexion);
      abductionData.push(angles.abduction);
      rotationData.push(angles.rotation);
    }

    return [times, flexionData, abductionData, rotationData];
  }, [
    hasRequiredSensors,
    parentSensorId,
    childSensorId,
    framesBySensor,
    frames,
    jointDef,
    config.jointId,
    parentCalibrationOffset,
    childCalibrationOffset,
  ]);

  // Initialize uPlot
  useEffect(() => {
    if (!chartRef.current || !chartData) return;

    if (uplotRef.current) {
      uplotRef.current.destroy();
      uplotRef.current = null;
    }

    const seriesConfig: uPlot.Series[] = [
      { label: "Time" },
      ...config.series.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: 1.5,
      })),
    ];

    const opts: uPlot.Options = {
      width: chartRef.current.clientWidth,
      height: 120,
      series: seriesConfig,
      scales: {
        x: { time: false },
        y: { range: config.yRange },
      },
      axes: [
        {
          show: true,
          stroke: "#888",
          grid: { stroke: "#333" },
          font: "10px sans-serif",
          size: 24,
        },
        {
          stroke: "#888",
          grid: { stroke: "#333", width: 1 },
          font: "10px sans-serif",
          size: 45,
          values: (_, vals) => vals.map((v) => `${v}°`),
        },
      ],
      cursor: {
        show: true,
        x: true,
        y: false,
        drag: { x: false, y: false },
      },
      legend: { show: false },
    };

    const u = new uPlot(opts, chartData, chartRef.current);
    uplotRef.current = u;

    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current && uplotRef.current) {
        uplotRef.current.setSize({
          width: chartRef.current.clientWidth,
          height: 120,
        });
      }
    });
    resizeObserver.observe(chartRef.current);

    return () => {
      resizeObserver.disconnect();
      if (uplotRef.current) {
        uplotRef.current.destroy();
        uplotRef.current = null;
      }
    };
  }, [chartData, config]);

  // Sync cursor with playback
  useEffect(() => {
    if (!uplotRef.current || duration === 0) return;
    const timeInSeconds = currentTime / 1000;
    const left = uplotRef.current.valToPos(timeInSeconds, "x");
    if (left >= 0) {
      uplotRef.current.setCursor({ left, top: 0 });
    }
  }, [currentTime, duration]);

  // Don't render if we don't have the required sensors
  if (!hasRequiredSensors || !chartData) {
    return null;
  }

  return (
    <div
      className={`bg-bg-elevated/50 border border-border rounded-lg overflow-hidden ${className || ""}`}
    >
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-text-secondary" />
          )}
          <Activity className="w-3.5 h-3.5 text-accent" />
          <span className="text-xs font-medium text-text-primary">
            {config.name}
          </span>
        </div>
      </div>

      {isExpanded && (
        <div className="px-2 pb-2">
          <div ref={chartRef} className="w-full" style={{ height: 120 }} />

          <div className="flex justify-center gap-4 mt-1">
            {config.series.map((s) => (
              <div key={s.key} className="flex items-center gap-1">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-[9px] text-text-secondary">
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Container for all joint angle charts
 */
export function PlaybackJointAngleCharts() {
  const sessionId = usePlaybackStore((state) => state.sessionId);
  const sensorMapping = usePlaybackStore((state) => state.sensorMapping);

  if (!sessionId || Object.keys(sensorMapping).length === 0) {
    return null;
  }

  // Filter to only show joints where we have both parent and child sensors
  const availableConfigs = JOINT_CHART_CONFIGS.filter((config) => {
    const jointDef = JOINT_DEFINITIONS[config.jointId];
    if (!jointDef) return false;

    const segments = Object.values(sensorMapping).map((s) => s.toLowerCase());
    const hasParent = segments.includes(jointDef.parentSegment.toLowerCase());
    const hasChild = segments.includes(jointDef.childSegment.toLowerCase());

    return hasParent && hasChild;
  });

  if (availableConfigs.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-text-secondary uppercase px-1">
        Joint Angles
      </h4>
      {availableConfigs.map((config) => (
        <PlaybackJointAngleChart key={config.jointId} config={config} />
      ))}
    </div>
  );
}
