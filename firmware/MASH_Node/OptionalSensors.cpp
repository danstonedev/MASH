// ============================================================================
// OptionalSensors.cpp — Magnetometer (MMC5603) and Barometer (BMP390) support
//
// Extracted from SensorManager.cpp for maintainability.
// All functions are SensorManager:: methods; include SensorManager.h only.
// ============================================================================

#include "SensorManager.h"
#include <Preferences.h>

// ============================================================================
// Optional Sensor Reading (10 Hz)
// ============================================================================

void SensorManager::updateOptionalSensors()
{
    // Only update at 10Hz to reduce I2C load
    unsigned long now = millis();
    if (now - lastOptionalSensorUpdate < 100)
    {
        return;
    }
    lastOptionalSensorUpdate = now;

    // Read magnetometer if present
    if (hasMagnetometer)
    {
        if (useMultiplexer && magChannel >= 0)
        {
            selectChannel(magChannel);
        }

        sensors_event_t event;
        mag.getEvent(&event);
        magData.x = event.magnetic.x;
        magData.y = event.magnetic.y;
        magData.z = event.magnetic.z;

        float heading = atan2(magData.y, magData.x) * 180.0f / PI;
        if (heading < 0)
            heading += 360.0f;
        magData.heading = heading;
    }

    // Read barometer if present
    if (hasBarometer)
    {
        if (useMultiplexer && baroChannel >= 0)
        {
            selectChannel(baroChannel);
        }

        if (baro.performReading())
        {
            baroData.pressure = baro.pressure / 100.0f; // Pa to hPa
            baroData.temperature = baro.temperature;
            baroData.altitude =
                44330.0f * (1.0f - pow(baroData.pressure / 1013.25f, 0.1903f));
        }
    }
}

// ============================================================================
// Magnetometer Calibration
// ============================================================================

MagData SensorManager::getCalibratedMagData() const
{
    MagData calibrated = magData;

    if (magCalibration.isCalibrated)
    {
        // Apply hard iron correction (subtract bias)
        calibrated.x =
            (magData.x - magCalibration.hardIronX) * magCalibration.softIronScaleX;
        calibrated.y =
            (magData.y - magCalibration.hardIronY) * magCalibration.softIronScaleY;
        calibrated.z =
            (magData.z - magCalibration.hardIronZ) * magCalibration.softIronScaleZ;

        // Recalculate heading with calibrated values
        float heading = atan2(calibrated.y, calibrated.x) * 180.0f / PI;
        if (heading < 0)
            heading += 360.0f;
        calibrated.heading = heading;
    }

    return calibrated;
}

void SensorManager::startMagCalibration(uint32_t durationMs)
{
    if (!hasMagnetometer)
    {
        Serial.println("[SensorMgr] Cannot calibrate - no magnetometer present");
        return;
    }

    Serial.println("[SensorMgr] Starting magnetometer calibration...");
    Serial.println("[SensorMgr] Move sensor slowly in figure-8 pattern");

    magCalibrationActive = true;
    magCalibrationStartTime = millis();
    magCalibrationDuration = durationMs;
    magCalibration.sampleCount = 0;

    // Reset min/max trackers with first reading
    updateOptionalSensors();
    magMinX = magMaxX = magData.x;
    magMinY = magMaxY = magData.y;
    magMinZ = magMaxZ = magData.z;
}

