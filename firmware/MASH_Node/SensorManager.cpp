/*******************************************************************************
 * SensorManager.cpp - IMU Sensor Management Implementation for Node
 *
 * Uses ICM20649_Research driver (custom research-grade implementation).
 * Includes Madgwick sensor fusion, auto gyro bias calibration, and ZUPT.
 ******************************************************************************/

#include "SensorManager.h"
#include "SyncManager.h"
#include <Arduino.h>
#include <Wire.h>

// Degrees to radians conversion
#define DEG_TO_RAD 0.017453292519943295f

SensorManager::SensorManager()
    : sensorCount(0), useMultiplexer(false),  // Will probe at runtime
      outputMode(OUTPUT_QUATERNION_EXTENDED), // Default to extended mode (0x03)

      zuptGyroThresh(0.1f), // rad/s (~5.7°/s) - increased to ensure trigger
      zuptAccelThresh(
          2.0f), // m/s² deviation from 1g (increased for calib tolerance)
      zuptMinFrames(10), hasMagnetometer(false), hasBarometer(false),
      lastOptionalSensorUpdate(0), magChannel(-1), baroChannel(-1),
      magCalibrationActive(false), magCalibrationStartTime(0),
      magCalibrationDuration(15000),
      fifoModeEnabled(false), batchSampleCount(0) // FIFO batch state
{
  // CRITICAL: Initialize sensorData array to zero to avoid garbage sensorIds
  // The sensorId field was reading uninitialized memory (ASCII chars like
  // 88='X')
  memset(sensorData, 0, sizeof(sensorData));
  memset(batchBuffer, 0, sizeof(batchBuffer)); // Initialize batch buffer

  // Initialize calibration data with proper defaults
  for (uint8_t i = 0; i < MAX_SENSORS; i++)
  {
    calibration[i] = {
        0, 0, 0, // accelOffsetX/Y/Z
        1.0f,    // accelScale (1.0 = no scaling)
        0, 0, 0, // gyroOffsetX/Y/Z
        false,   // isCalibrated
        0        // outlierCount
    };
    sensorChannels[i] = -1;
  }
  // Initialize optional sensor data
  magData = {0, 0, 0, 0};
  baroData = {0, 0, 0};

  // Initialize magnetometer calibration
  magCalibration = {0, 0, 0, 1.0f, 1.0f, 1.0f, false, 0};
  magMinX = magMaxX = 0;
  magMinY = magMaxY = 0;
  magMinZ = magMaxZ = 0;
}

void SensorManager::selectChannel(uint8_t channel)
{
  if (!useMultiplexer || channel >= 8)
    return;

  Wire.beginTransmission(TCA9548A_ADDRESS);
  Wire.write(1 << channel);
  Wire.endTransmission();
}

