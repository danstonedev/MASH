/*******************************************************************************
 * DisplayManager.h - Onboard LCD Status Display for MASH Gateway
 *
 * End-user-facing status screen on the Waveshare ESP32-S3-LCD-1.47
 * (ST7789V 172x320). Shows five things the user cares about:
 *   1. How many Nodes are connected?
 *   2. How many Sensors total?
 *   3. Web app connected?
 *   4. WiFi connected?
 *   5. Recording?
 *
 * Always compiled into the firmware. At runtime, init() checks boardHasDisplay
 * and becomes a no-op on boards without a display (e.g., QT Py).
 ******************************************************************************/

#ifndef DISPLAY_MANAGER_H
#define DISPLAY_MANAGER_H

#include "../shared/SharedConfig.h"
#include <Arduino.h>
#include <SPI.h>

// ============================================================================
// Display Status — the 5 things a Gateway user needs to know
// ============================================================================
struct DisplayStatus
{
    uint8_t nodeCount;    // Connected TDMA nodes
    uint8_t sensorCount;  // Total IMU sensors across all nodes
    bool webAppConnected; // Web app connected via WebSocket
    bool wifiConnected;   // WiFi connected to router
    bool recording;       // Currently streaming / recording data
};

// Color definitions (RGB565)
#define COLOR_BLACK 0x0000
#define COLOR_WHITE 0xFFFF
#define COLOR_RED 0xF800
#define COLOR_GREEN 0x07E0
#define COLOR_BLUE 0x001F
#define COLOR_CYAN 0x07FF
#define COLOR_YELLOW 0xFFE0
#define COLOR_ORANGE 0xFD20
#define COLOR_GRAY 0x7BEF
#define COLOR_DARKGRAY 0x39E7
#define COLOR_DARKBLUE 0x1082
#define COLOR_BG 0x0000 // Screen background

class DisplayManager
{
public:
    DisplayManager();

    // Returns true if display hardware was found and initialized.
    // Safe to call on any board; returns false on boards without a display.
    bool init();

    void update(const DisplayStatus &status);
    void setBrightness(uint8_t brightness);
    void showSplash(const char *version);
    void showError(const char *message);

private:
    bool _initialized;
    uint8_t _brightness;

    // Cached state for dirty-checking
    int8_t _lastNodeCount;
    int8_t _lastSensorCount;
    int8_t _lastWebApp;
    int8_t _lastWiFi;
    int8_t _lastRecording;
    uint32_t _lastFullRedraw;

    // SPI session management
    void beginSPI();
    void endSPI();

    // Low-level ST7789 commands
    void writeCommand(uint8_t cmd);
    void writeData(uint8_t data);
    void setAddressWindow(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1);

    // Drawing primitives
    void fillRect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t color);
    void fillScreen(uint16_t color);
    void drawChar(uint16_t x, uint16_t y, char c, uint16_t color, uint16_t bg, uint8_t size);
    void drawString(uint16_t x, uint16_t y, const char *str, uint16_t color, uint16_t bg, uint8_t size);
    void drawHLine(uint16_t x, uint16_t y, uint16_t w, uint16_t color);

    // Status row helper
    void drawStatusRow(uint16_t y, uint16_t dotColor, const char *label,
                       const char *value, uint16_t valueColor);
};

#endif // DISPLAY_MANAGER_H
