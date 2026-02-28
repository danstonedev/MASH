import Dexie, { type Table } from "dexie";
import type {
  IDataManager,
  RecordedFrame,
  RecordedEnvFrame,
  RecordingSession,
  SessionExportData,
} from "./types";

class IMUConnectDB extends Dexie {
  sessions!: Table<RecordingSession>;
  imuFrames!: Table<RecordedFrame>;
  envFrames!: Table<RecordedEnvFrame>;

  constructor() {
    super("imu-connect-db");

    // Version 1: Original schema
    this.version(1).stores({
      sessions: "id, startTime, name",
      imuFrames: "++id, sessionId, sensorId, [sessionId+timestamp]",
      envFrames: "++id, sessionId, [sessionId+timestamp]",
    });

    // Version 2: Added athleteId index
    this.version(2).stores({
      sessions: "id, startTime, name, athleteId",
      imuFrames: "++id, sessionId, sensorId, [sessionId+timestamp]",
      envFrames: "++id, sessionId, [sessionId+timestamp]",
    });

    // Version 3: Enhanced schema with segment field
    // (new fields are added automatically, we just need index updates)
    this.version(3).stores({
      sessions: "id, startTime, name, athleteId",
      imuFrames: "++id, sessionId, sensorId, segment, [sessionId+timestamp]",
      envFrames: "++id, sessionId, sensorId, [sessionId+timestamp]",
    });
  }
}

// Legacy db export for components that haven't migrated to dataManager yet
export const db = new IMUConnectDB();

export class LocalDataManager implements IDataManager {
  private _db: IMUConnectDB;

  constructor() {
    this._db = db; // Use the shared instance
  }

  // Session Management
  async createSession(session: RecordingSession): Promise<void> {
    await this._db.sessions.add(session);
  }

  async updateSession(
    id: string,
    updates: Partial<RecordingSession>,
  ): Promise<void> {
    await this._db.sessions.update(id, updates);
  }

  async getSession(id: string): Promise<RecordingSession | undefined> {
    return await this._db.sessions.get(id);
  }

  async getAllSessions(athleteId?: string): Promise<RecordingSession[]> {
    if (athleteId) {
      return await this._db.sessions
        .where("athleteId")
        .equals(athleteId)
        .reverse()
        .sortBy("startTime");
    }
    return await this._db.sessions.orderBy("startTime").reverse().toArray();
  }

  async deleteSession(id: string): Promise<void> {
    await this._db.transaction(
      "rw",
      this._db.sessions,
      this._db.imuFrames,
      this._db.envFrames,
      async () => {
        await this._db.imuFrames.where("sessionId").equals(id).delete();
        await this._db.envFrames.where("sessionId").equals(id).delete();
        await this._db.sessions.delete(id);
      },
    );
  }

  // Frame Recording
  async saveFrame(frame: RecordedFrame): Promise<void> {
    await this._db.imuFrames.add(frame);
  }

  async bulkSaveFrames(frames: RecordedFrame[]): Promise<void> {
    if (frames.length === 0) return;
    await this._db.imuFrames.bulkAdd(frames);
  }

  async saveEnvFrame(frame: RecordedEnvFrame): Promise<void> {
    await this._db.envFrames.add(frame);
  }

  // Bulk Operations
  async exportSessionData(sessionId: string): Promise<RecordedFrame[]> {
    return await this._db.imuFrames
      .where("sessionId")
      .equals(sessionId)
      .sortBy("timestamp");
  }

  async exportEnvData(sessionId: string): Promise<RecordedEnvFrame[]> {
    return await this._db.envFrames
      .where("sessionId")
      .equals(sessionId)
      .sortBy("timestamp");
  }

  /**
   * Export complete session with all frames and metadata.
   * Following biomechanics industry best practices for comprehensive data export.
   */
  async exportFullSession(
    sessionId: string,
  ): Promise<SessionExportData | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    const imuFrames = await this.exportSessionData(sessionId);
    const envFrames = await this.exportEnvData(sessionId);

    return {
      session,
      imuFrames,
      envFrames,
      exportedAt: new Date().toISOString(),
      exportVersion: "1.0.0",
    };
  }

  async clearAllData(): Promise<void> {
    await this._db.imuFrames.clear();
    await this._db.envFrames.clear();
    await this._db.sessions.clear();
  }
}
