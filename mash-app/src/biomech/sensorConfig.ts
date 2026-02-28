/**
 * Sensor Configuration - Defines IMU placement and mounting for each body segment.
 *
 * Based on OpenSense conventions:
 * - Each sensor maps to a body segment
 * - Physical placement is defined anatomically
 * - Visual offset positions the marker on the 3D model
 */

import type { SegmentId } from "./segmentRegistry";

export interface SensorMountConfig {
  segmentId: SegmentId;

  // Human-readable anatomical description
  anatomicalLocation: string;

  // Visual placement offset in bone-local coordinates [x, y, z]
  // In Mixamo: X = lateral, Y = along bone (negative = distal), Z = anterior/posterior
  visualOffset: [number, number, number];

  // Sensor axis mapping hints (for calibration guidance)
  sensorAxes: {
    // Which sensor axis points in the body's forward direction
    bodyForward: "x" | "y" | "z" | "-x" | "-y" | "-z";
    // Which sensor axis points up along the body
    bodyUp: "x" | "y" | "z" | "-x" | "-y" | "-z";
  };

  // Side of body (for color coding)
  side: "left" | "right" | "center";
}

/**
 * Standard IMU mounting configurations based on OpenSense conventions.
 *
 * Placement Guidelines:
 * - Pelvis: Posterior sacrum (S1-S2 level), centered
 * - Thigh: Lateral mid-femur (vastus lateralis area)
 * - Tibia: Anterior proximal tibia (flat area below tibial tuberosity)
 * - Foot: Dorsum of foot (over metatarsals)
 * - Torso: Posterior thoracic spine (T3-T5)
 * - Head: Posterior occiput or forehead
 */
export const SENSOR_MOUNT_CONFIGS: Record<string, SensorMountConfig> = {
  // Center segments
  pelvis: {
    segmentId: "pelvis",
    anatomicalLocation: "Posterior sacrum (S1-S2)",
    visualOffset: [0, 1.0, -3.0],
    sensorAxes: { bodyForward: "-z", bodyUp: "y" },
    side: "center",
  },
  torso: {
    segmentId: "torso",
    anatomicalLocation: "Posterior thoracic spine (T3-T5)",
    visualOffset: [0, 0, -3.0],
    sensorAxes: { bodyForward: "-z", bodyUp: "y" },
    side: "center",
  },
  head: {
    segmentId: "head",
    anatomicalLocation: "Posterior occiput",
    visualOffset: [0, -0.05, -0.12],
    sensorAxes: { bodyForward: "-z", bodyUp: "y" },
    side: "center",
  },

  // Left leg
  thigh_l: {
    segmentId: "thigh_l",
    anatomicalLocation: "Lateral mid-femur (vastus lateralis)",
    visualOffset: [-2.0, -3.0, 0],
    sensorAxes: { bodyForward: "z", bodyUp: "-y" },
    side: "left",
  },
  tibia_l: {
    segmentId: "tibia_l",
    anatomicalLocation: "Anterior proximal tibia",
    visualOffset: [0, -2.5, 3.0],
    sensorAxes: { bodyForward: "z", bodyUp: "-y" },
    side: "left",
  },
  foot_l: {
    segmentId: "foot_l",
    anatomicalLocation: "Dorsum of foot (metatarsals)",
    visualOffset: [0, 1.0, 2.5],
    sensorAxes: { bodyForward: "z", bodyUp: "y" },
    side: "left",
  },

  // Right leg
  thigh_r: {
    segmentId: "thigh_r",
    anatomicalLocation: "Lateral mid-femur (vastus lateralis)",
    visualOffset: [2.0, -3.0, 0],
    sensorAxes: { bodyForward: "z", bodyUp: "-y" },
    side: "right",
  },
  tibia_r: {
    segmentId: "tibia_r",
    anatomicalLocation: "Anterior proximal tibia",
    visualOffset: [0, -2.5, 3.0],
    sensorAxes: { bodyForward: "z", bodyUp: "-y" },
    side: "right",
  },
  foot_r: {
    segmentId: "foot_r",
    anatomicalLocation: "Dorsum of foot (metatarsals)",
    visualOffset: [0, 1.0, 2.5],
    sensorAxes: { bodyForward: "z", bodyUp: "y" },
    side: "right",
  },

  // Arms (for future use)
  upper_arm_l: {
    segmentId: "upper_arm_l",
    anatomicalLocation: "Lateral upper arm",
    visualOffset: [-0.06, -0.1, 0],
    sensorAxes: { bodyForward: "z", bodyUp: "-y" },
    side: "left",
  },
  upper_arm_r: {
    segmentId: "upper_arm_r",
    anatomicalLocation: "Lateral upper arm",
    visualOffset: [0.06, -0.1, 0],
    sensorAxes: { bodyForward: "z", bodyUp: "-y" },
    side: "right",
  },
  forearm_l: {
    segmentId: "forearm_l",
    anatomicalLocation: "Posterior forearm",
    visualOffset: [0, -0.08, -0.04],
    sensorAxes: { bodyForward: "-z", bodyUp: "-y" },
    side: "left",
  },
  forearm_r: {
    segmentId: "forearm_r",
    anatomicalLocation: "Posterior forearm",
    visualOffset: [0, -0.08, -0.04],
    sensorAxes: { bodyForward: "-z", bodyUp: "-y" },
    side: "right",
  },
  hand_l: {
    segmentId: "hand_l",
    anatomicalLocation: "Dorsum of hand",
    visualOffset: [0, 0, 0.04],
    sensorAxes: { bodyForward: "z", bodyUp: "-y" },
    side: "left",
  },
  hand_r: {
    segmentId: "hand_r",
    anatomicalLocation: "Dorsum of hand",
    visualOffset: [0, 0, 0.04],
    sensorAxes: { bodyForward: "z", bodyUp: "-y" },
    side: "right",
  },
};

/**
 * Get sensor config for a segment
 */
export function getSensorConfig(
  segmentId: string,
): SensorMountConfig | undefined {
  return SENSOR_MOUNT_CONFIGS[segmentId];
}

/**
 * Get visual offset for a segment
 */
export function getSensorVisualOffset(
  segmentId: string,
): [number, number, number] {
  return SENSOR_MOUNT_CONFIGS[segmentId]?.visualOffset || [0, 0, 0];
}

/**
 * Get color for segment based on side
 */
export function getSensorColor(segmentId: string): string {
  const side = SENSOR_MOUNT_CONFIGS[segmentId]?.side;
  switch (side) {
    case "left":
      return "#10B981"; // Green
    case "right":
      return "#EF4444"; // Red
    default:
      return "#3B82F6"; // Blue
  }
}
