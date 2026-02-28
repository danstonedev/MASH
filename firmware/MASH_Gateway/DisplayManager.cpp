/*******************************************************************************
 * DisplayManager.cpp - ST7789V Display Driver + MASH Gateway Status
 *
 * Self-contained display driver for the Waveshare ESP32-S3-LCD-1.47.
 * No external display library dependencies — uses SPI directly.
 *
 * Board: ESP32-S3-LCD-1.47  (ST7789V, 172×320 pixels)
 * SPI pins: MOSI=45, SCLK=40, CS=42, DC=41, RST=39, BL=48
 * SPI freq: 80 MHz
 * Offsets: col=34 (172px centered in 240px controller RAM), row=0
 *
 * Gateway display layout (172×320 pixels):
 * ┌──────────────────────────────┐
 * │       MASH GW                │  Header (dark blue)
 * ├──────────────────────────────┤
 * │                              │
 * │  2  Nodes                    │  Count (green / red)
 * │                              │
 * │  4  Sensors                  │  Count (green / red)
 * │                              │
 * │  ●  Web App      Connected  │  Green / Red dot
 * │                              │
 * │  ●  WiFi         Connected  │  Green / Red dot
 * │                              │
 * │  ●  Recording               │  Green / Gray dot
 * │                              │
 * └──────────────────────────────┘
 ******************************************************************************/

#include "DisplayManager.h"

