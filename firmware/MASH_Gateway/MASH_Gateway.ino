/*******************************************************************************
 * MASH_Gateway - Gateway-Only Firmware for ESP32-S3
 *
 * This firmware is specifically for Gateway devices that:
 * - Receive ESP-NOW data from Node devices
 * - Forward aggregated data to PC via USB Serial
 * - Do NOT read sensors directly (no SensorManager)
 *
 * Hardware: Adafruit QT Py ESP32-S3
 ******************************************************************************/

// ============================================================================
// Gateway Role Configuration (MUST be before Config.h)
// ============================================================================
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#include <ArduinoJson.h>
// NOTE: <USB.h> removed — using Hardware CDC (ARDUINO_USB_MODE=1) instead of
// TinyUSB. The USB Serial/JTAG hardware controller provides a stable CDC that
// never re-enumerates on boot, eliminating the stale-endpoint problem that
// caused zero-byte reads in the webapp. Set Arduino IDE > Tools > USB Mode >
// "Hardware CDC and JTAG".
#include <Wire.h>
#include <esp_wifi.h> // For esp_wifi_set_channel() - ESP-NOW/WiFi channel sync
#include <stdarg.h>

// Direct hardware FIFO access for boot diagnostics (bypasses HWCDC class)
#include "hal/usb_serial_jtag_ll.h"

// Include shared modules (copied into this folder for Arduino IDE)
#include "../libraries/IMUConnectCore/src/TDMAProtocol.h"
#include "CommandHandler.h"
#include "Config.h"
#include "SyncFrameBuffer.h"
#include "SyncManager.h"
#include "DisplayManager.h"
#include "WebSocketManager.h"
#include "WiFiManager.h"
#include "WiFiOTAServer.h"

// ============================================================================
// Global Objects
// ============================================================================

// Prevent log text from corrupting the framed USB serial stream during
// streaming. Exported as extern in Config.h so .cpp files can use SAFE_LOG
// macros.
volatile bool suppressSerialLogs = false;

// ============================================================================
// BOOT DIAGNOSTICS
// ============================================================================
// Hold BOOT (GPIO0) during reset/power-on to enter a minimal "safe boot" mode
// that keeps USB Serial alive and avoids WiFi/ESP-NOW/task startup.
// This helps diagnose reboot loops where the port connects/disconnects and
// nothing is printed.
static constexpr int SAFE_BOOT_PIN = 0; // ESP32-S3 BOOT strap pin

// USB CDC buffer sizing can be unstable across core/board variants.
// Default off for stability; enable only if confirmed stable on your build.
#ifndef ENABLE_USB_SERIAL_BUFFER_TUNING
#define ENABLE_USB_SERIAL_BUFFER_TUNING 0
#endif

// Mutex to prevent concurrent Serial.write() from multiple cores/tasks.
// Used by SAFE_LOG macros in .cpp files and SerialTxTask in this file.
// CRITICAL: Must be a FreeRTOS mutex (not portMUX_TYPE spinlock) because
// USB CDC Serial.write() can block waiting for the host to drain data.
// A spinlock (portENTER_CRITICAL) disables interrupts while spinning,
// which triggers the Task Watchdog Timer (TWDT) after ~5 seconds â†’ reboot.
SemaphoreHandle_t serialWriteMutex = nullptr;

static inline void enqueueJsonFrame(const String &json);
static inline void enqueueSerialFrame(const uint8_t *frame, size_t len,
                                      bool isCommandResponse = false);
static void logJson(const char *level, const char *message);
static inline size_t writeUsbFifoDirect(const uint8_t *data, size_t len);
static inline void sendFramedPacketDirect(const uint8_t *payload, size_t len);
static inline void emitCompactSyncStatusDirect();
static inline void emitPipelineDiagDirect();
static inline void emitBootJsonFrameDirect(const char *phase);

class SerialLogGate
{
public:
  void begin(unsigned long baud) { ::Serial.begin(baud); }
  // Delegate to the real Serial operator bool(). With HWCDC this returns
  // true when the USB Serial/JTAG controller is connected to a host.
  explicit operator bool() const { return static_cast<bool>(::Serial); }
  int available() { return ::Serial.available(); }
  int read() { return ::Serial.read(); }
  size_t write(const uint8_t *buffer, size_t size)
  {
    return ::Serial.write(buffer, size);
  }
  size_t write(uint8_t data) { return ::Serial.write(data); }

  // Some Arduino cores (e.g., ESP32) support adjusting serial buffer sizes.
  // If the underlying ::Serial does not provide these methods, they become
  // no-ops.
  void setRxBufferSize(size_t size) { setRxBufferSizeImpl(::Serial, size); }
  void setTxBufferSize(size_t size) { setTxBufferSizeImpl(::Serial, size); }

private:
  template <typename SerialT>
  static auto setRxBufferSizeImpl(SerialT &ser, size_t size)
      -> decltype(ser.setRxBufferSize(size), void())
  {
    ser.setRxBufferSize(size);
  }
  static void setRxBufferSizeImpl(...) {}

  template <typename SerialT>
  static auto setTxBufferSizeImpl(SerialT &ser, size_t size)
      -> decltype(ser.setTxBufferSize(size), void())
  {
    ser.setTxBufferSize(size);
  }
  static void setTxBufferSizeImpl(...) {}

public:
  size_t print(const char *msg)
  {
    if (suppressSerialLogs)
      return 0;
    return ::Serial.print(msg);
  }

  size_t print(const String &msg)
  {
    if (suppressSerialLogs)
      return 0;
    return ::Serial.print(msg);
  }

  template <typename T>
  size_t print(T value)
  {
    if (suppressSerialLogs)
      return 0;
    return ::Serial.print(value);
  }

  size_t println()
  {
    if (suppressSerialLogs)
      return 0;
    return ::Serial.println();
  }

  size_t println(const char *msg)
  {
    if (suppressSerialLogs)
      return 0;
    return ::Serial.println(msg);
  }

  size_t println(const String &msg)
  {
    if (suppressSerialLogs)
      return 0;
    return ::Serial.println(msg);
  }

  template <typename T>
  size_t println(T value)
  {
    if (suppressSerialLogs)
      return 0;
    return ::Serial.println(value);
  }

  int printf(const char *format, ...)
  {
    if (suppressSerialLogs)
      return 0;
    va_list args;
    va_start(args, format);
    int result = ::Serial.vprintf(format, args);
    va_end(args);
    return result;
  }
};

static SerialLogGate SerialGate;

#define Serial SerialGate

Preferences preferences;
SyncManager syncManager;
WiFiManagerESP wifiManager;
WebSocketManager wsManager;
CommandHandler commandHandler;

WiFiOTAServer wifiOTAServer;

// ============================================================================
// SYNC FRAME BUFFER - Cross-Node Timestamp Synchronization (Phase 5)
// ============================================================================
// The SyncFrameBuffer accumulates samples from ALL nodes and only emits
// "Sync Frames" (packet type 0x25) when ALL expected sensors have data for
// the same timestamp. This guarantees cross-node synchronization at the
// packet level, eliminating the need for web app timestamp correlation.
// ============================================================================
SyncFrameBuffer syncFrameBuffer;
bool syncFrameBufferInitialized = false;

// Enable/disable Sync Frame mode (can be toggled via command for debugging)
bool useSyncFrameMode = true;

// ============================================================================
// DEFERRED SYNC RESET — Single reset after all conditions are met
// ============================================================================
// Instead of firing sync resets immediately on START and on each node
// registration, we defer to a single reset fired once ALL of:
//   1. isStreaming == true (webapp connected)
//   2. TDMA state == RUNNING (all nodes discovered, slots assigned)
//   3. SyncFrameBuffer initialized (sensor IDs known)
// This avoids multiple 200ms reset windows that delay data flow.
// ============================================================================
bool pendingSyncReset = false;
// ============================================================================

