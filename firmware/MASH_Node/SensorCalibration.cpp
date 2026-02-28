// ============================================================================
// SensorCalibration.cpp — IMU calibration, NVS persistence, and topology
//
// Extracted from SensorManager.cpp for maintainability.
// All functions are SensorManager:: methods; include SensorManager.h only.
// ============================================================================

#include "SensorManager.h"
#include <Preferences.h>

// ============================================================================
// Manual Calibration Routines
// ============================================================================

void SensorManager::calibrateSensor(uint8_t sensorId)
{
    if (sensorId >= sensorCount)
    {
        Serial.printf("[SensorMgr] Invalid sensor ID: %d\n", sensorId);
        return;
    }

    Serial.printf("[SensorMgr] Calibrating sensor %d - keep device still!\n",
                  sensorId);

    // DATASHEET COMPLIANCE NOTICE:
    // This manual calibration routine relies on the "System-Level" compensation
    // method. CRITICAL: The device MUST be placed FLAT (Z-UP) on a stationary
    // surface. The Z-axis offset calculation hardcodes a subtraction of 1G (9.81
    // m/s²). If calibrated in any other orientation, the Z-offset will be
    // incorrect.

    // Research: 200-500ms sufficient for static calibration capture
    // 50 samples × 10ms = 500ms total (previously 100 samples = 1s)
    const int numSamples = 50;
    float accelSumX = 0, accelSumY = 0, accelSumZ = 0;
    float gyroSumX = 0, gyroSumY = 0, gyroSumZ = 0;

    if (useMultiplexer && sensorChannels[sensorId] >= 0)
    {
        selectChannel(sensorChannels[sensorId]);
    }

    for (int i = 0; i < numSamples; i++)
    {
        IMUFrame frame;
        if (sensors[sensorId].readFrame(&frame))
        {
            // Transform 2: [-X, +Y, -Z] - must match updateOptimized()
            // See: firmware/BigPicture/ORIENTATION_PIPELINE.md
            accelSumX += (-frame.ax_g) * 9.81f;
            accelSumY += (+frame.ay_g) * 9.81f;
            accelSumZ += (-frame.az_g) * 9.81f;

            gyroSumX += -frame.gx_rad;
            gyroSumY += +frame.gy_rad;
            gyroSumZ += -frame.gz_rad;
        }
        delay(10);
    }

    // Calculate offsets (Average - Expected)
    // Expectation for FLAT/LEVEL placement in Y-Up Frame:
    // Gravity is on Y-axis (+9.81 m/s²)
    calibration[sensorId].accelOffsetX = accelSumX / numSamples;
    calibration[sensorId].accelOffsetY =
        (accelSumY / numSamples) - 9.81f; // Subtract gravity from Y
    calibration[sensorId].accelOffsetZ = accelSumZ / numSamples;
    calibration[sensorId].gyroOffsetX = gyroSumX / numSamples;
    calibration[sensorId].gyroOffsetY = gyroSumY / numSamples;
    calibration[sensorId].gyroOffsetZ = gyroSumZ / numSamples;
    calibration[sensorId].isCalibrated = true;

    Serial.printf("[SensorMgr] Calibration complete for sensor %d\n", sensorId);
    Serial.printf("  Accel offsets: X=%.3f, Y=%.3f, Z=%.3f\n",
                  calibration[sensorId].accelOffsetX,
                  calibration[sensorId].accelOffsetY,
                  calibration[sensorId].accelOffsetZ);
    Serial.printf("  Gyro offsets: X=%.3f, Y=%.3f, Z=%.3f\n",
                  calibration[sensorId].gyroOffsetX,
                  calibration[sensorId].gyroOffsetY,
                  calibration[sensorId].gyroOffsetZ);

    // Auto-save calibration to NVS
    saveCalibration(sensorId);
}

