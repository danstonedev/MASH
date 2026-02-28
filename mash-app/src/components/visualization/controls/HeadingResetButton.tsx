import React from "react";
import { useCalibrationStore } from "../../../store/useCalibrationStore";
import { useTareStore } from "../../../store/useTareStore";
import {
  useDeviceRegistry,
  deviceQuaternionCache,
} from "../../../store/useDeviceRegistry";
import { useSensorAssignmentStore } from "../../../store/useSensorAssignmentStore";
import { firmwareToThreeQuat } from "../../../lib/math/conventions";
import * as THREE from "three";

export const HeadingResetButton = () => {
  const getSegmentForSensor = useSensorAssignmentStore(
    (state) => state.getSegmentForSensor,
  );

  const handleReset = () => {
    const devices = useDeviceRegistry.getState().devices;
    const calibStore = useCalibrationStore.getState();
    const tareStore = useTareStore.getState();

    // Build map of segment quaternions (calibration-corrected)
    const segmentQuats = new Map<string, THREE.Quaternion>();

    devices.forEach((device, deviceId) => {
      const segment = getSegmentForSensor(deviceId);
      if (!segment) return;

      // Get current quaternion from cache (more reliable than device.quaternion)
      const cachedQuat = deviceQuaternionCache.get(deviceId);
      const rawQuat = cachedQuat || device.quaternion;

      // Convert to world frame
      const worldQuat = firmwareToThreeQuat(rawQuat);

      // Apply calibration offset if available
      const calibData = calibStore.getCalibration(segment);
      if (calibData) {
        worldQuat.multiply(calibData.offset);
      }

      segmentQuats.set(segment, worldQuat);
    });

    if (segmentQuats.size === 0) {
      console.warn("[HeadingReset] No calibrated sensors found");
      return;
    }

    // Use useTareStore to capture global heading tare for all segments
    tareStore.captureGlobalHeadingTare(segmentQuats);

    console.debug(
      `[HeadingReset] Captured heading tare for ${segmentQuats.size} segments`,
    );
  };

  return (
    <button
      onClick={handleReset}
      className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-md flex items-center justify-center gap-2 transition-colors border border-zinc-700"
      title="Re-center the model's facing direction (Fix Yaw Drift)"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
      <span>Reset Heading</span>
    </button>
  );
};