// ============================================================================
// Embedded 5x7 Bitmap Font (ASCII 32-126)
// ============================================================================
static const uint8_t font5x7[] PROGMEM = {
    0x00,
    0x00,
    0x00,
    0x00,
    0x00, // 32 (space)
    0x00,
    0x00,
    0x5F,
    0x00,
    0x00, // 33 !
    0x00,
    0x07,
    0x00,
    0x07,
    0x00, // 34 "
    0x14,
    0x7F,
    0x14,
    0x7F,
    0x14, // 35 #
    0x24,
    0x2A,
    0x7F,
    0x2A,
    0x12, // 36 $
    0x23,
    0x13,
    0x08,
    0x64,
    0x62, // 37 %
    0x36,
    0x49,
    0x55,
    0x22,
    0x50, // 38 &
    0x00,
    0x05,
    0x03,
    0x00,
    0x00, // 39 '
    0x00,
    0x1C,
    0x22,
    0x41,
    0x00, // 40 (
    0x00,
    0x41,
    0x22,
    0x1C,
    0x00, // 41 )
    0x08,
    0x2A,
    0x1C,
    0x2A,
    0x08, // 42 *
    0x08,
    0x08,
    0x3E,
    0x08,
    0x08, // 43 +
    0x00,
    0x50,
    0x30,
    0x00,
    0x00, // 44 ,
    0x08,
    0x08,
    0x08,
    0x08,
    0x08, // 45 -
    0x00,
    0x60,
    0x60,
    0x00,
    0x00, // 46 .
    0x20,
    0x10,
    0x08,
    0x04,
    0x02, // 47 /
    0x3E,
    0x51,
    0x49,
    0x45,
    0x3E, // 48 0
    0x00,
    0x42,
    0x7F,
    0x40,
    0x00, // 49 1
    0x42,
    0x61,
    0x51,
    0x49,
    0x46, // 50 2
    0x21,
    0x41,
    0x45,
    0x4B,
    0x31, // 51 3
    0x18,
    0x14,
    0x12,
    0x7F,
    0x10, // 52 4
    0x27,
    0x45,
    0x45,
    0x45,
    0x39, // 53 5
    0x3C,
    0x4A,
    0x49,
    0x49,
    0x30, // 54 6
    0x01,
    0x71,
    0x09,
    0x05,
    0x03, // 55 7
    0x36,
    0x49,
    0x49,
    0x49,
    0x36, // 56 8
    0x06,
    0x49,
    0x49,
    0x29,
    0x1E, // 57 9
    0x00,
    0x36,
    0x36,
    0x00,
    0x00, // 58 :
    0x00,
    0x56,
    0x36,
    0x00,
    0x00, // 59 ;
    0x00,
    0x08,
    0x14,
    0x22,
    0x41, // 60 <
    0x14,
    0x14,
    0x14,
    0x14,
    0x14, // 61 =
    0x41,
    0x22,
    0x14,
    0x08,
    0x00, // 62 >
    0x02,
    0x01,
    0x51,
    0x09,
    0x06, // 63 ?
    0x32,
    0x49,
    0x79,
    0x41,
    0x3E, // 64 @
    0x7E,
    0x11,
    0x11,
    0x11,
    0x7E, // 65 A
    0x7F,
    0x49,
    0x49,
    0x49,
    0x36, // 66 B
    0x3E,
    0x41,
    0x41,
    0x41,
    0x22, // 67 C
    0x7F,
    0x41,
    0x41,
    0x22,
    0x1C, // 68 D
    0x7F,
    0x49,
    0x49,
    0x49,
    0x41, // 69 E
    0x7F,
    0x09,
    0x09,
    0x01,
    0x01, // 70 F
    0x3E,
    0x41,
    0x41,
    0x51,
    0x32, // 71 G
    0x7F,
    0x08,
    0x08,
    0x08,
    0x7F, // 72 H
    0x00,
    0x41,
    0x7F,
    0x41,
    0x00, // 73 I
    0x20,
    0x40,
    0x41,
    0x3F,
    0x01, // 74 J
    0x7F,
    0x08,
    0x14,
    0x22,
    0x41, // 75 K
    0x7F,
    0x40,
    0x40,
    0x40,
    0x40, // 76 L
    0x7F,
    0x02,
    0x04,
    0x02,
    0x7F, // 77 M
    0x7F,
    0x04,
    0x08,
    0x10,
    0x7F, // 78 N
    0x3E,
    0x41,
    0x41,
    0x41,
    0x3E, // 79 O
    0x7F,
    0x09,
    0x09,
    0x09,
    0x06, // 80 P
    0x3E,
    0x41,
    0x51,
    0x21,
    0x5E, // 81 Q
    0x7F,
    0x09,
    0x19,
    0x29,
    0x46, // 82 R
    0x46,
    0x49,
    0x49,
    0x49,
    0x31, // 83 S
    0x01,
    0x01,
    0x7F,
    0x01,
    0x01, // 84 T
    0x3F,
    0x40,
    0x40,
    0x40,
    0x3F, // 85 U
    0x1F,
    0x20,
    0x40,
    0x20,
    0x1F, // 86 V
    0x7F,
    0x20,
    0x18,
    0x20,
    0x7F, // 87 W
    0x63,
    0x14,
    0x08,
    0x14,
    0x63, // 88 X
    0x03,
    0x04,
    0x78,
    0x04,
    0x03, // 89 Y
    0x61,
    0x51,
    0x49,
    0x45,
    0x43, // 90 Z
    0x00,
    0x00,
    0x7F,
    0x41,
    0x41, // 91 [
    0x02,
    0x04,
    0x08,
    0x10,
    0x20, // 92 backslash
    0x41,
    0x41,
    0x7F,
    0x00,
    0x00, // 93 ]
    0x04,
    0x02,
    0x01,
    0x02,
    0x04, // 94 ^
    0x40,
    0x40,
    0x40,
    0x40,
    0x40, // 95 _
    0x00,
    0x01,
    0x02,
    0x04,
    0x00, // 96 `
    0x20,
    0x54,
    0x54,
    0x54,
    0x78, // 97 a
    0x7F,
    0x48,
    0x44,
    0x44,
    0x38, // 98 b
    0x38,
    0x44,
    0x44,
    0x44,
    0x20, // 99 c
    0x38,
    0x44,
    0x44,
    0x48,
    0x7F, // 100 d
    0x38,
    0x54,
    0x54,
    0x54,
    0x18, // 101 e
    0x08,
    0x7E,
    0x09,
    0x01,
    0x02, // 102 f
    0x08,
    0x14,
    0x54,
    0x54,
    0x3C, // 103 g
    0x7F,
    0x08,
    0x04,
    0x04,
    0x78, // 104 h
    0x00,
    0x44,
    0x7D,
    0x40,
    0x00, // 105 i
    0x20,
    0x40,
    0x44,
    0x3D,
    0x00, // 106 j
    0x00,
    0x7F,
    0x10,
    0x28,
    0x44, // 107 k
    0x00,
    0x41,
    0x7F,
    0x40,
    0x00, // 108 l
    0x7C,
    0x04,
    0x18,
    0x04,
    0x78, // 109 m
    0x7C,
    0x08,
    0x04,
    0x04,
    0x78, // 110 n
    0x38,
    0x44,
    0x44,
    0x44,
    0x38, // 111 o
    0x7C,
    0x14,
    0x14,
    0x14,
    0x08, // 112 p
    0x08,
    0x14,
    0x14,
    0x18,
    0x7C, // 113 q
    0x7C,
    0x08,
    0x04,
    0x04,
    0x08, // 114 r
    0x48,
    0x54,
    0x54,
    0x54,
    0x20, // 115 s
    0x04,
    0x3F,
    0x44,
    0x40,
    0x20, // 116 t
    0x3C,
    0x40,
    0x40,
    0x20,
    0x7C, // 117 u
    0x1C,
    0x20,
    0x40,
    0x20,
    0x1C, // 118 v
    0x3C,
    0x40,
    0x30,
    0x40,
    0x3C, // 119 w
    0x44,
    0x28,
    0x10,
    0x28,
    0x44, // 120 x
    0x0C,
    0x50,
    0x50,
    0x50,
    0x3C, // 121 y
    0x44,
    0x64,
    0x54,
    0x4C,
    0x44, // 122 z
    0x00,
    0x08,
    0x36,
    0x41,
    0x00, // 123 {
    0x00,
    0x00,
    0x7F,
    0x00,
    0x00, // 124 |
    0x00,
    0x41,
    0x36,
    0x08,
    0x00, // 125 }
    0x08,
    0x08,
    0x2A,
    0x1C,
    0x08, // 126 ~
};

