/**
 * BLEConnection — Stub implementation
 *
 * BLE connection support has been removed in favour of USB Serial (SerialConnection).
 * This stub satisfies the IConnection interface so ConnectionManager can still
 * reference it without breaking the build. All methods are no-ops.
 */

import type {
  ConnectionData,
  ConnectionStatus,
  IConnection,
} from "./IConnection";

export class BLEConnection implements IConnection {
  type = "ble" as const;
  status: ConnectionStatus = "disconnected";

  async connect(): Promise<void> {
    console.warn("BLEConnection: BLE support has been removed. Use Serial.");
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  onData(_callback: (data: ConnectionData) => void): void {
    // no-op
  }

  onStatus(_callback: (status: ConnectionStatus) => void): void {
    // no-op
  }

  async sendCommand(_cmd: string, _params?: unknown): Promise<void> {
    console.warn("BLEConnection: BLE support has been removed. Use Serial.");
  }

  getDeviceName(): string | undefined {
    return undefined;
  }
}
