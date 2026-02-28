import type {
  EnvironmentalDataPacket,
  IMUDataPacket,
  JSONPacket,
  NodeInfoPacket,
} from "../ble/DeviceInterface";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type ConnectionData =
  | IMUDataPacket
  | IMUDataPacket[]
  | EnvironmentalDataPacket
  | NodeInfoPacket
  | JSONPacket;

export interface IConnection {
  type: "ble" | "serial";
  status: ConnectionStatus;

  connect(params?: any): Promise<void>;
  disconnect(): Promise<void>;

  // Callbacks
  onData(callback: (data: ConnectionData) => void): void;
  onStatus(callback: (status: ConnectionStatus) => void): void;

  // Commands
  sendCommand(cmd: string, params?: any): Promise<void>;

  getDeviceName?(): string | undefined;
}
