/**
 * ICM20649_Research.cpp
 *
 * Implementation of Research-Grade driver.
 */

#include "ICM20649_Research.h"

#define GRAVITY 9.80665f

ICM20649_Research::ICM20649_Research()
{
  _currentBank = 0xFF; // Force reload on first access
  _accelScale = 0;
  _gyroScale = 0;
  _tempRef = 25.0f;       // Default room temp
  _cachedTemp_c = 25.0f;  // Default until first real temp read
  _tempReadCounter = 199; // Force temp read on first call to readFrameFast
  for (int i = 0; i < 3; i++)
    _tempSlope[i] = 0.0f;
}

// I2C Bus Recovery: Clock out any stuck slave devices
void ICM20649_Research::recoverI2CBus()
{
  Serial.println("[ICM20649] Attempting I2C bus recovery...");

  // Temporarily end Wire to release pins
  _wire->end();
  delay(10);

  // Get the I2C pins (ESP32-S3 QT Py defaults: SDA=41, SCL=40)
  // We'll manually clock the bus to release any stuck slaves
  int sdaPin = SDA; // Use default Arduino SDA
  int sclPin = SCL; // Use default Arduino SCL

  pinMode(sdaPin, INPUT_PULLUP);
  pinMode(sclPin, OUTPUT);

  // Generate 9 clock pulses to release any stuck slave
  for (int i = 0; i < 9; i++)
  {
    digitalWrite(sclPin, LOW);
    delayMicroseconds(5);
    digitalWrite(sclPin, HIGH);
    delayMicroseconds(5);
  }

  // Generate STOP condition
  pinMode(sdaPin, OUTPUT);
  digitalWrite(sdaPin, LOW);
  delayMicroseconds(5);
  digitalWrite(sclPin, HIGH);
  delayMicroseconds(5);
  digitalWrite(sdaPin, HIGH);
  delayMicroseconds(5);

  // Re-initialize Wire
  _wire->begin();
  _wire->setClock(400000);
  delay(10);

  Serial.println("[ICM20649] I2C bus recovery complete");
}

bool ICM20649_Research::begin(TwoWire *wire, uint8_t address)
{
  _wire = wire;
  _addr = address;

  Serial.printf("[ICM20649] Initializing at address 0x%02X...\n", _addr);

  // 0. First, try reading WHO_AM_I to verify bus is working
  uint8_t who = readRegister(BANK0, REG_WHO_AM_I);
  Serial.printf("[ICM20649] Initial WHO_AM_I read: 0x%02X (expect 0xE1)\n", who);

  if (who != WHO_AM_I_VAL)
  {
    // Try I2C recovery
    Serial.println("[ICM20649] WHO_AM_I mismatch - trying I2C recovery...");
    recoverI2CBus();
    delay(50);

    who = readRegister(BANK0, REG_WHO_AM_I);
    Serial.printf("[ICM20649] After recovery WHO_AM_I: 0x%02X\n", who);
    if (who != WHO_AM_I_VAL)
    {
      Serial.println("[ICM20649] FATAL: Cannot communicate with sensor!");
      return false;
    }
  }

  // 1. Reset device (with verification)
  Serial.println("[ICM20649] Resetting device...");
  writeRegister(BANK0, REG_PWR_MGMT_1, BIT_DEVICE_RESET);
  delay(100); // Wait for reset

  // After reset, WHO_AM_I should still be correct
  who = readRegister(BANK0, REG_WHO_AM_I);
  if (who != WHO_AM_I_VAL)
  {
    Serial.printf("[ICM20649] Post-reset WHO_AM_I invalid: 0x%02X\n", who);
    return false;
  }

  // 2. Wake up and select Auto Clock
  Serial.println("[ICM20649] Waking sensor (clearing SLEEP bit)...");
  writeRegister(BANK0, REG_PWR_MGMT_1, BIT_CLKSEL_AUTO);
  delay(30); // Wait for oscillator startup

  // Verify wake succeeded
  uint8_t pwrMgmt = readRegister(BANK0, REG_PWR_MGMT_1);
  Serial.printf("[ICM20649] PWR_MGMT_1 after wake: 0x%02X (expect 0x01)\n", pwrMgmt);

  if (pwrMgmt & BIT_SLEEP)
  {
    Serial.println("[ICM20649] WARNING: Sensor still in SLEEP mode!");
    // Try again with slower I2C
    _wire->setClock(100000);
    writeRegister(BANK0, REG_PWR_MGMT_1, BIT_CLKSEL_AUTO);
    delay(30);
    pwrMgmt = readRegister(BANK0, REG_PWR_MGMT_1);
    Serial.printf("[ICM20649] Retry at 100kHz - PWR_MGMT_1: 0x%02X\n", pwrMgmt);
    _wire->setClock(400000); // Restore
  }

  // 3. Configure physics (with verification)
  Serial.println("[ICM20649] Configuring sensors...");
  configurePhysics(RANGE_8G, RANGE_1000DPS, DLPF_119HZ);

  Serial.println("[ICM20649] Initialization complete!");
  return true;
}

