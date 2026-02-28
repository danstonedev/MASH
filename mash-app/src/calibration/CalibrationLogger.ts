/**
 * Calibration Logger
 *
 * Logs all calibration events to IndexedDB for:
 * 1. Debugging and diagnostics
 * 2. Export for analysis
 * 3. Future ML training data
 *
 * Data is stored locally and can be exported as JSON.
 */

// ============================================================================
// TYPES
// ============================================================================

export type CorrectionType = "zupt" | "heading" | "constraint" | "drift";

export interface CalibrationSession {
  id: string;
  startTime: number;
  endTime?: number;

  // Initial calibration results
  initialOffsets: Record<
    string,
    {
      offset: [number, number, number, number]; // quaternion
      quality: number;
      method: "pose" | "pca-refined";
      pcaConfidence?: number;
    }
  >;

  // Overall stats
  overallQuality: number;
  sensorsCalibrated: number;
}

export interface CorrectionEvent {
  type: CorrectionType;
  sensor: string;
  magnitude: number; // degrees
  correction: [number, number, number, number]; // quaternion
  confidence: number;
  timestamp: number;
}

export interface CalibrationLogEntry {
  sessionId: string;
  session: CalibrationSession;
  corrections: CorrectionEvent[];
}

// ============================================================================
// INDEXEDDB WRAPPER
// ============================================================================

const DB_NAME = "imu-connect-calibration-log";
const DB_VERSION = 1;
const SESSIONS_STORE = "sessions";
const CORRECTIONS_STORE = "corrections";

class CalibrationLogger {
  private db: IDBDatabase | null = null;
  private currentSessionId: string | null = null;
  private pendingCorrections: CorrectionEvent[] = [];
  private flushInterval: number | null = null;

  constructor() {
    this.initDB();
  }

  /**
   * Initialize IndexedDB
   */
  private async initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error(
          "[CalibrationLogger] Failed to open IndexedDB",
          request.error,
        );
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.debug("[CalibrationLogger] IndexedDB initialized");

