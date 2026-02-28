/**
 * Sensor Alignment Card
 * =====================
 * 
 * Toggle for sensor placement/alignment mode.
 */

import { Move } from 'lucide-react';
import { useDeviceRegistry } from '../../store/useDeviceRegistry';
import { cn } from '../../lib/utils';

export function SensorAlignmentCard() {
    const { isPlacementMode, setPlacementMode } = useDeviceRegistry();

    return (
        <div className="p-3 bg-bg-elevated rounded-lg space-y-2">
            <div className="flex items-center gap-2">
                <Move className="h-4 w-4 text-text-secondary" />
                <span className="text-xs font-semibold text-text-secondary uppercase">Sensor Alignment</span>
            </div>

            <button
                onClick={() => setPlacementMode(!isPlacementMode)}
                className={cn(
                    "w-full flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-md transition-all border",
                    isPlacementMode
                        ? "bg-accent text-white shadow-lg border-accent"
                        : "bg-bg-primary text-text-secondary hover:text-white hover:bg-white/5 border-border"
                )}
            >
                <Move className="h-4 w-4" />
                {isPlacementMode ? 'EXIT PLACEMENT MODE' : 'EDIT SENSOR PLACEMENT'}
            </button>

            {isPlacementMode && (
                <div className="p-2 bg-accent/10 border border-accent/20 rounded text-[10px] text-accent">
                    Click a sensor in the 3D view to select it. Drag the arrows to fine-tune position.
                </div>
            )}
        </div>
    );
}
