/*******************************************************************************
 * MASH_Node - Node-Only Firmware for ESP32-S3
 *
 * This firmware is specifically for Node devices that:
 * - Read IMU sensors locally
 * - Send data to Gateway via ESP-NOW
 * - TDMA-only operation (BLE disabled for maximum throughput)
 *
 * Hardware: Adafruit QT Py ESP32-S3 + ICM20649 sensors via TCA9548A
 ******************************************************************************/

// ============================================================================
// Node Role Configuration (MUST be before Config.h)
// ============================================================================
#define DEVICE_ROLE DEVICE_ROLE_NODE

// ============================================================================
// BLE DISABLED: BLE stack consumes ~30-40KB heap and 1-3ms per notification,
// which steals from the 5ms sensor budget at 200Hz. Since all data flows via
// ESP-NOW → Gateway → USB Serial, BLE provides no value during operation.
// Set to 1 to re-enable for standalone debug/calibration without a gateway.
// ============================================================================
#ifndef ENABLE_BLE
#define ENABLE_BLE 0
#endif

// NOTE: SENSOR_ID_OFFSET is now calculated at runtime from MAC address
// Each node automatically gets a unique ID - no manual editing required!
// The nodeId variable is set in setup() from the ESP32's unique MAC.

#include "Config.h"

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
// NOTE: <USB.h> removed — using Hardware CDC (ARDUINO_USB_MODE=1).
// The USB Serial/JTAG hardware controller provides stable CDC without
// TinyUSB re-enumeration. Set Arduino IDE: Tools > USB Mode > "Hardware CDC and JTAG".
#include <WiFi.h>
#include <Wire.h>
#include <esp_now.h>
#include <esp_wifi.h>

// Include MASH modules
#if ENABLE_BLE
#include "BLEManager.h"
#endif
#include "CommandHandler.h"
#include "OTAManager.h"
#include "PowerStateManager.h"
#include "SensorManager.h"
#include "SyncManager.h"
#include "TimingGlobals.h" // Timing instrumentation
#include "WebSocketManager.h"
#include "WiFiManager.h"
#include "ZuptTest.h"

// ============================================================================
// Global Objects
// ============================================================================

Preferences preferences;
SyncManager syncManager;
SensorManager sensorManager;
#if ENABLE_BLE
BLEManager bleManager;
#endif
WiFiManagerESP wifiManager;
WebSocketManager wsManager;
CommandHandler commandHandler;
OTAManager otaManager;
PowerStateManager powerManager;

Adafruit_NeoPixel statusLED(1, QTPY_NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);

// State variables
volatile bool isStreaming = false;
ConnectionMode currentMode = MODE_BLE;
unsigned long lastSampleTime = 0;
volatile unsigned long sampleIntervalUs = 1000000 / DEFAULT_SAMPLE_RATE_HZ;

// ============================================================================
// POWER STATE HYSTERESIS (MOD-4 fix)
// ============================================================================
// Prevents immediate drop to 25Hz on brief TDMA sync loss.
// When link is lost, we stay at POWER_FULL for a grace period before
// transitioning to POWER_LOW. If re-sync occurs during the grace period,
// the pending power-down is cancelled.
// ============================================================================
static const unsigned long POWER_DOWN_GRACE_MS = 3000; // 3-second grace period
static bool powerDownPending = false;
static unsigned long powerDownScheduledAt = 0;

String deviceName;
uint8_t nodeId = 0; // Unique node ID derived from MAC address at runtime

// ============================================================================
// PROTOCOL TASK (Core 0) - Parallelization Optimization
// ============================================================================
// Runs time-critical operations on Core 0 to avoid jitter from WiFi/BLE on
// Core 1. Handles:
// - TDMA transmission window checking
// - Packet sending when in slot
// - Sample buffering coordination
//
// Benefits:
// - Consistent transmit timing (±50µs vs ±500µs without)
// - No contention with WiFi stack on Core 1
// - Predictable TDMA slot utilization
// ============================================================================
TaskHandle_t protocolTaskHandle = nullptr;
volatile bool protocolTaskRunning = false;

// Protocol task statistics
volatile uint32_t protocolLoopCount = 0;
volatile uint32_t tdmaTxAttempts = 0;
volatile uint32_t tdmaTxSuccess = 0;

// ============================================================================
// OPP-1: Sensor Task (Core 1) - Deterministic Sensor Reading
// ============================================================================
// Isolates I2C sensor reads + Madgwick fusion on Core 1 with highest user
// priority (24). This prevents WiFi/BLE ISRs on Core 0 from introducing
// jitter into the 200Hz sample loop. The task uses vTaskDelayUntil() for
// precise periodic timing instead of polling micros() in loop().
// ============================================================================
#if USE_FREERTOS_TASKS
TaskHandle_t sensorTaskHandle = nullptr;
volatile bool sensorTaskRunning = false;

