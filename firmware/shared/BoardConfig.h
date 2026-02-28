/*******************************************************************************
 * BoardConfig.h - Hardware Board Variant Definitions
 *
 * Defines pin mappings and hardware capabilities for each supported board.
 *
 * Supported boards:
 *   QT Py ESP32-S3          - Adafruit QT Py (NeoPixel, I2C on GPIO41/40)
 *   Waveshare LCD 1.47      - Waveshare ESP32-S3-LCD-1.47 (ST7789V 172×320,
 *                              NeoPixel on GPIO38, TF card, no I2C peripherals)
 *
 * Usage:
 *   Call detectBoard() early in setup() BEFORE Wire.begin().
 *   Then use the global variables (boardHasDisplay, boardHasNeoPixel, etc.)
 *   for all hardware access.
 ******************************************************************************/

#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H

#include <Arduino.h>

// ============================================================================
// Board Type Enum
// ============================================================================
enum BoardType
{
    BOARD_UNKNOWN = 0,
    BOARD_QTPY_ESP32S3,
    BOARD_WAVESHARE_LCD_147
};

// ============================================================================
// Pin Constants for Each Board (always available for reference)
// ============================================================================

// --- QT Py ESP32-S3 ---
#define QTPY_SDA_PIN 41
#define QTPY_SCL_PIN 40
#define QTPY_NEOPIXEL_PIN 39
#define QTPY_NEOPIXEL_POWER_PIN 38

// Wire1 (second I2C bus) on castellated SDA/SCL pads
#define QTPY_WIRE1_SDA_PIN 7
#define QTPY_WIRE1_SCL_PIN 6

// --- Waveshare ESP32-S3-LCD-1.47 ---
// Ref: https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47
// 1.47" ST7789V 172×320 display, NeoPixel LED, TF card slot
// NO touch controller, NO IMU, NO SYS_EN power gate
#define WS_LCD_CS_PIN 42
#define WS_LCD_DC_PIN 41
#define WS_LCD_RST_PIN 39
#define WS_LCD_BL_PIN 48
#define WS_LCD_MOSI_PIN 45
#define WS_LCD_SCLK_PIN 40
#define WS_LCD_SPI_FREQ 80000000 // 80 MHz
#define WS_LCD_WIDTH 172
#define WS_LCD_HEIGHT 320
#define WS_LCD_COL_OFFSET 34 // 172px centered in 240px controller RAM
#define WS_LCD_ROW_OFFSET 0
#define WS_NEOPIXEL_PIN 38 // Single WS2812 RGB LED

// ============================================================================
// Runtime Board Detection — Global State
// ============================================================================
// These are set by detectBoard() and used throughout the firmware.
// Defaults are QT Py values (safe fallback).
// ============================================================================

extern BoardType detectedBoard;
extern uint8_t boardSDA;
extern uint8_t boardSCL;
extern bool boardHasDisplay;
extern bool boardHasNeoPixel;
extern bool boardHasBuzzer;

// Runtime NeoPixel pin (set by detectBoard())
extern uint8_t boardNeoPixelPin;
extern bool boardNeoPixelNeedsPower; // QT Py needs power pin; Waveshare doesn't

// ============================================================================
// Backward-compatible aliases used by Gateway and shared code.
// These aliases provide QT Py defaults for code that still references them.
// ============================================================================
#define SDA_PIN QTPY_SDA_PIN
#define SCL_PIN QTPY_SCL_PIN
#define NEOPIXEL_PIN QTPY_NEOPIXEL_PIN
#define NEOPIXEL_POWER_PIN QTPY_NEOPIXEL_POWER_PIN

// Display pin aliases (used by DisplayManager — always Waveshare values,
// since the display only exists on the Waveshare board)
#define LCD_WIDTH WS_LCD_WIDTH
#define LCD_HEIGHT WS_LCD_HEIGHT
#define LCD_COL_OFFSET WS_LCD_COL_OFFSET
#define LCD_ROW_OFFSET WS_LCD_ROW_OFFSET
#define LCD_CS_PIN WS_LCD_CS_PIN
#define LCD_DC_PIN WS_LCD_DC_PIN
#define LCD_RST_PIN WS_LCD_RST_PIN
#define LCD_BL_PIN WS_LCD_BL_PIN
#define LCD_MOSI_PIN WS_LCD_MOSI_PIN
#define LCD_SCLK_PIN WS_LCD_SCLK_PIN
#define LCD_SPI_FREQ WS_LCD_SPI_FREQ

// ============================================================================
// detectBoard() — Call once in setup() before Wire.begin()
// ============================================================================
// Currently forced to Waveshare for the Gateway.
// Returns the detected board type.
// ============================================================================
BoardType detectBoard();

#endif // BOARD_CONFIG_H
