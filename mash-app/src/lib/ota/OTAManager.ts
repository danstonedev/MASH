/**
 * OTAManager.ts - Over-The-Air Firmware Update Utilities
 *
 * Provides shared utilities for firmware updates:
 * - File loading and chunking
 * - Hash calculation
 * - Progress/callback types
 *
 * Actual OTA transfer is handled by WiFiOTAManager (HTTP upload to gateway).
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
 * Splits firmware binary into chunks for transfer
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
