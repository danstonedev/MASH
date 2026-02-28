/**
 * Settings Panel (Refactored)
 * ===========================
 *
 * Streamlined settings using extracted card components.
 */

import { useState } from "react";
import {
  Settings,
  Cpu,
  BarChart2,
  ChevronDown,
  ChevronRight,
  Network,
} from "lucide-react";
import { useDeviceStore } from "../../../store/useDeviceStore";
import { ConnectionSettingsCard } from "../../settings/ConnectionSettingsCard";
import { FirmwareUpdateCard } from "../../settings/FirmwareUpdateCard";
import { QualityMetricsCard } from "../../ui/QualityMetricsCard";
// NetworkTopology component removed — file no longer exists.
// TODO: Re-add when bluetooth/NetworkTopology.tsx is restored.

import { useDeviceRegistry } from "../../../store/useDeviceRegistry";

export function SettingsPanel() {
  const { isConnected } = useDeviceStore();
  const { zuptThreshold, setZuptThreshold } = useDeviceRegistry();
  const [topologyExpanded, setTopologyExpanded] = useState(false);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-white">Settings</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Connection Settings */}
        <ConnectionSettingsCard />

        {/* Network Topology - Collapsible */}
        {isConnected && (
          <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
            <button
              onClick={() => setTopologyExpanded(!topologyExpanded)}
              className="w-full flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <Network className="h-4 w-4 text-text-secondary" />
                <span className="text-xs font-semibold text-text-secondary uppercase">
                  Network Topology
                </span>
              </div>
              {topologyExpanded ? (
                <ChevronDown className="h-4 w-4 text-text-secondary" />
              ) : (
                <ChevronRight className="h-4 w-4 text-text-secondary" />
              )}
            </button>
            {topologyExpanded && (
              <div className="text-xs text-text-secondary italic">
                Network topology view unavailable
              </div>
            )}
          </div>
        )}

        {/* Data Quality Metrics */}
        {isConnected && (
          <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
            <div className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-text-secondary" />
              <span className="text-xs font-semibold text-text-secondary uppercase">
                Data Quality
              </span>
            </div>
            <QualityMetricsCard />
          </div>
        )}

        {/* Calibration section removed - now unified in DevicePanel Quick Start */}

        {/* Sensor Alignment and Device Provisioning removed - not needed if calibration works */}

        {/* Firmware Params (Compact) */}
        {isConnected && (
          <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-text-secondary" />
              <span className="text-xs font-semibold text-text-secondary uppercase">
                Firmware Params
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-text-primary">Output Mode</span>
              <div className="flex bg-bg-primary rounded p-0.5 border border-border">
                <button
                  onClick={() => {
                    import("../../../lib/connection/ConnectionManager").then(
                      ({ connectionManager }) => {
                        connectionManager.sendCommand("SET_OUTPUT_MODE", {
                          mode: "raw",
                        });
                      },
                    );
                  }}
                  className="px-2 py-1 text-[10px] hover:bg-white/5 rounded text-text-secondary"
                >
                  RAW
                </button>
                <button
                  onClick={() => {
                    import("../../../lib/connection/ConnectionManager").then(
                      ({ connectionManager }) => {
                        connectionManager.sendCommand("SET_OUTPUT_MODE", {
                          mode: "quaternion",
                        });
                      },
                    );
                  }}
                  className="px-2 py-1 text-[10px] bg-accent text-white rounded shadow-sm"
                >
                  QUAT
                </button>
              </div>
            </div>

            {/* Sport Mode - Sample Rate Selector */}
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-xs text-text-primary">Sample Rate</span>
                <span className="text-[9px] text-text-secondary">
                  200Hz for sports
                </span>
              </div>
              <div className="flex bg-bg-primary rounded p-0.5 border border-border">
                <button
                  onClick={() => {
                    import("../../../lib/connection/ConnectionManager").then(
                      ({ connectionManager }) => {
                        connectionManager.sendCommand("SET_RATE", { rate: 60 });
                      },
                    );
                  }}
                  className="px-2 py-1 text-[10px] hover:bg-white/5 rounded text-text-secondary"
                  title="Low power (60Hz)"
                >
                  60
                </button>
                <button
                  onClick={() => {
                    import("../../../lib/connection/ConnectionManager").then(
                      ({ connectionManager }) => {
                        connectionManager.sendCommand("SET_RATE", {
                          rate: 100,
                        });
                      },
                    );
                  }}
                  className="px-2 py-1 text-[10px] hover:bg-white/5 rounded text-text-secondary"
                  title="Standard (100Hz)"
                >
                  100
                </button>
                <button
                  onClick={() => {
                    import("../../../lib/connection/ConnectionManager").then(
                      ({ connectionManager }) => {
                        connectionManager.sendCommand("SET_RATE", {
                          rate: 200,
                        });
                      },
                    );
                  }}
                  className="px-2 py-1 text-[10px] bg-accent text-white rounded shadow-sm"
                  title="Sport Mode (200Hz)"
                >
                  200 ⚡
                </button>
              </div>
            </div>

            {/* Fusion Mode removed - 9-DOF not implemented in firmware yet */}

            <div className="space-y-1">
              <div className="flex justify-between text-xs text-text-secondary">
                <label htmlFor="filter-beta-slider">Filter Beta</label>
                <span className="font-mono">0.1</span>
              </div>
              <input
                id="filter-beta-slider"
                type="range"
                min="0.01"
                max="1.0"
                step="0.05"
                defaultValue="0.1"
                aria-label="Filter Beta"
                className="w-full h-1 bg-bg-primary rounded-lg appearance-none cursor-pointer"
                onChange={(e) => {
                  const beta = parseFloat(e.target.value);
                  import("../../../lib/connection/ConnectionManager").then(
                    ({ connectionManager }) => {
                      connectionManager.sendCommand("SET_FILTER_BETA", {
                        beta,
                      });
                    },
                  );
                }}
              />
            </div>
          </div>
        )}

        {/* Firmware Update - Collapsible */}
        {isConnected && (
          <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <Cpu className="h-4 w-4 text-text-secondary" />
              <span className="text-xs font-semibold text-text-secondary uppercase">
                Firmware Update
              </span>
            </div>
            <FirmwareUpdateCard />
          </div>
        )}

        {/* Magnetometer Calibration - moved to DevicePanel (Connect tab) */}
      </div>

      {/* Pipeline Configuration */}
      {isConnected && (
        <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-text-secondary" />
            <span className="text-xs font-semibold text-text-secondary uppercase">
              Pipeline Config
            </span>
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-xs text-text-secondary">
              <label
                htmlFor="zupt-threshold-slider"
                title="Zero-Velocity Update Threshold"
              >
                Drift Correction (ZUPT)
              </label>
              <span className="font-mono">{zuptThreshold.toFixed(1)}°/s</span>
            </div>
            <input
              id="zupt-threshold-slider"
              type="range"
              min="0.0"
              max="5.0"
              step="0.1"
              value={zuptThreshold}
              aria-label="ZUPT Threshold"
              className="w-full h-1 bg-bg-primary rounded-lg appearance-none cursor-pointer"
              onChange={(e) => {
                setZuptThreshold(parseFloat(e.target.value));
                // Force re-render of settings panel logic if needed
              }}
            />
            <div className="text-[9px] text-text-secondary">
              Clamps drift when motion is below this threshold.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
