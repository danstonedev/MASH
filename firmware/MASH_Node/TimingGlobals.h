#ifndef TIMING_GLOBALS_H
#define TIMING_GLOBALS_H

#include <Arduino.h>

extern volatile uint32_t g_processTimeMax;
extern volatile uint32_t g_packetBuildTimeMax;
extern volatile uint32_t g_txAirTimeMax;
extern volatile uint32_t g_txStartTime;

#endif
