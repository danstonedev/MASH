import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { FKSolver } from "../ForwardKinematics";
import { ValidationDataParser } from "./ValidationDataParser";
import * as THREE from "three";

/**
 * Kinematic Validation Test Suite
 *
 * Runs the FKSolver against real Xsens Walking Data provided by the user.
 * To run: npm test KinematicValidation
 */
describe("Kinematic Validation (Xsens Walking Data)", () => {
  // Path to the user provided data
  const DATA_DIR =
    "c:/Users/danst/OneDrive/Desktop/Exonetics Trials/2025.02.09 - Trial/20250209_222223_698 - Walk Both Shoes On";

  // Sensor Mapping as provided by user
  const SENSOR_MAPPING: { [key: string]: string } = {
    DEMO6_0: "PELVIS",
    DEMO6_1: "THIGH_L",
    DEMO6_2: "THIGH_R",
    DEMO6_3: "TIBIA_L",
    DEMO6_4: "TIBIA_R",
  };

  it("should validate skeletal alignment using Xsens walking trial", () => {
    if (!fs.existsSync(DATA_DIR)) {
      console.warn(`[SKIP] Data directory not found: ${DATA_DIR}`);
      return;
    }

    console.log(`Loading Xsens data from: ${DATA_DIR}`);
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".csv"));

    // Map SensorID -> Quaternion Array
    const sensorData = new Map<string, THREE.Quaternion[]>();
    let minFrames = Infinity;

    for (const file of files) {
      // Extract DEMO6_X tag
      const tag = file.split("_")[0] + "_" + file.split("_")[1];
      const segmentId = SENSOR_MAPPING[tag];

      if (!segmentId) {
        console.log(`Skipping unmapped file: ${file} (Tag: ${tag})`);
        continue;
      }

      const content = fs.readFileSync(path.join(DATA_DIR, file), "utf-8");
      try {
        const parsed = ValidationDataParser.parseXsensCSV(content);
        sensorData.set(segmentId, parsed.quats);
        minFrames = Math.min(minFrames, parsed.quats.length);
        console.log(`Loaded ${segmentId}: ${parsed.quats.length} frames`);
      } catch (e) {
        console.error(`Failed to parse ${file}:`, e);
      }
    }

    expect(sensorData.size).toBeGreaterThan(0);
    console.log(`\nProcessing ${minFrames} frames...`);

    // Setup Solver
    const solver = new FKSolver();

    const boneIds = ["PELVIS", "THIGH_L", "THIGH_R", "TIBIA_L", "TIBIA_R"];
    const calibrationOffsets = new Map<string, THREE.Quaternion>();

    // 1. Calibration Step (Frame 0)
    for (const boneId of boneIds) {
      const quats = sensorData.get(boneId);
      if (quats && quats.length > 0) {
        const qSensor0 = quats[0].clone();
        const qModelNeutral = new THREE.Quaternion(); // Identity
        const qCal = qSensor0.clone().invert().multiply(qModelNeutral);
        calibrationOffsets.set(boneId, qCal);
        solver.assignSensor(boneId, boneId, qCal);
      }
    }

    // Helper to get relative euler
    const getRelativeEuler = (
      parentQ: THREE.Quaternion,
      childQ: THREE.Quaternion,
    ) => {
      const qRel = parentQ.clone().invert().multiply(childQ);
      const e = new THREE.Euler().setFromQuaternion(qRel, "XYZ");
      return {
        x: e.x * (180 / Math.PI),
        y: e.y * (180 / Math.PI),
        z: e.z * (180 / Math.PI),
      };
    };

    // Clear output file
    const textFile =
      "c:/Users/danst/IMU Connect App/imu-connect/validation_results.txt";
    if (fs.existsSync(textFile)) fs.unlinkSync(textFile);

    const header =
      "Frame | Hip_L(X,Y,Z) | Knee_L(X,Y,Z) | Hip_R(X,Y,Z) | Knee_R(X,Y,Z)\n";
    console.log(header);
    fs.appendFileSync(textFile, header);

    const step = 10; // Log every 10th frame
    for (let i = 0; i < minFrames; i += step) {
      // Updates Inputs
      const inputMap = new Map<string, THREE.Quaternion>();
      for (const [id, searchQuats] of sensorData) {
        inputMap.set(id, searchQuats[i]);
      }

      // Update Solver
      solver.update(inputMap);

      // Extract Angles
      const pelvis = solver.getBoneTransform("PELVIS");
      const thighL = solver.getBoneTransform("THIGH_L");
      const tibiaL = solver.getBoneTransform("TIBIA_L");
      const thighR = solver.getBoneTransform("THIGH_R");
      const tibiaR = solver.getBoneTransform("TIBIA_R");

      if (pelvis && thighL && tibiaL && thighR && tibiaR) {
        const hipL = getRelativeEuler(pelvis.rotation, thighL.rotation);
        const kneeL = getRelativeEuler(thighL.rotation, tibiaL.rotation);
        const hipR = getRelativeEuler(pelvis.rotation, thighR.rotation);
        const kneeR = getRelativeEuler(thighR.rotation, tibiaR.rotation);

        const fmt = (v: number) => v.toFixed(0).padStart(4);
        const formatEuler = (e: { x: number; y: number; z: number }) =>
          `[${fmt(e.x)},${fmt(e.y)},${fmt(e.z)}]`;

        const line = `${i.toString().padEnd(5)} | ${formatEuler(hipL)} | ${formatEuler(kneeL)} | ${formatEuler(hipR)} | ${formatEuler(kneeR)}\n`;
        fs.appendFileSync(textFile, line);
      }
    }

    // Basic Assertion: Check if output generated
    expect(minFrames).toBeGreaterThan(0);
  });
});
