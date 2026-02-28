/**
 * Skate Telemetry Chart - 3 stacked charts for IMU data
 * Shows: Orientation (deg), Acceleration (m/s²), Gyroscope (°/s)
 */

import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { deviceQuaternionCache, deviceAccelCache, deviceGyroCache, useDeviceRegistry } from '../../store/useDeviceRegistry';
import * as THREE from 'three';

const MAX_POINTS = 200;

interface ChartConfig {
    title: string;
    unit: string;
    series: { label: string; color: string }[];
    yRange: [number, number];
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
        yRange: [-30, 30],
    },
    {
        title: 'Gyroscope',
        unit: '°/s',
        series: [
            { label: 'X', color: '#F97316' },
            { label: 'Y', color: '#8B5CF6' },
            { label: 'Z', color: '#EC4899' },
        ],
        yRange: [-1000, 1000],
    },
];

function createChartOptions(config: ChartConfig, width: number, height: number): uPlot.Options {
    return {
        width,
        height,
        cursor: { show: false },
        legend: { show: false },
        scales: {
            x: { time: false },
            y: { range: config.yRange },
        },
        axes: [
            {
                show: true,
                stroke: '#555',
                grid: { stroke: '#333', width: 1 },
                ticks: { stroke: '#333', width: 1 },
                font: '10px monospace',
                size: 30,
            },
            {
                show: true,
                stroke: '#555',
                grid: { stroke: '#333', width: 1 },
                ticks: { stroke: '#333', width: 1 },
                font: '10px monospace',
                size: 50,
                values: (_, vals) => vals.map(v => `${v}${config.unit}`),
            },
        ],
        series: [
            { label: 'Time' },
            ...config.series.map(s => ({
                label: s.label,
                stroke: s.color,
                width: 1.5,
            })),
        ],
    };
}

export function SkateTelemetryChart() {
    const devices = useDeviceRegistry(state => state.devices);

    const chartRefs = [
        useRef<HTMLDivElement>(null),
        useRef<HTMLDivElement>(null),
        useRef<HTMLDivElement>(null),
    ];

    const uplotRefs = useRef<(uPlot | null)[]>([null, null, null]);
    const dataRefs = useRef<number[][][]>([
        [[], [], [], []],  // Orientation: time, pitch, roll, yaw
        [[], [], [], []],  // Accel: time, x, y, z
        [[], [], [], []],  // Gyro: time, x, y, z
    ]);
    const startTimeRef = useRef<number>(Date.now());

    // Get first sensor
    const sensor = Array.from(devices.values())[0];

    // Initialize charts
    useEffect(() => {

        // Cleanup previous
        uplotRefs.current.forEach(u => u?.destroy());
        uplotRefs.current = [null, null, null];
        startTimeRef.current = Date.now();

        // Reset data buffers
        dataRefs.current = [
            [[], [], [], []],
            [[], [], [], []],
            [[], [], [], []],
        ];

        // Create charts
        chartRefs.forEach((ref, i) => {
            if (!ref.current) return;

            const rect = ref.current.getBoundingClientRect();
            const opts = createChartOptions(CHART_CONFIGS[i], rect.width, rect.height);

            uplotRefs.current[i] = new uPlot(opts, [[], [], [], []] as any, ref.current);
        });

        // Resize observer
        const resizeObserver = new ResizeObserver(() => {
            chartRefs.forEach((ref, i) => {
                if (ref.current && uplotRefs.current[i]) {
                    const rect = ref.current.getBoundingClientRect();
                    uplotRefs.current[i]!.setSize({ width: rect.width, height: rect.height });
                }
            });
        });

        chartRefs.forEach(ref => {
            if (ref.current) resizeObserver.observe(ref.current);
        });

        return () => {
            uplotRefs.current.forEach(u => u?.destroy());
            resizeObserver.disconnect();
        };
    }, [sensor?.id]); // Re-init when sensor connects

    // Streaming loop (60Hz)
    useEffect(() => {
        if (!sensor) return;

        let lastTime = 0;
        let animationId: number;

        const tick = (timestamp: number) => {
            if (timestamp - lastTime >= 16) { // 60Hz
                lastTime = timestamp;

                const now = (Date.now() - startTimeRef.current) / 1000;

                // Get data from caches
                const quat = deviceQuaternionCache.get(sensor.id);
                const accel = deviceAccelCache.get(sensor.id);
                const gyro = deviceGyroCache.get(sensor.id);

                // Convert quaternion to euler
                let pitch = 0, roll = 0, yaw = 0;
                if (quat) {
                    const [w, x, y, z] = quat;
                    const threeQuat = new THREE.Quaternion(x, y, z, w);
                    const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'YXZ');
                    const toDeg = 180 / Math.PI;
                    pitch = euler.x * toDeg;
                    roll = euler.z * toDeg;
                    yaw = euler.y * toDeg;
                }

                // Update data buffers
                const updateBuffer = (bufferIdx: number, values: number[]) => {
                    const buffer = dataRefs.current[bufferIdx];
                    buffer[0].push(now);
                    values.forEach((v, i) => buffer[i + 1].push(v));

                    // Trim to MAX_POINTS
                    buffer.forEach(col => {
                        if (col.length > MAX_POINTS) col.shift();
                    });
                };

                updateBuffer(0, [pitch, roll, yaw]);
                updateBuffer(1, accel || [0, 0, 0]);
                updateBuffer(2, gyro || [0, 0, 0]);

                // Update charts
                uplotRefs.current.forEach((u, i) => {
                    if (u) u.setData(dataRefs.current[i] as any);
                });
            }

            animationId = requestAnimationFrame(tick);
        };

        animationId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animationId);
    }, [sensor]);


    return (
        <div className="flex flex-col h-full w-full gap-1 p-2">
            {CHART_CONFIGS.map((config, i) => (
                <div key={config.title} className="flex-1 relative">
                    {/* Chart Title */}
                    <div className="absolute top-0 left-1 z-10 text-[10px] text-zinc-400 bg-zinc-900/80 px-1 rounded">
                        {config.title} ({config.unit})
                    </div>
                    {/* Legend */}
                    <div className="absolute top-0 right-1 z-10 flex gap-2 text-[10px]">
                        {config.series.map(s => (
                            <span key={s.label} style={{ color: s.color }}>
                                {s.label}
                            </span>
                        ))}
                    </div>
                    {/* Chart Container */}
                    <div ref={chartRefs[i]} className="w-full h-full" />
                </div>
            ))}
        </div>
    );
}
