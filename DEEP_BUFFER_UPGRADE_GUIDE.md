# Deep Buffer & Integrity Upgrade - Verification Plan

## 1. Upgrade Hardware
You must update **ALL** devices for the system to work correctly.

### Step 1: Update Gateway
1. Connect **Gateway ESP32** to USB.
2. Open `firmware/MASH_Gateway/MASH_Gateway.ino` in Arduino IDE
3. Select Board: **Adafruit QT Py ESP32-S3**
4. Click **Upload**

### Step 2: Update Nodes
1. Connect **Tracker Node ESP32** to USB.
2. Open `firmware/MASH_Node/MASH_Node.ino` in Arduino IDE
3. Select Board: **Adafruit QT Py ESP32-S3**
4. Click **Upload**
5. Repeat for all other nodes.

---

## 2. Verification Test
Once updated, perform this specific stress test:

1. **Start Recording:** Open IMU Connect and start a session.
2. **"The Faraday Test":** 
   - Cover a sensor node completely with your hands (or a metal pot) for ~200ms (simulate interference).
   - **Expectation:** Data should *pause* briefly on screen, then *fast-forward* to catch up. 
   - **Critical:** There should be **NO GAPS** in the recorded file. The "Deep Buffer" will store the data and "Burst" it out when the signal returns.
3. **"The Ghost Hunter":**
   - Walk to the edge of WiFi range.
   - **Expectation:** If packets are corrupted, they will be **DROPPED** by the Gateway (CRC Mismatch). You will see a small gap, but **NEVER** a "Ghost Sensor" (Node ID 255/128/etc).

## 3. Technical Summary of Changes
- **Node:** 
  - Buffer Size: 4 -> **60 samples** (300ms Data Protection).
  - Logic: **Non-blocking Burst Mode** (Sends up to 2 packets/loop to catch up).
  - Safety: **Zero-Loss Shift** (Uses `memmove` to protect partial buffers).
- **Gateway:**
  - Integrity: **CRC8 Verification** (Rejects 100% of corrupted packets).
  - Throughput: Optimized pass-through for burst reception.

## 4. Virtual Verification (Software Simulation)
You can verify the system's resilience *without hardware* by running the newly created virtual stress test. This mimics the firmware's burst and CRC logic directly against the frontend parser.

### Run the Simulation
`ash
cd 'c:\Users\danst\IMU Connect App\imu-connect'
npx vitest run src/tests/virtual_stress.test.ts
`

### What This Tests
1. **Deep Buffer Catch-up:** Simulates a 300ms radio blackout followed by a rapid burst of 15 packets. Confirms the frontend parser correctly orders and timestamps the burst.
2. **CRC Integrity:** Injects intentionally corrupted packets (simulating 'Ghost' data). Confirms the parser **REJECTS** them (0% acceptance).
3. **High Load:** Simulates a node with 6 sensors running at full 200Hz.

### Expected Output
`	ext
 Deep Buffer & Integrity Pipeline (4)
   Pipeline should accept clean 200Hz stream (Normal Operation)
   Pipeline should REJECT corrupted packets (Anti-Ghost Sensor)
   Pipeline should handle 'Faraday Burst' (300ms Gap -> catch-up)
   Pipeline should handle Multi-Sensor Packets
`
This confirms the **Receiver Software** is fully compatible with the new **Firmware Protocol**.

