import React from 'react';
import { Card } from '../../ui/Card';

export const BalanceRing: React.FC<{ sway?: number, score?: number }> = ({ sway = 0, score = 0 }) => {
    // Score 0-100 (100 is best)
    const color = score > 80 ? 'text-green-500' : score > 50 ? 'text-yellow-500' : 'text-red-500';

    return (
        <Card className="p-4 bg-black/80 border-l-4 border-purple-500 flex items-center justify-between">
            <div className="relative w-12 h-12 flex items-center justify-center">
                {/* SVG Ring? Or simple text */}
                <div className={`text-xl font-bold ${color}`}>
                    {score.toFixed(0)}
                </div>
            </div>

            <div className="text-right">
                <div className="text-[10px] uppercase text-gray-400">Sway Area</div>
                <div className="text-white font-mono">
                    {sway.toFixed(2)} <span className="text-xs text-gray-600">cm²</span>
                </div>
            </div>
        </Card>
    );
};
