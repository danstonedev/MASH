/**
 * Session Analyzer
 *
 * Post-hoc analysis of recorded sessions.
 * Runs the same algorithms as live mode but on stored data.
 *
 * Features:
 * - Full session analysis with all metrics
 * - Activity timeline detection
 * - Gait analysis for walking segments
 * - Azure-ready JSON export format
 */

import * as THREE from "three";
import { dataManager, type RecordedFrame } from "../lib/db";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";
import {
  extractFeatures,
  classifyActivity,
  type ActivityClass,
  type FeatureVector,
  type SensorRegion,
} from "./MovementAnalysisEngine";
import { firmwareToThreeQuat } from "../lib/math/conventions";
import { type GaitMetrics } from "./GaitAnalyzer";

// ============================================================================
// TYPES
// ============================================================================

export interface AnalysisSegment {
  activity: ActivityClass;
  startTime: number; // ms since session start
  endTime: number;
  duration: number; // ms
  confidence: number;
  features: FeatureVector;
}

export interface GaitSegment {
  startTime: number;
  endTime: number;
  metrics: GaitMetrics;
  stepCount: number;
}

export interface SessionAnalysisResult {
  // Metadata
  sessionId: string;
  sessionName: string;
  analyzedAt: number;
  totalDuration: number; // ms
  frameCount: number;

  // Sensor context - what body parts were instrumented
  sensorRegion: SensorRegion;
  instrumentedSegments: string[]; // e.g. ['head'], ['pelvis','thigh_r','shank_r']

  // Activity breakdown
  activitySegments: AnalysisSegment[];
  activitySummary: Record<ActivityClass, number>; // total ms per activity

  // Gait analysis (for walking/running segments)
  gaitSegments: GaitSegment[];
  overallGaitMetrics?: GaitMetrics;

  // Step metrics
  totalSteps: number;
  averageCadence: number;

  // Quality metrics
  dataQuality: {
    missingFrames: number;
    sensorCount: number;
    averageSampleRate: number;
  };

