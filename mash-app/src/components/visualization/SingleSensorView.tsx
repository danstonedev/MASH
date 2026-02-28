
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useDeviceRegistry, deviceQuaternionCache, deviceAccelCache, deviceGyroCache } from '../../store/useDeviceRegistry';
import { useTelemetryStore } from '../../store/useTelemetryStore';
import * as THREE from 'three';

const MAX_POINTS = 300; // 5 seconds @ 60Hz

interface ChartConfig {
    title: string;
    unit: string;
    series: { label: string; color: string }[];
    yRange?: [number, number];
    minRange?: number;
}

const CHART_CONFIGS: ChartConfig[] = [
    {
        title: 'Orientation',
        unit: '°',
        series: [
            { label: 'Pitch', color: '#EF4444' },
            { label: 'Roll', color: '#10B981' },
            { label: 'Yaw', color: '#3B82F6' },
        ],
        yRange: [-180, 180],
    },
    {
        title: 'Acceleration',
        unit: 'm/s²',
        series: [
            { label: 'X', color: '#EF4444' },
            { label: 'Y', color: '#10B981' },
            { label: 'Z', color: '#3B82F6' },
        ],
        minRange: 25, // Ensure at least ~2.5g range visible
    },
    {
        title: 'Gyroscope',
        unit: '°/s',
        series: [
            { label: 'X', color: '#F97316' },
            { label: 'Y', color: '#8B5CF6' },
            { label: 'Z', color: '#EC4899' },
        ],
        minRange: 200, // Ensure at least 200deg/s range
    },
];

// Smart range scaler to prevent noise zoom-in
const getSmartRange = (cfg: ChartConfig) => (u: uPlot, min: number, max: number): [number, number] => {
    if (cfg.yRange) return cfg.yRange; // Fixed range

    const range = max - min;
    const minRange = cfg.minRange || 10;

    if (range < minRange) {
        const mid = (min + max) / 2;
        return [mid - minRange / 2, mid + minRange / 2];
    }

    // Add 10% padding for comfort
    const pad = range * 0.1;
    return [min - pad, max + pad];
};

function createChartOptions(config: ChartConfig, width: number, height: number): uPlot.Options {
    return {
        width,
        height,
        cursor: { show: false },
        legend: { show: false },
        scales: {
            x: { time: false },
            y: {
                range: getSmartRange(config),
            },
        },
        axes: [
            {
                show: true,
                stroke: '#9ca3af', // lighter grey (text-gray-400)
                grid: { stroke: '#374151', width: 1 },
                ticks: { stroke: '#4b5563', width: 1 },
                font: '11px "Inter", monospace',
                gap: 5,
                size: 30,
            },
            {
                show: true,
                stroke: '#9ca3af',
                grid: { stroke: '#374151', width: 1 },
                ticks: { stroke: '#4b5563', width: 1 },
                font: '11px "Inter", monospace',
                size: 45, // wider for units
                gap: 5,
                values: (_, vals) => vals.map(v => v.toFixed(0)), // Clean integer display
            },
        ],
        series: [
            { label: 'Time' },
            ...config.series.map(s => ({
                label: s.label,
                stroke: s.color,
                width: 2, // Thicker lines
            })),
        ],
    };
}

