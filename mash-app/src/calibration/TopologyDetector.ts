/**
 * Topology Detector
 * =================
 *
 * Intelligent detection of sensor topology based on assigned segments.
 * Automatically selects the appropriate calibration routine and algorithm mix.
 *
 * Key features:
 * 1. Infers topology from assigned segments
 * 2. Identifies SARA-eligible joints (dual-sensor hinge)
 * 3. Identifies SCoRE-eligible joints (dual-sensor ball)
 * 4. Generates optimal calibration flow
 *
 * @module TopologyDetector
 */

import { TopologyType } from "../biomech/topology/SensorRoles";

import type { CalibrationStep } from "./UnifiedCalibration";
import {
  RESEARCH_STRICT_FLOWS,
  RESEARCH_STRICT_FULL_BODY_FLOW,
} from "./calibrationStepConfig";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result of topology detection.
 */
export interface TopologyDetectionResult {
  /** Detected topology type */
  topology: TopologyType;

  /** Human-readable description */
  description: string;

  /** Recommended calibration flow */
  calibrationFlow: CalibrationStep[];

  /** Confidence in detection [0-1] */
  confidence: number;

  /** Warnings about the setup */
  warnings: string[];
}

/**
 * Segment group classifications.
 */
interface SegmentGroups {
  core: string[]; // Pelvis, Chest, Head, Spine
  leftLeg: string[]; // Thigh_L, Tibia_L, Foot_L
  rightLeg: string[];
  leftArm: string[]; // Shoulder_L, Arm_L, Forearm_L, Hand_L
  rightArm: string[];
  equipment: string[]; // Skates, Props
}

// ============================================================================
// SEGMENT CLASSIFICATION
// ============================================================================

const CORE_SEGMENTS = new Set([
  "PELVIS",
  "CHEST",
  "HEAD",
  "NECK",
  "SPINE_LOW",
  "TORSO",
]);
const LEFT_LEG_SEGMENTS = new Set([
  "HIP_L",
  "THIGH_L",
  "KNEE_L",
  "TIBIA_L",
  "FOOT_L",
  "TOE_L",
  "SKATE_L",
]);
const RIGHT_LEG_SEGMENTS = new Set([
  "HIP_R",
  "THIGH_R",
  "KNEE_R",
  "TIBIA_R",
  "FOOT_R",
  "TOE_R",
  "SKATE_R",
]);
const LEFT_ARM_SEGMENTS = new Set([
  "SHOULDER_L",
  "ARM_L",
  "UPPER_ARM_L",
  "FOREARM_L",
  "HAND_L",
]);
const RIGHT_ARM_SEGMENTS = new Set([
  "SHOULDER_R",
  "ARM_R",
  "UPPER_ARM_R",
  "FOREARM_R",
  "HAND_R",
]);
const EQUIPMENT_SEGMENTS = new Set(["PROP_1", "PROP_2", "SKATE_L", "SKATE_R"]);

// ============================================================================
// MAIN DETECTOR FUNCTION
// ============================================================================

/**
 * Detect topology and generate calibration plan from assigned segments.
 *
 * @param assignedSegments Array of segment IDs (e.g., ['PELVIS', 'THIGH_R', 'TIBIA_R'])
 * @returns Detection result with topology, eligible joints, and calibration flow
 */
export function detectTopology(
  assignedSegments: string[],
): TopologyDetectionResult {
  // Normalize to uppercase
  const segments = new Set(assignedSegments.map((s) => s.toUpperCase()));
  const segmentArray = Array.from(segments);

  // Classify into groups
  const groups = classifySegments(segmentArray);

  // Infer topology
  const { topology, description, confidence } = inferTopology(groups, segments);

  // Generate calibration flow
  const calibrationFlow = generateCalibrationFlow(topology, groups);

  // Generate warnings
  const warnings = generateWarnings(groups);

  return {
    topology,
    description,

    calibrationFlow,
    confidence,
    warnings,
  };
}

/**
 * Classify segments into body groups.
 */
function classifySegments(segments: string[]): SegmentGroups {
  const groups: SegmentGroups = {
    core: [],
    leftLeg: [],
    rightLeg: [],
    leftArm: [],
    rightArm: [],
    equipment: [],
  };

  for (const seg of segments) {
    if (CORE_SEGMENTS.has(seg)) groups.core.push(seg);
    else if (LEFT_LEG_SEGMENTS.has(seg)) groups.leftLeg.push(seg);
    else if (RIGHT_LEG_SEGMENTS.has(seg)) groups.rightLeg.push(seg);
    else if (LEFT_ARM_SEGMENTS.has(seg)) groups.leftArm.push(seg);
    else if (RIGHT_ARM_SEGMENTS.has(seg)) groups.rightArm.push(seg);
    else if (EQUIPMENT_SEGMENTS.has(seg)) groups.equipment.push(seg);
  }

  return groups;
}

