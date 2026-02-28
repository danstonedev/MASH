/*******************************************************************************
 * OTAManager.h - Over-the-Air Firmware Update Manager
 *
 * Handles BLE-based OTA firmware updates for the Gateway.
 * Supports chunked transfer with MD5 verification.
 ******************************************************************************/

#ifndef OTA_MANAGER_H
#define OTA_MANAGER_H

#include "Config.h"
#include <Arduino.h>
#include <MD5Builder.h>
#include <Update.h>


// OTA State Machine
enum OTAState {
  OTA_IDLE,      // Ready to receive OTA
  OTA_RECEIVING, // Currently receiving chunks
  OTA_VERIFYING, // Verifying MD5 checksum
  OTA_COMPLETE,  // Update complete, ready to reboot
  OTA_ERROR      // Error occurred
};

// OTA Error Codes
enum OTAError {
  OTA_ERR_NONE = 0,
  OTA_ERR_BEGIN_FAILED,
  OTA_ERR_WRITE_FAILED,
  OTA_ERR_END_FAILED,
  OTA_ERR_MD5_MISMATCH,
  OTA_ERR_TIMEOUT,
  OTA_ERR_LOW_BATTERY,
  OTA_ERR_ABORTED
};

// Callback types
typedef std::function<void(uint32_t current, uint32_t total)>
    OTAProgressCallback;
typedef std::function<void(OTAError error, const char *message)>
    OTAErrorCallback;
typedef std::function<void()> OTACompleteCallback;

class OTAManager {
public:
  OTAManager();

  /**
   * Start an OTA update session
   * @param totalSize Total firmware size in bytes
   * @param expectedMD5 Expected MD5 hash of the firmware (32 hex chars)
   * @return true if OTA session started successfully
   */
  bool begin(uint32_t totalSize, const char *expectedMD5 = nullptr);

  /**
   * Write a chunk of firmware data
   * @param data Pointer to chunk data
   * @param len Length of chunk
   * @return Number of bytes written, or -1 on error
   */
  int writeChunk(const uint8_t *data, size_t len);

  /**
   * Finalize the OTA update
   * @return true if update completed and verified successfully
   */
  bool end();

  /**
   * Abort the current OTA update
   */
  void abort();

  /**
   * Reboot to apply the update
   * Should be called after end() returns true
   */
  void reboot();

  // State queries
  OTAState getState() const { return state; }
  OTAError getLastError() const { return lastError; }
  uint32_t getBytesReceived() const { return bytesReceived; }
  uint32_t getTotalSize() const { return totalSize; }
  float getProgress() const;
  bool isInProgress() const { return state == OTA_RECEIVING; }

  // Callbacks
  void setProgressCallback(OTAProgressCallback cb) { progressCallback = cb; }
  void setErrorCallback(OTAErrorCallback cb) { errorCallback = cb; }
  void setCompleteCallback(OTACompleteCallback cb) { completeCallback = cb; }

  // Version info
  static const char *getFirmwareVersion() { return FIRMWARE_VERSION; }
  static uint8_t getVersionMajor() { return FIRMWARE_VERSION_MAJOR; }
  static uint8_t getVersionMinor() { return FIRMWARE_VERSION_MINOR; }
  static uint8_t getVersionPatch() { return FIRMWARE_VERSION_PATCH; }

private:
  OTAState state;
  OTAError lastError;

  uint32_t totalSize;
  uint32_t bytesReceived;
  uint32_t lastActivityTime;

  char expectedMD5[33]; // 32 hex chars + null
  MD5Builder md5;

  OTAProgressCallback progressCallback;
  OTAErrorCallback errorCallback;
  OTACompleteCallback completeCallback;

  void setError(OTAError error, const char *message);
  void reset();
};

#endif // OTA_MANAGER_H
