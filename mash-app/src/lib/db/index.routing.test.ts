import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudDataManager,
  LocalDataManager,
  dataManager,
  setStorageMode,
} from "./index";

describe("dataManager storage routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("imu-connect-storage-mode");
  });

  it("routes createSession to LocalDataManager in local mode", async () => {
    setStorageMode("local");
    const localSpy = vi
      .spyOn(LocalDataManager.prototype, "createSession")
      .mockResolvedValue();
    const cloudSpy = vi
      .spyOn(CloudDataManager.prototype, "createSession")
      .mockResolvedValue();

    await dataManager.createSession({
      id: "s-local",
      name: "Local",
      startTime: Date.now(),
      sensorCount: 1,
    });

    expect(localSpy).toHaveBeenCalledTimes(1);
    expect(cloudSpy).not.toHaveBeenCalled();
  });

  it("routes createSession to CloudDataManager in cloud mode", async () => {
    setStorageMode("cloud");
    const localSpy = vi
      .spyOn(LocalDataManager.prototype, "createSession")
      .mockResolvedValue();
    const cloudSpy = vi
      .spyOn(CloudDataManager.prototype, "createSession")
      .mockResolvedValue();

    await dataManager.createSession({
      id: "s-cloud",
      name: "Cloud",
      startTime: Date.now(),
      sensorCount: 1,
    });

    expect(cloudSpy).toHaveBeenCalledTimes(1);
    expect(localSpy).not.toHaveBeenCalled();
  });
});

