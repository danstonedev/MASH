/**
 * WiFiOTAManager.ts - WiFi-based OTA Firmware Update Manager
 *
 * Handles fast WiFi-based OTA updates via HTTP POST to the Gateway's web server.
 * Much faster than BLE OTA (100-500 KB/s vs 1-5 KB/s).
 */

export interface WiFiOTAProgress {
  phase: "uploading" | "complete" | "error";
  percent: number;
  message: string;
}

/**
 * Perform a WiFi OTA firmware update
 *
 * @param ipAddress The Gateway's IP address (e.g., "192.168.1.100")
 * @param firmware The firmware binary as ArrayBuffer
 * @param onProgress Progress callback
 * @returns Promise that resolves when complete
 */
export async function performWiFiOTA(
  ipAddress: string,
  firmware: ArrayBuffer,
  onProgress?: (progress: WiFiOTAProgress) => void,
): Promise<void> {
  console.debug(
    `[WiFi-OTA] Starting upload to ${ipAddress}, size: ${firmware.byteLength}`,
  );

  onProgress?.({
    phase: "uploading",
    percent: 0,
    message: "Preparing upload...",
  });

  // Create form data with firmware file
  const formData = new FormData();
  const blob = new Blob([firmware], { type: "application/octet-stream" });
  formData.append("firmware", blob, "firmware.bin");

  try {
    // Use XMLHttpRequest for upload progress tracking
    const result = await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `http://${ipAddress}/ota`, true);

      // Track upload progress
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          const speed = (
            (e.loaded / 1024 / (Date.now() - startTime)) *
            1000
          ).toFixed(1);
          onProgress?.({
            phase: "uploading",
            percent,
            message: `Uploading... ${percent}% (${speed} KB/s)`,
          });
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          onProgress?.({
            phase: "complete",
            percent: 100,
            message: "Update complete! Device is rebooting...",
          });
          resolve();
        } else {
          reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
        }
      };

      xhr.onerror = () => {
        reject(new Error("Network error during upload"));
      };

      xhr.ontimeout = () => {
        reject(new Error("Upload timed out"));
      };

      // 5 minute timeout for upload
      xhr.timeout = 300000;

      const startTime = Date.now();
      xhr.send(formData);
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[WiFi-OTA] Error:", message);

    onProgress?.({
      phase: "error",
      percent: 0,
      message: `Error: ${message}`,
    });

    throw err;
  }
}

/**
 * Check if the OTA server is reachable
 *
 * @param ipAddress The Gateway's IP address
 * @returns Device info if reachable
 */
export async function checkOTAServer(ipAddress: string): Promise<{
  version: string;
  freeHeap: number;
  reachable: boolean;
}> {
  try {
    const response = await fetch(`http://${ipAddress}/info`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      return {
        version: data.version || "unknown",
        freeHeap: data.freeHeap || 0,
        reachable: true,
      };
    }

    return { version: "unknown", freeHeap: 0, reachable: false };
  } catch {
    return { version: "unknown", freeHeap: 0, reachable: false };
  }
}