void SensorManager::calibrateGyro(uint8_t sensorId)
{
    if (sensorId >= sensorCount)
    {
        Serial.printf("[SensorMgr] Invalid sensor ID: %d\n", sensorId);
        return;
    }

    Serial.printf(
        "[SensorMgr] Zeroing Gyros for sensor %d - keep device still!\n",
        sensorId);

    // Quick 500ms capture
    const int numSamples = 50;
    float gyroSumX = 0, gyroSumY = 0, gyroSumZ = 0;

    if (useMultiplexer && sensorChannels[sensorId] >= 0)
    {
        selectChannel(sensorChannels[sensorId]);
    }

    for (int i = 0; i < numSamples; i++)
    {
        IMUFrame frame;
        if (sensors[sensorId].readFrame(&frame))
        {
            // Transform 2: [-X, +Y, -Z] - must match updateOptimized()
            // See: firmware/BigPicture/ORIENTATION_PIPELINE.md
            gyroSumX += -frame.gx_rad;
            gyroSumY += +frame.gy_rad;
            gyroSumZ += -frame.gz_rad;
        }
        delay(10);
    }

    // Update ONLY gyro offsets
    calibration[sensorId].gyroOffsetX = gyroSumX / numSamples;
    calibration[sensorId].gyroOffsetY = gyroSumY / numSamples;
    calibration[sensorId].gyroOffsetZ = gyroSumZ / numSamples;

    // Set calibrated flag (assuming if we zero gyros, we want to use the result)
    calibration[sensorId].isCalibrated = true;

    Serial.printf("[SensorMgr] Gyro Zero complete for sensor %d\n", sensorId);
    Serial.printf("  Gyro offsets: X=%.3f, Y=%.3f, Z=%.3f\n",
                  calibration[sensorId].gyroOffsetX,
                  calibration[sensorId].gyroOffsetY,
                  calibration[sensorId].gyroOffsetZ);

    // Auto-save calibration to NVS
    saveCalibration(sensorId);
}

// ============================================================================
// Calibration Getters
// ============================================================================

CalibrationData SensorManager::getCalibration(uint8_t sensorIndex)
{
    if (sensorIndex < sensorCount)
    {
        return calibration[sensorIndex];
    }
    return CalibrationData{0, 0, 0, 0, 0, 0, false};
}

bool SensorManager::isCalibrated(uint8_t sensorIndex) const
{
    if (sensorIndex < MAX_SENSORS)
    {
        return calibration[sensorIndex].isCalibrated;
    }
    return false;
}

uint8_t SensorManager::getCalibratedCount() const
{
    uint8_t count = 0;
    for (uint8_t i = 0; i < sensorCount; i++)
    {
        if (calibration[i].isCalibrated)
        {
            count++;
        }
    }
    return count;
}

// ============================================================================
// Sensor Topology
// ============================================================================

int8_t SensorManager::getSensorChannel(uint8_t sensorIndex) const
{
    if (sensorIndex < MAX_SENSORS)
    {
        return sensorChannels[sensorIndex];
    }
    return -1;
}

void SensorManager::getSensorTopology(int8_t *channels) const
{
    for (uint8_t i = 0; i < MAX_SENSORS; i++)
    {
        channels[i] = sensorChannels[i];
    }
}

// ============================================================================
// NVS Persistence — IMU Calibration
// ============================================================================

void SensorManager::saveCalibration(uint8_t sensorId)
{
    if (sensorId >= sensorCount)
    {
        Serial.printf(
            "[SensorMgr] Cannot save calibration - invalid sensor ID: %d\n",
            sensorId);
        return;
    }

    Preferences prefs;
    prefs.begin("imu_calib", false);

    char keyPrefix[16];
    snprintf(keyPrefix, sizeof(keyPrefix), "s%d_", sensorId);

    String keyAccelX = String(keyPrefix) + "ax";
    String keyAccelY = String(keyPrefix) + "ay";
    String keyAccelZ = String(keyPrefix) + "az";
    String keyGyroX = String(keyPrefix) + "gx";
    String keyGyroY = String(keyPrefix) + "gy";
    String keyGyroZ = String(keyPrefix) + "gz";
    String keyValid = String(keyPrefix) + "ok";

    prefs.putFloat(keyAccelX.c_str(), calibration[sensorId].accelOffsetX);
    prefs.putFloat(keyAccelY.c_str(), calibration[sensorId].accelOffsetY);
    prefs.putFloat(keyAccelZ.c_str(), calibration[sensorId].accelOffsetZ);
    prefs.putFloat(keyGyroX.c_str(), calibration[sensorId].gyroOffsetX);
    prefs.putFloat(keyGyroY.c_str(), calibration[sensorId].gyroOffsetY);
    prefs.putFloat(keyGyroZ.c_str(), calibration[sensorId].gyroOffsetZ);
    prefs.putBool(keyValid.c_str(), calibration[sensorId].isCalibrated);

    prefs.end();

    Serial.printf("[SensorMgr] Calibration saved to NVS for sensor %d\n",
                  sensorId);
}

