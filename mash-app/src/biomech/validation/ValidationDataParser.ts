import * as THREE from "three";
import type { ValidationDataset, ValidationFrame } from "./KinematicValidator";

/**
 * Parsers for External Validation Data Formats
 * Supports: OpenSim Storage (.sto, .mot)
 */
export class ValidationDataParser {
  /**
   * Parse Xsens DOT CSV export format.
   * Columns: PacketCounter,SampleTimeFine,Quat_W,Quat_X,Quat_Y,Quat_Z,...
   */
  static parseXsensCSV(content: string): {
    quats: THREE.Quaternion[];
    packetCounters: number[];
  } {
    const lines = content.split("\n");
    const quats: THREE.Quaternion[] = [];
    const packetCounters: number[] = [];

    let datastartIndex = -1;
    // Find header line
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("PacketCounter,SampleTimeFine,Quat_W")) {
        datastartIndex = i + 1;
        break;
      }
    }

    if (datastartIndex === -1)
      throw new Error("Invalid Xsens CSV: Header not found");

    for (let i = datastartIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(",");
      if (parts.length < 6) continue;

      const counter = parseInt(parts[0], 10);
      const w = parseFloat(parts[2]);
      const x = parseFloat(parts[3]);
      const y = parseFloat(parts[4]);
      const z = parseFloat(parts[5]);

      if (
        !Number.isFinite(counter) ||
        !Number.isFinite(w) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z)
      ) {
        continue;
      }

      quats.push(new THREE.Quaternion(x, y, z, w));
      packetCounters.push(counter);
    }

    return { quats, packetCounters };
  }

  /**
   * Parse an OpenSim .sto or .mot file content into a ValidationDataset
   * @param content Raw string content of the file
   * @param fileName Name of the file (for identification)
   * @param type 'orientation' | 'kinematics' - hint for how to interpret columns
   */
  static parseOpenSimStorage(
    content: string,
    fileName: string,
  ): ValidationDataset {
    const lines = content.split("\n");
    let headerEndIndex = -1;
    let columnNames: string[] = [];
    let isDegrees = false; // Default OpenSim is often degrees, but header says 'inDegrees=yes'

    // Mapping from OpenSim/OpenSense names to our FKSolver Segment IDs
    const SEGMENT_MAP: { [key: string]: string } = {
      torso_imu: "TORSO",
      pelvis_imu: "PELVIS",
      femur_r_imu: "THIGH_R",
      thigh_r_imu: "THIGH_R",
      tibia_r_imu: "TIBIA_R",
      shank_r_imu: "TIBIA_R",
      calcn_r_imu: "FOOT_R",
      foot_r_imu: "FOOT_R",
      toes_r_imu: "FOOT_R",
      femur_l_imu: "THIGH_L",
      thigh_l_imu: "THIGH_L",
      tibia_l_imu: "TIBIA_L",
      shank_l_imu: "TIBIA_L",
      calcn_l_imu: "FOOT_L",
      foot_l_imu: "FOOT_L",
      toes_l_imu: "FOOT_L",
    };

    // 1. Parse Header
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("inDegrees")) {
        if (line.includes("yes") || line.includes("true")) isDegrees = true;
      }
      if (line === "endheader") {
        headerEndIndex = i;
        // Next line is usually column headers
        if (i + 1 < lines.length) {
          columnNames = lines[i + 1].trim().split(/\s+/); // Split by whitespace (tabs or spaces)
        }
        break;
      }
    }

    if (headerEndIndex === -1 || columnNames.length === 0) {
      throw new Error(
        `Invalid OpenSim storage file: ${fileName}. Could not find 'endheader' or column names.`,
      );
    }

    const timeColumnIndex = columnNames.findIndex(
      (name) => name.toLowerCase() === "time",
    );
    if (timeColumnIndex === -1) {
      throw new Error(
        `Invalid OpenSim storage file: ${fileName}. Missing required 'time' column.`,
      );
    }

    const frames: ValidationFrame[] = [];

    // 2. Parse Data Rows
    for (let i = headerEndIndex + 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = line.split(/\s+/).map(Number);
      if (values.length !== columnNames.length) continue; // Skip malformed lines

      const time = values[timeColumnIndex];
      if (isNaN(time)) continue;

      const frame: ValidationFrame = {
        timestamp: time * 1000, // Convert to ms
        inputs: {},
        expectedOutputs: {},
      };

      // Heuristic Parsing: Detect if columns are Quaternions or Joint Angles
      // 2a. Quaternions: Look for suffixes like _IMU_Orientation_q0, _q1, etc. or just _q0, _q1...
      // Common OpenSense suffix: [sensor_name]_q0, [sensor_name]_q1...

      // We need to group columns by prefix.
      // Map: Prefix -> { q0: val, q1: val, q2: val, q3: val }
      const quatGroups: { [prefix: string]: { [comp: string]: number } } = {};

      // 2b. Kinematics: Look for joint names (e.g., knee_angle_r, hip_flexion_r)
      const jointAngles: { [joint: string]: { [axis: string]: number } } = {};

      columnNames.forEach((col, idx) => {
        if (col === "time") return;
        const val = values[idx];
        if (!Number.isFinite(val)) return;

        // Check for Quaternion components
        // Pattern: "torso_imu_q0" or "torso_q0"
        const qMatch = col.match(/(.+)[_]q([0-3])$/i);
        if (qMatch) {
          const prefix = qMatch[1]; // e.g. "torso_imu"
          const comp = `q${qMatch[2]}`; // "q0", "q1"...
          if (!quatGroups[prefix]) quatGroups[prefix] = {};
          quatGroups[prefix][comp] = val;
        } else {
          // Assume it's a joint angle/coordinate
          // We treat raw angles as entries in expectedOutputs
          // Typically: "knee_angle_r", "hip_flexion_r"
          // We'll store them raw for now, and map them later

          // Simple heuristic: if it looks like a coordinate
          if (!frame.expectedOutputs["raw"]) {
            frame.expectedOutputs["raw"] = {
              flexion: 0,
              abduction: 0,
              rotation: 0,
            }; // Container
          }
          // For flexible parsing, we might need a dynamic mapping structure in the future.
          // For this MVP, let's just create a generic "Kinematics" map we can query.

          // Hack: Store ALL non-quat values in a temporary 'custom' joint
          // The Validator will have to look up "knee_angle_r" from this map.
          // But ValidationFrame expects structured joints.
          // Let's adapt ValidationFrame to allow a flat map of "Coordinate Values"?

          // Actually, let's just infer standard ISB names if possible.
          // If col contains "knee" and "flex", map to flexion.
          const jointName = this.inferJointName(col);
          if (jointName) {
            if (!frame.expectedOutputs[jointName.name]) {
              frame.expectedOutputs[jointName.name] = {
                flexion: 0,
                abduction: 0,
                rotation: 0,
              };
            }
            const angleVal = isDegrees ? val : val * (180 / Math.PI);

            if (jointName.axis === "flexion")
              frame.expectedOutputs[jointName.name].flexion = angleVal;
            if (jointName.axis === "abduction")
              frame.expectedOutputs[jointName.name].abduction = angleVal;
            if (jointName.axis === "rotation")
              frame.expectedOutputs[jointName.name].rotation = angleVal;
          }
        }
      });

      // Reconstruct Quaternions
      for (const [prefix, comps] of Object.entries(quatGroups)) {
        if (
          comps.q0 !== undefined &&
          comps.q1 !== undefined &&
          comps.q2 !== undefined &&
          comps.q3 !== undefined
        ) {
          // Normalize standard OpenSim names to our Segment IDs
          // e.g. "pelvis_imu" -> "PELVIS"
          const mappedPrefix = SEGMENT_MAP[prefix] || prefix.toUpperCase(); // Fallback to uppercase

          // OpenSim Quaternions are usually [w, x, y, z] -> q0 is w
          frame.inputs[mappedPrefix] = new THREE.Quaternion(
            comps.q1,
            comps.q2,
            comps.q3,
            comps.q0,
          );
        }
      }

      frames.push(frame);
    }

    return {
      name: fileName,
      description: `Parsed from ${fileName}. ${lines.length} lines. Degrees: ${isDegrees}`,
      frames,
    };
  }

  private static inferJointName(
    colName: string,
  ): { name: string; axis: "flexion" | "abduction" | "rotation" } | null {
    const lower = colName.toLowerCase();
    let name = "";
    if (lower.includes("knee")) name = "knee";
    else if (lower.includes("hip")) name = "hip";
    else if (lower.includes("ankle")) name = "ankle";
    else return null; // Ignore non-joint cols

    // Side
    if (lower.endsWith("_r") || lower.includes("right")) name += "_r";
    else if (lower.endsWith("_l") || lower.includes("left")) name += "_l";
    else return null; // Require side

    // Axis
    let axis: "flexion" | "abduction" | "rotation" = "flexion"; // Default
    if (
      lower.includes("flex") ||
      lower.includes("pitch") ||
      lower.includes("angle")
    )
      axis = "flexion";
    // Note: knee_angle usually means flexion in OpenSim
    else if (
      lower.includes("add") ||
      lower.includes("abd") ||
      lower.includes("roll")
    )
      axis = "abduction";
    else if (lower.includes("rot") || lower.includes("yaw")) axis = "rotation";

    return { name, axis };
  }
}