bool SensorManager::init(uint8_t baseNodeId)
{
  sensorCount = 0;

  Serial.println("[SensorMgr] Scanning for IMU sensors...");

  // Probe for multiplexer with retries
  // Some boards need a moment to stabilize I2C after Wire.begin()
  for (int retry = 0; retry < 3; retry++)
  {
    Wire.beginTransmission(TCA9548A_ADDRESS);
    if (Wire.endTransmission() == 0)
    {
      Serial.println("[SensorMgr] TCA9548A multiplexer detected");
      useMultiplexer = true;
      break;
    }
    Serial.printf("[SensorMgr] Mux probe failed (attempt %d/3)...\n",
                  retry + 1);
    delay(100);
  }

  if (!useMultiplexer)
  {
    Serial.println(
        "[SensorMgr] TCA9548A not found after retries, checking direct I2C...");
  }

  if (useMultiplexer)
  {
    for (uint8_t ch = 0; ch < 8 && sensorCount < MAX_SENSORS; ch++)
    {
      selectChannel(ch);
      delay(10);

      if (sensors[sensorCount].begin(&Wire, ICM20649_DEFAULT_ADDRESS))
      {
        Serial.printf("[SensorMgr] Found ICM20649 on channel %d\n", ch);

        // OVERSAMPLING CONFIG: 375Hz ODR with 119Hz DLPF for anti-aliasing
        // Software decimation 2:1 yields clean 200Hz output
        sensors[sensorCount].configurePhysics(
            RANGE_16G, RANGE_2000DPS,
            DLPF_119HZ);                                   // 119Hz DLPF cutoff (anti-aliasing for 200Hz output)
        sensors[sensorCount].setOutputDataRate(ODR_375HZ); // ~375Hz ODR
        // FIFO disabled - using direct register reads

        sensorData[sensorCount].sensorId = ch + SENSOR_ID_OFFSET;
        sensorChannels[sensorCount] = ch;
        sensorCount++;
      }
    }
  }
  else
  {
    // ===== Wire bus (Stemma QT): probe 0x68 then 0x69 =====
    if (sensors[0].begin(&Wire, ICM20649_DEFAULT_ADDRESS))
    {
      Serial.println("[SensorMgr] Found ICM20649 on Wire @ 0x68 (Stemma QT)");

      sensors[0].configurePhysics(RANGE_8G, RANGE_2000DPS, DLPF_51HZ);
      sensors[0].setOutputDataRate(ODR_375HZ);

      sensorData[0].sensorId = 0 + SENSOR_ID_OFFSET;
      sensorChannels[0] = -1;
      sensorCount = 1;
    }

    if (sensors[sensorCount].begin(&Wire, 0x69))
    {
      Serial.println("[SensorMgr] Found ICM20649 on Wire @ 0x69 (Stemma QT, ADO high)");

      sensors[sensorCount].configurePhysics(RANGE_8G, RANGE_2000DPS, DLPF_51HZ);
      sensors[sensorCount].setOutputDataRate(ODR_375HZ);

      sensorData[sensorCount].sensorId = sensorCount + SENSOR_ID_OFFSET;
      sensorChannels[sensorCount] = -1;
      sensorCount++;
    }

    // ===== Wire1 bus (castellated SDA/SCL pads): probe 0x68 then 0x69 =====
    if (sensorCount < MAX_SENSORS && sensors[sensorCount].begin(&Wire1, ICM20649_DEFAULT_ADDRESS))
    {
      Serial.println("[SensorMgr] Found ICM20649 on Wire1 @ 0x68 (SDA/SCL pads)");

      sensors[sensorCount].configurePhysics(RANGE_8G, RANGE_2000DPS, DLPF_51HZ);
      sensors[sensorCount].setOutputDataRate(ODR_375HZ);

      sensorData[sensorCount].sensorId = sensorCount + SENSOR_ID_OFFSET;
      sensorChannels[sensorCount] = -1;
      sensorCount++;
    }

    if (sensorCount < MAX_SENSORS && sensors[sensorCount].begin(&Wire1, 0x69))
    {
      Serial.println("[SensorMgr] Found ICM20649 on Wire1 @ 0x69 (SDA/SCL pads, ADO high)");

      sensors[sensorCount].configurePhysics(RANGE_8G, RANGE_2000DPS, DLPF_51HZ);
      sensors[sensorCount].setOutputDataRate(ODR_375HZ);

      sensorData[sensorCount].sensorId = sensorCount + SENSOR_ID_OFFSET;
      sensorChannels[sensorCount] = -1;
      sensorCount++;
    }
  }

  Serial.printf("[SensorMgr] Total sensors found: %d\n", sensorCount);
  Serial.printf("[SensorMgr] Output mode: %s\n",
                outputMode == OUTPUT_QUATERNION ? "QUATERNION" : "RAW");

  // ========== Auto-detect optional sensors ==========
  Serial.println("[SensorMgr] Scanning for optional sensors...");

  if (useMultiplexer)
  {
    for (uint8_t ch = 0; ch < 8; ch++)
    {
      selectChannel(ch);
      delay(10);

      if (!hasMagnetometer && mag.begin(MMC5603_ADDRESS, &Wire))
      {
        hasMagnetometer = true;
        magChannel = ch;
        mag.setDataRate(100);
        Serial.printf(
            "[SensorMgr] MMC5603 magnetometer detected on channel %d\n", ch);
      }

      if (!hasBarometer && baro.begin_I2C(BMP390_ADDRESS, &Wire))
      {
        hasBarometer = true;
        baroChannel = ch;
        baro.setTemperatureOversampling(BMP3_OVERSAMPLING_2X);
        baro.setPressureOversampling(BMP3_OVERSAMPLING_16X);
        baro.setIIRFilterCoeff(BMP3_IIR_FILTER_COEFF_3);
        baro.setOutputDataRate(BMP3_ODR_50_HZ);
        Serial.printf("[SensorMgr] BMP390 barometer detected on channel %d\n",
                      ch);
      }
    }

    // Disable all mux channels
    Wire.beginTransmission(TCA9548A_ADDRESS);
    Wire.write(0x00);
    Wire.endTransmission();
    delay(10);
  }

  // Try direct I2C for optional sensors
  if (!hasMagnetometer && mag.begin(MMC5603_ADDRESS, &Wire))
  {
    hasMagnetometer = true;
    magChannel = -1;
    mag.setDataRate(100);
    Serial.println("[SensorMgr] MMC5603 magnetometer detected on direct I2C");
  }

  if (!hasBarometer && baro.begin_I2C(BMP390_ADDRESS, &Wire))
  {
    hasBarometer = true;
    baroChannel = -1;
    baro.setTemperatureOversampling(BMP3_OVERSAMPLING_2X);
    baro.setPressureOversampling(BMP3_OVERSAMPLING_16X);
    baro.setIIRFilterCoeff(BMP3_IIR_FILTER_COEFF_3);
    baro.setOutputDataRate(BMP3_ODR_50_HZ);
    Serial.println("[SensorMgr] BMP390 barometer detected on direct I2C");
  }

  if (!hasMagnetometer)
  {
    Serial.println("[SensorMgr] No magnetometer detected (optional)");
  }
  if (!hasBarometer)
  {
    Serial.println("[SensorMgr] No barometer detected (optional)");
  }

  // ========== Calibration Persistence ==========
  loadCalibration(); // Try to load saved calibration from NVS

  // ========== Auto Gyro Bias Calibration ==========
  // Quick calibration on startup to remove gyro offset drift
  // Uses 50 samples (~500ms) - device should be stationary during boot
  if (sensorCount > 0)
  {
    Serial.println("[SensorMgr] Checking calibration status...");

    // Industry standard: 500ms-1s for static calibration
    // 50 samples × 10ms delay = 500ms total
    const int numSamples = 50;

    for (uint8_t s = 0; s < sensorCount; s++)
    {
      if (calibration[s].isCalibrated)
      {
        Serial.printf(
            "[SensorMgr] Sensor %d already calibrated from NVS, skipping\n", s);
        continue;
      }

      if (useMultiplexer && sensorChannels[s] >= 0)
      {
        selectChannel(sensorChannels[s]);
      }

      float gyroSumX = 0, gyroSumY = 0, gyroSumZ = 0;
      float accelSumX = 0, accelSumY = 0, accelSumZ = 0;

      for (int i = 0; i < numSamples; i++)
      {
        IMUFrame frame;
        if (sensors[s].readFrame(&frame))
        {
          // Transform 2: [-X, +Y, -Z] - must match updateOptimized()
          // See: firmware/BigPicture/ORIENTATION_PIPELINE.md
          gyroSumX += -frame.gx_rad;
          gyroSumY += +frame.gy_rad;
          gyroSumZ += -frame.gz_rad;

          accelSumX += (-frame.ax_g) * 9.81f;
          accelSumY += (+frame.ay_g) * 9.81f;
          accelSumZ += (-frame.az_g) * 9.81f;
        }
        delay(10);
      }

      calibration[s].gyroOffsetX = gyroSumX / numSamples;
      calibration[s].gyroOffsetY = gyroSumY / numSamples;
      calibration[s].gyroOffsetZ = gyroSumZ / numSamples;

      // Calculate Step 1: Average raw acceleration
      float accelAvgX = accelSumX / numSamples;
      float accelAvgY = accelSumY / numSamples;
      float accelAvgZ = accelSumZ / numSamples;

      // Determine dominant axis for gravity alignment
      float absX = fabs(accelAvgX);
      float absY = fabs(accelAvgY);
      float absZ = fabs(accelAvgZ);

      float expectedGravX = 0;
      float expectedGravY = 0;
      float expectedGravZ = 0;

      if (absX > absY && absX > absZ)
      {
        expectedGravX = (accelAvgX > 0) ? 9.81f : -9.81f;
      }
      else if (absY > absX && absY > absZ)
      {
        expectedGravY = (accelAvgY > 0) ? 9.81f : -9.81f;
      }
      else
      {
        expectedGravZ = (accelAvgZ > 0) ? 9.81f : -9.81f;
      }

      calibration[s].accelOffsetX = accelAvgX - expectedGravX;
      calibration[s].accelOffsetY = accelAvgY - expectedGravY;
      calibration[s].accelOffsetZ = accelAvgZ - expectedGravZ;

      calibration[s].isCalibrated = true;

      float startX = accelAvgX - calibration[s].accelOffsetX;
      float startY = accelAvgY - calibration[s].accelOffsetY;
      float startZ = accelAvgZ - calibration[s].accelOffsetZ;

      Serial.printf(
          "[SensorMgr] Sensor %d gyro bias: X=%.4f, Y=%.4f, Z=%.4f rad/s\n", s,
          calibration[s].gyroOffsetX, calibration[s].gyroOffsetY,
          calibration[s].gyroOffsetZ);
      Serial.printf(
          "[SensorMgr] Sensor %d accel bias (m/s^2): X=%.4f, Y=%.4f, Z=%.4f\n",
          s, calibration[s].accelOffsetX, calibration[s].accelOffsetY,
          calibration[s].accelOffsetZ);
      Serial.printf("[SensorMgr] Gravity detected on axis: %s (%.2f)\n",
                    (absX > absY && absX > absZ)   ? "X"
                    : (absY > absX && absY > absZ) ? "Y"
                                                   : "Z",
                    (absX > absY && absX > absZ)   ? startX
                    : (absY > absX && absY > absZ) ? startY
                                                   : startZ);

      // SOFTWARE-ONLY STRATEGY:
      // We purposefully DO NOT write to hardware offset registers here.
      // 1. Hardware writes lock the I2C bus for ms, causing jitter.
      // 2. Dynamic ZUPT updates would be too costly in hardware.
      // Therefore, we only update the 'calibration[]' struct and apply it
      // via software subtraction in update().
    }

    Serial.println("[SensorMgr] Auto-calibration complete!");
  }

  return sensorCount > 0;
}

