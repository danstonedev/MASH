import * as THREE from "three";
import {
  transformSkeleton,
  createIdentityTareState,
} from "../lib/math/OrientationPipeline";
import type { TareState } from "../calibration/taringPipeline";

type SerializedJointTare = {
  flexion: number;
  abduction: number;
  rotation: number;
};

type SerializedTareState = {
  mountingTare: [number, number, number, number];
  headingTare: [number, number, number, number];
  frameAlignment?: [number, number, number, number];
  jointTare: SerializedJointTare;
  mountingTareTime: number;
  headingTareTime: number;
  frameAlignmentTime?: number;
  jointTareTime: number;
};

type KinematicsWorkerInput = {
  type: "process";
  requestId: number;
  sensorData: Array<[string, [number, number, number, number]]>;
  tareStates: Array<[string, SerializedTareState]>;
};

type KinematicsWorkerOutput =
  | {
      type: "result";
      requestId: number;
      segmentQuaternions: Array<[string, [number, number, number, number]]>;
    }
  | {
      type: "error";
      requestId: number;
      error: string;
    };

function toQuaternion(
  source: [number, number, number, number] | undefined,
): THREE.Quaternion {
  if (!source) return new THREE.Quaternion();
  const [w, x, y, z] = source;
  return new THREE.Quaternion(x, y, z, w);
}

function deserializeTareState(serialized: SerializedTareState): TareState {
  const base = createIdentityTareState();
  return {
    ...base,
    mountingTare: toQuaternion(serialized.mountingTare),
    headingTare: toQuaternion(serialized.headingTare),
    frameAlignment: serialized.frameAlignment
      ? toQuaternion(serialized.frameAlignment)
      : undefined,
    jointTare: serialized.jointTare,
    mountingTareTime: serialized.mountingTareTime,
    headingTareTime: serialized.headingTareTime,
    frameAlignmentTime: serialized.frameAlignmentTime,
    jointTareTime: serialized.jointTareTime,
  };
}

self.onmessage = (event: MessageEvent<KinematicsWorkerInput>) => {
  const { data } = event;
  if (data?.type !== "process") return;

  try {
    const sensorData = new Map(data.sensorData);
    const tareStates = new Map<string, TareState>(
      data.tareStates.map(([segmentId, tare]) => [
        segmentId,
        deserializeTareState(tare),
      ]),
    );

    const results = transformSkeleton(sensorData, tareStates);
    const segmentQuaternions: Array<
      [string, [number, number, number, number]]
    > = [];

    results.forEach((result, segmentId) => {
      const q = result.q_world;
      segmentQuaternions.push([segmentId, [q.w, q.x, q.y, q.z]]);
    });

    const output: KinematicsWorkerOutput = {
      type: "result",
      requestId: data.requestId,
      segmentQuaternions,
    };

    self.postMessage(output);
  } catch (error) {
    const output: KinematicsWorkerOutput = {
      type: "error",
      requestId: data.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(output);
  }
};