void SensorTask(void *parameter)
{
  Serial.println("[SensorTask] Started on Core 1 (µs-precision sensor loop)");
  sensorTaskRunning = true;

  // ========================================================================
  // MICROSECOND-PRECISION TIMING (replaces vTaskDelayUntil)
  // ========================================================================
  // PROBLEM: vTaskDelayUntil uses FreeRTOS ticks (1ms resolution on ESP32).
  //   At 200Hz (5ms period), if the task body occasionally takes 5.1ms
  //   (e.g., due to I2C stretch or ISR preemption), vTaskDelayUntil
  //   returns immediately and the NEXT call sleeps for a full 5 ticks,
  //   producing a 10ms gap. This caused ~15% of samples to double-space,
  //   dropping effective rate from 200Hz to ~170Hz.
  //
  // FIX: Use micros()-based timing with hybrid sleep:
  //   1. Compute exact µs until next sample deadline
  //   2. If > 1500µs remaining, yield via vTaskDelay(1) (saves power)
  //   3. Busy-wait the final <1500µs for precise wakeup
  //   4. On overrun, advance deadline without accumulating debt
  //      (skip at most 1 sample to avoid cascade)
  //
  // This gives ±10µs precision vs ±1000µs with tick-based delay.
  // ========================================================================
  uint32_t nextDeadlineUs = micros();

  // ========================================================================
  // OVERRUN DETECTION: Track how often the task body exceeds budget
  // ========================================================================
  uint32_t overrunCount = 0;
  uint32_t totalCycles = 0;
  uint32_t maxCycleUs = 0;
  uint32_t lastOverrunLog = 0;

  // Track streaming state transitions to reset timing on start
  bool wasStreaming = false;

  while (true)
  {
    // Reset deadline when streaming starts to avoid catch-up burst
    if (isStreaming && !wasStreaming)
    {
      nextDeadlineUs = micros();
    }
    wasStreaming = isStreaming;

    // Advance deadline for this cycle
    nextDeadlineUs += sampleIntervalUs;

    if (isStreaming)
    {
      uint32_t cycleStart = micros();
      float dt = sampleIntervalUs / 1000000.0f;

      // I2C sensor read (always use optimized path for maximum throughput)
      // updateOptimized() uses readFrameFast() which eliminates the 1s
      // keep-alive register read and blocking diagnostic output from
      // readFrame(). It has its own 2s health check via checkSensorHealth()
      // which is sufficient.
      uint32_t tStart = micros();
      sensorManager.updateOptimized(dt);
      uint32_t tProc = micros() - tStart;
      if (tProc > g_processTimeMax)
        g_processTimeMax = tProc;

      // Buffer for TDMA transmission
      if (syncManager.isTDMASynced())
      {
        syncManager.bufferSample(sensorManager);
      }

      // BLE disabled (ENABLE_BLE=0) — saves 1-3ms per cycle at 200Hz

      // ====================================================================
      // OVERRUN TRACKING: Detect when task body exceeds sample period
      // ====================================================================
      uint32_t cycleUs = micros() - cycleStart;
      totalCycles++;
      if (cycleUs > maxCycleUs)
        maxCycleUs = cycleUs;
      if (cycleUs > sampleIntervalUs)
      {
        overrunCount++;
      }

      // Log overrun stats every 10 seconds (Rate-limited)
      if (millis() - lastOverrunLog > 10000 && totalCycles > 0)
      {
        lastOverrunLog = millis();
        float overrunPct = (float)overrunCount / totalCycles * 100.0f;
        Serial.printf("[SensorTask] Rate: %luHz, MaxCycle: %luus/%luus budget, "
                      "Overruns: %lu/%lu (%.1f%%)\n",
                      1000000UL / sampleIntervalUs, maxCycleUs,
                      sampleIntervalUs, overrunCount, totalCycles, overrunPct);
        overrunCount = 0;
        totalCycles = 0;
        maxCycleUs = 0;
      }
    }

    // ======================================================================
    // MICROSECOND-PRECISION SLEEP (hybrid yield + busy-wait)
    // ======================================================================
    uint32_t nowUs = micros();
    int32_t remainingUs = (int32_t)(nextDeadlineUs - nowUs);

    if (remainingUs <= 0)
    {
      // Overrun: task body took longer than sampleIntervalUs.
      // Don't accumulate debt — realign deadline to NOW + 1 period.
      // This loses at most 1 sample but prevents cascade stuttering.
      if (remainingUs < -(int32_t)sampleIntervalUs)
      {
        // Severe overrun (>2 periods behind) — hard reset deadline
        nextDeadlineUs = nowUs;
      }
      // Mild overrun (<1 period behind) — next cycle will be slightly
      // shorter, naturally catching up without skipping.
      taskYIELD(); // Still yield once to let lower-priority tasks run
    }
    else
    {
      // Normal case: we finished early, need to wait
      // Phase 1: FreeRTOS yield for bulk of the wait (>400µs chunks)
      // FIX: Lowered threshold from 1500us to 400us to reduce CPU pinning
      while (remainingUs > 400)
      {
        vTaskDelay(1); // Yield for 1 tick (~1ms), saves power
        nowUs = micros();
        remainingUs = (int32_t)(nextDeadlineUs - nowUs);
      }
      // Phase 2: Busy-wait for final <400µs (µs precision)
      while ((int32_t)(nextDeadlineUs - micros()) > 0)
      {
        // Tight spin — yields ±10µs accuracy
      }
    }
  }
}
#endif // USE_FREERTOS_TASKS

// Forward declaration
void ProtocolTask(void *parameter);

void ProtocolTask(void *parameter)
{
  Serial.println("[ProtocolTask] Started on Core 0");
  protocolTaskRunning = true;

  // Task timing
  TickType_t lastWakeTime = xTaskGetTickCount();
  const TickType_t taskPeriodTicks = pdMS_TO_TICKS(1); // 1ms check interval

  while (true)
  {
    protocolLoopCount++;

    // =========================================================================
    // TDMA TRANSMISSION: Check if we're in our transmit window
    // =========================================================================
    if (isStreaming && syncManager.isTDMASynced())
    {
      if (syncManager.isInTransmitWindow() && syncManager.hasBufferedData())
      {
        tdmaTxAttempts++;
        syncManager.sendTDMAData();
        tdmaTxSuccess++;
      }
    }

    // Log stats periodically (every 60 seconds) - REDUCED rate to save serial
    // bandwidth
    static uint32_t lastProtocolLog = 0;
    if (millis() - lastProtocolLog > 60000)
    {
      lastProtocolLog = millis();
      Serial.printf(
          "[ProtocolTask] Stats: loops=%lu, txAttempts=%lu, txSuccess=%lu\n",
          protocolLoopCount, tdmaTxAttempts, tdmaTxSuccess);
    }

    // DIAGNOSTIC: Stack and heap monitoring (every 10 seconds)
    static uint32_t lastStackLog = 0;
    if (millis() - lastStackLog > 10000)
    {
      lastStackLog = millis();
      UBaseType_t protoStack = uxTaskGetStackHighWaterMark(protocolTaskHandle);
      UBaseType_t sensorStack =
          sensorTaskHandle ? uxTaskGetStackHighWaterMark(sensorTaskHandle) : 0;
      Serial.printf("[DIAG] Stack HWM: Protocol=%u, Sensor=%u bytes | Heap "
                    "free=%lu min=%lu\n",
                    (unsigned)protoStack * 4, (unsigned)sensorStack * 4,
                    (unsigned long)esp_get_free_heap_size(),
                    (unsigned long)esp_get_minimum_free_heap_size());
    }

    // Sleep until next period
    vTaskDelayUntil(&lastWakeTime, taskPeriodTicks);
  }
}
// ============================================================================

