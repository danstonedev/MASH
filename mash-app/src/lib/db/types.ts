import type {
  IMUDataPacket,
  EnvironmentalDataPacket,
} from "../ble/DeviceInterface";

/**
 * Serialized calibration offset for storage.
 * Following ISB/OpenSim conventions for quaternion representation.
 */
export interface SerializedCalibrationOffset {
  segmentId: string;
  offset: [number, number, number, number]; // Quaternion [w, x, y, z]
  alignmentQuaternion?: [number, number, number, number];
  headingCorrection?: [number, number, number, number];
  quality: number; // 0-100 quality score
  method: "single-pose" | "dual-pose" | "functional" | "pca";
  capturedAt: number;
}

/**
 * Recorded IMU frame with segment assignment.
 * Per biomechanics best practices: includes sensor placement and timestamps.
 */
export interface RecordedFrame extends IMUDataPacket {
  id?: number;
  sessionId: string;
  systemTime: number; // Wall-clock time (Unix ms)
  segment?: string; // Body segment this sensor is assigned to (e.g., 'pelvis', 'thigh_r')
  sensorName?: string; // Provisioned sensor name for identification
  /** Frame completeness metadata from firmware sync frame (Issue #3) */
  frameCompleteness?: {
    validCount: number;
    expectedCount: number;
    isComplete: boolean;
  };
  /**
   * Bitfield of integrity anomalies detected on this packet.
   * 0 = clean. See IntegrityFlag in SensorIntegrityMonitor.ts for bit meanings.
   * Only set when flags != 0 to minimise storage overhead.
   */
  integrityFlags?: number;
}

/**
 * Recorded environmental frame (barometer, magnetometer).
 */
export interface RecordedEnvFrame extends EnvironmentalDataPacket {
  id?: number;
  sessionId: string;
  sensorId?: number; // Associate with specific sensor if applicable
}

/**
 * Recording session metadata.
 * Following C3D/OpenSim conventions for comprehensive metadata storage.
 */
export interface RecordingSession {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  sensorCount: number;
  athleteId?: string;
  coachId?: string;

  // ============ Enhanced Metadata (Industry Best Practices) ============

  /** Sensor ID to body segment mapping (e.g., { 1: 'pelvis', 2: 'thigh_r' }) */
  sensorMapping?: Record<number, string>;

  /** Calibration offsets captured at start of recording - required for playback reconstruction */
  calibrationOffsets?: SerializedCalibrationOffset[];

  /** Full 3-level tare states for PhD-grade orientation pipeline */
  tareStates?: {
    segmentId: string;
    mountingTare: [number, number, number, number];
    headingTare: [number, number, number, number];
    jointTare: { flexion: number; abduction: number; rotation: number };
    mountingTareTime: number;
    headingTareTime: number;
    jointTareTime: number;
  }[];

  /** Actual sample rate during recording (Hz) */
  sampleRate?: number;

  /** Device/firmware information for reproducibility */
  firmwareVersion?: string;
  deviceName?: string;

  /** Environmental conditions at time of recording */
  environmentalConditions?: {
    temperature?: number; // Celsius
    pressure?: number; // hPa
    altitude?: number; // meters
  };

  /** Notes/comments about the session */
  notes?: string;

  /** Activity type (e.g., speed_skating, hockey, running) */
  activityType?: string;

  /** Tags for categorization */
  tags?: string[];

  /** Data quality summary captured at end of recording */
  dataQuality?: {
    totalFrames: number; // Total sync frames (unique frameNumbers)
    completeFrames: number; // Frames with all sensors present
    completenessPercent: number; // completeFrames / totalFrames * 100
    sensorCount: number; // Unique sensors seen during recording
    duplicatesDropped: number; // Packets dropped as duplicates
    startGateDropped: number; // Packets dropped by start-gate
    stopTrimDropped: number; // Packets dropped by stop-trim
    pauseTrimDropped: number; // Packets dropped by pause-trim
    /** Sensor integrity summary — anomalies detected during recording */
    integrity?: {
      totalChecked: number;
      totalFlagged: number;
      flagCounts: Record<string, number>;
      perSensor: Record<string, { checked: number; flagged: number; flags: Record<string, number> }>;
    };
  };

  /** Summary Metrics (Aggregated results from Analysis Engine) */
  metrics?: {
    // General
    duration?: number;
    calories?: number;

    // Neuromuscular
    avgComplexityScore?: number;
    avgStabilityIndex?: number;

    // Skating
    avgStrokeRate?: number;
    avgGlideEfficiency?: number;
    pushOffAsymmetry?: number;

    // Jump
    maxJumpHeight?: number;
    avgRSI?: number;

    // Squat
    maxDepth?: number;
    avgFormScore?: number;

    // Balance
    minSwayArea?: number;
  };
}

/**
 * Complete session export data including all frames and metadata.
 * Used for JSON export per biomechanics data standards.
 */
export interface SessionExportData {
  session: RecordingSession;
  imuFrames: RecordedFrame[];
  envFrames: RecordedEnvFrame[];
  exportedAt: string; // ISO 8601 timestamp
  exportVersion: string; // Schema version for future compatibility
}

/**
 * Data Manager Interface
 * Abstracts the storage layer (Local IndexedDB vs Cloud Azure)
 */
export interface IDataManager {
  // Session Management
  createSession(session: RecordingSession): Promise<void>;
  updateSession(id: string, updates: Partial<RecordingSession>): Promise<void>;
  getSession(id: string): Promise<RecordingSession | undefined>;
  getAllSessions(athleteId?: string): Promise<RecordingSession[]>;
  deleteSession(id: string): Promise<void>;

  // Frame Recording (High Frequency)
  saveFrame(frame: RecordedFrame): Promise<void>;
  saveEnvFrame(frame: RecordedEnvFrame): Promise<void>;

  // Batched Frame Recording (Performance Optimization)
  // Writes multiple frames in a single IndexedDB transaction
  bulkSaveFrames(frames: RecordedFrame[]): Promise<void>;

  // Bulk Operations
  exportSessionData(sessionId: string): Promise<RecordedFrame[]>;
  exportEnvData?(sessionId: string): Promise<RecordedEnvFrame[]>;
  exportFullSession?(sessionId: string): Promise<SessionExportData | null>;
  clearAllData(): Promise<void>;
}
