/*******************************************************************************
 * BLEManager.cpp - Bluetooth Low Energy Communication Implementation
 *
 * Supports both raw IMU data (0x01) and quaternion data (0x02) packets.
 ******************************************************************************/

#include "BLEManager.h"
#include "SensorManager.h"
#include <ArduinoJson.h>
#include <esp_idf_version.h>

static const Quaternion kIdentityQuat(1.0f, 0.0f, 0.0f, 0.0f);

BLEManager::BLEManager()
    : pServer(nullptr), pService(nullptr), pDataChar(nullptr),
      pConfigChar(nullptr), pCommandChar(nullptr), pStatusChar(nullptr),
      deviceConnected(false), oldDeviceConnected(false),
      commandCallback(nullptr), _initialized(false) {}

void BLEManager::init(const char *deviceName)
{
  if (_initialized)
  {
    Serial.println("[BLE] Already initialized, skipping");
    return;
  }

  Serial.printf("[BLE] Initializing as '%s'\n", deviceName);
  _pendingDeviceName = ""; // Clear pending since we're initializing now

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
  _initialized = true;
  Serial.println("[BLE] Service started");
}

// OPP-4: Check if BLE stack is initialized
bool BLEManager::isInitialized() const { return _initialized; }

// OPP-4: Lazy init — call init() with stored name if not yet initialized
bool BLEManager::ensureInitialized()
{
  if (_initialized)
    return true;
  if (_pendingDeviceName.length() == 0)
  {
    Serial.println("[BLE] Cannot lazy-init: no device name set. Call setDeviceName() first.");
    return false;
  }
  init(_pendingDeviceName.c_str());
  return _initialized;
}

void BLEManager::startAdvertising()
{
  if (!_initialized)
  {
    Serial.println("[BLE] startAdvertising() skipped — BLE not initialized (OPP-4 lazy init)");
    return;
  }
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(IMU_SERVICE_UUID);
  pAdvertising->setScanResponse(true);

  // Request fastest connection interval for minimum latency
  pAdvertising->setMinPreferred(0x06); // 7.5ms min
  pAdvertising->setMaxPreferred(0x06); // 7.5ms max

  BLEDevice::startAdvertising();
  Serial.println("[BLE] Advertising started (7.5ms interval)");
}

void BLEManager::stopAdvertising()
{
  if (!_initialized)
    return;
  BLEDevice::stopAdvertising();
  Serial.println("[BLE] Advertising stopped");
}

bool BLEManager::isConnected() const { return _initialized && deviceConnected; }

// Request larger MTU for high throughput
void BLEManager::onConnect(BLEServer *pServer)
{
  deviceConnected = true;
  Serial.println("[BLE] Client connected");
  pServer->updatePeerMTU(pServer->getConnId(), BLE_MTU_SIZE);
}

void BLEManager::onDisconnect(BLEServer *pServer)
{
  deviceConnected = false;
  Serial.println("[BLE] Client disconnected");
  // BUG 7 FIX: Removed 500ms delay() - it blocks the NimBLE task.
  // Short delay is sufficient for stack cleanup before re-advertising.
  delay(50);
  startAdvertising();
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
      Serial.printf("[BLE] Command received: %s\n", value.c_str());
      if (commandCallback)
      {
        commandCallback(value);
      }
    }
    else if (pCharacteristic->getUUID().equals(BLEUUID(CONFIG_CHAR_UUID)))
    {
      Serial.printf("[BLE] Config update: %s\n", value.c_str());
      if (commandCallback)
      {
        commandCallback(value);
      }
    }
  }
}

void BLEManager::sendESPNowData(const ESPNowDataPacket &packet)
{
  if (!deviceConnected)
    return;

  // Extended quaternion packet (0x03) structure matches CompressedSensorData
  // exactly [packetId(1)][count(1)][timestamp(4)][per sensor: id(1) + quat(8) +
  // accel(6) + gyro(6)]

  const size_t headerSize = 2 + 4;                        // Type(1) + Count(1) + Timestamp(4)
  const size_t sensorSize = sizeof(CompressedSensorData); // 21 bytes
  const uint8_t sensorCount =
      (packet.count > MAX_SENSORS) ? MAX_SENSORS : packet.count;
  size_t totalSize = headerSize + (sensorCount * sensorSize);

  // Optimization: specific stack buffer to avoid heap fragmentation
  uint8_t buffer[256];
  if (totalSize > 256)
    return; // Safety check

  // Header
  buffer[0] = PACKET_QUATERNION_EXTENDED; // 0x03
  buffer[1] = sensorCount;
  memcpy(buffer + 2, &packet.timestamp, 4);

  // Payload - direct copy as structs match packed layout
  memcpy(buffer + 6, packet.sensors, sensorCount * sensorSize);

  pDataChar->setValue(buffer, totalSize);
  pDataChar->notify();
}

