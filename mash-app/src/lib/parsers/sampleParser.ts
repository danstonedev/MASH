/**
 * Sample Parser types
 */

export interface SampleFrame {
  timestamp: number;
  sensorId?: string;
  quaternion?: [number, number, number, number];
  accelerometer?: [number, number, number];
  gyroscope?: [number, number, number];
  samples: SampleData[];
}

export interface SampleData {
  nodeId: number;
  sensorId?: string;
  timestamp: number;
  timestampUs: number;
  quaternion?: [number, number, number, number];
  accelerometer?: [number, number, number];
}
