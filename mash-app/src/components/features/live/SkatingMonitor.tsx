import React from 'react';
import { Card } from '../../ui/Card';

interface SkatingMonitorProps {
    strokeRate?: number;
    效率?: number; // using chinese chars or english? Prop name was strange in my thought process. glideEfficiency.
}

export const SkatingMonitor: React.FC<{ strokeRate?: number, efficiency?: number }> = ({ strokeRate = 0, efficiency = 0 }) => {
    return (
        <Card className="p-4 bg-black/80 border-l-4 border-cyan-500">
            <div className="grid grid-cols-2 gap-4">
                <div>
                    <div className="text-[10px] uppercase text-gray-400">Stroke Rate</div>
                    <div className="text-3xl font-bold text-white">
                        {strokeRate.toFixed(0)} <span className="text-xs text-gray-500 font-normal">spm</span>
                    </div>
                </div>
                <div>
                    <div className="text-[10px] uppercase text-gray-400">Glide Eff.</div>
                    <div className={`text-3xl font-bold ${efficiency > 70 ? 'text-green-400' : efficiency > 50 ? 'text-yellow-400' : 'text-red-400'
                        }`}>
                        {efficiency.toFixed(0)} <span className="text-xs text-gray-500 font-normal">%</span>
                    </div>
                </div>
            </div>

            {/* Efficiency Bar */}
            <div className="mt-3 w-full bg-gray-800 h-1.5 rounded-full overflow-hidden">
                <div
                    className="h-full bg-cyan-500 transition-all duration-300"
                    style={{ width: `${efficiency}%` }}
                />
            </div>
        </Card>
    );
};
