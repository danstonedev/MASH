/**
 * DeviceInterface.ts — Packet type definitions for IMU data pipeline
 *
 * These types define the data structures exchanged between firmware (via BLE/Serial)
 * and the web application. Originally part of the BLE connection layer, now used
 * by both BLE and Serial connection paths.
 */

// ============================================================================
// Sync Quality
// ============================================================================

/** Per-sample synchronisation quality metadata (from TDMA sync protocol) */
export interface SyncQuality {
  offsetUncertaintyUs: number;
  driftPpmX10: number;
  lastSyncAgeMs: number;
  confidence: number; // 0–3 (None/Low/Medium/High)
  kalmanInitialized: boolean;
  outlierRejected: boolean;
}

// ============================================================================
// IMU Data Packet
// ============================================================================

/** High-frequency IMU orientation + inertial data (one per sensor per frame) */
export interface IMUDataPacket {
  sensorId: number;
  timestamp: number; // seconds
  timestampUs: number; // microseconds
  frameNumber: number;
  quaternion: [number, number, number, number]; // [w, x, y, z]
  accelerometer: [number, number, number]; // [x, y, z] in g
  gyro: [number, number, number]; // [x, y, z] in rad/s
  battery: number;
  format: string; // e.g. "0x25-sync"
  syncQuality?: SyncQuality;
  /** OPP-2: Frame completeness metadata */
  frameCompleteness?: {
    validCount: number;
    expectedCount: number;
    isComplete: boolean;
  };
  /** Segment assignment (used in playback) */
  segment?: string;
}

// ============================================================================
// Environmental Data
// ============================================================================

export interface MagnetometerData {
  x: number;
  y: number;
  z: number;
  heading: number;
}

export interface BarometerData {
  pressure: number;
  temperature: number;
  altitude: number;
}

/** Low-frequency environmental sensor packet (magnetometer + barometer) */
export interface EnvironmentalDataPacket {
  timestamp: number;
  magnetometer?: MagnetometerData;
  barometer?: BarometerData;
}

// ============================================================================
// Node Info / Discovery
// ============================================================================

/** Node discovery packet (0x05) — identifies a sensor node on the network */
export interface NodeInfoPacket {
  nodeName: string;
  sensorIdOffset: number;
  sensorCount: number;
  hasMagnetometer: boolean;
  hasBarometer: boolean;
  useMux?: boolean;
  sensorChannels?: number[];
}

// ============================================================================
// JSON Command / Status
// ============================================================================

/** Generic JSON payload from firmware status or command responses (0x06) */
export interface JSONPacket {
  [key: string]: unknown;
}
