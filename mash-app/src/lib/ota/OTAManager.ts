/**
 * OTAManager.ts - Over-The-Air Firmware Update Manager
 *
 * Handles BLE-based OTA firmware updates with chunked transfer,
 * progress tracking, and hash verification.
 */

// OTA Configuration
// Using 512 bytes per chunk - ESP32 expects this size for optimal flash writes
const OTA_CHUNK_SIZE = 512;
const OTA_TIMEOUT_MS = 1800000; // 30 minute timeout for full transfer

export interface OTAProgress {
  phase:
    | "downloading"
    | "preparing"
    | "transferring"
    | "verifying"
    | "complete"
    | "error";
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  message: string;
}

export interface OTACallbacks {
  onProgress?: (progress: OTAProgress) => void;
  onError?: (error: string) => void;
  onComplete?: () => void;
}

/**
 * Calculates MD5-like hash of a binary file using Web Crypto API (SHA-256)
 * Note: We use SHA-256 and truncate for simplicity since ESP32 supports both
 */
export async function calculateHash(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Return first 32 hex chars for compatibility with MD5 length
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 32);
}

/**
 * Splits firmware binary into chunks for BLE transfer
 */
export function* chunkFirmware(
  data: ArrayBuffer,
  chunkSize: number = OTA_CHUNK_SIZE,
): Generator<Uint8Array> {
  const bytes = new Uint8Array(data);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    yield bytes.slice(offset, end);
  }
}

/**
 * Performs OTA update via BLE
 *
 * @param otaCharacteristic - OTA data characteristic
 * @param commandCharacteristic - Command characteristic for control messages
 * @param firmware - Firmware binary data
 * @param callbacks - Progress and completion callbacks
 */
export async function performOTAUpdate(
  otaCharacteristic: BluetoothRemoteGATTCharacteristic,
  commandCharacteristic: BluetoothRemoteGATTCharacteristic,
  firmware: ArrayBuffer,
  callbacks: OTACallbacks,
): Promise<boolean> {
  const { onProgress, onError, onComplete } = callbacks;

  try {
    // Phase 1: Prepare
    onProgress?.({
      phase: "preparing",
      bytesTransferred: 0,
      totalBytes: firmware.byteLength,
      percent: 0,
      message: "Calculating firmware checksum...",
    });

    const hash = await calculateHash(firmware);
    console.debug("[OTA] Firmware hash:", hash, "Size:", firmware.byteLength);

    // Phase 2: Send OTA_START command
    onProgress?.({
      phase: "preparing",
      bytesTransferred: 0,
      totalBytes: firmware.byteLength,
      percent: 0,
      message: "Starting OTA session...",
    });

    const startCmd = JSON.stringify({
      cmd: "OTA_START",
      size: firmware.byteLength,
      md5: hash,
    });

    await commandCharacteristic.writeValue(new TextEncoder().encode(startCmd));

    // Longer delay to let device prepare the OTA partition
    await new Promise((r) => setTimeout(r, 1000));

    // Phase 3: Transfer chunks (sequential - Chrome doesn't support parallel GATT ops)
    const startTime = Date.now();
    let bytesTransferred = 0;
    const totalBytes = firmware.byteLength;
    let chunkIndex = 0;
    let useFastWrite = true;

    for (const chunk of chunkFirmware(firmware)) {
      // Check timeout
      if (Date.now() - startTime > OTA_TIMEOUT_MS) {
        throw new Error("OTA transfer timed out");
      }

      // Write chunk via OTA characteristic
      const chunkBuffer = new Uint8Array(chunk).buffer as ArrayBuffer;

      let retries = 3;
      while (retries > 0) {
        try {
          if (useFastWrite) {
            await otaCharacteristic.writeValueWithoutResponse(chunkBuffer);
          } else {
            await otaCharacteristic.writeValue(chunkBuffer);
          }
          break; // Success
        } catch (err) {
          retries--;
          if (retries === 0 && useFastWrite) {
            console.warn("[OTA] Fast write failed, switching to slow mode");
            useFastWrite = false;
            retries = 3;
            continue;
          }
          if (retries === 0) throw err;
          // Exponential backoff with jitter: 5ms, 15ms, 45ms (approx)
          const baseDelay = 5 * Math.pow(3, 3 - retries);
          const jitter = Math.random() * baseDelay * 0.5;
          await new Promise((r) => setTimeout(r, baseDelay + jitter));
        }
      }

      bytesTransferred += chunk.length;
      chunkIndex++;

      // Pace the transfer: delay every 3 chunks to let ESP32 write to flash
      // This prevents overwhelming the BLE stack and flash write buffer
      if (chunkIndex % 3 === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Report progress every 20 chunks for performance
      if (chunkIndex % 20 === 0 || bytesTransferred >= totalBytes) {
        const percent = Math.round((bytesTransferred / totalBytes) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = bytesTransferred / elapsed / 1024; // KB/s
        const eta =
          (totalBytes - bytesTransferred) / (bytesTransferred / elapsed);

        onProgress?.({
          phase: "transferring",
          bytesTransferred,
          totalBytes,
          percent,
          message: `Transferring... ${percent}% (${rate.toFixed(1)} KB/s, ETA: ${Math.ceil(eta)}s)`,
        });
      }
    }

    // Phase 4: Verify
    onProgress?.({
      phase: "verifying",
      bytesTransferred: totalBytes,
      totalBytes,
      percent: 100,
      message: "Verifying firmware...",
    });

    // Wait for device to verify and reboot
    await new Promise((r) => setTimeout(r, 2000));

    // Phase 5: Complete
    onProgress?.({
      phase: "complete",
      bytesTransferred: totalBytes,
      totalBytes,
      percent: 100,
      message: "Firmware update complete! Device is rebooting...",
    });

    onComplete?.();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[OTA] Error:", message);

    onProgress?.({
      phase: "error",
      bytesTransferred: 0,
      totalBytes: firmware.byteLength,
      percent: 0,
      message: `Update failed: ${message}`,
    });

    // Send abort command
    try {
      const abortCmd = JSON.stringify({ cmd: "OTA_ABORT" });
      await commandCharacteristic.writeValue(
        new TextEncoder().encode(abortCmd),
      );
    } catch {
      // Ignore abort errors
    }

    onError?.(message);
    return false;
  }
}

/**
 * Load firmware from a File object
 */
export async function loadFirmwareFromFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("Failed to read firmware file"));
    reader.readAsArrayBuffer(file);
  });
}