// NeoPixel pin is set at runtime by detectBoard() via statusLED.setPin().
// Default to NEOPIXEL_PIN (QT Py GPIO39); overridden for Waveshare (GPIO38).
Adafruit_NeoPixel statusLED(1, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
DisplayManager displayManager;

// State variables
bool isStreaming = false;
ConnectionMode currentMode = MODE_BLE;

String deviceName;

// USB Serial command buffer (newline-delimited JSON commands)
static String serialCommandBuffer;

// ============================================================================
// USB SERIAL TX Queue Architecture
// ============================================================================
// Critical: ESP-NOW callbacks run in high-priority Wi-Fi task.
// USB Serial writes must NOT be called from that context - causes instability.
// Solution: Queue frames in callback, drain in dedicated Serial TX task.
// ============================================================================

// ============================================================================
// Frame Buffer Sizing
// ============================================================================
// CRITICAL: Frame buffer must hold entire length-prefixed frame in one entry!
// If split across multiple queue entries, length prefix gets interleaved with
// data from other frames, causing desync on the receiving side.
//
// Serial Frame buffer: Must hold the largest possible SyncFrame packet
// (SYNC_FRAME_MAX_PACKET_SIZE=512) plus 2-byte length prefix = 514 bytes.
// Actual frames for 5 sensors are ~130 bytes. MEMORY NOTE: Each queue entry =
// sizeof(SerialFrame) â‰ˆ SERIAL_FRAME_BUFFER_SIZE + 2.
//   Old: 64 Ã— 702 = 44,928 bytes
//   New: 16 Ã— 514 = 8,224 bytes
// AUDIT FIX 2026-02-08 (MIN-4): Renamed BLEâ†’Serial to reflect actual USB Serial
// transport.
// ============================================================================
static constexpr size_t SERIAL_FRAME_BUFFER_SIZE =
    512; // Fits 20-sensor SyncFrame (490 bytes) + headroom (AUDIT FIX
         // 2026-02-08: was 256, too small for 16 sensors)
static constexpr size_t SERIAL_TX_QUEUE_SIZE =
    64; // 320ms buffer at 200Hz â€” higher burst tolerance on USB CDC
        // when multiple stale slots complete simultaneously. USB CDC at
        // 12 Mbit/s drains faster than enqueue, so extra depth is free
        // headroom.
static constexpr uint32_t SERIAL_BATCH_INTERVAL_MS =
    5; // 200 batches/sec â€” halved from 10ms to reduce transport latency.
       // At <1KB per batch (200Hz Ã— ~130B/frame), USB CDC 12 Mbit/s handles
       // this trivially.
static constexpr uint32_t SERIAL_MAX_BATCH_FRAMES =
    16; // Cap per-batch drain to avoid starving other tasks when backlog
        // spikes.

struct SerialFrame
{
  uint16_t len;
  uint8_t data[SERIAL_FRAME_BUFFER_SIZE];
};

// Compile-time check: largest SyncFrame (0x25 absolute) must fit in serial
// buffer 0x25 packet = 10 header + SYNC_MAX_SENSORS Ã— 24 bytes/sensor + 2
// length prefix
static_assert(10 + SYNC_MAX_SENSORS * 24 + 2 <= SERIAL_FRAME_BUFFER_SIZE,
              "SERIAL_FRAME_BUFFER_SIZE too small for SYNC_MAX_SENSORS!");

static QueueHandle_t serialTxQueue = nullptr;

// Diagnostic counters
static volatile uint32_t serialTxDropCount = 0;
static volatile uint32_t serialTxBatchCount = 0;
static volatile uint32_t serialTxFrameCount = 0;

// Queue overflow detection
static constexpr uint32_t QUEUE_OVERFLOW_WARN_THRESHOLD =
    10; // Drops per interval to warn
static constexpr uint32_t QUEUE_OVERFLOW_CRITICAL_THRESHOLD =
    50;                                         // Drops per interval for critical
static volatile uint32_t lastReportedDrops = 0; // For delta calculation
static volatile bool serialQueueOverloaded =
    false; // Flag for potential throttle signaling

// ============================================================================
// OPP-7: USB Serial Flow Control
// ============================================================================
// When the webapp can't keep up with 200Hz data, it sends {"cmd":"PAUSE"}\n
// to temporarily stop enqueuing frames. {"cmd":"RESUME"}\n resumes.
// This prevents silent frame drops and gives the app control over data flow.
// ============================================================================
static volatile bool serialTxPaused = false;
static volatile uint32_t serialPauseCount = 0;  // Times paused
static volatile uint32_t serialResumeCount = 0; // Times resumed

// ============================================================================
// PROTOCOL TASK (Core 0) - Jitter-Free Beacon & Sync Frame Emission
// ============================================================================
// Critical timing operations run on dedicated Core 0 task:
// - TDMA beacon transmission at exactly 50Hz
// - SyncFrameBuffer management and 0x25 emission
//
// This eliminates jitter from Wi-Fi/BLE contention on Core 1.
// Expected improvement: Beacon jitter from Â±500Âµs to Â±50Âµs
// ============================================================================

static TaskHandle_t protocolTaskHandle = nullptr;
static volatile bool protocolTaskRunning = false;

// Protocol task statistics
static volatile uint32_t beaconTxCount = 0;
static volatile uint32_t beaconJitterMaxUs = 0;
static volatile uint32_t syncFrameEmitCount = 0;

// Forward declaration
void ProtocolTask(void *param);

// Forward declaration
void SerialTxTask(void *param);

// ============================================================================
// DATA INGESTION TASK (Core 1) - ESP-NOW â†’ SyncFrameBuffer Pipeline
// ============================================================================
// Decouples ESP-NOW callback (runs on WiFi task, Core 0, priority ~23)
// from SyncFrameBuffer processing. The callback just enqueues raw packets;
// the DataIngestionTask on Core 1 dequeues, decodes, and calls addSample().
//
// Benefits:
// 1. ESP-NOW callback returns immediately â†’ no WiFi stack stall
// 2. Core 1 gets meaningful work (was nearly idle before)
// 3. Eliminates cross-priority preemption on shared data
// ============================================================================

// Raw ESP-NOW packet for cross-core queuing
// Buffer must fit the LARGEST possible node packet.
// 6-sensor node: 0x23 keyframe â‰ˆ 609B, 0x26 delta â‰ˆ 599B.
// 8-sensor node (max): 0x23 keyframe â‰ˆ 801B.
// 1024 bytes covers all valid topologies with headroom.
// We copy raw data to avoid pointer lifetime issues (callback-only validity).
static constexpr size_t ESPNOW_RX_BUFFER_SIZE = 1024;

struct EspNowRxPacket
{
  uint8_t data[ESPNOW_RX_BUFFER_SIZE];
  uint16_t len; // uint16_t to hold sizes > 255
};

static constexpr size_t ESPNOW_RX_QUEUE_SIZE =
    24; // 24 Ã— 1026 = ~24KB â€” burst absorption for 5-6 nodes during beacon jitter
static QueueHandle_t espNowRxQueue = nullptr;
static TaskHandle_t dataIngestionTaskHandle = nullptr;
static volatile uint32_t espNowRxDropCount = 0;
static volatile uint32_t espNowRxProcessedCount = 0;

// Forward declaration
void DataIngestionTask(void *param);

// Global buffer for deferred processing of mag calibration packets
volatile bool magPacketReceived = false;
ESPNowMagCalibPacket magPacketBuffer;

static inline size_t writeUsbFifoDirect(const uint8_t *data, size_t len)
{
  if (data == nullptr || len == 0)
  {
    return 0;
  }

  size_t offset = 0;
  const uint32_t startMs = millis();
  const uint32_t timeoutMs = 30;

  while (offset < len && (millis() - startMs) < timeoutMs)
  {
    if (!usb_serial_jtag_ll_txfifo_writable())
    {
      delay(1);
      continue;
    }

    size_t remaining = len - offset;
    size_t chunk = (remaining > 64) ? 64 : remaining;
    usb_serial_jtag_ll_write_txfifo(data + offset, chunk);
    usb_serial_jtag_ll_txfifo_flush();
    offset += chunk;
  }

  return offset;
}

static inline void sendFramedPacketDirect(const uint8_t *payload, size_t len)
{
  if (payload == nullptr || len == 0)
  {
    return;
  }

  const uint16_t frameLen = (uint16_t)len;
  uint8_t hdr[2] = {
      (uint8_t)(frameLen & 0xFF),
      (uint8_t)((frameLen >> 8) & 0xFF),
  };

  if (serialWriteMutex != nullptr)
  {
    xSemaphoreTake(serialWriteMutex, portMAX_DELAY);
  }

  writeUsbFifoDirect(hdr, sizeof(hdr));
  writeUsbFifoDirect(payload, len);

  if (serialWriteMutex != nullptr)
  {
    xSemaphoreGive(serialWriteMutex);
  }
}

static inline void emitCompactSyncStatusDirect()
{
  const uint32_t now = millis();
  const TDMANodeInfo *regNodes = syncManager.getRegisteredNodes();
  bool hasAliveNodes = false;
  for (uint8_t i = 0; i < syncManager.getMaxNodes(); i++)
  {
    if (regNodes[i].registered && (now - regNodes[i].lastHeard) < 5000)
    {
      hasAliveNodes = true;
      break;
    }
  }

  const bool tdmaRunning = syncManager.isTDMARunning();
  const bool bufferInitialized = syncFrameBufferInitialized;
  const uint32_t completedFrames = syncFrameBuffer.getCompletedFrames();
  const float syncRate = syncFrameBuffer.getTrueSyncRate();
  const bool bufferReady = bufferInitialized && completedFrames > 0;
  const bool syncQualityOk = (syncRate > 50.0f) || (completedFrames < 10);
  const bool ready = tdmaRunning && hasAliveNodes && bufferReady && syncQualityOk;

  char json[768];
  const int jsonLen = snprintf(
      json, sizeof(json),
      "{\"type\":\"sync_status\",\"tdmaState\":\"%s\",\"isStreaming\":%s,"
      "\"nodeCount\":%u,\"nodes\":[],"
      "\"syncBuffer\":{\"initialized\":%s,\"expectedSensors\":%u,\"completedFrames\":%lu,\"trulyComplete\":%lu,\"partialRecovery\":%lu,\"dropped\":%lu,\"incomplete\":%lu,\"trueSyncRate\":%.2f},"
      "\"serialTx\":{\"frames\":%lu,\"drops\":%lu,\"queueFree\":%u,\"paused\":%s},"
      "\"ready\":%s,\"readiness\":{\"tdmaRunning\":%s,\"hasAliveNodes\":%s,\"bufferReady\":%s,\"syncQualityOk\":%s,\"syncRate\":%.2f}}",
      syncManager.getTDMAStateName(),
      isStreaming ? "true" : "false",
      syncManager.getRegisteredNodeCount(),
      bufferInitialized ? "true" : "false",
      (unsigned int)syncFrameBuffer.getExpectedSensorCount(),
      (unsigned long)completedFrames,
      (unsigned long)syncFrameBuffer.getTrulyCompleteFrames(),
      (unsigned long)syncFrameBuffer.getPartialRecoveryFrames(),
      (unsigned long)syncFrameBuffer.getDroppedFrames(),
      (unsigned long)syncFrameBuffer.getIncompleteFrames(),
      syncRate,
      (unsigned long)serialTxFrameCount,
      (unsigned long)serialTxDropCount,
      (unsigned int)(serialTxQueue ? uxQueueSpacesAvailable(serialTxQueue) : 0),
      serialTxPaused ? "true" : "false",
      ready ? "true" : "false",
      tdmaRunning ? "true" : "false",
      hasAliveNodes ? "true" : "false",
      bufferReady ? "true" : "false",
      syncQualityOk ? "true" : "false",
      syncRate);

  if (jsonLen <= 0)
  {
    return;
  }

  size_t safeLen = (size_t)jsonLen;
  if (safeLen >= sizeof(json))
  {
    safeLen = sizeof(json) - 1;
  }

  const uint16_t payloadLen = (uint16_t)(1 + safeLen);
  uint8_t frame[2 + 1 + sizeof(json)];
  frame[0] = (uint8_t)(payloadLen & 0xFF);
  frame[1] = (uint8_t)((payloadLen >> 8) & 0xFF);
  frame[2] = 0x06;
  memcpy(frame + 3, json, safeLen);

  writeUsbFifoDirect(frame, 3 + safeLen);
}

static inline void emitPipelineDiagDirect()
{
  char json[320];
  const int jsonLen = snprintf(
      json, sizeof(json),
      "{\"type\":\"gateway_pipeline_diag\",\"uptime_ms\":%lu,\"isStreaming\":%s,\"tdmaRunning\":%s,\"nodeCount\":%u,\"espNowRxProcessed\":%lu,\"espNowRxDropped\":%lu,\"syncFramesEmitted\":%lu,\"beacons\":%lu}",
      (unsigned long)millis(),
      isStreaming ? "true" : "false",
      syncManager.isTDMARunning() ? "true" : "false",
      (unsigned int)syncManager.getRegisteredNodeCount(),
      (unsigned long)espNowRxProcessedCount,
      (unsigned long)espNowRxDropCount,
      (unsigned long)syncFrameEmitCount,
      (unsigned long)beaconTxCount);

  if (jsonLen <= 0)
  {
    return;
  }

  size_t safeLen = (size_t)jsonLen;
  if (safeLen >= sizeof(json))
  {
    safeLen = sizeof(json) - 1;
  }

  const uint16_t payloadLen = (uint16_t)(1 + safeLen);
  uint8_t frame[2 + 1 + sizeof(json)];
  frame[0] = (uint8_t)(payloadLen & 0xFF);
  frame[1] = (uint8_t)((payloadLen >> 8) & 0xFF);
  frame[2] = 0x06;
  memcpy(frame + 3, json, safeLen);

  writeUsbFifoDirect(frame, 3 + safeLen);
}

static inline void emitBootJsonFrameDirect(const char *phase)
{
  if (phase == nullptr)
  {
    phase = "unknown";
  }

  char json[180];
  int jsonLen = snprintf(json, sizeof(json),
                         "{\"type\":\"usb_boot\",\"phase\":\"%s\",\"uptime_ms\":%lu}",
                         phase, (unsigned long)millis());
  if (jsonLen <= 0)
  {
    return;
  }
  if (jsonLen >= (int)sizeof(json))
  {
    jsonLen = (int)sizeof(json) - 1;
  }

  const uint16_t payloadLen = (uint16_t)(1 + jsonLen);
  uint8_t frame[2 + 1 + sizeof(json)];
  frame[0] = (uint8_t)(payloadLen & 0xFF);
  frame[1] = (uint8_t)((payloadLen >> 8) & 0xFF);
  frame[2] = 0x06;
  memcpy(frame + 3, json, (size_t)jsonLen);

  writeUsbFifoDirect(frame, (size_t)(3 + jsonLen));
}

// ============================================================================
// Setup
// ============================================================================

void setup()
{
  // -----------------------------------------------------------------------
  // HARDWARE CDC MODE (ARDUINO_USB_MODE=1)
  //
  // We use the ESP32-S3's built-in USB Serial/JTAG hardware controller
  // instead of TinyUSB (USB OTG). Key advantages:
  //   - NO re-enumeration on boot — the hardware CDC is active from ROM
  //     through application startup, so the host always sees the same device
  //   - NO DTR dependency for writes — the hardware manages its own TX FIFO
  //   - NO stale USB endpoints in the browser's Web Serial connection
  //   - NO accidental bootloader entry from DTR/RTS toggling
  //
  // Arduino IDE settings required:
  //   Tools > USB Mode > "Hardware CDC and JTAG"
  //   Tools > USB CDC On Boot > "Enabled"
  // -----------------------------------------------------------------------
  Serial.begin(921600);

  // -----------------------------------------------------------------------
  // HWCDC Connection Wait
  //
  // HWCDC::operator bool() calls isCDC_Connected() which probes the USB
  // Serial/JTAG TX FIFO. The host must acknowledge an IN token for the
  // SERIAL_IN_EMPTY ISR to fire and set `connected = true`. Without this
  // wait, early Serial.write() calls go through flushTXBuffer() which
  // churns a 256-byte ring buffer without actually transmitting to the host.
  //
  // The loop also prevents a race where a USB BUS_RESET (triggered by the
  // host opening the port) clears `connected` during a passive delay().
  // Active polling re-establishes the connection immediately.
  // -----------------------------------------------------------------------
  {
    uint32_t waitStart = millis();
    const uint32_t HWCDC_CONNECT_TIMEOUT_MS = 5000;
    while (!Serial && (millis() - waitStart < HWCDC_CONNECT_TIMEOUT_MS))
    {
      delay(10);
    }
    if (!Serial)
    {
      // Host not connected — write directly to hardware FIFO as diagnostic.
      // This bypasses HWCDC's ring buffer and connected flag entirely.
      const char *msg = "[Boot] HWCDC TIMEOUT - no host detected\r\n";
      usb_serial_jtag_ll_write_txfifo((const uint8_t *)msg, strlen(msg));
      usb_serial_jtag_ll_txfifo_flush();
    }
  }

  // Create FreeRTOS mutex for serial write protection (must happen early,
  // before any tasks are created or SAFE_LOG macros are used from .cpp files).
  serialWriteMutex = xSemaphoreCreateMutex();

  // Early boot banner via the raw USB CDC Serial (not gated by
  // suppressSerialLogs). If you see nothing at all, the device is likely
  // resetting before/at USB init.
  ::Serial.println("\n[Boot] USB CDC up");
  emitBootJsonFrameDirect("post_connect_wait");

  // ============================================================================
  // AUTO-DETECT BOARD (probes QMI8658 on Waveshare I2C pins)
  // Must happen BEFORE Wire.begin() and any hardware init.
  // ============================================================================
  detectBoard();

  // Board-specific hardware initialization based on detection.
  // ESP32-S3-LCD-1.47 has no SYS_EN power gate â€” nothing to assert here.
  // Update NeoPixel pin to match detected board.
  statusLED.setPin(boardNeoPixelPin);
  ::Serial.printf("[Setup] Board: %s, NeoPixel pin: %d\n",
                  (detectedBoard == BOARD_WAVESHARE_LCD_147) ? "Waveshare 1.47" : "QT Py",
                  boardNeoPixelPin);

  // SAFE BOOT: hold BOOT button (GPIO0 low) during boot.
  pinMode(SAFE_BOOT_PIN, INPUT_PULLUP);
  const bool safeBoot = (digitalRead(SAFE_BOOT_PIN) == LOW);
  if (safeBoot)
  {
    ::Serial.println("[Boot] SAFE BOOT mode active (BOOT held)");
    ::Serial.println(
        "[Boot] Skipping WiFi/ESP-NOW/tasks. USB should stay stable.");

    // Minimal NeoPixel power-on so you have a visual heartbeat.
    if (boardHasNeoPixel)
    {
      if (boardNeoPixelNeedsPower)
      {
        pinMode(NEOPIXEL_POWER_PIN, OUTPUT);
        digitalWrite(NEOPIXEL_POWER_PIN, HIGH);
        delay(50);
      }
      statusLED.begin();
      statusLED.setBrightness(20);
    }

    while (true)
    {
      if (boardHasNeoPixel)
      {
        // Purple blink
        statusLED.setPixelColor(0, statusLED.Color(60, 0, 60));
        statusLED.show();
      }
      ::Serial.println("[SAFEBOOT] alive");
      delay(500);
      if (boardHasNeoPixel)
      {
        statusLED.setPixelColor(0, statusLED.Color(0, 0, 0));
        statusLED.show();
      }
      delay(500);
    }
  }

  // NOTE: Using Hardware CDC mode (ARDUINO_USB_MODE=1). No TinyUSB
  // descriptor calls needed - the USB Serial/JTAG controller uses
  // fixed descriptors managed by the ESP32-S3 hardware.
#if ENABLE_USB_SERIAL_BUFFER_TUNING
  // Increase USB Serial buffers to reduce jitter during bursts.
  // Keep TX conservative to avoid large heap allocations that can destabilize
  // USB.
  Serial.setRxBufferSize(4096);
  Serial.setTxBufferSize(16384);
#endif

  Serial.println("\n\n*** ESP32 GATEWAY STARTING ***\n");
  Serial.println("========================================");
  Serial.println("   MASH - Gateway Firmware");
  Serial.println("   VERSION: 2026-02-09 WIFI_PS_FIX v7");
  Serial.println("   Role: GATEWAY (No Local Sensors)");
  Serial.println("   Optimizations: PSRAM + Dual-Core");
  Serial.println("========================================\n");

  // ============================================================================
  // PSRAM Detection & Reporting
  // ============================================================================
  if (psramFound())
  {
    Serial.printf("[Setup] PSRAM detected: %u bytes total, %u bytes free\n",
                  ESP.getPsramSize(), ESP.getFreePsram());
  }
  else
  {
    Serial.println(
        "[Setup] WARNING: No PSRAM detected! Falling back to internal SRAM.");
  }

  // Pre-allocate SyncFrameBuffer slots in PSRAM (before other allocations)
  if (!syncFrameBuffer.allocateSlots())
  {
    Serial.println("[Setup] CRITICAL: SyncFrameBuffer slot allocation failed!");
  }

  // Initialize NeoPixel
  if (boardHasNeoPixel)
  {
    if (boardNeoPixelNeedsPower)
    {
      // QT Py requires powering the NeoPixel via a separate GPIO
      pinMode(NEOPIXEL_POWER_PIN, OUTPUT);
      digitalWrite(NEOPIXEL_POWER_PIN, HIGH);
      delay(100);
    }
    statusLED.begin();
    statusLED.setBrightness(30);
  }
  showStartupAnimation();

  setStatusColor(50, 50, 0); // Yellow = initializing

  // Initialize I2C only if the board has I2C pins (Waveshare 1.47" has none)
  if (boardSDA > 0 && boardSCL > 0)
  {
    Wire.begin(boardSDA, boardSCL);
    Wire.setClock(400000);
    Serial.printf("[Setup] I2C initialized on SDA=%d SCL=%d\n", boardSDA, boardSCL);
  }
  else
  {
    Serial.println("[Setup] No I2C on this board â€” skipping Wire.begin()");
  }

  // Initialize command handler with callbacks
  commandHandler.setStartCallback(onStartStreaming);
  commandHandler.setStopCallback(onStopStreaming);
  commandHandler.setSampleRateCallback(onSetSampleRate);
  commandHandler.setAccelRangeCallback(onSetAccelRange);
  commandHandler.setGyroRangeCallback(onSetGyroRange);
  commandHandler.setSwitchModeCallback(onSwitchMode);
  commandHandler.setStatusCallback(onGetStatus);
  commandHandler.setSyncStatusCallback(onGetSyncStatus);
  commandHandler.setCalibrateCallback(onCalibrate);
  commandHandler.setCalibrateGyroCallback(onCalibrateGyro);

  // Discovery Lock / Late-Join Control
  commandHandler.setDiscoveryLockCallback(onDiscoveryLock);
  commandHandler.setTDMARescanCallback(onTDMARescan);
  commandHandler.setAcceptNodeCallback(onAcceptNode);
  commandHandler.setRejectNodeCallback(onRejectNode);
  commandHandler.setPendingNodesCallback(onGetPendingNodes);
  commandHandler.setWiFiCallback(onSetWiFi);
  commandHandler.setWiFiConnectCallback(onConnectWiFi);
  commandHandler.setWiFiStatusCallback(onGetWiFiStatus);
  commandHandler.setOutputModeCallback(onSetOutputMode);
  commandHandler.setFilterBetaCallback(onSetFilterBeta);
  commandHandler.setSetNameCallback(onSetName);
  commandHandler.setSyncRoleCallback(onSetSyncRole);
  commandHandler.setGetCalibrationCallback(onGetCalibration);
  commandHandler.setZuptCallback(onSetZupt);
  commandHandler.setWiFiScanCallback(
      []() -> String
      { return wifiManager.scanNetworks(); });
  commandHandler.setStartSoftAPCallback(
      [](const char *ssid, const char *password) -> bool
      {
        bool success = wifiManager.startAP(ssid, password);
        if (success)
        {
          wifiOTAServer.init();
        }
        return success;
      });
  commandHandler.setStopSoftAPCallback([]()
                                       { wifiManager.stopAP(); });
  commandHandler.setGetSoftAPStatusCallback(
      []() -> bool
      { return wifiManager.isAPActive(); });

  // OTA Callbacks
  // OTA Callbacks - BLE OTA is deprecated, these do nothing or could be removed
  // if CommandHandler supports optional callbacks
  commandHandler.setOTAStartCallback(
      [](uint32_t size, const char *md5) -> bool
      {
        Serial.println("[Gateway] BLE OTA is deprecated. Use WiFi OTA.");
        return false;
      });
  commandHandler.setOTAAbortCallback(
      []()
      { Serial.println("[Gateway] BLE OTA Abort (No-op)"); });

  // Magnetometer calibration callback - forwards to Nodes via ESP-NOW
  commandHandler.setMagCalibCallback([](uint8_t cmdType, uint32_t param)
                                     {
                                       Serial.printf("[Gateway] Forwarding mag calib cmd: type=%d param=%lu\n",
                                                     cmdType, param);
                                       syncManager.sendMagCalibCommand(cmdType, param,
                                                                       0xFF); // Broadcast to all nodes
                                     });

  // Note: Gateway doesn't have local sensors - calibration clear would need
  // to be forwarded to Nodes via ESP-NOW (not implemented here)
  // For local Gateway sensors, add SensorManager instance and wire callback

  // Load saved device name
  preferences.begin("imu_config", true);
  deviceName = preferences.getString("device_name", BLE_DEVICE_NAME);
  preferences.end();
  deviceName += "_Gateway";

  Serial.printf("[MASH Gateway] USB Serial ready as '%s'...\n",
                deviceName.c_str());

  // ============================================================================
  // Serial TX Queue - sized for 5-sensor SyncFrames, not worst-case 20-sensor
  // ============================================================================
  // SerialFrame is 514 bytes Ã— 16 entries = ~8KB
  // Standard xQueueCreate for maximum compatibility across Arduino-ESP32
  // versions.
  // ============================================================================
  serialTxQueue = xQueueCreate(SERIAL_TX_QUEUE_SIZE, sizeof(SerialFrame));
  if (serialTxQueue == nullptr)
  {
    Serial.println("[ERROR] Failed to create Serial TX queue!");
  }
  else
  {
    Serial.printf("[Setup] Serial TX queue created (%d Ã— %d = %d bytes)\n",
                  SERIAL_TX_QUEUE_SIZE, sizeof(SerialFrame),
                  SERIAL_TX_QUEUE_SIZE * sizeof(SerialFrame));
    Serial.printf("[Setup] Heap after serial queue: %u bytes free\n",
                  ESP.getFreeHeap());
  }

  // Serial TX Task: Batched USB writes
  // Priority 2 = above idle, below critical tasks
  // Pin to Core 0 to keep Core 1 free for VQF/Data processing
  xTaskCreatePinnedToCore(SerialTxTask,   // Task function
                          "SerialTxTask", // Name
                          8192,           // Stack size
                          nullptr,        // Parameters
                          2,              // Priority
                          nullptr,        // Task handle (not needed)
                          0               // Core 0 (System Core)
  );
  Serial.println("[Setup] Serial TX task pinned to Core 0");

  // ============================================================================
  // ESP-NOW RX Queue + Data Ingestion Task (Core 1)
  // ============================================================================
  // Raw ESP-NOW packets are enqueued by the callback on Core 0 and processed
  // by DataIngestionTask on Core 1. This distributes load across both cores
  // and keeps the WiFi callback fast (<5Âµs per packet).
  // ============================================================================
  espNowRxQueue = xQueueCreate(ESPNOW_RX_QUEUE_SIZE, sizeof(EspNowRxPacket));
  if (espNowRxQueue == nullptr)
  {
    Serial.println("[ERROR] Failed to create ESP-NOW RX queue!");
  }
  else
  {
    Serial.printf("[Setup] ESP-NOW RX queue created (%d entries, %d bytes)\n",
                  ESPNOW_RX_QUEUE_SIZE,
                  (int)(ESPNOW_RX_QUEUE_SIZE * sizeof(EspNowRxPacket)));
  }

  // Data Ingestion Task: dequeues raw packets and feeds SyncFrameBuffer
  // Priority 3 = above Idle, but doesn't block critical tasks
  xTaskCreatePinnedToCore(DataIngestionTask,        // Task function
                          "DataIngest",             // Name
                          8192,                     // Stack size
                          nullptr,                  // Parameters
                          3,                        // Priority
                          &dataIngestionTaskHandle, // Task handle
                          1                         // Core 1 (data processing)
  );
  Serial.println("[Setup] Data Ingestion task pinned to Core 1");

  // ============================================================================
  // Protocol Task: Beacon TX + Sync Frame Emission (Core 0)
  // ============================================================================
  // MUST stay on Core 0: syncManager.update() calls esp_now_send() which
  // interacts with the WiFi stack pinned to Core 0. SyncManager state is
  // also accessed from ESP-NOW callbacks (Core 0). The SyncFrameBuffer
  // spinlock safely handles cross-core reads from ProtocolTask (Core 0)
  // while DataIngestionTask writes from Core 1.
  //
  // Sync/Protocol Task: Handles Beacons and TDMA state (Core 0 only)
  // Priority 3 = Real-time radio operations
  xTaskCreatePinnedToCore(ProtocolTask,        // Task function
                          "ProtocolTask",      // Name
                          8192,                // Stack size (bytes)
                          nullptr,             // Parameters
                          3,                   // Priority
                          &protocolTaskHandle, // Task handle
                          0                    // Core 0 (WiFi/ESP-NOW stack)
  );
  Serial.println(
      "[Setup] Protocol Task pinned to Core 0 (jitter-free beacons enabled)");
  // ============================================================================

  // Initialize WiFi manager
  Serial.println("[Setup] Initializing WiFi manager...");
  wifiManager.init();

  // ============================================================================
  // PRINT GATEWAY MAC ADDRESS - Now that WiFi is initialized!
  // ============================================================================
  {
    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac); // Use esp_wifi API for reliability
    Serial.println("\n*** IMPORTANT: GATEWAY MAC ADDRESS ***");
    Serial.printf("MAC: %02X:%02X:%02X:%02X:%02X:%02X\n", mac[0], mac[1],
                  mac[2], mac[3], mac[4], mac[5]);
    Serial.printf("For Node Config.h, use: {0x%02X, 0x%02X, 0x%02X, 0x%02X, "
                  "0x%02X, 0x%02X}\n",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    Serial.println("========================================\n");
  }

  // Initialize WiFi
  // CRITICAL STABILITY FIX: Disable WiFi Power Save
  // ESP-NOW + BLE coexistence requires the radio to be always on.
  // Default power save (DTIM) causes radio to sleep, leading to packet loss,
  // sync failure, and eventually BLE connection termination.
  WiFi.mode(WIFI_AP_STA);
  esp_wifi_set_ps(WIFI_PS_NONE);
  Serial.println(
      "[Setup] WiFi Power Save DISABLED (Required for ESP-NOW stability)");

  // Initialize ESP-NOW Sync Manager
  syncManager.init(deviceName.c_str());
  syncManager.setRole(SYNC_ROLE_MASTER); // Gateway controls time
  Serial.println("[Setup] SyncRole set to MASTER");

  // Force streaming startup so data forwarding does not depend on host
  // command RX reliability during bring-up.
  onStartStreaming();
  emitBootJsonFrameDirect("streaming_forced_on");

  // FIX #2: EXPLICITLY SET WIFI CHANNEL FOR ESP-NOW
  // Critical: WiFi.channel() returns 0 when ESP32 is in STA mode without
  // an active connection. This causes beacons to include channel=0, which
  // breaks Node synchronization.
  //
  // Solution: Explicitly set channel 1 for ESP-NOW communication
  // (ESP-NOW supports channels 0-14, channel 1 is default for ESP32 STA mode)
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  Serial.println("[Setup] ESP-NOW channel explicitly set to 1 (prevents "
                 "channel=0 in beacons)");

  // Note: If WiFi router connection is enabled later, the channel will
  // auto-sync to the router's channel (see lines 545-549 in loop())

  // Set up callback to forward ESP-NOW packets to USB Serial
  syncManager.setDataCallback([](const uint8_t *data, int len)
                              {
    static uint32_t callbackCount = 0;
    static unsigned long lastDiagLog = 0;
    callbackCount++;

    // Periodic diagnostic output
    if (millis() - lastDiagLog > 3000) {
      Serial.printf("[DIAG] Callback invoked %d times, isStreaming=%d, "
                    "sizeof(ESPNowDataPacket)=%d\n",
                    callbackCount, isStreaming, sizeof(ESPNowDataPacket));
      callbackCount = 0;
      lastDiagLog = millis();
    }

    if (len < 1)
      return;

    uint8_t packetType = data[0];

    // NodeInfo packets (0x05) should ALWAYS be forwarded for discovery
    if (packetType == 0x05) {
      if (len >= 37) {
        // ================================================================
        // IDENTITY FIX: Translate sensorIdOffset from raw nodeId to
        // compact base ID so the webapp sensor→node map matches the
        // compact IDs used in 0x25 SyncFrame packets.
        //
        // Raw nodeId (e.g., 88) is derived from MAC XOR on the Node.
        // Compact base (e.g., 1) is the sequential ID assigned by the
        // Gateway's TDMA registration order. SyncFrameBuffer uses
        // compact IDs in 0x25 frames, so NodeInfo must match.
        // ================================================================
        uint8_t rawNodeId = data[33]; // sensorIdOffset field
        uint8_t compactBase = syncManager.getCompactSensorId(rawNodeId, 0);

        if (compactBase > 0) {
          // Node is TDMA-registered — translate and forward
          uint8_t buf[64];
          size_t copyLen = ((size_t)len <= sizeof(buf)) ? (size_t)len : sizeof(buf);
          memcpy(buf, data, copyLen);
          buf[33] = compactBase; // Replace sensorIdOffset with compact base
          enqueueSerialFrame(buf, copyLen);
        } else {
          // Node not yet TDMA-registered — suppress until registered.
          // The webapp will learn about this node from sync_status or
          // the next NodeInfo in 10s once registration completes.
        }

        static uint32_t lastNodeLog = 0;
        if (millis() - lastNodeLog > 2000) {
          Serial.printf("[Gateway] NodeInfo: rawId=%d compactBase=%d (%d bytes)\n",
                        rawNodeId, compactBase, len);
          lastNodeLog = millis();
        }
      }
      return;
    }

    // Magnetometer Calibration Progress (0x07) should ALWAYS be processed
    if (packetType == MAG_CALIB_PACKET) {
      if (len == sizeof(ESPNowMagCalibPacket)) {
        // Defer processing to main loop to avoid blocking ISR
        memcpy(&magPacketBuffer, data, sizeof(ESPNowMagCalibPacket));
        magPacketReceived = true;
      }
      return;
    }

    // Keep data path active regardless of isStreaming. Command path issues
    // should not block node ingestion/repackaging.

    if (packetType == 0x03) { // LEGACY FORMAT - REJECTED!
      // ========================================================================
      // TDMA-ONLY MODE: Legacy 0x03 packets are NO LONGER supported
      // If you see this error, reflash Node firmware with TDMA support
      // ========================================================================
      static unsigned long lastRejectLog = 0;
      if (millis() - lastRejectLog > 5000) {
        Serial.println("[ERROR] ========================================");
        Serial.println("[ERROR] Received LEGACY 0x03 packet - REJECTED!");
        Serial.println("[ERROR] System is TDMA-only (0x23 packets)");
        Serial.println("[ERROR] Reflash Node firmware immediately!");
        Serial.println("[ERROR] ========================================");
        lastRejectLog = millis();
      }
      // DO NOT FORWARD - System will not work until Nodes use TDMA
    } else if (packetType == 0x04) { // Environmental Data
      ESPNowEnviroPacket packet;
      if (len == sizeof(ESPNowEnviroPacket)) {
        memcpy(&packet, data, sizeof(packet));

        // Reconstruct for BLE (31 bytes total)
        // Format: [0x04][hasMag][hasBaro][mag(16)][baro(12)]
        uint8_t buffer[31];
        buffer[0] = 0x04;
        buffer[1] = packet.hasMag;
        buffer[2] = packet.hasBaro;

        // Copy magnetometer data (16 bytes) at offset 3
        memcpy(buffer + 3, &packet.mag[0], 16);

        // Copy barometer data (12 bytes) at offset 19
        memcpy(buffer + 19, &packet.baro[0], 12);

        // Enqueue length-prefixed environmental frame
        enqueueSerialFrame(buffer, 31);
      } else {
        static unsigned long lastEnvLog = 0;
        if (millis() - lastEnvLog > 1000) {
          Serial.printf("[DIAG] 0x04 SIZE MISMATCH: got %d, expected %d\n", len,
                        sizeof(ESPNowEnviroPacket));
          lastEnvLog = millis();
        }
      }
    } else if (packetType ==
               MAG_CALIB_PACKET) { // Magnetometer Calibration Progress
      if (len == sizeof(ESPNowMagCalibPacket)) {
        // Defer processing to main loop to avoid blocking ISR
        memcpy(&magPacketBuffer, data, sizeof(ESPNowMagCalibPacket));
        magPacketReceived = true;
      }
    } else if (packetType == TDMA_PACKET_DATA) { // TDMA Batched IMU Data (0x23)
      // ========================================================================
      // DUAL-CORE PIPELINE: Enqueue raw packet for Core 1 processing
      // ========================================================================
      // Instead of processing here (WiFi callback, Core 0, priority ~23),
      // we just copy the raw packet into the RX queue. DataIngestionTask on
      // Core 1 handles decoding and SyncFrameBuffer insertion.
      // This keeps the callback under 5Âµs and prevents WiFi stack stalls.
      // ========================================================================

      TDMADataPacket *tdmaV1 = (TDMADataPacket *)data;
      uint8_t nodeId = tdmaV1->nodeId;

      // Update lastHeard (lightweight, no queue needed)
      syncManager.updateNodeLastHeard(nodeId);

      // Enqueue for Core 1 processing
      if (espNowRxQueue != nullptr && useSyncFrameMode &&
          syncFrameBufferInitialized) {
        EspNowRxPacket rxPkt;
        rxPkt.len = (len <= sizeof(rxPkt.data)) ? len : sizeof(rxPkt.data);
        memcpy(rxPkt.data, data, rxPkt.len);
        if (len > sizeof(rxPkt.data)) {
          static uint32_t lastTruncWarn = 0;
          if (millis() - lastTruncWarn > 5000) {
            Serial.printf("[WARN] ESP-NOW packet TRUNCATED: %d -> %d bytes! "
                          "Increase ESPNOW_RX_BUFFER_SIZE\n",
                          len, (int)sizeof(rxPkt.data));
            lastTruncWarn = millis();
          }
        }
        if (xQueueSend(espNowRxQueue, &rxPkt, 0) != pdTRUE) {
          espNowRxDropCount++;
        }
      }

      // Periodic logging
      static uint32_t lastTdmaLog = 0;
      static uint32_t tdmaPacketCount = 0;
      tdmaPacketCount++;
      if (millis() - lastTdmaLog > 2000) {
        Serial.printf("[TDMA] RX: %lu pkts, last: node=%d syncMode=%d\n",
                      tdmaPacketCount, nodeId, useSyncFrameMode);
        tdmaPacketCount = 0;
        lastTdmaLog = millis();
      }
    } else if (packetType ==
               TDMA_PACKET_DATA_DELTA) { // Node Delta-Encoded Data (0x26)
      // ========================================================================
      // DUAL-CORE PIPELINE: Enqueue raw 0x26 packet for Core 1 processing
      // ========================================================================
      // Same approach as 0x23 â€” just enqueue, let DataIngestionTask handle it.
      // ========================================================================

      // Extract nodeId for lastHeard update (lightweight)
      if (len >= TDMA_NODE_DELTA_HEADER_SIZE) {
        const TDMANodeDeltaPacket *header = (const TDMANodeDeltaPacket *)data;
        syncManager.updateNodeLastHeard(header->nodeId);
      }

      if (espNowRxQueue != nullptr && useSyncFrameMode &&
          syncFrameBufferInitialized) {
        EspNowRxPacket rxPkt;
        rxPkt.len = (len <= sizeof(rxPkt.data)) ? len : sizeof(rxPkt.data);
        memcpy(rxPkt.data, data, rxPkt.len);
        if (len > sizeof(rxPkt.data)) {
          static uint32_t lastTruncWarn26 = 0;
          if (millis() - lastTruncWarn26 > 5000) {
            Serial.printf(
                "[WARN] ESP-NOW 0x26 packet TRUNCATED: %d -> %d bytes!\n", len,
                (int)sizeof(rxPkt.data));
            lastTruncWarn26 = millis();
          }
        }
        if (xQueueSend(espNowRxQueue, &rxPkt, 0) != pdTRUE) {
          espNowRxDropCount++;
        }
      }
    } });

  // Set callback for when new nodes register during TDMA discovery
  // This ensures SyncFrameBuffer is updated with expected sensors immediately
  syncManager.setNodeRegisteredCallback([](uint8_t nodeId,
                                           uint8_t sensorCount)
                                        {
    if (useSyncFrameMode) {
      // Get updated sensor list from SyncManager
      uint8_t expectedSensorIds[SYNC_MAX_SENSORS];
      uint8_t totalSensors =
          syncManager.getExpectedSensorIds(expectedSensorIds, SYNC_MAX_SENSORS);

      if (totalSensors > 0) {
        // Late-initialize or update the SyncFrameBuffer
        if (!syncFrameBufferInitialized) {
          syncFrameBuffer.init(expectedSensorIds, totalSensors);
          syncFrameBufferInitialized = true;
          Serial.printf("[SyncFrame] Late-initialized with %d sensors: ",
                        totalSensors);
        } else {
          syncFrameBuffer.setExpectedSensors(expectedSensorIds, totalSensors);
        }
        for (uint8_t i = 0; i < totalSensors; i++) {
          Serial.printf("%d ", expectedSensorIds[i]);
        }
        Serial.println();

        // ======================================================================
        // DEFERRED SYNC RESET: When a new node joins during streaming, flag
        // a pending reset rather than firing immediately. ProtocolTask will
        // fire a single reset once TDMA is RUNNING + buffer is init'd.
        // This avoids stacking multiple 200ms reset windows per node.
        // ======================================================================
        if (isStreaming) {
          Serial.printf("[SYNC] New node %d registered during streaming - "
                        "deferring SYNC_RESET\n",
                        nodeId);
          pendingSyncReset = true;
          syncFrameBuffer.reset(); // Clear buffer to avoid stale samples
        }
      }
    } });

  // Set callback for when inactive nodes are pruned (NVS stale topology fix)
  // This ensures SyncFrameBuffer no longer emits phantom sensor IDs from
  // nodes that went offline. Without this, stale NVS entries inflate
  // expectedSensorCount and produce IDs like 101 in 0x25 frames.
  syncManager.setNodePrunedCallback([]()
                                    {
    if (useSyncFrameMode && syncFrameBufferInitialized) {
      uint8_t expectedSensorIds[SYNC_MAX_SENSORS];
      uint8_t totalSensors =
          syncManager.getExpectedSensorIds(expectedSensorIds, SYNC_MAX_SENSORS);

      if (totalSensors > 0) {
        syncFrameBuffer.setExpectedSensors(expectedSensorIds, totalSensors);
        Serial.printf("[SyncFrame] Pruned â†’ updated to %d sensors: ",
                      totalSensors);
        for (uint8_t i = 0; i < totalSensors; i++) {
          Serial.printf("%d ", expectedSensorIds[i]);
        }
        Serial.println();
      } else {
        // All nodes pruned â€” reset the buffer entirely
        syncFrameBuffer.reset();
        syncFrameBufferInitialized = false;
        Serial.println("[SyncFrame] All nodes pruned â€” buffer reset");
      }
    } });

  // Set callback for when a node is queued as pending (discovery locked)
  // Pushes a JSON notification to the webapp via the serial TX queue
  syncManager.setNodePendingCallback([](const SyncManager::PendingNode &node)
                                     {
    StaticJsonDocument<256> doc;
    doc["type"] = "node_pending";
    doc["nodeId"] = node.nodeId;
    doc["name"] = node.nodeName;
    doc["sensorCount"] = node.sensorCount;
    doc["hasMag"] = node.hasMag;
    doc["hasBaro"] = node.hasBaro;

    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             node.mac[0], node.mac[1], node.mac[2],
             node.mac[3], node.mac[4], node.mac[5]);
    doc["mac"] = macStr;

    String output;
    serializeJson(doc, output);
    enqueueJsonFrame(output);
    Serial.printf("[TDMA] Pushed node_pending notification for node %d (%s)\n",
                  node.nodeId, node.nodeName); });

  Serial.println(
      "[Setup] Gateway Mode: ESP-NOW â†’ USB Serial forwarding enabled");

  // Initialize WebSocket
  // wsManager.begin(); // Removed: method does not exist
  wsManager.setMessageCallback([&](const String &msg)
                               {
    String response = commandHandler.processCommand(msg);
    wsManager.broadcast(response); });

  // WiFi connection is OPTIONAL - only connect if user explicitly requests it
  // Without WiFi router connection, ESP-NOW uses default channel 1
  // To enable auto-connect, uncomment the lines below:
  // if (wifiManager.hasSavedCredentials()) {
  //   Serial.println("[Setup] Attempting to connect to saved WiFi...");
  //   wifiManager.connectAsync();
  // }
  Serial.println("[Setup] WiFi auto-connect disabled (ESP-NOW on channel 1)");

  // Streaming is disabled at boot. The web app sends {"cmd":"START"} after
  // connecting, which calls onStartStreaming() â†’ sets isStreaming=true and
  // suppressSerialLogs=true. Until then, Serial Monitor shows text logs.
  suppressSerialLogs = false;
  isStreaming = false;
  Serial.println("[Setup] Streaming disabled until START command");

  // ============================================================================
  // BACKGROUND DISCOVERY: Start TDMA immediately (Warm Standby)
  // ============================================================================
  // Starting TDMA in setup() allows nodes to register and send metadata
  // immediately upon boot, even before the webapp connects.
  // Since isStreaming is false, nodes will stay in low-power standby (25Hz)
  // until the webapp sends {"cmd":"START"}.
  // ============================================================================
  if (!syncManager.isTDMAActive())
  {
    syncManager.startTDMA();
  }
  Serial.println(
      "[Setup] TDMA Background Discovery enabled (nodes can register now)");

  setStatusColor(50, 0, 50); // Purple = Gateway ready

  // ============================================================================
  // Initialize Display (Waveshare board only)
  // ============================================================================
  if (displayManager.init())
  {
    displayManager.showSplash("2026-02-09");
    Serial.println("[Setup] Display initialized and splash shown");
  }

  // ============================================================================
  // MEMORY USAGE SUMMARY
  // ============================================================================
  Serial.println("\n[Setup] ======== MEMORY USAGE SUMMARY ========");
  Serial.printf("[Setup] Internal SRAM: %u free / %u total\n",
                ESP.getFreeHeap(), ESP.getHeapSize());
  if (psramFound())
  {
    Serial.printf("[Setup] PSRAM:         %u free / %u total\n",
                  ESP.getFreePsram(), ESP.getPsramSize());
    Serial.printf("[Setup] PSRAM used:    %u bytes\n",
                  ESP.getPsramSize() - ESP.getFreePsram());
  }
  Serial.println("[Setup] Core 0: SerialTxTask + ProtocolTask (USB + beacons + "
                 "frame emit)");
  Serial.println(
      "[Setup] Core 1: DataIngestionTask (ESP-NOW decode + SyncFrameBuffer)");
  Serial.println("[Setup] ==========================================\n");

  Serial.println("[Setup] Gateway Ready! Waiting for connections...");
  Serial.println("========================================\n");
}

