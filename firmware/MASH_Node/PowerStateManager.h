/*******************************************************************************
 * PowerStateManager.h - Dynamic Power State Management for IMU Node
 *
 * Implements a 3-state power model to optimize battery life:
 *   LOW  (25Hz)  - Boot, waiting for Gateway, idle
 *   MED  (100Hz) - During calibration
 *   FULL (200Hz) - TDMA synced streaming
 ******************************************************************************/

#ifndef POWER_STATE_MANAGER_H
#define POWER_STATE_MANAGER_H

#include <Arduino.h>
#include <functional>

// ============================================================================
// Power State Definitions
// ============================================================================

enum PowerState
{
  POWER_LOW = 0, // 25Hz - Boot, idle, waiting
  POWER_MED = 1, // 100Hz - Calibration
  POWER_FULL = 2 // 200Hz - Active streaming
};

// Sample rates for each power state
// ============================================================================
// 200Hz OUTPUT ARCHITECTURE
// ============================================================================
// GOAL: 200 time-synced samples per second from EACH sensor to WebApp
// - Node samples at 200Hz (5ms intervals)
// - TDMA batches 4 samples per 50Hz frame
// - Gateway passes through without decimation
// - WebApp receives 200Hz time-synced data
// ============================================================================
#define POWER_LOW_SAMPLE_RATE_HZ 25
#define POWER_MED_SAMPLE_RATE_HZ 100  // Calibration mode
#define POWER_FULL_SAMPLE_RATE_HZ 200 // Full 200Hz for research-grade output

// ============================================================================
// PowerStateManager Class
// ============================================================================

class PowerStateManager
{
public:
  PowerStateManager();

  /**
   * Initialize the power state manager
   * Starts in LOW state by default
   */
  void init();

  /**
   * Request a state transition
   * @param newState Target power state
   * @return true if transition occurred
   */
  bool requestState(PowerState newState);

  /**
   * Get current power state
   */
  PowerState getState() const { return currentState; }

  /**
   * Get current sample rate based on power state
   * @return Sample rate in Hz
   */
  uint16_t getSampleRateHz() const;

  /**
   * Get current sample interval in microseconds
   * @return Interval in microseconds
   */
  unsigned long getSampleIntervalUs() const;

  /**
   * Get state name for logging
   */
  const char *getStateName() const;

  /**
   * Set callback for state changes
   * Called after state transition with new state
   */
  void setStateChangeCallback(std::function<void(PowerState, uint16_t)> cb)
  {
    onStateChange = cb;
  }

  /**
   * Check if currently in a high-performance state
   */
  bool isHighPerformance() const { return currentState == POWER_FULL; }

  /**
   * Get time since last state change (ms)
   */
  unsigned long getTimeSinceStateChange() const;

private:
  PowerState currentState;
  PowerState previousState;
  unsigned long lastStateChangeTime;
  std::function<void(PowerState, uint16_t)> onStateChange;
};

#endif // POWER_STATE_MANAGER_H
