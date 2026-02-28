/*******************************************************************************
 * WiFiOTAServer.cpp - HTTP Server for OTA Firmware Updates Implementation
 ******************************************************************************/

// IMPORTANT: Define DEVICE_ROLE before including Config.h
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include "WiFiOTAServer.h"
#include <ArduinoJson.h>

// Firmware version - update this when releasing new firmware
#define FIRMWARE_VERSION "1.0.0"

// HTML page for upload form
static const char OTA_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>IMU-Connect OTA Update</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 500px; 
      margin: 50px auto; 
      padding: 20px;
      background: #1a1a1a;
      color: #fff;
    }
    h1 { color: #00ff88; }
    .card {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin: 20px 0;
    }
    .info { color: #888; font-size: 14px; margin: 8px 0; }
    input[type="file"] {
      display: block;
      margin: 16px 0;
      padding: 12px;
      background: #333;
      border: 2px dashed #555;
      border-radius: 8px;
      width: 100%;
      box-sizing: border-box;
      color: #fff;
    }
    button {
      background: #00ff88;
      color: #000;
      border: none;
      padding: 12px 32px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      width: 100%;
    }
    button:hover { background: #00cc6a; }
    button:disabled { background: #555; color: #888; cursor: not-allowed; }
    .progress {
      height: 20px;
      background: #333;
      border-radius: 10px;
      overflow: hidden;
      margin: 16px 0;
      display: none;
    }
    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #00ff88, #00cc6a);
      width: 0%;
      transition: width 0.3s;
    }
    .status { margin-top: 16px; font-size: 14px; }
    .success { color: #00ff88; }
    .error { color: #ff4444; }
  </style>
</head>
<body>
  <h1>🔧 IMU-Connect Gateway</h1>
  <div class="card">
    <h2>Firmware Update</h2>
    <p class="info">Current Version: <strong id="version">Loading...</strong></p>
    <p class="info">Free Heap: <strong id="heap">Loading...</strong></p>
    <form id="upload-form" enctype="multipart/form-data">
      <input type="file" name="firmware" id="firmware-file" accept=".bin">
      <div class="progress" id="progress">
        <div class="progress-bar" id="progress-bar"></div>
      </div>
      <button type="submit" id="upload-btn">Upload Firmware</button>
    </form>
    <div class="status" id="status"></div>
  </div>

  <script>
    // Fetch device info
    fetch('/info')
      .then(r => r.json())
      .then(data => {
        document.getElementById('version').textContent = data.version;
        document.getElementById('heap').textContent = Math.round(data.freeHeap / 1024) + ' KB';
      });

    // Handle form submission
    document.getElementById('upload-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const fileInput = document.getElementById('firmware-file');
      const file = fileInput.files[0];
      if (!file) {
        alert('Please select a firmware file');
        return;
      }

      const btn = document.getElementById('upload-btn');
      const progress = document.getElementById('progress');
      const progressBar = document.getElementById('progress-bar');
      const status = document.getElementById('status');

      btn.disabled = true;
      progress.style.display = 'block';
      status.textContent = 'Uploading...';
      status.className = 'status';

      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/ota', true);
        
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = (e.loaded / e.total) * 100;
            progressBar.style.width = percent + '%';
            status.textContent = 'Uploading... ' + Math.round(percent) + '%';
          }
        };

        xhr.onload = () => {
          if (xhr.status === 200) {
            status.textContent = '✓ Update successful! Device is rebooting...';
            status.className = 'status success';
            progressBar.style.width = '100%';
          } else {
            status.textContent = '✗ Update failed: ' + xhr.responseText;
            status.className = 'status error';
            btn.disabled = false;
          }
        };

        xhr.onerror = () => {
          status.textContent = '✗ Network error';
          status.className = 'status error';
          btn.disabled = false;
        };

        const formData = new FormData();
        formData.append('firmware', file);
        xhr.send(formData);
      } catch (err) {
        status.textContent = '✗ Error: ' + err.message;
        status.className = 'status error';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>
)rawliteral";

WiFiOTAServer::WiFiOTAServer()
    : server(nullptr), running(false), progressCallback(nullptr),
      completeCallback(nullptr), updateSize(0), updateProgress(0),
      updateStarted(false) {}

void WiFiOTAServer::init()
{
  if (running)
  {
    SAFE_PRINTLN("[WiFi-OTA] Server already running");
    return;
  }

  server = new AsyncWebServer(OTA_HTTP_PORT);

  // Root page with upload form
  server->on("/", HTTP_GET,
             [this](AsyncWebServerRequest *request)
             { handleRoot(request); });

  // Device info endpoint
  server->on("/info", HTTP_GET,
             [this](AsyncWebServerRequest *request)
             { handleInfo(request); });

  // OTA upload endpoint
  server->on(
      "/ota", HTTP_POST,
      [this](AsyncWebServerRequest *request)
      { handleOTAComplete(request); },
      [this](AsyncWebServerRequest *request, String filename, size_t index,
             uint8_t *data, size_t len, bool final)
      {
        handleOTAUpload(request, filename, index, data, len, final);
      });

  // Handle OPTIONS requests for CORS preflight
  server->on("/ota", HTTP_OPTIONS,
             [](AsyncWebServerRequest *request)
             { request->send(200); });

  // Enable CORS for web app
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods",
                                       "GET, POST, OPTIONS");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers",
                                       "Content-Type");

  server->begin();
  running = true;

  SAFE_LOG("[WiFi-OTA] HTTP server started on port %d\n", OTA_HTTP_PORT);
}

void WiFiOTAServer::stop()
{
  if (server && running)
  {
    server->end();
    delete server;
    server = nullptr;
    running = false;
    SAFE_PRINTLN("[WiFi-OTA] Server stopped");
  }
}

bool WiFiOTAServer::isRunning() const { return running; }

void WiFiOTAServer::setProgressCallback(WiFiOTAProgressCallback callback)
{
  progressCallback = callback;
}

void WiFiOTAServer::setCompleteCallback(WiFiOTACompleteCallback callback)
{
  completeCallback = callback;
}

const char *WiFiOTAServer::getFirmwareVersion() { return FIRMWARE_VERSION; }

void WiFiOTAServer::handleRoot(AsyncWebServerRequest *request)
{
  request->send_P(200, "text/html", OTA_HTML);
}

void WiFiOTAServer::handleInfo(AsyncWebServerRequest *request)
{
  StaticJsonDocument<256> doc;
  doc["version"] = FIRMWARE_VERSION;
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["chipModel"] = ESP.getChipModel();
  doc["chipRevision"] = ESP.getChipRevision();
  doc["flashSize"] = ESP.getFlashChipSize();

  String output;
  serializeJson(doc, output);
  request->send(200, "application/json", output);
}

void WiFiOTAServer::handleOTAUpload(AsyncWebServerRequest *request,
                                    String filename, size_t index,
                                    uint8_t *data, size_t len, bool final)
{
  // First chunk - start update
  if (index == 0)
  {
    SAFE_LOG("[WiFi-OTA] Starting update: %s\n", filename.c_str());

    updateSize = request->contentLength();
    updateProgress = 0;
    updateStarted = true;

    // Abort any previous update
    if (Update.isRunning())
    {
      Update.abort();
    }

    if (!Update.begin(updateSize, U_FLASH))
    {
      SAFE_LOG("[WiFi-OTA] Update.begin failed: %s\n",
               Update.errorString());
      updateStarted = false;
      return;
    }

    SAFE_LOG("[WiFi-OTA] Update started, size: %u bytes\n", updateSize);
  }

  // Write chunk
  if (updateStarted && len > 0)
  {
    if (Update.write(data, len) != len)
    {
      SAFE_LOG("[WiFi-OTA] Write failed: %s\n", Update.errorString());
      Update.abort();
      updateStarted = false;
      return;
    }

    updateProgress += len;

    // Log progress every 10%
    static uint8_t lastPercent = 0;
    uint8_t percent = (updateProgress * 100) / updateSize;
    if (percent >= lastPercent + 10)
    {
      SAFE_LOG("[WiFi-OTA] Progress: %u%% (%u/%u bytes)\n", percent,
               updateProgress, updateSize);
      lastPercent = percent;

      if (progressCallback)
      {
        progressCallback(updateProgress, updateSize);
      }
    }
  }

  // Final chunk - finish update
  if (final)
  {
    SAFE_LOG("[WiFi-OTA] Upload complete, total: %u bytes\n",
             updateProgress);

    if (Update.end(true))
    {
      SAFE_PRINTLN("[WiFi-OTA] Update successful!");
      if (completeCallback)
      {
        completeCallback(true, "Update successful");
      }
    }
    else
    {
      SAFE_LOG("[WiFi-OTA] Update failed: %s\n", Update.errorString());
      if (completeCallback)
      {
        completeCallback(false, Update.errorString());
      }
    }

    updateStarted = false;
  }
}

void WiFiOTAServer::handleOTAComplete(AsyncWebServerRequest *request)
{
  if (Update.hasError())
  {
    request->send(500, "text/plain", Update.errorString());
  }
  else
  {
    request->send(200, "text/plain", "OK");
    delay(1000);
    ESP.restart();
  }
}
