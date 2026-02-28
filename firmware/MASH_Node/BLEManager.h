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

// Packet type identifiers
#define PACKET_RAW_IMU 0x01
#define PACKET_QUATERNION 0x02
#define PACKET_QUATERNION_EXTENDED 0x03
#define PACKET_ENVIRONMENTAL 0x04

// Forward declaration
class SensorManager;

// Callback type for command processing
typedef std::function<void(const String &)> BLECommandCallback;

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
   * OPP-4: Check if BLE has been initialized
   * @return true if init() has been called
   */
  bool isInitialized() const;

  /**
   * OPP-4: Ensure BLE is initialized before use (lazy init pattern)
   * Calls init() if not already initialized. Returns false if no name was set.
   */
  bool ensureInitialized();

  /**
   * OPP-4: Set device name for deferred initialization
   * @param name Device name to use when init() is eventually called
   */
  void setDeviceName(const String &name) { _pendingDeviceName = name; }

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
   * Send raw byte array via data characteristic
   * @param data Pointer to data buffer
   * @param len Length of data
   */
  void sendRawData(const uint8_t *data, size_t len);

  /**
   * Send IMU data via BLE notification (raw or quaternion based on mode)
   * @param sensorManager Reference to sensor manager for data
   */
  void sendIMUData(SensorManager &sensorManager);

  /**
   * Send ESP-NOW packet via BLE notification (Gateway mode)
   * @param packet Data packet received via ESP-NOW
   */
  void sendESPNowData(const ESPNowDataPacket &packet);

  /**
   * Send environmental data (mag/baro) via BLE notification
   * @param sensorManager Reference to sensor manager for data
   */
  void sendEnvironmentalData(SensorManager &sensorManager);

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

  bool deviceConnected;
  bool oldDeviceConnected;
  BLECommandCallback commandCallback;

  // OPP-4: Lazy initialization state
  bool _initialized;         // True after init() has been called
  String _pendingDeviceName; // Stored name for deferred init

  /**
   * Pack raw IMU data (Packet 0x01)
   * Format: [packetId(1B)][count(1B)][sensorId(1B)][timestamp(4B)][accel
   * xyz(12B)][gyro xyz(12B)]
   */
  void packRawIMUData(uint8_t *buffer, const IMUData &data);

  /**
   * Pack quaternion data (Packet 0x02)
   * Format: [packetId(1B)][count(1B)][sensorId(1B)][w,x,y,z int16(8B)]
   */
  void packQuaternionData(uint8_t *buffer, uint8_t sensorId,
                          const Quaternion &q);

  /**
   * Pack extended quaternion data (Packet 0x03)
   * Format: [sensorId(1B)][quat int16(8B)][accel int16(6B)][gyro int16(6B)]
   */
  void packQuaternionExtendedData(uint8_t *buffer, uint8_t sensorId,
                                  const Quaternion &q, const IMUData &data);
};

#endif // BLE_MANAGER_H