// NOTE: update() was removed — dead code, superseded by updateOptimized().
// See ORIENTATION_PIPELINE.md for the active data path.

// ============================================================================
// OPTIMIZED UPDATE: Two-Phase I2C Read for Multi-Sensor Nodes
// ============================================================================
// This function optimizes I2C throughput for nodes with multiple sensors
// on a TCA9548A multiplexer by separating I2C reads from data processing:
//
// Phase 1 (I2C): Read all sensors' raw data with minimal mux switching
// Phase 2 (CPU): Process all data (transforms, filtering, quaternions)
//
// Benefits:
// - Reduces I2C bus contention by batching reads
// - Keeps mux switch overhead minimal (1 switch per sensor vs interleaved)
// - Processing happens after I2C is complete (no blocking)
//
// For a 6-sensor node at 200Hz:
// - Old: 6 sensors × (mux + read + process) × 200 = high latency
// - New: 6 × (mux + read) + 6 × (process) = lower latency
// ============================================================================
void SensorManager::updateOptimized(float dt)
{
  // =========================================================================
  // CONSTANTS (same as update())
  // =========================================================================
  const float MAX_ACCEL_G = 30.0f;
  const float MAX_GYRO_RADS = 35.0f;
  const uint8_t MAX_OUTLIER_COUNT = 5;
  const float GYRO_LEARN_RATE = 0.01f;
  const float ACCEL_SCALE_LEARN_RATE = 0.001f;
  const float ACCEL_BIAS_LEARN_RATE = 0.005f;
  const float FLAT_THRESHOLD = 0.5f;
  const int STATIONARY_FRAMES_FOR_LEARNING = 60;

  // Stationary detection for adaptive calibration (same as update())
  static int stationaryCount[MAX_SENSORS] = {0};

  // Diagnostic counters
  static uint32_t totalReads = 0;
  static uint32_t failedReads = 0;
  static uint32_t lastDiagLog = 0;
  static uint32_t lastI2CTimingLog = 0;
  static uint32_t lastHealthCheck = 0;

  // =========================================================================
  // PERIODIC HEALTH CHECK (every 2 seconds)
  // =========================================================================
  // This replaces the per-read keep-alive check with a periodic batch check.
  // Much more efficient for multi-sensor nodes!
  // =========================================================================
  if (millis() - lastHealthCheck > 2000)
  {
    lastHealthCheck = millis();
    for (uint8_t i = 0; i < sensorCount; i++)
    {
      if (useMultiplexer && sensorChannels[i] >= 0)
      {
        selectChannel(sensorChannels[i]);
      }
      sensors[i].checkSensorHealth();
    }
  }

  // =========================================================================
  // PHASE 1: I2C READS (time-critical, minimize latency)
  // =========================================================================
  // Read all sensors' raw data into temporary buffer using FAST reads
  // (no keep-alive overhead - we handle that separately above)
  // =========================================================================
  IMUFrame rawFrames[MAX_SENSORS];
  bool frameValid[MAX_SENSORS] = {false};

  uint32_t i2cStartTime = micros();

  for (uint8_t i = 0; i < sensorCount; i++)
  {
    if (useMultiplexer && sensorChannels[i] >= 0)
    {
      selectChannel(sensorChannels[i]);
    }

    totalReads++;
    // Use FAST read (no keep-alive check) for maximum throughput
    if (sensors[i].readFrameFast(&rawFrames[i]))
    {
      frameValid[i] = true;
    }
    else
    {
      failedReads++;
      frameValid[i] = false;
    }
  }

  uint32_t i2cEndTime = micros();
  uint32_t i2cDurationUs = i2cEndTime - i2cStartTime;

  // Log I2C timing periodically (every 10 seconds)
  if (millis() - lastI2CTimingLog > 10000)
  {
    lastI2CTimingLog = millis();
    Serial.printf("[I2C OPT] %d sensors read in %lu us (%.1f us/sensor)\n",
                  sensorCount, i2cDurationUs, (float)i2cDurationUs / sensorCount);
  }

  // =========================================================================
  // PHASE 2: DATA PROCESSING (CPU-bound, no I2C blocking)
  // =========================================================================
  for (uint8_t i = 0; i < sensorCount; i++)
  {
    if (!frameValid[i])
    {
      continue; // Skip invalid frames
    }

    IMUFrame *frame = &rawFrames[i];

    // Raw values
    float ax_raw_g = frame->ax_g;
    float ay_raw_g = frame->ay_g;
    float az_raw_g = frame->az_g;
    float gx_raw = frame->gx_rad;
    float gy_raw = frame->gy_rad;
    float gz_raw = frame->gz_rad;

    // Outlier rejection
    bool isOutlier = false;
    if (fabs(ax_raw_g) > MAX_ACCEL_G || fabs(ay_raw_g) > MAX_ACCEL_G ||
        fabs(az_raw_g) > MAX_ACCEL_G ||
        fabs(gx_raw) > MAX_GYRO_RADS || fabs(gy_raw) > MAX_GYRO_RADS ||
        fabs(gz_raw) > MAX_GYRO_RADS ||
        isnan(ax_raw_g) || isnan(ay_raw_g) || isnan(az_raw_g) ||
        isnan(gx_raw) || isnan(gy_raw) || isnan(gz_raw))
    {
      isOutlier = true;
      calibration[i].outlierCount++;
      if (calibration[i].outlierCount > MAX_OUTLIER_COUNT)
      {
        Serial.printf("[OUTLIER S%d] %d consecutive outliers\n", i, calibration[i].outlierCount);
      }
      continue;
    }
    else
    {
      calibration[i].outlierCount = 0;
    }

    // Hardware mounting transform: [-X, +Y, -Z] (true 180° yaw rotation)
    // See: firmware/BigPicture/ORIENTATION_PIPELINE.md
    float ax_yup = -ax_raw_g * 9.81f;
    float ay_yup = +ay_raw_g * 9.81f;
    float az_yup = -az_raw_g * 9.81f;
    float gx_yup = -gx_raw;
    float gy_yup = +gy_raw;
    float gz_yup = -gz_raw;

    // Apply calibration
    float ax_cal = (ax_yup - calibration[i].accelOffsetX) * calibration[i].accelScale;
    float ay_cal = (ay_yup - calibration[i].accelOffsetY) * calibration[i].accelScale;
    float az_cal = (az_yup - calibration[i].accelOffsetZ) * calibration[i].accelScale;
    float gx_cal = gx_yup - calibration[i].gyroOffsetX;
    float gy_cal = gy_yup - calibration[i].gyroOffsetY;
    float gz_cal = gz_yup - calibration[i].gyroOffsetZ;

    // Store processed data
    sensorData[i].accelX = ax_cal;
    sensorData[i].accelY = ay_cal;
    sensorData[i].accelZ = az_cal;
    sensorData[i].gyroX = gx_cal;
    sensorData[i].gyroY = gy_cal;
    sensorData[i].gyroZ = gz_cal;
    sensorData[i].timestamp = micros();
    sensorData[i].sensorId = i;

    // Adaptive calibration (same logic as update())
    float gyroMag = sqrt(gx_cal * gx_cal + gy_cal * gy_cal + gz_cal * gz_cal);
    float accelMag = sqrt(ax_cal * ax_cal + ay_cal * ay_cal + az_cal * az_cal);
    float accelDiff = fabs(accelMag - 9.81f);
    bool isStationary = (gyroMag < zuptGyroThresh) && (accelDiff < zuptAccelThresh);

    if (isStationary)
    {
      stationaryCount[i]++;
      if (stationaryCount[i] > STATIONARY_FRAMES_FOR_LEARNING)
      {
        // Gyro bias learning
        if (calibration[i].isCalibrated)
        {
          calibration[i].gyroOffsetX = (1.0f - GYRO_LEARN_RATE) * calibration[i].gyroOffsetX + GYRO_LEARN_RATE * gx_yup;
          calibration[i].gyroOffsetY = (1.0f - GYRO_LEARN_RATE) * calibration[i].gyroOffsetY + GYRO_LEARN_RATE * gy_yup;
          calibration[i].gyroOffsetZ = (1.0f - GYRO_LEARN_RATE) * calibration[i].gyroOffsetZ + GYRO_LEARN_RATE * gz_yup;
        }
        else
        {
          calibration[i].gyroOffsetX = gx_yup;
          calibration[i].gyroOffsetY = gy_yup;
          calibration[i].gyroOffsetZ = gz_yup;
          calibration[i].accelScale = 1.0f;
          calibration[i].isCalibrated = true;
        }

        // Accel scale learning
        float ax_b = ax_yup - calibration[i].accelOffsetX;
        float ay_b = ay_yup - calibration[i].accelOffsetY;
        float az_b = az_yup - calibration[i].accelOffsetZ;
        float rawMag = sqrt(ax_b * ax_b + ay_b * ay_b + az_b * az_b);
        if (rawMag > 0.1f && calibration[i].isCalibrated)
        {
          float idealScale = 9.81f / rawMag;
          calibration[i].accelScale = (1.0f - ACCEL_SCALE_LEARN_RATE) * calibration[i].accelScale + ACCEL_SCALE_LEARN_RATE * idealScale;
          calibration[i].accelScale = constrain(calibration[i].accelScale, 0.9f, 1.1f);
        }

        // Accel bias learning
        if (fabs(sensorData[i].accelY - 9.81f) < FLAT_THRESHOLD && calibration[i].isCalibrated)
        {
          calibration[i].accelOffsetX = (1.0f - ACCEL_BIAS_LEARN_RATE) * calibration[i].accelOffsetX + ACCEL_BIAS_LEARN_RATE * ax_yup;
          calibration[i].accelOffsetZ = (1.0f - ACCEL_BIAS_LEARN_RATE) * calibration[i].accelOffsetZ + ACCEL_BIAS_LEARN_RATE * az_yup;
        }
      }
    }
    else
    {
      stationaryCount[i] = 0;
    }
  }

  // Diagnostic output
  if (millis() - lastDiagLog > 5000)
  {
    lastDiagLog = millis();
    if (totalReads > 0)
    {
      float successRate = 100.0f * (totalReads - failedReads) / totalReads;
      Serial.printf("[DIAG OPT] I2C success: %.1f%% (%lu/%lu)\n", successRate, totalReads - failedReads, totalReads);
    }
  }
}
// End of updateOptimized()

