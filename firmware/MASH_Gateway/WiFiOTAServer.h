/*******************************************************************************
 * WiFiOTAServer.h - HTTP Server for OTA Firmware Updates
 *
 * Provides HTTP endpoints for fast WiFi-based firmware uploads.
 * Much faster than BLE OTA (100-500 KB/s vs 1-5 KB/s).
 ******************************************************************************/

#ifndef WIFI_OTA_SERVER_H
#define WIFI_OTA_SERVER_H

#include "Config.h"
#include <Arduino.h>
#include <ESPAsyncWebServer.h>
#include <Update.h>

// HTTP server port
#define OTA_HTTP_PORT 80

// Callback for OTA progress updates
typedef void (*WiFiOTAProgressCallback)(uint32_t current, uint32_t total);
typedef void (*WiFiOTACompleteCallback)(bool success, const char *message);

class WiFiOTAServer {
public:
  WiFiOTAServer();

  /**
   * Initialize the HTTP server (call after WiFi is connected)
   */
  void init();

  /**
   * Stop the HTTP server
   */
  void stop();

  /**
   * Check if server is running
   */
  bool isRunning() const;

  /**
   * Set progress callback
   */
  void setProgressCallback(WiFiOTAProgressCallback callback);

  /**
   * Set completion callback
   */
  void setCompleteCallback(WiFiOTACompleteCallback callback);

  /**
   * Get firmware version string
   */
  static const char *getFirmwareVersion();

private:
  AsyncWebServer *server;
  bool running;
  WiFiOTAProgressCallback progressCallback;
  WiFiOTACompleteCallback completeCallback;
  uint32_t updateSize;
  uint32_t updateProgress;
  bool updateStarted;

  /**
   * Handle root page request
   */
  void handleRoot(AsyncWebServerRequest *request);

  /**
   * Handle device info request
   */
  void handleInfo(AsyncWebServerRequest *request);

  /**
   * Handle OTA upload start
   */
  void handleOTAStart(AsyncWebServerRequest *request);

  /**
   * Handle OTA file upload
   */
  void handleOTAUpload(AsyncWebServerRequest *request, String filename,
                       size_t index, uint8_t *data, size_t len, bool final);

  /**
   * Handle OTA upload completion
   */
  void handleOTAComplete(AsyncWebServerRequest *request);
};

#endif // WIFI_OTA_SERVER_H
