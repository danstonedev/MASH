/**
 * Connection Settings Card
 * ========================
 *
 * Connection info display (USB Serial via Gateway).
 */

import { Usb } from "lucide-react";
import { useDeviceStore } from "../../store/useDeviceStore";

export function ConnectionSettingsCard() {
  const isConnected = useDeviceStore((state) => state.isConnected);

  return (
    <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
      <div className="flex items-center gap-2">
        <Usb className="h-4 w-4 text-accent" />
        <span className="text-xs font-semibold text-text-secondary uppercase">
          Connection
        </span>
      </div>

      <div className="flex items-center gap-2 p-2 rounded-lg ring-1 ring-border bg-bg-primary text-white text-sm font-medium">
        <Usb className="h-4 w-4 text-accent" />
        USB Serial
      </div>

      <p className="text-xs text-text-secondary">
        {isConnected
          ? "Connected to Gateway via USB Serial."
          : "Connect the Gateway via USB and choose the serial port when prompted."}
      </p>
    </div>
  );
}