bool SensorManager::updateMagCalibration()
{
    if (!magCalibrationActive)
    {
        return false;
    }

    // Check if calibration time is complete
    uint32_t elapsed = millis() - magCalibrationStartTime;
    if (elapsed >= magCalibrationDuration)
    {
        // Calibration complete - calculate offsets
        Serial.println("[SensorMgr] Magnetometer calibration complete!");

        // Hard iron offsets = center of the ellipsoid
        magCalibration.hardIronX = (magMaxX + magMinX) / 2.0f;
        magCalibration.hardIronY = (magMaxY + magMinY) / 2.0f;
        magCalibration.hardIronZ = (magMaxZ + magMinZ) / 2.0f;

        // Soft iron scale factors = normalize axes to average radius
        float rangeX = (magMaxX - magMinX) / 2.0f;
        float rangeY = (magMaxY - magMinY) / 2.0f;
        float rangeZ = (magMaxZ - magMinZ) / 2.0f;
        float avgRange = (rangeX + rangeY + rangeZ) / 3.0f;

        // Avoid division by zero
        if (rangeX > 0.1f && rangeY > 0.1f && rangeZ > 0.1f)
        {
            magCalibration.softIronScaleX = avgRange / rangeX;
            magCalibration.softIronScaleY = avgRange / rangeY;
            magCalibration.softIronScaleZ = avgRange / rangeZ;
        }
        else
        {
            // Not enough range - use unity scale
            magCalibration.softIronScaleX = 1.0f;
            magCalibration.softIronScaleY = 1.0f;
            magCalibration.softIronScaleZ = 1.0f;
            Serial.println(
                "[SensorMgr] Warning: Insufficient magnetometer range detected");
        }

        magCalibration.isCalibrated = true;
        magCalibrationActive = false;

        Serial.printf("[SensorMgr] Hard iron: X=%.2f, Y=%.2f, Z=%.2f uT\n",
                      magCalibration.hardIronX, magCalibration.hardIronY,
                      magCalibration.hardIronZ);
        Serial.printf("[SensorMgr] Soft iron scale: X=%.3f, Y=%.3f, Z=%.3f\n",
                      magCalibration.softIronScaleX, magCalibration.softIronScaleY,
                      magCalibration.softIronScaleZ);
        Serial.printf("[SensorMgr] Samples collected: %d\n",
                      magCalibration.sampleCount);

        // Auto-save calibration
        saveMagCalibration();

        return false; // Calibration complete
    }

    // Update magnetometer reading
    updateOptionalSensors();

    // Track min/max values
    if (magData.x < magMinX)
        magMinX = magData.x;
    if (magData.x > magMaxX)
        magMaxX = magData.x;
    if (magData.y < magMinY)
        magMinY = magData.y;
    if (magData.y > magMaxY)
        magMaxY = magData.y;
    if (magData.z < magMinZ)
        magMinZ = magData.z;
    if (magData.z > magMaxZ)
        magMaxZ = magData.z;

    magCalibration.sampleCount++;

    // Log progress every 2 seconds
    static uint32_t lastLog = 0;
    if (millis() - lastLog > 2000)
    {
        Serial.printf("[MagCal] Progress: %d%% | Samples: %d | Range X:[%.1f,%.1f] "
                      "Y:[%.1f,%.1f] Z:[%.1f,%.1f]\n",
                      getMagCalibrationProgress(), magCalibration.sampleCount,
                      magMinX, magMaxX, magMinY, magMaxY, magMinZ, magMaxZ);
        lastLog = millis();
    }

    return true; // Still calibrating
}

uint8_t SensorManager::getMagCalibrationProgress() const
{
    if (!magCalibrationActive)
    {
        return magCalibration.isCalibrated ? 100 : 0;
    }

    uint32_t elapsed = millis() - magCalibrationStartTime;
    uint32_t progress = (elapsed * 100) / magCalibrationDuration;
    return progress > 100 ? 100 : progress;
}

// ============================================================================
// NVS Persistence — Magnetometer Calibration
// ============================================================================

void SensorManager::saveMagCalibration()
{
    if (!magCalibration.isCalibrated)
    {
        Serial.println("[SensorMgr] Cannot save - magnetometer not calibrated");
        return;
    }

    Preferences prefs;
    prefs.begin("mag_calib", false);

    prefs.putFloat("hi_x", magCalibration.hardIronX);
    prefs.putFloat("hi_y", magCalibration.hardIronY);
    prefs.putFloat("hi_z", magCalibration.hardIronZ);
    prefs.putFloat("si_x", magCalibration.softIronScaleX);
    prefs.putFloat("si_y", magCalibration.softIronScaleY);
    prefs.putFloat("si_z", magCalibration.softIronScaleZ);
    prefs.putBool("valid", true);
    prefs.putUShort("samples", magCalibration.sampleCount);

    prefs.end();

    Serial.println("[SensorMgr] Magnetometer calibration saved to NVS");
}

bool SensorManager::loadMagCalibration()
{
    Preferences prefs;
    prefs.begin("mag_calib", true); // Read-only

    if (prefs.getBool("valid", false))
    {
        magCalibration.hardIronX = prefs.getFloat("hi_x", 0.0f);
        magCalibration.hardIronY = prefs.getFloat("hi_y", 0.0f);
        magCalibration.hardIronZ = prefs.getFloat("hi_z", 0.0f);
        magCalibration.softIronScaleX = prefs.getFloat("si_x", 1.0f);
        magCalibration.softIronScaleY = prefs.getFloat("si_y", 1.0f);
        magCalibration.softIronScaleZ = prefs.getFloat("si_z", 1.0f);
        magCalibration.sampleCount = prefs.getUShort("samples", 0);
        magCalibration.isCalibrated = true;

        prefs.end();

        Serial.println("[SensorMgr] Magnetometer calibration loaded from NVS");
        Serial.printf("[SensorMgr] Hard iron: X=%.2f, Y=%.2f, Z=%.2f uT\n",
                      magCalibration.hardIronX, magCalibration.hardIronY,
                      magCalibration.hardIronZ);
        return true;
    }

    prefs.end();
    Serial.println("[SensorMgr] No magnetometer calibration found in NVS");
    return false;
}

void SensorManager::clearMagCalibration()
{
    Preferences prefs;
    prefs.begin("mag_calib", false);
    prefs.clear();
    prefs.end();

    magCalibration = {0, 0, 0, 1.0f, 1.0f, 1.0f, false, 0};

    Serial.println("[SensorMgr] Magnetometer calibration cleared");
}
