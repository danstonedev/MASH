import {
  useDeviceRegistry,
  deviceQuaternionCache,
  deviceAccelCache,
  deviceGyroCache,
} from "../store/useDeviceRegistry";
import { usePlaybackStore } from "../store/usePlaybackStore";
import * as THREE from "three";

export interface StandardizedSensorData {
  quaternion: [number, number, number, number]; // [w, x, y, z]
  acceleration: [number, number, number]; // [x, y, z]
  gyro: [number, number, number]; // [x, y, z]
  isStationary?: boolean;
  timestamp: number;
}

// Reusable data objects to prevent garbage collection churn
const nullData: StandardizedSensorData = {
  quaternion: [1, 0, 0, 0],
  acceleration: [0, 0, 0],
  gyro: [0, 0, 0],
  isStationary: true,
  timestamp: 0,
};

// Helper: resolve device key → compact sensor ID for playback frame lookup.
// Device keys ("node_44_s0") don't embed the compact ID, so we look it up
// from the device registry's packetSensorId field.
const getPlaybackSensorId = (deviceId: string): number => {
  const device = useDeviceRegistry.getState().devices.get(deviceId);
  return device?.packetSensorId ?? -1;
};

/**
 * useSensorData Hook
 * ==================
 * "The Single Source of Truth for Sensor Data."
 *
 * Abstracts away the difference between:
 * 1. Live Serial Data (High-performance Cache)
 * 2. Recorded Playback Data (Frame-by-frame)
 *
 * Returns standardized data for visualization components.
 *
 * @param deviceId The string ID of the device (e.g., "node_44_s0")
 */
export function getSensorData(
  deviceId: string | null,
): StandardizedSensorData | null {
  if (!deviceId) return null;

  // 1. Check Playback Mode - sessionId being set means we're in playback
  // (regardless of play/pause state or current time position)
  const playbackState = usePlaybackStore.getState();
  const isPlayback = playbackState.sessionId !== null;

  if (isPlayback) {
    const id = getPlaybackSensorId(deviceId);

    // 1. Get Interpolated Data (Smooth Motion)
    const interpolated = playbackState.getInterpolatedFrame(id);

    // 2. Get Raw Frame (for Acceleration / Metadata)
    const rawFrame = playbackState.getFrameAtTime(id);

    if (!interpolated) return nullData;

    return {
      // Convert THREE.Quaternion back to [w, x, y, z] standard
      quaternion: [
        interpolated.quaternion.w,
        interpolated.quaternion.x,
        interpolated.quaternion.y,
        interpolated.quaternion.z,
      ],
      // Fallback to raw frame for acceleration (not interpolated yet)
      acceleration: rawFrame
        ? (rawFrame as any).accelerometer ||
          (rawFrame as any).accel || [0, 0, 0]
        : [0, 0, 0],
      gyro: (interpolated.gyro as [number, number, number]) || [0, 0, 0],
      isStationary: undefined, // Let client calculate ZUPT from raw data
      timestamp: playbackState.currentTime, // Use actual playback cursor time
    };
  }

  // 2. Live Mode - Direct Cache Access (Fastest)
  const quat = deviceQuaternionCache.get(deviceId);
  if (!quat) return null; // Device not streaming yet

  const accel = deviceAccelCache.get(deviceId) || [0, 0, 0];
  const gyro = deviceGyroCache.get(deviceId) || [0, 0, 0];

  // We can fetch live stationary status from Registry state if strictly needed,
  // but for high-freq render, we might infer or retrieve from a stats cache.
  // For now, let's grab it from the registry map, assuming it doesn't cause a React re-render loop
  // (accessing .getState() is safe/non-reactive).
  const deviceState = useDeviceRegistry.getState().devices.get(deviceId);

  return {
    quaternion: quat,
    acceleration: accel,
    gyro: gyro,
    isStationary: deviceState?.isStationary ?? false,
    timestamp: deviceState?.lastUpdate ?? 0,
  };
}
