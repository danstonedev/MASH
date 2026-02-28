/**
 * Export Panel
 * ============
 * 
 * User-friendly export with:
 * - Content selection (choose what to include)
 * - One-click report generation
 * - Live preview before download
 * - Multiple formats (PDF, PNG, CSV)
 * - Progress feedback
 */

import { useState, useCallback } from 'react';
import {
    FileDown,
    FileImage,
    FileText,
    FileSpreadsheet,
    Loader2,
    CheckCircle,
    Download,
    Eye,
    X,
    Sparkles,
    Settings2,
    Activity,
    Footprints,
    Gauge,
    BarChart3,
    Clock,
    Cpu
} from 'lucide-react';
import { sessionAnalyzer, type SessionAnalysisResult } from '../../analysis/SessionAnalyzer';
import { usePlaybackStore } from '../../store/usePlaybackStore';
import { cn } from '../../lib/utils';

// ============================================================================
// TYPES
// ============================================================================

type ExportFormat = 'html' | 'csv' | 'json';

interface ExportOption {
    format: ExportFormat;
    label: string;
    description: string;
    icon: React.ReactNode;
}

interface ReportSection {
    id: string;
    label: string;
    description: string;
    icon: React.ReactNode;
    default: boolean;
}

interface ReportSettings {
    includeSummary: boolean;
    includeActivity: boolean;
    includeGait: boolean;
    includeFatigue: boolean;
    includeQuality: boolean;
    includeRawData: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const EXPORT_OPTIONS: ExportOption[] = [
    {
        format: 'html',
        label: 'Visual Report',
        description: 'Beautiful styled report',
        icon: <FileImage className="w-5 h-5" />
    },
    {
        format: 'csv',
        label: 'Spreadsheet',
        description: 'Excel-compatible data',
        icon: <FileSpreadsheet className="w-5 h-5" />
    },
    {
        format: 'json',
        label: 'Raw Data',
        description: 'Full analysis JSON',
        icon: <FileText className="w-5 h-5" />
    }
];

const REPORT_SECTIONS: ReportSection[] = [
    {
        id: 'summary',
        label: 'Session Summary',
        description: 'Duration, frames, sensors',
        icon: <Clock className="w-4 h-4" />,
        default: true
    },
    {
        id: 'activity',
        label: 'Activity Breakdown',
        description: 'Walking, running, idle time',
        icon: <Activity className="w-4 h-4" />,
        default: true
    },
    {
        id: 'gait',
        label: 'Gait Metrics',
        description: 'Steps, cadence, symmetry',
        icon: <Footprints className="w-4 h-4" />,
        default: true
    },
    {
        id: 'fatigue',
        label: 'Fatigue Analysis',
        description: 'Fatigue index, trends',
        icon: <Gauge className="w-4 h-4" />,
        default: false
    },
    {
        id: 'quality',
        label: 'Data Quality',
        description: 'Sample rate, missing frames',
        icon: <BarChart3 className="w-4 h-4" />,
        default: true
    },
    {
        id: 'rawData',
        label: 'Technical Details',
        description: 'Sensor IDs, raw metrics',
        icon: <Cpu className="w-4 h-4" />,
        default: false
    }
];

const DEFAULT_SETTINGS: ReportSettings = {
    includeSummary: true,
    includeActivity: true,
    includeGait: true,
    includeFatigue: false,
    includeQuality: true,
    includeRawData: false
};

// ============================================================================
// HELPERS
// ============================================================================

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
}