void ICM20649_Research::configurePhysics(AccelRange aRange, GyroRange gRange,
                                         DLPFBandwidth bw)
{
  // === GYRO CONFIG ===
  // Bank 2, Reg 0x01
  // [5:3] DLPFCFG, [2:1] FS_SEL, [0] FCHOICE (0=enable DLPF)
  uint8_t gyroConfig = (bw << 3) | gRange | 1; // FCHOICE=1 enables DLPF path

  // Actually, for ICM20649:
  // FCHOICE=0: Bypass DLPF? No.
  // We want FCHOICE=1 (Enable DLPF)
  // Check Datasheet carefully:
  // GYRO_FCHOICE (bit 0): 0=Bypass DLPF, 1=Enable DLPF.
  // Wait, standard practice says enable.
  // Let's stick to the register map:
  // Bit 0 = 1 to ENABLE the filter chain properly.

  writeRegister(BANK2, REG_GYRO_CONFIG_1, gyroConfig);

  // Calculate Gyro Scale (deg/s -> rad/s)
  float fs_dps = 0;
  switch (gRange)
  {
  case RANGE_500DPS:
    fs_dps = 500.0f;
    break;
  case RANGE_1000DPS:
    fs_dps = 1000.0f;
    break;
  case RANGE_2000DPS:
    fs_dps = 2000.0f;
    break;
  case RANGE_4000DPS:
    fs_dps = 4000.0f;
    break;
  }
  _gyroScale = (fs_dps / 32767.0f) * (3.14159f / 180.0f); // rad/s per LSB

  // === ACCEL CONFIG ===
  // Bank 2, Reg 0x15
  // [5:3] DLPFCFG, [2:1] FS_SEL, [0] FCHOICE
  uint8_t accelConfig = (bw << 3) | aRange | 1;
  writeRegister(BANK2, REG_ACCEL_CONFIG_1, accelConfig);

  // DEBUG: Readback verify and log
  uint8_t readback = readRegister(BANK2, REG_ACCEL_CONFIG_1);
  Serial.printf(
      "[ICM20649] Accel config: wrote 0x%02X, readback 0x%02X, range=%d\n",
      accelConfig, readback, aRange);

  // Calculate Accel Scale (g)
  float fs_g = 0;
  switch (aRange)
  {
  case RANGE_4G:
    fs_g = 4.0f;
    break;
  case RANGE_8G:
    fs_g = 8.0f;
    break;
  case RANGE_16G:
    fs_g = 16.0f;
    break;
  case RANGE_30G:
    fs_g = 30.0f;
    break;
  }
  _accelScale = fs_g / 32767.0f;

  // WORKAROUND: Raw accel reads ~6.4x too high (register config issue TBD)
  // Apply correction factor to get correct gravity reading
  // _accelScale = _accelScale * 6.4f; // Reverted

  Serial.printf("[ICM20649] Accel scale set to %.6f g/LSB (range=+/-%dg)\n",
                _accelScale, (int)fs_g);

  // CRITICAL: Switch back to Bank 0 after config (data registers are in Bank 0)
  selectBank(BANK0);
}

void ICM20649_Research::setOutputDataRate(OutputDataRate odr)
{
  // Use same divider for both gyro and accel
  setOutputDataRateRaw((uint8_t)odr, (uint16_t)odr);
}

void ICM20649_Research::setOutputDataRateRaw(uint8_t gyroDivider, uint16_t accelDivider)
{
  // Gyro sample rate divider (Bank 2, Reg 0x00)
  // ODR = 1.125kHz / (1 + divider)
  writeRegister(BANK2, REG_GYRO_SMPLRT_DIV, gyroDivider);

  // Accel sample rate divider (Bank 2, Reg 0x10-0x11)
  // 12-bit value split across two registers
  // ODR = 1.125kHz / (1 + divider)
  writeRegister(BANK2, REG_ACCEL_SMPLRT_DIV_1, (uint8_t)(accelDivider >> 8));   // MSB [11:8]
  writeRegister(BANK2, REG_ACCEL_SMPLRT_DIV_2, (uint8_t)(accelDivider & 0xFF)); // LSB [7:0]

  float gyroODR = 1125.0f / (1.0f + gyroDivider);
  float accelODR = 1125.0f / (1.0f + accelDivider);
  Serial.printf("[ICM20649] ODR set: Gyro=%.1fHz, Accel=%.1fHz (dividers: %d, %d)\n",
                gyroODR, accelODR, gyroDivider, accelDivider);

  // Return to Bank 0
  selectBank(BANK0);
}

