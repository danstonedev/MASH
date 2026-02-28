/*******************************************************************************
 * PacketTypes.h - ESP-NOW and Communication Packet Definitions
 * 
 * Part of IMUConnectCore library - shared between Gateway and Node firmware.
 * Defines all packet structures used for wireless communication.
 *
 * NOTE: TDMA-specific packets are in TDMAProtocol.h
 *       This file contains general-purpose ESP-NOW packets.
 *
 ******************************************************************************/

#ifndef PACKET_TYPES_H
#define PACKET_TYPES_H

#include <Arduino.h>
#include "ConfigBase.h"

// ============================================================================
// ESP-NOW Packet Type Identifiers
// ============================================================================

// Data packets (0x01-0x0F)
#define PACKET_TYPE_IMU_DATA     0x01  // Single IMU sample
#define PACKET_TYPE_ENVIRO_DATA  0x02  // Environmental data (mag, baro)
#define PACKET_TYPE_BATCH_DATA   0x03  // Batched IMU samples

// Control packets (0x10-0x1F)
#define PACKET_TYPE_COMMAND      0x10  // Command packet
#define PACKET_TYPE_RESPONSE     0x11  // Response packet
#define PACKET_TYPE_NODE_INFO    0x12  // Node information/status

// OTA packets (0x30-0x3F)
#define PACKET_TYPE_OTA_BEGIN    0x30  // OTA update start
#define PACKET_TYPE_OTA_DATA     0x31  // OTA data chunk
#define PACKET_TYPE_OTA_END      0x32  // OTA update complete
#define PACKET_TYPE_OTA_ACK      0x33  // OTA acknowledgment
#define PACKET_TYPE_OTA_NACK     0x34  // OTA negative acknowledgment

// TDMA packets (0x20-0x2F) - defined in TDMAProtocol.h

// ============================================================================
// IMU Data Structures
// ============================================================================

// Raw IMU data sample
struct __attribute__((packed)) IMUData {
  uint8_t sensorId;       // Sensor identifier
  uint32_t timestamp;     // Microseconds since boot
  int16_t quat[4];        // Quaternion (w,x,y,z) * QUAT_SCALE
  int16_t accel[3];       // Accelerometer (x,y,z) * ACCEL_SCALE
  int16_t gyro[3];        // Gyroscope (x,y,z) * GYRO_SCALE
};

// Environmental data (magnetometer + barometer)
struct __attribute__((packed)) EnviroData {
  uint8_t sensorId;       // Sensor identifier
  uint32_t timestamp;     // Microseconds since boot
  int16_t mag[3];         // Magnetometer (x,y,z) in uT * 10
  float pressure;         // Pressure in hPa
  float temperature;      // Temperature in °C
};

// Calibration data for a single sensor
struct __attribute__((packed)) CalibrationData {
  uint8_t sensorId;
  float accelBias[3];     // Accelerometer bias
  float gyroBias[3];      // Gyroscope bias
  float magHardIron[3];   // Magnetometer hard iron offset
  float magSoftIron[9];   // Magnetometer soft iron matrix (3x3)
  uint8_t isValid;        // Calibration validity flag
};

// ============================================================================
// ESP-NOW Data Packets
// ============================================================================

// Standard IMU data packet (single node, single sample)
struct __attribute__((packed)) ESPNowDataPacket {
  uint8_t type;           // PACKET_TYPE_IMU_DATA
  uint8_t nodeId;         // Source node ID
  uint32_t timestamp;     // Timestamp (us)
  uint8_t sensorCount;    // Number of sensors in packet
  // Followed by: sensorCount * IMUData
};

// Environmental data packet
struct __attribute__((packed)) ESPNowEnviroPacket {
  uint8_t type;           // PACKET_TYPE_ENVIRO_DATA
  uint8_t nodeId;         // Source node ID
  uint32_t timestamp;     // Timestamp (us)
  EnviroData data;        // Environmental data
};

// Node information packet (discovery/status)
struct __attribute__((packed)) ESPNowNodeInfoPacket {
  uint8_t type;           // PACKET_TYPE_NODE_INFO
  uint8_t nodeId;         // Node ID
  uint8_t sensorCount;    // Number of sensors
  uint8_t hasMag;         // Has magnetometer
  uint8_t hasBaro;        // Has barometer
  uint8_t firmwareVersion[3];  // Major, Minor, Patch
  char nodeName[16];      // Human-readable name
  uint8_t macAddress[6];  // WiFi MAC address
};

// ============================================================================
// Command Packets
// ============================================================================

// Command identifiers
#define CMD_PING            0x00  // Connection test
#define CMD_RESET           0x01  // Reset device
#define CMD_GET_INFO        0x02  // Request device info
#define CMD_SET_CONFIG      0x03  // Set configuration
#define CMD_GET_CONFIG      0x04  // Get configuration
#define CMD_START_STREAM    0x10  // Start data streaming
#define CMD_STOP_STREAM     0x11  // Stop data streaming
#define CMD_CALIBRATE       0x20  // Start calibration
#define CMD_SAVE_CALIB      0x21  // Save calibration
#define CMD_LOAD_CALIB      0x22  // Load calibration
#define CMD_TARE            0x23  // Tare (zero) sensors
#define CMD_OTA_BEGIN       0x30  // Begin OTA update
#define CMD_OTA_ABORT       0x31  // Abort OTA update

// Command packet
struct __attribute__((packed)) ESPNowCommandPacket {
  uint8_t type;           // PACKET_TYPE_COMMAND
  uint8_t command;        // Command identifier
  uint8_t targetNodeId;   // Target node (0xFF = broadcast)
  uint8_t payloadLength;  // Length of payload data
  uint8_t payload[32];    // Command-specific payload
};

// Response packet
struct __attribute__((packed)) ESPNowResponsePacket {
  uint8_t type;           // PACKET_TYPE_RESPONSE
  uint8_t command;        // Original command
  uint8_t nodeId;         // Responding node
  uint8_t status;         // 0=Success, >0=Error code
  uint8_t payloadLength;  // Length of response data
  uint8_t payload[32];    // Response-specific payload
};

// ============================================================================
// OTA Packets
// ============================================================================

struct __attribute__((packed)) OTABeginPacket {
  uint8_t type;           // PACKET_TYPE_OTA_BEGIN
  uint8_t targetNodeId;   // Target node (0xFF = all)
  uint32_t totalSize;     // Total firmware size in bytes
  uint16_t chunkSize;     // Size of each chunk
  uint16_t totalChunks;   // Total number of chunks
  uint8_t md5[16];        // MD5 hash of firmware
};

struct __attribute__((packed)) OTADataPacket {
  uint8_t type;           // PACKET_TYPE_OTA_DATA
  uint16_t chunkIndex;    // Chunk index (0-based)
  uint16_t dataLength;    // Actual data length in this chunk
  uint8_t data[200];      // Chunk data (max 200 bytes)
};

struct __attribute__((packed)) OTAEndPacket {
  uint8_t type;           // PACKET_TYPE_OTA_END
  uint8_t success;        // 1=Success, 0=Failure
};

struct __attribute__((packed)) OTAAckPacket {
  uint8_t type;           // PACKET_TYPE_OTA_ACK or PACKET_TYPE_OTA_NACK
  uint8_t nodeId;         // Responding node
  uint16_t chunkIndex;    // Acknowledged chunk index
  uint8_t status;         // 0=OK, >0=Error code
};

#endif  // PACKET_TYPES_H