uint8_t SensorManager::loadCalibration()
{
    Preferences prefs;
    prefs.begin("imu_calib", true); // Read-only

    uint8_t loadedCount = 0;

    for (uint8_t i = 0; i < MAX_SENSORS; i++)
    {
        char keyPrefix[16];
        snprintf(keyPrefix, sizeof(keyPrefix), "s%d_", i);

        String keyValid = String(keyPrefix) + "ok";

        if (prefs.getBool(keyValid.c_str(), false))
        {
            String keyAccelX = String(keyPrefix) + "ax";
            String keyAccelY = String(keyPrefix) + "ay";
            String keyAccelZ = String(keyPrefix) + "az";
            String keyGyroX = String(keyPrefix) + "gx";
            String keyGyroY = String(keyPrefix) + "gy";
            String keyGyroZ = String(keyPrefix) + "gz";

            calibration[i].accelOffsetX = prefs.getFloat(keyAccelX.c_str(), 0.0f);
            calibration[i].accelOffsetY = prefs.getFloat(keyAccelY.c_str(), 0.0f);
            calibration[i].accelOffsetZ = prefs.getFloat(keyAccelZ.c_str(), 0.0f);
            calibration[i].gyroOffsetX = prefs.getFloat(keyGyroX.c_str(), 0.0f);
            calibration[i].gyroOffsetY = prefs.getFloat(keyGyroY.c_str(), 0.0f);
            calibration[i].gyroOffsetZ = prefs.getFloat(keyGyroZ.c_str(), 0.0f);
            calibration[i].isCalibrated = true;

            // SOFTWARE-ONLY STRATEGY:
            // We DO NOT restore hardware offsets.
            // Offsets are applied in software in update().
            Serial.printf("[SensorMgr] Loaded software calibration for sensor %d "
                          "(Hardware Write Skipped)\n",
                          i);
        }

        loadedCount++;
        Serial.printf("[SensorMgr] Loaded calibration from NVS for sensor %d\n", i);
        Serial.printf("  Accel offsets: X=%.3f, Y=%.3f, Z=%.3f\n",
                      calibration[i].accelOffsetX, calibration[i].accelOffsetY,
                      calibration[i].accelOffsetZ);
        Serial.printf("  Gyro offsets: X=%.3f, Y=%.3f, Z=%.3f\n",
                      calibration[i].gyroOffsetX, calibration[i].gyroOffsetY,
                      calibration[i].gyroOffsetZ);
    }

    prefs.end();

    if (loadedCount > 0)
    {
        Serial.printf("[SensorMgr] Loaded calibration for %d sensor(s) from NVS\n",
                      loadedCount);
    }
    else
    {
        Serial.println("[SensorMgr] No saved calibration found in NVS");
    }

    return loadedCount;
}

void SensorManager::clearCalibration()
{
    Preferences prefs;
    prefs.begin("imu_calib", false);
    prefs.clear();
    prefs.end();

    for (uint8_t i = 0; i < MAX_SENSORS; i++)
    {
        calibration[i] = {
            0, 0, 0, // accelOffsetX/Y/Z
            1.0f,    // accelScale (1.0 = no scaling)
            0, 0, 0, // gyroOffsetX/Y/Z
            false,   // isCalibrated
            0        // outlierCount
        };
    }

    Serial.println("[SensorMgr] All calibration data cleared from NVS");
}
