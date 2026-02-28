/*******************************************************************************
 * SharedConfig.h - Common Configuration for MASH Gateway & Node Firmware
 *
 * OPP-6 FIX 2026-02-08: Unified shared config to eliminate duplication.
 *
 * This file contains ALL definitions shared between Gateway and Node builds.
 * Role-specific Config.h files #include this and add role-specific overrides.
 *
 * PREREQUISITE: DEVICE_ROLE must be #defined BEFORE including this file.
 * Valid values: DEVICE_ROLE_STANDALONE (0), DEVICE_ROLE_NODE (1),
 *               DEVICE_ROLE_GATEWAY (2)
 ******************************************************************************/

#ifndef SHARED_CONFIG_H
#define SHARED_CONFIG_H

#include <Arduino.h>
#include <Preferences.h>
#include <freertos/semphr.h>
#include <math.h>

// ============================================================================
// Firmware Version
// ============================================================================

#define FIRMWARE_VERSION "1.0.0"
#define FIRMWARE_VERSION_MAJOR 1
#define FIRMWARE_VERSION_MINOR 0
#define FIRMWARE_VERSION_PATCH 0

// ============================================================================
// Hardware Configuration - Board-Specific Pin Definitions
// ============================================================================
// Pin mappings (SDA_PIN, SCL_PIN, NEOPIXEL_*, HAS_DISPLAY, LCD_* etc.)
// are defined in BoardConfig.h based on the selected BOARD_xxx variant.
// The board variant is chosen in the role-specific Config.h.
// ============================================================================

#include "BoardConfig.h"

// I2C Multiplexer (TCA9548A)
#define TCA9548A_ADDRESS 0x70
#define PROBE_FOR_MULTIPLEXER true
#define USE_MULTIPLEXER PROBE_FOR_MULTIPLEXER

// ============================================================================
// Sensor Configuration
// ============================================================================

#define MAX_SENSORS 8
// DEPRECATED: Runtime code uses TDMA_MAX_NODES (= 8) from TDMAProtocol.h.
// Kept at 8 for legacy test compatibility. Do NOT use in new code.
#define MAX_NODES 8
#define ICM20649_DEFAULT_ADDRESS 0x68
#define DEFAULT_ACCEL_RANGE_G 16
#define DEFAULT_GYRO_RANGE_DPS 2000
#define DEFAULT_SAMPLE_RATE_HZ 200

// Optional sensors (auto-detected)
#define MMC5603_ADDRESS 0x30
#define BMP390_ADDRESS 0x77
#define BMP390_ALT_ADDRESS 0x76

// ============================================================================
// BLE Configuration
// ============================================================================

#define BLE_DEVICE_NAME "MASH"
#define IMU_SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define IMU_DATA_CHAR_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define CONFIG_CHAR_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a9"
#define COMMAND_CHAR_UUID "beb5483e-36e1-4688-b7f5-ea07361b26aa"
#define STATUS_CHAR_UUID "beb5483e-36e1-4688-b7f5-ea07361b26ab"
#define OTA_DATA_CHAR_UUID "beb5483e-36e1-4688-b7f5-ea07361b26ac"
#define BLE_MTU_SIZE 512

// ============================================================================
// WiFi / WebSocket Configuration
// ============================================================================

#define WEBSOCKET_PORT 81
#define WIFI_CONNECT_TIMEOUT_MS 10000
#define WIFI_RECONNECT_INTERVAL_MS 30000
#define OTA_TIMEOUT_MS 30000

// NVS namespace for storing credentials
#define NVS_NAMESPACE "imu_connect"
#define NVS_SSID_KEY "wifi_ssid"
#define NVS_PASS_KEY "wifi_pass"

// ============================================================================
// FreeRTOS Task Configuration
// ============================================================================