void ICM20649_Research::enableFIFO(uint8_t watermarkThreshold)
{
  // 1. Reset FIFO
  writeRegister(BANK0, 0x6A, 0xF); // Disable user ctrl
  delay(10);

  // 2. Enable FIFO components (Accel + Gyro)
  // Reg 0x67 FIFO_EN_2
  uint8_t fifo_en_2 = BIT_ACCEL_FIFO_EN | BIT_GYRO_FIFO_EN; // Accel, GyroXYZ
  writeRegister(BANK0, REG_FIFO_EN_2, fifo_en_2);

  // 3. Configure FIFO mode (Stream)
  // Reg 0x66 FIFO_RST/MODE
  // Bit 4-0 is mode? No Check reg map.
  // For basic Stream mode, usually just enable it in USER_CTRL (Reg 0x03)

  // USER_CTRL (Bank 0, Reg 0x03)
  // Bit 6: FIFO_EN
  // Bit 4: I2C_IF_DIS (disable to use SPI? We are I2C)
  // Bit 0: SIG_COND_RST
  writeRegister(BANK0, 0x03, 0x40); // Enable FIFO bit
}

void ICM20649_Research::resetFIFO()
{
  uint8_t user_ctrl = readRegister(BANK0, 0x03);
  writeRegister(BANK0, 0x03, user_ctrl | 0x04); // FIFO_RST bit
}

uint16_t ICM20649_Research::getFIFOCount()
{
  uint8_t buff[2];
  readRegisterBlock(BANK0, REG_FIFO_COUNTH, buff, 2);
  return (uint16_t)(((uint16_t)buff[0] << 8) | buff[1]);
}

