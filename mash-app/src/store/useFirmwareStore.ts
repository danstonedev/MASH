/**
 * useFirmwareStore.ts - Firmware State Management
 * 
 * Manages firmware version tracking, update availability, and OTA state.
 */

import { create } from 'zustand';
import type { OTAProgress, FirmwareRelease } from '../lib/ota';

export interface DeviceFirmware {
    version: string;
    major: number;
    minor: number;
    patch: number;
    role: 'gateway' | 'node' | 'standalone';
}

interface FirmwareState {
    // Current device firmware versions
    gatewayFirmware: DeviceFirmware | null;
    nodeFirmware: Map<number, DeviceFirmware>;  // nodeId -> firmware info

    // Available updates
    latestRelease: FirmwareRelease | null;
    updateAvailable: boolean;

    // OTA state
    isUpdating: boolean;
    updateTarget: 'gateway' | 'node' | null;
    otaProgress: OTAProgress | null;

    // Error state
    lastError: string | null;

    // Check Status
    checkStatus: 'idle' | 'checking' | 'success' | 'error' | 'not_found';

    // Actions
    setGatewayFirmware: (firmware: DeviceFirmware) => void;
    setNodeFirmware: (nodeId: number, firmware: DeviceFirmware) => void;
    setLatestRelease: (release: FirmwareRelease | null) => void;
    startUpdate: (target: 'gateway' | 'node') => void;
    setProgress: (progress: OTAProgress) => void;
    completeUpdate: () => void;
    failUpdate: (error: string) => void;
    resetUpdateState: () => void;
    initialize: () => Promise<void>;
}

export const useFirmwareStore = create<FirmwareState>((set, get) => ({
    gatewayFirmware: null,
    nodeFirmware: new Map(),
    latestRelease: null,
    updateAvailable: false,
    isUpdating: false,
    updateTarget: null,
    otaProgress: null,
    lastError: null,
    checkStatus: 'idle',

    setGatewayFirmware: (firmware) => {
        set({ gatewayFirmware: firmware });
        // Check if update is available
        const { latestRelease } = get();
        if (latestRelease) {
            const updateAvailable =
                latestRelease.major > firmware.major ||
                (latestRelease.major === firmware.major && latestRelease.minor > firmware.minor) ||
                (latestRelease.major === firmware.major && latestRelease.minor === firmware.minor && latestRelease.patch > firmware.patch);
            set({ updateAvailable });
        }
    },

    setNodeFirmware: (nodeId, firmware) => {
        const nodeFirmware = new Map(get().nodeFirmware);
        nodeFirmware.set(nodeId, firmware);
        set({ nodeFirmware });
    },

    setLatestRelease: (release) => {
        set({ latestRelease: release });
        // Check if update is available
        const { gatewayFirmware } = get();
        if (release && gatewayFirmware) {
            const updateAvailable =
                release.major > gatewayFirmware.major ||
                (release.major === gatewayFirmware.major && release.minor > gatewayFirmware.minor) ||
                (release.major === gatewayFirmware.major && release.minor === gatewayFirmware.minor && release.patch > gatewayFirmware.patch);
            set({ updateAvailable });
        }
    },

    startUpdate: (target) => {
        set({
            isUpdating: true,
            updateTarget: target,
            otaProgress: {
                phase: 'preparing',
                bytesTransferred: 0,
                totalBytes: 0,
                percent: 0,
                message: 'Preparing update...'
            },
            lastError: null
        });
    },

    setProgress: (progress) => {
        set({ otaProgress: progress });
    },

    completeUpdate: () => {
        set({
            isUpdating: false,
            updateTarget: null,
            otaProgress: {
                phase: 'complete',
                bytesTransferred: 0,
                totalBytes: 0,
                percent: 100,
                message: 'Update complete!'
            }
        });
    },

    failUpdate: (error: string) => {
        set({
            isUpdating: false,
            updateTarget: null,
            otaProgress: {
                phase: 'error',
                bytesTransferred: 0,
                totalBytes: 0,
                percent: 0,
                message: error
            },
            lastError: error
        });
    },

    resetUpdateState: () => {
        set({
            isUpdating: false,
            updateTarget: null,
            otaProgress: null,
            lastError: null
        });
    },

    initialize: async () => {
        set({ checkStatus: 'checking' });
        try {
            // Fetch latest release from GitHub
            // Note: This won't throw; it returns null on failure
            const { fetchLatestRelease } = await import('../lib/ota/GithubFirmware');
            const latest = await fetchLatestRelease();

            if (latest) {
                get().setLatestRelease(latest);
                set({ checkStatus: 'success' });
            } else {
                set({ checkStatus: 'not_found' });
            }
        } catch (e) {
            console.warn("Failed to check for updates:", e);
            set({ checkStatus: 'error' });
        }
    }
}));