#define SENSOR_TASK_CORE 1
#define PROTOCOL_TASK_CORE 0
#define SENSOR_TASK_PRIORITY 24
#define PROTOCOL_TASK_PRIORITY \
  18 // High priority to ensure reliable TDMA slot hits
#define SYNC_TASK_PRIORITY 20
#define DATA_TX_TASK_PRIORITY 15
#define BLE_TASK_PRIORITY 10
#define SENSOR_TASK_STACK_SIZE 4096
#define PROTOCOL_TASK_STACK_SIZE 8192
#define SYNC_TASK_STACK_SIZE 2048
#define DATA_TX_TASK_STACK_SIZE 3072

// NOTE: USE_FREERTOS_TASKS is role-specific — defined in each Config.h

// ============================================================================
// Filter Constants
// ============================================================================

#define FILTER_CUTOFF_HZ 10.0f
#define COMPLEMENTARY_ALPHA 0.98f

// ============================================================================
// Device Role Configuration
// ============================================================================

#define DEVICE_ROLE_STANDALONE 0
#define DEVICE_ROLE_NODE 1
#define DEVICE_ROLE_GATEWAY 2

enum DeviceRole
{
  ROLE_STANDALONE = DEVICE_ROLE_STANDALONE,
  ROLE_NODE = DEVICE_ROLE_NODE,
  ROLE_GATEWAY = DEVICE_ROLE_GATEWAY
};

#ifndef DEVICE_ROLE
#define DEVICE_ROLE DEVICE_ROLE_STANDALONE
#endif

#ifndef SENSOR_ID_OFFSET
#define SENSOR_ID_OFFSET 0
#endif

// ============================================================================
// ESP-NOW Configuration
// ============================================================================

#define ESP_NOW_CHANNEL 1

#ifndef GATEWAY_MAC_ADDRESS
#define GATEWAY_MAC_ADDRESS {0x34, 0x85, 0x18, 0xAB, 0xE0, 0xB4}
#endif

// ============================================================================
// Data Structures
// ============================================================================

struct IMUData
{
  float accelX, accelY, accelZ;
  float gyroX, gyroY, gyroZ;
  uint32_t timestamp;
  uint8_t sensorId;
};

struct CalibrationData
{
  float accelOffsetX, accelOffsetY, accelOffsetZ;
  float accelScale;
  float gyroOffsetX, gyroOffsetY, gyroOffsetZ;
  bool isCalibrated;
  uint8_t outlierCount;
};

struct MagData
{
  float x, y, z;
  float heading;
};

struct MagCalibrationData
{
  float hardIronX, hardIronY, hardIronZ;
  float softIronScaleX, softIronScaleY, softIronScaleZ;
  bool isCalibrated;
  uint16_t sampleCount;
};

struct BaroData
{
  float pressure;
  float temperature;
  float altitude;
};

enum ConnectionMode
{
  MODE_BLE,
  MODE_WIFI
};

// ============================================================================
// Quaternion Structure
// ============================================================================

struct Quaternion
{
  float w, x, y, z;

  Quaternion() : w(1.0f), x(0.0f), y(0.0f), z(0.0f) {}
  Quaternion(float _w, float _x, float _y, float _z)
      : w(_w), x(_x), y(_y), z(_z) {}

  void normalize()
  {
    float norm = sqrtf(w * w + x * x + y * y + z * z);
    if (norm > 0.0f)
    {
      float invNorm = 1.0f / norm;
      w *= invNorm;
      x *= invNorm;
      y *= invNorm;
      z *= invNorm;
    }
  }

  bool isNormalized(float tolerance = 0.001f) const
  {
    float norm = sqrtf(w * w + x * x + y * y + z * z);
    return fabsf(norm - 1.0f) < tolerance;
  }

  int16_t wInt16() const { return (int16_t)(w * 16384.0f); }
  int16_t xInt16() const { return (int16_t)(x * 16384.0f); }
  int16_t yInt16() const { return (int16_t)(y * 16384.0f); }
  int16_t zInt16() const { return (int16_t)(z * 16384.0f); }

