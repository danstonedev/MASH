import React from 'react';
import { Card } from '../../ui/Card';

export const SquatGauge: React.FC<{ depth?: number, formScore?: number }> = ({ depth = 0, formScore = 0 }) => {
    // Depth: 0 (stand) -> 90 (parallel) -> 120 (ATG)
    const isParallel = depth >= 90;
    const isGoodForm = Math.abs(formScore) < 15; // Spine angle

    return (
        <Card className={`p-4 bg-black/80 border-l-4 ${isParallel ? 'border-green-500' : 'border-orange-500'}`}>
            <div className="flex justify-between items-end">
                <div>
                    <div className="text-[10px] uppercase text-gray-400">Thigh Depth</div>
                    <div className={`text-3xl font-bold ${isParallel ? 'text-green-500' : 'text-orange-400'}`}>
                        {depth.toFixed(0)}°
                    </div>
                </div>

                <div className="text-right">
                    <div className="text-[10px] uppercase text-gray-400">Torso</div>
                    <div className={`text-lg font-bold ${isGoodForm ? 'text-white' : 'text-red-400'}`}>
                        {Math.abs(formScore).toFixed(0)}°
                    </div>
                </div>
            </div>

            <div className="mt-2 text-xs text-center font-bold uppercase tracking-widest text-gray-500">
                {isParallel ? 'GOOD REP' : 'GO LOWER'}
            </div>
        </Card>
    );
};
