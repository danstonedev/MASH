/*******************************************************************************
 * WebSocketManager.cpp - WebSocket Server Implementation
 *
 * Uses WebSockets library by Markus Sattler for better compatibility.
 ******************************************************************************/

// IMPORTANT: Define DEVICE_ROLE before including Config.h
#define DEVICE_ROLE DEVICE_ROLE_GATEWAY

#include "WebSocketManager.h"

// Static instance pointer for callback bridging
WebSocketManager *WebSocketManager::instance = nullptr;

WebSocketManager::WebSocketManager()
    : webSocket(nullptr), messageCallback(nullptr), initialized(false),
      clientCount(0)
{
  instance = this;
}

void WebSocketManager::init(uint16_t port)
{
  if (initialized)
  {
    SAFE_PRINTLN("[WS] Already initialized");
    return;
  }

  SAFE_LOG("[WS] Initializing WebSocket server on port %d\n", port);

  webSocket = new WebSocketsServer(port);
  webSocket->begin();
  webSocket->onEvent(webSocketEventStatic);

  initialized = true;
  SAFE_PRINTLN("[WS] WebSocket server started");
}

void WebSocketManager::loop()
{
  if (!initialized || !webSocket)
    return;
  webSocket->loop();
}

void WebSocketManager::webSocketEventStatic(uint8_t num, WStype_t type,
                                            uint8_t *payload, size_t length)
{
  if (instance)
  {
    instance->webSocketEvent(num, type, payload, length);
  }
}

void WebSocketManager::webSocketEvent(uint8_t num, WStype_t type,
                                      uint8_t *payload, size_t length)
{
  switch (type)
  {
  case WStype_DISCONNECTED:
    SAFE_LOG("[WS] Client #%u disconnected\n", num);
    if (clientCount > 0)
      clientCount--;
    break;

  case WStype_CONNECTED:
  {
    IPAddress ip = webSocket->remoteIP(num);
    SAFE_LOG("[WS] Client #%u connected from %s\n", num,
             ip.toString().c_str());
    clientCount++;

    // Send welcome message
    webSocket->sendTXT(
        num, "{\"type\":\"connected\",\"message\":\"Welcome to IMU-Connect\"}");
    break;
  }

  case WStype_TEXT:
  {
    String message = String((char *)payload);
    SAFE_LOG("[WS] Message from #%u: %s\n", num, message.c_str());

    if (messageCallback)
    {
      messageCallback(message);
    }
    break;
  }

  case WStype_PING:
    SAFE_LOG("[WS] Ping from #%u\n", num);
    break;

  case WStype_PONG:
    SAFE_LOG("[WS] Pong from #%u\n", num);
    break;

  default:
    break;
  }
}

void WebSocketManager::broadcast(const String &message)
{
  if (!initialized || !webSocket)
    return;
  String msg = message; // Make non-const copy
  webSocket->broadcastTXT(msg);
}

void WebSocketManager::broadcastJson(const JsonDocument &doc)
{
  if (!initialized || !webSocket)
    return;

  String output;
  serializeJson(doc, output);
  webSocket->broadcastTXT(output);
}

bool WebSocketManager::hasClients() const { return clientCount > 0; }

uint8_t WebSocketManager::getClientCount() const { return clientCount; }

void WebSocketManager::setMessageCallback(WSMessageCallback callback)
{
  messageCallback = callback;
}
