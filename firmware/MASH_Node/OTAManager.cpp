/*******************************************************************************
 * OTAManager.cpp - Over-the-Air Firmware Update Implementation (Node Version)
 *
 * Handles ESP-NOW based OTA receiving and flash writing.
 ******************************************************************************/

#include "OTAManager.h"

// Timeout for OTA in milliseconds (5 minutes)
#define NODE_OTA_TIMEOUT_MS 300000

OTAManager::OTAManager()
    : state(OTA_IDLE), lastError(OTA_ERR_NONE), nodeId(0), totalSize(0),
      bytesReceived(0), expectedOffset(0), lastActivityTime(0),
      progressCallback(nullptr), errorCallback(nullptr),
      completeCallback(nullptr) {
  memset(expectedMD5, 0, sizeof(expectedMD5));
}

void OTAManager::reset() {
  state = OTA_IDLE;
  lastError = OTA_ERR_NONE;
  totalSize = 0;
  bytesReceived = 0;
  expectedOffset = 0;
  lastActivityTime = 0;
  memset(expectedMD5, 0, sizeof(expectedMD5));
}

void OTAManager::setError(OTAError error) {
  lastError = error;
  state = OTA_ERROR;
  Serial.printf("[Node OTA] Error: %d\n", error);

  if (errorCallback) {
    errorCallback(error);
  }

  Update.abort();
}

ESPNowOTAAckPacket OTAManager::createAck(uint8_t status) {
  ESPNowOTAAckPacket ack;
  ack.type = OTA_PACKET_ACK;
  ack.nodeId = nodeId;
  ack.status = status;
  ack.lastOffset = (uint16_t)(bytesReceived / 240); // Chunk index
  ack.progress = getProgress();
  return ack;
}

bool OTAManager::handleBegin(const ESPNowOTABeginPacket &packet) {
  Serial.printf("[Node OTA] Begin received: size=%u, version=%s\n",
                packet.totalSize, packet.version);

  // Reset state
  reset();

  // Store expected values
  totalSize = packet.totalSize;
  strncpy(expectedMD5, packet.md5, 32);
  expectedMD5[32] = '\0';

  // Initialize MD5 calculation
  md5.begin();

  // Start the ESP32 Update process
  if (!Update.begin(totalSize, U_FLASH)) {
    Serial.printf("[Node OTA] Update.begin failed: %s\n", Update.errorString());
    setError(OTA_ERR_BEGIN_FAILED);
    return false;
  }

  if (strlen(expectedMD5) == 32) {
    Update.setMD5(expectedMD5);
  }

  state = OTA_RECEIVING;
  lastActivityTime = millis();
  bytesReceived = 0;
  expectedOffset = 0;

  Serial.println("[Node OTA] Update session started");
  return true;
}

ESPNowOTAAckPacket OTAManager::handleData(const ESPNowOTADataPacket &packet) {
  if (state != OTA_RECEIVING) {
    Serial.println("[Node OTA] Data received but not in receiving state");
    return createAck(2); // Busy/wrong state
  }

  // Check for timeout
  if (millis() - lastActivityTime > NODE_OTA_TIMEOUT_MS) {
    setError(OTA_ERR_TIMEOUT);
    return createAck(1); // Error
  }

  // Check sequence (allow some flexibility for retransmissions)
  if (packet.offset != bytesReceived) {
    if (packet.offset < bytesReceived) {
      // Duplicate packet, already received - just ACK
      Serial.printf("[Node OTA] Duplicate chunk at offset %u (have %u)\n",
                    packet.offset, bytesReceived);
      return createAck(0);
    } else {
      // Gap in sequence
      Serial.printf("[Node OTA] Sequence error: expected %u, got %u\n",
                    bytesReceived, packet.offset);
      setError(OTA_ERR_SEQUENCE_ERROR);
      return createAck(1);
    }
  }

  // Write to flash
  size_t written = Update.write((uint8_t *)packet.data, packet.length);
  if (written != packet.length) {
    Serial.printf("[Node OTA] Write failed: %s\n", Update.errorString());
    setError(OTA_ERR_WRITE_FAILED);
    return createAck(1);
  }

  // Update MD5
  md5.add((uint8_t *)packet.data, packet.length);

  bytesReceived += written;
  lastActivityTime = millis();

  // Report progress
  uint8_t progress = getProgress();
  if (progressCallback) {
    progressCallback(progress);
  }

  // Log progress every 10%
  static uint8_t lastLoggedProgress = 0;
  if (progress >= lastLoggedProgress + 10) {
    Serial.printf("[Node OTA] Progress: %u%% (%u/%u)\n", progress,
                  bytesReceived, totalSize);
    lastLoggedProgress = progress;
  }

  return createAck(0); // Success
}

bool OTAManager::handleEnd(const ESPNowOTAEndPacket &packet) {
  if (state != OTA_RECEIVING) {
    Serial.println("[Node OTA] End received but not in receiving state");
    return false;
  }

  state = OTA_VERIFYING;

  // Finalize MD5
  md5.calculate();
  String calculatedMD5 = md5.toString();
  Serial.printf("[Node OTA] Calculated MD5: %s\n", calculatedMD5.c_str());

  // Verify MD5
  if (strlen(expectedMD5) == 32) {
    if (!calculatedMD5.equalsIgnoreCase(expectedMD5)) {
      setError(OTA_ERR_MD5_MISMATCH);
      return false;
    }
    Serial.println("[Node OTA] MD5 verification passed");
  }

  // Finalize the update
  if (!Update.end(true)) {
    Serial.printf("[Node OTA] Update.end failed: %s\n", Update.errorString());
    setError(OTA_ERR_END_FAILED);
    return false;
  }

  state = OTA_COMPLETE;
  Serial.printf("[Node OTA] Update complete! %u bytes\n", bytesReceived);

  if (completeCallback) {
    completeCallback();
  }

  return true;
}

void OTAManager::handleAbort() {
  Serial.println("[Node OTA] Abort received");
  Update.abort();
  setError(OTA_ERR_ABORTED);
  reset();
}

void OTAManager::checkTimeout() {
  if (state == OTA_RECEIVING) {
    if (millis() - lastActivityTime > NODE_OTA_TIMEOUT_MS) {
      Serial.println("[Node OTA] Timeout - aborting");
      setError(OTA_ERR_TIMEOUT);
      reset();
    }
  }
}

void OTAManager::reboot() {
  if (state == OTA_COMPLETE) {
    Serial.println("[Node OTA] Rebooting to apply update...");
    delay(1000);
    ESP.restart();
  }
}

uint8_t OTAManager::getProgress() const {
  if (totalSize == 0)
    return 0;
  return (uint8_t)((bytesReceived * 100) / totalSize);
}