bool ICM20649_Research::readFrame(IMUFrame *frame)
{
  // PREEMPTIVE KEEP-ALIVE CHECK: Verify sensor is awake every 1 second
  static unsigned long lastKeepAlive = 0;
  static int consecutiveFailures = 0;

  if (millis() - lastKeepAlive > 1000)
  {
    uint8_t pwrMgmt1 = readRegister(BANK0, REG_PWR_MGMT_1);
    if (pwrMgmt1 & BIT_SLEEP)
    {
      consecutiveFailures++;
      Serial.printf("[ICM20649] KEEP-ALIVE: Sensor SLEEP detected (fail #%d)\n", consecutiveFailures);

      // After 3 consecutive failures, try I2C recovery
      if (consecutiveFailures >= 3)
      {
        Serial.println("[ICM20649] KEEP-ALIVE: 3+ failures - attempting I2C bus recovery");
        recoverI2CBus();
        _wire->setClock(100000); // Try slower clock
        delay(20);
        consecutiveFailures = 0; // Reset counter
      }

      // Wake sequence
      writeRegister(BANK0, REG_PWR_MGMT_1, BIT_DEVICE_RESET);
      delay(100);
      writeRegister(BANK0, REG_PWR_MGMT_1, BIT_CLKSEL_AUTO);
      delay(50);

      // Verify
      pwrMgmt1 = readRegister(BANK0, REG_PWR_MGMT_1);
      if (!(pwrMgmt1 & BIT_SLEEP))
      {
        Serial.printf("[ICM20649] KEEP-ALIVE: Wake SUCCESS! PWR_MGMT_1=0x%02X\n", pwrMgmt1);
        configurePhysics(RANGE_8G, RANGE_1000DPS, DLPF_119HZ);
        consecutiveFailures = 0;
        _wire->setClock(400000); // Restore fast clock if wake worked
      }
      else
      {
        Serial.printf("[ICM20649] KEEP-ALIVE: Wake FAILED! PWR_MGMT_1=0x%02X\n", pwrMgmt1);
      }
    }
    else
    {
      consecutiveFailures = 0; // Reset on success
    }
    lastKeepAlive = millis();
  }

  // BYPASS FIFO - Read directly from registers for reliability
  // ACCEL: 0x2D-0x32 (6 bytes), GYRO: 0x33-0x38 (6 bytes)
  // Read all 12 bytes in one contiguous read for atomic data capture

  uint8_t raw[12] = {0}; // Initialize to zero for safety

  // Single read of accel + gyro (12 bytes starting at 0x2D)
  uint8_t bytesRead = readRegisterBlock(BANK0, 0x2D, raw, 12);
  if (bytesRead != 12)
  {
    return false; // I2C read failed
  }

  frame->accelX = (int16_t)((raw[0] << 8) | raw[1]);
  frame->accelY = (int16_t)((raw[2] << 8) | raw[3]);
  frame->accelZ = (int16_t)((raw[4] << 8) | raw[5]);

  frame->gyroX = (int16_t)((raw[6] << 8) | raw[7]);
  frame->gyroY = (int16_t)((raw[8] << 8) | raw[9]);
  frame->gyroZ = (int16_t)((raw[10] << 8) | raw[11]);

  // Check for all-zeros (sensor may be in standby or not configured)
  if (frame->accelX == 0 && frame->accelY == 0 && frame->accelZ == 0 &&
      frame->gyroX == 0 && frame->gyroY == 0 && frame->gyroZ == 0)
  {
    static unsigned long lastZeroWarn = 0;
    if (millis() - lastZeroWarn > 5000)
    {
      Serial.println("[ICM20649] WARNING: All sensor registers read as zero!");

      // Read diagnostic registers to understand WHY
      uint8_t pwrMgmt1 = readRegister(BANK0, REG_PWR_MGMT_1);
      uint8_t intStatus = readRegister(BANK0, REG_INT_STATUS_1);
      uint8_t whoami = readRegister(BANK0, REG_WHO_AM_I);

      Serial.printf("[ICM20649] DIAG: WHO_AM_I=0x%02X (expect 0xE1), PWR_MGMT_1=0x%02X, INT_STATUS_1=0x%02X\n",
                    whoami, pwrMgmt1, intStatus);
      Serial.printf("[ICM20649] DIAG: PWR_MGMT_1 bits: SLEEP=%d, CLKSEL=%d\n",
                    (pwrMgmt1 >> 6) & 1, pwrMgmt1 & 0x07);
      Serial.printf("[ICM20649] DIAG: Raw bytes: [%02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X]\n",
                    raw[0], raw[1], raw[2], raw[3], raw[4], raw[5],
                    raw[6], raw[7], raw[8], raw[9], raw[10], raw[11]);

      if (pwrMgmt1 & BIT_SLEEP)
      {
        Serial.println("[ICM20649] ERROR: Sensor is in SLEEP mode! Attempting wake-up...");

        // ROBUST WAKE-UP SEQUENCE:
        // 1. Full device reset first
        writeRegister(BANK0, REG_PWR_MGMT_1, BIT_DEVICE_RESET);
        delay(100); // Reset takes up to 100ms

        // 2. Clear SLEEP bit and set auto clock (write 0x01, NOT 0x41)
        // BIT_CLKSEL_AUTO = 0x01 means: SLEEP=0, CLKSEL=auto
        writeRegister(BANK0, REG_PWR_MGMT_1, BIT_CLKSEL_AUTO);
        delay(50); // Extra time for oscillator startup

        // 3. Verify wake-up succeeded
        uint8_t verifyPwr = readRegister(BANK0, REG_PWR_MGMT_1);
        if (verifyPwr & BIT_SLEEP)
        {
          Serial.printf("[ICM20649] WAKE FAILED! PWR_MGMT_1 still 0x%02X - Trying I2C recovery...\n", verifyPwr);

          // Try I2C bus recovery
          recoverI2CBus();
          delay(50);

          // Try a slower I2C clock (100kHz instead of 400kHz)
          _wire->setClock(100000);
          Serial.println("[ICM20649] Reduced I2C clock to 100kHz");

          // Retry device reset with slower clock
          writeRegister(BANK0, REG_PWR_MGMT_1, BIT_DEVICE_RESET);
          delay(100);
          writeRegister(BANK0, REG_PWR_MGMT_1, BIT_CLKSEL_AUTO);
          delay(50);

          verifyPwr = readRegister(BANK0, REG_PWR_MGMT_1);
          if (verifyPwr & BIT_SLEEP)
          {
            Serial.printf("[ICM20649] STILL FAILED after recovery! PWR_MGMT_1=0x%02X\n", verifyPwr);
            Serial.println("[ICM20649] >>> CHECK HARDWARE: wiring, power, sensor defect <<<");
          }
          else
          {
            Serial.printf("[ICM20649] Recovery SUCCESS! PWR_MGMT_1=0x%02X\n", verifyPwr);
            configurePhysics(RANGE_8G, RANGE_1000DPS, DLPF_119HZ);
            // Restore full speed
            _wire->setClock(400000);
          }
        }
        else
        {
          Serial.printf("[ICM20649] WAKE SUCCESS! PWR_MGMT_1 = 0x%02X\n", verifyPwr);

          // 4. Re-apply sensor configuration after reset
          configurePhysics(RANGE_8G, RANGE_1000DPS, DLPF_119HZ);
          Serial.println("[ICM20649] Sensor re-configured after wake-up");
        }
      }

      lastZeroWarn = millis();
    }
    // Still return true - data was read, just all zeros
  }

  // Read temp separately (not in FIFO usually for 20649, standard packets are
  // AG)
  uint8_t tRaw[2] = {0};
  readRegisterBlock(BANK0, REG_TEMP_OUT_H, tRaw, 2);
  frame->tempRaw = (int16_t)((tRaw[0] << 8) | tRaw[1]);

  frame->timestampMicros = micros();

  // DEBUG: Log raw int16 values periodically to diagnose scale issues
  static unsigned long lastRawDebug = 0;
  if (millis() - lastRawDebug > 5000)
  {
    Serial.printf("[ICM20649] Raw int16: accel=[%d,%d,%d] gyro=[%d,%d,%d]\n",
                  frame->accelX, frame->accelY, frame->accelZ, frame->gyroX,
                  frame->gyroY, frame->gyroZ);
    Serial.printf("[ICM20649] Scales: accel=%.6f g/LSB, gyro=%.6f rad/s/LSB\n",
                  _accelScale, _gyroScale);
    lastRawDebug = millis();
  }

  // =========================================================================
  // TRANSFORM 1: ICM20649 (Z-up) → Y-up
  // See: firmware/BigPicture/ORIENTATION_PIPELINE.md
  // =========================================================================
  // Transform: [X, Z, -Y] with chirality preservation
  //   X → X  (Right stays Right)
  //   Z → Y  (Up stays Up)
  //   Y → -Z (Forward becomes Back, preserves right-handedness)
  // =========================================================================

  float ax_sensor = frame->accelX * _accelScale;
  float ay_sensor = frame->accelY * _accelScale;
  float az_sensor = frame->accelZ * _accelScale;

  // Accel: [X, Z, -Y]
  frame->ax_g = ax_sensor;
  frame->ay_g = az_sensor;
  frame->az_g = -ay_sensor;

  // Gyro Temp Compensation
  frame->temp_c = (frame->tempRaw / 333.87f) + 21.0f;

  float gx_sensor = frame->gyroX * _gyroScale;
  float gy_sensor = frame->gyroY * _gyroScale;
  float gz_sensor = frame->gyroZ * _gyroScale;

  // Apply linear bias correction (in sensor frame)
  float tempDelta = frame->temp_c - _tempRef;
  gx_sensor -= (_tempSlope[0] * tempDelta);
  gy_sensor -= (_tempSlope[1] * tempDelta);
  gz_sensor -= (_tempSlope[2] * tempDelta);

  // Gyro: [X, Z, -Y] - IDENTICAL to accel (rigid body rule)
  frame->gx_rad = gx_sensor;
  frame->gy_rad = gz_sensor;
  frame->gz_rad = -gy_sensor;

  return true;
}