function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Generate CSV content from analysis
function generateCSV(result: SessionAnalysisResult, settings: ReportSettings): string {
    const rows: string[][] = [
        ['Session Report - ' + result.sessionName],
        ['Generated', new Date().toISOString()],
        []
    ];

    if (settings.includeSummary) {
        rows.push(['=== SESSION SUMMARY ===']);
        rows.push(['Session Name', result.sessionName]);
        rows.push(['Duration', formatDuration(result.totalDuration)]);
        rows.push(['Total Frames', String(result.frameCount)]);
        rows.push([]);
    }

    if (settings.includeGait) {
        rows.push(['=== GAIT METRICS ===']);
        rows.push(['Total Steps', String(result.totalSteps)]);
        rows.push(['Average Cadence (steps/min)', result.averageCadence.toFixed(1)]);
        if (result.overallGaitMetrics) {
            if (result.overallGaitMetrics.symmetryIndex !== undefined) {
                rows.push(['Symmetry Index', result.overallGaitMetrics.symmetryIndex.toFixed(2)]);
            }
            if (result.overallGaitMetrics.strideTimeCV !== undefined) {
                rows.push(['Stride Time CV', result.overallGaitMetrics.strideTimeCV.toFixed(2)]);
            }
        }
        rows.push([]);
    }

    if (settings.includeActivity) {
        rows.push(['=== ACTIVITY BREAKDOWN ===']);
        rows.push(['Activity', 'Duration (s)', 'Percentage']);
        Object.entries(result.activitySummary).forEach(([activity, duration]) => {
            rows.push([
                activity,
                (duration / 1000).toFixed(1),
                ((duration / result.totalDuration) * 100).toFixed(1) + '%'
            ]);
        });
        rows.push([]);
    }

    if (settings.includeQuality) {
        rows.push(['=== DATA QUALITY ===']);
        rows.push(['Sensor Count', String(result.dataQuality.sensorCount)]);
        rows.push(['Sample Rate (Hz)', result.dataQuality.averageSampleRate.toFixed(1)]);
        rows.push(['Missing Frames', String(result.dataQuality.missingFrames)]);
        const quality = 100 - (result.dataQuality.missingFrames / result.frameCount) * 100;
        rows.push(['Quality Score', quality.toFixed(1) + '%']);
        rows.push([]);
    }

    return rows.map(row => row.join(',')).join('\n');
}

