/**
 * ESP-NOW v2.0 Verification Sketch
 * =================================
 *
 * Flash this to any ESP32 to verify ESP-NOW v2.0 is available.
 * Check Serial Monitor at 115200 baud.
 */

#include <Arduino.h>
#include <esp_now.h>
#include <esp_idf_version.h>

void setup()
{
    Serial.begin(115200);
    delay(2000);

    Serial.println("\n\n");
    Serial.println("╔═══════════════════════════════════════════════════════════════╗");
    Serial.println("║         ESP-NOW v2.0 VERIFICATION                             ║");
    Serial.println("╚═══════════════════════════════════════════════════════════════╝");

    // Print ESP-IDF version
    Serial.printf("\n  ESP-IDF Version: %d.%d.%d\n",
                  ESP_IDF_VERSION_MAJOR,
                  ESP_IDF_VERSION_MINOR,
                  ESP_IDF_VERSION_PATCH);

    // Print Arduino-ESP32 version
    Serial.printf("  Arduino-ESP32:   %s\n", ESP_ARDUINO_VERSION_STR);

    // Check for ESP-NOW v2.0 constant
    Serial.println("\n  ESP-NOW Payload Limits:");
    Serial.println("  ───────────────────────────────────────────────────────────");

#ifdef ESP_NOW_MAX_DATA_LEN
    Serial.printf("  ESP_NOW_MAX_DATA_LEN (v1.0):    %d bytes\n", ESP_NOW_MAX_DATA_LEN);
#else
    Serial.println("  ESP_NOW_MAX_DATA_LEN (v1.0):    NOT DEFINED");
#endif

#ifdef ESP_NOW_MAX_DATA_LEN_V2
    Serial.printf("  ESP_NOW_MAX_DATA_LEN_V2 (v2.0): %d bytes  ✓ AVAILABLE!\n", ESP_NOW_MAX_DATA_LEN_V2);
    Serial.println("\n  ═══════════════════════════════════════════════════════════════");
    Serial.println("  🎉 ESP-NOW v2.0 IS AVAILABLE!");
    Serial.println("     You can use payloads up to 1470 bytes.");
    Serial.println("  ═══════════════════════════════════════════════════════════════");
#else
    Serial.println("  ESP_NOW_MAX_DATA_LEN_V2 (v2.0): NOT DEFINED");
    Serial.println("\n  ═══════════════════════════════════════════════════════════════");
    Serial.println("  ⚠ ESP-NOW v2.0 NOT AVAILABLE");
    Serial.println("    Upgrade Arduino-ESP32 to v3.x for v2.0 support.");
    Serial.println("  ═══════════════════════════════════════════════════════════════");
#endif

    Serial.println("\n--- Verification complete ---");
}

void loop()
{
    delay(10000);
}
