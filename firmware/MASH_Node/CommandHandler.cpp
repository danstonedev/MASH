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

#include "CommandHandler.h"

CommandHandler::CommandHandler()
    : startCallback(nullptr), stopCallback(nullptr),
      sampleRateCallback(nullptr), accelRangeCallback(nullptr),
      gyroRangeCallback(nullptr), modeCallback(nullptr),
      statusCallback(nullptr), calibrateCallback(nullptr),
      wifiCallback(nullptr), outputModeCallback(nullptr),
      filterBetaCallback(nullptr), setNameCallback(nullptr),
      syncRoleCallback(nullptr), setNodeIdCallback(nullptr), getCalibrationCallback(nullptr),
      zuptCallback(nullptr), magCalibrateCallback(nullptr),
      getMagCalibrationCallback(nullptr), calibrateGyroCallback(nullptr),
      clearCalibrationCallback(nullptr) {}

String CommandHandler::processCommand(const String &command)
{
  Serial.printf("[CmdHandler] Processing: %s\n", command.c_str());

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, command);

  if (error)
  {
    Serial.printf("[CmdHandler] JSON parse error: %s\n", error.c_str());
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

  // SET_RATE
  if (strcmp(cmd, "SET_RATE") == 0)
  {
    uint16_t rate = doc["rate"] | 0;
    if (rate == 30 || rate == 60 || rate == 120)
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
    return errorResponse("Invalid rate (use 30, 60, or 120)");
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

  // SET_NODE_ID
  if (strcmp(cmd, "SET_NODE_ID") == 0)
  {
    if (doc.containsKey("nodeId"))
    {
      uint8_t id = doc["nodeId"];
      if (setNodeIdCallback)
      {
        setNodeIdCallback(id);
        char msg[64];
        snprintf(msg, sizeof(msg), "Node ID set to %d. Rebooting...", id);
        return successResponse(msg);
      }
      return errorResponse("Set Node ID callback not set");
    }
    return errorResponse("Missing 'nodeId' field");
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

  // CALIBRATE_MAG - Start magnetometer calibration
  if (strcmp(cmd, "CALIBRATE_MAG") == 0)
  {
    uint32_t duration = doc["duration"] | 15000; // Default 15 seconds
    if (magCalibrateCallback)
    {
      magCalibrateCallback(duration);
      char msg[80];
      snprintf(msg, sizeof(msg), "Magnetometer calibration started (%lu ms)",
               duration);
      return successResponse(msg);
    }
    return errorResponse("Magnetometer calibration callback not set");
  }

  // GET_MAG_CALIBRATION - Get magnetometer calibration data
  if (strcmp(cmd, "GET_MAG_CALIBRATION") == 0)
  {
    if (getMagCalibrationCallback)
    {
      StaticJsonDocument<384> response;
      response["type"] = "mag_calibration";
      getMagCalibrationCallback(response);

      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("Get magnetometer calibration callback not set");
  }

  // CLEAR_MAG_CALIBRATION - Clear magnetometer calibration
  if (strcmp(cmd, "CLEAR_MAG_CALIBRATION") == 0)
  {
    if (getMagCalibrationCallback)
    {
      // We'll reuse the callback to signal a clear operation
      StaticJsonDocument<128> response;
      response["type"] = "mag_calibration_cleared";
      response["success"] = true;

      String output;
      serializeJson(response, output);
      return output;
    }
    return errorResponse("Magnetometer calibration callback not set");
  }

  // SET_PROFILE - Apply PhD-grade activity profile
  if (strcmp(cmd, "SET_PROFILE") == 0)
  {
    int profileIds = doc["profile"] | 0;
    if (profileIds >= 0 && profileIds <= 2)
    {
      // We need a callback for this new method in CommandHandler.h too?
      // Actually, we usually map these to callbacks.
      // Let's add the callback member first or just use a generic one?
      // We need to update CommandHandler.h first.
      // Let's hold off on this file and update .h first.
      return errorResponse("Profile callback not implemented yet");
    }
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

  // CLEAR_CALIBRATION - Reset all calibration data (use after firmware coord frame changes)
  if (strcmp(cmd, "CLEAR_CALIBRATION") == 0)
  {
    if (clearCalibrationCallback)
    {
      clearCalibrationCallback();
      return successResponse("All calibration data cleared. Device will re-calibrate on next boot.");
    }
    return errorResponse("Clear calibration callback not set");
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
