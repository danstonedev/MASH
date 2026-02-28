/**
 * Device Provisioning Card
 * ========================
 *
 * Component for renaming connected sensors.
 */

import { useState } from "react";
import { Edit2 } from "lucide-react";
import { useDeviceRegistry } from "../../store/useDeviceRegistry";
import { Button } from "../ui/Button";

// Device name presets removed - user enters custom name directly

export function DeviceProvisioningCard() {
  const devices = useDeviceRegistry((state) => state.devices);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [targetName, setTargetName] = useState<string>("");
  const [isRenaming, setIsRenaming] = useState(false);

  const connectedDevices = Array.from(devices.values()).filter(
    (d) => d.isConnected,
  );

  const handleRenameDevice = async () => {
    if (!selectedDeviceId || !targetName) return;
    setIsRenaming(true);
    try {
      const { connectionManager } =
        await import("../../lib/connection/ConnectionManager");
      await connectionManager.sendCommand("SET_NAME", { name: targetName });
      setTargetName("");
    } catch (e) {
      console.error("Rename failed", e);
    } finally {
      setIsRenaming(false);
    }
  };

  if (connectedDevices.length === 0) {
    return (
      <div className="p-3 bg-bg-elevated rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <Edit2 className="h-4 w-4 text-text-secondary" />
          <span className="text-xs font-semibold text-text-secondary uppercase">
            Device Provisioning
          </span>
        </div>
        <p className="text-[10px] text-text-tertiary italic">
          Connect a device to rename it.
        </p>
      </div>
    );
  }

  return (
    <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
      <div className="flex items-center gap-2">
        <Edit2 className="h-4 w-4 text-text-secondary" />
        <span className="text-xs font-semibold text-text-secondary uppercase">
          Device Provisioning
        </span>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-text-secondary">Select Device</label>
        <select
          className="w-full bg-bg-primary border border-border rounded px-2 py-1.5 text-xs"
          value={selectedDeviceId}
          onChange={(e) => {
            setSelectedDeviceId(e.target.value);
            const dev = devices.get(e.target.value);
            if (dev) setTargetName(dev.name);
          }}
        >
          <option value="" disabled>
            Select a sensor...
          </option>
          {connectedDevices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.id.slice(-4)})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-text-secondary">New Name</label>
        <input
          type="text"
          className="w-full bg-bg-primary border border-border rounded px-2 py-1.5 text-xs font-mono"
          placeholder="IMU-LeftArm"
          value={targetName}
          onChange={(e) => setTargetName(e.target.value)}
        />
      </div>

      <Button
        size="sm"
        variant="gradient"
        className="w-full"
        onClick={handleRenameDevice}
        disabled={!selectedDeviceId || !targetName || isRenaming}
      >
        {isRenaming ? "WRITING..." : "RENAME SENSOR"}
      </Button>
      <p className="text-[9px] text-text-tertiary text-center">
        Sensor will reboot after renaming.
      </p>
    </div>
  );
}