IMUData SensorManager::getData(uint8_t sensorIndex)
{
  if (sensorIndex < sensorCount)
  {
    return sensorData[sensorIndex];
  }
  return IMUData{0, 0, 0, 0, 0, 0, 0, 0};
}

Quaternion SensorManager::getQuaternion(uint8_t sensorIndex)
{
  static const Quaternion kIdentityQuat(1.0f, 0.0f, 0.0f, 0.0f);
  if (sensorIndex < sensorCount)
  {
    return kIdentityQuat; // Always identity (fusion moved to TDMA layer)
  }
  return kIdentityQuat;
}

uint8_t SensorManager::getSensorCount() const { return sensorCount; }

void SensorManager::setOutputMode(OutputMode mode)
{
  outputMode = mode;
  const char *modeStr = "UNKNOWN";
  if (mode == OUTPUT_RAW)
    modeStr = "RAW";
  else if (mode == OUTPUT_QUATERNION)
    modeStr = "QUATERNION";
  else if (mode == OUTPUT_QUATERNION_EXTENDED)
    modeStr = "QUATERNION_EXTENDED";
  Serial.printf("[SensorMgr] Output mode changed to: %s\n", modeStr);
}

OutputMode SensorManager::getOutputMode() const { return outputMode; }

void SensorManager::setAccelRange(uint8_t rangeG)
{
  AccelRange range;
  switch (rangeG)
  {
  case 4:
    range = RANGE_4G;
    break;
  case 8:
    range = RANGE_8G;
    break;
  case 16:
    range = RANGE_16G;
    break;
  case 30:
    range = RANGE_30G;
    break;
  default:
    range = RANGE_16G;
    break;
  }

  for (uint8_t i = 0; i < sensorCount; i++)
  {
    if (useMultiplexer && sensorChannels[i] >= 0)
    {
      selectChannel(sensorChannels[i]);
    }
    sensors[i].setAccelRange(range);
  }

  Serial.printf("[SensorMgr] Accelerometer range set to ±%dg\n", rangeG);
}

