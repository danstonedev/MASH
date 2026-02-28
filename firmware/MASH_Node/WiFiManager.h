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

  /**
   * Stop connection attempts (disconnects Station but keeps Radio ON for
   * ESP-NOW)
   */
  void stopConnection();

private:
  Preferences preferences;
  String ssid;
  String password;
  bool credentialsLoaded;
  unsigned long lastConnectAttempt;

  /**
   * Load credentials from NVS
   */
  void loadCredentials();
};

#endif // WIFI_MANAGER_H
