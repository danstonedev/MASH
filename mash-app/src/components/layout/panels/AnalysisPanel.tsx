import { useEffect } from 'react';
import { Activity, GitMerge, Share2, ChevronDown, BarChart3 } from 'lucide-react';
import { useTelemetryStore } from '../../../store/useTelemetryStore';
import { useDeviceRegistry } from '../../../store/useDeviceRegistry';
import { SingleSensorView } from '../../visualization/SingleSensorView';
import { MultiSensorView } from '../../visualization/MultiSensorView';
import { JointBiomechanicsView } from '../../visualization/JointBiomechanicsView';
import { AnalysisResultsPanel } from '../../analysis/AnalysisResultsPanel';

export function AnalysisPanel() {
    const { vizMode, setVizMode, selectedSensorId, setSelectedSensor } = useTelemetryStore();
    const devices = useDeviceRegistry(state => state.devices);
    const sortedDevices = Array.from(devices.values()).sort((a, b) => a.id.localeCompare(b.id));

    // Initialize selected sensor if null
    useEffect(() => {
        if (!selectedSensorId && sortedDevices.length > 0) {
            setSelectedSensor(sortedDevices[0].id);
        }
    }, [sortedDevices, selectedSensorId, setSelectedSensor]);

    return (
        <div className="flex flex-col h-full bg-bg-surface overflow-hidden">
            <h2 className="p-3 text-sm font-bold text-text-primary border-b border-border shrink-0">
                ANALYSIS & CHARTS
            </h2>

            {/* Mode Tabs */}
            <div className="p-2 border-b border-border shrink-0">
                <div className="flex bg-bg-elevated p-0.5 rounded-lg ring-1 ring-border">
                    <button
                        onClick={() => setVizMode('summary')}
                        className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md transition-all text-[10px] ${vizMode === 'summary' ? 'bg-accent text-white shadow-lg' : 'text-text-secondary hover:text-white hover:bg-white/5'}`}
                    >
                        <BarChart3 className="w-3 h-3" />
                        <span className="font-bold uppercase">Summary</span>
                    </button>
                    <button
                        onClick={() => setVizMode('single')}
                        className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md transition-all text-[10px] ${vizMode === 'single' ? 'bg-accent text-white shadow-lg' : 'text-text-secondary hover:text-white hover:bg-white/5'}`}
                    >
                        <Activity className="w-3 h-3" />
                        <span className="font-bold uppercase">Single</span>
                    </button>
                    <button
                        onClick={() => setVizMode('multi')}
                        className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md transition-all text-[10px] ${vizMode === 'multi' ? 'bg-accent text-white shadow-lg' : 'text-text-secondary hover:text-white hover:bg-white/5'}`}
                    >
                        <GitMerge className="w-3 h-3" />
                        <span className="font-bold uppercase">Multi</span>
                    </button>
                    <button
                        onClick={() => setVizMode('joint')}
                        className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md transition-all text-[10px] ${vizMode === 'joint' ? 'bg-accent text-white shadow-lg' : 'text-text-secondary hover:text-white hover:bg-white/5'}`}
                    >
                        <Share2 className="w-3 h-3" />
                        <span className="font-bold uppercase">Joint</span>
                    </button>
                </div>
            </div>

            {/* Single Sensor Selector */}
            {vizMode === 'single' && sortedDevices.length > 0 && (
                <div className="p-2 border-b border-border shrink-0">
                    <div className="relative">
                        <select
                            value={selectedSensorId || ''}
                            onChange={(e) => setSelectedSensor(e.target.value)}
                            className="w-full bg-bg-elevated border border-border rounded py-1.5 px-2 text-xs text-text-primary appearance-none"
                        >
                            {sortedDevices.map(device => (
                                <option key={device.id} value={device.id}>
                                    {device.name || `Device ${device.id}`}
                                </option>
                            ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-secondary pointer-events-none" />
                    </div>
                </div>
            )}

            {/* Telemetry Content */}
            <div className="flex-1 overflow-hidden">
                {vizMode === 'summary' && <AnalysisResultsPanel />}
                {vizMode === 'single' && <SingleSensorView />}
                {vizMode === 'multi' && <MultiSensorView />}
                {vizMode === 'joint' && <JointBiomechanicsView />}
            </div>
        </div>
    );
}