// ============================================================================
// FAST READ: Optimized read without keep-alive check
// ============================================================================
// Use this in tight loops for maximum throughput. Call checkSensorHealth()
// separately at a lower rate (e.g., every 2 seconds per sensor).
// ============================================================================
bool ICM20649_Research::readFrameFast(IMUFrame *frame)
{
  // Direct register read - no keep-alive overhead
  uint8_t raw[12] = {0};

  uint8_t bytesRead = readRegisterBlock(BANK0, 0x2D, raw, 12);
  if (bytesRead != 12)
  {
    return false;
  }

  // Parse raw data
  frame->accelX = (int16_t)((raw[0] << 8) | raw[1]);
  frame->accelY = (int16_t)((raw[2] << 8) | raw[3]);
  frame->accelZ = (int16_t)((raw[4] << 8) | raw[5]);
  frame->gyroX = (int16_t)((raw[6] << 8) | raw[7]);
  frame->gyroY = (int16_t)((raw[8] << 8) | raw[9]);
  frame->gyroZ = (int16_t)((raw[10] << 8) | raw[11]);

  // Quick all-zeros check (sensor may be asleep)
  if (frame->accelX == 0 && frame->accelY == 0 && frame->accelZ == 0 &&
      frame->gyroX == 0 && frame->gyroY == 0 && frame->gyroZ == 0)
  {
    return false; // Likely sensor issue - caller should invoke checkSensorHealth()
  }

  frame->timestampMicros = micros();

  // Apply scaling and transforms (same as readFrame)
  float ax_sensor = frame->accelX * _accelScale;
  float ay_sensor = frame->accelY * _accelScale;
  float az_sensor = frame->accelZ * _accelScale;

  frame->ax_g = ax_sensor;
  frame->ay_g = az_sensor;
  frame->az_g = -ay_sensor;

  // ========================================================================
  // TEMPERATURE: Read only every 200 samples (~1s at 200Hz)
  // ========================================================================
  // Temperature changes over seconds, not milliseconds. Reading the temp
  // register every sample wastes ~150µs per sensor per read (I2C overhead
  // for selectBank + beginTransmission + requestFrom + read). With 4 sensors,
  // that's 600µs wasted out of a 5000µs budget — 12% of the cycle.
  //
  // Fix: Read temp every 200th call (~1s), cache the result for gyro
  // temp compensation on intervening calls. Temperature drift at room
  // temp is ~0.01°C/s, so 1s staleness is negligible for bias correction.
  // ========================================================================
  _tempReadCounter++;
  if (_tempReadCounter >= 200)
  {
    _tempReadCounter = 0;
    uint8_t tRaw[2] = {0};
    readRegisterBlock(BANK0, REG_TEMP_OUT_H, tRaw, 2);
    frame->tempRaw = (int16_t)((tRaw[0] << 8) | tRaw[1]);
    _cachedTemp_c = (frame->tempRaw / 333.87f) + 21.0f;
  }
  frame->temp_c = _cachedTemp_c;

  float gx_sensor = frame->gyroX * _gyroScale;
  float gy_sensor = frame->gyroY * _gyroScale;
  float gz_sensor = frame->gyroZ * _gyroScale;

  float tempDelta = frame->temp_c - _tempRef;
  gx_sensor -= (_tempSlope[0] * tempDelta);
  gy_sensor -= (_tempSlope[1] * tempDelta);
  gz_sensor -= (_tempSlope[2] * tempDelta);

  frame->gx_rad = gx_sensor;
  frame->gy_rad = gz_sensor;
  frame->gz_rad = -gy_sensor;

  return true;
}