void SensorManager::setGyroRange(uint16_t rangeDPS)
{
  GyroRange range;
  switch (rangeDPS)
  {
  case 500:
    range = RANGE_500DPS;
    break;
  case 1000:
    range = RANGE_1000DPS;
    break;
  case 2000:
    range = RANGE_2000DPS;
    break;
  case 4000:
    range = RANGE_4000DPS;
    break;
  default:
    range = RANGE_2000DPS;
    break;
  }

  for (uint8_t i = 0; i < sensorCount; i++)
  {
    if (useMultiplexer && sensorChannels[i] >= 0)
    {
      selectChannel(sensorChannels[i]);
    }
    sensors[i].setGyroRange(range);
  }

  Serial.printf("[SensorMgr] Gyroscope range set to ±%d dps\n", rangeDPS);
}

void SensorManager::setActivityProfile(ActivityProfile profile)
{
  switch (profile)
  {
  case PROFILE_REHAB:
    setAccelRange(8);
    setGyroRange(1000);
    Serial.println("[SensorMgr] Applied REHAB profile (8G, 1000dps)");
    break;
  case PROFILE_SPORT:
    setAccelRange(16);
    setGyroRange(2000);
    Serial.println("[SensorMgr] Applied SPORT profile (16G, 2000dps)");
    break;
  case PROFILE_IMPACT:
    setAccelRange(30);
    setGyroRange(4000);
    Serial.println("[SensorMgr] Applied IMPACT profile (30G, 4000dps)");
    break;
  }
}

