/*******************************************************************************
 * WebSocketManager.h - WebSocket Server for Real-time Data Streaming
 *
 * Uses WebSockets library by Markus Sattler for better compatibility.
 ******************************************************************************/

#ifndef WEBSOCKET_MANAGER_H
#define WEBSOCKET_MANAGER_H

#include "Config.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebSocketsServer.h>


// Callback type for message processing
typedef std::function<void(const String &)> WSMessageCallback;

class WebSocketManager {
public:
  WebSocketManager();

  /**
   * Initialize WebSocket server on specified port
   * @param port WebSocket port (default 81)
   */
  void init(uint16_t port = WEBSOCKET_PORT);

  /**
   * Process WebSocket events (call in loop)
   */
  void loop();

  /**
   * Broadcast message to all connected clients
   * @param message Message string to send
   */
  void broadcast(const String &message);

  /**
   * Broadcast JSON document to all clients
   * @param doc ArduinoJson document
   */
  void broadcastJson(const JsonDocument &doc);

  /**
   * Check if any clients are connected
   */
  bool hasClients() const;

  /**
   * Get number of connected clients
   */
  uint8_t getClientCount() const;

  /**
   * Set callback for incoming messages
   * @param callback Function to handle message strings
   */
  void setMessageCallback(WSMessageCallback callback);

private:
  WebSocketsServer *webSocket;
  WSMessageCallback messageCallback;
  bool initialized;
  uint8_t clientCount;

  /**
   * Static event handler (bridges to instance method)
   */
  static void webSocketEventStatic(uint8_t num, WStype_t type, uint8_t *payload,
                                   size_t length);
  static WebSocketManager *instance;

  void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload,
                      size_t length);
};

#endif // WEBSOCKET_MANAGER_H
