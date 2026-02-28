/*******************************************************************************
 * WiFiManager.cpp - WiFi Connection Management Implementation
 ******************************************************************************/

#include "WiFiManager.h"

WiFiManagerESP::WiFiManagerESP()
    : credentialsLoaded(false), lastConnectAttempt(0) {}

void WiFiManagerESP::init()
{
  Serial.println("[WiFi] Initializing...");

  // NOTE: WiFi.mode(WIFI_STA) is NOT called here.
  // SyncManager::init() is the sole caller of WiFi.mode() to avoid
  // duplicate WiFi stack resets that can disrupt ESP-NOW.

  // Load saved credentials
  loadCredentials();

  Serial.println("[WiFi] Initialization complete");
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
    Serial.printf("[WiFi] Loaded saved credentials for: %s\n", ssid.c_str());
  }
  else
  {
    Serial.println("[WiFi] No saved credentials found");
  }
}

void WiFiManagerESP::setCredentials(const char *newSsid,
                                    const char *newPassword)
{
  ssid = String(newSsid);
  password = String(newPassword);
  credentialsLoaded = true;

  Serial.printf("[WiFi] Credentials set for: %s\n", ssid.c_str());

  // Auto-save credentials
  saveCredentials();
}

void WiFiManagerESP::saveCredentials()
{
  preferences.begin(NVS_NAMESPACE, false); // Read-write

  preferences.putString(NVS_SSID_KEY, ssid);
  preferences.putString(NVS_PASS_KEY, password);

  preferences.end();

  Serial.println("[WiFi] Credentials saved to NVS");
}

void WiFiManagerESP::clearCredentials()
{
  preferences.begin(NVS_NAMESPACE, false);
  preferences.clear();
  preferences.end();

  ssid = "";
  password = "";
  credentialsLoaded = false;

  Serial.println("[WiFi] Credentials cleared");
}

bool WiFiManagerESP::connect()
{
  if (!credentialsLoaded)
  {
    Serial.println("[WiFi] No credentials available");
    return false;
  }

  Serial.printf("[WiFi] Connecting to %s...\n", ssid.c_str());

  WiFi.begin(ssid.c_str(), password.c_str());

  unsigned long startTime = millis();
  while (WiFi.status() != WL_CONNECTED)
  {
    if (millis() - startTime > WIFI_CONNECT_TIMEOUT_MS)
    {
      Serial.println("[WiFi] Connection timeout");
      return false;
    }
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.printf("[WiFi] Connected! IP: %s\n",
                WiFi.localIP().toString().c_str());
  Serial.printf("[WiFi] Signal strength: %d dBm\n", WiFi.RSSI());

  return true;
}

void WiFiManagerESP::connectAsync()
{
  if (!credentialsLoaded)
  {
    Serial.println("[WiFi] No credentials available for async connect");
    return;
  }

  lastConnectAttempt = millis();
  WiFi.begin(ssid.c_str(), password.c_str());

  Serial.printf("[WiFi] Async connection started to %s\n", ssid.c_str());
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
  Serial.println("[WiFi] Disconnected");
}

void WiFiManagerESP::stopConnection()
{
  // false = keep radio ON (crucial for ESP-NOW)
  WiFi.disconnect(false);
  Serial.println("[WiFi] Stopped connection attempts (Radio kept ON)");
}
