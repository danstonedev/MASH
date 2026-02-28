/*******************************************************************************
 * OTAManager.cpp - Over-the-Air Firmware Update Implementation
 *
 * Handles chunked BLE OTA with MD5 verification and ESP32 Update library.
 ******************************************************************************/

// IMPORTANT: Define DEVICE_ROLE before including Config.h
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include "OTAManager.h"

OTAManager::OTAManager()
    : state(OTA_IDLE), lastError(OTA_ERR_NONE), totalSize(0), bytesReceived(0),
      lastActivityTime(0), progressCallback(nullptr), errorCallback(nullptr),
      completeCallback(nullptr)
{
  memset(expectedMD5, 0, sizeof(expectedMD5));
}

void OTAManager::reset()
{
  state = OTA_IDLE;
  lastError = OTA_ERR_NONE;
  totalSize = 0;
  bytesReceived = 0;
  lastActivityTime = 0;
  memset(expectedMD5, 0, sizeof(expectedMD5));
}

void OTAManager::setError(OTAError error, const char *message)
{
  lastError = error;
  state = OTA_ERROR;
  SAFE_LOG("[OTA] Error %d: %s\n", error, message);

  if (errorCallback)
  {
    errorCallback(error, message);
  }

  // Abort any in-progress update
  Update.abort();
}

bool OTAManager::begin(uint32_t size, const char *expectedHash)
{
  SAFE_LOG("[OTA] Starting update, size: %u bytes\n", size);

  // Clean up any previous failed update
  if (Update.isRunning())
  {
    SAFE_PRINTLN("[OTA] Aborting previous update session");
    Update.abort();
  }

  // Reset state
  reset();

  // Store expected values
  totalSize = size;
  if (expectedHash && strlen(expectedHash) == 32)
  {
    strncpy(expectedMD5, expectedHash, 32);
    expectedMD5[32] = '\0';
    SAFE_LOG("[OTA] Expected MD5: %s\n", expectedMD5);
  }

  // Initialize MD5 calculation
  this->md5.begin();

  // Start the ESP32 Update process
  if (!Update.begin(size, U_FLASH))
  {
    SAFE_LOG("[OTA] Update.begin failed: %s\n", Update.errorString());
    setError(OTA_ERR_BEGIN_FAILED, Update.errorString());
    return false;
  }

  // Set MD5 for verification if provided
  if (strlen(expectedMD5) == 32)
  {
    Update.setMD5(expectedMD5);
  }

  state = OTA_RECEIVING;
  lastActivityTime = millis();
  bytesReceived = 0;

  SAFE_PRINTLN("[OTA] Update session started");
  return true;
}

int OTAManager::writeChunk(const uint8_t *data, size_t len)
{
  if (state != OTA_RECEIVING)
  {
    SAFE_PRINTLN("[OTA] Error: Not in receiving state");
    return -1;
  }

  // Check timeout
  if (millis() - lastActivityTime > OTA_TIMEOUT_MS)
  {
    setError(OTA_ERR_TIMEOUT, "OTA transfer timed out");
    return -1;
  }

  // Write to flash
  size_t written = Update.write((uint8_t *)data, len);
  if (written != len)
  {
    setError(OTA_ERR_WRITE_FAILED, Update.errorString());
    return -1;
  }

  // Update MD5 calculation
  this->md5.add((uint8_t *)data, len);

  bytesReceived += written;
  lastActivityTime = millis();

  // Report progress
  if (progressCallback)
  {
    progressCallback(bytesReceived, totalSize);
  }

  // Log progress every 10%
  static uint8_t lastPercent = 0;
  uint8_t percent = (bytesReceived * 100) / totalSize;
  if (percent >= lastPercent + 10)
  {
    SAFE_LOG("[OTA] Progress: %u%% (%u/%u bytes)\n", percent,
             bytesReceived, totalSize);
    lastPercent = percent;
  }

  return written;
}

bool OTAManager::end()
{
  if (state != OTA_RECEIVING)
  {
    SAFE_PRINTLN("[OTA] Error: Not in receiving state");
    return false;
  }

  state = OTA_VERIFYING;

  // Finalize MD5
  this->md5.calculate();
  String calculatedMD5 = this->md5.toString();
  SAFE_LOG("[OTA] Calculated MD5: %s\n", calculatedMD5.c_str());

  // Verify MD5 if we had an expected value
  if (strlen(expectedMD5) == 32)
  {
    if (!calculatedMD5.equalsIgnoreCase(expectedMD5))
    {
      setError(OTA_ERR_MD5_MISMATCH, "MD5 checksum mismatch");
      return false;
    }
    SAFE_PRINTLN("[OTA] MD5 verification passed");
  }

  // Finalize the update
  if (!Update.end(true))
  {
    setError(OTA_ERR_END_FAILED, Update.errorString());
    return false;
  }

  state = OTA_COMPLETE;
  SAFE_LOG("[OTA] Update complete! Received %u bytes\n", bytesReceived);

  if (completeCallback)
  {
    completeCallback();
  }

  return true;
}

void OTAManager::abort()
{
  SAFE_PRINTLN("[OTA] Update aborted by user");
  Update.abort();
  setError(OTA_ERR_ABORTED, "Update aborted by user");
  reset();
}

void OTAManager::reboot()
{
  if (state == OTA_COMPLETE)
  {
    SAFE_PRINTLN("[OTA] Rebooting to apply update...");
    delay(1000);
    ESP.restart();
  }
  else
  {
    SAFE_PRINTLN("[OTA] Cannot reboot - update not complete");
  }
}

float OTAManager::getProgress() const
{
  if (totalSize == 0)
    return 0.0f;
  return (float)bytesReceived / (float)totalSize;
}