// ============================================================================
// Constructor
// ============================================================================

DisplayManager::DisplayManager()
    : _initialized(false),
      _brightness(200),
      _lastNodeCount(-1),
      _lastSensorCount(-1),
      _lastWebApp(-1),
      _lastWiFi(-1),
      _lastRecording(-1),
      _lastFullRedraw(0)
{
}

// ============================================================================
// SPI Session Helpers
// ============================================================================

void DisplayManager::beginSPI()
{
    SPI.beginTransaction(SPISettings(LCD_SPI_FREQ, MSBFIRST, SPI_MODE0));
    digitalWrite(LCD_CS_PIN, LOW);
}

void DisplayManager::endSPI()
{
    digitalWrite(LCD_CS_PIN, HIGH);
    SPI.endTransaction();
}

// ============================================================================
// Low-Level ST7789 Commands
// ============================================================================

void DisplayManager::writeCommand(uint8_t cmd)
{
    digitalWrite(LCD_DC_PIN, LOW);
    SPI.transfer(cmd);
    digitalWrite(LCD_DC_PIN, HIGH);
}

void DisplayManager::writeData(uint8_t data)
{
    SPI.transfer(data);
}

void DisplayManager::setAddressWindow(uint16_t x0, uint16_t y0,
                                      uint16_t x1, uint16_t y1)
{
    y0 += LCD_ROW_OFFSET;
    y1 += LCD_ROW_OFFSET;
    x0 += LCD_COL_OFFSET;
    x1 += LCD_COL_OFFSET;

    writeCommand(0x2A);
    writeData(x0 >> 8);
    writeData(x0 & 0xFF);
    writeData(x1 >> 8);
    writeData(x1 & 0xFF);

    writeCommand(0x2B);
    writeData(y0 >> 8);
    writeData(y0 & 0xFF);
    writeData(y1 >> 8);
    writeData(y1 & 0xFF);

    writeCommand(0x2C);
}

// ============================================================================
// Display Initialization (ST7789V for ESP32-S3-LCD-1.47, 172×320)
// ============================================================================

