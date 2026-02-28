/*******************************************************************************
 * CommandHandler.h - Unified Command Processing
 *
 * Handles commands from both BLE and WebSocket connections with a consistent
 * JSON-based protocol for controlling the IMU device from the web app.
 ******************************************************************************/

#ifndef COMMAND_HANDLER_H
#define COMMAND_HANDLER_H

#include "Config.h"
#include "SensorManager.h"
#include <Arduino.h>
#include <ArduinoJson.h>

// Command callback types
typedef std::function<void()> VoidCallback;
typedef std::function<void(uint16_t)> SampleRateCallback;
typedef std::function<void(uint8_t)> AccelRangeCallback;
typedef std::function<void(uint16_t)> GyroRangeCallback;
typedef std::function<void(ConnectionMode)> ModeCallback;
typedef std::function<void(JsonDocument &)> StatusCallback;
typedef std::function<void(uint8_t)> CalibrateCallback;
typedef std::function<void(const char *, const char *)> WiFiCallback;
typedef std::function<void(OutputMode)> OutputModeCallback;
typedef std::function<void(float)> FilterBetaCallback;
typedef std::function<void(const char *)> SetNameCallback;
typedef std::function<void(const char *)> SyncRoleCallback;
typedef std::function<void(uint8_t, JsonDocument &)> GetCalibrationCallback;
typedef std::function<void(float, float, int)> ZuptCallback;
typedef std::function<void(uint32_t)> MagCalibrateCallback;
typedef std::function<void(JsonDocument &)> GetMagCalibrationCallback;
typedef std::function<void(uint8_t)> SetNodeIdCallback;

class CommandHandler
{
public:
  CommandHandler();

  /**
   * Process a command string (JSON format)
   * @param command JSON command string
   * @return JSON response string
   */
  String processCommand(const String &command);

  // Callback setters
  void setStartCallback(VoidCallback cb) { startCallback = cb; }
  void setStopCallback(VoidCallback cb) { stopCallback = cb; }
  void setSampleRateCallback(SampleRateCallback cb) { sampleRateCallback = cb; }
  void setAccelRangeCallback(AccelRangeCallback cb) { accelRangeCallback = cb; }
  void setGyroRangeCallback(GyroRangeCallback cb) { gyroRangeCallback = cb; }
  void setSwitchModeCallback(ModeCallback cb) { modeCallback = cb; }
  void setStatusCallback(StatusCallback cb) { statusCallback = cb; }
  void setCalibrateCallback(CalibrateCallback cb) { calibrateCallback = cb; }
  void setCalibrateGyroCallback(CalibrateCallback cb)
  {
    calibrateGyroCallback = cb;
  }
  void setWiFiCallback(WiFiCallback cb) { wifiCallback = cb; }
  void setOutputModeCallback(OutputModeCallback cb) { outputModeCallback = cb; }
  void setFilterBetaCallback(FilterBetaCallback cb) { filterBetaCallback = cb; }
  void setSetNameCallback(SetNameCallback cb) { setNameCallback = cb; }
  void setSyncRoleCallback(SyncRoleCallback cb) { syncRoleCallback = cb; }
  void setSetNodeIdCallback(SetNodeIdCallback cb) { setNodeIdCallback = cb; } // New Setter
  void setGetCalibrationCallback(GetCalibrationCallback cb)
  {
    getCalibrationCallback = cb;
  }
  void setZuptCallback(ZuptCallback cb) { zuptCallback = cb; }
  void setMagCalibrateCallback(MagCalibrateCallback cb)
  {
    magCalibrateCallback = cb;
  }
  void setGetMagCalibrationCallback(GetMagCalibrationCallback cb)
  {
    getMagCalibrationCallback = cb;
  }
  void setClearCalibrationCallback(VoidCallback cb)
  {
    clearCalibrationCallback = cb;
  }

private:
  VoidCallback startCallback;
  VoidCallback stopCallback;
  SampleRateCallback sampleRateCallback;
  AccelRangeCallback accelRangeCallback;
  GyroRangeCallback gyroRangeCallback;
  ModeCallback modeCallback;
  StatusCallback statusCallback;
  CalibrateCallback calibrateCallback;
  CalibrateCallback calibrateGyroCallback;
  WiFiCallback wifiCallback;
  OutputModeCallback outputModeCallback;
  FilterBetaCallback filterBetaCallback;
  SetNameCallback setNameCallback;
  SyncRoleCallback syncRoleCallback;
  SetNodeIdCallback setNodeIdCallback; // New Member
  GetCalibrationCallback getCalibrationCallback;
  ZuptCallback zuptCallback;
  MagCalibrateCallback magCalibrateCallback;
  GetMagCalibrationCallback getMagCalibrationCallback;
  VoidCallback clearCalibrationCallback;

  String successResponse(const char *message);
  String errorResponse(const char *message);
};

#endif // COMMAND_HANDLER_H
