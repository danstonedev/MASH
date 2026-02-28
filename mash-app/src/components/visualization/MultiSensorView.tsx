import { useState, useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useDeviceRegistry, deviceAccelCache, deviceGyroCache } from '../../store/useDeviceRegistry';
import { Activity, Check } from 'lucide-react';

const COLORS = ['#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1'];
const MAX_POINTS = 600; // 10 seconds @ 60Hz

export function MultiSensorView() {
    const devices = useDeviceRegistry(state => state.devices);
    const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());

    // Auto-select first device if empty
    useEffect(() => {
        if (selectedDevices.size === 0 && devices.size > 0) {
            const firstId = devices.keys().next().value;
            if (firstId) setSelectedDevices(new Set([firstId]));
        }
    }, [devices.size]);

    const toggleDevice = (deviceId: string) => {
        const newSet = new Set(selectedDevices);
        if (newSet.has(deviceId)) {
            newSet.delete(deviceId);
        } else {
            if (newSet.size >= 8) return; // Higher limit supported by uPlot
            newSet.add(deviceId);
        }
        setSelectedDevices(newSet);
    };

    const selectedList = Array.from(selectedDevices);

    if (devices.size === 0) {
        return (
            <div className="flex flex-col h-full items-center justify-center p-8 text-center opacity-60">
                <Activity className="w-12 h-12 mb-4 text-accent" />
                <p>No sensors connected.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-bg-surface overflow-hidden">
            {/* Header / Selector */}
            <div className="flex-none max-h-[30%] overflow-y-auto border-b border-border bg-bg-elevated/30">
                <div className="p-2 space-y-1">
                    <div className="flex justify-between items-center px-1 mb-1">
                        <div className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider">
                            Select Sensors ({selectedList.length})
                        </div>
                        <div className="text-[10px] text-text-tertiary">
                            Max 8
                        </div>
                    </div>
                    {Array.from(devices.values()).map(device => {
                        const isSelected = selectedDevices.has(device.id);
                        return (
                            <button
                                key={device.id}
                                onClick={() => toggleDevice(device.id)}
                                className={`w-full text-left p-2 rounded border transition-all ${isSelected
                                        ? 'bg-accent/10 border-accent shadow-sm'
                                        : 'bg-bg-elevated border-border hover:border-text-secondary/50'
                                    }`}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-accent' : 'bg-text-tertiary/30'}`} />
                                        <span className={`text-xs font-semibold ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
                                            {device.name}
                                        </span>
                                    </div>
                                    {isSelected && <Check className="w-3 h-3 text-accent" />}
                                </div>
                                <div className="text-[10px] text-text-tertiary truncate pl-3.5">
                                    {device.id}
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Graphs (Canvas based uPlot) */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2 bg-bg-surface">
                {selectedList.length > 0 ? (
                    <>
                        <PerformantMultiGraph
                            title="Total Acceleration"
                            unit="g"
                            selectedIds={selectedList}
                            cache={deviceAccelCache}
                            devices={devices}
                            minRange={4}
                        />
                        <PerformantMultiGraph
                            title="Total Angular Velocity"
                            unit="rad/s"
                            selectedIds={selectedList}
                            cache={deviceGyroCache}
                            devices={devices}
                            minRange={10}
                        />
                    </>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center text-text-tertiary p-4 text-center">
                        <Activity className="w-8 h-8 opacity-50 mb-2" />
                        <p>Select sensors to compare data</p>
                    </div>
                )}
            </div>
        </div>
    );
}

interface GraphProps {
    title: string;
    unit: string;
    selectedIds: string[];
    cache: Map<string, [number, number, number]>; // Raw [x,y,z] cache
    devices: Map<string, any>;
    minRange: number;
}

// Separate component to handle its own animation loop and uPlot instance
function PerformantMultiGraph({ title, unit, selectedIds, cache, devices, minRange }: GraphProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const uplotRef = useRef<uPlot | null>(null);
    const dataRef = useRef<number[][]>([]); // [Time, Series1, Series2...]
    const startTimeRef = useRef(Date.now());

    // Rebuild chart when selection changes
    useEffect(() => {
        if (!containerRef.current) return;

        // Cleanup old
        if (uplotRef.current) {
            uplotRef.current.destroy();
            uplotRef.current = null;
        }

        // Reset buffers
        // 0: Time, 1..N: Data for each selected ID
        dataRef.current = [[]]; // Time
        selectedIds.forEach(() => dataRef.current.push([]));
        startTimeRef.current = Date.now();

        // Build series options
        const seriesOpts = [
            { label: 'Time' },
            ...selectedIds.map((id, idx) => ({
                label: devices.get(id)?.name || id,
                stroke: COLORS[idx % COLORS.length],
                width: 2,
            }))
        ];

        const rect = containerRef.current.getBoundingClientRect();

        const opts: uPlot.Options = {
            width: rect.width,
            height: 200, // Fixed height per graph
            series: seriesOpts,
            cursor: { show: false },
            legend: { show: false },
            scales: {
                x: { time: false },
                y: {
                    range: (_: uPlot, min: number, max: number): [number, number] => {
                        const range = max - min;
                        if (range < minRange) {
                            const mid = (min + max) / 2;
                            return [mid - minRange / 2, mid + minRange / 2];
                        }
                        const pad = range * 0.1;
                        return [min - pad, max + pad];
                    }
                }
            },
            axes: [
                {
                    show: true,
                    stroke: '#9ca3af',
                    grid: { stroke: '#374151', width: 1 },
                    ticks: { stroke: '#4b5563', width: 1 },
                    font: '10px "Inter", monospace',
                    size: 30,
                },
                {
                    show: true,
                    stroke: '#9ca3af',
                    grid: { stroke: '#374151', width: 1 },
                    ticks: { stroke: '#4b5563', width: 1 },
                    font: '10px "Inter", monospace',
                    size: 40,
                    values: (_, vals) => vals.map(v => v.toFixed(1)),
                }
            ]
        };

        uplotRef.current = new uPlot(opts, dataRef.current as any, containerRef.current);

        // Handle Resize
        const resizeObserver = new ResizeObserver(() => {
            if (containerRef.current && uplotRef.current) {
                const r = containerRef.current.getBoundingClientRect();
                uplotRef.current.setSize({ width: r.width, height: 200 });
            }
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
            uplotRef.current?.destroy();
        };

    }, [selectedIds, title]); // Re-create on selection change

    // Animation Loop
    useEffect(() => {
        let animationId: number;
        let lastTime = 0;

        const tick = (timestamp: number) => {
            if (timestamp - lastTime >= 16) { // 60Hz cap
                lastTime = timestamp;

                if (uplotRef.current) {
                    const now = (Date.now() - startTimeRef.current) / 1000;

                    // Update Time Buffer
                    const timeBuf = dataRef.current[0];
                    timeBuf.push(now);
                    if (timeBuf.length > MAX_POINTS) timeBuf.shift();

                    // Update Data Buffers
                    selectedIds.forEach((id, idx) => {
                        const vec = cache.get(id);
                        let val = 0;
                        if (vec) {
                            // Calculate Magnitude
                            val = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);

                            // Specific unit conversions if needed
                            // Accel comes in m/s^2 from the cache usually? Or g? 
                            // MASH_Node typically sends raw or calibrated units.
                            // If we assume cache is raw units, magnitude is consistent.
                            // Based on 'SingleSensorView', Accel is m/s^2. 
                            // If user wants 'g', we divide by 9.81.
                            if (title.includes("Acceleration")) val /= 9.81;
                        }

                        const buf = dataRef.current[idx + 1];
                        buf.push(val);
                        if (buf.length > MAX_POINTS) buf.shift();
                    });

                    uplotRef.current.setData(dataRef.current as any);
                }
            }
            animationId = requestAnimationFrame(tick);
        };
        animationId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animationId);
    }, [selectedIds, cache, title]);

    return (
        <div className="bg-bg-elevated/50 rounded border border-border overflow-hidden flex flex-col">
            <div className="px-2 py-1 bg-bg-elevated border-b border-border/50 flex justify-between items-center">
                <span className="text-[10px] uppercase font-bold text-text-secondary tracking-wider">
                    {title} <span className="text-text-tertiary">({unit})</span>
                </span>
            </div>
            {/* Chart Wrapper */}
            <div ref={containerRef} className="w-full relative h-[200px]">
                {/* Legend Overlay */}
                <div className="absolute top-2 left-2 flex flex-col gap-1 pointer-events-none z-10">
                    {selectedIds.map((id, idx) => (
                        <div key={id} className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                            <span className="text-[9px] text-text-secondary shadow-sm bg-black/50 px-1.5 py-0.5 rounded backdrop-blur-sm">
                                {devices.get(id)?.name || id}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
