import { describe, it, expect } from "vitest";
import { ValidationDataParser } from "./ValidationDataParser";

describe("ValidationDataParser", () => {
  describe("parseXsensCSV", () => {
    it("skips malformed quaternion rows instead of emitting NaN quaternions", () => {
      const content = [
        "Metadata line",
        "PacketCounter,SampleTimeFine,Quat_W,Quat_X,Quat_Y,Quat_Z",
        "1,100,1,0,0,0",
        "2,101,1,0,NaN,0",
        "bad,102,1,0,0,0",
      ].join("\n");

      const parsed = ValidationDataParser.parseXsensCSV(content);

      expect(parsed.quats).toHaveLength(1);
      expect(parsed.packetCounters).toEqual([1]);
    });
  });

  describe("parseOpenSimStorage", () => {
    it("throws when required time column is missing", () => {
      const content = [
        "inDegrees=yes",
        "endheader",
        "pelvis_imu_q0 pelvis_imu_q1 pelvis_imu_q2 pelvis_imu_q3",
        "1 0 0 0",
      ].join("\n");

      expect(() =>
        ValidationDataParser.parseOpenSimStorage(content, "missing-time.sto"),
      ).toThrow(/Missing required 'time' column/);
    });

    it("parses quaternion inputs when time column is present", () => {
      const content = [
        "inDegrees=no",
        "endheader",
        "time pelvis_imu_q0 pelvis_imu_q1 pelvis_imu_q2 pelvis_imu_q3",
        "0.01 1 0 0 0",
      ].join("\n");

      const parsed = ValidationDataParser.parseOpenSimStorage(
        content,
        "pelvis.sto",
      );

      expect(parsed.frames).toHaveLength(1);
      const pelvis = parsed.frames[0].inputs["PELVIS"];
      expect(pelvis).toBeDefined();
      expect(pelvis?.x).toBe(0);
      expect(pelvis?.y).toBe(0);
      expect(pelvis?.z).toBe(0);
      expect(pelvis?.w).toBe(1);
    });
  });
});