bool DisplayManager::init()
{
    if (!boardHasDisplay)
    {
        Serial.println("[Display] No display on this board — skipping init");
        return false;
    }

    Serial.println("[Display] === Begin ST7789V init (172x320) ===");

    // Configure control pins
    pinMode(LCD_CS_PIN, OUTPUT);
    pinMode(LCD_DC_PIN, OUTPUT);
    pinMode(LCD_RST_PIN, OUTPUT);
    pinMode(LCD_BL_PIN, OUTPUT);

    digitalWrite(LCD_CS_PIN, HIGH); // CS inactive initially
    digitalWrite(LCD_BL_PIN, LOW);  // BL off during init

    Serial.printf("[Display] Pins: CS=%d DC=%d RST=%d BL=%d MOSI=%d SCLK=%d\n",
                  LCD_CS_PIN, LCD_DC_PIN, LCD_RST_PIN, LCD_BL_PIN,
                  LCD_MOSI_PIN, LCD_SCLK_PIN);
    Serial.printf("[Display] SPI freq: %d Hz, Resolution: %dx%d, Offsets: col=%d row=%d\n",
                  LCD_SPI_FREQ, LCD_WIDTH, LCD_HEIGHT, LCD_COL_OFFSET, LCD_ROW_OFFSET);

    // Init SPI bus (SCLK, MISO=-1, MOSI, SS=-1)
    SPI.begin(LCD_SCLK_PIN, -1, LCD_MOSI_PIN, -1);
    Serial.println("[Display] SPI.begin() done");

    // Hardware reset with CS asserted
    digitalWrite(LCD_CS_PIN, LOW);
    digitalWrite(LCD_RST_PIN, HIGH);
    delay(10);
    digitalWrite(LCD_RST_PIN, LOW);
    delay(10);
    digitalWrite(LCD_RST_PIN, HIGH);
    delay(120);
    digitalWrite(LCD_CS_PIN, HIGH);
    Serial.println("[Display] Hardware reset complete");

    // SWRESET — must be in its own SPI session, then wait ≥120ms
    beginSPI();
    writeCommand(0x01);
    endSPI();
    delay(150);
    Serial.println("[Display] SWRESET sent");

    // SLPOUT — must be in its own SPI session, then wait ≥120ms
    beginSPI();
    writeCommand(0x11);
    endSPI();
    delay(150);
    Serial.println("[Display] SLPOUT sent");

    // ---- Configuration commands (single SPI session) ----
    beginSPI();

    writeCommand(0x36); // MADCTL — Memory Data Access Control
    writeData(0x00);    // Normal portrait orientation, RGB order

    writeCommand(0x3A); // COLMOD — Pixel Format
    writeData(0x55);    // 16-bit RGB565 (both MCU + RGB interfaces)

    writeCommand(0xB2); // Porch Control
    writeData(0x0C);
    writeData(0x0C);
    writeData(0x00);
    writeData(0x33);
    writeData(0x33);

    writeCommand(0xB7); // Gate Control
    writeData(0x35);

    writeCommand(0xBB); // VCOM Setting
    writeData(0x35);    // 1.47" board value

    writeCommand(0xC0); // LCM Control
    writeData(0x2C);

    writeCommand(0xC2); // VDV/VRH Command Enable
    writeData(0x01);

    writeCommand(0xC3); // VRH Set
    writeData(0x13);    // 1.47" board value

    writeCommand(0xC4); // VDV Set
    writeData(0x20);

    writeCommand(0xC6); // Frame Rate Control
    writeData(0x0F);    // 60Hz

    writeCommand(0xD0); // Power Control 1
    writeData(0xA4);
    writeData(0xA1);

    // Positive Gamma Correction
    writeCommand(0xE0);
    writeData(0xF0);
    writeData(0x00);
    writeData(0x04);
    writeData(0x04);
    writeData(0x04);
    writeData(0x05);
    writeData(0x29);
    writeData(0x33);
    writeData(0x3E);
    writeData(0x38);
    writeData(0x12);
    writeData(0x12);
    writeData(0x28);
    writeData(0x30);

    // Negative Gamma Correction
    writeCommand(0xE1);
    writeData(0xF0);
    writeData(0x07);
    writeData(0x0A);
    writeData(0x0D);
    writeData(0x0B);
    writeData(0x07);
    writeData(0x28);
    writeData(0x33);
    writeData(0x3E);
    writeData(0x36);
    writeData(0x14);
    writeData(0x14);
    writeData(0x29);
    writeData(0x32);

    writeCommand(0x21); // Display Inversion On (needed for ST7789)
    writeCommand(0x13); // Normal Display Mode On
    writeCommand(0x29); // Display On

    endSPI();
    Serial.println("[Display] Init commands sent (INVON + NORON + DISPON)");

    // Turn on backlight FIRST, then do diagnostic fills so results are visible
    ledcAttach(LCD_BL_PIN, 1000, 10); // 1 kHz, 10-bit resolution
    ledcWrite(LCD_BL_PIN, 1023);      // Full brightness (1023/1023)
    _brightness = 255;
    Serial.println("[Display] Backlight ON (LEDC PWM 1kHz/10-bit)");

    // ---- DIAGNOSTIC: Flash RED then WHITE to confirm SPI pixel writes ----
    Serial.println("[Display] DIAG: Filling RED...");
    fillScreen(COLOR_RED);
    delay(400);
    Serial.println("[Display] DIAG: Filling WHITE...");
    fillScreen(COLOR_WHITE);
    delay(400);
    Serial.println("[Display] DIAG: Filling BG (black)...");
    fillScreen(COLOR_BG);

    _initialized = true;
    Serial.println("[Display] ST7789V 172x320 initialized OK");
    return true;
}

