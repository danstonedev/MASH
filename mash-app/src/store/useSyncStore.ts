/**
 * Sync Store - Hardware Synchronization State Management
 * =======================================================
 * 
 * Manages sync status from all nodes, calculates aggregate
 * sync quality, and provides warnings for out-of-sync nodes.
 */

import { create } from 'zustand';

// ============================================================================
// TYPES
// ============================================================================

export interface NodeSyncStatus {
    nodeId: number;
    isSynced: boolean;
    offsetNanos: number;
    jitterNanos: number;
    frequencyPpm: number;
    syncCount: number;
    lastUpdate: number;
}

export interface SyncState {
    // Per-node sync status
    nodes: Map<number, NodeSyncStatus>;

    // Aggregate metrics
    allSynced: boolean;
    worstJitterNanos: number;
    worstOffsetNanos: number;
    totalSyncCount: number;

    // Quality thresholds
    jitterTargetNanos: number;  // Default: 1000 (1μs)

    // Actions
    updateNodeStatus: (
        nodeId: number,
        synced: boolean,
        offsetNanos: number,
        jitterNanos: number,
        frequencyPpm: number,
        syncCount: number
    ) => void;

    parseFromBLE: (data: DataView, nodeId: number) => void;

    setJitterTarget: (nanos: number) => void;

    getQualityLevel: () => 'excellent' | 'good' | 'fair' | 'poor';

    reset: () => void;
}

// ============================================================================
// STORE
// ============================================================================

export const useSyncStore = create<SyncState>((set, get) => ({
    nodes: new Map(),
    allSynced: false,
    worstJitterNanos: 0,
    worstOffsetNanos: 0,
    totalSyncCount: 0,
    jitterTargetNanos: 1000,  // 1μs default target

    updateNodeStatus: (nodeId, synced, offsetNanos, jitterNanos, frequencyPpm, syncCount) => {
        const nodes = new Map(get().nodes);

        nodes.set(nodeId, {
            nodeId,
            isSynced: synced,
            offsetNanos,
            jitterNanos,
            frequencyPpm,
            syncCount,
            lastUpdate: Date.now(),
        });

        // Calculate aggregates
        let allSynced = true;
        let worstJitter = 0;
        let worstOffset = 0;
        let totalSync = 0;

        nodes.forEach(node => {
            if (!node.isSynced) allSynced = false;
            if (node.jitterNanos > worstJitter) worstJitter = node.jitterNanos;
            if (Math.abs(node.offsetNanos) > Math.abs(worstOffset)) worstOffset = node.offsetNanos;
            totalSync += node.syncCount;
        });

        set({
            nodes,
            allSynced,
            worstJitterNanos: worstJitter,
            worstOffsetNanos: worstOffset,
            totalSyncCount: totalSync,
        });
    },

    parseFromBLE: (data: DataView, nodeId: number) => {
        // Parse SyncStatusBLE packet (type 0x07)
        // Format: type(1) + nodeId(1) + synced(1) + offsetNanos(4) + jitterNanos(4) + freqPpmX10(2) + syncCount(4)
        try {
            if (data.byteLength < 16) return;

            const type = data.getUint8(0);
            if (type !== 0x07) return;

            const reportedNodeId = data.getUint8(1);
            const synced = data.getUint8(2) === 1;
            const offsetNanos = data.getInt32(3, true);
            const jitterNanos = data.getUint32(7, true);
            const freqPpmX10 = data.getInt16(11, true);
            const syncCount = data.getUint32(13, true);

            get().updateNodeStatus(
                reportedNodeId || nodeId,
                synced,
                offsetNanos,
                jitterNanos,
                freqPpmX10 / 10,
                syncCount
            );
        } catch (err) {
            console.error('[SyncStore] Error parsing BLE packet:', err);
        }
    },

    setJitterTarget: (nanos) => set({ jitterTargetNanos: nanos }),

    getQualityLevel: () => {
        const { worstJitterNanos, jitterTargetNanos, allSynced } = get();

        if (!allSynced) return 'poor';
        if (worstJitterNanos <= jitterTargetNanos) return 'excellent';
        if (worstJitterNanos <= jitterTargetNanos * 10) return 'good';
        if (worstJitterNanos <= jitterTargetNanos * 100) return 'fair';
        return 'poor';
    },

    reset: () => {
        set({
            nodes: new Map(),
            allSynced: false,
            worstJitterNanos: 0,
            worstOffsetNanos: 0,
            totalSyncCount: 0,
        });
    },
}));

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format nanoseconds in human-readable form.
 */
export function formatNanos(nanos: number): string {
    if (Math.abs(nanos) < 1000) {
        return `${nanos.toFixed(0)}ns`;
    } else if (Math.abs(nanos) < 1000000) {
        return `${(nanos / 1000).toFixed(2)}μs`;
    } else {
        return `${(nanos / 1000000).toFixed(2)}ms`;
    }
}

/**
 * Format frequency drift in PPM.
 */
export function formatPpm(ppm: number): string {
    return `${ppm >= 0 ? '+' : ''}${ppm.toFixed(2)} ppm`;
}
