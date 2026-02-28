/**
 * Calibration Replay Test Script
 *
 * Run this to test calibration algorithms on recorded data.
 *
 * Usage (from browser console):
 *   1. Import: const { testCalibrationReplay } = await import('./src/calibration/testCalibrationReplay.ts')
 *   2. Run: testCalibrationReplay()
 *
 * Or run directly with: npx tsx src/calibration/testCalibrationReplay.ts
 */

import * as fs from "fs";
import * as path from "path";

// We need to set up THREE.js for Node environment
import * as THREE from "three";

// Import our calibration replay system
import {
  CalibrationReplay,
  runCalibrationTest,
  type DebugCapture,
} from "./CalibrationReplay";

// Path to your debug capture file
const DEBUG_CAPTURE_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  "IMU Connect App",
  "imu-connect-debug-capture-2026-01-08T21-51-22-761Z.json",
);

async function main() {
  console.log("Loading debug capture from:", DEBUG_CAPTURE_PATH);

  // Load the capture file
  const rawJson = fs.readFileSync(DEBUG_CAPTURE_PATH, "utf-8");
  const capture: DebugCapture = JSON.parse(rawJson);

  console.log(
    `\nLoaded: ${capture.samples.length} samples @ ${capture.sampleHz}Hz`,
  );
  console.log(`Captured at: ${capture.capturedAtIso}`);

  // Run the calibration test
  runCalibrationTest(capture);

  // Additional analysis: Show per-phase statistics
  console.log("\n========== PHASE ANALYSIS ==========\n");

  const replay = new CalibrationReplay(capture);
  const phases = replay.getPhases();

  // Analyze gyro during each phase
  for (const [phaseName, phase] of Object.entries(phases)) {
    const startIdx = (phase as any).startFrame;
    const endIdx = (phase as any).endFrame;

    console.log(`${phaseName}:`);
    console.log(`  Frames: ${startIdx} - ${endIdx}`);
    console.log(
      `  Duration: ${((endIdx - startIdx) / capture.sampleHz).toFixed(2)}s`,
    );

    // Compute average gyro magnitude per segment
    const segmentGyro = new Map<string, number[]>();

    for (let i = startIdx; i <= endIdx; i++) {
      const sample = capture.samples[i];
      for (const device of sample.devices) {
        const [gx, gy, gz] = device.gyro;
        const mag = Math.sqrt(gx * gx + gy * gy + gz * gz);

        if (!segmentGyro.has(device.segmentId)) {
          segmentGyro.set(device.segmentId, []);
        }
        segmentGyro.get(device.segmentId)!.push(mag);
      }
    }

    for (const [segment, mags] of segmentGyro) {
      const avg = mags.reduce((a, b) => a + b, 0) / mags.length;
      const max = Math.max(...mags);
      console.log(
        `    ${segment}: avg=${avg.toFixed(3)} rad/s, max=${max.toFixed(3)} rad/s`,
      );
    }

    console.log();
  }

  // Show SARA-eligible joint pairs
  console.log("========== SARA-ELIGIBLE JOINTS ==========\n");

  const segments = [
    ...new Set(capture.samples[0].devices.map((d) => d.segmentId)),
  ];

  const jointPairs = [
    { jointId: "knee_r", proximal: "thigh_r", distal: "tibia_r" },
    { jointId: "knee_l", proximal: "thigh_l", distal: "tibia_l" },
    { jointId: "ankle_r", proximal: "tibia_r", distal: "foot_r" },
    { jointId: "ankle_l", proximal: "tibia_l", distal: "foot_l" },
  ];

  for (const joint of jointPairs) {
    const hasProximal = segments.includes(joint.proximal);
    const hasDistal = segments.includes(joint.distal);
    const status = hasProximal && hasDistal ? "✓" : "✗";
    console.log(
      `  ${status} ${joint.jointId}: ${joint.proximal} + ${joint.distal}`,
    );
  }
}

main().catch(console.error);