  // Raw data for Azure upload
  rawFeatures?: FeatureVector[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const WINDOW_SIZE = 128; // ~2s at 60Hz
const WINDOW_STEP = 64; // 50% overlap
const MIN_SEGMENT_MS = 1000; // Minimum 1s to count as activity segment

// ============================================================================
// SESSION ANALYZER
// ============================================================================

export class SessionAnalyzer {
  /**
   * Analyze a recorded session
   */
  async analyzeSession(
    sessionId: string,
  ): Promise<SessionAnalysisResult | null> {
    // Load session metadata
    const session = await dataManager.getSession(sessionId);
    if (!session) {
      console.error(`[SessionAnalyzer] Session ${sessionId} not found`);
      return null;
    }

    // Load all frames
    const frames = await dataManager.exportSessionData(sessionId);

    if (frames.length === 0) {
      console.error(`[SessionAnalyzer] No frames for session ${sessionId}`);
      return null;
    }

    console.debug(
      `[SessionAnalyzer] Analyzing ${frames.length} frames from "${session.name}"`,
    );

    // Group frames by sensor
    const sensorFrames = this.groupBySensor(frames);
    const sensorCount = sensorFrames.size;

    // Determine which body segments are instrumented
    const instrumentedSegments = this.getInstrumentedSegments(frames, session);
    const sensorRegion = this.classifySensorRegion(instrumentedSegments);
    console.debug(
      `[SessionAnalyzer] Sensor region: ${sensorRegion}, segments: [${instrumentedSegments.join(", ")}]`,
    );

    // Use pelvis sensor if available, otherwise first sensor
    const primarySensorId = this.findPrimarySensor(sensorFrames);
    const primaryFrames = sensorFrames.get(primarySensorId) || frames;

    // Calculate sample rate
    const totalDuration =
      primaryFrames[primaryFrames.length - 1].timestamp -
      primaryFrames[0].timestamp;
    const averageSampleRate = primaryFrames.length / (totalDuration / 1000);

    // Run activity detection (with sensor context)
    const { segments, features } = this.detectActivities(
      primaryFrames,
      sensorRegion,
    );

    // Calculate activity summary
    const activitySummary = this.calculateActivitySummary(segments);

    // Run gait analysis on walking/running segments
    const walkingSegments = segments.filter(
      (s) => s.activity === "walking" || s.activity === "running",
    );
    const gaitSegments = this.analyzeGaitSegments(frames, walkingSegments);

    // Calculate overall gait metrics
    const overallGaitMetrics =
      gaitSegments.length > 0
        ? this.calculateOverallGait(gaitSegments)
        : undefined;

    // Calculate total steps
    const totalSteps = gaitSegments.reduce((sum, g) => sum + g.stepCount, 0);
    const walkingDuration = activitySummary.walking + activitySummary.running;
    const averageCadence =
      walkingDuration > 0 ? totalSteps / (walkingDuration / 60000) : 0;

    return {
      sessionId,
      sessionName: session.name,
      analyzedAt: Date.now(),
      totalDuration,
      frameCount: frames.length,

      sensorRegion,
      instrumentedSegments,

      activitySegments: segments,
      activitySummary,

      gaitSegments,
      overallGaitMetrics,

      totalSteps,
      averageCadence: Math.round(averageCadence),

      dataQuality: {
        missingFrames: this.countMissingFrames(
          primaryFrames,
          averageSampleRate,
        ),
        sensorCount,
        averageSampleRate: Math.round(averageSampleRate * 10) / 10,
      },

      rawFeatures: features,
    };
  }

  /**
   * Group frames by sensor ID
   */
  private groupBySensor(frames: RecordedFrame[]): Map<number, RecordedFrame[]> {
    const grouped = new Map<number, RecordedFrame[]>();
    frames.forEach((frame) => {
      const sensorId = frame.sensorId || 0;
      if (!grouped.has(sensorId)) {
        grouped.set(sensorId, []);
      }
      grouped.get(sensorId)!.push(frame);
    });
    return grouped;
  }

  /**
   * Find primary sensor (prefer pelvis/torso)
   */
  private findPrimarySensor(
    sensorFrames: Map<number, RecordedFrame[]>,
  ): number {
    // Just return first sensor with most frames for now
    // Could be enhanced to detect pelvis based on movement patterns
    let maxFrames = 0;
    let primaryId = 0;
    sensorFrames.forEach((frames, id) => {
      if (frames.length > maxFrames) {
        maxFrames = frames.length;
        primaryId = id;
      }
    });
    return primaryId;
  }

  /**
   * Detect activities using sliding window (with sensor-region context)
   */
  private detectActivities(
    frames: RecordedFrame[],
    sensorRegion: SensorRegion = "unknown",
  ): {
    segments: AnalysisSegment[];
    features: FeatureVector[];
  } {
    const allFeatures: FeatureVector[] = [];
    const rawDetections: {
      timestamp: number;
      activity: ActivityClass;
      confidence: number;
      features: FeatureVector;
    }[] = [];

    // Sliding window analysis
    for (let i = 0; i <= frames.length - WINDOW_SIZE; i += WINDOW_STEP) {
      const windowFrames = frames.slice(i, i + WINDOW_SIZE);

      // Extract sensor data
      const accelWindow = windowFrames.map(
        (f) =>
          new THREE.Vector3(
            f.accelerometer[0],
            f.accelerometer[1],
            f.accelerometer[2],
          ),
      );
      const gyroWindow = windowFrames.map((f) =>
        f.gyro
          ? new THREE.Vector3(f.gyro[0], f.gyro[1], f.gyro[2])
          : new THREE.Vector3(),
      );
      const quatWindow = windowFrames.map((f) =>
        firmwareToThreeQuat(f.quaternion),
      );

      const features = extractFeatures(accelWindow, gyroWindow, quatWindow);
      const { activity, confidence } = classifyActivity(features, sensorRegion);

      allFeatures.push(features);
      rawDetections.push({
        timestamp: windowFrames[0].timestamp,
        activity,
        confidence,
        features,
      });
    }

    // Merge consecutive same-activity windows into segments
    const segments = this.mergeToSegments(rawDetections);

    return { segments, features: allFeatures };
  }

  /**
   * Merge raw detections into continuous segments
   */
  private mergeToSegments(
    detections: {
      timestamp: number;
      activity: ActivityClass;
      confidence: number;
      features: FeatureVector;
    }[],
  ): AnalysisSegment[] {
    if (detections.length === 0) return [];

    const segments: AnalysisSegment[] = [];
    let currentSegment = {
      activity: detections[0].activity,
      startTime: detections[0].timestamp,
      endTime: detections[0].timestamp,
      confidenceSum: detections[0].confidence,
      count: 1,
      features: detections[0].features,
    };

    for (let i = 1; i < detections.length; i++) {
      const det = detections[i];

      if (det.activity === currentSegment.activity) {
        // Extend current segment
        currentSegment.endTime = det.timestamp;
        currentSegment.confidenceSum += det.confidence;
        currentSegment.count++;
      } else {
        // Save current segment and start new one
        const duration = currentSegment.endTime - currentSegment.startTime;
        if (duration >= MIN_SEGMENT_MS) {
          segments.push({
            activity: currentSegment.activity,
            startTime: currentSegment.startTime,
            endTime: currentSegment.endTime,
            duration,
            confidence: currentSegment.confidenceSum / currentSegment.count,
            features: currentSegment.features,
          });
        }

        currentSegment = {
          activity: det.activity,
          startTime: det.timestamp,
          endTime: det.timestamp,
          confidenceSum: det.confidence,
          count: 1,
          features: det.features,
        };
      }
    }

    // Save final segment
    const finalDuration = currentSegment.endTime - currentSegment.startTime;
    if (finalDuration >= MIN_SEGMENT_MS) {
      segments.push({
        activity: currentSegment.activity,
        startTime: currentSegment.startTime,
        endTime: currentSegment.endTime,
        duration: finalDuration,
        confidence: currentSegment.confidenceSum / currentSegment.count,
        features: currentSegment.features,
      });
    }

    return segments;
  }

  /**
   * Calculate activity summary
   */
  private calculateActivitySummary(
    segments: AnalysisSegment[],
  ): Record<ActivityClass, number> {
    const summary: Record<ActivityClass, number> = {
      standing: 0,
      walking: 0,
      running: 0,
      sitting: 0,
      exercising: 0,
      transitioning: 0,
      squat: 0,
      jumping: 0,
      skating: 0,
      unknown: 0,
    };

    segments.forEach((seg) => {
      summary[seg.activity] += seg.duration;
    });

    return summary;
  }

  /**
   * Analyze gait for walking/running segments
   */
  private analyzeGaitSegments(
    allFrames: RecordedFrame[],
    walkingSegments: AnalysisSegment[],
  ): GaitSegment[] {
    const gaitSegments: GaitSegment[] = [];

    walkingSegments.forEach((segment) => {
      // Get frames in this time range
      const segmentFrames = allFrames.filter(
        (f) =>
          f.timestamp >= segment.startTime && f.timestamp <= segment.endTime,
      );

      if (segmentFrames.length < 30) return; // Not enough data

      // Detect steps using peak detection on accel magnitude
      const accelMags = segmentFrames.map((f) =>
        Math.sqrt(
          f.accelerometer[0] ** 2 +
            f.accelerometer[1] ** 2 +
            f.accelerometer[2] ** 2,
        ),
      );

      const stepCount = this.countSteps(accelMags);
      const duration = segment.duration;

      // Calculate basic gait metrics
      const cadence = duration > 0 ? stepCount / (duration / 60000) : 0;
      const avgStrideTime = stepCount > 0 ? duration / stepCount : 0;

      gaitSegments.push({
        startTime: segment.startTime,
        endTime: segment.endTime,
        stepCount,
        metrics: {
          cadence: Math.round(cadence),
          strideTime: Math.round(avgStrideTime),
          stanceRatio: 0.6, // Default - would need foot sensors for accurate
          swingRatio: 0.4,
          strideLength: 0,
          walkingSpeed: 0,
          stepWidth: 0,
          leftRightRatio: 1,
          symmetryIndex: 100, // Would need bilateral sensors
          strideLengthSymmetry: 100,
          strideTimeCV: 0,
          strideLengthCV: 0,
          dfaAlpha: 0,
          longRangeCorrelation: false,
          currentPhaseLeft: "unknown",
          currentPhaseRight: "unknown",
          stepCount,
        },
      });
    });

    return gaitSegments;
  }

  /**
   * Count steps using peak detection
   */
  private countSteps(accelMags: number[]): number {
    if (accelMags.length < 10) return 0;

    const mean = accelMags.reduce((a, b) => a + b, 0) / accelMags.length;
    const variance =
      accelMags.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) /
      accelMags.length;
    const std = Math.sqrt(variance);
    const threshold = mean + std * 0.5;

    let stepCount = 0;
    let lastPeakIdx = -10;
    const minPeakDistance = 15; // ~250ms at 60Hz

    for (let i = 2; i < accelMags.length - 2; i++) {
      if (
        accelMags[i] > threshold &&
        accelMags[i] > accelMags[i - 1] &&
        accelMags[i] > accelMags[i - 2] &&
        accelMags[i] > accelMags[i + 1] &&
        accelMags[i] > accelMags[i + 2] &&
        i - lastPeakIdx >= minPeakDistance
      ) {
        stepCount++;
        lastPeakIdx = i;
      }
    }

    return stepCount;
  }

  /**
   * Calculate overall gait metrics from segments
   */
  private calculateOverallGait(segments: GaitSegment[]): GaitMetrics {
    const totalSteps = segments.reduce((sum, s) => sum + s.stepCount, 0);
    const totalDuration = segments.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );

    const avgCadence =
      totalDuration > 0 ? totalSteps / (totalDuration / 60000) : 0;
    const avgStrideTime = totalSteps > 0 ? totalDuration / totalSteps : 0;

    return {
      cadence: Math.round(avgCadence),
      strideTime: Math.round(avgStrideTime),
      stanceRatio: 0.6,
      swingRatio: 0.4,
      strideLength: 0,
      walkingSpeed: 0,
      stepWidth: 0,
      leftRightRatio: 1,
      symmetryIndex: 100,
      strideLengthSymmetry: 100,
      strideTimeCV: 0,
      strideLengthCV: 0,
      dfaAlpha: 0,
      longRangeCorrelation: false,
      currentPhaseLeft: "unknown",
      currentPhaseRight: "unknown",
      stepCount: totalSteps,
    };
  }