// ============================================================================
// FIFO BATCH READING IMPLEMENTATION
// ============================================================================
// This reduces I2C overhead by ~75% by reading multiple samples per transaction.
// Instead of 4 separate read operations (4 × ~200µs = 800µs),
// we do 1 batch read (~300µs) saving ~500µs per frame.
// ============================================================================

void SensorManager::enableFIFOMode()
{
  if (fifoModeEnabled)
    return; // Already enabled

  Serial.println("[SensorMgr] Enabling FIFO batch mode for all sensors...");

  for (uint8_t s = 0; s < sensorCount; s++)
  {
    if (useMultiplexer && sensorChannels[s] >= 0)
    {
      selectChannel(sensorChannels[s]);
      delay(5);
    }

    // Enable FIFO with watermark threshold of 4 samples (48 bytes)
    // This triggers interrupt when we have enough data for one TDMA frame
    sensors[s].enableFIFO(4);
    Serial.printf("[SensorMgr] Sensor %d FIFO enabled (watermark=4)\n", s);
  }

  fifoModeEnabled = true;
  batchSampleCount = 0;

  Serial.println("[SensorMgr] FIFO batch mode ENABLED - ~75% I2C overhead reduction");
}

uint8_t SensorManager::updateBatch(uint8_t maxSamples)
{
  if (!fifoModeEnabled)
  {
    // Fallback: Use single-sample update if FIFO not enabled
    updateOptimized(0.005f); // Assume 200Hz
    batchSampleCount = 1;
    return 1;
  }

  // Limit to buffer capacity
  if (maxSamples > BATCH_BUFFER_SIZE)
    maxSamples = BATCH_BUFFER_SIZE;
  if (maxSamples == 0)
    maxSamples = 4;

  uint8_t samplesRead = 0;

  // Read batch from each sensor
  for (uint8_t s = 0; s < sensorCount; s++)
  {
    if (useMultiplexer && sensorChannels[s] >= 0)
    {
      selectChannel(sensorChannels[s]);
    }

    // Read batch from this sensor's FIFO
    uint8_t count = sensors[s].readFrameBatch(batchBuffer[s], maxSamples);

    // Track minimum samples read (use lowest common count)
    if (s == 0 || count < samplesRead)
    {
      samplesRead = count;
    }
  }

  batchSampleCount = samplesRead;

  // Apply calibration and store in sensorData (for compatibility with getData())
  // Store the LATEST sample for backward compatibility
  if (samplesRead > 0)
  {
    for (uint8_t s = 0; s < sensorCount; s++)
    {
      IMUFrame *frame = &batchBuffer[s][samplesRead - 1]; // Latest sample

      // Transform 2: [-X, +Y, -Z] then apply calibration offsets
      // See: firmware/BigPicture/ORIENTATION_PIPELINE.md
      float ax = -frame->ax_g * 9.81f - calibration[s].accelOffsetX;
      float ay = +frame->ay_g * 9.81f - calibration[s].accelOffsetY;
      float az = -frame->az_g * 9.81f - calibration[s].accelOffsetZ;

      float gx = -frame->gx_rad - calibration[s].gyroOffsetX;
      float gy = +frame->gy_rad - calibration[s].gyroOffsetY;
      float gz = -frame->gz_rad - calibration[s].gyroOffsetZ;

      sensorData[s].accelX = ax;
      sensorData[s].accelY = ay;
      sensorData[s].accelZ = az;
      sensorData[s].gyroX = gx;
      sensorData[s].gyroY = gy;
      sensorData[s].gyroZ = gz;
      sensorData[s].timestamp = frame->timestampMicros;
    }
  }

  // Debug logging periodically
  static uint32_t lastBatchDebug = 0;
  if (millis() - lastBatchDebug > 10000)
  {
    lastBatchDebug = millis();
    Serial.printf("[SensorMgr] FIFO batch: read %d samples from %d sensors\n",
                  samplesRead, sensorCount);
  }

  return samplesRead;
}

IMUData SensorManager::getBatchedData(uint8_t sensorIndex, uint8_t sampleIndex) const
{
  IMUData data = {0};

  if (sensorIndex >= sensorCount || sampleIndex >= batchSampleCount)
  {
    return data;
  }

  const IMUFrame *frame = &batchBuffer[sensorIndex][sampleIndex];
  const CalibrationData *cal = &calibration[sensorIndex];

  // Transform 2: [-X, +Y, -Z] then apply calibration
  // See: firmware/BigPicture/ORIENTATION_PIPELINE.md
  data.accelX = -frame->ax_g * 9.81f - cal->accelOffsetX;
  data.accelY = +frame->ay_g * 9.81f - cal->accelOffsetY;
  data.accelZ = -frame->az_g * 9.81f - cal->accelOffsetZ;

  data.gyroX = -frame->gx_rad - cal->gyroOffsetX;
  data.gyroY = +frame->gy_rad - cal->gyroOffsetY;
  data.gyroZ = -frame->gz_rad - cal->gyroOffsetZ;

  data.timestamp = frame->timestampMicros;
  data.sensorId = sensorData[sensorIndex].sensorId;

  return data;
}
