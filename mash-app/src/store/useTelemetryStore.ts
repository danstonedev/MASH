/**
 * Telemetry Store - Time-series data for charting.
 * Supports multiple data sources: ROM angles, accelerometer, quaternions.
 */

import { create } from 'zustand';
import { JOINT_DEFINITIONS } from '../biomech/jointAngles';

const MAX_POINTS = 100;
const SAMPLE_INTERVAL = 100; // 10Hz for performance

export type ChartMode = 'rom' | 'accel' | 'quaternion';

export interface ChartSeries {
    id: string;
    label: string;
    color: string;
    enabled: boolean;
    category: 'rom' | 'accel' | 'quaternion';
    jointId?: string;
    axis?: 'flexion' | 'abduction' | 'rotation' | 'x' | 'y' | 'z' | 'w';
}

interface TimeSeriesPoint {
    time: number;
    [key: string]: number;
}

// Visualization modes for the Right Sidebar
export type VisualizationMode = 'single' | 'multi' | 'joint' | 'history' | 'analyze' | 'summary';

export interface TelemetryState {
    // Current analysis tab (Controls both Left and Right panels)
    vizMode: VisualizationMode;

    // Single Sensor View State
    selectedSensorId: string | null;

    // Multi Sensor Comparison State
    // Format: "sensorId:dataChannel" e.g. "sensor1:accelX"
    comparisonSeries: string[];

    // Joint Biomechanics State
    selectedJointId: string | null;

    // Right Panel Visibility (Always available slider)
    isRightPanelOpen: boolean;

    // Actions
    setVizMode: (mode: VisualizationMode) => void;
    setSelectedSensor: (sensorId: string | null) => void;
    toggleComparisonSeries: (seriesKey: string) => void;
    setSelectedJoint: (jointId: string | null) => void;
    setRightPanelOpen: (isOpen: boolean) => void;

    // Legacy State (To be refactored/removed later)
    mode: ChartMode;
    availableSeries: ChartSeries[];
    data: TimeSeriesPoint[];
    lastSampleTime: number;
    setMode: (mode: ChartMode) => void;
    toggleSeries: (seriesId: string) => void;
    enableOnlySeries: (seriesIds: string[]) => void;
    addDataPoint: (values: Record<string, number>) => void;
    clearData: () => void;
    getEnabledSeries: () => ChartSeries[];
}

// Color palette for joints
const JOINT_COLORS: Record<string, { flex: string; abd: string; rot: string }> = {
    hip_l: { flex: '#EF4444', abd: '#10B981', rot: '#3B82F6' },
    hip_r: { flex: '#F97316', abd: '#14B8A6', rot: '#6366F1' },
    knee_l: { flex: '#EC4899', abd: '#22C55E', rot: '#8B5CF6' },
    knee_r: { flex: '#F43F5E', abd: '#84CC16', rot: '#A855F7' },
    ankle_l: { flex: '#FB7185', abd: '#4ADE80', rot: '#C084FC' },
    ankle_r: { flex: '#FDA4AF', abd: '#86EFAC', rot: '#D8B4FE' },
};

// Build ROM series list from joint definitions
function buildROMSeries(): ChartSeries[] {
    const series: ChartSeries[] = [];

    for (const [jointId, def] of Object.entries(JOINT_DEFINITIONS)) {
        const colors = JOINT_COLORS[jointId] || { flex: '#888', abd: '#888', rot: '#888' };

        series.push({
            id: `${jointId}_flex`,
            label: `${def.name} ${def.flexionName.split('/')[0]}`,
            color: colors.flex,
            enabled: jointId.includes('knee'), // Default: show knees
            category: 'rom',
            jointId,
            axis: 'flexion',
        });
        series.push({
            id: `${jointId}_abd`,
            label: `${def.name} ${def.abductionName.split('/')[0]}`,
            color: colors.abd,
            enabled: false,
            category: 'rom',
            jointId,
            axis: 'abduction',
        });
        series.push({
            id: `${jointId}_rot`,
            label: `${def.name} ${def.rotationName.split('/')[0]}`,
            color: colors.rot,
            enabled: false,
            category: 'rom',
            jointId,
            axis: 'rotation',
        });
    }

    return series;
}

const ACCEL_SERIES: ChartSeries[] = [
    { id: 'ax', label: 'Accel X', color: '#EF4444', enabled: true, category: 'accel', axis: 'x' },
    { id: 'ay', label: 'Accel Y', color: '#10B981', enabled: true, category: 'accel', axis: 'y' },
    { id: 'az', label: 'Accel Z', color: '#3B82F6', enabled: true, category: 'accel', axis: 'z' },
];

const GYRO_SERIES: ChartSeries[] = [
    { id: 'gx', label: 'Gyro X', color: '#F97316', enabled: true, category: 'accel', axis: 'x' },
    { id: 'gy', label: 'Gyro Y', color: '#8B5CF6', enabled: true, category: 'accel', axis: 'y' },
    { id: 'gz', label: 'Gyro Z', color: '#EC4899', enabled: true, category: 'accel', axis: 'z' },
];

// Combined IMU series (accel + gyro)
const IMU_SERIES: ChartSeries[] = [...ACCEL_SERIES, ...GYRO_SERIES];

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
    // New State
    vizMode: 'single',
    selectedSensorId: null,
    comparisonSeries: [],
    selectedJointId: null,
    isRightPanelOpen: true, // Open by default as requested

    setVizMode: (vizMode) => set({ vizMode }),
    setSelectedSensor: (selectedSensorId) => set({ selectedSensorId }),
    toggleComparisonSeries: (seriesKey) => set(state => {
        const exists = state.comparisonSeries.includes(seriesKey);
        return {
            comparisonSeries: exists
                ? state.comparisonSeries.filter(k => k !== seriesKey)
                : [...state.comparisonSeries, seriesKey]
        };
    }),
    setSelectedJoint: (selectedJointId) => set({ selectedJointId }),
    setRightPanelOpen: (isRightPanelOpen) => set({ isRightPanelOpen }),

    // Legacy State Defaults (Preserving for interim compatibility)
    mode: 'rom',
    availableSeries: buildROMSeries(),
    data: [],
    lastSampleTime: 0,
    setMode: (mode) => {
        const series = mode === 'rom' ? buildROMSeries() :
            mode === 'accel' ? IMU_SERIES :
                buildROMSeries();
        set({ mode, availableSeries: series, data: [] });
    },
    toggleSeries: (seriesId) => {
        set(state => ({
            availableSeries: state.availableSeries.map(s =>
                s.id === seriesId ? { ...s, enabled: !s.enabled } : s
            )
        }));
    },
    enableOnlySeries: (seriesIds) => {
        set(state => ({
            availableSeries: state.availableSeries.map(s => ({
                ...s,
                enabled: seriesIds.includes(s.id)
            }))
        }));
    },
    addDataPoint: (values) => {
        const now = Date.now();
        const last = get().lastSampleTime;
        if (now - last < SAMPLE_INTERVAL) return;
        const point: TimeSeriesPoint = { time: now, ...values };
        set(state => {
            const newData = [...state.data, point];
            if (newData.length > MAX_POINTS) {
                return { data: newData.slice(-MAX_POINTS), lastSampleTime: now };
            }
            return { data: newData, lastSampleTime: now };
        });
    },
    clearData: () => set({ data: [] }),
    getEnabledSeries: () => get().availableSeries.filter(s => s.enabled)
}));