  // ========================================================================
  // SENSOR CONTEXT HELPERS
  // ========================================================================

  /** Extract the list of body segments that were instrumented during recording */
  private getInstrumentedSegments(
    frames: RecordedFrame[],
    session: any,
  ): string[] {
    const segments = new Set<string>();

    // 1. Check session-level sensorMapping  (e.g. { 190: 'head', 43: 'pelvis' })
    const mapping = session.sensorMapping || {};
    Object.values(mapping).forEach((seg: any) => {
      if (typeof seg === "string" && seg.length > 0)
        segments.add(seg.toLowerCase());
    });

    // 2. Check per-frame segment field (written at record time)
    for (const f of frames) {
      if (f.segment && typeof f.segment === "string") {
        segments.add(f.segment.toLowerCase());
      }
    }

    // 3. Fallback: check live assignment store for sensor IDs present in the data
    if (segments.size === 0) {
      try {
        const assignments = useSensorAssignmentStore.getState()
          .assignments as Map<string, { segmentId: string }>;
        const dataSensorIds = new Set(frames.map((f) => f.sensorId));

        assignments.forEach((a, deviceId) => {
          // Try to match by trailing numeric ID
          const match = String(deviceId).match(/(\d+)$/);
          if (match) {
            const numId = parseInt(match[1], 10);
            if (dataSensorIds.has(numId)) {
              segments.add(a.segmentId.toLowerCase());
            }
          }
        });
      } catch {
        /* assignment store unavailable */
      }
    }

    return Array.from(segments);
  }

