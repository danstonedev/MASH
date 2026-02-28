/*******************************************************************************
 * IMUConnectCore.h - Main Library Header
 * 
 * IMUConnectCore Library for ESP32
 * Provides shared components for IMU Connect Gateway and Node firmware.
 *
 * Include this single header to get all library components:
 *   - ConfigBase.h:    Shared configuration constants
 *   - TDMAProtocol.h:  TDMA protocol definitions and helpers
 *   - Quaternion.h:    Quaternion data structure
 *   - PacketTypes.h:   ESP-NOW packet definitions
 *
 * USAGE:
 *   #include <IMUConnectCore.h>
 *
 * Or include individual headers as needed:
 *   #include <ConfigBase.h>
 *   #include <TDMAProtocol.h>
 *
 ******************************************************************************/

#ifndef IMU_CONNECT_CORE_H
#define IMU_CONNECT_CORE_H

// Library version
#define IMU_CONNECT_CORE_VERSION_MAJOR 1
#define IMU_CONNECT_CORE_VERSION_MINOR 0
#define IMU_CONNECT_CORE_VERSION_PATCH 0

// Include all library components
#include "ConfigBase.h"
#include "Quaternion.h"
#include "TDMAProtocol.h"
#include "PacketTypes.h"

#endif  // IMU_CONNECT_CORE_H
