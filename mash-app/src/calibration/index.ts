/**
 * Calibration Module Barrel Export
 */
export * from "./calibrationMath";
export * from "./anatomicalConstraints";
export {
  autoCalEngine,
  type AutoCalState,
  type CorrectionProposal,
} from "./AutoCalEngine";
export {
  calibrationLogger,
  type CorrectionType,
  type CalibrationSession,
  type CorrectionEvent,
} from "./CalibrationLogger";
export {
  unifiedCalibration,
  type UnifiedCalibrationState,
  type CalibrationStep,
  type CalibrationMode,
  type CalibrationResult,
} from "./UnifiedCalibration";

// PhD-level additions
export {
  type TareState,
  type TareOptions,
  type TareResult,
  computeQuaternionVariance,
  computeSphericalMean,
  assessCalibrationQuality,
  createDefaultTareState,
  applyFrameAlignment,
  computeMountingTare,
  computeMountingTareRobust,
  applyMountingTare,
  computeHeadingTare,
  applyHeadingTare,
  type JointAngleOffsets,
  computeJointTare,
  applyJointTare,
  applyFullTarePipeline,
  PIPELINE_STAGES,
  validateStillness,
  averageQuaternions,
} from "./taringPipeline";
export * from "./temporalSync";
export * from "./orientationLevels";

// Debugging tools
export { calibrationDebugger } from "./CalibrationDebugger";

// Research-grade dual-sensor calibration

export {
  detectTopology,
  getCalibrationSummary,
  hasTopologyChanged,
  type TopologyDetectionResult,
} from "./TopologyDetector";
