/*******************************************************************************
 * ConfigBase.h - Shared Configuration Constants
 *
 * Part of IMUConnectCore library - shared between Gateway and Node firmware.
 * Contains all constants that are identical across firmware variants.
 *
 * USAGE:
 *   In your project's Config.h:
 *   #include <ConfigBase.h>
 *   // Then add project-specific overrides/additions
 *
 ******************************************************************************/

#ifndef CONFIG_BASE_H
#define CONFIG_BASE_H

#include <Arduino.h>

// ============================================================================
// Device Identification
// ============================================================================

// Device roles in the IMU Connect system
enum DeviceRole
{
  ROLE_GATEWAY = 0,   // Central hub - receives data from nodes
  ROLE_NODE = 1,      // Peripheral - collects and transmits sensor data
  ROLE_STANDALONE = 2 // Single device mode (legacy)
};

// ============================================================================
// Hardware Configuration - ESP32-S3
// ============================================================================

// I2C pins (ESP32-S3 default)
#define DEFAULT_SDA_PIN 8
#define DEFAULT_SCL_PIN 9
#define DEFAULT_I2C_FREQ 400000 // 400kHz Fast Mode

// NeoPixel LED (common across all boards)
#define NEOPIXEL_PIN 21
#define NEOPIXEL_COUNT 1

// ============================================================================
// Sensor Configuration
// ============================================================================

// ICM-20649 Wide Range IMU
#define ICM20649_ADDR 0x68
#define ICM20649_ADDR_ALT 0x69

// BMI270 IMU (if used)
#define BMI270_ADDR 0x68
#define BMI270_ADDR_ALT 0x69

// LIS3MDL Magnetometer
#define LIS3MDL_ADDR 0x1C
#define LIS3MDL_ADDR_ALT 0x1E

// BMP390 Barometer
#define BMP390_ADDR 0x76
#define BMP390_ADDR_ALT 0x77

// Maximum sensors per device
#define MAX_SENSORS 6

// Sensor sampling rates
#define SENSOR_SAMPLE_RATE_HZ 200 // Internal IMU sample rate
#define MAG_SAMPLE_RATE_HZ 100    // Magnetometer rate
#define BARO_SAMPLE_RATE_HZ 50    // Barometer rate

// ============================================================================
// Filter Configuration
// ============================================================================

// ESKF (Error-State Kalman Filter) parameters
#define ESKF_PROCESS_NOISE_GYRO 0.001f
#define ESKF_PROCESS_NOISE_ACCEL 0.01f
#define ESKF_MEASUREMENT_NOISE_ACCEL 0.1f
#define ESKF_MEASUREMENT_NOISE_MAG 0.5f

// ============================================================================
// BLE Configuration
// ============================================================================

// BLE Service and Characteristic UUIDs
#define IMU_SERVICE_UUID "12345678-1234-5678-1234-56789abcdef0"
#define IMU_CHAR_UUID "12345678-1234-5678-1234-56789abcdef1"
#define CONTROL_CHAR_UUID "12345678-1234-5678-1234-56789abcdef2"
#define CALIBRATION_CHAR_UUID "12345678-1234-5678-1234-56789abcdef3"
#define ENVIRO_CHAR_UUID "12345678-1234-5678-1234-56789abcdef4"

// BLE settings
#define BLE_MTU_SIZE 512
#define BLE_DEVICE_NAME_PREFIX "MASH-"

// ============================================================================
// WiFi Configuration
// ============================================================================

#define WIFI_CONNECT_TIMEOUT_MS 10000
#define WIFI_RECONNECT_DELAY_MS 5000

// ============================================================================
// WebSocket Configuration
// ============================================================================

#define WEBSOCKET_PORT 81
#define WEBSOCKET_RECONNECT_DELAY_MS 3000
#define WEBSOCKET_PING_INTERVAL_MS 30000

// ============================================================================
// OTA (Over-The-Air Update) Configuration
// ============================================================================

#define OTA_PASSWORD "imuconnect"
#define OTA_PORT 3232
#define OTA_CHUNK_SIZE 1024

// ============================================================================
// Data Scaling Factors
// ============================================================================

// Quaternion scaling (int16 transmission)
#define QUAT_SCALE 16384.0f // 2^14

// Accelerometer scaling (int16 transmission, in m/s²)
#define ACCEL_SCALE 100.0f

// Gyroscope scaling (int16 transmission, in deg/s)
#define GYRO_SCALE 100.0f

// ============================================================================
// Timing Constants
// ============================================================================

#define LOOP_DELAY_US 100          // Main loop minimum delay
#define STATUS_LED_BLINK_MS 500    // Status LED blink interval
#define HEARTBEAT_INTERVAL_MS 1000 // Heartbeat/status update interval

// ============================================================================
// Buffer Sizes
// ============================================================================

#define SERIAL_BUFFER_SIZE 256
#define COMMAND_BUFFER_SIZE 128
#define JSON_BUFFER_SIZE 1024

// ============================================================================
// Debug Configuration
// ============================================================================

#ifndef DEBUG_LEVEL
#define DEBUG_LEVEL 1 // 0=Off, 1=Errors, 2=Warnings, 3=Info, 4=Verbose
#endif

// Debug macros
#if DEBUG_LEVEL >= 1
#define DEBUG_ERROR(x) Serial.println(x)
#else
#define DEBUG_ERROR(x)
#endif

#if DEBUG_LEVEL >= 2
#define DEBUG_WARN(x) Serial.println(x)
#else
#define DEBUG_WARN(x)
#endif

#if DEBUG_LEVEL >= 3
#define DEBUG_INFO(x) Serial.println(x)
#else
#define DEBUG_INFO(x)
#endif

#if DEBUG_LEVEL >= 4
#define DEBUG_VERBOSE(x) Serial.println(x)
#else
#define DEBUG_VERBOSE(x)
#endif

#endif // CONFIG_BASE_H
