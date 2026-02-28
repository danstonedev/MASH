import { describe, it, expect } from "vitest";
import type { RecordedFrame } from "../db/types";
import { buildC3DArtifact } from "./C3DExporter";
import { buildBVHArtifact } from "./BVHExporter";
import { buildOpenSimStoArtifact } from "./OpenSimExporter";

function frame(overrides: Partial<RecordedFrame> = {}): RecordedFrame {
  return {
    sessionId: "session-1",
    systemTime: 1000,
    timestamp: 0,
    sensorId: 1,
    frameNumber: 0,
    quaternion: [1, 0, 0, 0],
    accelerometer: [0, 0, 9.81],
    gyro: [0, 0, 0],
    battery: 95,
    segment: "pelvis",
    ...overrides,
  };
}

describe("Export artifact builders", () => {
  it("builds C3D artifact with binary payload", () => {
    const frames = [frame(), frame({ timestamp: 5, frameNumber: 1 })];

    const artifact = buildC3DArtifact(frames, {
      sessionName: "trial_a",
      frameRate: 200,
      includeAnalog: true,
    });

    expect(artifact.filename).toBe("trial_a.c3d");
    expect(artifact.mimeType).toBe("application/octet-stream");
    expect(artifact.content).toBeInstanceOf(ArrayBuffer);
    expect((artifact.content as ArrayBuffer).byteLength).toBeGreaterThan(0);
  });

  it("builds BVH artifact with text payload", () => {
    const frames = [frame(), frame({ timestamp: 5, frameNumber: 1 })];

    const artifact = buildBVHArtifact(frames, {
      sessionName: "trial_b",
      frameRate: 200,
    });

    expect(artifact.filename).toBe("trial_b.bvh");
    expect(artifact.mimeType).toBe("text/plain");
    expect(typeof artifact.content).toBe("string");
    expect(artifact.content).toContain("HIERARCHY");
    expect(artifact.content).toContain("MOTION");
  });

  it("builds OpenSim STO artifact", () => {
    const frames = [
      frame({ sensorId: 1, segment: "pelvis" }),
      frame({ sensorId: 1, segment: "pelvis", timestamp: 5, frameNumber: 1 }),
    ];

    const artifact = buildOpenSimStoArtifact(frames, {
      sessionName: "trial_c",
      dataRate: 200,
    });

    expect(artifact.filename).toBe("trial_c.sto");
    expect(artifact.mimeType).toBe("text/plain");
    expect(typeof artifact.content).toBe("string");
    expect(artifact.content).toContain("version=1");
    expect(artifact.content).toContain("endheader");
  });
});
