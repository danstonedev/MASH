/*******************************************************************************
 * Config.h - Node-Specific Configuration
 *
 * Thin wrapper around SharedConfig.h.
 * All shared definitions live in firmware/shared/SharedConfig.h.
 * Board type is auto-detected at runtime (see BoardConfig.h / BoardDetect.cpp).
 * This file contains only Node-specific overrides.
 ******************************************************************************/

#ifndef CONFIG_H
#define CONFIG_H

// Include the unified shared configuration (includes BoardConfig.h)
#include "../shared/SharedConfig.h"

// ============================================================================
// Node-Specific Configuration
// ============================================================================

// OPP-1: Enable FreeRTOS sensor task isolation on Node
// Moves sensor I2C reads + fusion into a dedicated task pinned to Core 1,
// preventing WiFi/BLE ISR jitter from disrupting 200Hz sample timing.
#define USE_FREERTOS_TASKS 1

#endif // CONFIG_H