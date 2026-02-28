/**
 * Research Panel - Dedicated research tools and validation features
 * Apple-style: Clean, minimal, organized feature categories
 */

import { useState } from 'react';
import {
    FileDown,
    Award,
    TrendingDown,
    ChevronRight,
    FlaskConical,
    Target,
    BarChart3,
    FileCheck
} from 'lucide-react';
import { DriftTestWizard } from '../../analysis/DriftTestWizard';
import { CalibrationCertificateViewer } from '../../ui/CalibrationCertificateViewer';
import { ExportModal } from '../../ui/ExportModal';
import { useDeviceRegistry } from '../../../store/useDeviceRegistry';
import { useRecordingStore } from '../../../store/useRecordingStore';

interface FeatureItem {
    id: string;
    icon: typeof FileDown;
    title: string;
    subtitle: string;
    enabled: boolean;
    category: 'export' | 'validation' | 'calibration';
}

export function ResearchPanelFull() {
    const [activeModal, setActiveModal] = useState<string | null>(null);
    const devices = useDeviceRegistry(state => state.devices);
    const { currentSession, frameCount } = useRecordingStore();

    const hasConnectedDevices = devices.size > 0;
    const hasRecordedData = currentSession && frameCount > 0;

    const features: FeatureItem[] = [
        // Export Category
        {
            id: 'export-csv',
            icon: FileDown,
            title: 'Export CSV',
            subtitle: hasRecordedData ? `${frameCount.toLocaleString()} frames` : 'No data',
            enabled: !!hasRecordedData,
            category: 'export',
        },
        {
            id: 'export-opensim',
            icon: FileCheck,
            title: 'Export OpenSim',
            subtitle: 'Biomechanics STO format',
            enabled: !!hasRecordedData,
            category: 'export',
        },

        // Validation Category
        {
            id: 'drift-test',
            icon: TrendingDown,
            title: 'Drift Characterization',
            subtitle: '5-minute static test',
            enabled: hasConnectedDevices,
            category: 'validation',
        },
        {
            id: 'mocap-validation',
            icon: BarChart3,
            title: 'MoCap Validation',
            subtitle: 'Compare with optical data',
            enabled: !!hasRecordedData,
            category: 'validation',
        },

        // Calibration Category
        {
            id: 'certificate',
            icon: Award,
            title: 'Calibration Certificate',
            subtitle: 'Traceability data',
            enabled: hasConnectedDevices,
            category: 'calibration',
        },
    ];

    const categories = [
        { id: 'export', title: 'Data Export', icon: FileDown },
        { id: 'validation', title: 'Validation', icon: FlaskConical },
        { id: 'calibration', title: 'Calibration', icon: Target },
    ] as const;

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                    <FlaskConical className="h-4 w-4 text-accent" />
                    <span className="text-sm font-semibold text-white">Research Tools</span>
                </div>
                <p className="text-[10px] text-white/40 mt-1">
                    Publication-quality export & validation
                </p>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
                {categories.map(category => {
                    const items = features.filter(f => f.category === category.id);
                    const CategoryIcon = category.icon;

                    return (
                        <div key={category.id}>
                            <div className="flex items-center gap-2 mb-2 px-1">
                                <CategoryIcon className="h-3 w-3 text-white/40" />
                                <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">
                                    {category.title}
                                </span>
                            </div>
                            <div className="space-y-1">
                                {items.map(item => (
                                    <button
                                        key={item.id}
                                        onClick={() => item.enabled && setActiveModal(item.id)}
                                        disabled={!item.enabled}
                                        className={`
                                            w-full flex items-center gap-3 p-2.5 rounded-xl
                                            transition-all duration-200 group text-left
                                            ${item.enabled
                                                ? 'hover:bg-white/5 active:bg-white/10 cursor-pointer'
                                                : 'opacity-40 cursor-not-allowed'
                                            }
                                        `}
                                    >
                                        <div className={`
                                            w-8 h-8 rounded-lg flex items-center justify-center shrink-0
                                            ${item.enabled ? 'bg-accent/10 text-accent' : 'bg-white/5 text-white/30'}
                                        `}>
                                            <item.icon className="h-4 w-4" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium text-white">
                                                {item.title}
                                            </div>
                                            <div className="text-[10px] text-white/40 truncate">
                                                {item.subtitle}
                                            </div>
                                        </div>
                                        {item.enabled && (
                                            <ChevronRight className="h-3.5 w-3.5 text-white/20 group-hover:text-white/40 transition-colors shrink-0" />
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Modals */}
            {(activeModal === 'export-csv' || activeModal === 'export-opensim') && (
                <ExportModal onClose={() => setActiveModal(null)} />
            )}
            {activeModal === 'certificate' && (
                <CalibrationCertificateViewer onClose={() => setActiveModal(null)} />
            )}
            {activeModal === 'drift-test' && (
                <DriftTestModal onClose={() => setActiveModal(null)} />
            )}
            {activeModal === 'mocap-validation' && (
                <ValidationModal onClose={() => setActiveModal(null)} />
            )}
        </div>
    );
}

// Modal wrapper for DriftTestWizard
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

// Modal wrapper for ValidationReport
function ValidationModal({ onClose }: { onClose: () => void }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg m-4 max-h-[80vh] overflow-y-auto bg-[#1C1C1E] rounded-2xl">
                <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#1C1C1E]">
                    <button onClick={onClose} className="text-accent text-sm font-medium">
                        Done
                    </button>
                    <span className="text-sm font-semibold text-white">MoCap Validation</span>
                    <div className="w-12" />
                </div>
                <div className="p-4">
                    <p className="text-sm text-white/60 text-center py-8">
                        Upload a TRC file and select an IMU session to compare.
                        <br /><br />
                        <span className="text-white/40 text-xs">
                            This feature requires recorded IMU data and optical MoCap data for comparison.
                        </span>
                    </p>
                </div>
            </div>
        </div>
    );
}
