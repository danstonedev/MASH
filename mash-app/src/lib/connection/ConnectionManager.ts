import type {
  ConnectionData,
  IConnection,
  ConnectionStatus,
} from "./IConnection";
import { SerialConnection } from "./SerialConnection";

/**
 * Connection Manager
 *
 * Manages USB Serial connection to the Gateway hardware.
 * The Gateway communicates with sensor nodes via ESP-NOW WiFi protocol.
 */
export class ConnectionManager {
  activeConnection: IConnection;
  private serial: SerialConnection;

  constructor() {
    this.serial = new SerialConnection();
    this.activeConnection = this.serial;
  }

  // Proxies
  async connect(_type?: string, params?: unknown) {
    return this.activeConnection.connect(params);
  }

  async disconnect() {
    return this.activeConnection.disconnect();
  }

  async sendCommand(cmd: string, params?: unknown) {
    return this.activeConnection.sendCommand(cmd, params);
  }

  onData(cb: (data: ConnectionData) => void) {
    this.serial.onData(cb);
  }

  onStatus(cb: (status: ConnectionStatus) => void) {
    this.serial.onStatus(cb);
  }

  // Accessors
  getSerial() {
    return this.serial;
  }

  getActiveType(): "serial" {
    return "serial";
  }

  getDeviceName(): string | undefined {
    return this.activeConnection.getDeviceName?.();
  }
}

export const connectionManager = new ConnectionManager();
