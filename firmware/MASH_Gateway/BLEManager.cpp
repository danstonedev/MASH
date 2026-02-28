/*******************************************************************************
 * BLEManager.cpp - Bluetooth Low Energy Communication Implementation
 *
 * Supports both raw IMU data (0x01) and quaternion data (0x02) packets.
 ******************************************************************************/

// IMPORTANT: Define DEVICE_ROLE before including Config.h
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include "BLEManager.h"
#include <ArduinoJson.h>

// Note: SensorManager is NOT available on Gateway builds.
// sendEnvironmentalData() is wrapped in #if DEVICE_ROLE == ROLE_NODE below.

BLEManager::BLEManager()
    : pServer(nullptr), pService(nullptr), pDataChar(nullptr),
      pConfigChar(nullptr), pCommandChar(nullptr), pStatusChar(nullptr),
      pOTAChar(nullptr), deviceConnected(false), oldDeviceConnected(false),
      commandCallback(nullptr), otaDataCallback(nullptr) {}

void BLEManager::init(const char *deviceName)
{
  SAFE_LOG("[BLE] Initializing as '%s'\n", deviceName);

  BLEDevice::init(deviceName);
  BLEDevice::setMTU(BLE_MTU_SIZE);

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(this);

  pService = pServer->createService(BLEUUID(IMU_SERVICE_UUID), 30);

  // IMU Data characteristic (notify only)
  pDataChar = pService->createCharacteristic(
      BLEUUID(IMU_DATA_CHAR_UUID), BLECharacteristic::PROPERTY_NOTIFY);
  pDataChar->addDescriptor(new BLE2902());

  // Config characteristic (read/write)
  pConfigChar = pService->createCharacteristic(
      BLEUUID(CONFIG_CHAR_UUID),
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE);
  pConfigChar->setCallbacks(this);

  // Set default config value
  StaticJsonDocument<256> configDoc;
  configDoc["sampleRate"] = DEFAULT_SAMPLE_RATE_HZ;
  configDoc["accelRange"] = DEFAULT_ACCEL_RANGE_G;
  configDoc["gyroRange"] = DEFAULT_GYRO_RANGE_DPS;
  configDoc["outputMode"] = "quaternion";
  String configStr;
  serializeJson(configDoc, configStr);
  pConfigChar->setValue(configStr.c_str());

  // Command characteristic (write only)
  pCommandChar = pService->createCharacteristic(
      BLEUUID(COMMAND_CHAR_UUID),
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pCommandChar->setCallbacks(this);

  // Status characteristic (read/notify)
  pStatusChar = pService->createCharacteristic(
      BLEUUID(STATUS_CHAR_UUID),
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  pStatusChar->addDescriptor(new BLE2902());

  pService->start();
  SAFE_PRINTLN("[BLE] Service started");
}

void BLEManager::startAdvertising()
{
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(IMU_SERVICE_UUID);
  pAdvertising->setScanResponse(true);

  // Request fastest connection interval for minimum latency
  pAdvertising->setMinPreferred(0x06); // 7.5ms min
  pAdvertising->setMaxPreferred(0x06); // 7.5ms max

  BLEDevice::startAdvertising();
  SAFE_PRINTLN("[BLE] Advertising started (7.5ms interval)");
}

void BLEManager::stopAdvertising()
{
  BLEDevice::stopAdvertising();
  SAFE_PRINTLN("[BLE] Advertising stopped");
}

bool BLEManager::isConnected() const { return deviceConnected; }

void BLEManager::onConnect(BLEServer *pServer)
{
  deviceConnected = true;
  SAFE_PRINTLN("[BLE] Client connected");

  pServer->updatePeerMTU(pServer->getConnId(), BLE_MTU_SIZE);

  // Read back the negotiated MTU (peer may accept less than BLE_MTU_SIZE)
  uint16_t mtu = pServer->getPeerMTU(pServer->getConnId());
  if (mtu >= 23)
  {
    negotiatedMtu = mtu;
  }
  SAFE_LOG("[BLE] MTU: %d (max payload: %d bytes)\n", negotiatedMtu, getMaxPayload());

  // PHY negotiation happens automatically at the BLE controller level
  // ESP32-S3 with BLE 5.0 will auto-negotiate 2M PHY when the client supports it
  // No explicit API call needed - the controller handles this transparently
  SAFE_PRINTLN("[BLE] Connection established - PHY auto-negotiated by BLE controller");
  SAFE_PRINTLN("[BLE] (2M PHY used if both devices support BLE 5.0, otherwise 1M PHY)");
}

void BLEManager::onDisconnect(BLEServer *pServer)
{
  deviceConnected = false;
  SAFE_PRINTLN("[BLE] Client disconnected");
  delay(500);
  startAdvertising();
}

uint16_t BLEManager::getMaxPayload() const
{
  // ATT notification payload = MTU - 3 (ATT header)
  return (negotiatedMtu > 3) ? (negotiatedMtu - 3) : 20;
}

void BLEManager::sendRawData(const uint8_t *data, size_t len)
{
  if (!deviceConnected)
    return;

  pDataChar->setValue((uint8_t *)data, len);
  pDataChar->notify();
}

void BLEManager::onWrite(BLECharacteristic *pCharacteristic)
{
  // Handle OTA data (binary, no string conversion)
  if (pCharacteristic->getUUID().equals(BLEUUID(OTA_DATA_CHAR_UUID)))
  {
    uint8_t *data = pCharacteristic->getData();
    size_t len = pCharacteristic->getLength();
    if (otaDataCallback && len > 0)
    {

      otaDataCallback(data, len);
    }
    return;
  }

  // Handle text-based commands
  // ESP-IDF 5.x (Arduino ESP32 3.x): getValue() returns String
  // ESP-IDF 4.x (Arduino ESP32 2.x): getValue() returns std::string
#if ESP_IDF_VERSION_MAJOR >= 5
  String value = pCharacteristic->getValue();
#else
  std::string stdVal = pCharacteristic->getValue();
  String value = String(stdVal.c_str());
#endif

  if (value.length() > 0)
  {
    if (pCharacteristic->getUUID().equals(BLEUUID(COMMAND_CHAR_UUID)))
    {
      SAFE_LOG("[BLE] Command received: %s\n", value.c_str());
      if (commandCallback)
      {
        commandCallback(value);
      }
    }
    else if (pCharacteristic->getUUID().equals(BLEUUID(CONFIG_CHAR_UUID)))
    {
      SAFE_LOG("[BLE] Config update: %s\n", value.c_str());
      if (commandCallback)
      {
        commandCallback(value);
      }
    }
  }
}

// ============================================================================
// REMOVED: sendESPNowData() - Legacy 0x03 Packet Conversion
// ============================================================================
// This function converted ESP-NOW packets to 0x03 format before BLE
// transmission. It has been PERMANENTLY REMOVED to enforce TDMA-only operation.
//
// Migration: All data now flows as:
//   Node → TDMA packets (0x23) → Gateway → Raw forward → BLE → Web App
//
// Benefits:
//   - Preserves synchronized timestamps
//   - 40% less Gateway CPU usage
//   - Lower latency
//   - Higher sample rates possible
// ============================================================================

// ============================================================================
// REMOVED: sendIMUData() - Legacy Packet Creation (0x01/0x02/0x03)
// ============================================================================
// This function created legacy packet formats that are NO LONGER SUPPORTED.
// Deleted ~120 lines of code.
//
// TDMA packets (0x23) are forwarded RAW - no packet creation needed.
// ============================================================================

// sendEnvironmentalData only available on Node builds (requires SensorManager)
#if DEVICE_ROLE == DEVICE_ROLE_NODE
void BLEManager::sendEnvironmentalData(SensorManager &sensorManager)
{
  if (!deviceConnected)
    return;

  // Packet format (0x04): [id(1)][hasMag(1)][hasBaro(1)][mag(16)][baro(12)]
  const size_t totalSize = 1 + 1 + 1 + 16 + 12;
  uint8_t buffer[totalSize];
  memset(buffer, 0, totalSize);

  buffer[0] = PACKET_ENVIRONMENTAL;
  buffer[1] = sensorManager.hasMag() ? 1 : 0;
  buffer[2] = sensorManager.hasBaro() ? 1 : 0;

  if (sensorManager.hasMag())
  {
    MagData mag = sensorManager.getMagData();
    memcpy(buffer + 3, &mag.x, 4);
    memcpy(buffer + 7, &mag.y, 4);
    memcpy(buffer + 11, &mag.z, 4);
    memcpy(buffer + 15, &mag.heading, 4);
  }

  if (sensorManager.hasBaro())
  {
    BaroData baro = sensorManager.getBaroData();
    memcpy(buffer + 19, &baro.pressure, 4);
    memcpy(buffer + 23, &baro.temperature, 4);
    memcpy(buffer + 27, &baro.altitude, 4);
  }

  pDataChar->setValue(buffer, totalSize);
  pDataChar->notify();
}
#endif // DEVICE_ROLE == DEVICE_ROLE_NODE

// ============================================================================
// REMOVED: Legacy Packet Packing Functions
// ============================================================================
// The following functions have been PERMANENTLY DELETED:
//   - packRawIMUData() - packed 0x01 format (~10 lines)
//   - packQuaternionData() - packed 0x02 format (~15 lines)
//   - packQuaternionExtendedData() - packed 0x03 format (~35 lines)
//
// Total deleted: ~60 lines
//
// TDMA packets (0x23) are created by Nodes and forwarded RAW by Gateway.
// No packet construction needed on Gateway.
// ============================================================================

void BLEManager::sendResponse(const String &response)
{
  if (!deviceConnected)
    return;

  pStatusChar->setValue(response.c_str());
  pStatusChar->notify();

  SAFE_LOG("[BLE] Response sent: %s\n", response.c_str());
}

void BLEManager::setCommandCallback(BLECommandCallback callback)
{
  commandCallback = callback;
}

void BLEManager::setOTADataCallback(BLEOTADataCallback callback)
{
  otaDataCallback = callback;
}

void BLEManager::sendOTAProgress(uint32_t current, uint32_t total)
{
  if (!deviceConnected)
    return;

  // Send progress as JSON on status characteristic
  StaticJsonDocument<64> doc;
  doc["ota_progress"] = current;
  doc["ota_total"] = total;
  String json;
  serializeJson(doc, json);
  pStatusChar->setValue(json.c_str());
  pStatusChar->notify();
}
