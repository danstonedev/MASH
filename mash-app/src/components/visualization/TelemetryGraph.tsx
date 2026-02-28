/**
 * Telemetry Graph - High-performance canvas-based charting with uPlot.
 * Supports ROM angles, accelerometer, and future data sources.
 * Purely visualizes data based on `useTelemetryStore` state.
 * Uses pre-computed ROM cache for animations (zero live calculations).
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useTelemetryStore } from '../../store/useTelemetryStore';
import { useJointAnglesStore } from '../../store/useJointAnglesStore';
import { useAnimationStore } from '../../store/useAnimationStore';
import { precomputeAnimationROM, getCachedROMAtTime, isAnimationCached, getAnimationCache } from '../../biomech/animationROMCache';
import { deviceAccelCache, deviceGyroCache, useDeviceRegistry } from '../../store/useDeviceRegistry';

const MAX_POINTS = 200;

export function TelemetryGraph() {
    const { mode, getEnabledSeries, clearData } = useTelemetryStore();
    const currentAnimation = useAnimationStore(state => state.currentAnimation);
    const [isCaching, setIsCaching] = useState(false);

    const chartRef = useRef<HTMLDivElement>(null);
    const uplotRef = useRef<uPlot | null>(null);
    const dataRef = useRef<number[][]>([]);
    const startTimeRef = useRef<number>(Date.now());

    const enabledSeries = getEnabledSeries();

    // Pre-compute ROM cache when animation is selected
    useEffect(() => {
        if (!currentAnimation || mode !== 'rom') return;

        if (!isAnimationCached(currentAnimation.id)) {
            setIsCaching(true);
            precomputeAnimationROM(currentAnimation.id, currentAnimation.file, 30)
                .then(() => {
                    setIsCaching(false);
                    clearData();
                    // Reset data buffer
                    dataRef.current = [];
                    startTimeRef.current = Date.now();
                })
                .catch(err => {
                    console.error('[ROMCache] Failed:', err);
                    setIsCaching(false);
                });
        }
    }, [currentAnimation, mode, clearData]);

    // Initialize uPlot
    useEffect(() => {
        if (!chartRef.current) return;

        const seriesConfig: uPlot.Series[] = [
            { label: 'Time' }, // x-axis
            ...enabledSeries.map(s => ({
                label: s.label,
                stroke: s.color,
                width: 1.5,
            })),
        ];

        const opts: uPlot.Options = {
            width: chartRef.current.clientWidth,
            height: chartRef.current.clientHeight,
            series: seriesConfig,
            scales: {
                x: { time: false },
                y: { range: mode === 'rom' ? [-180, 180] : [-20, 20] },
            },
            axes: [
                { show: false }, // hide x-axis
                {
                    stroke: '#A3A3A3',
                    grid: { stroke: '#222222', width: 1 },
                    ticks: { stroke: '#222222', width: 1 },
                    font: '10px sans-serif',
                    size: 40,
                    values: (_, vals) => vals.map(v => `${v}°`),
                },
            ],
            cursor: { show: false },
            legend: { show: false },
        };

        const u = new uPlot(opts, [[]], chartRef.current);
        uplotRef.current = u;
        dataRef.current = Array(seriesConfig.length).fill(0).map(() => []);

        const resizeObserver = new ResizeObserver(() => {
            if (chartRef.current) {
                u.setSize({
                    width: chartRef.current.clientWidth,
                    height: chartRef.current.clientHeight,
                });
            }
        });
        resizeObserver.observe(chartRef.current);

        return () => {
            u.destroy();
            resizeObserver.disconnect();
            uplotRef.current = null;
        };
    }, [mode, enabledSeries]);

    // Add data point helper
    const addDataPoint = useCallback((values: Record<string, number>) => {
        if (!uplotRef.current) return;

        const now = (Date.now() - startTimeRef.current) / 1000;
        const newPoint = [now];

        // Map values to active series order
        enabledSeries.forEach(s => {
            let val = 0;

            // For IMU data (accel/gyro), use series ID directly
            if (values[s.id] !== undefined) {
                val = values[s.id];
            } else {
                // For ROM data, key format: "jointId_axis"
                const key = `${s.jointId}_${s.axis === 'flexion' ? 'flex' : s.axis === 'abduction' ? 'abd' : 'rot'}`;
                if (values[key] !== undefined) {
                    val = values[key];
                }
            }
            newPoint.push(val);
        });

        // Push to columns
        dataRef.current.forEach((col, i) => {
            col.push(newPoint[i]);
            if (col.length > MAX_POINTS) col.shift();
        });

        uplotRef.current.setData(dataRef.current as [number[], ...number[][]]);
    }, [enabledSeries]);

    // ROM Data Streaming Loop (30Hz)
    useEffect(() => {
        if (mode !== 'rom') return;

        let lastTime = 0;
        let animationId: number;

        const tick = (timestamp: number) => {
            if (timestamp - lastTime >= 33) { // 30Hz
                lastTime = timestamp;

                const values: Record<string, number> = {};
                const anim = useAnimationStore.getState();

                // Use cached data if animation is cached
                if (anim.currentAnimation && anim.isPlaying && isAnimationCached(anim.currentAnimation.id)) {
                    const cache = getAnimationCache(anim.currentAnimation.id)!;
                    const romData = getCachedROMAtTime(cache, anim.progress);

                    for (const [jointId, angles] of Object.entries(romData)) {
                        values[`${jointId}_flex`] = angles.flexion;
                        values[`${jointId}_abd`] = angles.abduction;
                        values[`${jointId}_rot`] = angles.rotation;
                    }
                } else {
                    // Fallback to live joint angle store (for simulator mode)
                    const currentJointData = useJointAnglesStore.getState().jointData;
                    currentJointData.forEach((data, jointId) => {
                        values[`${jointId}_flex`] = data.current.flexion;
                        values[`${jointId}_abd`] = data.current.abduction;
                        values[`${jointId}_rot`] = data.current.rotation;
                    });
                }

                if (Object.keys(values).length > 0) {
                    addDataPoint(values);
                }
            }

            animationId = requestAnimationFrame(tick);
        };

        animationId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animationId);
    }, [mode, addDataPoint]);

    // IMU Data Streaming Loop (30Hz)
    useEffect(() => {
        if (mode !== 'accel') return;

        let lastTime = 0;
        let animationId: number;

        const tick = (timestamp: number) => {
            if (timestamp - lastTime >= 33) { // 30Hz
                lastTime = timestamp;

                const values: Record<string, number> = {};
                const devices = useDeviceRegistry.getState().devices;
                const sensor = Array.from(devices.values())[0];

                if (sensor) {
                    // Read from high-frequency caches
                    const accel = deviceAccelCache.get(sensor.id);
                    const gyro = deviceGyroCache.get(sensor.id);

                    if (accel) {
                        values['ax'] = accel[0];
                        values['ay'] = accel[1];
                        values['az'] = accel[2];
                    }

                    if (gyro) {
                        const RAD_TO_DEG = 180 / Math.PI;
                        values['gx'] = gyro[0] * RAD_TO_DEG;
                        values['gy'] = gyro[1] * RAD_TO_DEG;
                        values['gz'] = gyro[2] * RAD_TO_DEG;
                    }
                }

                if (Object.keys(values).length > 0) {
                    addDataPoint(values);
                }
            }

            animationId = requestAnimationFrame(tick);
        };

        animationId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animationId);
    }, [mode, addDataPoint]);

    return (
        <div className="flex flex-col h-full bg-transparent">
            {isCaching && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-50 backdrop-blur-sm">
                    <span className="text-accent animate-pulse font-mono">Caching Animation ROM...</span>
                </div>
            )}
            <div ref={chartRef} className="w-full h-full" />
        </div>
    );
}
