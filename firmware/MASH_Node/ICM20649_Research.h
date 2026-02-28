/**
 * ICM20649_Research.h
 *
 * Research-Grade driver for ICM-20649 High-G IMU.
 *
 * DESIGN PHILOSOPHY:
 * 1. Hardware DLPF: Strict 50Hz cutoff to prevent aliasing.
 * 2. FIFO Stream: Burst reads to minimize CPU/Radio jitter.
 * 3. Bank Switching: Robust register access.
 * 4. No Bloat: Direct register manipulation.
 *
 * REFERENCES:
 * - ICM-20649 Datasheet (DS-000192)
 * - ICM-20649 Register Map (RM-000192)
 */

#ifndef ICM20649_RESEARCH_H
#define ICM20649_RESEARCH_H

#include <Arduino.h>
#include <Wire.h>

// ============================================================================
// REGISTER MAP (Critical Only)
// ============================================================================

// BANK 0: Global, User Interface, FIFO
#define REG_BANK_SEL 0x7F
#define BANK0 0x00
#define BANK2 0x02

#define REG_WHO_AM_I 0x00
#define WHO_AM_I_VAL 0xE1

#define REG_PWR_MGMT_1 0x06
#define BIT_DEVICE_RESET 0x80
#define BIT_CLKSEL_AUTO 0x01
#define BIT_SLEEP 0x40 // Sleep mode bit

#define REG_INT_STATUS_1 0x1A       // Data ready interrupt status
#define BIT_RAW_DATA_0_RDY_INT 0x01 // Raw data ready bit

#define REG_FIFO_EN_2 0x67
#define BIT_ACCEL_FIFO_EN 0x10
#define BIT_GYRO_FIFO_EN 0x0E // Gyro X, Y, Z

#define REG_FIFO_R_W 0x72
#define REG_FIFO_COUNTH 0x70

#define REG_TEMP_OUT_H 0x39

// BANK 2: Configuration
#define REG_GYRO_SMPLRT_DIV 0x00 // Gyro sample rate divider
#define REG_GYRO_CONFIG_1 0x01
#define REG_ACCEL_SMPLRT_DIV_1 0x10 // Accel sample rate divider MSB
#define REG_ACCEL_SMPLRT_DIV_2 0x11 // Accel sample rate divider LSB
#define REG_ACCEL_CONFIG_1 0x14     // Was 0x15 (WRONG!) - Adafruit uses 0x14

// BANK 2: Gyro Offset Registers (for hardware bias cancellation)
#define REG_XG_OFFS_USRH 0x03
#define REG_XG_OFFS_USRL 0x04
#define REG_YG_OFFS_USRH 0x05
#define REG_YG_OFFS_USRL 0x06
#define REG_ZG_OFFS_USRH 0x07
#define REG_ZG_OFFS_USRL 0x08

// BANK 1: Accel Offset Registers (for hardware bias cancellation)
#define BANK1 0x01
#define REG_XA_OFFS_H 0x14
#define REG_XA_OFFS_L 0x15
#define REG_YA_OFFS_H 0x17
#define REG_YA_OFFS_L 0x18
#define REG_ZA_OFFS_H 0x1A
#define REG_ZA_OFFS_L 0x1B

// ============================================================================
// CONFIGURATION ENUMS
// ============================================================================

enum AccelRange
{
  RANGE_4G = 0x00,
  RANGE_8G = 0x02,  // Recommended for Rehab/Walking
  RANGE_16G = 0x04, // Recommended for Running/Sports
  RANGE_30G = 0x06  // Impact only
};

enum GyroRange
{
  RANGE_500DPS = 0x00,
  RANGE_1000DPS = 0x02, // Recommended for Rehab
  RANGE_2000DPS = 0x04, // Recommended for Sports
  RANGE_4000DPS = 0x06
};

enum DLPFBandwidth
{
  DLPF_196HZ = 0x01, // Too high for biomech
  DLPF_151HZ = 0x02,
  DLPF_119HZ = 0x03,
  DLPF_51HZ = 0x04, // PhD Recommendation (prevents aliasing)
  DLPF_23HZ = 0x05, // Heavy smoothing
  DLPF_11HZ = 0x06
};

// Output Data Rate presets (internal ODR before DLPF)
// ODR = 1.125kHz / (1 + SMPLRT_DIV)
// For oversampling strategy: sample high, decimate to 200Hz
enum OutputDataRate
{
  ODR_1125HZ = 0, // Divider 0: 1125Hz (max)
  ODR_562HZ = 1,  // Divider 1: 562Hz
  ODR_375HZ = 2,  // Divider 2: 375Hz
  ODR_281HZ = 3,  // Divider 3: 281Hz
  ODR_225HZ = 4,  // Divider 4: 225Hz (good for 200Hz output + margin)
  ODR_187HZ = 5,  // Divider 5: 187Hz
  ODR_100HZ = 10, // Divider 10: ~102Hz
  ODR_50HZ = 21   // Divider 21: ~51Hz
};

// ============================================================================
// DATA STRUCTURES
// ============================================================================

struct IMUFrame
{
  int16_t accelX, accelY, accelZ;
  int16_t gyroX, gyroY, gyroZ;
  int16_t tempRaw;
  uint32_t timestampMicros; // Capture time

  // Converted values (for fusion)
  float ax_g, ay_g, az_g;
  float gx_rad, gy_rad, gz_rad;
  float temp_c;
};