// ============================================================================
// Main Loop
// ============================================================================

void loop()
{
  // Keep stream intent latched during diagnostics; command-path glitches
  // should not disable gateway repackaging.
  if (!isStreaming)
  {
    isStreaming = true;
    suppressSerialLogs = true;
    syncManager.setStreaming(true);
  }

  processSerialCommands();

  // Keepalive via normal queued JSON path (single writer through SerialTxTask).
  // Avoid direct FIFO writes here to prevent interleaving with queued sync
  // frames.
  {
    static uint32_t lastUsbKeepaliveMs = 0;
    const uint32_t nowMs = millis();
    if (nowMs - lastUsbKeepaliveMs > 2000)
    {
      StaticJsonDocument<128> hb;
      hb["type"] = "usb_keepalive";
      hb["uptime_ms"] = nowMs;
      hb["heap_kb"] = ESP.getFreeHeap() / 1024;
      String hbJson;
      serializeJson(hb, hbJson);
      enqueueJsonFrame(hbJson);

      lastUsbKeepaliveMs = nowMs;
    }
  }

  // NOTE: Direct FIFO sync_status / pipeline_diag periodic pushes disabled.
  // They can interleave with queued sync frames and corrupt framing.

  // If the user opens Serial Monitor after boot, they may miss the startup
  // banner. Provide a lightweight heartbeat while not streaming.
  if (!isStreaming && !suppressSerialLogs)
  {
    static uint32_t lastHeartbeatMs = 0;
    const uint32_t nowMs = millis();
    if (nowMs - lastHeartbeatMs > 2000)
    {
      Serial.printf("[Heartbeat] alive, heap=%uKB\n", ESP.getFreeHeap() / 1024);
      lastHeartbeatMs = nowMs;
    }
  }

  // Check WiFi and start WebSocket server if connected
  static bool wsStarted = false;
  static bool espNowSynced = false;

  if (wifiManager.isConnected() && !wsStarted)
  {
    Serial.printf("[Gateway] WiFi connected! IP: %s\n",
                  wifiManager.getIPAddress().c_str());
    wsManager.init(WEBSOCKET_PORT);
    wsStarted = true;

    // CRITICAL: Sync ESP-NOW to WiFi channel after connection
    // This fixes the channel mismatch issue
    if (!espNowSynced)
    {
      uint8_t wifiChannel = WiFi.channel();
      esp_wifi_set_channel(wifiChannel, WIFI_SECOND_CHAN_NONE);
      Serial.printf("[Sync] ESP-NOW channel synced to WiFi channel %d\n",
                    wifiChannel);
      espNowSynced = true;
    }
  }
  else if (!wifiManager.isConnected() && wsStarted)
  {
    wsStarted = false;
    espNowSynced = false; // Re-sync when WiFi reconnects
  }

  if (wsStarted)
  {
    wsManager.loop();
  }

  // NOTE (BUG 1 FIX): syncManager.update() is NOT called here.
  // ProtocolTask on Core 0 already calls it at 50Hz with precise timing.
  // Calling it from loop() (Core 1) simultaneously caused unsynchronized
  // concurrent access to SyncManager state (tdmaFrameNumber, tdmaState,
  // lastBeaconTime) and duplicate esp_now_send() calls, leading to
  // radio stack corruption and watchdog resets.

  // ============================================================================
  // SYNC FRAME BUFFER: Late initialization and status
  // ============================================================================
  // If streaming is enabled but buffer not initialized, try to init it now.
  // This handles the case where nodes register after streaming starts.
  // ============================================================================
  static uint32_t lastSyncFrameRetry = 0;
  static uint32_t lastSyncFrameStatus = 0;

  if (isStreaming && useSyncFrameMode && !syncFrameBufferInitialized)
  {
    // Retry initialization every second
    if (millis() - lastSyncFrameRetry > 1000)
    {
      lastSyncFrameRetry = millis();

      uint8_t expectedSensorIds[SYNC_MAX_SENSORS];
      uint8_t sensorCount =
          syncManager.getExpectedSensorIds(expectedSensorIds, SYNC_MAX_SENSORS);

      if (sensorCount > 0)
      {
        syncFrameBuffer.init(expectedSensorIds, sensorCount);
        syncFrameBufferInitialized = true;
        Serial.printf("[SyncFrame] Late-initialized with %d sensors: ",
                      sensorCount);
        for (uint8_t i = 0; i < sensorCount; i++)
        {
          Serial.printf("%d ", expectedSensorIds[i]);
        }
        Serial.println();
      }
    }
  }

  // Print SyncFrameBuffer status periodically when active
  if (syncFrameBufferInitialized && (millis() - lastSyncFrameStatus > 10000))
  {
    lastSyncFrameStatus = millis();
    syncFrameBuffer.printStatus();
  }
  // ============================================================================

  // Process deferred Magnetometer Calibration Packet
  if (magPacketReceived)
  {
    magPacketReceived = false; // Clear flag

    // Process the buffered packet (safe context)
    StaticJsonDocument<512> doc;
    doc["type"] = "mag_calibration_progress";
    doc["nodeId"] = magPacketBuffer.nodeId;
    doc["progress"] = magPacketBuffer.progress;
    doc["isCalibrating"] = magPacketBuffer.isCalibrating ? true : false;
    doc["isCalibrated"] = magPacketBuffer.isCalibrated ? true : false;

    // Include calibration data if calibrated
    if (magPacketBuffer.isCalibrated)
    {
      JsonObject hardIron = doc.createNestedObject("hardIron");
      hardIron["x"] = magPacketBuffer.hardIronX;
      hardIron["y"] = magPacketBuffer.hardIronY;
      hardIron["z"] = magPacketBuffer.hardIronZ;

      JsonObject softIron = doc.createNestedObject("softIronScale");
      softIron["x"] = magPacketBuffer.softIronScaleX;
      softIron["y"] = magPacketBuffer.softIronScaleY;
      softIron["z"] = magPacketBuffer.softIronScaleZ;

      doc["sampleCount"] = magPacketBuffer.sampleCount;
    }

    String jsonOutput;
    serializeJson(doc, jsonOutput);
    enqueueJsonFrame(jsonOutput);

    Serial.printf(
        "[Gateway] Forwarded MagCalib: node=%d progress=%d%% cal=%d\n",
        magPacketBuffer.nodeId, magPacketBuffer.progress,
        magPacketBuffer.isCalibrated);
  }

  // ============================================================================
  // DISPLAY UPDATE (Waveshare board only, ~4Hz)
  // ============================================================================
  if (boardHasDisplay)
  {
    static uint32_t lastDisplayUpdate = 0;
    if (millis() - lastDisplayUpdate > 250)
    {
      lastDisplayUpdate = millis();

      DisplayStatus ds;
      // Keep display counts aligned with web topology semantics:
      // show registered/expected sensors, not a transient "active in last 3s" snapshot.
      ds.nodeCount = syncManager.getRegisteredNodeCount();

      uint8_t expectedSensorIds[MAX_SENSORS];
      uint8_t displaySensorCount =
          syncManager.getExpectedSensorIds(expectedSensorIds, MAX_SENSORS);

      if (useSyncFrameMode && syncFrameBufferInitialized)
      {
        const uint8_t expected = syncFrameBuffer.getExpectedSensorCount();
        if (expected > 0)
        {
          displaySensorCount = expected;
        }
      }
      ds.sensorCount = displaySensorCount;
      ds.webAppConnected = wsStarted && wsManager.hasClients();
      ds.wifiConnected = wifiManager.isConnected();
      ds.recording = isStreaming;

      displayManager.update(ds);
    }
  }

  // Gateway is mostly idle - ESP-NOW callbacks handle data forwarding
  yield();
}