// ============================================================================
// SENSOR HEALTH CHECK: Call periodically (every 1-2 seconds)
// ============================================================================
bool ICM20649_Research::checkSensorHealth()
{
  uint8_t pwrMgmt1 = readRegister(BANK0, REG_PWR_MGMT_1);

  if (pwrMgmt1 & BIT_SLEEP)
  {
    Serial.println("[ICM20649] Health check: Sensor in SLEEP mode, waking...");

    // Wake sequence
    writeRegister(BANK0, REG_PWR_MGMT_1, BIT_DEVICE_RESET);
    delay(100);
    writeRegister(BANK0, REG_PWR_MGMT_1, BIT_CLKSEL_AUTO);
    delay(50);

    // Verify
    pwrMgmt1 = readRegister(BANK0, REG_PWR_MGMT_1);
    if (!(pwrMgmt1 & BIT_SLEEP))
    {
      Serial.println("[ICM20649] Health check: Wake SUCCESS");
      configurePhysics(RANGE_8G, RANGE_1000DPS, DLPF_119HZ);
      return false; // Wake was needed
    }
    else
    {
      Serial.println("[ICM20649] Health check: Wake FAILED");
      return false;
    }
  }

  return true; // Sensor healthy
}

// ============================================================================
// BATCH READ: Read multiple frames in single I2C transaction
// ============================================================================
// This dramatically reduces I2C overhead for high sample rates.
// Instead of 4 separate readFrame() calls (4 × ~200µs = 800µs),
// we do 1 batch read (~300µs) saving ~500µs per frame.
//
// The ICM20649 FIFO accumulates samples at the ODR rate. We read
// them all in one burst, process, and return.
// ============================================================================
uint8_t ICM20649_Research::readFrameBatch(IMUFrame *frames, uint8_t maxFrames)
{
  // Limit to reasonable batch size (FIFO can hold ~42 frames)
  if (maxFrames > 10)
    maxFrames = 10;
  if (maxFrames == 0)
    return 0;

  // Check FIFO count first
  uint16_t fifoBytes = getFIFOCount();
  uint8_t framesAvailable = fifoBytes / 12; // 12 bytes per frame (6 accel + 6 gyro)

  if (framesAvailable == 0)
  {
    return 0; // No data available
  }

  uint8_t framesToRead = (framesAvailable < maxFrames) ? framesAvailable : maxFrames;
  uint16_t bytesToRead = framesToRead * 12;

  // Read all frames in one FIFO burst (max 120 bytes for 10 frames)
  uint8_t rawBuffer[120]; // 10 frames × 12 bytes

  // FIFO read: Read multiple samples from FIFO_R_W register
  selectBank(BANK0);

  _wire->beginTransmission(_addr);
  _wire->write(REG_FIFO_R_W);
  if (_wire->endTransmission(false) != 0)
  {
    return 0; // I2C error
  }

  uint16_t bytesReceived = _wire->requestFrom(_addr, bytesToRead);
  if (bytesReceived != bytesToRead)
  {
    return 0; // Incomplete read
  }

  for (uint16_t i = 0; i < bytesToRead; i++)
  {
    rawBuffer[i] = _wire->read();
  }

  // Get temperature once (shared across all frames in batch)
  uint8_t tRaw[2] = {0};
  readRegisterBlock(BANK0, REG_TEMP_OUT_H, tRaw, 2);
  int16_t tempRaw = (int16_t)((tRaw[0] << 8) | tRaw[1]);
  float temp_c = (tempRaw / 333.87f) + 21.0f;

  // Get base timestamp, each frame gets offset by sample period
  uint32_t baseTimestamp = micros();
  // At 375Hz ODR, each sample is ~2667µs apart
  // But for FIFO batches, samples are evenly spaced
  uint32_t samplePeriodUs = 2667; // 375Hz

  // Process each frame
  for (uint8_t f = 0; f < framesToRead; f++)
  {
    uint8_t *raw = &rawBuffer[f * 12];
    IMUFrame *frame = &frames[f];

    frame->accelX = (int16_t)((raw[0] << 8) | raw[1]);
    frame->accelY = (int16_t)((raw[2] << 8) | raw[3]);
    frame->accelZ = (int16_t)((raw[4] << 8) | raw[5]);
    frame->gyroX = (int16_t)((raw[6] << 8) | raw[7]);
    frame->gyroY = (int16_t)((raw[8] << 8) | raw[9]);
    frame->gyroZ = (int16_t)((raw[10] << 8) | raw[11]);

    frame->tempRaw = tempRaw;
    frame->temp_c = temp_c;

    // Timestamp: Oldest sample first (FIFO order)
    // Subtract time for samples read BEFORE this one
    frame->timestampMicros = baseTimestamp - ((framesToRead - 1 - f) * samplePeriodUs);

    // Apply coordinate transform and scaling
    float ax_sensor = frame->accelX * _accelScale;
    float ay_sensor = frame->accelY * _accelScale;
    float az_sensor = frame->accelZ * _accelScale;

    // Transform: [X, Z, -Y]
    frame->ax_g = ax_sensor;
    frame->ay_g = az_sensor;
    frame->az_g = -ay_sensor;

    float gx_sensor = frame->gyroX * _gyroScale;
    float gy_sensor = frame->gyroY * _gyroScale;
    float gz_sensor = frame->gyroZ * _gyroScale;

    // Temp compensation
    float tempDelta = temp_c - _tempRef;
    gx_sensor -= (_tempSlope[0] * tempDelta);
    gy_sensor -= (_tempSlope[1] * tempDelta);
    gz_sensor -= (_tempSlope[2] * tempDelta);

    // Transform: [X, Z, -Y]
    frame->gx_rad = gx_sensor;
    frame->gy_rad = gz_sensor;
    frame->gz_rad = -gy_sensor;
  }

  return framesToRead;
}

