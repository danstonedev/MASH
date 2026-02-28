#ifndef SENSOR_MANAGER_H
#define SENSOR_MANAGER_H

#include "Config.h"

#include "ICM20649_Research.h"
#include <Arduino.h>
#include <Wire.h>

// Optional sensor libraries (graceful if not installed - will just not detect)
#include <Adafruit_BMP3XX.h>
#include <Adafruit_MMC56x3.h>

// Output mode for data streaming
enum OutputMode
{
  OUTPUT_RAW,                // Raw accel + gyro (original format)
  OUTPUT_QUATERNION,         // Fused quaternion data
  OUTPUT_QUATERNION_EXTENDED // Quaternion + accel + gyro combined
};

class SensorManager
{
public:
  SensorManager();

  /**
   * Initialize sensor manager and detect connected IMUs
   * @param baseNodeId The base ID for this node (from MAC)
   * @return true if at least one sensor was found
   */
  bool init(uint8_t baseNodeId = 0);

  /**
   * Optimized update for multi-sensor nodes with I2C multiplexer
   * Uses two-phase approach: batch I2C reads, then process all data
   * This reduces I2C bus contention and improves throughput for 6+ sensor nodes
   * @param dt Time step in seconds for quaternion integration
   */
  void updateOptimized(float dt);

  /**
   * Get the latest raw data from a specific sensor
   * @param sensorIndex Index of the sensor (0 to getSensorCount()-1)
   * @return IMUData structure with accelerometer and gyroscope readings
   */
  IMUData getData(uint8_t sensorIndex);

  /**
   * Get the fused quaternion for a specific sensor
   * @return Identity Quaternion always (fusion moved to TDMA layer)
   */
  Quaternion getQuaternion(uint8_t sensorIndex);

  /**
   * Get the number of detected sensors
   */
  uint8_t getSensorCount() const;

  /**
   * Set output mode (raw or quaternion)
   */
  void setOutputMode(OutputMode mode);

  /**
   * Get current output mode
   */
  OutputMode getOutputMode() const;

  /** Get current ZUPT gyro threshold */
  float getZuptGyroThresh() const { return zuptGyroThresh; }
  /** Get current ZUPT accel threshold */
  float getZuptAccelThresh() const { return zuptAccelThresh; }
  /** Get current ZUPT min frames */
  int getZuptMinFrames() const { return zuptMinFrames; }

  /**
   * Set accelerometer range for all sensors
   * @param rangeG Range in g (4, 8, 16, or 30)
   */
  void setAccelRange(uint8_t rangeG);

  /**
   * Set gyroscope range for all sensors
   * @param rangeDPS Range in degrees per second (500, 1000, 2000, or 4000)
   */
  void setGyroRange(uint16_t rangeDPS);

  // PhD-Level "Black Box" Profiles
  enum ActivityProfile
  {
    PROFILE_REHAB = 0, // Walking, imbalance (8G, 1000dps, 50Hz)
    PROFILE_SPORT = 1, // Running, cutting (16G, 2000dps, 50Hz)
    PROFILE_IMPACT = 2 // Jumping, boxing (30G, 4000dps, 100Hz)
  };

  /**
   * Apply a preset activity profile to configure physics engine automatically
   * @param profile The activity profile to use
   */
  void setActivityProfile(ActivityProfile profile);

  /**
   * Calibrate a specific sensor (compute gyro offsets at rest)
   * @param sensorId Sensor index to calibrate
   */
  void calibrateSensor(uint8_t sensorId);

  /**
   * Calibrate gyro bias ONLY (assumes device is stationary but not necessarily
   * flat)
   * @param sensorId Sensor index to calibrate
   */
  void calibrateGyro(uint8_t sensorId);

  /**
   * Get calibration data for a sensor
   */
  CalibrationData getCalibration(uint8_t sensorIndex);

  /**
   * Save calibration data to NVS for persistence across reboots
   * @param sensorId Sensor index to save calibration for
   */
  void saveCalibration(uint8_t sensorId);

  /**
   * Load calibration data from NVS
   * @return Number of sensors with saved calibration loaded
   */
  uint8_t loadCalibration();

  /**
   * Check if a sensor is calibrated
   */
  bool isCalibrated(uint8_t sensorIndex) const;

  /**
   * Get count of calibrated sensors
   */
  uint8_t getCalibratedCount() const;

  /**
   * Clear all calibration data from NVS (forces recalibration on next boot)
   */
  void clearCalibration();

  /**
   * Check if multiplexer is being used at runtime
   */
  bool isUsingMultiplexer() const { return useMultiplexer; }

  /**
   * Get the mux channel for a specific sensor
   * @return -1 if direct I2C, 0-7 if on mux channel
   */
  int8_t getSensorChannel(uint8_t sensorIndex) const;

  /**
   * Fill array with channel mappings for all sensors
   * @param channels Array of at least MAX_SENSORS size
   */
  void getSensorTopology(int8_t *channels) const;

  // ========== Optional Sensors (auto-detected) ==========