// ============================================================================
// Backlight Control
// ============================================================================

void DisplayManager::setBrightness(uint8_t brightness)
{
    _brightness = brightness;
    // Map 0-255 to 0-1023 (10-bit LEDC resolution, 1 kHz)
    uint32_t duty = (uint32_t)brightness * 1023 / 255;
    ledcWrite(LCD_BL_PIN, duty);
}

// ============================================================================
// Drawing Primitives
// ============================================================================

void DisplayManager::fillRect(uint16_t x, uint16_t y,
                              uint16_t w, uint16_t h, uint16_t color)
{
    if (x >= LCD_WIDTH || y >= LCD_HEIGHT)
        return;
    if (x + w > LCD_WIDTH)
        w = LCD_WIDTH - x;
    if (y + h > LCD_HEIGHT)
        h = LCD_HEIGHT - y;

    beginSPI();
    setAddressWindow(x, y, x + w - 1, y + h - 1);

    uint8_t hi = color >> 8;
    uint8_t lo = color & 0xFF;

    static const uint16_t BUF_PIXELS = 120;
    uint8_t lineBuf[BUF_PIXELS * 2];

    uint16_t bufPixels = (w < BUF_PIXELS) ? w : BUF_PIXELS;
    for (uint16_t i = 0; i < bufPixels; i++)
    {
        lineBuf[i * 2] = hi;
        lineBuf[i * 2 + 1] = lo;
    }

    uint32_t totalPixels = (uint32_t)w * h;
    while (totalPixels > 0)
    {
        uint32_t chunk = (totalPixels < bufPixels) ? totalPixels : bufPixels;
        SPI.transferBytes(lineBuf, nullptr, chunk * 2);
        totalPixels -= chunk;
    }

    endSPI();
}

void DisplayManager::fillScreen(uint16_t color)
{
    fillRect(0, 0, LCD_WIDTH, LCD_HEIGHT, color);
}

void DisplayManager::drawHLine(uint16_t x, uint16_t y, uint16_t w, uint16_t color)
{
    fillRect(x, y, w, 1, color);
}

