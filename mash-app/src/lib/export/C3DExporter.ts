/**
 * C3D File Export - Industry Standard Biomechanics Format
 * ========================================================
 *
 * C3D is the de-facto standard for biomechanics motion capture data,
 * supported by OpenSim, Visual3D, Vicon, and all major analysis tools.
 *
 * This implementation follows the C3D.org specification:
 * - Header section (512 bytes)
 * - Parameter section (variable)
 * - Data section (3D points + analog)
 *
 * File Structure:
 * ┌─────────────────┐
 * │   Header Block  │  512 bytes (Block 1)
 * │   (metadata)    │
 * ├─────────────────┤
 * │   Parameter     │  Variable (Blocks 2-N)
 * │   Section       │
 * ├─────────────────┤
 * │   3D + Analog   │  Frame data
 * │   Data Section  │
 * └─────────────────┘
 *
 * @module C3DExporter
 * @see https://www.c3d.org/HTML/default.htm
 */

import type { RecordedFrame } from "../db/types";
import { downloadBlobPart } from "./download";

// ============================================================================
// CONSTANTS
// ============================================================================

const BLOCK_SIZE = 512;
const PROCESSOR_TYPE = 84; // Intel (little-endian)

// ============================================================================
// TYPES
// ============================================================================

export interface C3DExportOptions {
  /** Session name for header */
  sessionName: string;

  /** Frame rate in Hz */
  frameRate: number;

  /** Scale factor for coordinates (default: 0.001 = mm to meters) */
  scale?: number;

  /** Include analog data (accelerometer, gyro) */
  includeAnalog?: boolean;

  /** Marker/point labels (segment names) */
  pointLabels?: string[];

  /** Additional metadata */
  metadata?: {
    subjectName?: string;
    subjectHeight?: number; // cm
    subjectWeight?: number; // kg
    dateOfBirth?: string;
  };
}

export interface C3DPoint {
  x: number;
  y: number;
  z: number;
  residual?: number; // Camera residual (unused for IMU)
}

export interface C3DArtifact {
  content: ArrayBuffer;
  filename: string;
  mimeType: string;
}

// ============================================================================
// C3D WRITER CLASS
// ============================================================================