  /** Check if magnetometer is present */
  bool hasMag() const { return hasMagnetometer; }

  /** Check if barometer is present */
  bool hasBaro() const { return hasBarometer; }

  /** Get magnetometer data (only valid if hasMag() == true) */
  MagData getMagData() const { return magData; }

  /** Get calibrated magnetometer data (applies hard/soft iron correction) */
  MagData getCalibratedMagData() const;

  /** Get barometer data (only valid if hasBaro() == true) */
  BaroData getBaroData() const { return baroData; }

  /** Update optional sensors (called less frequently than IMUs) */
  void updateOptionalSensors();

  // ========== Magnetometer Calibration ==========

  /**
   * Start magnetometer calibration process
   * Collects min/max values while user moves sensor in figure-8 pattern
   * @param durationMs Duration to collect samples (default 15000ms = 15s)
   */
  void startMagCalibration(uint32_t durationMs = 15000);

  /**
   * Update magnetometer calibration (call in loop during calibration)
   * @return true if calibration is still in progress, false when complete
   */
  bool updateMagCalibration();

  /**
   * Check if magnetometer calibration is currently running
   */
  bool isMagCalibrating() const { return magCalibrationActive; }

  /**
   * Get magnetometer calibration progress (0-100)
   */
  uint8_t getMagCalibrationProgress() const;

  /**
   * Get magnetometer calibration data
   */
  MagCalibrationData getMagCalibration() const { return magCalibration; }

  /**
   * Check if magnetometer is calibrated
   */
  bool isMagCalibrated() const { return magCalibration.isCalibrated; }

  /**
   * Save magnetometer calibration to NVS
   */
  void saveMagCalibration();

  /**
   * Load magnetometer calibration from NVS
   * @return true if calibration was loaded
   */
  bool loadMagCalibration();

  /**
   * Clear magnetometer calibration
   */
  void clearMagCalibration();

  // ============================================================================
  // FIFO BATCH READING (Parallelization Optimization)
  // ============================================================================
  /**
   * Enable FIFO mode for batch reading (call once after init)
   * This configures the ICM20649 to buffer samples in hardware FIFO.
   */
  void enableFIFOMode();

  /**
   * Read multiple samples from all sensors using FIFO batch read.
   * This is ~75% faster than individual readFrame() calls.
   *
   * @param maxSamples Maximum samples per sensor to read (1-4 recommended)
   * @return Number of samples read per sensor (0 if no data)
   */
  uint8_t updateBatch(uint8_t maxSamples = 4);

  /**
   * Get batched sample from buffer
   * @param sensorIndex Which sensor (0 to getSensorCount()-1)
   * @param sampleIndex Which sample in batch (0 to updateBatch()-1)
   * @return IMUData for that sample
   */
  IMUData getBatchedData(uint8_t sensorIndex, uint8_t sampleIndex) const;

  /**
   * Check if FIFO mode is enabled
   */
  bool isFIFOEnabled() const { return fifoModeEnabled; }
  // ============================================================================

private:
  ICM20649_Research sensors[MAX_SENSORS]; // Use custom driver
  IMUData sensorData[MAX_SENSORS];
  CalibrationData calibration[MAX_SENSORS];

  uint8_t sensorCount;
  bool useMultiplexer;
  OutputMode outputMode;

  // Sensor channel mapping (-1 = direct I2C, 0-7 = mux channel)
  int8_t sensorChannels[MAX_SENSORS];

  // ZUPT (Zero Velocity Update) thresholds
  float zuptGyroThresh;  // rad/s
  float zuptAccelThresh; // m/s² deviation from 1g
  int zuptMinFrames;     // frames to confirm stationary

  // Optional sensors (may not be present)
  bool hasMagnetometer;
  bool hasBarometer;
  Adafruit_MMC5603 mag;
  Adafruit_BMP3XX baro;
  MagData magData;
  BaroData baroData;
  unsigned long lastOptionalSensorUpdate;

  // Multiplexer channels for optional sensors (-1 = direct I2C, 0-7 = mux
  // channel)
  int8_t magChannel;
  int8_t baroChannel;

  // Frame counter for magnetometer correction scheduling
  uint32_t updateCount;

  // Magnetometer calibration state
  MagCalibrationData magCalibration;
  bool magCalibrationActive;
  uint32_t magCalibrationStartTime;
  uint32_t magCalibrationDuration;
  float magMinX, magMaxX;
  float magMinY, magMaxY;
  float magMinZ, magMaxZ;

  // ============================================================================
  // FIFO BATCH READING STATE
  // ============================================================================
  bool fifoModeEnabled;
  static constexpr uint8_t BATCH_BUFFER_SIZE = 4; // Max samples per batch
  IMUFrame batchBuffer[MAX_SENSORS][BATCH_BUFFER_SIZE];
  uint8_t batchSampleCount; // Samples currently in batch buffer
  // ============================================================================

  /**
   * Select I2C multiplexer channel
   * @param channel Channel number (0-7)
   */
  void selectChannel(uint8_t channel);
};

#endif // SENSOR_MANAGER_H
