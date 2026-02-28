/**
 * BVH Export - Animation Industry Standard
 * =========================================
 *
 * BVH (Biovision Hierarchy) is the standard format for motion capture
 * data in animation and game development. It's used by:
 * - Blender, Maya, 3ds Max
 * - Unity, Unreal Engine
 * - Adobe Character Animator
 *
 * Format Structure:
 * - HIERARCHY section: Bone structure definition
 * - MOTION section: Frame-by-frame rotation data
 *
 * @module BVHExporter
 */

import type { RecordedFrame } from "../db/types";
import * as THREE from "three";
import { downloadBlobPart } from "./download";

// ============================================================================
// TYPES
// ============================================================================

export interface BVHExportOptions {
  /** Session name for comments */
  sessionName: string;

  /** Frame rate in Hz */
  frameRate: number;

  /** Use ZXY rotation order (Mixamo-compatible) */
  useMixamoOrder?: boolean;

  /** Scale factor for root translation */
  rootScale?: number;

  /** Segment name to BVH bone name mapping */
  boneMapping?: Record<string, string>;
}

export interface BVHArtifact {
  content: string;
  filename: string;
  mimeType: string;
}

// ============================================================================
// DEFAULT SKELETON HIERARCHY (Mixamo-compatible)
// ============================================================================

interface BVHBone {
  name: string;
  offset: [number, number, number];
  channels: string[];
  children: BVHBone[];
  segment?: string; // Maps to IMU segment
}

