/*******************************************************************************
 * Config.h - Gateway-Specific Configuration
 *
 * OPP-6 FIX 2026-02-08: Thin wrapper around SharedConfig.h.
 * All shared definitions live in firmware/shared/SharedConfig.h.
 * This file contains only Gateway-specific overrides.
 ******************************************************************************/

#ifndef CONFIG_H
#define CONFIG_H

// Include the unified shared configuration
#include "../shared/SharedConfig.h"

// ============================================================================
// Gateway-Specific Configuration
// ============================================================================

// Gateway does not use FreeRTOS sensor task (sensor reads happen on Nodes)
#define USE_FREERTOS_TASKS 0

// Output mode for data streaming (Gateway-specific)
enum OutputMode
{
  OUTPUT_RAW,                // Raw accel + gyro (original format)
  OUTPUT_QUATERNION,         // Fused quaternion data
  OUTPUT_QUATERNION_EXTENDED // Quaternion + accel + gyro combined
};

#endif // CONFIG_H