// Generate report card HTML
function generateReportHTML(result: SessionAnalysisResult, settings: ReportSettings): string {
    const activityBars = settings.includeActivity
        ? Object.entries(result.activitySummary)
            .filter(([_, duration]) => duration > 0)
            .map(([activity, duration]) => {
                const percent = (duration / result.totalDuration) * 100;
                const colors: Record<string, string> = {
                    walking: '#22c55e',
                    running: '#f59e0b',
                    idle: '#6b7280',
                    skating: '#3b82f6',
                    jumping: '#ef4444'
                };
                return `<div style="width:${percent}%;background:${colors[activity] || '#9ca3af'};height:100%" title="${activity}: ${percent.toFixed(0)}%"></div>`;
            }).join('')
        : '';

    const metricsHTML = [];

    if (settings.includeSummary) {
        metricsHTML.push(`
            <div class="metric">
                <div class="metric-label">Duration</div>
                <div class="metric-value">${formatDuration(result.totalDuration)}</div>
            </div>
        `);
    }

    if (settings.includeGait) {
        metricsHTML.push(`
            <div class="metric">
                <div class="metric-label">Total Steps</div>
                <div class="metric-value">${result.totalSteps}<span class="metric-unit">steps</span></div>
            </div>
            <div class="metric">
                <div class="metric-label">Cadence</div>
                <div class="metric-value">${result.averageCadence.toFixed(0)}<span class="metric-unit">spm</span></div>
            </div>
        `);
    }

    if (settings.includeQuality) {
        const quality = 100 - (result.dataQuality.missingFrames / result.frameCount) * 100;
        metricsHTML.push(`
            <div class="metric">
                <div class="metric-label">Data Quality</div>
                <div class="metric-value">${quality.toFixed(0)}<span class="metric-unit">%</span></div>
            </div>
        `);
    }

    if (settings.includeGait && result.overallGaitMetrics?.symmetryIndex !== undefined) {
        metricsHTML.push(`
            <div class="metric">
                <div class="metric-label">Symmetry</div>
                <div class="metric-value">${result.overallGaitMetrics.symmetryIndex.toFixed(0)}<span class="metric-unit">%</span></div>
            </div>
        `);
    }

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Session Report - ${result.sessionName}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 40px;
            color: white;
        }
        .card {
            background: rgba(255,255,255,0.05);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 16px;
            padding: 32px;
            max-width: 600px;
            margin: 0 auto;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .logo {
            width: 48px;
            height: 48px;
            background: linear-gradient(135deg, #00a86b 0%, #00ff9d 100%);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 24px;
        }
        .title { font-size: 24px; font-weight: 700; }
        .subtitle { font-size: 12px; opacity: 0.6; }
        .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 24px 0; }
        .metric {
            background: rgba(255,255,255,0.05);
            padding: 16px;
            border-radius: 12px;
        }
        .metric-label { font-size: 12px; opacity: 0.6; margin-bottom: 4px; }
        .metric-value { font-size: 28px; font-weight: 700; }
        .metric-unit { font-size: 14px; opacity: 0.6; margin-left: 4px; }
        .section { margin-top: 24px; }
        .section-title { font-size: 12px; opacity: 0.6; margin-bottom: 8px; }
        .activity-bar {
            height: 8px;
            border-radius: 4px;
            overflow: hidden;
            display: flex;
            background: rgba(255,255,255,0.1);
        }
        .footer {
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid rgba(255,255,255,0.1);
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            opacity: 0.5;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <div class="logo">⚡</div>
            <div>
                <div class="title">${result.sessionName}</div>
                <div class="subtitle">Session Report • ${formatDate(result.analyzedAt)}</div>
            </div>
        </div>
        
        ${metricsHTML.length > 0 ? `<div class="metrics">${metricsHTML.join('')}</div>` : ''}
        
        ${settings.includeActivity ? `
        <div class="section">
            <div class="section-title">Activity Breakdown</div>
            <div class="activity-bar">${activityBars}</div>
        </div>
        ` : ''}
        
        <div class="footer">
            <span>IMU Connect • Research-Grade Motion Analysis</span>
            <span>Generated ${new Date().toLocaleDateString()}</span>
        </div>
    </div>
</body>
</html>`;
}

// ============================================================================
// CONTENT SELECTOR
// ============================================================================

interface ContentSelectorProps {
    settings: ReportSettings;
    onChange: (settings: ReportSettings) => void;
}

function ContentSelector({ settings, onChange }: ContentSelectorProps) {
    const toggleSection = (sectionId: string) => {
        const key = `include${sectionId.charAt(0).toUpperCase() + sectionId.slice(1)}` as keyof ReportSettings;
        onChange({ ...settings, [key]: !settings[key] });
    };

    const selectAll = () => {
        onChange({
            includeSummary: true,
            includeActivity: true,
            includeGait: true,
            includeFatigue: true,
            includeQuality: true,
            includeRawData: true
        });
    };

    const selectEssential = () => {
        onChange(DEFAULT_SETTINGS);
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-text-secondary">
                    <Settings2 className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase">Report Content</span>
                </div>
                <div className="flex gap-1">
                    <button
                        onClick={selectEssential}
                        className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors"
                    >
                        Essential
                    </button>
                    <button
                        onClick={selectAll}
                        className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors"
                    >
                        All
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
                {REPORT_SECTIONS.map(section => {
                    const key = `include${section.id.charAt(0).toUpperCase() + section.id.slice(1)}` as keyof ReportSettings;
                    const isEnabled = settings[key];

                    return (
                        <button
                            key={section.id}
                            onClick={() => toggleSection(section.id)}
                            className={cn(
                                "flex items-start gap-2 p-2 rounded-lg text-left transition-all",
                                "ring-1",
                                isEnabled
                                    ? "bg-accent/10 ring-accent/50 text-white"
                                    : "bg-bg-elevated ring-border text-text-secondary hover:ring-white/30"
                            )}
                        >
                            <div className={cn(
                                "mt-0.5 w-4 h-4 rounded flex items-center justify-center shrink-0 transition-colors",
                                isEnabled ? "bg-accent text-white" : "bg-white/10"
                            )}>
                                {isEnabled && <CheckCircle className="w-3 h-3" />}
                            </div>
                            <div className="min-w-0">
                                <div className="text-xs font-bold flex items-center gap-1">
                                    {section.icon}
                                    {section.label}
                                </div>
                                <div className="text-[10px] opacity-60 truncate">
                                    {section.description}
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ============================================================================
// PREVIEW MODAL
// ============================================================================

interface PreviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    content: string;
    format: ExportFormat;
    onDownload: () => void;
}

function PreviewModal({ isOpen, onClose, content, format, onDownload }: PreviewModalProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-bg-elevated rounded-2xl ring-1 ring-border max-w-3xl w-full max-h-[80vh] flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <div className="flex items-center gap-2">
                        <Eye className="w-4 h-4 text-accent" />
                        <span className="font-bold">Preview</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1 hover:bg-white/10 rounded-lg transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto p-4 bg-bg">
                    {format === 'html' ? (
                        <iframe
                            srcDoc={content}
                            className="w-full h-[500px] rounded-lg border border-border"
                            title="Report Preview"
                        />
                    ) : (
                        <pre className="text-xs font-mono bg-black/50 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap">
                            {content}
                        </pre>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm rounded-lg hover:bg-white/10 transition-colors"
                    >
                        Close
                    </button>
                    <button
                        onClick={onDownload}
                        className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover rounded-lg font-bold flex items-center gap-2 transition-colors"
                    >
                        <Download className="w-4 h-4" />
                        Download
                    </button>
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function ExportPanel() {
    const sessionId = usePlaybackStore(state => state.sessionId);
    const sessionName = usePlaybackStore(state => state.sessionName);

    const [isExporting, setIsExporting] = useState(false);
    const [exportSuccess, setExportSuccess] = useState<ExportFormat | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewContent, setPreviewContent] = useState('');
    const [previewFormat, setPreviewFormat] = useState<ExportFormat>('html');
    const [analysisResult, setAnalysisResult] = useState<SessionAnalysisResult | null>(null);
    const [settings, setSettings] = useState<ReportSettings>(DEFAULT_SETTINGS);

    // Analyze session for export
    const prepareExport = useCallback(async (): Promise<SessionAnalysisResult | null> => {
        if (!sessionId) return null;

        if (analysisResult && analysisResult.sessionId === sessionId) {
            return analysisResult;
        }

        const result = await sessionAnalyzer.analyzeSession(sessionId);
        if (result) {
            setAnalysisResult(result);
        }
        return result;
    }, [sessionId, analysisResult]);

    // Generate content based on format and settings
    const generateContent = useCallback((result: SessionAnalysisResult, format: ExportFormat): string => {
        switch (format) {
            case 'html':
                return generateReportHTML(result, settings);
            case 'csv':
                return generateCSV(result, settings);
            case 'json':
                // Filter JSON based on settings
                const filtered: Record<string, unknown> = {
                    sessionId: result.sessionId,
                    sessionName: result.sessionName,
                    analyzedAt: result.analyzedAt
                };
                if (settings.includeSummary) {
                    filtered.totalDuration = result.totalDuration;
                    filtered.frameCount = result.frameCount;
                }
                if (settings.includeActivity) {
                    filtered.activitySummary = result.activitySummary;
                    filtered.activitySegments = result.activitySegments;
                }
                if (settings.includeGait) {
                    filtered.totalSteps = result.totalSteps;
                    filtered.averageCadence = result.averageCadence;
                    filtered.overallGaitMetrics = result.overallGaitMetrics;
                    filtered.gaitSegments = result.gaitSegments;
                }
                if (settings.includeQuality) {
                    filtered.dataQuality = result.dataQuality;
                }
                if (settings.includeRawData) {
                    filtered.rawFeatures = result.rawFeatures;
                }
                return JSON.stringify(filtered, null, 2);
            default:
                return JSON.stringify(result, null, 2);
        }
    }, [settings]);

    // Preview export
    const handlePreview = useCallback(async (format: ExportFormat) => {
        setIsExporting(true);

        try {
            const result = await prepareExport();
            if (!result) {
                throw new Error('Failed to analyze session');
            }

            const content = generateContent(result, format);
            setPreviewContent(content);
            setPreviewFormat(format);
            setPreviewOpen(true);
        } catch (error) {
            console.error('Preview failed:', error);
        } finally {
            setIsExporting(false);
        }
    }, [prepareExport, generateContent]);

    // Download export
    const handleDownload = useCallback(async (format: ExportFormat) => {
        setIsExporting(true);

        try {
            const result = await prepareExport();
            if (!result) {
                throw new Error('Failed to analyze session');
            }

            const content = generateContent(result, format);

            const mimeTypes: Record<ExportFormat, string> = {
                html: 'text/html',
                csv: 'text/csv',
                json: 'application/json'
            };

            // Create download
            const blob = new Blob([content], { type: mimeTypes[format] });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${sessionName || 'session'}_report.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Show success
            setExportSuccess(format);
            setTimeout(() => setExportSuccess(null), 2000);
            setPreviewOpen(false);
        } catch (error) {
            console.error('Download failed:', error);
        } finally {
            setIsExporting(false);
        }
    }, [prepareExport, generateContent, sessionName]);

    // Quick export (one-click)
    const handleQuickExport = useCallback(async () => {
        await handleDownload('html');
    }, [handleDownload]);

    // No session
    if (!sessionId) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-text-secondary p-4">
                <FileDown className="w-12 h-12 mb-3 opacity-30" />
                <p className="text-sm">No session loaded</p>
                <p className="text-xs mt-1">Load a session to export reports</p>
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto p-3 space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2 text-accent">
                <FileDown className="w-4 h-4" />
                <h3 className="text-sm font-bold">Export Report</h3>
            </div>

            {/* Content Selector */}
            <ContentSelector settings={settings} onChange={setSettings} />

            {/* Quick Export Button */}
            <button
                onClick={handleQuickExport}
                disabled={isExporting}
                className={cn(
                    "w-full py-4 rounded-xl font-bold text-sm transition-all",
                    "bg-gradient-to-r from-accent to-green-400 hover:from-accent-hover hover:to-green-300",
                    "flex items-center justify-center gap-3 shadow-lg shadow-accent/20",
                    "active:scale-98",
                    isExporting && "opacity-50 cursor-not-allowed"
                )}
            >
                {isExporting ? (
                    <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Generating...
                    </>
                ) : exportSuccess ? (
                    <>
                        <CheckCircle className="w-5 h-5" />
                        Downloaded!
                    </>
                ) : (
                    <>
                        <Sparkles className="w-5 h-5" />
                        Generate Report
                    </>
                )}
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3 py-2">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-text-secondary">or choose format</span>
                <div className="flex-1 h-px bg-border" />
            </div>

            {/* Export Options */}
            <div className="space-y-2">
                {EXPORT_OPTIONS.map(option => (
                    <div
                        key={option.format}
                        className="bg-bg-elevated rounded-xl p-3 ring-1 ring-border hover:ring-accent/50 transition-all group"
                    >
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent group-hover:bg-accent/20 transition-colors">
                                {option.icon}
                            </div>
                            <div className="flex-1">
                                <div className="font-bold text-sm">{option.label}</div>
                                <div className="text-xs text-text-secondary">{option.description}</div>
                            </div>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => handlePreview(option.format)}
                                    disabled={isExporting}
                                    className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                                    title="Preview"
                                >
                                    <Eye className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => handleDownload(option.format)}
                                    disabled={isExporting}
                                    className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                                    title="Download"
                                >
                                    <Download className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Success Toast */}
            {exportSuccess && (
                <div className="fixed bottom-4 right-4 bg-green-500 text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 animate-in slide-in-from-bottom z-50">
                    <CheckCircle className="w-5 h-5" />
                    <span className="font-bold">Report downloaded!</span>
                </div>
            )}

            {/* Preview Modal */}
            <PreviewModal
                isOpen={previewOpen}
                onClose={() => setPreviewOpen(false)}
                content={previewContent}
                format={previewFormat}
                onDownload={() => handleDownload(previewFormat)}
            />
        </div>
    );
}
