import { useRef, useEffect } from 'react';
import { useOptionalSensorsStore } from '../../store/useOptionalSensorsStore';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export function BarometerPanel() {
    const { barometer, hasBarometer } = useOptionalSensorsStore();
    const chartRef = useRef<HTMLDivElement>(null);
    const uplotRef = useRef<uPlot | null>(null);
    const dataRef = useRef<number[][]>([[], []]); // [time, altitude]
    const startTimeRef = useRef<number>(Date.now());

    useEffect(() => {
        if (!chartRef.current || !hasBarometer) return;

        const opts: uPlot.Options = {
            width: chartRef.current.clientWidth,
            height: 120,
            series: [
                { label: 'Time' },
                {
                    label: 'Altitude',
                    stroke: '#009A44', // UND Green
                    width: 2,
                    value: (_u, v) => v == null ? '-' : v.toFixed(2) + 'm',
                },
            ],
            axes: [
                { show: false },
                {
                    stroke: '#A3A3A3',
                    grid: { stroke: '#222222', width: 1 },
                    font: '10px sans-serif',
                    values: (_u, vals) => vals.map(v => v + 'm'),
                },
            ],
            cursor: { show: false },
            legend: { show: false },
        };

        const u = new uPlot(opts, [[], []], chartRef.current);
        uplotRef.current = u;

        const resizeObserver = new ResizeObserver(() => {
            if (chartRef.current && uplotRef.current) {
                uplotRef.current.setSize({
                    width: chartRef.current.clientWidth,
                    height: 120,
                });
            }
        });
        resizeObserver.observe(chartRef.current);

        return () => {
            u.destroy();
            resizeObserver.disconnect();
            uplotRef.current = null;
        };
    }, [hasBarometer]);

    useEffect(() => {
        if (uplotRef.current && barometer) {
            const now = (Date.now() - startTimeRef.current) / 1000;

            // Direct mutation of dataRef columns for performance
            dataRef.current[0].push(now);
            dataRef.current[1].push(barometer.altitude);

            // Keep last 100 points
            if (dataRef.current[0].length > 100) {
                dataRef.current[0].shift();
                dataRef.current[1].shift();
            }

            uplotRef.current.setData(dataRef.current as [number[], number[]]);
        }
    }, [barometer]);

    if (!hasBarometer) return null;

    return (
        <div className="p-3 bg-bg-elevated/40 backdrop-blur-md rounded-lg border border-border mt-4 mx-2">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-accent">Barometer (BMP390)</h3>
                <span className="flex h-2 w-2 rounded-full bg-accent animate-pulse" />
            </div>

            <div className="grid grid-cols-3 gap-2 mb-4">
                <div className="bg-white/5 p-2 rounded border border-white/5">
                    <div className="text-[8px] text-text-secondary uppercase mb-1">Altitude</div>
                    <div className="text-lg font-mono text-text-primary leading-none">
                        {barometer?.altitude.toFixed(2)}<span className="text-[10px] ml-1">m</span>
                    </div>
                </div>
                <div className="bg-white/5 p-2 rounded border border-white/5">
                    <div className="text-[8px] text-text-secondary uppercase mb-1">Pressure</div>
                    <div className="text-lg font-mono text-text-primary leading-none">
                        {barometer?.pressure.toFixed(1)}<span className="text-[10px] ml-1">hPa</span>
                    </div>
                </div>
                <div className="bg-white/5 p-2 rounded border border-white/5">
                    <div className="text-[8px] text-text-secondary uppercase mb-1">Temp</div>
                    <div className="text-lg font-mono text-text-primary leading-none">
                        {barometer?.temperature.toFixed(1)}<span className="text-[10px] ml-1">°C</span>
                    </div>
                </div>
            </div>

            <div ref={chartRef} className="w-full h-[120px] overflow-hidden" />
        </div>
    );
}
