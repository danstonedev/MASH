import type {
  ConnectionData,
  IConnection,
  ConnectionStatus,
} from "./IConnection";
import { BLEConnection } from "./BLEConnection";
import { SerialConnection } from "./SerialConnection";

export type ConnectionType = "ble" | "serial";

/**
 * Connection Manager
 *
 * Manages BLE and USB Serial connections to IMU hardware.
 * WiFi connection was removed as it only supported raw data streaming,
 * not fused quaternion orientation data.
 */
export class ConnectionManager {
  activeConnection: IConnection;
  private ble: BLEConnection;
  private serial: SerialConnection;
  private activeType: ConnectionType = "ble";

  constructor() {
    this.ble = new BLEConnection();
    this.serial = new SerialConnection();
    this.activeConnection = this.ble;
  }

  setActive(type: ConnectionType) {
    this.activeType = type;
    this.activeConnection = type === "serial" ? this.serial : this.ble;
  }

  // Proxies
  async connect(type: ConnectionType = this.activeType, params?: any) {
    this.setActive(type);
    return this.activeConnection.connect(params);
  }

  async disconnect() {
    return this.activeConnection.disconnect();
  }

  async sendCommand(cmd: string, params?: any) {
    return this.activeConnection.sendCommand(cmd, params);
  }

  onData(cb: (data: ConnectionData) => void) {
    this.ble.onData((data) => {
      if (this.activeType === "ble") cb(data);
    });
    this.serial.onData((data) => {
      if (this.activeType === "serial") cb(data);
    });
  }

  onStatus(cb: (status: ConnectionStatus) => void) {
    this.ble.onStatus((status) => {
      if (this.activeType === "ble") cb(status);
    });
    this.serial.onStatus((status) => {
      if (this.activeType === "serial") cb(status);
    });
  }

  // Accessors
  getBLE() {
    return this.ble;
  }

  getSerial() {
    return this.serial;
  }

  getActiveType(): ConnectionType {
    return this.activeType;
  }

  getDeviceName(): string | undefined {
    return this.activeConnection.getDeviceName?.();
  }
}

export const connectionManager = new ConnectionManager();