// ============================================================================
// Status LED Colors
// ============================================================================

void setStatusColor(uint8_t r, uint8_t g, uint8_t b)
{
  statusLED.setPixelColor(0, statusLED.Color(r, g, b));
  statusLED.show();
}

void showStartupAnimation()
{
  // Node-specific: Green pulse
  for (int i = 0; i < 3; i++)
  {
    setStatusColor(0, 50, 0); // Green
    delay(150);
    setStatusColor(0, 0, 0);
    delay(150);
  }
}

// ============================================================================
// Command Callbacks
// ============================================================================

void onStartStreaming()
{
  isStreaming = true;
  setStatusColor(0, 50, 0); // Green = streaming
  Serial.println("[Node] Streaming started");
}

void onStopStreaming()
{
  isStreaming = false;
  setStatusColor(0, 50, 50); // Cyan = Node idle
  Serial.println("[Node] Streaming stopped");
}

void onSetSampleRate(uint16_t rateHz)
{
  // AUDIT FIX 2026-02-08: Added 200 Hz to validated rates (was missing despite
  // being the target rate)
  if (rateHz == 30 || rateHz == 60 || rateHz == 100 || rateHz == 120 ||
      rateHz == 200)
  {
    sampleIntervalUs = 1000000 / rateHz;
    Serial.printf("[Node] Sample rate set to %d Hz (%lu us)\n", rateHz,
                  sampleIntervalUs);
  }
  else
  {
    Serial.printf("[Node] Invalid sample rate: %d\n", rateHz);
  }
}

void onSetAccelRange(uint8_t rangeG)
{
  sensorManager.setAccelRange(rangeG);
  Serial.printf("[Node] Accel range set to ±%dg\n", rangeG);
}

void onSetGyroRange(uint16_t rangeDPS)
{
  sensorManager.setGyroRange(rangeDPS);
  Serial.printf("[Node] Gyro range set to ±%d dps\n", rangeDPS);
}

void onSwitchMode(ConnectionMode mode)
{
  currentMode = mode;
  Serial.printf("[Node] Mode: %s\n", mode == MODE_BLE ? "TDMA" : "WiFi");
}

void onGetStatus(JsonDocument &response)
{
  response["role"] = "node";
  response["sensorIdOffset"] = nodeId;
  response["sensorCount"] = sensorManager.getSensorCount();
  response["isStreaming"] = isStreaming;
  response["sampleRate"] = 1000000 / sampleIntervalUs;
  response["outputMode"] = (sensorManager.getOutputMode() == OUTPUT_QUATERNION)
                               ? "quaternion"
                               : "raw";
  response["calibratedCount"] = sensorManager.getCalibratedCount();

  JsonArray calibration = response.createNestedArray("calibration");
  for (uint8_t i = 0; i < sensorManager.getSensorCount(); i++)
  {
    calibration.add(sensorManager.isCalibrated(i));
  }

  response["hasMagnetometer"] = sensorManager.hasMag();
  response["hasBarometer"] = sensorManager.hasBaro();
}

void onCalibrate(uint8_t sensorId)
{
  Serial.printf("[Node] Calibrating sensor %d\n", sensorId);
  sensorManager.calibrateSensor(sensorId);
}

void onCalibrateGyro(uint8_t sensorId)
{
  Serial.printf("[Node] Zeroing Gyros for sensor %d\n", sensorId);
  sensorManager.calibrateGyro(sensorId);
}

void onSetWiFi(const char *ssid, const char *password)
{
  Serial.printf("[Node] Setting WiFi: %s\n", ssid);
  wifiManager.setCredentials(ssid, password);
  wifiManager.connect();
}

void onSetOutputMode(OutputMode mode)
{
  sensorManager.setOutputMode(mode);
  Serial.printf("[Node] Output mode: %s\n",
                mode == OUTPUT_QUATERNION ? "quaternion" : "raw");
}

// void onSetFilterBeta(float beta) REMOVED

void onSetName(const char *name)
{
  Serial.printf("[Node] Setting name: %s\n", name);
  preferences.begin("imu_config", false);
  preferences.putString("device_name", name);
  preferences.end();
  Serial.println("[Node] Name saved. Rebooting...");
  delay(1000);
  ESP.restart();
}

void onSetNodeId(uint8_t id)
{
  Serial.printf("[Node] Setting manual Node ID: %d\n", id);
  preferences.begin("imu_config", false);
  if (id == 0)
  {
    preferences.remove("custom_node_id"); // Reset to auto
    Serial.println(
        "[Node] Custom ID removed. Will use MAC-derived ID next boot.");
  }
  else
  {
    preferences.putUChar("custom_node_id", id);
    Serial.println("[Node] Custom ID saved.");
  }
  preferences.end();
  Serial.println("[Node] Rebooting...");
  delay(1000);
  ESP.restart();
}

void onSetSyncRole(const char *role)
{
  if (strcmp(role, "master") == 0)
  {
    syncManager.setRole(SYNC_ROLE_MASTER);
  }
  else if (strcmp(role, "slave") == 0)
  {
    syncManager.setRole(SYNC_ROLE_SLAVE);
  }
  else
  {
    syncManager.setRole(SYNC_ROLE_AUTO);
  }
}