void BLEManager::sendIMUData(SensorManager &sensorManager)
{
  if (!deviceConnected)
    return;

  uint8_t sensorCount = sensorManager.getSensorCount();
  if (sensorCount > MAX_SENSORS)
  {
    sensorCount = MAX_SENSORS;
  }
  OutputMode mode = sensorManager.getOutputMode();

  if (mode == OUTPUT_QUATERNION_EXTENDED)
  {
    // Extended quaternion packet (0x03): quaternion + accel + gyro + timestamp
    const size_t headerSize = 2 + 4; // 2 byte header + 4 byte timestamp
    const size_t sensorPacketSize = 21;
    size_t totalSize = headerSize + (sensorCount * sensorPacketSize);

    uint8_t buffer[256];
    if (totalSize > 256)
      return; // Safety check

    buffer[0] = PACKET_QUATERNION_EXTENDED;
    buffer[1] = sensorCount;

    // Use sensor timestamp (acquisition time) for better latency tracking
    uint32_t timestamp = sensorManager.getData(0).timestamp;
    memcpy(buffer + 2, &timestamp, 4);

    for (uint8_t i = 0; i < sensorCount; i++)
    {
      IMUData data = sensorManager.getData(i);
      // FIX: Use data.sensorId (actual sensor ID) not 'i' (loop index)
      packQuaternionExtendedData(buffer + headerSize + (i * sensorPacketSize),
                                 data.sensorId, kIdentityQuat, data);
    }

    pDataChar->setValue(buffer, totalSize);
    pDataChar->notify();
  }
  else if (mode == OUTPUT_QUATERNION)
  {
    // Quaternion packet (0x02): much smaller, 9 bytes per sensor
    const size_t headerSize = 2;
    const size_t sensorPacketSize = 9;
    size_t totalSize = headerSize + (sensorCount * sensorPacketSize);

    uint8_t buffer[128];
    if (totalSize > 128)
      return;

    buffer[0] = PACKET_QUATERNION;
    buffer[1] = sensorCount;

    for (uint8_t i = 0; i < sensorCount; i++)
    {
      IMUData data = sensorManager.getData(i);
      // FIX: Use data.sensorId (actual sensor ID) not 'i' (loop index)
      packQuaternionData(buffer + headerSize + (i * sensorPacketSize),
                         data.sensorId, kIdentityQuat);
    }

    pDataChar->setValue(buffer, totalSize);
    pDataChar->notify();
  }
  else
  {
    // Raw IMU packet (0x01): original format
    const size_t headerSize = 2;
    const size_t sensorPacketSize = 29;
    size_t totalSize = headerSize + (sensorCount * sensorPacketSize);

    uint8_t buffer[256];
    if (totalSize > 256)
      return;

    buffer[0] = PACKET_RAW_IMU;
    buffer[1] = sensorCount;

    for (uint8_t i = 0; i < sensorCount; i++)
    {
      IMUData data = sensorManager.getData(i);
      packRawIMUData(buffer + headerSize + (i * sensorPacketSize), data);
    }

    pDataChar->setValue(buffer, totalSize);
    pDataChar->notify();
  }
}

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

void BLEManager::packRawIMUData(uint8_t *buffer, const IMUData &data)
{
  buffer[0] = data.sensorId;
  memcpy(buffer + 1, &data.timestamp, 4);
  memcpy(buffer + 5, &data.accelX, 4);
  memcpy(buffer + 9, &data.accelY, 4);
  memcpy(buffer + 13, &data.accelZ, 4);
  memcpy(buffer + 17, &data.gyroX, 4);
  memcpy(buffer + 21, &data.gyroY, 4);
  memcpy(buffer + 25, &data.gyroZ, 4);
}

void BLEManager::packQuaternionData(uint8_t *buffer, uint8_t sensorId,
                                    const Quaternion &q)
{
  buffer[0] = sensorId;

  // Pack quaternion as int16 scaled by 16384
  int16_t w = q.wInt16();
  int16_t x = q.xInt16();
  int16_t y = q.yInt16();
  int16_t z = q.zInt16();

  memcpy(buffer + 1, &w, 2);
  memcpy(buffer + 3, &x, 2);
  memcpy(buffer + 5, &y, 2);
  memcpy(buffer + 7, &z, 2);
}

void BLEManager::packQuaternionExtendedData(uint8_t *buffer, uint8_t sensorId,
                                            const Quaternion &q,
                                            const IMUData &data)
{
  buffer[0] = sensorId;

  // Pack quaternion as int16 scaled by 16384
  int16_t qw = q.wInt16();
  int16_t qx = q.xInt16();
  int16_t qy = q.yInt16();
  int16_t qz = q.zInt16();

  memcpy(buffer + 1, &qw, 2);
  memcpy(buffer + 3, &qx, 2);
  memcpy(buffer + 5, &qy, 2);
  memcpy(buffer + 7, &qz, 2);

  // Pack accelerometer as int16 scaled by 100 (m/s² * 100)
  int16_t ax = (int16_t)(data.accelX * 100.0f);
  int16_t ay = (int16_t)(data.accelY * 100.0f);
  int16_t az = (int16_t)(data.accelZ * 100.0f);

  memcpy(buffer + 9, &ax, 2);
  memcpy(buffer + 11, &ay, 2);
  memcpy(buffer + 13, &az, 2);

  // Pack gyroscope as int16 scaled by 100 (rad/s * 100)
  int16_t gx = (int16_t)(data.gyroX * 100.0f);
  int16_t gy = (int16_t)(data.gyroY * 100.0f);
  int16_t gz = (int16_t)(data.gyroZ * 100.0f);

  memcpy(buffer + 15, &gx, 2);
  memcpy(buffer + 17, &gy, 2);
  memcpy(buffer + 19, &gz, 2);
}

void BLEManager::sendResponse(const String &response)
{
  if (!deviceConnected)
    return;

  pStatusChar->setValue(response.c_str());
  pStatusChar->notify();

  Serial.printf("[BLE] Response sent: %s\n", response.c_str());
}

void BLEManager::setCommandCallback(BLECommandCallback callback)
{
  commandCallback = callback;
}