const DEFAULT_SKELETON: BVHBone = {
  name: "Hips",
  offset: [0, 0, 0],
  channels: [
    "Xposition",
    "Yposition",
    "Zposition",
    "Zrotation",
    "Xrotation",
    "Yrotation",
  ],
  segment: "pelvis",
  children: [
    {
      name: "Spine",
      offset: [0, 10, 0],
      channels: ["Zrotation", "Xrotation", "Yrotation"],
      segment: undefined, // Virtual bone between Hips and Torso
      children: [
        {
          name: "Spine1",
          offset: [0, 10, 0],
          channels: ["Zrotation", "Xrotation", "Yrotation"],
          segment: "torso",
          children: [
            {
              name: "Neck",
              offset: [0, 15, 0],
              channels: ["Zrotation", "Xrotation", "Yrotation"],
              children: [
                {
                  name: "Head",
                  offset: [0, 10, 0],
                  channels: ["Zrotation", "Xrotation", "Yrotation"],
                  segment: "head",
                  children: [],
                },
              ],
            },
            {
              name: "LeftShoulder",
              offset: [5, 10, 0],
              channels: ["Zrotation", "Xrotation", "Yrotation"],
              children: [
                {
                  name: "LeftArm",
                  offset: [15, 0, 0],
                  channels: ["Zrotation", "Xrotation", "Yrotation"],
                  segment: "upper_arm_l",
                  children: [
                    {
                      name: "LeftForeArm",
                      offset: [25, 0, 0],
                      channels: ["Zrotation", "Xrotation", "Yrotation"],
                      segment: "forearm_l",
                      children: [
                        {
                          name: "LeftHand",
                          offset: [25, 0, 0],
                          channels: ["Zrotation", "Xrotation", "Yrotation"],
                          segment: "hand_l",
                          children: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              name: "RightShoulder",
              offset: [-5, 10, 0],
              channels: ["Zrotation", "Xrotation", "Yrotation"],
              children: [
                {
                  name: "RightArm",
                  offset: [-15, 0, 0],
                  channels: ["Zrotation", "Xrotation", "Yrotation"],
                  segment: "upper_arm_r",
                  children: [
                    {
                      name: "RightForeArm",
                      offset: [-25, 0, 0],
                      channels: ["Zrotation", "Xrotation", "Yrotation"],
                      segment: "forearm_r",
                      children: [
                        {
                          name: "RightHand",
                          offset: [-25, 0, 0],
                          channels: ["Zrotation", "Xrotation", "Yrotation"],
                          segment: "hand_r",
                          children: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "LeftUpLeg",
      offset: [10, -5, 0],
      channels: ["Zrotation", "Xrotation", "Yrotation"],
      segment: "thigh_l",
      children: [
        {
          name: "LeftLeg",
          offset: [0, -45, 0],
          channels: ["Zrotation", "Xrotation", "Yrotation"],
          segment: "tibia_l",
          children: [
            {
              name: "LeftFoot",
              offset: [0, -45, 0],
              channels: ["Zrotation", "Xrotation", "Yrotation"],
              segment: "foot_l",
              children: [
                {
                  name: "LeftToeBase",
                  offset: [0, 0, 10],
                  channels: ["Zrotation", "Xrotation", "Yrotation"],
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "RightUpLeg",
      offset: [-10, -5, 0],
      channels: ["Zrotation", "Xrotation", "Yrotation"],
      segment: "thigh_r",
      children: [
        {
          name: "RightLeg",
          offset: [0, -45, 0],
          channels: ["Zrotation", "Xrotation", "Yrotation"],
          segment: "tibia_r",
          children: [
            {
              name: "RightFoot",
              offset: [0, -45, 0],
              channels: ["Zrotation", "Xrotation", "Yrotation"],
              segment: "foot_r",
              children: [
                {
                  name: "RightToeBase",
                  offset: [0, 0, 10],
                  channels: ["Zrotation", "Xrotation", "Yrotation"],
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ============================================================================
// BVH EXPORTER CLASS
// ============================================================================

export class BVHWriter {
  private options: BVHExportOptions;
  private frames: RecordedFrame[] = [];
  private skeleton: BVHBone;
  private channelOrder: string[] = []; // Flat list of all channels in order
  private segmentToBone: Map<string, BVHBone> = new Map();

  constructor(options: BVHExportOptions) {
    this.options = {
      useMixamoOrder: true,
      rootScale: 0.1,
      ...options,
    };
    this.skeleton = DEFAULT_SKELETON;
    this.buildMappings(this.skeleton);
  }

  /**
   * Add recorded frames for export.
   */
  addFrames(frames: RecordedFrame[]) {
    this.frames.push(...frames);
  }

  /**
   * Build BVH file content as string.
   */
  build(): string {
    const lines: string[] = [];

    // HIERARCHY section
    lines.push("HIERARCHY");
    this.writeHierarchy(this.skeleton, lines, 0, true);

    // MOTION section
    const framesByTime = this.groupFramesByTime();
    const numFrames = framesByTime.length;
    const frameTime = 1 / this.options.frameRate;

    lines.push("MOTION");
    lines.push(`Frames: ${numFrames}`);
    lines.push(`Frame Time: ${frameTime.toFixed(6)}`);

    // Frame data
    framesByTime.forEach((frameGroup) => {
      const values = this.computeFrameValues(frameGroup);
      lines.push(values.map((v) => v.toFixed(4)).join(" "));
    });

    return lines.join("\n");
  }

  /**
   * Download as .bvh file.
   */
  download(filename?: string) {
    const content = this.build();
    downloadBlobPart(
      content,
      filename || `${this.options.sessionName}.bvh`,
      "text/plain",
    );
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  private buildMappings(bone: BVHBone) {
    if (bone.segment) {
      this.segmentToBone.set(bone.segment, bone);
    }

    // Add channels to order
    bone.channels.forEach((ch) => {
      this.channelOrder.push(`${bone.name}.${ch}`);
    });

    bone.children.forEach((child) => this.buildMappings(child));
  }

  private writeHierarchy(
    bone: BVHBone,
    lines: string[],
    indent: number,
    isRoot: boolean,
  ) {
    const pad = "  ".repeat(indent);

    if (isRoot) {
      lines.push(`${pad}ROOT ${bone.name}`);
    } else if (bone.children.length === 0) {
      lines.push(`${pad}End Site`);
      lines.push(`${pad}{`);
      lines.push(`${pad}  OFFSET ${bone.offset.join(" ")}`);
      lines.push(`${pad}}`);
      return;
    } else {
      lines.push(`${pad}JOINT ${bone.name}`);
    }

    lines.push(`${pad}{`);
    lines.push(`${pad}  OFFSET ${bone.offset.join(" ")}`);
    lines.push(
      `${pad}  CHANNELS ${bone.channels.length} ${bone.channels.join(" ")}`,
    );

    if (bone.children.length === 0) {
      // End effector
      lines.push(`${pad}  End Site`);
      lines.push(`${pad}  {`);
      lines.push(`${pad}    OFFSET 0 5 0`);
      lines.push(`${pad}  }`);
    } else {
      bone.children.forEach((child) => {
        this.writeHierarchy(child, lines, indent + 1, false);
      });
    }

    lines.push(`${pad}}`);
  }

  private groupFramesByTime(): { time: number; frames: RecordedFrame[] }[] {
    const groups: { time: number; frames: RecordedFrame[] }[] = [];
    let currentGroup: { time: number; frames: RecordedFrame[] } | null = null;

    const sorted = [...this.frames].sort((a, b) => a.timestamp - b.timestamp);
    const startTime = sorted[0]?.timestamp || 0;

    sorted.forEach((frame) => {
      const relativeTime = (frame.timestamp - startTime) / 1000;

      if (!currentGroup || Math.abs(relativeTime - currentGroup.time) > 0.005) {
        currentGroup = { time: relativeTime, frames: [frame] };
        groups.push(currentGroup);
      } else {
        currentGroup.frames.push(frame);
      }
    });

    return groups;
  }

  private computeFrameValues(frameGroup: {
    time: number;
    frames: RecordedFrame[];
  }): number[] {
    const values: number[] = [];

    // Process each bone in hierarchy order
    this.processBonerValues(this.skeleton, frameGroup.frames, values, true);

    return values;
  }

  private processBonerValues(
    bone: BVHBone,
    frames: RecordedFrame[],
    values: number[],
    isRoot: boolean,
  ) {
    // Find frame for this bone's segment
    const frame = bone.segment
      ? frames.find((f) => f.segment === bone.segment)
      : null;

    if (isRoot && bone.channels.some((c) => c.includes("position"))) {
      // Root has position channels
      if (frame) {
        // Estimate position from accelerometer integration (simplified)
        values.push(0); // X position
        values.push(100); // Y position (base height)
        values.push(0); // Z position
      } else {
        values.push(0, 100, 0);
      }
    }

    // Rotation channels
    const rotationChannels = bone.channels.filter((c) =>
      c.includes("rotation"),
    );
    if (rotationChannels.length > 0) {
      if (frame) {
        const euler = this.quaternionToEuler(frame.quaternion, bone.channels);
        rotationChannels.forEach((ch) => {
          if (ch === "Xrotation") values.push(euler.x);
          else if (ch === "Yrotation") values.push(euler.y);
          else if (ch === "Zrotation") values.push(euler.z);
        });
      } else {
        rotationChannels.forEach(() => values.push(0));
      }
    }

    // Process children
    bone.children.forEach((child) => {
      this.processBonerValues(child, frames, values, false);
    });
  }

  private quaternionToEuler(
    quat: [number, number, number, number],
    channels: string[],
  ): { x: number; y: number; z: number } {
    const [qw, qx, qy, qz] = quat;
    const q = new THREE.Quaternion(qx, qy, qz, qw);

    // Determine Euler order from channel order
    let order: THREE.EulerOrder = "ZXY"; // BVH default

    const rotChannels = channels
      .filter((c) => c.includes("rotation"))
      .map((c) => c[0]);
    if (rotChannels.length === 3) {
      order = rotChannels.join("") as THREE.EulerOrder;
    }

    const euler = new THREE.Euler().setFromQuaternion(q, order);

    const RAD2DEG = 180 / Math.PI;
    return {
      x: euler.x * RAD2DEG,
      y: euler.y * RAD2DEG,
      z: euler.z * RAD2DEG,
    };
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Export frames to BVH format.
 */
export function exportToBVH(
  frames: RecordedFrame[],
  options: BVHExportOptions,
): string {
  const writer = new BVHWriter(options);
  writer.addFrames(frames);
  return writer.build();
}

export function buildBVHArtifact(
  frames: RecordedFrame[],
  options: BVHExportOptions,
  filename?: string,
): BVHArtifact {
  const content = exportToBVH(frames, options);
  return {
    content,
    filename: filename || `${options.sessionName}.bvh`,
    mimeType: "text/plain",
  };
}

/**
 * Download frames as BVH file.
 */
export function downloadBVH(
  frames: RecordedFrame[],
  options: BVHExportOptions,
  filename?: string,
) {
  const artifact = buildBVHArtifact(frames, options, filename);
  downloadBlobPart(artifact.content, artifact.filename, artifact.mimeType);
}
