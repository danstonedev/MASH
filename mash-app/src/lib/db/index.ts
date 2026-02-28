import { LocalDataManager, db } from './LocalDataManager';
import { CloudDataManager } from './CloudDataManager';
import type { IDataManager } from './types';

// Re-export types
export * from './types';

// Re-export db for legacy compatibility (unmigrated files)
export { db };

// Re-export manager classes
export { LocalDataManager, CloudDataManager };

// Storage mode - can be configured via environment or localStorage
export type StorageMode = 'local' | 'cloud';

/**
 * Get the current storage mode preference
 */
export function getStorageMode(): StorageMode {
    if (typeof window !== 'undefined') {
        return (localStorage.getItem('imu-connect-storage-mode') as StorageMode) || 'local';
    }
    return 'local';
}

/**
 * Set the storage mode preference
 */
export function setStorageMode(mode: StorageMode): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem('imu-connect-storage-mode', mode);
    }
}

/**
 * Create a data manager based on current storage mode
 */
export function createDataManager(mode?: StorageMode): IDataManager {
    const effectiveMode = mode || getStorageMode();
    return effectiveMode === 'cloud' ? new CloudDataManager() : new LocalDataManager();
}

let _activeMode: StorageMode | null = null;
let _activeManager: IDataManager | null = null;

function getActiveManager(): IDataManager {
    const mode = getStorageMode();
    if (!_activeManager || _activeMode !== mode) {
        _activeMode = mode;
        _activeManager = createDataManager(mode);
    }
    return _activeManager;
}

class DynamicDataManager implements IDataManager {
    createSession(session: Parameters<IDataManager['createSession']>[0]) {
        return getActiveManager().createSession(session);
    }

    updateSession(id: string, updates: Parameters<IDataManager['updateSession']>[1]) {
        return getActiveManager().updateSession(id, updates);
    }

    getSession(id: string) {
        return getActiveManager().getSession(id);
    }

    getAllSessions(athleteId?: string) {
        return getActiveManager().getAllSessions(athleteId);
    }

    deleteSession(id: string) {
        return getActiveManager().deleteSession(id);
    }

    saveFrame(frame: Parameters<IDataManager['saveFrame']>[0]) {
        return getActiveManager().saveFrame(frame);
    }

    saveEnvFrame(frame: Parameters<IDataManager['saveEnvFrame']>[0]) {
        return getActiveManager().saveEnvFrame(frame);
    }

    bulkSaveFrames(frames: Parameters<IDataManager['bulkSaveFrames']>[0]) {
        return getActiveManager().bulkSaveFrames(frames);
    }

    exportSessionData(sessionId: string) {
        return getActiveManager().exportSessionData(sessionId);
    }

    exportEnvData(sessionId: string) {
        const manager = getActiveManager();
        if (!manager.exportEnvData) return Promise.resolve([]);
        return manager.exportEnvData(sessionId);
    }

    exportFullSession(sessionId: string) {
        const manager = getActiveManager();
        if (!manager.exportFullSession) return Promise.resolve(null);
        return manager.exportFullSession(sessionId);
    }

    clearAllData() {
        return getActiveManager().clearAllData();
    }
}

export const dataManager: IDataManager = new DynamicDataManager();

