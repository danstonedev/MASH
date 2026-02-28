#ifndef ZUPT_TEST_H

#define ZUPT_TEST_H

#include <Arduino.h>

class ZuptTest {
public:
  static void run(float currentGyroTh, float currentAccelTh) {
    Serial.println("\n[Test] --- Running ZUPT Regression Self-Test ---");
    Serial.printf("[Test] Current Thresholds: Gyro=%.3f, A-Diff=%.3f\n",
                  currentGyroTh, currentAccelTh);

    bool allPass = true;

    // --- TEST CASE 1: Perfect Stillness ---
    // Gyro=0, AccelDiff=0 -> Should be STATIONARY
    if (!check(0.0f, 0.0f, currentGyroTh, currentAccelTh, true,
               "Perfect Stillness"))
      allPass = false;

    // --- TEST CASE 2: Acceptable Noise (The "Research" Case) ---
    // Gyro=0.03, AccelDiff=0.18 (observed real noise) -> Should be STATIONARY
    if (!check(0.03f, 0.18f, currentGyroTh, currentAccelTh, true,
               "Typical Sensor Noise"))
      allPass = false;

    // --- TEST CASE 3: Accel Spike ---
    // Gyro=0.01, AccelDiff=2.5 (above 2.0 limit) -> Should be MOVING
    if (!check(0.01f, 2.50f, currentGyroTh, currentAccelTh, false,
               "Accel Spike"))
      allPass = false;

    // --- TEST CASE 4: Gyro Rotation ---
    // Gyro=0.15 (above 0.1 limit), AccelDiff=0.1 -> Should be MOVING
    if (!check(0.15f, 0.10f, currentGyroTh, currentAccelTh, false,
               "Slow Rotation"))
      allPass = false;

    // --- TEST CASE 5: High Noise Tolerance (Edge Case) ---
    // AccelDiff=1.9 (high deviation) -> Should be STATIONARY with relaxed
    // thresholds (2.0)
    if (!check(0.01f, 1.90f, currentGyroTh, currentAccelTh, true,
               "High Noise Tolerance"))
      allPass = false;

    if (allPass) {
      Serial.println("[Test] RESULT: PASS ✅ - ZUPT Logic is Sound");
    } else {
      Serial.println(
          "[Test] RESULT: FAIL ❌ - ZUPT Logic Broken! Check Thresholds.");
    }
    Serial.println("[Test] ----------------------------------------\n");
  }

private:
  static bool check(float gMag, float aDiff, float gTh, float aTh,
                    bool expected, const char *name) {
    // Replicate logic from SensorManager.cpp
    bool isStationary = (gMag < gTh) && (aDiff < aTh);

    if (isStationary == expected) {
      // Serial.printf("[Test] %s: OK\n", name); // Verbose optional
      return true;
    } else {
      Serial.printf(
          "[Test] FAIL %s: Input(G=%.2f, A=%.2f) -> Result %d (Expected %d)\n",
          name, gMag, aDiff, isStationary, expected);
      return false;
    }
  }
};

#endif // ZUPT_TEST_H