void onGetCalibration(uint8_t sensorId, JsonDocument &response)
{
  response["sensorId"] = sensorId;
  if (sensorId < sensorManager.getSensorCount())
  {
    CalibrationData cal = sensorManager.getCalibration(sensorId);
    response["isCalibrated"] = cal.isCalibrated;
    if (cal.isCalibrated)
    {
      JsonObject accelOffset = response.createNestedObject("accelOffset");
      accelOffset["x"] = cal.accelOffsetX;
      accelOffset["y"] = cal.accelOffsetY;
      accelOffset["z"] = cal.accelOffsetZ;
      JsonObject gyroOffset = response.createNestedObject("gyroOffset");
      gyroOffset["x"] = cal.gyroOffsetX;
      gyroOffset["y"] = cal.gyroOffsetY;
      gyroOffset["z"] = cal.gyroOffsetZ;
    }
  }
  else
  {
    response["error"] = "Invalid sensor ID";
  }
}

void onSetZupt(float gyroThresh, float accelThresh, int minFrames)
{
  // sensorManager.setZuptThresholds(gyroThresh, accelThresh, minFrames); //
  // REMOVED
}

void onCalibrateMag(uint32_t durationMs)
{
  Serial.printf("[Node] Starting magnetometer calibration (%lu ms)\n",
                durationMs);
  sensorManager.startMagCalibration(durationMs);
}

void onGetMagCalibration(JsonDocument &response)
{
  response["hasMagnetometer"] = sensorManager.hasMag();
  response["isCalibrating"] = sensorManager.isMagCalibrating();
  response["progress"] = sensorManager.getMagCalibrationProgress();

  MagCalibrationData cal = sensorManager.getMagCalibration();
  response["isCalibrated"] = cal.isCalibrated;

  if (cal.isCalibrated)
  {
    JsonObject hardIron = response.createNestedObject("hardIron");
    hardIron["x"] = cal.hardIronX;
    hardIron["y"] = cal.hardIronY;
    hardIron["z"] = cal.hardIronZ;

    JsonObject softIron = response.createNestedObject("softIronScale");
    softIron["x"] = cal.softIronScaleX;
    softIron["y"] = cal.softIronScaleY;
    softIron["z"] = cal.softIronScaleZ;

    response["sampleCount"] = cal.sampleCount;
  }

  // Include current magnetometer reading
  if (sensorManager.hasMag())
  {
    MagData mag = sensorManager.getCalibratedMagData();
    JsonObject magReading = response.createNestedObject("currentReading");
    magReading["x"] = mag.x;
    magReading["y"] = mag.y;
    magReading["z"] = mag.z;
    magReading["heading"] = mag.heading;
  }
}

// ============================================================================
// Setup
// ============================================================================

