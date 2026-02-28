import { useMemo } from "react";
import { RotateCcw, Compass, RefreshCw, ScanSearch } from "lucide-react";
import { useDeviceStore } from "../../store/useDeviceStore";
import { useDeviceRegistry } from "../../store/useDeviceRegistry";
import { useNetworkStore } from "../../store/useNetworkStore";
import { useSensorAssignmentStore } from "../../store/useSensorAssignmentStore";
import { resetAllStats } from "../../lib/connection/SyncedSampleStats";
import { getSensorDisplayName } from "../../lib/sensorDisplayName";

function extractSensorId(deviceId: string): number {
  if (deviceId.startsWith("sensor_")) {
    return parseInt(deviceId.substring(7), 10);
  }
  const lastUnderscore = deviceId.lastIndexOf("_");
  if (lastUnderscore >= 0) {
    return parseInt(deviceId.substring(lastUnderscore + 1), 10);
  }
  return parseInt(deviceId, 10);
}

export function SystemCommands() {
  const sendCommand = useDeviceStore((state) => state.sendCommand);
  const devices = useDeviceRegistry((state) => state.devices);
  const isConnected = useDeviceStore((state) => state.isConnected);
  const { nodes, getNodeForSensor, getNodeNameForSensor } = useNetworkStore();
  const getSegmentForSensor = useSensorAssignmentStore(
    (state) => state.getSegmentForSensor,
  );

  const canCalibrateMag = (sensorId: number) => {
    if (Number.isNaN(sensorId)) return false;
    const nodeId = getNodeForSensor(sensorId);
    const node = nodes.get(nodeId);
    return node?.hasMagnetometer ?? false;
  };

  const sensorRows = useMemo(() => {
    const idToDevice = new Map<number, { id: string; name: string }>();

    devices.forEach((device, id) => {
      const sensorId = extractSensorId(id);
      if (!Number.isFinite(sensorId)) return;
      idToDevice.set(sensorId, {
        id,
        name: device.name || getSensorDisplayName(sensorId),
      });
    });

    // Include topology-known sensors even if they haven't produced IMU data yet.
    nodes.forEach((node) => {
      const count =
        typeof node.sensorCount === "number" && node.sensorCount > 0
          ? node.sensorCount
          : node.sensors.size;
      if (!count || count <= 0) return;
      for (let i = 0; i < count; i++) {
        const sensorId = (node.id + i) % 256;
        if (!idToDevice.has(sensorId)) {
          const nodeName = getNodeNameForSensor(sensorId);
          idToDevice.set(sensorId, {
            id: `sensor_${sensorId}`,
            name: nodeName || getSensorDisplayName(sensorId),
          });
        }
      }
    });

    return Array.from(idToDevice.entries())
      .sort(([a], [b]) => a - b)
      .map(([sensorId, device]) => ({ sensorId, ...device }));
  }, [devices, nodes, getNodeNameForSensor]);

  const handleZeroGyros = () => {
    if (confirm("Keep all sensors STATIONARY for 2-3 seconds. Continue?")) {
      sendCommand("CALIBRATE_GYRO", { sensor: 0xff });
    }
  };

  const handleRescanNodes = () => {
    if (
      confirm(
        "This will clear all registered nodes and restart discovery. Continue?",
      )
    ) {
      sendCommand("TDMA_RESCAN");
    }
  };

  const handleResetStats = () => {
    resetAllStats();
  };

  return (
    <div className="flex flex-col gap-2 p-3 bg-bg-elevated border border-border rounded-lg">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
        System Controls
      </h3>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleZeroGyros}
          disabled={!isConnected}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-500 hover:bg-amber-500/20 disabled:opacity-50 text-xs font-medium transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Zero Gyros
        </button>

        <button
          onClick={handleRescanNodes}
          disabled={!isConnected}
          title="Wipe node table and restart TDMA discovery"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20 disabled:opacity-50 text-xs font-medium transition-colors"
        >
          <ScanSearch className="w-3.5 h-3.5" />
          Re-scan Nodes
        </button>

        <button
          onClick={handleResetStats}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 disabled:opacity-50 text-xs font-medium transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reset Stats
        </button>
      </div>

      {/* Per-Device Calibration */}
      {isConnected && (
        <div className="mt-2 space-y-1">
          <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-semibold">
            Per-Device
          </div>
          {sensorRows.map((row) => {
            const seg = getSegmentForSensor(row.id) || "Unassigned";
            const hasMag = canCalibrateMag(row.sensorId);
            return (
              <div
                key={row.id}
                className="flex items-center justify-between p-1.5 rounded bg-bg-surface/50 border border-border/50"
              >
                <div className="text-[10px]">
                  <span className="font-medium text-text-primary">
                    {row.name || row.id}
                  </span>
                  <span className="ml-1.5 text-text-tertiary">{seg}</span>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() =>
                      sendCommand("CALIBRATE_GYRO", {
                        sensor: row.sensorId,
                      })
                    }
                    title="Zero Gyro (Keep Still!)"
                    className="px-1.5 py-0.5 text-[9px] bg-bg-elevated border border-border rounded hover:bg-white/10 text-text-primary transition-colors"
                  >
                    Zero Gyro
                  </button>
                  {hasMag && (
                    <button
                      onClick={() =>
                        sendCommand("CALIBRATE_MAG", { duration: 15000 })
                      }
                      title="Calibrate Mag (Figure 8, 15s)"
                      className="px-1.5 py-0.5 text-[9px] bg-bg-elevated border border-border rounded hover:bg-white/10 text-text-primary transition-colors"
                    >
                      <Compass className="inline w-3 h-3 mr-0.5" />
                      Mag Cal
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="text-[10px] text-text-tertiary mt-1 text-center">
        * Zeroing stores bias in volatile memory. Lost on reboot.
      </div>
    </div>
  );
}
