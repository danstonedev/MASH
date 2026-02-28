/*******************************************************************************
 * CommandHandler.cpp - Unified Command Processing Implementation
 *
 * Command Protocol (JSON):
 *
 * Commands:
 *   {"cmd": "START"}                          - Start data streaming
 *   {"cmd": "STOP"}                           - Stop data streaming
 *   {"cmd": "SET_RATE", "rate": 60}           - Set sample rate (30, 60, 120)
 *   {"cmd": "SET_ACCEL_RANGE", "range": 16}   - Set accel range (4, 8, 16, 30)
 *   {"cmd": "SET_GYRO_RANGE", "range": 2000}  - Set gyro range
 *   {"cmd": "GET_STATUS"}                     - Request device status
 *   {"cmd": "CALIBRATE", "sensor": 0}         - Calibrate sensor
 *   {"cmd": "SET_WIFI", "ssid": "...", "password": "..."}
 *   {"cmd": "SWITCH_MODE", "mode": "ble"}     - Switch to BLE or WiFi
 *   {"cmd": "SET_OUTPUT_MODE", "mode": "quaternion"} - Set output to
 * raw/quaternion
 *   {"cmd": "SET_FILTER_BETA", "beta": 0.1}   - Set Madgwick filter gain
 *
 * Responses:
 *   {"success": true, "message": "..."}
 *   {"success": false, "error": "..."}
 *   {"type": "status", ...}
 ******************************************************************************/

// IMPORTANT: Define DEVICE_ROLE before including Config.h
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include "CommandHandler.h"

CommandHandler::CommandHandler()
    : startCallback(nullptr), stopCallback(nullptr),
      sampleRateCallback(nullptr), accelRangeCallback(nullptr),
      gyroRangeCallback(nullptr), modeCallback(nullptr),
      statusCallback(nullptr), calibrateCallback(nullptr),
      wifiCallback(nullptr), wifiConnectCallback(nullptr),
      wifiStatusCallback(nullptr), outputModeCallback(nullptr),
      filterBetaCallback(nullptr), setNameCallback(nullptr),
      syncRoleCallback(nullptr), getCalibrationCallback(nullptr),
      zuptCallback(nullptr), otaStartCallback(nullptr),
      otaAbortCallback(nullptr), calibrateGyroCallback(nullptr),
      wifiScanCallback(nullptr), startSoftAPCallback(nullptr),
      stopSoftAPCallback(nullptr), getSoftAPStatusCallback(nullptr),
      clearCalibrationCallback(nullptr), tdmaRescanCallback(nullptr) {}

