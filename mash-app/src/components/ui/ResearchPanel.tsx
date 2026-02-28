/**
 * Research Panel - Streamlined Research Features
 * Apple-inspired: Clean, minimal, progressive disclosure
 */

import { useState } from 'react';
import {
    FileDown,
    Award,
    TrendingDown,
    ChevronRight
} from 'lucide-react';
import { DriftTestWizard } from '../analysis/DriftTestWizard';
import { CalibrationCertificateViewer } from './CalibrationCertificateViewer';
import { ExportModal } from './ExportModal';
import { useDeviceRegistry } from '../../store/useDeviceRegistry';
import { useRecordingStore } from '../../store/useRecordingStore';

export function ResearchPanel() {
    const [activeModal, setActiveModal] = useState<'export' | 'certificate' | 'drift' | null>(null);
    const devices = useDeviceRegistry(state => state.devices);
    const { currentSession, frameCount } = useRecordingStore();

    const hasConnectedDevices = devices.size > 0;
    const hasRecordedData = currentSession && frameCount > 0;

    const features = [
        {
            id: 'export',
            icon: FileDown,
            title: 'Export Data',
            subtitle: hasRecordedData
                ? `${frameCount.toLocaleString()} frames ready`
                : 'Record a session first',
            enabled: hasRecordedData,
        },
        {
            id: 'certificate',
            icon: Award,
            title: 'Calibration Certificate',
            subtitle: hasConnectedDevices ? 'View traceability data' : 'Connect sensors first',
            enabled: hasConnectedDevices,
        },
        {
            id: 'drift',
            icon: TrendingDown,
            title: 'Drift Characterization',
            subtitle: hasConnectedDevices ? '5-minute drift test' : 'Connect sensors first',
            enabled: hasConnectedDevices,
        },
    ] as const;

    return (
        <>
            <div className="space-y-1">
                {features.map(feature => (
                    <button
                        key={feature.id}
                        onClick={() => feature.enabled && setActiveModal(feature.id)}
                        disabled={!feature.enabled}
                        className={`
                            w-full flex items-center gap-3 p-3 rounded-xl
                            transition-all duration-200 group text-left
                            ${feature.enabled
                                ? 'hover:bg-white/5 active:bg-white/10 cursor-pointer'
                                : 'opacity-40 cursor-not-allowed'
                            }
                        `}
                    >
                        <div className={`
                            w-9 h-9 rounded-lg flex items-center justify-center
                            ${feature.enabled ? 'bg-accent/10 text-accent' : 'bg-white/5 text-white/30'}
                        `}>
                            <feature.icon className="h-4.5 w-4.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-white">
                                {feature.title}
                            </div>
                            <div className="text-xs text-white/50 truncate">
                                {feature.subtitle}
                            </div>
                        </div>
                        {feature.enabled && (
                            <ChevronRight className="h-4 w-4 text-white/30 group-hover:text-white/50 transition-colors" />
                        )}
                    </button>
                ))}
            </div>

            {/* Modals */}
            {activeModal === 'export' && (
                <ExportModal onClose={() => setActiveModal(null)} />
            )}
            {activeModal === 'certificate' && (
                <CalibrationCertificateViewer onClose={() => setActiveModal(null)} />
            )}
            {activeModal === 'drift' && (
                <DriftTestModal onClose={() => setActiveModal(null)} />
            )}
        </>
    );
}

// Simple wrapper for DriftTestWizard in modal form
function DriftTestModal({ onClose }: { onClose: () => void }) {
    const devices = useDeviceRegistry(state => state.devices);
    const firstDeviceId = Array.from(devices.keys())[0] || '';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-md m-4">
                <DriftTestWizard
                    deviceId={firstDeviceId}
                    onClose={onClose}
                />
            </div>
        </div>
    );
}
