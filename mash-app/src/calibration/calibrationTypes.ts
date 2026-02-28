/**
 * Core calibration type definitions.
 *
 * Kept in a dedicated module to avoid circular imports between
 * calibrationStepConfig, SensorRingBuffers, and UnifiedCalibration.
 */

export type CalibrationStep =
  | "idle"
  | "warm-up" // Short settling period before capture
  | "static-pose" // Initial T/N pose
  | "leg-left-functional" // Left leg isolated functional capture
  | "leg-right-functional" // Right leg isolated functional capture
  | "arm-left-functional" // Left arm isolated functional capture
  | "arm-right-functional" // Right arm isolated functional capture
  | "head-functional" // Head nod/shake functional capture
  | "ankle-flex" // Ankle plantarflex/dorsiflex (skate topology)
  | "hip-rotation" // Hip rotation axis (core topology)
  | "generic-flex" // Any joint flexion (single-sensor / custom)
  | "final-pose" // Final validation pose
  | "verification" // Post-calibration ROM check to validate quality
  | "pose-check" // Post-calibration neutral hold quality check
  | "squat-check" // Post-calibration dynamic functional check
  | "complete"
  | "error";

export type CalibrationMode = "research_strict";
