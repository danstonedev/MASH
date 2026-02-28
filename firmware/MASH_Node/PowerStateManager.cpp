/*******************************************************************************
 * PowerStateManager.cpp - Dynamic Power State Management Implementation
 ******************************************************************************/

#include "PowerStateManager.h"

// ============================================================================
// Constructor
// ============================================================================

PowerStateManager::PowerStateManager()
    : currentState(POWER_LOW), previousState(POWER_LOW), lastStateChangeTime(0),
      onStateChange(nullptr) {}

// ============================================================================
// Initialization
// ============================================================================

void PowerStateManager::init() {
  currentState = POWER_LOW;
  previousState = POWER_LOW;
  lastStateChangeTime = millis();

  Serial.println("[PowerState] Initialized in LOW state (25Hz)");
}

// ============================================================================
// State Transitions
// ============================================================================

bool PowerStateManager::requestState(PowerState newState) {
  if (newState == currentState) {
    return false; // No change needed
  }

  previousState = currentState;
  currentState = newState;
  lastStateChangeTime = millis();

  uint16_t newRate = getSampleRateHz();

  Serial.printf("[PowerState] Transition: %s -> %s (%dHz)\n",
                (previousState == POWER_LOW)   ? "LOW"
                : (previousState == POWER_MED) ? "MED"
                                               : "FULL",
                getStateName(), newRate);

  // Notify listeners
  if (onStateChange) {
    onStateChange(currentState, newRate);
  }

  return true;
}

// ============================================================================
// Getters
// ============================================================================

uint16_t PowerStateManager::getSampleRateHz() const {
  switch (currentState) {
  case POWER_LOW:
    return POWER_LOW_SAMPLE_RATE_HZ;
  case POWER_MED:
    return POWER_MED_SAMPLE_RATE_HZ;
  case POWER_FULL:
  default:
    return POWER_FULL_SAMPLE_RATE_HZ;
  }
}

unsigned long PowerStateManager::getSampleIntervalUs() const {
  return 1000000UL / getSampleRateHz();
}

const char *PowerStateManager::getStateName() const {
  switch (currentState) {
  case POWER_LOW:
    return "LOW";
  case POWER_MED:
    return "MED";
  case POWER_FULL:
    return "FULL";
  default:
    return "UNKNOWN";
  }
}

unsigned long PowerStateManager::getTimeSinceStateChange() const {
  return millis() - lastStateChangeTime;
}