  /**
   * Classify the sensor coverage region from segment names.
   * This tells the activity classifier which activities are even possible.
   */
  private classifySensorRegion(segments: string[]): SensorRegion {
    if (segments.length === 0) return "unknown";

    const HEAD_SEGMENTS = ["head", "cervical", "neck"];
    const UPPER_SEGMENTS = [
      "head",
      "cervical",
      "neck",
      "thorax",
      "chest",
      "spine",
      "upper_arm_r",
      "upper_arm_l",
      "forearm_r",
      "forearm_l",
      "hand_r",
      "hand_l",
      "shoulder_r",
      "shoulder_l",
      "humerus_r",
      "humerus_l",
      "radius_r",
      "radius_l",
    ];
    const LOWER_SEGMENTS = [
      "pelvis",
      "sacrum",
      "hip",
      "thigh_r",
      "thigh_l",
      "shank_r",
      "shank_l",
      "foot_r",
      "foot_l",
      "femur_r",
      "femur_l",
      "tibia_r",
      "tibia_l",
      "calcn_r",
      "calcn_l",
    ];

    const hasUpper = segments.some((s) => UPPER_SEGMENTS.includes(s));
    const hasLower = segments.some((s) => LOWER_SEGMENTS.includes(s));
    const isHeadOnly = segments.every((s) => HEAD_SEGMENTS.includes(s));

    if (isHeadOnly) return "head";
    if (hasUpper && hasLower) return "full_body";
    if (hasLower) return "lower_body";
    if (hasUpper) return "upper_body";

    return "unknown";
  }

