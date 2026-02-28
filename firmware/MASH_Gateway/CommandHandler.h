/*******************************************************************************
 * CommandHandler.h - Unified Command Processing
 *
 * Handles commands from both BLE and WebSocket connections with a consistent
 * JSON-based protocol for controlling the IMU device from the web app.
 ******************************************************************************/

#ifndef COMMAND_HANDLER_H
#define COMMAND_HANDLER_H

#include "Config.h"
// Note: OutputMode is now defined in Config.h (shared)
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
typedef std::function<bool()> WiFiConnectCallback;
typedef std::function<void(JsonDocument &)> WiFiStatusCallback;
typedef std::function<void(OutputMode)> OutputModeCallback;
typedef std::function<void(float)> FilterBetaCallback;
typedef std::function<void(const char *)> SetNameCallback;
typedef std::function<void(const char *)> SyncRoleCallback;
typedef std::function<void(uint8_t, JsonDocument &)> GetCalibrationCallback;
typedef std::function<void(float, float, int)> ZuptCallback;
// OTA callbacks
typedef std::function<bool(uint32_t, const char *)>
    OTAStartCallback; // size, md5 -> success
typedef std::function<void()> OTAAbortCallback;

// Mag calibration callback (cmdType, param) - for Gateway to forward to Nodes
typedef std::function<void(uint8_t, uint32_t)> MagCalibCallback;

typedef std::function<String()> WiFiScanCallback; // returns JSON string
typedef std::function<bool(const char *, const char *)> StartSoftAPCallback;
typedef std::function<void()> StopSoftAPCallback;
typedef std::function<bool()> GetSoftAPStatusCallback;
typedef std::function<void(JsonDocument &)> SyncStatusCallback;

// Discovery lock callbacks
typedef std::function<void(bool)> DiscoveryLockCallback;
typedef std::function<bool(uint8_t)> AcceptRejectNodeCallback;
typedef std::function<void(JsonDocument &)> PendingNodesCallback;

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
  void setWiFiConnectCallback(WiFiConnectCallback cb)
  {
    wifiConnectCallback = cb;
  }
  void setWiFiStatusCallback(WiFiStatusCallback cb) { wifiStatusCallback = cb; }
  void setOutputModeCallback(OutputModeCallback cb) { outputModeCallback = cb; }
  void setFilterBetaCallback(FilterBetaCallback cb) { filterBetaCallback = cb; }
  void setSetNameCallback(SetNameCallback cb) { setNameCallback = cb; }
  void setSyncRoleCallback(SyncRoleCallback cb) { syncRoleCallback = cb; }
  void setGetCalibrationCallback(GetCalibrationCallback cb)
  {
    getCalibrationCallback = cb;
  }
  void setZuptCallback(ZuptCallback cb) { zuptCallback = cb; }
  void setOTAStartCallback(OTAStartCallback cb) { otaStartCallback = cb; }
  void setOTAAbortCallback(OTAAbortCallback cb) { otaAbortCallback = cb; }
  void setWiFiScanCallback(WiFiScanCallback cb) { wifiScanCallback = cb; }
  void setStartSoftAPCallback(StartSoftAPCallback cb)
  {
    startSoftAPCallback = cb;
  }
  void setStopSoftAPCallback(StopSoftAPCallback cb) { stopSoftAPCallback = cb; }
  void setGetSoftAPStatusCallback(GetSoftAPStatusCallback cb)
  {
    getSoftAPStatusCallback = cb;
  }
  void setMagCalibCallback(MagCalibCallback cb) { magCalibCallback = cb; }
  void setClearCalibrationCallback(VoidCallback cb)
  {
    clearCalibrationCallback = cb;
  }
  void setTDMARescanCallback(VoidCallback cb) { tdmaRescanCallback = cb; }
  void setSyncStatusCallback(SyncStatusCallback cb)
  {
    syncStatusCallback = cb;
  }
  void setDiscoveryLockCallback(DiscoveryLockCallback cb)
  {
    discoveryLockCallback = cb;
  }
  void setAcceptNodeCallback(AcceptRejectNodeCallback cb)
  {
    acceptNodeCallback = cb;
  }
  void setRejectNodeCallback(AcceptRejectNodeCallback cb)
  {
    rejectNodeCallback = cb;
  }
  void setPendingNodesCallback(PendingNodesCallback cb)
  {
    pendingNodesCallback = cb;
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
  WiFiConnectCallback wifiConnectCallback;
  WiFiStatusCallback wifiStatusCallback;
  OutputModeCallback outputModeCallback;
  FilterBetaCallback filterBetaCallback;
  SetNameCallback setNameCallback;
  SyncRoleCallback syncRoleCallback;
  GetCalibrationCallback getCalibrationCallback;
  ZuptCallback zuptCallback;
  OTAStartCallback otaStartCallback;
  OTAAbortCallback otaAbortCallback;
  WiFiScanCallback wifiScanCallback;
  StartSoftAPCallback startSoftAPCallback;
  StopSoftAPCallback stopSoftAPCallback;
  GetSoftAPStatusCallback getSoftAPStatusCallback;
  MagCalibCallback magCalibCallback;
  VoidCallback clearCalibrationCallback;
  VoidCallback tdmaRescanCallback;
  SyncStatusCallback syncStatusCallback;
  DiscoveryLockCallback discoveryLockCallback;
  AcceptRejectNodeCallback acceptNodeCallback;
  AcceptRejectNodeCallback rejectNodeCallback;
  PendingNodesCallback pendingNodesCallback;

  String successResponse(const char *message);
  String errorResponse(const char *message);
};

#endif // COMMAND_HANDLER_H
