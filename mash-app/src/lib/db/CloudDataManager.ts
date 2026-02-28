/**
 * CloudDataManager
 *
 * Implements IDataManager interface using Azure Functions API for session data
 * and IndexedDB for high-frequency frame data (hybrid approach).
 *
 * Architecture:
 * - Sessions: Stored in Azure SQL via API
 * - Frames: Stored locally in IndexedDB (too high-frequency for cloud sync)
 */

import type {
  IDataManager,
  RecordedFrame,
  RecordedEnvFrame,
  RecordingSession,
} from "./types";
import { db } from "./LocalDataManager"; // Use shared db for frames

const API_BASE = "/api";

export class CloudDataManager implements IDataManager {
  private isOnline: boolean = true;

  private mergeWithLocalSession(
    cloud: RecordingSession | undefined,
    local: RecordingSession | undefined,
  ): RecordingSession | undefined {
    if (!cloud) return local;
    if (!local) return cloud;
    // Prefer local for richer metadata fields while still taking cloud canonical basics.
    return { ...cloud, ...local };
  }

  constructor() {
    // Monitor online status
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => (this.isOnline = true));
      window.addEventListener("offline", () => (this.isOnline = false));
      this.isOnline = navigator.onLine;
    }
  }

  // ============================================
  // Session Management (→ Cloud via API)
  // ============================================

  async createSession(session: RecordingSession): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/sessions-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
      });

      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.statusText}`);
      }

      // Also save locally as backup
      await db.sessions.put(session);
    } catch (error) {
      console.warn("[CloudDataManager] Falling back to local storage:", error);
      await db.sessions.put(session);
    }
  }

  async updateSession(
    id: string,
    updates: Partial<RecordingSession>,
  ): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/sessions-update?id=${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...updates }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update session: ${response.statusText}`);
      }

      // Also update locally
      await db.sessions.update(id, updates);
    } catch (error) {
      console.warn("[CloudDataManager] Falling back to local storage:", error);
      await db.sessions.update(id, updates);
    }
  }

  async getSession(id: string): Promise<RecordingSession | undefined> {
    try {
      const response = await fetch(`${API_BASE}/sessions-get?id=${id}`);

      if (!response.ok) {
        throw new Error(`Failed to get session: ${response.statusText}`);
      }

      const data = await response.json();
      const cloudSession = data || undefined;
      const localSession = await db.sessions.get(id);
      const merged = this.mergeWithLocalSession(cloudSession, localSession);
      if (merged) {
        await db.sessions.put(merged);
      }
      return merged;
    } catch (error) {
      console.warn("[CloudDataManager] Falling back to local storage:", error);
      return await db.sessions.get(id);
    }
  }

  async getAllSessions(athleteId?: string): Promise<RecordingSession[]> {
    try {
      const url = athleteId
        ? `${API_BASE}/sessions-get?athleteId=${athleteId}`
        : `${API_BASE}/sessions-get`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to get sessions: ${response.statusText}`);
      }

      const cloudSessions = (await response.json()) as RecordingSession[];
      const localSessions = athleteId
        ? await db.sessions
            .where("athleteId")
            .equals(athleteId)
            .reverse()
            .sortBy("startTime")
        : await db.sessions.orderBy("startTime").reverse().toArray();

      const localById = new Map(localSessions.map((s) => [s.id, s]));
      const merged = cloudSessions.map((session) =>
        this.mergeWithLocalSession(session, localById.get(session.id)),
      ) as RecordingSession[];

      for (const session of localSessions) {
        if (!merged.some((s) => s.id === session.id)) merged.push(session);
      }

      for (const session of merged) {
        await db.sessions.put(session);
      }

      merged.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
      return merged;
    } catch (error) {
      console.warn("[CloudDataManager] Falling back to local storage:", error);
      if (athleteId) {
        return await db.sessions
          .where("athleteId")
          .equals(athleteId)
          .reverse()
          .sortBy("startTime");
      }
      return await db.sessions.orderBy("startTime").reverse().toArray();
    }
  }

  async deleteSession(id: string): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/sessions-delete?id=${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(`Failed to delete session: ${response.statusText}`);
      }
    } catch (error) {
      console.warn("[CloudDataManager] Error deleting from cloud:", error);
    }

    // Always delete locally too
    await db.sessions.delete(id);
    await db.imuFrames.where("sessionId").equals(id).delete();
    await db.envFrames.where("sessionId").equals(id).delete();
  }

  // ============================================
  // Frame Recording (→ Local IndexedDB only)
  // High-frequency data stays local
  // ============================================

  async saveFrame(frame: RecordedFrame): Promise<void> {
    await db.imuFrames.add(frame);
  }

  async bulkSaveFrames(frames: RecordedFrame[]): Promise<void> {
    if (frames.length === 0) return;
    await db.imuFrames.bulkAdd(frames);
  }

  async saveEnvFrame(frame: RecordedEnvFrame): Promise<void> {
    await db.envFrames.add(frame);
  }

  // ============================================
  // Bulk Operations
  // ============================================

  async exportSessionData(sessionId: string): Promise<RecordedFrame[]> {
    return await db.imuFrames
      .where("sessionId")
      .equals(sessionId)
      .sortBy("timestamp");
  }

  async clearAllData(): Promise<void> {
    await db.imuFrames.clear();
    await db.envFrames.clear();
    await db.sessions.clear();
    // Note: Cloud data not cleared - would need separate admin endpoint
  }

  // ============================================
  // Cloud-specific methods
  // ============================================

  isCloudAvailable(): boolean {
    return this.isOnline;
  }
}