void DisplayManager::drawChar(uint16_t x, uint16_t y, char c,
                              uint16_t color, uint16_t bg, uint8_t size)
{
    if (c < 32 || c > 126)
        c = '?';
    uint16_t idx = (c - 32) * 5;

    uint16_t charW = 5 * size;
    uint16_t charH = 7 * size;

    if (x + charW > LCD_WIDTH || y + charH > LCD_HEIGHT)
        return;

    uint8_t charBuf[20 * 28 * 2];
    uint16_t bufIdx = 0;

    uint8_t hiC = color >> 8, loC = color & 0xFF;
    uint8_t hiB = bg >> 8, loB = bg & 0xFF;

    for (uint8_t row = 0; row < 7; row++)
    {
        for (uint8_t sy = 0; sy < size; sy++)
        {
            for (uint8_t col = 0; col < 5; col++)
            {
                uint8_t colData = pgm_read_byte(&font5x7[idx + col]);
                bool pixel = (colData >> row) & 1;
                uint8_t pixHi = pixel ? hiC : hiB;
                uint8_t pixLo = pixel ? loC : loB;
                for (uint8_t sx = 0; sx < size; sx++)
                {
                    charBuf[bufIdx++] = pixHi;
                    charBuf[bufIdx++] = pixLo;
                }
            }
        }
    }

    beginSPI();
    setAddressWindow(x, y, x + charW - 1, y + charH - 1);
    SPI.transferBytes(charBuf, nullptr, bufIdx);
    endSPI();
}

void DisplayManager::drawString(uint16_t x, uint16_t y, const char *str,
                                uint16_t color, uint16_t bg, uint8_t size)
{
    uint16_t curX = x;
    uint16_t charW = 6 * size;

    while (*str)
    {
        if (curX + 5 * size > LCD_WIDTH)
            break;
        drawChar(curX, y, *str, color, bg, size);
        curX += charW;
        str++;
    }
}

// ============================================================================
// Status Row Helper — colored dot + label + value
// ============================================================================

void DisplayManager::drawStatusRow(uint16_t y, uint16_t dotColor,
                                   const char *label, const char *value,
                                   uint16_t valueColor)
{
    // Layout for 172px width: dot(4,10x10) + label(20) + value(120)
    fillRect(4, y + 2, 10, 10, dotColor);
    drawString(20, y, label, COLOR_WHITE, COLOR_BG, 2);
    if (value && value[0])
    {
        drawString(120, y, value, valueColor, COLOR_BG, 2);
    }
}

// ============================================================================
// Splash Screen
// ============================================================================

void DisplayManager::showSplash(const char *version)
{
    if (!_initialized)
        return;

    fillScreen(COLOR_BG);

    // "MASH GW" size 3: 7 chars * 18px = 126px, center = (172-126)/2 = 23
    drawString(23, 100, "MASH GW", COLOR_CYAN, COLOR_BG, 3);

    char verStr[32];
    snprintf(verStr, sizeof(verStr), "v%s", version);
    uint16_t verLen = strlen(verStr);
    uint16_t verX = (LCD_WIDTH - verLen * 12) / 2;
    drawString(verX, 145, verStr, COLOR_GRAY, COLOR_BG, 2);

    // "Gateway Hub" size 2: 11 chars * 12px = 132px, center = (172-132)/2 = 20
    drawString(20, 175, "Gateway Hub", COLOR_DARKGRAY, COLOR_BG, 2);

    delay(1500);
}

// ============================================================================
// Error Display
// ============================================================================

void DisplayManager::showError(const char *message)
{
    if (!_initialized)
        return;

    fillRect(0, 130, LCD_WIDTH, 60, COLOR_RED);
    drawString(8, 136, "ERROR", COLOR_WHITE, COLOR_RED, 3);
    drawString(8, 164, message, COLOR_WHITE, COLOR_RED, 1);
}

// ============================================================================
// Status Page Update — 5 Gateway rows (called at ~4Hz from loop)
// ============================================================================

