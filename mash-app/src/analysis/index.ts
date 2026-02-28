/**
 * Analysis Module Barrel Export
 */
export { movementEngine, type ActivityClass, type ActivityDetection, type MovementStats } from './MovementAnalysisEngine';
export { gaitAnalyzer, type GaitEvent, type GaitMetrics, type GaitPhase, type Stride } from './GaitAnalyzer';
export { sessionAnalyzer, type SessionAnalysisResult, type AnalysisSegment, type GaitSegment } from './SessionAnalyzer';

// New analytics modules
export { cogTracker, type CoGState, type CoGSample } from './CoGTracker';
export { skateAnalyzer, type SkatePhase, type SkateEvent, type SkateStride, type SkateMetrics } from './SkateAnalyzer';
export { jumpAnalyzer, type JumpPhase, type Jump, type JumpMetrics } from './JumpAnalyzer';
export { distanceTracker, type DistanceMetrics, type SpeedSample } from './DistanceTracker';
