# Firmware Tasks — V1 Multi-Node

## Purpose
Define the firmware responsibilities for each node in the full-body suit.

---

## Common Tasks (All Nodes)

| Task | Frequency | Description |
|------|-----------|-------------|
| IMU Sampling | 120 Hz | Read accel + gyro from all connected IMUs |
| Madgwick Fusion | 120 Hz | Compute quaternion from accel/gyro |
| Timestamping | Per sample | Apply synchronized time to each sample |
| ZUPT Detection | Per sample | Zero velocity update when stationary |
| ESP-NOW Transmit | 60 Hz | Send fused data in TDMA slot |
| BLE/WiFi Transmit | 60 Hz | Direct streaming (single-node mode) |
| Command Processing | On receive | Parse and execute JSON commands |

---

## Node-Specific Tasks

### Node A — Upper Body (Hub)

**Additional Hardware:**
- TCA9548A I2C multiplexer (channels 0-4)
- MMC5603 magnetometer
- BMP390 barometer

**Additional Tasks:**
| Task | Frequency | Description |
|------|-----------|-------------|
| Mux Channel Select | Before each read | Select correct I2C channel |
| Magnetometer Read | 10 Hz | Read heading for yaw correction |
| Barometer Read | 20 Hz | Read altitude for jump detection |
| Sync Beacon Broadcast | 20 Hz | Send time sync to slave nodes |
| Heading Fusion | 10 Hz | Apply mag correction to quaternion |

**Sensor Mapping:**
| Mux Channel | Segment | Mixamo Bone |
|-------------|---------|-------------|
| 0 | torso | mixamorigSpine2 |
| 1 | upper_arm_l | mixamorigLeftArm |
| 2 | upper_arm_r | mixamorigRightArm |
| 3 | forearm_l | mixamorigLeftForeArm |
| 4 | forearm_r | mixamorigRightForeArm |

---

### Node B — Lower Body (Slave)

**Additional Hardware:**
- TCA9548A I2C multiplexer (channels 0-4)

**Sensor Mapping:**
| Mux Channel | Segment | Mixamo Bone |
|-------------|---------|-------------|
| 0 | pelvis | mixamorigHips |
| 1 | thigh_l | mixamorigLeftUpLeg |
| 2 | thigh_r | mixamorigRightUpLeg |
| 3 | shank_l | mixamorigLeftLeg |
| 4 | shank_r | mixamorigRightLeg |

---

### Node C — Left Boot (Slave)

**Single IMU Mode** (no multiplexer)

| Segment | Mixamo Bone |
|---------|-------------|
| foot_l | mixamorigLeftFoot |

---

### Node D — Right Boot (Slave)

**Single IMU Mode** (no multiplexer)

| Segment | Mixamo Bone |
|---------|-------------|
| foot_r | mixamorigRightFoot |

---

## Firmware Configuration

### Config.h Key Settings

```cpp
// Hardware
#define MAX_SENSORS 8
#define USE_MULTIPLEXER true
#define TCA9548A_ADDRESS 0x70

// Sampling
#define DEFAULT_SAMPLE_RATE_HZ 120
#define DEFAULT_ACCEL_RANGE_G 16
#define DEFAULT_GYRO_RANGE_DPS 2000

// Fusion
#define FILTER_BETA 0.1f  // Madgwick gain

// BLE
#define BLE_DEVICE_NAME "IMU-Connect"
#define BLE_MTU_SIZE 512
```

---

## ZUPT (Zero Velocity Update) Parameters

```cpp
// SensorManager.cpp
const float GYRO_STATIONARY_THRESH = 0.05f;  // rad/s
const float ACCEL_STATIONARY_THRESH = 0.2f;  // deviation from 1g
const int MIN_STATIONARY_FRAMES = 10;
```

When stationary:
- Gyro inputs are forced to zero
- Prevents yaw drift accumulation
- Filter still uses accel for gravity alignment

---

## Calibration Tasks

| Action | Storage | Trigger |
|--------|---------|---------|
| Accel offset | NVS | CALIBRATE command |
| Gyro offset | NVS | CALIBRATE command |
| Load on boot | NVS → RAM | setup() |
| Auto-save | RAM → NVS | After calibration |

---

## LED Status Indicators

| Color | Meaning |
|-------|---------|
| 🔴 Red | Error (no sensors found) |
| 🟡 Yellow | Initializing |
| 🔵 Blue | Ready, waiting for connection |
| 🟢 Green | Streaming data |
| 🟣 Purple | Calibrating (future) |

---

## Power Management (Future)

| State | Current | Wake Condition |
|-------|---------|----------------|
| Active | ~100mA | — |
| Idle | ~50mA | BLE connection |
| Sleep | ~10μA | Button press / BLE advert |