/**
 * Infer topology type from segment groups.
 */
function inferTopology(
  groups: SegmentGroups,
  allSegments: Set<string>,
): { topology: TopologyType; description: string; confidence: number } {
  const totalSensors = allSegments.size;
  const hasCore = groups.core.length > 0;
  const hasLeftLeg = groups.leftLeg.length > 0;
  const hasRightLeg = groups.rightLeg.length > 0;
  const hasLeftArm = groups.leftArm.length > 0;
  const hasRightArm = groups.rightArm.length > 0;
  const hasSkates = allSegments.has("SKATE_L") || allSegments.has("SKATE_R");

  // Single sensor
  if (totalSensors === 1) {
    return {
      topology: TopologyType.SINGLE_SENSOR,
      description: "Single Sensor",
      confidence: 1.0,
    };
  }

  // Dual skate setup
  if (totalSensors === 2 && hasSkates) {
    return {
      topology: TopologyType.DUAL_SKATE,
      description: "Dual Skate/Foot",
      confidence: 1.0,
    };
  }

  // Core only (pelvis/chest)
  if (hasCore && !hasLeftLeg && !hasRightLeg && !hasLeftArm && !hasRightArm) {
    return {
      topology: TopologyType.CORE,
      description: "Core Only",
      confidence: 0.9,
    };
  }

  // Full body (all regions)
  if (hasCore && (hasLeftLeg || hasRightLeg) && (hasLeftArm || hasRightArm)) {
    if (totalSensors >= 10) {
      return {
        topology: TopologyType.FULL_BODY,
        description: `Full Body (${totalSensors} sensors)`,
        confidence: 0.95,
      };
    } else {
      return {
        topology: TopologyType.SPARSE_BODY,
        description: `Sparse Body (${totalSensors} sensors)`,
        confidence: 0.9,
      };
    }
  }

  // Legs only
  if ((hasLeftLeg || hasRightLeg) && !hasLeftArm && !hasRightArm) {
    const legSensors =
      groups.leftLeg.length + groups.rightLeg.length + groups.core.length;
    if (legSensors >= 6) {
      return {
        topology: TopologyType.FULL_LEG,
        description: `Full Leg (${legSensors} sensors)`,
        confidence: 0.9,
      };
    } else {
      return {
        topology: TopologyType.SPARSE_LEG,
        description: `Sparse Leg (${legSensors} sensors)`,
        confidence: 0.85,
      };
    }
  }

  // Arms only
  if ((hasLeftArm || hasRightArm) && !hasLeftLeg && !hasRightLeg) {
    return {
      topology: TopologyType.SPARSE_ARM,
      description: "Arm Tracking",
      confidence: 0.85,
    };
  }

  // Default: custom
  return {
    topology: TopologyType.CUSTOM,
    description: `Custom (${totalSensors} sensors)`,
    confidence: 0.7,
  };
}

/**
 * Return the canonical calibration flow for the given topology.
 * Delegates to the single source of truth in calibrationStepConfig.
 */
function generateCalibrationFlow(
  topology: TopologyType,
  _groups: SegmentGroups,
): CalibrationStep[] {
  return RESEARCH_STRICT_FLOWS[topology] || RESEARCH_STRICT_FULL_BODY_FLOW;
}

/**
 * Generate warnings about the sensor setup.
 */
function generateWarnings(groups: SegmentGroups): string[] {
  const warnings: string[] = [];

  // Asymmetric setup
  if (groups.leftLeg.length !== groups.rightLeg.length) {
    warnings.push(
      "Asymmetric leg setup - left and right have different sensors",
    );
  }

  if (groups.leftArm.length !== groups.rightArm.length) {
    warnings.push(
      "Asymmetric arm setup - left and right have different sensors",
    );
  }

  // Missing pelvis for leg tracking
  if (
    (groups.leftLeg.length > 0 || groups.rightLeg.length > 0) &&
    !groups.core.includes("PELVIS")
  ) {
    warnings.push(
      "Leg tracking without pelvis sensor - hip joint calibration unavailable",
    );
  }

  return warnings;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get a human-readable summary of the calibration plan.
 */
export function getCalibrationSummary(result: TopologyDetectionResult): string {
  const lines: string[] = [
    `Topology: ${result.description}`,
    `Sensors: ${result.calibrationFlow.length - 2} calibration steps`,
  ];

  return lines.join("\n");
}

/**
 * Check if topology has changed from previous detection.
 */
export function hasTopologyChanged(
  prev: TopologyDetectionResult | null,
  current: TopologyDetectionResult,
): boolean {
  if (!prev) return true;
  return prev.topology !== current.topology;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { classifySegments, inferTopology, generateCalibrationFlow };