  /**
   * Count gaps in data
   */
  private countMissingFrames(
    frames: RecordedFrame[],
    expectedRate: number,
  ): number {
    if (frames.length < 2) return 0;

    let missing = 0;
    const expectedInterval = 1000 / expectedRate; // ms

    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i].timestamp - frames[i - 1].timestamp;
      if (gap > expectedInterval * 2) {
        missing += Math.floor(gap / expectedInterval) - 1;
      }
    }

    return missing;
  }

  /**
   * Export analysis result as Azure-ready JSON
   */
  toAzureFormat(result: SessionAnalysisResult): object {
    return {
      version: "1.0",
      type: "imu_session_analysis",

      metadata: {
        sessionId: result.sessionId,
        sessionName: result.sessionName,
        analyzedAt: new Date(result.analyzedAt).toISOString(),
        durationMs: result.totalDuration,
        durationSeconds: Math.round(result.totalDuration / 1000),
        frameCount: result.frameCount,
      },

      activities: {
        segments: result.activitySegments.map((s) => ({
          activity: s.activity,
          startMs: s.startTime,
          endMs: s.endTime,
          durationMs: s.duration,
          confidence: Math.round(s.confidence * 100) / 100,
        })),
        summary: Object.entries(result.activitySummary).map(
          ([activity, ms]) => ({
            activity,
            durationMs: ms,
            durationSeconds: Math.round(ms / 1000),
            percentage: Math.round((ms / result.totalDuration) * 10000) / 100,
          }),
        ),
      },

      gait: result.overallGaitMetrics
        ? {
            totalSteps: result.totalSteps,
            averageCadence: result.averageCadence,
            overallMetrics: result.overallGaitMetrics,
            segments: result.gaitSegments,
          }
        : null,

      quality: result.dataQuality,

      // Feature vectors for ML training
      features: result.rawFeatures,
    };
  }
}

// Singleton
export const sessionAnalyzer = new SessionAnalyzer();
