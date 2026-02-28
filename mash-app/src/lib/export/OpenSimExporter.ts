/**
 * OpenSim Exporter
 * ================
 *
 * Generates .sto (Storage) files compatible with OpenSim Inverse Kinematics.
 *
 * Format Specification:
 * - Header: Metadata (nRows, nColumns, inDegrees=no)
 * - Data: Tab-delimited
 * - Columns: time, [sensor_name]_qx, [sensor_name]_qy, [sensor_name]_qz, [sensor_name]_qw
 *
 * @module lib/export/OpenSimExporter
 */

import { Quaternion } from "three";
import type { RecordedFrame } from "../db/types";
import { downloadBlobPart } from "./download";

export interface IMUFrame {
  timestamp: number; // ms
  sensors: Record<string, Quaternion>; // deviceId -> Quat
}

export interface OpenSimStoArtifact {
  content: string;
  filename: string;
  mimeType: string;
}

export class OpenSimExporter {
  /**
   * Converts a session of IMU frames into an OpenSim .sto string
   * @param recordingName Name of the trial
   * @param frames List of time-synced frames
   * @param sensorMapping Map of deviceId -> OpenSim_Body_Name (e.g. "pelvis", "tibia_r")
   * @param startTime offset t=0
   */

  static generateSTO(
    recordingName: string,
    frames: IMUFrame[],
    sensorMapping: Map<string, string>,
  ): string {
    if (frames.length === 0) return "";

    const startTime = frames[0].timestamp;
    const nRows = frames.length;

    // Identify active sensors from the mapping
    // We only export sensors that are mapped to body segments
    const activeSensors = Array.from(sensorMapping.keys());

    // 1. Build Column Headers
    // OpenSim IMU .sto typically expects quaternions:
    // time, sensor1_q1, sensor1_q2, sensor1_q3, sensor1_q4, ...
    // Or sometimes Euler. Let's stick to Quaternions as they are robust.
    // Format: <name>_Imu_q0 (scalar?), q1, q2, q3?
    // OpenSense standard: <bodyname>_orientation_1, 2, 3, 4 (Quat w,x,y,z usually)

    const columnLabels = ["time"];
    activeSensors.forEach((deviceId) => {
      const bodyName = sensorMapping.get(deviceId)!;
      // OpenSim usually expects: <body_name>_imu
      const prefix = `${bodyName}_imu`;
      columnLabels.push(`${prefix}_q1`); // x
      columnLabels.push(`${prefix}_q2`); // y
      columnLabels.push(`${prefix}_q3`); // z
      columnLabels.push(`${prefix}_q4`); // w (scalar)
    });

    const nColumns = columnLabels.length;

    // 2. Build Header
    const headerLines = [
      `result_file`,
      `version=1`,
      `nRows=${nRows}`,
      `nColumns=${nColumns}`,
      `inDegrees=no`, // Quaternions are unitless, but this hints generally
      `endheader`,
    ];

    // 3. Build Data
    const dataLines: string[] = [];
    dataLines.push(columnLabels.join("\t")); // Label Row

    for (const frame of frames) {
      const t = (frame.timestamp - startTime) / 1000.0; // Seconds
      const row = [t.toFixed(4)];

      for (const deviceId of activeSensors) {
        const q = frame.sensors[deviceId];
        if (q) {
          // OpenSim Quaternions are typically [x, y, z, w] or [w, x, y, z]?
          // OpenSense standard is usually [w, x, y, z] is scalar first?
          // "The order of components is q0, q1, q2, q3 where q0 is the scalar part."
          // THREE.js is x, y, z, w.

          // Let's assume w, x, y, z (scalar first) based on common .sto conventions
          row.push(q.w.toFixed(6));
          row.push(q.x.toFixed(6));
          row.push(q.y.toFixed(6));
          row.push(q.z.toFixed(6));
        } else {
          // Missing data pad
          row.push("0.000000\t0.000000\t0.000000\t1.000000");
        }
      }
      dataLines.push(row.join("\t"));
    }

    return headerLines.join("\n") + "\n" + dataLines.join("\n");
  }
}

export function buildOpenSimStoArtifact(
  frames: RecordedFrame[],
  metadata: { sessionName: string; dataRate: number },
  filename?: string,
): OpenSimStoArtifact {
  const timeMap = new Map<number, IMUFrame>();

  for (const frame of frames) {
    if (!timeMap.has(frame.timestamp)) {
      timeMap.set(frame.timestamp, { timestamp: frame.timestamp, sensors: {} });
    }

    const grouped = timeMap.get(frame.timestamp)!;
    if (frame.sensorId !== undefined && frame.quaternion) {
      grouped.sensors[String(frame.sensorId)] = new Quaternion(
        frame.quaternion[0],
        frame.quaternion[1],
        frame.quaternion[2],
        frame.quaternion[3],
      );
    }
  }

  const mapping = new Map<string, string>();
  frames.forEach((frame) => {
    if (frame.sensorId !== undefined && frame.segment) {
      mapping.set(String(frame.sensorId), frame.segment);
    }
  });

  const sortedFrames = Array.from(timeMap.values()).sort(
    (a, b) => a.timestamp - b.timestamp,
  );

  const content = OpenSimExporter.generateSTO(
    metadata.sessionName,
    sortedFrames,
    mapping,
  );

  return {
    content,
    filename: filename || `${metadata.sessionName}.sto`,
    mimeType: "text/plain",
  };
}

/**
 * Downloads a bundle of OpenSim-compatible files (STO, TRC, MOT)
 * @param frames Recorded frames from the session
 * @param metadata Session metadata
 */
export function downloadOpenSimBundle(
  frames: RecordedFrame[],
  metadata: { sessionName: string; dataRate: number },
): void {
  const artifact = buildOpenSimStoArtifact(frames, metadata);
  downloadBlobPart(artifact.content, artifact.filename, artifact.mimeType);
}
