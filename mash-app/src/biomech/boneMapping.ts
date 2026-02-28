import { BodyRole } from "./topology/SensorRoles";

/**
 * Bone mapping for Neutral_Model.glb (uses mixamorig1 prefix)
 */
export const SEGMENT_TO_BONE: Record<string, string> = {
  // Legacy lowercase mappings
  pelvis: "mixamorig1Hips",
  torso: "mixamorig1Spine2",
  head: "mixamorig1Head",
  thigh_l: "mixamorig1LeftUpLeg",
  thigh_r: "mixamorig1RightUpLeg",
  tibia_l: "mixamorig1LeftLeg",
  tibia_r: "mixamorig1RightLeg",
  foot_l: "mixamorig1LeftFoot",
  foot_r: "mixamorig1RightFoot",
  upper_arm_l: "mixamorig1LeftArm",
  upper_arm_r: "mixamorig1RightArm",
  forearm_l: "mixamorig1LeftForeArm",
  forearm_r: "mixamorig1RightForeArm",
  hand_l: "mixamorig1LeftHand",
  hand_r: "mixamorig1RightHand",

  // New BodyRole (uppercase) mappings
  PELVIS: "mixamorig1Hips",
  CHEST: "mixamorig1Spine2",
  HEAD: "mixamorig1Head",

  // Legs (Thigh -> UpLeg, Knee -> Leg, Foot -> Foot)
  HIP_L: "mixamorig1LeftUpLeg",
  KNEE_L: "mixamorig1LeftLeg",
  FOOT_L: "mixamorig1LeftFoot",
  SKATE_L: "mixamorig1LeftFoot", // Skates map to feet

  HIP_R: "mixamorig1RightUpLeg",
  KNEE_R: "mixamorig1RightLeg",
  FOOT_R: "mixamorig1RightFoot",
  SKATE_R: "mixamorig1RightFoot",

  // Arms (Arm -> Arm, Forearm -> ForeArm, Hand -> Hand)
  ARM_L: "mixamorig1LeftArm",
  FOREARM_L: "mixamorig1LeftForeArm",
  HAND_L: "mixamorig1LeftHand",

  ARM_R: "mixamorig1RightArm",
  FOREARM_R: "mixamorig1RightForeArm",
  HAND_R: "mixamorig1RightHand",
};

// Bone target offsets - positioned at segment centers
// Targets render THROUGH the model (depthTest=false) so no need for Z offsets
export const BONE_TARGET_OFFSETS: Partial<
  Record<BodyRole, { boneName: string; offset: [number, number, number] }>
> = {
  // Head - at the head bone
  [BodyRole.HEAD]: { boneName: "mixamorig1Head", offset: [0, 0.05, 0] },

  // Chest - at spine
  [BodyRole.CHEST]: { boneName: "mixamorig1Spine2", offset: [0, 0, 0] },

  // Pelvis - at hips
  [BodyRole.PELVIS]: { boneName: "mixamorig1Hips", offset: [0, -0.05, 0] },

  // LEFT LEG - offset down to segment centers
  [BodyRole.HIP_L]: { boneName: "mixamorig1LeftUpLeg", offset: [0, -0.21, 0] },
  [BodyRole.KNEE_L]: { boneName: "mixamorig1LeftLeg", offset: [0, -0.21, 0] },
  [BodyRole.FOOT_L]: {
    boneName: "mixamorig1LeftFoot",
    offset: [0.04, 0, 0.04],
  },

  // RIGHT LEG - offset down to segment centers
  [BodyRole.HIP_R]: { boneName: "mixamorig1RightUpLeg", offset: [0, -0.21, 0] },
  [BodyRole.KNEE_R]: { boneName: "mixamorig1RightLeg", offset: [0, -0.21, 0] },
  [BodyRole.FOOT_R]: {
    boneName: "mixamorig1RightFoot",
    offset: [-0.04, 0, 0.04],
  },

  // LEFT ARM - offset toward elbow/wrist
  [BodyRole.ARM_L]: { boneName: "mixamorig1LeftArm", offset: [0.12, 0, 0] },
  [BodyRole.FOREARM_L]: {
    boneName: "mixamorig1LeftForeArm",
    offset: [0.11, 0, 0],
  },
  [BodyRole.HAND_L]: { boneName: "mixamorig1LeftHand", offset: [0.05, 0, 0] },

  // RIGHT ARM - offset toward elbow/wrist
  [BodyRole.ARM_R]: { boneName: "mixamorig1RightArm", offset: [-0.12, 0, 0] },
  [BodyRole.FOREARM_R]: {
    boneName: "mixamorig1RightForeArm",
    offset: [-0.11, 0, 0],
  },
  [BodyRole.HAND_R]: { boneName: "mixamorig1RightHand", offset: [-0.05, 0, 0] },
};
