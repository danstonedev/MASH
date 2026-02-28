/**
 * Connection Settings Card
 * ========================
 *
 * Connection mode selection (BLE or USB Serial).
 */

import { Bluetooth, Usb } from "lucide-react";
import { useDeviceStore } from "../../store/useDeviceStore";

export function ConnectionSettingsCard() {
  const connectionType = useDeviceStore((state) => state.connectionType);
  const setConnectionType = useDeviceStore((state) => state.setConnectionType);
  const isConnected = useDeviceStore((state) => state.isConnected);

  return (
    <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
      <div className="flex items-center gap-2">
        <Bluetooth className="h-4 w-4 text-accent" />
        <span className="text-xs font-semibold text-text-secondary uppercase">
          Connection
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setConnectionType("ble")}
          disabled={isConnected}
          className={`flex items-center gap-2 p-2 rounded-lg ring-1 ring-border text-sm font-medium transition ${
            connectionType === "ble"
              ? "bg-bg-primary text-white"
              : "bg-transparent text-text-secondary hover:text-white"
          } ${isConnected ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          <Bluetooth className="h-4 w-4 text-accent" />
          Bluetooth (BLE)
        </button>
        <button
          type="button"
          onClick={() => setConnectionType("serial")}
          disabled={isConnected}
          className={`flex items-center gap-2 p-2 rounded-lg ring-1 ring-border text-sm font-medium transition ${
            connectionType === "serial"
              ? "bg-bg-primary text-white"
              : "bg-transparent text-text-secondary hover:text-white"
          } ${isConnected ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          <Usb className="h-4 w-4 text-accent" />
          USB Serial
        </button>
      </div>

      <p className="text-xs text-text-secondary">
        {connectionType === "ble"
          ? "Connect to IMU sensors via Bluetooth. Ensure your device is powered on and in range."
          : "Connect the Gateway via USB and choose the serial port when prompted."}
      </p>
    </div>
  );
}
