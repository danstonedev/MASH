import { useState } from "react";
import { Activity } from "lucide-react";
import { RecorderControls } from "../../debug/RecorderControls";
import { StreamAnalyzerControls } from "../../debug/StreamAnalyzerControls";
import { SensorHealthDashboard } from "../../debug/SensorHealthDashboard";
import { SystemCommands } from "../../debug/SystemCommands";
import { PipelineInspector } from "../../tools/PipelineInspector";

export function DebugPanel() {
  const [showPipelineInspector, setShowPipelineInspector] = useState(false);

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-surface">
      {/* Header */}
      <div className="p-4 border-b border-border bg-bg-elevated/50">
        <div className="text-sm font-semibold text-text-primary">
          Debug Dashboard
        </div>
        <div className="text-[11px] text-text-tertiary">
          Sensor Health & Diagnostics
        </div>
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* Pipeline Inspector Launch */}
        <section>
          <button
            onClick={() => setShowPipelineInspector(true)}
            className="w-full flex items-center justify-center gap-2 py-2 bg-white/5 hover:bg-white/10 rounded border border-white/10 text-xs font-medium text-text-primary transition-colors"
          >
            <Activity size={14} className="text-accent" />
            Open Pipeline Inspector
          </button>
          <PipelineInspector
            isOpen={showPipelineInspector}
            onClose={() => setShowPipelineInspector(false)}
          />
        </section>
        {/* 1. Sensor Health — are all sensors connected and at target Hz? */}
        <section>
          <SensorHealthDashboard />
        </section>

        {/* 2. High-Speed Stream Analyzer */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-3 bg-cyan-500/50 rounded-full" />
            <h2 className="text-xs font-bold text-text-secondary uppercase">
              Stream Analysis
            </h2>
          </div>
          <StreamAnalyzerControls />
        </section>

        {/* 3. Recording & Export */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-3 bg-purple-500/50 rounded-full" />
            <h2 className="text-xs font-bold text-text-secondary uppercase">
              Diagnostics
            </h2>
          </div>
          <RecorderControls />
        </section>

        {/* 4. System Actions */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-3 bg-amber-500/50 rounded-full" />
            <h2 className="text-xs font-bold text-text-secondary uppercase">
              Maintenance
            </h2>
          </div>
          <SystemCommands />
        </section>
      </div>
    </div>
  );
}