  static Quaternion fromInt16(int16_t w, int16_t x, int16_t y, int16_t z)
  {
    return Quaternion(w / 16384.0f, x / 16384.0f, y / 16384.0f, z / 16384.0f);
  }

  Quaternion operator*(const Quaternion &q) const
  {
    return Quaternion(w * q.w - x * q.x - y * q.y - z * q.z,
                      w * q.x + x * q.w + y * q.z - z * q.y,
                      w * q.y - x * q.z + y * q.w + z * q.x,
                      w * q.z + x * q.y - y * q.x + z * q.w);
  }

  Quaternion conjugate() const { return Quaternion(w, -x, -y, -z); }
};

// ============================================================================
// ESP-NOW Packet Structures
// ============================================================================

struct __attribute__((packed)) CompressedSensorData
{
  uint8_t id;
  int16_t q[4];
  int16_t a[3];
  int16_t g[3];
};

struct __attribute__((packed)) ESPNowDataPacket
{
  uint8_t type;
  uint8_t count;
  uint32_t timestamp;
  CompressedSensorData sensors[MAX_SENSORS];
};

struct __attribute__((packed)) ESPNowEnviroPacket
{
  uint8_t type;
  uint8_t hasMag;
  uint8_t hasBaro;
  float mag[4];
  float baro[3];
};

struct __attribute__((packed)) ESPNowNodeInfoPacket
{
  uint8_t type;
  char nodeName[32];
  uint8_t sensorIdOffset;
  uint8_t sensorCount;
  uint8_t hasMag;
  uint8_t hasBaro;
  uint8_t useMux;
  int8_t sensorChannels[8];
};

// ============================================================================
// OTA Packet Types
// ============================================================================

#define OTA_PACKET_BEGIN 0x10
#define OTA_PACKET_DATA 0x11
#define OTA_PACKET_END 0x12
#define OTA_PACKET_ACK 0x13
#define OTA_PACKET_ABORT 0x14

struct __attribute__((packed)) ESPNowOTABeginPacket
{
  uint8_t type;
  uint32_t totalSize;
  char md5[33];
  char version[16];
};

struct __attribute__((packed)) ESPNowOTADataPacket
{
  uint8_t type;
  uint32_t offset;
  uint8_t length;
  uint8_t data[240];
};

struct __attribute__((packed)) ESPNowOTAEndPacket
{
  uint8_t type;
  char md5[33];
};

struct __attribute__((packed)) ESPNowOTAAckPacket
{
  uint8_t type;
  uint8_t nodeId;
  uint8_t status;
  uint16_t lastOffset;
  uint8_t progress;
};

struct __attribute__((packed)) ESPNowOTAAbortPacket
{
  uint8_t type;
  uint8_t errorCode;
};

// ============================================================================
// Command & Control Packets
// ============================================================================

#define RADIO_MODE_PACKET 0x06
#define CMD_FORWARD_PACKET 0x08
#define MAG_CALIB_PACKET 0x09
#define RADIO_MODE_BLE_OFF 0x00
#define RADIO_MODE_BLE_ON 0x01

struct __attribute__((packed)) ESPNowRadioModePacket
{
  uint8_t type;
  uint8_t mode;
};

struct __attribute__((packed)) ESPNowCmdPacket
{
  uint8_t type;
  uint8_t targetNode;
  uint8_t cmdType;
  uint32_t param1;
  uint32_t param2;
};

struct __attribute__((packed)) ESPNowMagCalibPacket
{
  uint8_t type;
  uint8_t nodeId;
  uint8_t isCalibrating;
  uint8_t progress;
  uint8_t isCalibrated;
  float hardIronX, hardIronY, hardIronZ;
  float softIronScaleX, softIronScaleY, softIronScaleZ;
  uint16_t sampleCount;
};