void ICM20649_Research::setTempCalibration(float sX, float sY, float sZ,
                                           float tRef)
{
  _tempSlope[0] = sX;
  _tempSlope[1] = sY;
  _tempSlope[2] = sZ;
  _tempRef = tRef;
}

void ICM20649_Research::setGyroOffset(int16_t offsetX, int16_t offsetY,
                                      int16_t offsetZ)
{
  // Write to Bank 2 gyro offset registers for hardware-level bias cancellation
  // These registers subtract the offset from the raw ADC value inside the
  // sensor

  writeRegister(BANK2, REG_XG_OFFS_USRH, (offsetX >> 8) & 0xFF);
  writeRegister(BANK2, REG_XG_OFFS_USRL, offsetX & 0xFF);

  writeRegister(BANK2, REG_YG_OFFS_USRH, (offsetY >> 8) & 0xFF);
  writeRegister(BANK2, REG_YG_OFFS_USRL, offsetY & 0xFF);

  writeRegister(BANK2, REG_ZG_OFFS_USRH, (offsetZ >> 8) & 0xFF);
  writeRegister(BANK2, REG_ZG_OFFS_USRL, offsetZ & 0xFF);

  // Switch back to Bank 0 for normal operation
  selectBank(BANK0);

  Serial.printf("[ICM20649] Hardware gyro offset set: X=%d Y=%d Z=%d LSB\n",
                offsetX, offsetY, offsetZ);
}

void ICM20649_Research::setAccelOffset(int16_t offsetX, int16_t offsetY,
                                       int16_t offsetZ)
{
  // Write to Bank 1 accel offset registers for hardware-level bias cancellation
  // These registers subtract the offset from the raw ADC value inside the
  // sensor

  writeRegister(BANK1, REG_XA_OFFS_H, (offsetX >> 8) & 0xFF);
  writeRegister(BANK1, REG_XA_OFFS_L, offsetX & 0xFF);

  writeRegister(BANK1, REG_YA_OFFS_H, (offsetY >> 8) & 0xFF);
  writeRegister(BANK1, REG_YA_OFFS_L, offsetY & 0xFF);

  writeRegister(BANK1, REG_ZA_OFFS_H, (offsetZ >> 8) & 0xFF);
  writeRegister(BANK1, REG_ZA_OFFS_L, offsetZ & 0xFF);

  // Switch back to Bank 0 for normal operation
  selectBank(BANK0);

  Serial.printf("[ICM20649] Hardware accel offset set: X=%d Y=%d Z=%d LSB\n",
                offsetX, offsetY, offsetZ);
}

// ============================================================================
// LOW LEVEL (Bank Switching)
// ============================================================================

