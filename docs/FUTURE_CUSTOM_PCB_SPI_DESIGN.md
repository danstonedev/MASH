# Future Feature: Custom PCB with SPI Sensor Bus

> **Status:** Planned — Not started  
> **Date:** 2026-02-24  
> **Priority:** Post-prototype (after breakout board validation)  
> **Depends on:** Finalized sensor placement map, TDMA v2 stability

---

## Summary

Replace the current I2C + TCA9548A multiplexer sensor bus with direct SPI wiring on a custom PCB. This eliminates the mux IC, reduces per-sensor read latency by ~5×, and unlocks 400Hz+ sampling for research-grade biomechanics capture.

---

## Motivation

The current architecture uses I2C at 400kHz with a TCA9548A mux to address multiple identical IMUs (ICM-20649). This was the correct choice for breakout-board prototyping — only 2 wires, minimal soldering, one mux chip handles 8 channels. However, I2C has inherent limitations that a custom PCB can bypass:

1. **Mux switching overhead:** ~100µs per channel change × 5 sensors = 500µs wasted per cycle
2. **Bus speed ceiling:** 400kHz (Fast Mode) limits single-sensor reads to ~500µs
3. **Address conflicts:** ICM-20649 only offers 2 I2C addresses (AD0 high/low), forcing the mux
4. **Bus arbitration jitter:** Shared bus means non-deterministic timing under contention

---

## Design

### Sensor Bus: I2C → SPI

| Parameter | Current (I2C + mux) | Custom PCB (SPI) |
|:---|:---|:---|
| Protocol | I2C 400kHz | SPI 7MHz (ICM-20649 max) |
| Addressing | TCA9548A mux channels | GPIO chip-select per sensor |
| Read time / sensor | ~500µs | ~100µs |
| 5 sensors / cycle | 2500–3000µs | ~500µs |
| Components / node | ESP32-S3 + TCA9548A + sensors | ESP32-S3 + sensors (no mux) |
| Max sample rate | 200Hz (2.5ms headroom in 5ms) | **400Hz+ (2ms headroom in 2.5ms)** |

### Pin Budget (ESP32-S3, 5 sensors per node)

```
SPI shared signals:     3 pins  (MOSI, MISO, CLK)
Chip selects:           5 pins  (CS0–CS4, one per IMU)
Total:                  8 GPIO pins

ESP32-S3 available:     ~36 usable GPIO
Remaining after SPI:    ~28 (plenty for I2C mag, LEDs, etc.)
```

### PCB Trace Layout

```
┌──────────┐  SPI bus (shared MOSI/MISO/CLK)
│ ESP32-S3 │──────────────────────────────────────────────┐
│  GPIO 5  │─CS0──┤ ICM-20649 #0 │                       │
│  GPIO 6  │─CS1──┤ ICM-20649 #1 │                       │
│  GPIO 7  │─CS2──┤ ICM-20649 #2 │                       │
│  GPIO 8  │─CS3──┤ ICM-20649 #3 │                       │
│  GPIO 9  │─CS4──┤ ICM-20649 #4 │                       │
│          │                                               │
│  SDA/SCL │──I2C──┤ MMC5603 magnetometer (unchanged) │   │
└──────────┘                                               │
```

> **Note:** The MMC5603 magnetometer remains on I2C — it's a single device with a unique address, no mux needed.

---

## Sampling Rate Unlock: 400Hz

| Rate | Cycle budget | SPI read (5 sensors) | Headroom | I2C feasible? |
|:---:|:---:|:---:|:---:|:---:|
| 200Hz | 5000µs | 500µs | 4500µs | Yes (current) |
| 400Hz | 2500µs | 500µs | 2000µs | **No** (I2C needs 2500–3000µs) |
| 500Hz | 2000µs | 500µs | 1500µs | No |

### TDMA Impact at 400Hz

At 400Hz with `TDMA_SAMPLES_PER_FRAME = 8` (batch 8 samples at 50Hz TX):

```
Payload: 8 + (8 × 5 × 25) + 1 = 1009 bytes  (still under 1470B ESP-NOW v2 limit)
Slot width: max(2500, 1500 + airtime(1009B)) ≈ 2960µs
```