export class C3DWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset: number = 0;

  private frames: RecordedFrame[] = [];
  private options: C3DExportOptions;

  // Frame statistics
  private pointCount: number = 0;
  private analogCount: number = 0;
  private firstFrame: number = 1;
  private lastFrame: number = 1;

  // Segment name to virtual marker position mapping
  private segmentPositions: Map<string, { x: number; y: number; z: number }> =
    new Map();

  constructor(options: C3DExportOptions) {
    this.options = {
      scale: -0.001, // Negative = floating point format
      includeAnalog: true,
      ...options,
    };

    // Pre-allocate buffer (will resize if needed)
    this.buffer = new ArrayBuffer(1024 * 1024); // 1MB initial
    this.view = new DataView(this.buffer);
  }

  /**
   * Set virtual marker positions for each segment.
   * These are the 3D coordinates used to visualize marker positions.
   */
  setSegmentPositions(
    positions: Map<string, { x: number; y: number; z: number }>,
  ) {
    this.segmentPositions = positions;
  }

  /**
   * Add recorded frames to the export.
   */
  addFrames(frames: RecordedFrame[]) {
    this.frames.push(...frames);
  }

  /**
   * Build the C3D file and return as ArrayBuffer.
   */
  build(): ArrayBuffer {
    this.analyzeFrames();
    this.writeHeader();
    this.writeParameters();
    this.writeData();

    // Trim buffer to actual size
    return this.buffer.slice(0, this.offset);
  }

  /**
   * Build and download as .c3d file.
   */
  download(filename: string = "export.c3d") {
    const resolvedFilename = filename.endsWith(".c3d")
      ? filename
      : `${filename}.c3d`;
    const data = this.build();
    downloadBlobPart(data, resolvedFilename, "application/octet-stream");
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  private analyzeFrames() {
    // Get unique sensor IDs to determine point count
    const sensorIds = new Set(this.frames.map((f) => f.sensorId));
    this.pointCount = sensorIds.size;

    // Analog channels: 3 accel + 3 gyro per sensor
    this.analogCount = this.options.includeAnalog ? this.pointCount * 6 : 0;

    // Frame range
    this.firstFrame = 1;
    this.lastFrame = Math.ceil(this.frames.length / this.pointCount) || 1;

    console.debug(
      `[C3D] Analyzed: ${this.pointCount} points, ${this.analogCount} analog channels, ${this.lastFrame} frames`,
    );
  }

  private writeHeader() {
    // Block 1: Header (512 bytes)
    this.offset = 0;

    // Byte 1-2: Parameter start block (always 2)
    this.writeUint8(2);
    this.writeUint8(0x50); // C3D identifier

    // Bytes 3-4: Number of 3D points
    this.writeInt16(this.pointCount);

    // Bytes 5-6: Number of analog measurements per frame
    this.writeInt16(this.analogCount);

    // Bytes 7-8: First frame number
    this.writeInt16(this.firstFrame);

    // Bytes 9-10: Last frame number
    this.writeInt16(this.lastFrame);

    // Bytes 11-12: Maximum interpolation gap
    this.writeInt16(0);

    // Bytes 13-16: Scale factor (floating point if negative)
    this.writeFloat32(this.options.scale!);

    // Bytes 17-18: Data start block
    const dataStartBlock = 3; // After header and parameters
    this.writeInt16(dataStartBlock);

    // Bytes 19-20: Analog samples per frame
    this.writeInt16(1);

    // Bytes 21-24: Frame rate (float)
    this.writeFloat32(this.options.frameRate);

    // Bytes 25-148: Reserved (set to 0)
    for (let i = 0; i < 124; i++) {
      this.writeUint8(0);
    }

    // Bytes 149-150: Key value (0x3039 = 12345)
    this.writeInt16(12345);

    // Bytes 151-152: First label range block
    this.writeInt16(0);

    // Bytes 153-154: Last label range block
    this.writeInt16(0);

    // Bytes 155-156: Event count
    this.writeInt16(0);

    // Bytes 157-188: Reserved
    for (let i = 0; i < 32; i++) {
      this.writeUint8(0);
    }

    // Bytes 189-234: Reserved events
    for (let i = 0; i < 46; i++) {
      this.writeUint8(0);
    }

    // Pad to full block
    while (this.offset < BLOCK_SIZE) {
      this.writeUint8(0);
    }
  }

  private writeParameters() {
    // Block 2: Parameter section
    const paramStart = this.offset;

    // Parameter header (4 bytes)
    this.writeUint8(1); // Reserved
    this.writeUint8(0x50); // Key (80 = C3D)
    this.writeUint8(3); // Number of parameter blocks
    this.writeUint8(PROCESSOR_TYPE);

    // POINT group
    this.writeParameterGroup(-1, "POINT");
    this.writeParameter("USED", 2, [this.pointCount]);
    this.writeParameter("FRAMES", 2, [this.lastFrame]);
    this.writeParameter("SCALE", 4, [this.options.scale!]);
    this.writeParameter("RATE", 4, [this.options.frameRate]);
    this.writeParameter("LABELS", -1, this.getPointLabels());

    // ANALOG group (if enabled)
    if (this.options.includeAnalog && this.analogCount > 0) {
      this.writeParameterGroup(-2, "ANALOG");
      this.writeParameter("USED", 2, [this.analogCount]);
      this.writeParameter("RATE", 4, [this.options.frameRate]);
      this.writeParameter("LABELS", -1, this.getAnalogLabels());
    }

    // SUBJECT group
    this.writeParameterGroup(-3, "SUBJECT");
    const name = this.options.metadata?.subjectName || "Unknown";
    this.writeParameter("NAME", -1, [name]);
    if (this.options.metadata?.subjectHeight) {
      this.writeParameter("HEIGHT", 4, [this.options.metadata.subjectHeight]);
    }
    if (this.options.metadata?.subjectWeight) {
      this.writeParameter("WEIGHT", 4, [this.options.metadata.subjectWeight]);
    }

    // End of parameters
    this.writeUint8(0);
    this.writeUint8(0);

    // Pad to block boundary
    while (this.offset % BLOCK_SIZE !== 0) {
      this.writeUint8(0);
    }
  }

  private writeData() {
    // Group frames by timestamp, then by sensor
    const framesBySensor = new Map<number, RecordedFrame[]>();

    this.frames.forEach((frame) => {
      const sensorId = frame.sensorId ?? 0;
      if (!framesBySensor.has(sensorId)) {
        framesBySensor.set(sensorId, []);
      }
      framesBySensor.get(sensorId)!.push(frame);
    });

    // For each time frame, write all points
    const sensorIds = Array.from(framesBySensor.keys()).sort();
    const maxFrames = Math.max(
      ...Array.from(framesBySensor.values()).map((f) => f.length),
    );

    for (let frameIdx = 0; frameIdx < maxFrames; frameIdx++) {
      // Write 3D point data
      for (const sensorId of sensorIds) {
        const sensorFrames = framesBySensor.get(sensorId) || [];
        const frame = sensorFrames[frameIdx];

        if (frame) {
          // Get position from quaternion + segment mapping
          // For IMU data, we estimate position from orientation
          const pos = this.estimatePosition(frame);

          // Write X, Y, Z as floats (since scale is negative)
          this.writeFloat32(pos.x);
          this.writeFloat32(pos.y);
          this.writeFloat32(pos.z);

          // Residual + camera mask (4 bytes)
          this.writeFloat32(0); // Perfect residual
        } else {
          // Missing data point
          this.writeFloat32(0);
          this.writeFloat32(0);
          this.writeFloat32(0);
          this.writeFloat32(-1); // Invalid residual
        }
      }

      // Write analog data (if enabled)
      if (this.options.includeAnalog) {
        for (const sensorId of sensorIds) {
          const sensorFrames = framesBySensor.get(sensorId) || [];
          const frame = sensorFrames[frameIdx];

          if (frame) {
            // Accelerometer (3 channels)
            this.writeFloat32(frame.accelerometer[0]);
            this.writeFloat32(frame.accelerometer[1]);
            this.writeFloat32(frame.accelerometer[2]);

            // Gyroscope (3 channels)
            const gyro = frame.gyro || [0, 0, 0];
            this.writeFloat32(gyro[0]);
            this.writeFloat32(gyro[1]);
            this.writeFloat32(gyro[2]);
          } else {
            for (let i = 0; i < 6; i++) {
              this.writeFloat32(0);
            }
          }
        }
      }
    }
  }

  private estimatePosition(frame: RecordedFrame): C3DPoint {
    // For IMU-only systems, we estimate marker position from:
    // 1. Segment assignment (gives us which body part)
    // 2. Quaternion orientation (gives us rotation)
    //
    // Real marker positions would come from forward kinematics.
    // Here we use segment-based virtual marker positions.

    const segment = frame.segment || "unknown";
    const basePos = this.segmentPositions.get(segment) || { x: 0, y: 0, z: 0 };

    // Apply quaternion rotation to base position
    // (simplified - could use full FK chain)
    const [qw, qx, qy, qz] = frame.quaternion;

    // For now, return base position (future: integrate with ForwardKinematics)
    return {
      x: basePos.x * 1000, // Convert to mm
      y: basePos.y * 1000,
      z: basePos.z * 1000,
    };
  }

  private getPointLabels(): string[] {
    // Get unique segment names from frames
    const segments = new Set<string>();
    this.frames.forEach((f) => {
      if (f.segment) segments.add(f.segment);
    });

    // Use provided labels or generate from segments
    if (this.options.pointLabels && this.options.pointLabels.length > 0) {
      return this.options.pointLabels;
    }

    return Array.from(segments).map((s) => s.toUpperCase().slice(0, 4));
  }

  private getAnalogLabels(): string[] {
    const labels: string[] = [];
    const segments = this.getPointLabels();

    segments.forEach((seg) => {
      labels.push(`${seg}_AX`, `${seg}_AY`, `${seg}_AZ`);
      labels.push(`${seg}_GX`, `${seg}_GY`, `${seg}_GZ`);
    });

    return labels;
  }

  private writeParameterGroup(id: number, name: string) {
    // Group name length (negative = locked)
    this.writeInt8(name.length);

    // Group ID (negative for group)
    this.writeInt8(id);

    // Group name
    for (let i = 0; i < name.length; i++) {
      this.writeUint8(name.charCodeAt(i));
    }

    // Next parameter offset (will be updated)
    this.writeInt16(0);

    // Description
    this.writeUint8(0);
  }

  private writeParameter(
    name: string,
    dataType: number,
    data: (number | string)[],
  ) {
    // Parameter name length
    this.writeInt8(name.length);

    // Group ID of parent (positive for parameter)
    this.writeInt8(0);

    // Parameter name
    for (let i = 0; i < name.length; i++) {
      this.writeUint8(name.charCodeAt(i));
    }

    // Next parameter offset
    const dataSize = this.calculateDataSize(dataType, data);
    this.writeInt16(2 + 1 + (dataType < 0 ? 1 : 0) * data.length + dataSize);

    // Data type (-1 = char, 1 = byte, 2 = int16, 4 = float)
    this.writeInt8(dataType);

    // Number of dimensions
    this.writeUint8(1);

    // Dimension sizes
    this.writeUint8(data.length);

    // Data
    if (dataType === -1) {
      // Character data
      data.forEach((s) => {
        const str = String(s);
        this.writeUint8(str.length);
        for (let i = 0; i < str.length; i++) {
          this.writeUint8(str.charCodeAt(i));
        }
      });
    } else if (dataType === 2) {
      data.forEach((v) => this.writeInt16(v as number));
    } else if (dataType === 4) {
      data.forEach((v) => this.writeFloat32(v as number));
    }
  }

  private calculateDataSize(
    dataType: number,
    data: (number | string)[],
  ): number {
    if (dataType === -1) {
      return data.reduce<number>((sum, s) => sum + String(s).length + 1, 0);
    }
    return Math.abs(dataType) * data.length;
  }

  // ========================================================================
  // BINARY WRITING HELPERS
  // ========================================================================

  private ensureCapacity(bytes: number) {
    if (this.offset + bytes > this.buffer.byteLength) {
      // Double buffer size
      const newBuffer = new ArrayBuffer(this.buffer.byteLength * 2);
      const newView = new Uint8Array(newBuffer);
      newView.set(new Uint8Array(this.buffer));
      this.buffer = newBuffer;
      this.view = new DataView(this.buffer);
    }
  }

  private writeUint8(value: number) {
    this.ensureCapacity(1);
    this.view.setUint8(this.offset++, value);
  }

  private writeInt8(value: number) {
    this.ensureCapacity(1);
    this.view.setInt8(this.offset++, value);
  }

  private writeInt16(value: number) {
    this.ensureCapacity(2);
    this.view.setInt16(this.offset, value, true); // Little-endian
    this.offset += 2;
  }

  private writeFloat32(value: number) {
    this.ensureCapacity(4);
    this.view.setFloat32(this.offset, value, true); // Little-endian
    this.offset += 4;
  }
}

// ============================================================================
// CONVENIENCE FUNCTION
// ============================================================================

/**
 * Export recorded frames to C3D format.
 *
 * @param frames Recorded IMU frames
 * @param options Export options
 * @returns C3D file as ArrayBuffer
 */
export function exportToC3D(
  frames: RecordedFrame[],
  options: C3DExportOptions,
): ArrayBuffer {
  const writer = new C3DWriter(options);
  writer.addFrames(frames);
  return writer.build();
}

export function buildC3DArtifact(
  frames: RecordedFrame[],
  options: C3DExportOptions,
  filename?: string,
): C3DArtifact {
  const content = exportToC3D(frames, options);
  return {
    content,
    filename: filename || `${options.sessionName}.c3d`,
    mimeType: "application/octet-stream",
  };
}

/**
 * Download recorded frames as C3D file.
 */
export function downloadC3D(
  frames: RecordedFrame[],
  options: C3DExportOptions,
  filename?: string,
) {
  const artifact = buildC3DArtifact(frames, options, filename);
  downloadBlobPart(artifact.content, artifact.filename, artifact.mimeType);
}