void ICM20649_Research::selectBank(uint8_t bank)
{
  if (_currentBank != bank)
  {
    _wire->beginTransmission(_addr);
    _wire->write(REG_BANK_SEL);
    _wire->write(bank << 4); // Bank is in bits [5:4] usually?
    // Wait, ICM-20649 DS says bits [5:4] of user Bank Sel
    // Let's verify datasheet. REG_BANK_SEL (0x7F)
    // bit 5:4 = USER_BANK[1:0]
    _wire->endTransmission();
    _currentBank = bank;
  }
}

void ICM20649_Research::writeRegister(uint8_t bank, uint8_t reg,
                                      uint8_t value)
{
  // Robust write with retry and verification
  for (int attempt = 0; attempt < 3; attempt++)
  {
    selectBank(bank);
    _wire->beginTransmission(_addr);
    _wire->write(reg);
    _wire->write(value);
    uint8_t err = _wire->endTransmission();

    if (err != 0)
    {
      Serial.printf("[ICM20649] I2C WRITE ERROR: reg=0x%02X, err=%d, attempt=%d\n", reg, err, attempt + 1);
      delay(5); // Brief pause before retry
      continue;
    }

    // Skip verification for self-clearing bits (DEVICE_RESET)
    // When DEVICE_RESET (0x80) is written, the device resets and the bit clears
    if (reg == REG_PWR_MGMT_1 && (value & BIT_DEVICE_RESET))
    {
      delay(100); // Wait for reset to complete
      return;     // Don't verify - reset bit self-clears
    }

    // Verify critical registers (PWR_MGMT_1, config registers in other banks)
    if (reg == REG_PWR_MGMT_1 || bank != BANK0)
    {
      delay(2); // Allow register to settle
      uint8_t readback = readRegister(bank, reg);
      if (readback != value)
      {
        Serial.printf("[ICM20649] WRITE VERIFY FAILED: reg=0x%02X wrote=0x%02X read=0x%02X attempt=%d\n",
                      reg, value, readback, attempt + 1);
        delay(10);
        continue;
      }
    }

    return; // Success
  }
  Serial.printf("[ICM20649] WRITE FAILED AFTER 3 ATTEMPTS: bank=%d reg=0x%02X value=0x%02X\n", bank, reg, value);
}

uint8_t ICM20649_Research::readRegister(uint8_t bank, uint8_t reg)
{
  selectBank(bank);
  _wire->beginTransmission(_addr);
  _wire->write(reg);
  _wire->endTransmission(false); // Restart

  _wire->requestFrom(_addr, (uint8_t)1);
  if (_wire->available())
  {
    return _wire->read();
  }
  return 0;
}

uint8_t ICM20649_Research::readRegisterBlock(uint8_t bank, uint8_t reg,
                                             uint8_t *buffer, uint8_t len)
{
  selectBank(bank);
  _wire->beginTransmission(_addr);
  _wire->write(reg);
  uint8_t err = _wire->endTransmission(false);
  if (err != 0)
  {
    Serial.printf("[ICM20649] I2C TX error: %d\n", err);
    return 0;
  }

  uint8_t received = _wire->requestFrom(_addr, len);
  if (received != len)
  {
    Serial.printf("[ICM20649] I2C RX error: expected %d, got %d\n", len, received);
  }

  uint8_t count = 0;
  for (uint8_t i = 0; i < len; i++)
  {
    if (_wire->available())
    {
      buffer[i] = _wire->read();
      count++;
    }
    else
    {
      buffer[i] = 0; // Explicitly zero missing bytes
    }
  }
  return count;
}

void ICM20649_Research::setAccelRange(AccelRange range, DLPFBandwidth bw)
{
  uint8_t accelConfig = (bw << 3) | range | 1;
  writeRegister(BANK2, REG_ACCEL_CONFIG_1, accelConfig);

  float fs_g = 0;
  switch (range)
  {
  case RANGE_4G:
    fs_g = 4.0f;
    break;
  case RANGE_8G:
    fs_g = 8.0f;
    break;
  case RANGE_16G:
    fs_g = 16.0f;
    break;
  case RANGE_30G:
    fs_g = 30.0f;
    break;
  }
  _accelScale = fs_g / 32767.0f;
}

void ICM20649_Research::setGyroRange(GyroRange range, DLPFBandwidth bw)
{
  uint8_t gyroConfig = (bw << 3) | range | 1;
  writeRegister(BANK2, REG_GYRO_CONFIG_1, gyroConfig);

  float fs_dps = 0;
  switch (range)
  {
  case RANGE_500DPS:
    fs_dps = 500.0f;
    break;
  case RANGE_1000DPS:
    fs_dps = 1000.0f;
    break;
  case RANGE_2000DPS:
    fs_dps = 2000.0f;
    break;
  case RANGE_4000DPS:
    fs_dps = 4000.0f;
    break;
  }
  _gyroScale = (fs_dps / 32767.0f) * (3.14159f / 180.0f);
}
