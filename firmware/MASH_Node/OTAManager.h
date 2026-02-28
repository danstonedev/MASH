/*******************************************************************************
 * OTAManager.h - Over-the-Air Firmware Update Manager (Node Version)
 *
 * Handles ESP-NOW based OTA firmware updates for Node devices.
 * Receives firmware chunks from Gateway and writes to OTA partition.
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
  OTA_VERIFYING, // Verifying checksum
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
  OTA_ERR_SEQUENCE_ERROR,
  OTA_ERR_ABORTED
};

// Callback types
typedef std::function<void(uint8_t progress)> OTAProgressCallback;
typedef std::function<void(OTAError error)> OTAErrorCallback;
typedef std::function<void()> OTACompleteCallback;
typedef std::function<void(const ESPNowOTAAckPacket &ack)> OTAAckCallback;

class OTAManager {
public:
  OTAManager();

  /**
   * Handle OTA Begin packet from Gateway
   * @param packet The begin packet with size and MD5
   * @return true if OTA session started successfully
   */
  bool handleBegin(const ESPNowOTABeginPacket &packet);

  /**
   * Handle OTA Data packet from Gateway
   * @param packet The data packet with firmware chunk
   * @return ACK packet to send back
   */
  ESPNowOTAAckPacket handleData(const ESPNowOTADataPacket &packet);

  /**
   * Handle OTA End packet from Gateway
   * @param packet The end packet with final MD5
   * @return true if verification passed
   */
  bool handleEnd(const ESPNowOTAEndPacket &packet);

  /**
   * Handle OTA Abort packet from Gateway
   */
  void handleAbort();

  /**
   * Check if OTA has timed out (call periodically)
   */
  void checkTimeout();

  /**
   * Reboot to apply the update
   */
  void reboot();

  // State queries
  OTAState getState() const { return state; }
  OTAError getLastError() const { return lastError; }
  uint8_t getProgress() const;
  bool isInProgress() const { return state == OTA_RECEIVING; }

  // Set node ID for ACK packets
  void setNodeId(uint8_t id) { nodeId = id; }

  // Callbacks
  void setProgressCallback(OTAProgressCallback cb) { progressCallback = cb; }
  void setErrorCallback(OTAErrorCallback cb) { errorCallback = cb; }
  void setCompleteCallback(OTACompleteCallback cb) { completeCallback = cb; }

private:
  OTAState state;
  OTAError lastError;
  uint8_t nodeId;

  uint32_t totalSize;
  uint32_t bytesReceived;
  uint32_t expectedOffset;
  uint32_t lastActivityTime;

  char expectedMD5[33];
  MD5Builder md5;

  OTAProgressCallback progressCallback;
  OTAErrorCallback errorCallback;
  OTACompleteCallback completeCallback;

  void setError(OTAError error);
  void reset();
  ESPNowOTAAckPacket createAck(uint8_t status);
};

#endif // OTA_MANAGER_H
