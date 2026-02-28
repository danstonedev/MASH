import { describe, expect, it } from "vitest";
import {
  EXPORT_PROGRESS_STAGE,
  formatExportStage,
  normalizeExportStage,
} from "./formatExportStage";

describe("formatExportStage", () => {
  it("maps known chunked JSON stages to friendly labels", () => {
    expect(formatExportStage("serialize-json-imu")).toBe(
      "Serializing IMU JSON",
    );
    expect(formatExportStage("serialize-json-env")).toBe(
      "Serializing environment JSON",
    );
  });

  it("normalizes stage aliases to canonical keys", () => {
    expect(normalizeExportStage(EXPORT_PROGRESS_STAGE.START)).toBe(
      EXPORT_PROGRESS_STAGE.STARTING,
    );
  });

  it("returns working label for empty stages", () => {
    expect(formatExportStage("")).toBe("Working");
    expect(formatExportStage(undefined)).toBe("Working");
  });

  it("title-cases unknown stage keys", () => {
    expect(formatExportStage("custom-stage_name")).toBe("Custom Stage Name");
  });
});