#define CMD_MAG_CALIBRATE 0x50
#define CMD_MAG_CLEAR 0x51
#define CMD_GYRO_CALIBRATE 0x52
#define CMD_SET_NODE_ID 0x53

// ============================================================================
// Safe Serial Logging Macros
// ============================================================================

#if DEVICE_ROLE == DEVICE_ROLE_GATEWAY

extern volatile bool suppressSerialLogs;
extern SemaphoreHandle_t serialWriteMutex;

#define SAFE_LOG(fmt, ...)                               \
  do                                                     \
  {                                                      \
    if (!suppressSerialLogs)                             \
    {                                                    \
      if (serialWriteMutex != nullptr)                   \
        xSemaphoreTake(serialWriteMutex, portMAX_DELAY); \
      ::Serial.printf(fmt, ##__VA_ARGS__);               \
      if (serialWriteMutex != nullptr)                   \
        xSemaphoreGive(serialWriteMutex);                \
    }                                                    \
  } while (0)

#define SAFE_PRINTLN(msg)                                \
  do                                                     \
  {                                                      \
    if (!suppressSerialLogs)                             \
    {                                                    \
      if (serialWriteMutex != nullptr)                   \
        xSemaphoreTake(serialWriteMutex, portMAX_DELAY); \
      ::Serial.println(msg);                             \
      if (serialWriteMutex != nullptr)                   \
        xSemaphoreGive(serialWriteMutex);                \
    }                                                    \
  } while (0)

#define SAFE_PRINT(msg)                                  \
  do                                                     \
  {                                                      \
    if (!suppressSerialLogs)                             \
    {                                                    \
      if (serialWriteMutex != nullptr)                   \
        xSemaphoreTake(serialWriteMutex, portMAX_DELAY); \
      ::Serial.print(msg);                               \
      if (serialWriteMutex != nullptr)                   \
        xSemaphoreGive(serialWriteMutex);                \
    }                                                    \
  } while (0)

// NON-BLOCKING variants: skip log if mutex is held (for timing-critical paths)
// Use in sendTDMABeacon() / ProtocolTask to avoid stalling 50Hz beacons.
#define SAFE_LOG_NB(fmt, ...)                                       \
  do                                                                \
  {                                                                 \
    if (!suppressSerialLogs)                                        \
    {                                                               \
      bool _got_mutex = true;                                       \
      if (serialWriteMutex != nullptr)                              \
        _got_mutex = xSemaphoreTake(serialWriteMutex, 0) == pdTRUE; \
      if (_got_mutex)                                               \
      {                                                             \
        ::Serial.printf(fmt, ##__VA_ARGS__);                        \
        if (serialWriteMutex != nullptr)                            \
          xSemaphoreGive(serialWriteMutex);                         \
      }                                                             \
    }                                                               \
  } while (0)

#define SAFE_PRINTLN_NB(msg)                                        \
  do                                                                \
  {                                                                 \
    if (!suppressSerialLogs)                                        \
    {                                                               \
      bool _got_mutex = true;                                       \
      if (serialWriteMutex != nullptr)                              \
        _got_mutex = xSemaphoreTake(serialWriteMutex, 0) == pdTRUE; \
      if (_got_mutex)                                               \
      {                                                             \
        ::Serial.println(msg);                                      \
        if (serialWriteMutex != nullptr)                            \
          xSemaphoreGive(serialWriteMutex);                         \
      }                                                             \
    }                                                               \
  } while (0)

#else
#define SAFE_LOG(fmt, ...) ::Serial.printf(fmt, ##__VA_ARGS__)
#define SAFE_PRINTLN(msg) ::Serial.println(msg)
#define SAFE_PRINT(msg) ::Serial.print(msg)
#define SAFE_LOG_NB(fmt, ...) ::Serial.printf(fmt, ##__VA_ARGS__)
#define SAFE_PRINTLN_NB(msg) ::Serial.println(msg)
#endif

#endif // SHARED_CONFIG_H