void DisplayManager::update(const DisplayStatus &s)
{
    if (!_initialized)
        return;

    // Do a single full redraw on first update only.
    // Repainting the whole screen every 5s causes visible flicker on ST7789.
    bool fullRedraw = (_lastFullRedraw == 0);

    if (fullRedraw)
    {
        _lastFullRedraw = millis();
        fillScreen(COLOR_BG);

        // Header bar (height 32px)
        fillRect(0, 0, LCD_WIDTH, 32, COLOR_DARKBLUE);
        // "MASH GW" size 3 = 126px, center = (172-126)/2 = 23
        drawString(23, 5, "MASH GW", COLOR_CYAN, COLOR_DARKBLUE, 3);
        drawHLine(0, 32, LCD_WIDTH, COLOR_CYAN);

        // Force all rows to repaint
        _lastNodeCount = -1;
        _lastSensorCount = -1;
        _lastWebApp = -1;
        _lastWiFi = -1;
        _lastRecording = -1;
    }

    // 5 status rows: 320px tall, header 33px, 5 rows with ~54px spacing
    const uint16_t ROW_Y[] = {46, 100, 154, 208, 262};

    // Row 0: Nodes connected (count)
    int8_t nc = (int8_t)s.nodeCount;
    if (nc != _lastNodeCount || fullRedraw)
    {
        _lastNodeCount = nc;
        fillRect(0, ROW_Y[0] - 4, LCD_WIDTH, 24, COLOR_BG);

        char countBuf[4];
        snprintf(countBuf, sizeof(countBuf), "%d", s.nodeCount);
        uint16_t numColor = (s.nodeCount > 0) ? COLOR_GREEN : COLOR_RED;
        drawString(8, ROW_Y[0], countBuf, numColor, COLOR_BG, 2);

        if (s.nodeCount == 1)
        {
            drawString(28, ROW_Y[0], "Node", COLOR_WHITE, COLOR_BG, 2);
        }
        else
        {
            drawString(28, ROW_Y[0], "Nodes", COLOR_WHITE, COLOR_BG, 2);
        }
    }

    // Row 1: Total sensor count
    int8_t sc = (int8_t)s.sensorCount;
    if (sc != _lastSensorCount || fullRedraw)
    {
        _lastSensorCount = sc;
        fillRect(0, ROW_Y[1] - 4, LCD_WIDTH, 24, COLOR_BG);

        char countBuf[4];
        snprintf(countBuf, sizeof(countBuf), "%d", s.sensorCount);
        uint16_t numColor = (s.sensorCount > 0) ? COLOR_GREEN : COLOR_RED;
        drawString(8, ROW_Y[1], countBuf, numColor, COLOR_BG, 2);

        if (s.sensorCount == 1)
        {
            drawString(28, ROW_Y[1], "Sensor", COLOR_WHITE, COLOR_BG, 2);
        }
        else
        {
            drawString(28, ROW_Y[1], "Sensors", COLOR_WHITE, COLOR_BG, 2);
        }
    }

    // Row 2: Web App connected
    int8_t wa = s.webAppConnected ? 1 : 0;
    if (wa != _lastWebApp || fullRedraw)
    {
        _lastWebApp = wa;
        fillRect(0, ROW_Y[2] - 4, LCD_WIDTH, 24, COLOR_BG);
        if (s.webAppConnected)
        {
            drawStatusRow(ROW_Y[2], COLOR_GREEN, "Web App", "OK", COLOR_GREEN);
        }
        else
        {
            drawStatusRow(ROW_Y[2], COLOR_RED, "Web App", "--", COLOR_GRAY);
        }
    }

    // Row 3: WiFi connected
    int8_t wf = s.wifiConnected ? 1 : 0;
    if (wf != _lastWiFi || fullRedraw)
    {
        _lastWiFi = wf;
        fillRect(0, ROW_Y[3] - 4, LCD_WIDTH, 24, COLOR_BG);
        if (s.wifiConnected)
        {
            drawStatusRow(ROW_Y[3], COLOR_GREEN, "WiFi", "OK", COLOR_GREEN);
        }
        else
        {
            drawStatusRow(ROW_Y[3], COLOR_GRAY, "WiFi", "--", COLOR_GRAY);
        }
    }

    // Row 4: Recording
    int8_t rec = s.recording ? 1 : 0;
    if (rec != _lastRecording || fullRedraw)
    {
        _lastRecording = rec;
        fillRect(0, ROW_Y[4] - 4, LCD_WIDTH, 24, COLOR_BG);
        if (s.recording)
        {
            drawStatusRow(ROW_Y[4], COLOR_GREEN, "Rec", "", COLOR_GREEN);
        }
        else
        {
            drawStatusRow(ROW_Y[4], COLOR_GRAY, "Rec", "", COLOR_GRAY);
        }
    }
}
