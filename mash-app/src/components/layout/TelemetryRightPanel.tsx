import { ChevronRight, Maximize2, Activity, Database, BarChart3, Smartphone, Layers, Network } from 'lucide-react';
import { useTelemetryStore } from '../../store/useTelemetryStore';
import { SingleSensorView } from '../visualization/SingleSensorView';
import { MultiSensorView } from '../visualization/MultiSensorView';
import { JointBiomechanicsView } from '../visualization/JointBiomechanicsView';
import { BarometerPanel } from '../ui/BarometerPanel';
import { SessionManager } from '../ui/SessionManager';
import { AnalysisPanel } from '../ui/AnalysisPanel';

export function TelemetryRightPanel() {
    const { vizMode, isRightPanelOpen, setRightPanelOpen } = useTelemetryStore();

    if (!isRightPanelOpen) {
        return (
            <div className="absolute right-0 top-1/2 -translate-y-1/2 z-50">
                <button
                    onClick={() => setRightPanelOpen(true)}
                    className="bg-bg-elevated border border-l-0 border-border p-2 rounded-l-lg hover:bg-bg-primary transition-colors shadow-lg"
                    aria-label="Open Telemetry Panel"
                    title="Open Telemetry Panel"
                >
                    <ChevronRight className="w-4 h-4 rotate-180 text-text-secondary" aria-hidden="true" />
                </button>
            </div>
        );
    }

    return (
        <div className="w-[30%] min-w-[320px] max-w-[500px] border-l border-border bg-bg-surface flex flex-col h-full relative transition-all duration-300 ease-in-out">
            {/* Tab Navigation */}
            <div className="flex border-b border-border bg-bg-elevated/20">
                <button
                    onClick={() => useTelemetryStore.setState({ vizMode: 'single' })}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${['single', 'multi', 'joint'].includes(vizMode) ? 'text-accent border-b-2 border-accent bg-accent/5' : 'text-text-secondary hover:text-text-primary'}`}
                >
                    <Activity className="w-3 h-3" /> Telemetry
                </button>
                <button
                    onClick={() => useTelemetryStore.setState({ vizMode: 'history' })}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${vizMode === 'history' ? 'text-accent border-b-2 border-accent bg-accent/5' : 'text-text-secondary hover:text-text-primary'}`}
                >
                    <Database className="w-3 h-3" /> History
                </button>
                <button
                    onClick={() => useTelemetryStore.setState({ vizMode: 'analyze' })}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${vizMode === 'analyze' ? 'text-accent border-b-2 border-accent bg-accent/5' : 'text-text-secondary hover:text-text-primary'}`}
                >
                    <BarChart3 className="w-3 h-3" /> Analyze
                </button>
            </div>

            {/* Sub-Navigation for Telemetry Modes */}
            {['single', 'multi', 'joint'].includes(vizMode) && (
                <div className="flex p-1 bg-bg-surface border-b border-border gap-1">
                    <button
                        onClick={() => useTelemetryStore.setState({ vizMode: 'single' })}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-semibold transition-all ${vizMode === 'single' ? 'bg-bg-elevated text-text-primary shadow-sm ring-1 ring-border' : 'text-text-tertiary hover:text-text-secondary'}`}
                    >
                        <Smartphone className="w-3 h-3" /> Single
                    </button>
                    <button
                        onClick={() => useTelemetryStore.setState({ vizMode: 'multi' })}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-semibold transition-all ${vizMode === 'multi' ? 'bg-bg-elevated text-text-primary shadow-sm ring-1 ring-border' : 'text-text-tertiary hover:text-text-secondary'}`}
                    >
                        <Layers className="w-3 h-3" /> Multi
                    </button>
                    <button
                        onClick={() => useTelemetryStore.setState({ vizMode: 'joint' })}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-semibold transition-all ${vizMode === 'joint' ? 'bg-bg-elevated text-text-primary shadow-sm ring-1 ring-border' : 'text-text-tertiary hover:text-text-secondary'}`}
                    >
                        <Network className="w-3 h-3" /> Joint
                    </button>
                </div>
            )}

            {/* Header / Collapse Handle */}
            <div className="flex items-center justify-end p-1 border-b border-border bg-bg-elevated/30">
                <div className="flex items-center gap-1">
                    <button className="p-1 hover:bg-white/5 rounded text-text-secondary hover:text-white" title="Maximize">
                        <Maximize2 className="w-3 h-3" />
                    </button>
                    <button
                        onClick={() => setRightPanelOpen(false)}
                        className="p-1 hover:bg-white/5 rounded text-text-secondary hover:text-white"
                        title="Collapse"
                    >
                        <ChevronRight className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {/* Dynamic Content */}
            <div className="flex-1 overflow-hidden relative">
                {vizMode === 'history' ? (
                    <SessionManager />
                ) : vizMode === 'analyze' ? (
                    <AnalysisPanel />
                ) : (
                    <>
                        {vizMode === 'single' && <SingleSensorView />}
                        {vizMode === 'multi' && <MultiSensorView />}
                        {vizMode === 'joint' && <JointBiomechanicsView />}
                    </>
                )}
            </div>

            {/* Optional Environmental Sensors (BMP390/MMC5603) */}
            <BarometerPanel />
        </div>
    );
}