3-node (5+5+5) frame at 400Hz: `3000 + 3×2960 + 2×100 + 0 = 12,080µs` → fits in 20ms with 40% headroom.

---

## Firmware Changes Required

### SensorManager.cpp — Scope: ~200–300 lines

1. **Init path:** Replace `Wire.begin()` + mux probe with `SPI.begin()` + CS pin setup
2. **Read path:** Replace `Wire.beginTransmission()` / `Wire.requestFrom()` with `SPI.beginTransaction()` / `digitalWrite(CS, LOW)` / `SPI.transfer()` / `digitalWrite(CS, HIGH)`
3. **Remove:** `selectMuxChannel()`, `TCA9548A_ADDRESS`, mux probe logic
4. **Add:** CS pin array, `selectSensor(uint8_t index)` via GPIO

### SensorManager.h — Scope: ~20 lines

1. Replace `sensorChannels[]` (mux channels) with `csPins[]` (GPIO numbers)
2. Remove `useMultiplexer` flag
3. Add SPI configuration constants

### Config.h / SharedConfig.h — Scope: ~10 lines

1. Add `SPI_CS_PINS[]` definition per node variant
2. Remove `PROBE_FOR_MULTIPLEXER` (or gate behind `#ifdef USE_I2C_MUX`)

### Webapp — Scope: Minimal

1. Remove `useMux` field from `DeviceInterface.ts` (or ignore it)
2. Status display may need updating (no mux channel info)

### Files NOT affected

- `SyncManager.cpp` — no sensor bus dependency
- `TDMAProtocol.h` — slot formula is sensor-count-based, bus-agnostic
- All webapp data pipeline code — packet format is identical

---

## BOM Comparison (Per Node)

| Component | I2C + Mux | Custom PCB SPI |
|:---|:---|:---|
| ESP32-S3 module | 1 | 1 |
| TCA9548A mux | 1 | **0** |
| ICM-20649 IMU | 5 | 5 |
| MMC5603 magnetometer | 1 | 1 |
| Pull-up resistors (I2C) | 2 | **0** (SPI needs none) |
| Decoupling caps | 8 | 7 (one fewer for mux) |
| **Total ICs** | **8** | **7** |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|:---|:---|:---|
| SPI trace length on body-worn PCB | Signal integrity at 7MHz over flex cable | Keep traces < 10cm; reduce to 4MHz if needed (still 2× faster than I2C) |
| GPIO pin conflicts with other peripherals | Can't assign CS pins | Map pins early; ESP32-S3 has 36+ GPIO — not a real constraint |
| Firmware regression during SensorManager rewrite | Broken sensor reads | Keep I2C path behind `#ifdef USE_I2C_MUX` for fallback; write SPI path as parallel implementation |
| ICM-20649 SPI mode compatibility | Incorrect CPOL/CPHA | ICM-20649 uses SPI Mode 0 (CPOL=0, CPHA=0) — standard, well-documented |

---

## Implementation Order

1. **Validate sensor placement** on body → finalize how many sensors per node
2. **Design schematic** with ESP32-S3 + 5× ICM-20649 SPI + 1× MMC5603 I2C
3. **Route PCB** — keep SPI traces short, star topology from ESP32 to each sensor
4. **Firmware: Add SPI SensorManager** behind compile flag — keep I2C path for breakout boards
5. **Test at 200Hz first** — verify data matches I2C path exactly
6. **Increase to 400Hz** — update `TDMA_SAMPLES_PER_FRAME` from 4→8, validate frame budget
7. **Remove I2C mux code** once custom PCB is validated

---

## References

- ICM-20649 datasheet: SPI interface, Section 7.1 (Mode 0, max 7MHz)
- ESP32-S3 Technical Reference: SPI peripheral, Chapter 26
- TDMAProtocol.h: `calculateSlotWidth()` — bus-agnostic, auto-scales with payload size
- Current mux implementation: `SensorManager.cpp::selectMuxChannel()`, `SharedConfig.h::PROBE_FOR_MULTIPLEXER`
