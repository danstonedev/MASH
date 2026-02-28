/**
 * Optional Sensors Store - Magnetometer & Barometer data from V2 firmware
 * 
 * These sensors are auto-detected by firmware and data is included in GET_STATUS.
 * Not in the high-frequency data stream - polled periodically.
 */

import { create } from 'zustand';
import type { MagnetometerData, BarometerData } from '../lib/ble/DeviceInterface';

interface OptionalSensorsState {
    // Sensor presence (from GET_STATUS)
    hasMagnetometer: boolean;
    hasBarometer: boolean;
    
    // Latest readings
    magnetometer: MagnetometerData | null;
    barometer: BarometerData | null;
    
    // Last update timestamp
    lastUpdate: number;
    
    // Actions
    updateFromStatus: (status: {
        hasMagnetometer?: boolean;
        hasBarometer?: boolean;
        magnetometer?: MagnetometerData;
        barometer?: BarometerData;
    }) => void;
    reset: () => void;
}

export const useOptionalSensorsStore = create<OptionalSensorsState>((set) => ({
    hasMagnetometer: false,
    hasBarometer: false,
    magnetometer: null,
    barometer: null,
    lastUpdate: 0,
    
    updateFromStatus: (status) => {
        set({
            hasMagnetometer: status.hasMagnetometer ?? false,
            hasBarometer: status.hasBarometer ?? false,
            magnetometer: status.magnetometer ?? null,
            barometer: status.barometer ?? null,
            lastUpdate: Date.now(),
        });
    },
    
    reset: () => {
        set({
            hasMagnetometer: false,
            hasBarometer: false,
            magnetometer: null,
            barometer: null,
            lastUpdate: 0,
        });
    },
}));