String CommandHandler::processCommand(const String &command)
{
  SAFE_LOG("[CmdHandler] Processing: %s\n", command.c_str());

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, command);

  if (error)
  {
    SAFE_LOG("[CmdHandler] JSON parse error: %s\n", error.c_str());
    return errorResponse("Invalid JSON");
  }

  const char *cmd = doc["cmd"];
  if (!cmd)
  {
    return errorResponse("Missing 'cmd' field");
  }

  // START streaming
  if (strcmp(cmd, "START") == 0)
  {
    if (startCallback)
    {
      startCallback();
      return successResponse("Streaming started");
    }
    return errorResponse("Start callback not set");
  }

  // STOP streaming
  if (strcmp(cmd, "STOP") == 0)
  {
    if (stopCallback)
    {
      stopCallback();
      return successResponse("Streaming stopped");
    }
    return errorResponse("Stop callback not set");
  }

  // CALIBRATE_GYRO - Zero gyros only (persistent)
  if (strcmp(cmd, "CALIBRATE_GYRO") == 0)
  {
    uint8_t sensorId = doc["sensor"] | 0;
    if (calibrateGyroCallback)
    {
      calibrateGyroCallback(sensorId);
      char msg[50];
      snprintf(msg, sizeof(msg), "Gyro zeroing started for sensor %d",
               sensorId);
      return successResponse(msg);
    }
    return errorResponse("Calibrate Gyro callback not set");
  }

  // SET_RATE
  if (strcmp(cmd, "SET_RATE") == 0)
  {
    uint16_t rate = doc["rate"] | 0;
    if (rate == 30 || rate == 60 || rate == 100 || rate == 120 || rate == 200)
    {
      if (sampleRateCallback)
      {
        sampleRateCallback(rate);
        char msg[50];
        snprintf(msg, sizeof(msg), "Sample rate set to %d Hz", rate);
        return successResponse(msg);
      }
      return errorResponse("Sample rate callback not set");
    }
    return errorResponse("Invalid rate (use 30, 60, 100, 120, or 200)");
  }

  // SET_ACCEL_RANGE
  if (strcmp(cmd, "SET_ACCEL_RANGE") == 0)
  {
    uint8_t range = doc["range"] | 0;
    if (range == 4 || range == 8 || range == 16 || range == 30)
    {
      if (accelRangeCallback)
      {
        accelRangeCallback(range);
        char msg[50];
        snprintf(msg, sizeof(msg), "Accel range set to +/-%dg", range);
        return successResponse(msg);
      }
      return errorResponse("Accel range callback not set");
    }
    return errorResponse("Invalid range (use 4, 8, 16, or 30)");
  }

  // SET_GYRO_RANGE
  if (strcmp(cmd, "SET_GYRO_RANGE") == 0)
  {
    uint16_t range = doc["range"] | 0;
    if (range == 500 || range == 1000 || range == 2000 || range == 4000)
    {
      if (gyroRangeCallback)
      {
        gyroRangeCallback(range);
        char msg[50];
        snprintf(msg, sizeof(msg), "Gyro range set to +/-%d dps", range);
        return successResponse(msg);
      }
      return errorResponse("Gyro range callback not set");
    }
    return errorResponse("Invalid range (use 500, 1000, 2000, or 4000)");
  }

  // GET_STATUS
  if (strcmp(cmd, "GET_STATUS") == 0)
  {
    if (statusCallback)
    {
      StaticJsonDocument<256> response;
      response["type"] = "status";
      statusCallback(response);

      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("Status callback not set");
  }

  // CALIBRATE
  if (strcmp(cmd, "CALIBRATE") == 0)
  {
    uint8_t sensorId = doc["sensor"] | 0;
    if (calibrateCallback)
    {
      calibrateCallback(sensorId);
      char msg[50];
      snprintf(msg, sizeof(msg), "Calibration started for sensor %d", sensorId);
      return successResponse(msg);
    }
    return errorResponse("Calibrate callback not set");
  }

  // SET_WIFI
  if (strcmp(cmd, "SET_WIFI") == 0)
  {
    const char *ssid = doc["ssid"];
    const char *password = doc["password"];

    if (ssid && password)
    {
      if (wifiCallback)
      {
        wifiCallback(ssid, password);
        return successResponse("WiFi credentials updated");
      }
      return errorResponse("WiFi callback not set");
    }
    return errorResponse("Missing ssid or password");
  }

  // CONNECT_WIFI - Connect to saved WiFi network
  if (strcmp(cmd, "CONNECT_WIFI") == 0)
  {
    if (wifiConnectCallback)
    {
      bool success = wifiConnectCallback();
      if (success)
      {
        return successResponse("WiFi connected");
      }
      return errorResponse("WiFi connection failed");
    }
    return errorResponse("WiFi connect callback not set");
  }

  // GET_WIFI_STATUS - Get WiFi connection status and IP
  if (strcmp(cmd, "GET_WIFI_STATUS") == 0)
  {
    if (wifiStatusCallback)
    {
      StaticJsonDocument<256> response;
      response["type"] = "wifi_status";
      wifiStatusCallback(response);

      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("WiFi status callback not set");
  }

  // SCAN_WIFI - Scan for networks
  if (strcmp(cmd, "SCAN_WIFI") == 0)
  {
    if (wifiScanCallback)
    {
      String networks = wifiScanCallback();
      // Networks is already a JSON string []
      // Parse networks separately then add to response
      StaticJsonDocument<1024> response;
      StaticJsonDocument<768> networkDoc;
      response["type"] = "wifi_scan";
      DeserializationError err = deserializeJson(networkDoc, networks);
      if (err)
      {
        response["networks"] = JsonArray();
      }
      else
      {
        response["networks"] = networkDoc.as<JsonArray>();
      }

      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("WiFi scan callback not set");
  }

  // START_SOFTAP
  if (strcmp(cmd, "START_SOFTAP") == 0)
  {
    const char *ssid = doc["ssid"];
    const char *password = doc["password"]; // Optional

    if (ssid)
    {
      if (startSoftAPCallback)
      {
        bool success = startSoftAPCallback(ssid, password);
        if (success)
        {
          return successResponse("SoftAP started");
        }
        return errorResponse("Failed to start SoftAP");
      }
      return errorResponse("Start SoftAP callback not set");
    }
    return errorResponse("Missing ssid");
  }

  // STOP_SOFTAP
  if (strcmp(cmd, "STOP_SOFTAP") == 0)
  {
    if (stopSoftAPCallback)
    {
      stopSoftAPCallback();
      return successResponse("SoftAP stopped");
    }
    return errorResponse("Stop SoftAP callback not set");
  }

  // GET_SOFTAP_STATUS
  if (strcmp(cmd, "GET_SOFTAP_STATUS") == 0)
  {
    if (getSoftAPStatusCallback)
    {
      bool active = getSoftAPStatusCallback();
      StaticJsonDocument<64> response;
      response["type"] = "softap_status";
      response["active"] = active;

      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("Get SoftAP Status callback not set");
  }

  // SWITCH_MODE (BLE/WiFi)
  if (strcmp(cmd, "SWITCH_MODE") == 0)
  {
    const char *mode = doc["mode"];
    if (mode)
    {
      if (modeCallback)
      {
        if (strcmp(mode, "ble") == 0)
        {
          modeCallback(MODE_BLE);
          return successResponse("Switched to BLE mode");
        }
        else if (strcmp(mode, "wifi") == 0)
        {
          modeCallback(MODE_WIFI);
          return successResponse("Switched to WiFi mode");
        }
        return errorResponse("Invalid mode (use 'ble' or 'wifi')");
      }
      return errorResponse("Mode callback not set");
    }
    return errorResponse("Missing mode");
  }

  // SET_OUTPUT_MODE (raw/quaternion/quaternion_extended)
  if (strcmp(cmd, "SET_OUTPUT_MODE") == 0)
  {
    const char *mode = doc["mode"];
    if (mode)
    {
      if (outputModeCallback)
      {
        if (strcmp(mode, "quaternion") == 0)
        {
          outputModeCallback(OUTPUT_QUATERNION);
          return successResponse("Output mode set to quaternion");
        }
        else if (strcmp(mode, "quaternion_extended") == 0)
        {
          outputModeCallback(OUTPUT_QUATERNION_EXTENDED);
          return successResponse("Output mode set to quaternion_extended");
        }
        else if (strcmp(mode, "raw") == 0)
        {
          outputModeCallback(OUTPUT_RAW);
          return successResponse("Output mode set to raw");
        }
        return errorResponse("Invalid output mode (use 'quaternion', "
                             "'quaternion_extended', or 'raw')");
      }
      return errorResponse("Output mode callback not set");
    }
    return errorResponse("Missing mode");
  }

  // SET_FILTER_BETA
  if (strcmp(cmd, "SET_FILTER_BETA") == 0)
  {
    float beta = doc["beta"] | 0.1f;
    if (beta >= 0.01f && beta <= 1.0f)
    {
      if (filterBetaCallback)
      {
        filterBetaCallback(beta);
        char msg[50];
        snprintf(msg, sizeof(msg), "Filter beta set to %.3f", beta);
        return successResponse(msg);
      }
      return errorResponse("Filter beta callback not set");
    }
    return errorResponse("Invalid beta (use 0.01 to 1.0)");
  }

  // SET_NAME
  if (strcmp(cmd, "SET_NAME") == 0)
  {
    const char *name = doc["name"];
    if (name)
    {
      if (setNameCallback)
      {
        setNameCallback(name);
        return successResponse("Device name updated. Rebooting...");
      }
      return errorResponse("Set name callback not set");
    }
    return errorResponse("Missing name argument");
  }

  // SET_SYNC_ROLE
  if (strcmp(cmd, "SET_SYNC_ROLE") == 0)
  {
    const char *role = doc["role"];
    if (role)
    {
      if (syncRoleCallback)
      {
        syncRoleCallback(role);
        return successResponse("Sync role updated");
      }
      return errorResponse("Sync role callback not set");
    }
    return errorResponse("Missing role (master/slave/auto)");
  }

  // GET_CALIBRATION - returns calibration data for a sensor
  if (strcmp(cmd, "GET_CALIBRATION") == 0)
  {
    uint8_t sensorId = doc["sensor"] | 0;
    if (getCalibrationCallback)
    {
      StaticJsonDocument<384> response;
      response["type"] = "calibration";
      getCalibrationCallback(sensorId, response);

      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("Get calibration callback not set");
  }

  // SET_ZUPT - configure ZUPT thresholds
  if (strcmp(cmd, "SET_ZUPT") == 0)
  {
    float gyroThresh = doc["gyro"] | 0.05f;
    float accelThresh = doc["accel"] | 0.2f;
    int minFrames = doc["frames"] | 10;
    if (zuptCallback)
    {
      zuptCallback(gyroThresh, accelThresh, minFrames);
      return successResponse("ZUPT thresholds updated");
    }
    return errorResponse("ZUPT callback not set");
  }

  // GET_VERSION - returns firmware version
  if (strcmp(cmd, "GET_VERSION") == 0)
  {
    StaticJsonDocument<128> response;
    response["type"] = "version";
    response["version"] = FIRMWARE_VERSION;
    response["major"] = FIRMWARE_VERSION_MAJOR;
    response["minor"] = FIRMWARE_VERSION_MINOR;
    response["patch"] = FIRMWARE_VERSION_PATCH;
#if DEVICE_ROLE == DEVICE_ROLE_GATEWAY
    response["role"] = "gateway";
#elif DEVICE_ROLE == DEVICE_ROLE_NODE
    response["role"] = "node";
#else
    response["role"] = "standalone";
#endif
    String output;
    serializeJson(response, output);
    return output;
  }

  // OTA_START - begin OTA update session
  if (strcmp(cmd, "OTA_START") == 0)
  {
    uint32_t size = doc["size"] | 0;
    const char *md5 = doc["md5"] | nullptr;

    if (size == 0)
    {
      return errorResponse("Missing or invalid size parameter");
    }

    if (otaStartCallback)
    {
      bool success = otaStartCallback(size, md5);
      if (success)
      {
        return successResponse("OTA session started");
      }
      return errorResponse("Failed to start OTA session");
    }
    return errorResponse("OTA start callback not set");
  }

  // OTA_ABORT - abort current OTA update
  if (strcmp(cmd, "OTA_ABORT") == 0)
  {
    if (otaAbortCallback)
    {
      otaAbortCallback();
      return successResponse("OTA update aborted");
    }
    return errorResponse("OTA abort callback not set");
  }

  // CALIBRATE_MAG - Forward magnetometer calibration to Nodes via ESP-NOW
  if (strcmp(cmd, "CALIBRATE_MAG") == 0)
  {
    uint32_t duration = doc["duration"] | 15000; // Default 15 seconds
    if (magCalibCallback)
    {
      magCalibCallback(CMD_MAG_CALIBRATE, duration);
      char msg[80];
      snprintf(msg, sizeof(msg),
               "Magnetometer calibration forwarded to nodes (%lu ms)",
               duration);
      return successResponse(msg);
    }
    return errorResponse("Magnetometer calibration callback not set");
  }

  // CALIBRATE_GYRO - Forward gyro calibration to Nodes via ESP-NOW
  if (strcmp(cmd, "CALIBRATE_GYRO") == 0)
  {
    uint8_t sensorId = doc["sensor"] | 0xFF; // Default 0xFF (all)
    if (magCalibCallback)
    {
      magCalibCallback(CMD_GYRO_CALIBRATE, sensorId);
      char msg[80];
      snprintf(msg, sizeof(msg),
               "Gyro calibration forwarded to nodes (sensor %d)", sensorId);
      return successResponse(msg);
    }
    return errorResponse("Magnetometer calibration callback not set");
  }

  // CLEAR_MAG_CALIBRATION - Forward clear command to Nodes
  if (strcmp(cmd, "CLEAR_MAG_CALIBRATION") == 0)
  {
    if (magCalibCallback)
    {
      magCalibCallback(CMD_MAG_CLEAR, 0);
      return successResponse(
          "Magnetometer calibration clear forwarded to nodes");
    }
    return errorResponse("Magnetometer calibration callback not set");
  }

  // CLEAR_CALIBRATION - Reset all IMU calibration data (use after firmware coord frame changes)
  if (strcmp(cmd, "CLEAR_CALIBRATION") == 0)
  {
    if (clearCalibrationCallback)
    {
      clearCalibrationCallback();
      return successResponse("All calibration data cleared. Device will re-calibrate on next boot.");
    }
    return errorResponse("Clear calibration callback not set");
  }

  // ============================================================================
  // GET_SYNC_STATUS - Pre-streaming readiness verification
  // ============================================================================
  // Returns TDMA state, registered nodes, SyncFrameBuffer health metrics,
  // and a composite "ready" flag for the webapp to gate streaming on.
  // ============================================================================
  if (strcmp(cmd, "GET_SYNC_STATUS") == 0)
  {
    if (syncStatusCallback)
    {
      // 2048 bytes: sync_status carries per-node arrays + buffer metrics.
      // With 8 nodes × 8 fields each, ArduinoJson needs ~1300 bytes of pool.
      StaticJsonDocument<2048> response;
      response["type"] = "sync_status";
      syncStatusCallback(response);
      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("Sync status callback not set");
  }

  // ============================================================================
  // LOCK_DISCOVERY — Lock/unlock node discovery
  // ============================================================================
  if (strcmp(cmd, "LOCK_DISCOVERY") == 0)
  {
    if (discoveryLockCallback)
    {
      discoveryLockCallback(true);
      return successResponse("Discovery locked");
    }
    return errorResponse("Discovery lock callback not set");
  }

  if (strcmp(cmd, "UNLOCK_DISCOVERY") == 0)
  {
    if (discoveryLockCallback)
    {
      discoveryLockCallback(false);
      return successResponse("Discovery unlocked");
    }
    return errorResponse("Discovery lock callback not set");
  }

  // ============================================================================
  // ACCEPT_NODE / REJECT_NODE — Late-join control
  // ============================================================================
  if (strcmp(cmd, "ACCEPT_NODE") == 0)
  {
    uint8_t nodeId = doc["nodeId"] | 0;
    if (acceptNodeCallback)
    {
      bool ok = acceptNodeCallback(nodeId);
      return ok ? successResponse("Node accepted")
                : errorResponse("Node not found in pending queue");
    }
    return errorResponse("Accept node callback not set");
  }

  if (strcmp(cmd, "REJECT_NODE") == 0)
  {
    uint8_t nodeId = doc["nodeId"] | 0;
    if (rejectNodeCallback)
    {
      bool ok = rejectNodeCallback(nodeId);
      return ok ? successResponse("Node rejected")
                : errorResponse("Node not found in pending queue");
    }
    return errorResponse("Reject node callback not set");
  }

  // ============================================================================
  // GET_PENDING_NODES — Retrieve queued late-join nodes
  // ============================================================================
  if (strcmp(cmd, "GET_PENDING_NODES") == 0)
  {
    if (pendingNodesCallback)
    {
      StaticJsonDocument<1024> response;
      response["type"] = "pending_nodes";
      pendingNodesCallback(response);
      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("Pending nodes callback not set");
  }

  // TDMA_RESCAN — wipe node table and restart full discovery
  if (strcmp(cmd, "TDMA_RESCAN") == 0)
  {
    if (tdmaRescanCallback)
    {
      tdmaRescanCallback();
      return successResponse("TDMA re-scan started");
    }
    return errorResponse("TDMA rescan callback not set");
  }

  // Unknown command
  char msg[100];
  snprintf(msg, sizeof(msg), "Unknown command: %s", cmd);
  return errorResponse(msg);
}

String CommandHandler::successResponse(const char *message)
{
  StaticJsonDocument<128> doc;
  doc["success"] = true;
  doc["message"] = message;

  String output;
  serializeJson(doc, output);
  return output;
}

String CommandHandler::errorResponse(const char *message)
{
  StaticJsonDocument<128> doc;
  doc["success"] = false;
  doc["error"] = message;

  String output;
  serializeJson(doc, output);
  return output;
}