void setup()
{
  // -----------------------------------------------------------------------
  // HARDWARE CDC MODE (ARDUINO_USB_MODE=1)
  //
  // Using the ESP32-S3's built-in USB Serial/JTAG controller instead of
  // TinyUSB. No USB.productName()/manufacturerName() calls needed — the
  // hardware controller uses fixed descriptors. This avoids USB
  // re-enumeration that can break Web Serial connections.
  //
  // Arduino IDE settings required:
  //   Tools > USB Mode > "Hardware CDC and JTAG"
  //   Tools > USB CDC On Boot > "Enabled"
  // -----------------------------------------------------------------------
  Serial.begin(115200);

  // Wait for HWCDC connection (same pattern as Gateway)
  {
    uint32_t waitStart = millis();
    while (!Serial && (millis() - waitStart < 3000))
    {
      delay(10);
    }
  }

  Serial.println("\n\n*** ESP32 NODE STARTING ***\n");
  Serial.println("========================================");
  Serial.println("   VERSION: 2026-02-09 INT_WDT_FIX v10.1 (Startup Fix)");
  Serial.printf("   Role: NODE (will derive ID from MAC)\n");
  Serial.println("========================================\n");

  // ============================================================================
  // DIAGNOSTIC: Print reset reason to diagnose silent reboots
  // ============================================================================
  esp_reset_reason_t resetReason = esp_reset_reason();
  const char *resetReasonStr = "UNKNOWN";
  switch (resetReason)
  {
  case ESP_RST_POWERON:
    resetReasonStr = "POWER_ON";
    break;
  case ESP_RST_SW:
    resetReasonStr = "SOFTWARE";
    break;
  case ESP_RST_PANIC:
    resetReasonStr = "PANIC/EXCEPTION";
    break;
  case ESP_RST_INT_WDT:
    resetReasonStr = "INTERRUPT_WDT";
    break;
  case ESP_RST_TASK_WDT:
    resetReasonStr = "TASK_WDT";
    break;
  case ESP_RST_WDT:
    resetReasonStr = "OTHER_WDT";
    break;
  case ESP_RST_DEEPSLEEP:
    resetReasonStr = "DEEP_SLEEP";
    break;
  case ESP_RST_BROWNOUT:
    resetReasonStr = "BROWNOUT";
    break;
  case ESP_RST_SDIO:
    resetReasonStr = "SDIO";
    break;
  default:
    resetReasonStr = "UNKNOWN";
    break;
  }
  Serial.printf("[DIAG] Reset reason: %s (%d)\n", resetReasonStr,
                (int)resetReason);
  Serial.printf("[DIAG] Free heap: %lu bytes, min ever: %lu bytes\n",
                (unsigned long)esp_get_free_heap_size(),
                (unsigned long)esp_get_minimum_free_heap_size());
  // ============================================================================

  // RUN REGRESSION TESTS
  ZuptTest::run(sensorManager.getZuptGyroThresh(),
                sensorManager.getZuptAccelThresh());

  // Initialize NeoPixel status LED
  pinMode(QTPY_NEOPIXEL_POWER_PIN, OUTPUT);
  digitalWrite(QTPY_NEOPIXEL_POWER_PIN, HIGH);
  delay(100);
  statusLED.begin();
  statusLED.setBrightness(30);
  showStartupAnimation();

  setStatusColor(50, 50, 0); // Yellow = initializing

  // Initialize I2C buses
  // Wire  = Stemma QT connector (GPIO41/40) - up to 2 IMUs via address selection
  // Wire1 = Castellated SDA/SCL pads (GPIO7/6) - 3rd IMU on separate bus
  Wire.begin(QTPY_SDA_PIN, QTPY_SCL_PIN);
  Wire.setClock(400000);
  Wire1.begin(QTPY_WIRE1_SDA_PIN, QTPY_WIRE1_SCL_PIN);
  Wire1.setClock(400000);

  // Initialize sensors
  Serial.println("[Setup] Initializing sensors...");
  if (!sensorManager.init())
  {
    Serial.println("[Setup] ERROR: No sensors found!");
    setStatusColor(50, 0, 0);
    while (1)
    {
      delay(1000);
    }
  }
  Serial.printf("[Setup] Found %d sensor(s)\n", sensorManager.getSensorCount());

  // ============================================================================
  // PARALLELIZATION: Enable FIFO batch reading for ~75% I2C overhead reduction
  // ============================================================================
  sensorManager.enableFIFOMode();
  Serial.println("[Setup] FIFO batch mode enabled for optimized I2C reads");
  // ============================================================================

  // Cache sensor count for TDMA registration (before syncManager.init)
  syncManager.setSensorCount(sensorManager.getSensorCount());

  // RAW MODE: Do not load saved calibration.
  // We want the web app to receive raw sensor data (g/deg/s).
  // Note: SensorManager::init() already performed a fresh Gyro Bias
  // calibration, which is good (removes drift). We just don't want to overwrite
  // it with stale NVS data or apply permanent offsets that the App doesn't know
  // about. sensorManager.clearCalibration(); // Optional: Ensure it's clean
  // (though it defaults to 0)
  Serial.println("[Setup] Raw Mode: Calibration persistence disabled.");

  // Initialize command handler
  commandHandler.setStartCallback(onStartStreaming);
  commandHandler.setStopCallback(onStopStreaming);
  commandHandler.setSampleRateCallback(onSetSampleRate);
  commandHandler.setAccelRangeCallback(onSetAccelRange);
  commandHandler.setGyroRangeCallback(onSetGyroRange);
  commandHandler.setSwitchModeCallback(onSwitchMode);
  commandHandler.setStatusCallback(onGetStatus);
  commandHandler.setCalibrateCallback(onCalibrate);
  commandHandler.setCalibrateGyroCallback(onCalibrateGyro);
  commandHandler.setWiFiCallback(onSetWiFi);
  commandHandler.setOutputModeCallback(onSetOutputMode);
  // commandHandler.setFilterBetaCallback(onSetFilterBeta); REMOVED
  commandHandler.setSetNameCallback(onSetName);
  commandHandler.setSetNodeIdCallback(onSetNodeId);
  commandHandler.setSyncRoleCallback(onSetSyncRole);
  commandHandler.setGetCalibrationCallback(onGetCalibration);
  commandHandler.setZuptCallback(onSetZupt);
  commandHandler.setMagCalibrateCallback(onCalibrateMag);
  commandHandler.setGetMagCalibrationCallback(onGetMagCalibration);
  commandHandler.setClearCalibrationCallback(
      []()
      { sensorManager.clearCalibration(); });

  // Load magnetometer calibration if available
  // RAW MODE: Disabled
  // if (sensorManager.hasMag()) {
  //   sensorManager.loadMagCalibration();
  // }

  // Generate unique node ID from MAC address (no manual editing needed!)
  // Use WiFi STA MAC (same format as ESP-NOW src_addr) for consistency
  uint8_t baseMac[6];
  esp_wifi_get_mac(WIFI_IF_STA, baseMac);

  // XOR multiple MAC bytes together for better uniqueness
  // Just using one byte has a 1/256 collision chance per pair of nodes
  // XOR of bytes [3],[4],[5] gives much better distribution
  nodeId = baseMac[3] ^ baseMac[4] ^ baseMac[5];

  // CRITICAL: Ensure nodeId is never 0 (would cause sensor ID collisions)
  if (nodeId == 0)
  {
    nodeId = baseMac[2] ^ baseMac[4]; // Try different combination
    if (nodeId == 0)
    {
      nodeId = 1; // Ultimate fallback
    }
    Serial.printf("[Setup] WARNING: XOR hash was 0, using fallback nodeId=%d\n",
                  nodeId);
  }

  Serial.printf("[Setup] Node ID derived from MAC: %d "
                "(MAC=%02X:%02X:%02X:%02X:%02X:%02X)\n",
                nodeId, baseMac[0], baseMac[1], baseMac[2], baseMac[3],
                baseMac[4], baseMac[5]);

  // Check for custom override
  preferences.begin("imu_config", true);
  uint8_t customId = preferences.getUChar("custom_node_id", 0);
  preferences.end();

  if (customId != 0)
  {
    Serial.printf("[Setup] Using Configured Custom Node ID: %d (Overriding "
                  "MAC-based: %d)\n",
                  customId, nodeId);
    nodeId = customId;
  }

  // Load saved device name
  preferences.begin("imu_config", true);
  deviceName = preferences.getString("device_name", BLE_DEVICE_NAME);
  preferences.end();
  deviceName += "_Node_";
  deviceName +=
      String(nodeId); // Use MAC-derived ID instead of hardcoded offset

#if ENABLE_BLE
  // Deferred BLE initialization (lazy init)
  Serial.printf("[Setup] BLE deferred as '%s'\n", deviceName.c_str());
  bleManager.setDeviceName(deviceName);
  bleManager.setCommandCallback([](const String &cmd)
                                {
    String response = commandHandler.processCommand(cmd);
    bleManager.sendResponse(response); });
#else
  Serial.println("[Setup] BLE DISABLED (ENABLE_BLE=0) — TDMA-only mode");
#endif

  // Initialize WiFi
  WiFi.mode(WIFI_STA);
  // CRITICAL FIX: Disable WiFi Power Save MOVED to after Init
  // esp_wifi_set_ps(WIFI_PS_NONE);

  WiFi.disconnect(); // We don't need to connect to an AP, just ESP-NOW for
                     // sending to Gateway

  // Initialize WiFi Manager (credentials, etc.)
  wifiManager.init();

  // Initialize ESP-NOW for sending to Gateway
  syncManager.init(deviceName.c_str());

  // Connect OTA Manager to SyncManager for receiving Gateway OTA packets
  otaManager.setNodeId(nodeId);
  syncManager.setNodeId(nodeId); // Set dynamic node ID
  syncManager.setOTAManager(&otaManager);

  // ============================================================================
  // CRITICAL FIX: Disable WiFi Power Save to prevent radio sleeping
  // Default is WIFI_PS_MIN_MODEM which turns off radio between beacons.
  // This causes 16ms+ TX stalls and packet drops in high-rate TDMA.
  // MOVED HERE (v9) because syncManager.init() calls WiFi.mode() which resets
  // it.
  // ============================================================================
  esp_wifi_set_ps(WIFI_PS_NONE);

  // ============================================================================
  // POWER MANAGEMENT: Initialize power state manager (starts in LOW = 25Hz)
  // ============================================================================
  powerManager.init();
  syncManager.setPowerStateManager(&powerManager);
  sampleIntervalUs = powerManager.getSampleIntervalUs();
  Serial.printf("[Setup] Power state: %s (%dHz, %lu us)\n",
                powerManager.getStateName(), powerManager.getSampleRateHz(),
                sampleIntervalUs);
  // ============================================================================

  // WebSocket setup
  wsManager.setMessageCallback([](const String &msg)
                               {
    String response = commandHandler.processCommand(msg);
    wsManager.broadcast(response); });

#if ENABLE_BLE
  // Handle Radio Mode commands from Gateway
  syncManager.setRadioModeCallback([](uint8_t mode)
                                   {
    if (mode == 0)
      bleManager.stopAdvertising();
    else {
      bleManager.ensureInitialized();
      bleManager.startAdvertising();
    } });
#else
  // BLE disabled — ignore radio mode commands from gateway
  syncManager.setRadioModeCallback([](uint8_t mode)
                                   { Serial.printf("[Node] Radio mode command %d ignored (BLE disabled)\n",
                                                   mode); });
#endif

  // Handle Calibration Commands (Mag & Gyro) from Gateway
  syncManager.setMagCalibCallback([](uint8_t cmdType, uint32_t param)
                                  {
    if (cmdType == CMD_MAG_CALIBRATE) {
      Serial.println("[Node] Starting Magnetometer Calibration...");
      sensorManager.startMagCalibration((uint32_t)param);
    } else if (cmdType == CMD_MAG_CLEAR) {
      Serial.println("[Node] Clearing Magnetometer Calibration...");
      sensorManager.clearMagCalibration();
    } else if (cmdType == CMD_GYRO_CALIBRATE) {
      // param is sensorId, or 0xFF for all
      uint8_t sensorId = (uint8_t)param;
      if (sensorId == 0xFF) {
        Serial.println("[Node] Zeroing Gyros for ALL sensors...");
        for (uint8_t i = 0; i < sensorManager.getSensorCount(); i++) {
          sensorManager.calibrateGyro(i);
        }
      } else {
        Serial.printf("[Node] Zeroing Gyros for sensor %d...\n", sensorId);
        sensorManager.calibrateGyro(sensorId);
      }
    } });

  // BEST PRACTICE: Auto-toggle BLE based on TDMA State
  // Locked/Synced -> BLE OFF (Maximize stability)
  // Unregistered/Lost -> BLE ON (Recovery/Debug available)
  syncManager.setTDMAStateChangeCallback([](TDMANodeState state)
                                         {
    if (state == TDMA_NODE_SYNCED) {
      Serial.println("[Node] TDMA Synced");

      // ========================================================================
      // POWER MANAGEMENT: Switch to FULL power state (200Hz) when synced
      // Cancel any pending power-down (hysteresis - MOD-4)
      // ========================================================================
      if (powerDownPending) {
        Serial.println("[PowerState] Re-synced during grace period -> "
                       "cancelling power-down");
        powerDownPending = false;
      }
      powerManager.requestState(POWER_FULL);
      sampleIntervalUs = powerManager.getSampleIntervalUs();
      // sensorManager.setFilterSampleFrequency(powerManager.getSampleRateHz());
      // // REMOVED
      Serial.printf("[PowerState] SYNCED -> FULL (%dHz, %lu us interval)\n",
                    powerManager.getSampleRateHz(), sampleIntervalUs);
      // ========================================================================

      // CRITICAL FIX: Stopping BLE may reset the radio/channel.
      // We must IMMEDIATELY force the WiFi channel back to the Gateway's
      // channel to ensure we don't miss the next beacon or schedule.
      uint8_t channel = syncManager.getLastKnownChannel();

      // PHASE 4 FIX: Disable WiFi Auto-Reconnect to prevent channel scanning
      // Use helper method to stop station connection attempts but keep radio ON
      wifiManager.stopConnection();

      if (channel > 0) {
        esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
        // [TEST VERIFICATION LOG]
        Serial.printf("[Test] State: SYNCED -> WiFi: STOPPED (Radio On), "
                      "Channel: %d (Forced)\n",
                      channel);
      } else {
        Serial.println("[Test] State: SYNCED -> WiFi: STOPPED (Radio On), "
                       "Channel: UNKNOWN");
      }

    } else if (state == TDMA_NODE_UNREGISTERED) {
      Serial.println("[Node] TDMA Link Lost");

      // ========================================================================
      // POWER MANAGEMENT: Schedule deferred power-down (hysteresis - MOD-4)
      // Don't immediately drop to 25Hz — allow grace period for re-sync.
      // The actual transition happens in loop() after POWER_DOWN_GRACE_MS.
      // ========================================================================
      if (powerManager.getState() == POWER_FULL && !powerDownPending) {
        powerDownPending = true;
        powerDownScheduledAt = millis();
        Serial.printf(
            "[PowerState] UNREGISTERED -> Scheduling power-down in %lums "
            "(staying at %dHz during grace period)\n",
            POWER_DOWN_GRACE_MS, powerManager.getSampleRateHz());
      } else if (powerManager.getState() != POWER_FULL) {
        // Already at LOW/MED — go directly to LOW
        powerManager.requestState(POWER_LOW);
        sampleIntervalUs = powerManager.getSampleIntervalUs();
        Serial.printf(
            "[PowerState] UNREGISTERED -> LOW (%dHz, %lu us interval)\n",
            powerManager.getSampleRateHz(), sampleIntervalUs);
      }
      // ========================================================================

      // PHASE 4 FIX: Re-enable WiFi Auto-Reconnect for debugging/OTA
      if (wifiManager.hasSavedCredentials()) {
        wifiManager.connectAsync();
        // [TEST VERIFICATION LOG]
        Serial.println(
            "[Test] State: LOST -> WiFi: AUTO-RECONNECT ENABLED (Scanning...)");
      }
    } });

  if (wifiManager.hasSavedCredentials())
  {
    wifiManager.connectAsync();
  }

  // Nodes should auto-start streaming since their primary purpose is to send
  // data to the Gateway. They don't need a START command from BLE.
  isStreaming = true;
  Serial.println("[Setup] Auto-starting stream (Node mode)");

  // ============================================================================
  // PARALLELIZATION: Start Protocol Task on Core 0
  // ============================================================================
  // This handles time-critical TDMA transmission on a dedicated core,
  // reducing jitter from ±500µs to ±50µs by avoiding WiFi/BLE contention.
  // PRIORITY INCREASE: Raised to 18 to ensure it preempts background loops.
  // ============================================================================
  xTaskCreatePinnedToCore(
      ProtocolTask,             // Task function
      "ProtocolTask",           // Name
      PROTOCOL_TASK_STACK_SIZE, // Use SharedConfig constant (8KB)
      nullptr,                  // Parameters
      PROTOCOL_TASK_PRIORITY,   // Use SharedConfig constant (18)
      &protocolTaskHandle,      // Task handle
      PROTOCOL_TASK_CORE        // Use SharedConfig constant (Core 0)
  );
  Serial.printf("[Setup] Protocol Task started on Core %d (priority %d, %d "
                "bytes stack)\n",
                PROTOCOL_TASK_CORE, PROTOCOL_TASK_PRIORITY,
                PROTOCOL_TASK_STACK_SIZE);
  // ============================================================================

  // ============================================================================
  // OPP-1: Sensor Task on Core 1 (deterministic 200Hz I2C + fusion)
  // ============================================================================
#if USE_FREERTOS_TASKS
  xTaskCreatePinnedToCore(SensorTask,             // Task function
                          "SensorTask",           // Name
                          SENSOR_TASK_STACK_SIZE, // Stack size (4096 bytes)
                          nullptr,                // Parameters
                          SENSOR_TASK_PRIORITY,   // Priority 24 (highest user)
                          &sensorTaskHandle,      // Task handle
                          SENSOR_TASK_CORE        // Core 1 (isolated from WiFi/BLE)
  );
  Serial.printf(
      "[Setup] Sensor Task started on Core %d (priority %d, %d bytes stack)\n",
      SENSOR_TASK_CORE, SENSOR_TASK_PRIORITY, SENSOR_TASK_STACK_SIZE);
#else
  Serial.println(
      "[Setup] Sensor loop running in loop() (USE_FREERTOS_TASKS=0)");
#endif
  // ============================================================================

  setStatusColor(0, 50, 0); // Green = streaming
  Serial.println("\n[Setup] Node Ready and Streaming!");
  Serial.println("========================================\n");
}