        // Start periodic flush
        this.flushInterval = window.setInterval(
          () => this.flushCorrections(),
          5000,
        );

        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Sessions store
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          const sessionsStore = db.createObjectStore(SESSIONS_STORE, {
            keyPath: "id",
          });
          sessionsStore.createIndex("startTime", "startTime", {
            unique: false,
          });
        }

        // Corrections store
        if (!db.objectStoreNames.contains(CORRECTIONS_STORE)) {
          const correctionsStore = db.createObjectStore(CORRECTIONS_STORE, {
            keyPath: ["sessionId", "timestamp"],
          });
          correctionsStore.createIndex("sessionId", "sessionId", {
            unique: false,
          });
          correctionsStore.createIndex("type", "type", { unique: false });
          correctionsStore.createIndex("timestamp", "timestamp", {
            unique: false,
          });
        }
      };
    });
  }

  /**
   * Start a new calibration session
   */
  async startSession(): Promise<string> {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.currentSessionId = sessionId;

    const session: CalibrationSession = {
      id: sessionId,
      startTime: Date.now(),
      initialOffsets: {},
      overallQuality: 0,
      sensorsCalibrated: 0,
    };

    if (this.db) {
      const tx = this.db.transaction(SESSIONS_STORE, "readwrite");
      const store = tx.objectStore(SESSIONS_STORE);
      store.add(session);
    }

    console.debug(`[CalibrationLogger] Started session ${sessionId}`);
    return sessionId;
  }

  /**
   * Log initial calibration results
   */
  async logCalibrationComplete(
    offsets: Map<
      string,
      {
        offset: [number, number, number, number];
        quality: number;
        method: "pose" | "pca-refined";
        pcaConfidence?: number;
      }
    >,
    overallQuality: number,
  ): Promise<void> {
    if (!this.db || !this.currentSessionId) return;

    const offsetsObj: Record<string, any> = {};
    offsets.forEach((value, key) => {
      offsetsObj[key] = value;
    });

    const tx = this.db.transaction(SESSIONS_STORE, "readwrite");
    const store = tx.objectStore(SESSIONS_STORE);

    const request = store.get(this.currentSessionId);
    request.onsuccess = () => {
      const session = request.result as CalibrationSession;
      if (session) {
        session.initialOffsets = offsetsObj;
        session.overallQuality = overallQuality;
        session.sensorsCalibrated = offsets.size;
        session.endTime = Date.now();
        store.put(session);
      }
    };

    console.debug(
      `[CalibrationLogger] Logged calibration complete: ${offsets.size} sensors, quality ${overallQuality.toFixed(0)}%`,
    );
  }

  /**
   * Log a runtime correction (batched for performance)
   */
  logCorrection(correction: CorrectionEvent): void {
    if (!this.currentSessionId) {
      // Auto-start session if none exists
      this.startSession();
    }

    this.pendingCorrections.push({
      ...correction,
      timestamp: Date.now(),
    });

    // Flush if buffer is large
    if (this.pendingCorrections.length >= 50) {
      this.flushCorrections();
    }
  }

  /**
   * Flush pending corrections to IndexedDB
   */
  private async flushCorrections(): Promise<void> {
    if (
      !this.db ||
      !this.currentSessionId ||
      this.pendingCorrections.length === 0
    )
      return;

    const corrections = [...this.pendingCorrections];
    this.pendingCorrections = [];

    const tx = this.db.transaction(CORRECTIONS_STORE, "readwrite");
    const store = tx.objectStore(CORRECTIONS_STORE);

    corrections.forEach((correction) => {
      store.add({
        sessionId: this.currentSessionId,
        ...correction,
      });
    });

    console.debug(
      `[CalibrationLogger] Flushed ${corrections.length} corrections`,
    );
  }

  /**
   * Get all sessions
   */
  async getSessions(): Promise<CalibrationSession[]> {
    if (!this.db) return [];

    return new Promise((resolve) => {
      const tx = this.db!.transaction(SESSIONS_STORE, "readonly");
      const store = tx.objectStore(SESSIONS_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        resolve([]);
      };
    });
  }

  /**
   * Get corrections for a session
   */
  async getCorrections(sessionId: string): Promise<CorrectionEvent[]> {
    if (!this.db) return [];

    return new Promise((resolve) => {
      const tx = this.db!.transaction(CORRECTIONS_STORE, "readonly");
      const store = tx.objectStore(CORRECTIONS_STORE);
      const index = store.index("sessionId");
      const request = index.getAll(sessionId);

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        resolve([]);
      };
    });
  }

  /**
   * Export all data as JSON for ML training
   */
  async exportForML(): Promise<CalibrationLogEntry[]> {
    const sessions = await this.getSessions();
    const entries: CalibrationLogEntry[] = [];

    for (const session of sessions) {
      const corrections = await this.getCorrections(session.id);
      entries.push({
        sessionId: session.id,
        session,
        corrections,
      });
    }

    return entries;
  }

  /**
   * Export as downloadable JSON file
   */
  async downloadExport(): Promise<void> {
    const data = await this.exportForML();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `calibration-log-${Date.now()}.json`;
    a.click();

    URL.revokeObjectURL(url);
  }

  /**
   * Get statistics for current session
   */
  async getCurrentSessionStats(): Promise<{
    sessionId: string | null;
    correctionCount: number;
    correctionsByType: Record<CorrectionType, number>;
    duration: number;
  }> {
    if (!this.currentSessionId) {
      return {
        sessionId: null,
        correctionCount: 0,
        correctionsByType: { zupt: 0, heading: 0, constraint: 0, drift: 0 },
        duration: 0,
      };
    }

    const corrections = await this.getCorrections(this.currentSessionId);
    const sessions = await this.getSessions();
    const session = sessions.find((s) => s.id === this.currentSessionId);

    const byType: Record<CorrectionType, number> = {
      zupt: 0,
      heading: 0,
      constraint: 0,
      drift: 0,
    };
    corrections.forEach((c) => {
      byType[c.type]++;
    });

    return {
      sessionId: this.currentSessionId,
      correctionCount: corrections.length + this.pendingCorrections.length,
      correctionsByType: byType,
      duration: session ? Date.now() - session.startTime : 0,
    };
  }

  /**
   * Clear all stored data
   */
  async clearAll(): Promise<void> {
    if (!this.db) return;

    const tx = this.db.transaction(
      [SESSIONS_STORE, CORRECTIONS_STORE],
      "readwrite",
    );
    tx.objectStore(SESSIONS_STORE).clear();
    tx.objectStore(CORRECTIONS_STORE).clear();

    this.currentSessionId = null;
    this.pendingCorrections = [];

    console.debug("[CalibrationLogger] Cleared all data");
  }

  /**
   * Cleanup on unmount
   */
  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flushCorrections();
  }
}

// Singleton instance
export const calibrationLogger = new CalibrationLogger();
