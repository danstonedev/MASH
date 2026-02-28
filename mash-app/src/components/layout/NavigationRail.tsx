import {
  Bluetooth,
  BarChart3,
  Settings,
  FlaskConical,
  Layers,
  Users,
  Download,
  Activity,
  Bug,
} from "lucide-react";
import { cn } from "../../lib/utils";

export type SidebarTab =
  | "connect"
  | "xsens"
  | "capture"
  | "playback"
  | "athletes"
  | "analyze"
  | "grf"
  | "export"
  | "research"
  | "debug"
  | "settings";

interface NavigationRailProps {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
}

export function NavigationRail({
  activeTab,
  onTabChange,
}: NavigationRailProps) {
  const tabs = [
    { id: "connect", icon: Bluetooth, label: "Connect" },
    // { id: "xsens", icon: Bluetooth, label: "Xsens" },

    { id: "playback", icon: Layers, label: "Playback" },
    { id: "athletes", icon: Users, label: "Athletes" },
    { id: "analyze", icon: BarChart3, label: "Analyze" },
    // { id: "grf", icon: Activity, label: "GRF" },
    { id: "export", icon: Download, label: "Export" },
    { id: "research", icon: FlaskConical, label: "Research" },
    { id: "debug", icon: Bug, label: "Debug" },
    { id: "settings", icon: Settings, label: "Settings" },
  ] as const;

  return (
    <div className="w-20 glass-panel border-r border-glass flex flex-col items-center py-4 gap-2 z-20">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const Icon = tab.icon;

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            aria-label={`${tab.label} panel`}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative w-16 flex flex-col items-center justify-center gap-1 py-2 transition-all duration-300 group rounded-xl",
              isActive
                ? "bg-accent text-white shadow-[0_0_15px_rgba(0,154,68,0.6)] ring-1 ring-white/20"
                : "text-text-secondary hover:text-white hover:bg-white/10",
            )}
            title={tab.label}
          >
            <Icon
              strokeWidth={isActive ? 3 : 2}
              className={cn(
                "h-5 w-5 z-10 transition-transform duration-300",
                isActive ? "scale-100" : "group-hover:scale-110",
              )}
            />
            <span
              className={cn(
                "text-[9px] font-bold uppercase tracking-wide transition-colors",
                isActive
                  ? "text-white"
                  : "text-text-tertiary group-hover:text-white",
              )}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
