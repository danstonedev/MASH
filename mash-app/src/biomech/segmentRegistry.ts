/**
 * Segment Registry: Defines all possible body segments and their hierarchy.
 * Easily extensible - add new segments without code changes elsewhere.
 */

export interface SegmentDefinition {
  id: string;
  name: string;
  parent: string | null;
  side?: "left" | "right" | "center";
}

export const SEGMENT_DEFINITIONS: Record<string, SegmentDefinition> = {
  // Core
  pelvis: { id: "pelvis", name: "Pelvis", parent: null, side: "center" },

  // Lower Body - Left
  thigh_l: {
    id: "thigh_l",
    name: "Left Thigh",
    parent: "pelvis",
    side: "left",
  },
  tibia_l: {
    id: "tibia_l",
    name: "Left Tibia",
    parent: "thigh_l",
    side: "left",
  },
  foot_l: { id: "foot_l", name: "Left Foot", parent: "tibia_l", side: "left" },

  // Lower Body - Right
  thigh_r: {
    id: "thigh_r",
    name: "Right Thigh",
    parent: "pelvis",
    side: "right",
  },
  tibia_r: {
    id: "tibia_r",
    name: "Right Tibia",
    parent: "thigh_r",
    side: "right",
  },
  foot_r: {
    id: "foot_r",
    name: "Right Foot",
    parent: "tibia_r",
    side: "right",
  },

  // Upper Body (for future expansion)
  torso: { id: "torso", name: "Torso", parent: "pelvis", side: "center" },
  head: { id: "head", name: "Head", parent: "torso", side: "center" },

  // Arms (for future expansion)
  upper_arm_l: {
    id: "upper_arm_l",
    name: "Left Upper Arm",
    parent: "torso",
    side: "left",
  },
  forearm_l: {
    id: "forearm_l",
    name: "Left Forearm",
    parent: "upper_arm_l",
    side: "left",
  },
  hand_l: {
    id: "hand_l",
    name: "Left Hand",
    parent: "forearm_l",
    side: "left",
  },

  upper_arm_r: {
    id: "upper_arm_r",
    name: "Right Upper Arm",
    parent: "torso",
    side: "right",
  },
  forearm_r: {
    id: "forearm_r",
    name: "Right Forearm",
    parent: "upper_arm_r",
    side: "right",
  },
  hand_r: {
    id: "hand_r",
    name: "Right Hand",
    parent: "forearm_r",
    side: "right",
  },
} as const;

export type SegmentId = keyof typeof SEGMENT_DEFINITIONS;

/**
 * Get the kinematic depth of a segment (0 = root, 1 = child of root, etc.).
 * Returns Infinity for unknown segments so they sort last.
 */
export function getSegmentDepth(segmentId: string): number {
  let depth = 0;
  let current = SEGMENT_DEFINITIONS[segmentId];
  if (!current) return Infinity;

  while (current.parent) {
    depth++;
    current = SEGMENT_DEFINITIONS[current.parent];
    if (!current) return Infinity; // broken chain
  }
  return depth;
}

/**
 * Get all child segments for a given parent
 */
export function getChildSegments(parentId: SegmentId): SegmentId[] {
  return Object.keys(SEGMENT_DEFINITIONS).filter(
    (id) => SEGMENT_DEFINITIONS[id].parent === parentId,
  ) as SegmentId[];
}

/**
 * Get the full chain from root to segment
 */
export function getSegmentChain(segmentId: SegmentId): SegmentId[] {
  const chain: SegmentId[] = [segmentId];
  let current = SEGMENT_DEFINITIONS[segmentId];

  while (current.parent) {
    chain.unshift(current.parent as SegmentId);
    current = SEGMENT_DEFINITIONS[current.parent];
  }

  return chain;
}
