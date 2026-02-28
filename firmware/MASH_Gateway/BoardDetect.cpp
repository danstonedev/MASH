/*******************************************************************************
 * BoardDetect.cpp - Board Detection (Gateway)
 *
 * Identifies which board the Gateway firmware is running on:
 *   - Waveshare ESP32-S3-LCD-1.47 (1.47" ST7789V 172×320, NeoPixel GPIO38)
 *   - Adafruit QT Py ESP32-S3 (NeoPixel GPIO39 + power GPIO38, I2C GPIO41/40)
 *
 * Currently FORCED to Waveshare mode. Auto-detection can be restored later.
 * The two boards share some overlapping GPIOs:
 *   GPIO 41: QT Py SDA   / Waveshare LCD_DC
 *   GPIO 40: QT Py SCL   / Waveshare LCD_SCLK
 *   GPIO 39: QT Py NeoPixel / Waveshare LCD_RST
 *   GPIO 38: QT Py NeoPixel Power / Waveshare NeoPixel
 ******************************************************************************/

#include "../shared/BoardConfig.h"

// ============================================================================
// Global runtime state (defaults to QT Py — safe fallback)
// ============================================================================
BoardType detectedBoard = BOARD_QTPY_ESP32S3;
uint8_t boardSDA = QTPY_SDA_PIN;
uint8_t boardSCL = QTPY_SCL_PIN;
bool boardHasDisplay = false;
bool boardHasNeoPixel = true;
bool boardHasBuzzer = false;
uint8_t boardNeoPixelPin = QTPY_NEOPIXEL_PIN;
bool boardNeoPixelNeedsPower = true;

// ──────────────────────────────────────────────────────────────────────────
// Helper: apply Waveshare ESP32-S3-LCD-1.47 globals
// ──────────────────────────────────────────────────────────────────────────
static void setWaveshare()
{
    detectedBoard = BOARD_WAVESHARE_LCD_147;
    boardSDA = 0; // No I2C on Waveshare 1.47
    boardSCL = 0;
    boardHasDisplay = true;
    boardHasNeoPixel = true; // WS2812 on GPIO38
    boardHasBuzzer = false;
    boardNeoPixelPin = WS_NEOPIXEL_PIN; // GPIO38
    boardNeoPixelNeedsPower = false;    // No power gate needed

    Serial.println("[BoardDetect] >>> Waveshare ESP32-S3-LCD-1.47 DETECTED");
    Serial.printf("[BoardDetect]     Display: ST7789V %dx%d\n", WS_LCD_WIDTH, WS_LCD_HEIGHT);
    Serial.printf("[BoardDetect]     NeoPixel: GPIO%d\n", WS_NEOPIXEL_PIN);
}

static void setQtPy()
{
    detectedBoard = BOARD_QTPY_ESP32S3;
    boardSDA = QTPY_SDA_PIN;
    boardSCL = QTPY_SCL_PIN;
    boardHasDisplay = false;
    boardHasNeoPixel = true;
    boardHasBuzzer = false;
    boardNeoPixelPin = QTPY_NEOPIXEL_PIN; // GPIO39
    boardNeoPixelNeedsPower = true;       // Needs GPIO38 power gate

    Serial.println("[BoardDetect] >>> Adafruit QT Py ESP32-S3 (default)");
    Serial.printf("[BoardDetect]     I2C: SDA=%d, SCL=%d\n", boardSDA, boardSCL);
}

// ============================================================================
// detectBoard() — call once in setup() BEFORE Wire.begin()
// ============================================================================
BoardType detectBoard()
{
    Serial.println();
    Serial.println("[BoardDetect] ═══════════════════════════════════════");
    Serial.println("[BoardDetect]  Board: FORCED Waveshare ESP32-S3-LCD-1.47");
    Serial.println("[BoardDetect] ═══════════════════════════════════════");

    setWaveshare();
    return BOARD_WAVESHARE_LCD_147;

    // TODO: Restore auto-detection when QT Py Gateway support is needed.
    // Possible strategy: Waveshare has no I2C pull-ups on GPIO41/40,
    // but QT Py does. Probe pull-up on GPIO41 → QT Py.
}
