/*******************************************************************************
 * WiFiManager.h - WiFi Connection Management
 *
 * Handles WiFi connection, credential storage in NVS, and async connection.
 ******************************************************************************/

#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include "Config.h"
#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>

#define SOFTAP_IP IPAddress(192, 168, 4, 1)
#define SOFTAP_GATEWAY IPAddress(192, 168, 4, 1)
#define SOFTAP_SUBNET IPAddress(255, 255, 255, 0)

// Using WiFiManagerESP to avoid conflict with WiFiManager libraries
class WiFiManagerESP {
public:
  WiFiManagerESP();

  /**
   * Initialize WiFi manager and load saved credentials
   */
  void init();

  /**
   * Set WiFi credentials (does not connect automatically)
   * @param ssid Network name
   * @param password Network password
   */
  void setCredentials(const char *ssid, const char *password);

  /**
   * Connect to WiFi synchronously (blocking)
   * @return true if connection successful
   */
  bool connect();

  /**
   * Start async WiFi connection (non-blocking)
   */
  void connectAsync();

  /**
   * Scan for available WiFi networks
   * @return JSON string of networks [{"ssid":"name","rssi":-50},...]
   */
  String scanNetworks();

  /**
   * Start Access Point (SoftAP) mode
   * @param ssid AP SSID
   * @param password AP Password (min 8 chars, or NULL for open)
   * @return true if AP started
   */
  bool startAP(const char *ssid, const char *password = nullptr);

  /**
   * Stop Access Point mode
   */
  void stopAP();

  /**
   * Check if AP mode is active
   */
  bool isAPActive() const;

  /**
   * Check if WiFi is connected
   */
  bool isConnected() const;

  /**
   * Get the current IP address
   */
  String getIPAddress() const;

  /**
   * Check if credentials are saved
   */
  bool hasSavedCredentials() const;

  /**
   * Save current credentials to NVS
   */
  void saveCredentials();

  /**
   * Clear saved credentials
   */
  void clearCredentials();

  /**
   * Get RSSI (signal strength)
   */
  int getRSSI() const;

  /**
   * Disconnect from WiFi
   */
  void disconnect();

private:
  Preferences preferences;
  String ssid;
  String password;
  bool credentialsLoaded;
  bool apModeActive;
  unsigned long lastConnectAttempt;

  /**
   * Load credentials from NVS
   */
  void loadCredentials();
};

#endif // WIFI_MANAGER_H