class ICM20649_Research
{
public:
  ICM20649_Research();

  /**
   * Initialize sensor
   * @param wire Pointer to Wire instance
   * @param address I2C address (default 0x68)
   */
  bool begin(TwoWire *wire = &Wire, uint8_t address = 0x68);

  /**
   * Configure physics parameters (Bank 2)
   * Disables generic "DMP" and uses hardware DLPF.
   */
  void configurePhysics(AccelRange aRange, GyroRange gRange,
                        DLPFBandwidth bw = DLPF_51HZ);

  void setAccelRange(AccelRange range, DLPFBandwidth bw = DLPF_51HZ);
  void setGyroRange(GyroRange range, DLPFBandwidth bw = DLPF_51HZ);

  /**
   * Configure Output Data Rate (ODR) for both accel and gyro.
   * ICM-20649 internal rate = 1.125kHz, ODR = 1125/(1+divider)
   *
   * For 200Hz output with oversampling strategy:
   * - Set ODR_375HZ or ODR_562HZ for 2-3x oversampling
   * - Apply software decimation filter before transmission
   *
   * @param divider Sample rate divider (0-255 for gyro, 0-4095 for accel)
   */
  void setOutputDataRate(OutputDataRate odr);
  void setOutputDataRateRaw(uint8_t gyroDivider, uint16_t accelDivider);

  /**
   * Enable FIFO Stream Mode
   * @param watermarkThreshold Number of samples to trigger interrupt (20
   * recommended)
   */
  void enableFIFO(uint8_t watermarkThreshold = 20);

  /**
   * Reset the FIFO buffer (call if overflow detected)
   */
  void resetFIFO();

  /**
   * Check if new data is available in FIFO
   * @return Number of bytes in FIFO
   */
  uint16_t getFIFOCount();

  /**
   * Read logic for the main loop.
   * Pulls latest packet from FIFO or reads immediately if FIFO disabled.
   * Includes keep-alive check every 1 second (adds ~50us overhead when triggered).
   */
  bool readFrame(IMUFrame *frame);

  /**
   * FAST READ: Read sensor data without keep-alive check.
   * Use this in tight loops where you need maximum throughput.
   * Call checkSensorHealth() separately at a lower rate (e.g., every 2 seconds).
   * @param frame Pointer to frame struct to fill
   * @return true if read successful, false on I2C error
   */
  bool readFrameFast(IMUFrame *frame);

  /**
   * Check sensor health and wake if needed.
   * Call this periodically (every 1-2 seconds) when using readFrameFast().
   * @return true if sensor is healthy, false if wake was attempted
   */
  bool checkSensorHealth();

  /**
   * BATCH READ: Read multiple frames in a single I2C burst transaction.
   * This reduces I2C overhead by ~75% compared to individual readFrame() calls.
   *
   * The ICM20649 FIFO stores 512 bytes total. Each frame is 12 bytes
   * (6 accel + 6 gyro), so FIFO can hold ~42 frames.
   *
   * @param frames Array to store read frames
   * @param maxFrames Maximum number of frames to read (up to 10 recommended)
   * @return Number of frames actually read (0 if FIFO empty or error)
   *
   * Usage:
   *   IMUFrame batch[4];
   *   uint8_t count = sensor.readFrameBatch(batch, 4);
   *   for (int i = 0; i < count; i++) { process(batch[i]); }
   */
  uint8_t readFrameBatch(IMUFrame *frames, uint8_t maxFrames);

  /**
   * Temperature compensation coefficients
   * G_corr = G_raw - (Slope * (T_current - T_ref))
   */
  void setTempCalibration(float slopeX, float slopeY, float slopeZ,
                          float tempRef);

  /**
   * Set hardware gyro offset registers for bias cancellation.
   * Values are in raw LSB (use gyroScale to convert from rad/s).
   */
  void setGyroOffset(int16_t offsetX, int16_t offsetY, int16_t offsetZ);

  /**
   * Get gyro scale factor (rad/s per LSB) for offset conversion
   */
  float getGyroScale() const { return _gyroScale; }

  /**
   * Set hardware accel offset registers for bias cancellation.
   * Values are in raw LSB (use accelScale to convert from g).
   */
  void setAccelOffset(int16_t offsetX, int16_t offsetY, int16_t offsetZ);

  /**
   * Get accel scale factor (g per LSB) for offset conversion
   */
  float getAccelScale() const { return _accelScale; }

private:
  TwoWire *_wire;
  uint8_t _addr;
  uint8_t _currentBank;

  float _accelScale; // g per LSB
  float _gyroScale;  // rad/s per LSB

  // Temp comp parameters
  float _tempSlope[3];       // X, Y, Z
  float _tempRef;            // Reference temperature
  float _cachedTemp_c;       // Cached temperature for fast reads (updated every ~1s)
  uint32_t _tempReadCounter; // Counter for throttling temp reads in readFrameFast

  void selectBank(uint8_t bank);
  void writeRegister(uint8_t bank, uint8_t reg, uint8_t value);
  uint8_t readRegister(uint8_t bank, uint8_t reg);
  uint8_t readRegisterBlock(uint8_t bank, uint8_t reg, uint8_t *buffer,
                            uint8_t len);
  void recoverI2CBus(); // Clock out stuck I2C slaves
};

#endif // ICM20649_RESEARCH_H
