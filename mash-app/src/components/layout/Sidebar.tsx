import { NavigationRail } from "./NavigationRail";
import { DevicePanel } from "./panels/DevicePanel";
import { AnalysisPanel } from "./panels/AnalysisPanel";

import { SettingsPanel } from "./panels/SettingsPanel";
import { ResearchPanelFull } from "./panels/ResearchPanel";
import { PlaybackPanel } from "./panels/PlaybackPanel";
import { AthletesPanel } from "./panels/AthletesPanel";
import { ExportPanel } from "./panels/ExportPanel";
import { GRFPanel } from "./panels/GRFPanel";
import { DebugPanel } from "./panels/DebugPanel";
import { useNavigationStore } from "../../store/useNavigationStore";

export function Sidebar() {
  const { activeTab, setActiveTab } = useNavigationStore();

  return (
    <div className="flex h-full min-h-0 border-r border-glass bg-liquid-dark">
      {/* Left Rail */}
      <NavigationRail activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Expandable Panel Area - 50% wider */}
      <div className="w-[27rem] bg-transparent flex flex-col h-full min-h-0">
        {activeTab === "connect" && <DevicePanel />}

        {activeTab === "playback" && <PlaybackPanel />}
        {activeTab === "athletes" && <AthletesPanel />}
        {activeTab === "analyze" && <AnalysisPanel />}
        {activeTab === "grf" && <GRFPanel />}
        {activeTab === "export" && <ExportPanel />}
        {activeTab === "research" && <ResearchPanelFull />}
        {activeTab === "debug" && <DebugPanel />}
        {activeTab === "settings" && <SettingsPanel />}
      </div>
    </div>
  );
}
