/*******************************************************************************
 * WiFiManager.cpp - WiFi Connection Management Implementation
 ******************************************************************************/

// IMPORTANT: Define DEVICE_ROLE before including Config.h
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include "WiFiManager.h"

WiFiManagerESP::WiFiManagerESP()
    : credentialsLoaded(false), apModeActive(false), lastConnectAttempt(0) {}

void WiFiManagerESP::init()
{
  SAFE_PRINTLN("[WiFi] Initializing...");

  // NOTE: WiFi.mode(WIFI_STA) is NOT called here.
  // SyncManager::init() sets it when initializing ESP-NOW.
  // Calling it twice can reset the radio stack and disrupt ESP-NOW.

  // Load saved credentials
  loadCredentials();

  SAFE_PRINTLN("[WiFi] Initialization complete");
}

void WiFiManagerESP::loadCredentials()
{
  preferences.begin(NVS_NAMESPACE, true); // Read-only

  ssid = preferences.getString(NVS_SSID_KEY, "");
  password = preferences.getString(NVS_PASS_KEY, "");

  preferences.end();

  credentialsLoaded = (ssid.length() > 0);

  if (credentialsLoaded)
  {
    SAFE_LOG("[WiFi] Loaded saved credentials for: %s\n", ssid.c_str());
  }
  else
  {
    SAFE_PRINTLN("[WiFi] No saved credentials found");
  }
}

void WiFiManagerESP::setCredentials(const char *newSsid,
                                    const char *newPassword)
{
  ssid = String(newSsid);
  password = String(newPassword);
  credentialsLoaded = true;

  SAFE_LOG("[WiFi] Credentials set for: %s\n", ssid.c_str());

  // Auto-save credentials
  saveCredentials();
}

void WiFiManagerESP::saveCredentials()
{
  preferences.begin(NVS_NAMESPACE, false); // Read-write

  preferences.putString(NVS_SSID_KEY, ssid);
  preferences.putString(NVS_PASS_KEY, password);

  preferences.end();

  SAFE_PRINTLN("[WiFi] Credentials saved to NVS");
}

void WiFiManagerESP::clearCredentials()
{
  preferences.begin(NVS_NAMESPACE, false);
  preferences.clear();
  preferences.end();

  ssid = "";
  password = "";
  credentialsLoaded = false;

  SAFE_PRINTLN("[WiFi] Credentials cleared");
}

bool WiFiManagerESP::connect()
{
  if (!credentialsLoaded)
  {
    SAFE_PRINTLN("[WiFi] No credentials available");
    return false;
  }

  SAFE_LOG("[WiFi] Connecting to %s...\n", ssid.c_str());

  WiFi.begin(ssid.c_str(), password.c_str());

  unsigned long startTime = millis();
  while (WiFi.status() != WL_CONNECTED)
  {
    if (millis() - startTime > WIFI_CONNECT_TIMEOUT_MS)
    {
      SAFE_PRINTLN("[WiFi] Connection timeout");
      return false;
    }
    delay(500);
    SAFE_PRINT(".");
  }

  SAFE_PRINTLN();
  SAFE_LOG("[WiFi] Connected! IP: %s\n",
           WiFi.localIP().toString().c_str());
  SAFE_LOG("[WiFi] Signal strength: %d dBm\n", WiFi.RSSI());

  return true;
}

void WiFiManagerESP::connectAsync()
{
  if (!credentialsLoaded)
  {
    SAFE_PRINTLN("[WiFi] No credentials available for async connect");
    return;
  }

  lastConnectAttempt = millis();
  WiFi.begin(ssid.c_str(), password.c_str());

  SAFE_LOG("[WiFi] Async connection started to %s\n", ssid.c_str());
}

bool WiFiManagerESP::isConnected() const
{
  return WiFi.status() == WL_CONNECTED;
}

String WiFiManagerESP::getIPAddress() const
{
  if (isConnected())
  {
    return WiFi.localIP().toString();
  }
  return "Not connected";
}

bool WiFiManagerESP::hasSavedCredentials() const { return credentialsLoaded; }

int WiFiManagerESP::getRSSI() const
{
  if (isConnected())
  {
    return WiFi.RSSI();
  }
  return 0;
}

void WiFiManagerESP::disconnect()
{
  WiFi.disconnect(true);
  SAFE_PRINTLN("[WiFi] Disconnected");
}

String WiFiManagerESP::scanNetworks()
{
  SAFE_PRINTLN("[WiFi] Scanning networks...");
  int n = WiFi.scanNetworks();
  SAFE_LOG("[WiFi] Scan done. Found %d networks\n", n);

  if (n == 0)
  {
    return "[]";
  }

  // Build JSON string manually to avoid heavy JSON library overhead for this
  // simple list
  String json = "[";
  for (int i = 0; i < n; ++i)
  {
    if (i > 0)
      json += ",";
    json += "{\"ssid\":\"" + WiFi.SSID(i) + "\",";
    json += "\"rssi\":" + String(WiFi.RSSI(i)) + ",";
    json +=
        "\"auth\":" + String(WiFi.encryptionType(i) != WIFI_AUTH_OPEN) + "}";
  }
  json += "]";
  return json;
}

bool WiFiManagerESP::startAP(const char *ssid, const char *password)
{
  SAFE_LOG("[WiFi] Starting SoftAP: %s\n", ssid);

  WiFi.mode(
      WIFI_AP_STA); // AP + Station mode to keep scanning/connecting ability

  bool result = WiFi.softAP(ssid, password);
  if (result)
  {
    // Configure fixed IP
    WiFi.softAPConfig(SOFTAP_IP, SOFTAP_GATEWAY, SOFTAP_SUBNET);
    SAFE_LOG("[WiFi] AP Started. IP: %s\n",
             WiFi.softAPIP().toString().c_str());
    apModeActive = true;
  }
  else
  {
    SAFE_PRINTLN("[WiFi] AP Start Failed");
    apModeActive = false;
  }
  return result;
}

void WiFiManagerESP::stopAP()
{
  if (apModeActive)
  {
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA); // Revert to station only
    apModeActive = false;
    SAFE_PRINTLN("[WiFi] AP Stopped");
  }
}

bool WiFiManagerESP::isAPActive() const { return apModeActive; }