export function SingleSensorView() {
    const devices = useDeviceRegistry(state => state.devices);
    const selectedSensorId = useTelemetryStore(state => state.selectedSensorId);

    // Default to first device if none selected
    const activeSensor = selectedSensorId ? devices.get(selectedSensorId) : Array.from(devices.values())[0];

    const chartRefs = [
        useRef<HTMLDivElement>(null),
        useRef<HTMLDivElement>(null),
        useRef<HTMLDivElement>(null),
    ];

    const uplotRefs = useRef<(uPlot | null)[]>([null, null, null]);
    const dataRefs = useRef<number[][][]>([
        [[], [], [], []],  // Orientation
        [[], [], [], []],  // Accel
        [[], [], [], []],  // Gyro
    ]);
    const startTimeRef = useRef<number>(Date.now());

    // Initialize charts
    useEffect(() => {
        // Cleanup previous
        uplotRefs.current.forEach(u => u?.destroy());
        uplotRefs.current = [null, null, null];
        startTimeRef.current = Date.now();

        // Reset buffers
        dataRefs.current = [[[], [], [], []], [[], [], [], []], [[], [], [], []]];

        // Create charts
        chartRefs.forEach((ref, i) => {
            if (!ref.current) return;
            const rect = ref.current.getBoundingClientRect();
            const opts = createChartOptions(CHART_CONFIGS[i], rect.width, rect.height);
            uplotRefs.current[i] = new uPlot(opts, [[], [], [], []] as any, ref.current);
        });

        const resizeObserver = new ResizeObserver(() => {
            chartRefs.forEach((ref, i) => {
                if (ref.current && uplotRefs.current[i]) {
                    const rect = ref.current.getBoundingClientRect();
                    uplotRefs.current[i]!.setSize({ width: rect.width, height: rect.height });
                }
            });
        });

        chartRefs.forEach(ref => { if (ref.current) resizeObserver.observe(ref.current); });

        return () => {
            uplotRefs.current.forEach(u => u?.destroy());
            resizeObserver.disconnect();
        };
    }, [activeSensor?.id]); // Re-init when sensor changes

    // Streaming loop
    useEffect(() => {
        if (!activeSensor) return;

        let lastTime = 0;
        let animationId: number;

        const tick = (timestamp: number) => {
            if (timestamp - lastTime >= 16) { // 60Hz
                lastTime = timestamp;
                const now = (Date.now() - startTimeRef.current) / 1000;

                const quat = deviceQuaternionCache.get(activeSensor.id);
                const accel = deviceAccelCache.get(activeSensor.id);
                const gyro = deviceGyroCache.get(activeSensor.id);

                // Derived Euler
                let pitch = 0, roll = 0, yaw = 0;
                if (quat) {
                    const [w, x, y, z] = quat;
                    const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(x, y, z, w), 'YXZ');
                    pitch = euler.x * (180 / Math.PI);
                    roll = euler.z * (180 / Math.PI);
                    yaw = euler.y * (180 / Math.PI);
                }

                const updateBuffer = (idx: number, vals: number[]) => {
                    const buf = dataRefs.current[idx];
                    buf[0].push(now);
                    vals.forEach((v, i) => buf[i + 1].push(v));
                    buf.forEach(col => { if (col.length > MAX_POINTS) col.shift(); });
                };

                updateBuffer(0, [pitch, roll, yaw]);
                updateBuffer(1, accel || [0, 0, 0]);
                updateBuffer(2, gyro || [0, 0, 0]);

                uplotRefs.current.forEach((u, i) => {
                    if (u) u.setData(dataRefs.current[i] as any);
                });
            }
            animationId = requestAnimationFrame(tick);
        };
        animationId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animationId);
    }, [activeSensor]); // Re-run if sensor changes

    if (!activeSensor) {
        return <div className="p-4 text-center text-text-secondary">No sensor selected</div>;
    }

    return (
        <div className="flex flex-col h-full w-full gap-1 p-2 bg-black/20">
            {CHART_CONFIGS.map((config, i) => (
                <div key={config.title} className="flex-1 relative border border-border/50 rounded-lg overflow-hidden bg-bg-surface">
                    {/* Header Overlay */}
                    <div className="absolute top-0 left-0 right-0 z-10 flex justify-between items-center px-2 py-1 bg-black/40 backdrop-blur-sm pointer-events-none">
                        <span className="text-[10px] font-bold text-text-primary/80 uppercase tracking-wider">
                            {config.title} <span className="text-text-secondary">({config.unit})</span>
                        </span>
                        <div className="flex gap-2">
                            {config.series.map(s => (
                                <div key={s.label} className="flex items-center gap-1">
                                    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                                    <span className="text-[9px] text-text-secondary">{s.label}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                    {/* Chart Container */}
                    <div ref={chartRefs[i]} className="w-full h-full" />
                </div>
            ))}
        </div>
    );
}