// ============================================================================
// Main Loop
// ============================================================================

void loop()
{
  unsigned long currentTime = millis();

  // WiFi/WebSocket handling
  static bool wsStarted = false;
  if (wifiManager.isConnected() && !wsStarted)
  {
    Serial.printf("[Node] WiFi connected! IP: %s\n",
                  wifiManager.getIPAddress().c_str());
    wsManager.init(WEBSOCKET_PORT);
    wsStarted = true;
  }
  else if (!wifiManager.isConnected() && wsStarted)
  {
    wsStarted = false;
  }

  if (wsStarted)
  {
    wsManager.loop();
  }

  syncManager.update();

  // ============================================================================
  // WARM STANDBY: Toggle power state based on Gateway streaming status
  // ============================================================================
  // When the Gateway stops streaming (recording stopped), it continues to send
  // beacons but clears the SYNC_FLAG_STREAMING bit. Nodes should drop to
  // 25Hz (POWER_LOW) during this time to save power but stay connected.
  // When streaming resumes, they immediately jump back to 200Hz (POWER_FULL).
  // ============================================================================
  if (syncManager.isTDMASynced())
  {
    bool currentlyStreaming = syncManager.isGatewayStreaming();
    PowerState targetState = currentlyStreaming ? POWER_FULL : POWER_LOW;

    if (powerManager.getState() != targetState)
    {
      // Cancel any pending power-down hysteresis if we're responding to a flag
      powerDownPending = false;

      powerManager.requestState(targetState);
      sampleIntervalUs = powerManager.getSampleIntervalUs();

      Serial.printf("[WarmStandby] Gateway %s -> Switching to %s (%dHz)\n",
                    currentlyStreaming ? "Streaming" : "Standby",
                    powerManager.getStateName(),
                    powerManager.getSampleRateHz());

      // Update local streaming flag for LED status and other logic
      isStreaming = currentlyStreaming;
      setStatusColor(
          isStreaming ? 0 : 50, 50,
          isStreaming ? 0 : 50); // Green if streaming, Cyan/Purple if standby
    }
  }

  // ============================================================================
  // POWER STATE HYSTERESIS CHECK (MOD-4)
  // Execute deferred power-down after grace period expires
  // ============================================================================
  if (powerDownPending &&
      (currentTime - powerDownScheduledAt >= POWER_DOWN_GRACE_MS))
  {
    powerDownPending = false;
    powerManager.requestState(POWER_LOW);
    sampleIntervalUs = powerManager.getSampleIntervalUs();
    Serial.printf(
        "[PowerState] Grace period expired -> LOW (%dHz, %lu us interval)\n",
        powerManager.getSampleRateHz(), sampleIntervalUs);
  }

  // ============================================================================
  // TDMA Transmission: Now handled by Protocol Task on Core 0
  // ============================================================================
  // The Protocol Task runs at 1kHz and checks for transmit windows with
  // much lower jitter than the main loop. This code is kept as a fallback
  // in case the Protocol Task hasn't started yet.
  // ============================================================================
  if (!protocolTaskRunning && isStreaming && syncManager.isTDMASynced())
  {
    if (syncManager.isInTransmitWindow() && syncManager.hasBufferedData())
    {
      syncManager.sendTDMAData();
    }
  }

  // Update optional sensors at 10Hz
  sensorManager.updateOptionalSensors();

  // Update magnetometer calibration if in progress
  if (sensorManager.isMagCalibrating())
  {
    bool stillCalibrating = sensorManager.updateMagCalibration();

    // Send progress update via BLE if connected
#if ENABLE_BLE
    if (bleManager.isConnected())
    {
      static unsigned long lastMagProgressTime = 0;
      if (currentTime - lastMagProgressTime >= 500)
      { // Every 500ms
        StaticJsonDocument<256> progressDoc;
        progressDoc["type"] = "mag_calibration_progress";
        progressDoc["progress"] = sensorManager.getMagCalibrationProgress();
        progressDoc["isCalibrating"] = stillCalibrating;

        if (!stillCalibrating)
        {
          progressDoc["isCalibrated"] = sensorManager.isMagCalibrated();
        }

        String progressJson;
        serializeJson(progressDoc, progressJson);
        bleManager.sendResponse(progressJson);
        lastMagProgressTime = currentTime;
      }
    }
#endif
  }

  // Send environmental data via BLE at 10Hz (if connected for debug)
#if ENABLE_BLE
  static unsigned long lastEnvNotifyTime = 0;
  if (bleManager.isConnected() && (currentTime - lastEnvNotifyTime >= 100))
  {
    lastEnvNotifyTime = currentTime;
    bleManager.sendEnvironmentalData(sensorManager);
  }
#endif // ENABLE_BLE

  // Main sensor loop
  // Main sensor loop using MICROS for precise timing
  // OPP-1: When USE_FREERTOS_TASKS=1, sensor reads happen in SensorTask() on
  // Core 1
#if !USE_FREERTOS_TASKS
  unsigned long currentMicros = micros();
  if (isStreaming && (currentMicros - lastSampleTime >= sampleIntervalUs))
  {
    // Calculate fixed dt based on the sample rate to ensure consistent
    // integration during catch-up bursts If we simply measured time, a delayed
    // loop would integrate 'double time' then run again, causing
    // over-integration.
    float dt = sampleIntervalUs / 1000000.0f;
    lastSampleTime += sampleIntervalUs;

    // ============================================================================
    // I2C OPTIMIZATION: Use optimized update for multi-sensor nodes (3+)
    // ============================================================================
    // I2C OPTIMIZATION: Always use updateOptimized() for maximum throughput.
    // readFrameFast() eliminates keep-alive register reads and blocking
    // diagnostic output that can blow the 5ms timing budget at 200Hz.
    // ============================================================================
    uint32_t tStart = micros();
    sensorManager.updateOptimized(dt);
    uint32_t tProc = micros() - tStart;
    if (tProc > g_processTimeMax)
      g_processTimeMax = tProc;

    // ============================================================================
    // TDMA Mode: Buffer samples at 200Hz
    // ============================================================================
    if (syncManager.isTDMASynced())
    {
      syncManager.bufferSample(sensorManager);
    }

    // ============================================================================
    // Legacy Mode: Immediate transmission (fallback when TDMA not active)
    // ============================================================================
    else
    {

      // ========================================================================
      // TDMA-ONLY MODE: Legacy sendIMUData() call REMOVED
      // ========================================================================
      // This was creating 0x03 packets that Gateway rejects.
      // TDMA protocol handles all data transmission automatically.
      // DO NOT UNCOMMENT - System is TDMA-only!
      // syncManager.sendIMUData(sensorManager); // ← REMOVED (0x03 packets)
      // ========================================================================
    }

    // BLE disabled — BLE send removed from legacy path
  }
#endif // !USE_FREERTOS_TASKS

  // ============================================================================
  // Periodic sends (run in loop() regardless of task isolation mode)
  // ============================================================================

  // Send Node Info periodically (every 10 seconds) - REDUCED rate
  {
    static unsigned long lastInfoSendTime = 0;
    if (currentTime - lastInfoSendTime >= 10000)
    {
      // [TIMING PROFILER LOG]
      Serial.printf(
          "[TIMING-P99] Process=%lu us, Build=%lu us, AirTime=%lu us\n",
          g_processTimeMax, g_packetBuildTimeMax, g_txAirTimeMax);
      // Reset peaks after logging
      g_processTimeMax = 0;
      g_packetBuildTimeMax = 0;
      g_txAirTimeMax = 0;

      syncManager.sendNodeInfo(sensorManager, deviceName.c_str());
      lastInfoSendTime = currentTime;
    }
  }

  // Send Environmental data periodically
  {
    static unsigned long lastEnvSendTime = 0;
    if (currentTime - lastEnvSendTime >= 100)
    {
      syncManager.sendEnviroData(sensorManager);
      lastEnvSendTime = currentTime;
    }
  }

  yield();
}
