/*******************************************************************************
 * BLEManager.h - Bluetooth Low Energy Communication
 *
 * Implements BLE GATT server for IMU data streaming and command reception.
 * Optimized for ESP32-S3 with Bluetooth 5.0 LE support.
 *
 * Packet Types:
 *   0x01 - Raw IMU data (accel + gyro floats)
 *   0x02 - Quaternion data (int16 scaled by 16384)
 *   0x03 - Extended quaternion (quaternion + accel + gyro int16)
 *****************************************************************************/

#ifndef BLE_MANAGER_H
#define BLE_MANAGER_H

#include "Config.h"
#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// Forward declarations
class SensorManager;
class OTAManager;

// ============================================================================
// PACKET TYPE DEFINITIONS - TDMA-Only System
// ============================================================================
// Legacy packet types (0x01, 0x02, 0x03) have been PERMANENTLY REMOVED.
// System now supports ONLY:
//   - 0x23: TDMA batched IMU data (primary)
//   - 0x04: Environmental data (mag/baro)
//   - 0x05: Magnetometer calibration progress
//   - 0x20-0x22: TDMA control packets (not forwarded to BLE)
// ============================================================================

#define PACKET_ENVIRONMENTAL 0x04
#define PACKET_OTA_DATA 0x20 // OTA firmware chunk

// Forward declarations
class SensorManager;
class OTAManager;

// Callback type for command processing
typedef std::function<void(const String &)> BLECommandCallback;
// Callback type for OTA data reception
typedef std::function<void(const uint8_t *, size_t)> BLEOTADataCallback;

class BLEManager : public BLEServerCallbacks,
                   public BLECharacteristicCallbacks
{
public:
  BLEManager();

  /**
   * Initialize BLE with device name
   * @param deviceName Name that appears in BLE scanning
   */
  void init(const char *deviceName);

  /**
   * Start BLE advertising
   */
  void startAdvertising();

  /**
   * Stop BLE advertising
   */
  void stopAdvertising();

  /**
   * Check if a client is connected
   */
  bool isConnected() const;

  /**
   * Get the max payload bytes per BLE notification (MTU - 3)
   * Falls back to 509 (MTU 512) if not yet negotiated.
   */
  uint16_t getMaxPayload() const;

  /**
   * Send raw byte array via data characteristic
   * @param data Pointer to data buffer
   * @param len Length of data
   */
  void sendRawData(const uint8_t *data, size_t len);
  // REMOVED: sendIMUData() - created legacy 0x01/0x02/0x03 packets (DELETED)

#if DEVICE_ROLE == DEVICE_ROLE_NODE
  /**
   * Send environmental data (mag/baro) via BLE notification
   * @param sensorManager Reference to sensor manager for data
   */
  void sendEnvironmentalData(SensorManager &sensorManager);
#endif

  /**
   * Send response message via status characteristic
   * @param response Response string (usually JSON)
   */
  void sendResponse(const String &response);

  /**
   * Set callback for processing commands from web app
   * @param callback Function to handle command strings
   */
  void setCommandCallback(BLECommandCallback callback);

  /**
   * Set callback for receiving OTA firmware data
   * @param callback Function to handle OTA data chunks
   */
  void setOTADataCallback(BLEOTADataCallback callback);

  /**
   * Send OTA progress notification
   * @param current Bytes received so far
   * @param total Total bytes expected
   */
  void sendOTAProgress(uint32_t current, uint32_t total);

  // BLEServerCallbacks overrides
  void onConnect(BLEServer *pServer) override;
  void onDisconnect(BLEServer *pServer) override;

  // BLECharacteristicCallbacks overrides
  void onWrite(BLECharacteristic *pCharacteristic) override;

private:
  BLEServer *pServer;
  BLEService *pService;
  BLECharacteristic *pDataChar;    // IMU data (notify)
  BLECharacteristic *pConfigChar;  // Configuration (read/write)
  BLECharacteristic *pCommandChar; // Commands (write)
  BLECharacteristic *pStatusChar;  // Status/responses (read/notify)
  BLECharacteristic *pOTAChar;     // OTA data (write no response)

  bool deviceConnected;
  bool oldDeviceConnected;
  uint16_t negotiatedMtu = BLE_MTU_SIZE; // Updated on connect
  BLECommandCallback commandCallback;
  BLEOTADataCallback otaDataCallback;

  // ========================================================================
  // REMOVED: Legacy packet packing methods (0x01/0x02/0x03)
  // ========================================================================
  // - packRawIMUData() - DELETED
  // - packQuaternionData() - DELETED
  // - packQuaternionExtendedData() - DELETED
  //
  // TDMA packets (0x23) are forwarded RAW via sendRawData()
  // ========================================================================
};

#endif // BLE_MANAGER_H
