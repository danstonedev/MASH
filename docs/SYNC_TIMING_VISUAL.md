# IMU Connect Synchronization - Visual Timing Guide

## The Big Picture (1 Second of Operation)

```
TIME (ms)    0    20    40    60    80   100   120   140   160   180   200
             │     │     │     │     │     │     │     │     │     │     │
GATEWAY      ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼
BEACONS     [B0]  [B1]  [B2]  [B3]  [B4]  [B5]  [B6]  [B7]  [B8]  [B9]  [B10]
             │     │     │     │     │     │     │     │     │     │     │
             │     │     │     │     │     │     │     │     │     │     │
NODE 204    ─●────●────●────●─ ... receives beacons, samples at 200Hz
             │    │    │    │
             S0   S1   S2   S3  (4 samples per beacon frame)
             │    │    │    │
             5ms  5ms  5ms  5ms
             │     │     │     │
NODE 180    ─●────●────●────●─ ... same timing (ideally)
             │    │    │    │
             S0   S1   S2   S3

Legend: [Bn] = Beacon #n, Sn = Sample #n within frame, ● = sample taken
```

---

## TDMA Frame Structure (20ms)

```
One TDMA Frame Period = 20ms = 4 IMU Samples
═══════════════════════════════════════════════════════════════════════════

   │◄────────────────── 20,000 µs (20ms) ──────────────────►│
   │                                                          │
   ┌──────────┬──────────┬──────────┬──────────┐
   │ Sample 0 │ Sample 1 │ Sample 2 │ Sample 3 │
   │  0-5ms   │  5-10ms  │ 10-15ms  │ 15-20ms  │
   └──────────┴──────────┴──────────┴──────────┘
   │          │          │          │          │
   0µs      5000µs    10000µs   15000µs    20000µs
   │
   └─► Beacon arrives here (start of frame)
```

Note: this diagram is the **sampling timeline** (200Hz = 5ms). The **wireless TX schedule** (beacon + node slots + guard time) must also fit inside the same 20ms frame period.

---

## The Timestamp Formula

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   TIMESTAMP = EPOCH + (FRAME × 20000) + (SAMPLE_INDEX × 5000)          │
│                                                                         │
│   Equivalent (what nodes actually do):                                   │
│   ───────────────────────────────────                                   │
│   beaconGatewayTimeUs = EPOCH + (FRAME × 20000)                          │
│   TIMESTAMP = beaconGatewayTimeUs + (SAMPLE_INDEX × 5000)               │
│                                                                         │
│   Example for Frame 50, Sample 2:                                       │
│   ────────────────────────────────                                      │
│   EPOCH = 14265423 µs (set at SYNC_RESET)                              │
│   TIMESTAMP = 14265423 + (50 × 20000) + (2 × 5000)                     │
│             = 14265423 + 1000000 + 10000                                │
│             = 15275423 µs                                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## SYNC_RESET Sequence (The Critical Moment)

```
TIME        │ Gateway          │ Node 204         │ Node 180
────────────┼──────────────────┼──────────────────┼──────────────────
    0 ms    │ triggerReset()   │                  │
            │ epoch = micros() │                  │
            │ frame = 0        │                  │
   20 ms    │ [B0] RESET=1 ────┼──► Receives!     │     (missed)
            │ ts=epoch+0       │ frame=0          │
            │                  │ clear buffers    │
   40 ms    │ [B1] RESET=1 ────┼──────────────────┼──► Receives!
            │ ts=epoch+20000   │ (ignore, in      │ frame=0
            │                  │  reset cycle)    │ clear buffers
   60 ms    │ [B2] RESET=1     │                  │
    ...     │     ...          │                  │
  200 ms    │ [B9] RESET=1     │                  │
            │ RESET complete   │                  │
  220 ms    │ [B10] RESET=0 ───┼──► frame=10      │──► frame=10
            │ ts=epoch+200000  │                  │
            │                  │                  │
            │  ★ ALL NODES NOW SYNCHRONIZED! ★   │
────────────┴──────────────────┴──────────────────┴──────────────────
```

---

## The Problem We Were Fixing (v3 → v7)

### v3 Problem: Packet loss + boundary aliasing → mismatched sample slots

```
SCENARIO: Packet loss after SYNC_RESET ends

Gateway:    [B50]────────[B51]────────[B52]────────[B53]────────[B54]
             │            │            │            │            │
             ts=epoch     ts=epoch     ts=epoch     ts=epoch     ts=epoch
             +1000000     +1020000     +1040000     +1060000     +1080000
             │            │            │            │            │
Node 204:    ●────────────X────────────X────────────●
             received     lost         lost         received
             frame=50                               frame=53
             ts=1000000                             ts=1060000
             │
Node 180:    X────────────●────────────X────────────X
             lost         received     lost         lost
                          frame=51
                          ts=1020000
                          
RESULT: Node 204 at ts=1060000, Node 180 at ts=1020000
        Same physical instant, 40ms timestamp difference!
        SyncFrameBuffer can't match them! → INCOMPLETE FRAMES
```

### v4 Fix: Epoch-based deterministic beacon anchors
Gateway beacons carry `gatewayTimeUs = epoch + frame×20000`, so nodes can anchor sample timestamps to a shared timeline.

### v5 Fix: Sample index rounding (5ms quantization)
Instead of truncating `(timeSinceBeacon / 5000)`, nodes round to nearest sample slot:

`sampleIndex = (timeSinceBeaconRx + 2500) / 5000`

This prevents “boundary aliasing” where two nodes near a 5ms boundary choose different indices.

### v6 Fix: Gateway epoch-based normalization (handles nodes on wrong epoch)
If a node missed SYNC_RESET (or received it late), its raw timestamps can be seconds apart. The gateway can still map samples onto the canonical timeline:

`logicalSlot = (timestampUs - epoch) / 5000` → `normalizedTs = epoch + logicalSlot×5000`

### v7 Fix: Bounded freewheel on missed beacons (node-side)
If a node misses a beacon, it advances `currentFrameNumber`, `beaconGatewayTimeUs`, and `lastBeaconTime` by up to 2 frames (40ms) so:

- transmit windows stay consistent with the frame number
- timestamps stay consistent with the inferred frame

---

## Beacon Loss Behavior (Bounded Freewheel)

```
If the node misses beacons:

        timeSinceBeacon > 20ms?
                missedFrames = timeSinceBeacon / 20ms
                if missedFrames <= 2:
                        currentFrameNumber += missedFrames
                        beaconGatewayTimeUs += missedFrames * 20ms
                        lastBeaconTime += missedFrames * 20ms
                        keep sampling/buffering
                else:
                        stop buffering until a fresh beacon re-anchors timing
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              GATEWAY                                     │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐  │
│  │   Beacon   │    │  ESP-NOW   │    │ SyncFrame  │    │    BLE     │  │
│  │  Sender    │    │  Receiver  │    │   Buffer   │    │  Manager   │  │
│  │  (50 Hz)   │    │            │    │            │    │            │  │
│  └─────┬──────┘    └─────┬──────┘    └─────┬──────┘    └─────┬──────┘  │
│        │                 │                 │                 │          │
│        │ Beacons         │ Packets         │ Matched         │ Frames   │
│        ▼                 ▼                 ▼                 ▼          │
└────────┼─────────────────┼─────────────────┼─────────────────┼──────────┘
         │                 │                 │                 │
    ═════╪═════════════════╪═════════════════╪═════════════════╪══════════
         │    WIRELESS     │                 │                 │
    ═════╪═════════════════╪═════════════════╪═════════════════╪══════════
         │                 │                 │                 │
         ▼                 │                 │                 ▼
┌─────────────────────┐    │                 │          ┌─────────────────┐
│      NODE 204       │    │                 │          │    WEB APP      │
│  ┌───────────────┐  │    │                 │          │  ┌───────────┐  │
│  │  IMU Sensor   │──┼────┘                 │          │  │  Avatar   │  │
│  │   (200 Hz)    │  │                      │          │  │  Render   │  │
│  └───────────────┘  │                      │          │  └───────────┘  │
│  ┌───────────────┐  │                      │          │                 │
│  │ SyncManager   │  │                      │          │  timestamp =    │
│  │ ts = epoch +  │  │                      │          │  15275000       │
│  │ frame×20000 + │  │                      └──────────┤  sensors: ALL 7 │
│  │ sample×5000   │  │                                 │  ✓ Matched!     │
│  └───────────────┘  │                                 └─────────────────┘
└─────────────────────┘

┌─────────────────────┐
│      NODE 180       │
│  ┌───────────────┐  │
│  │ 6× IMU Sensors│──┼────► (same flow to Gateway)
│  │   (200 Hz)    │  │
│  └───────────────┘  │
└─────────────────────┘
```

---

## SyncFrameBuffer Slot Matching (v6+)

```
INCOMING SAMPLES (over ~50ms):

  Node 204, ts=15277423, frame=50  ──┐
  Node 180, ts=15278100, frame=51  ──┤  ← Different frame numbers!
  Node 181, ts=15278102, frame=51  ──┤
  Node 182, ts=15278105, frame=51  ──┤
        Node 183, ts=15278108, frame=51  ──┤
        Node 184, ts=15278110, frame=51  ──┤
        Node 185, ts=15278112, frame=51  ──┘

                                                                                                                                                                         ┌───────────────────────────┐
                                                                                                                                                                         │  NORMALIZE TO 5ms SLOTS    │
                                                                                                                                                                         │  slot = (ts - epoch)/5000  │
                                                                                                                                                                         │  normTs = epoch + slot*5000│
                                                                                                                                                                         │  → all become: 15275000    │
                                                                                                                                                                         └───────────┬───────────────┘
                                                                                                                                                                                                                         │
                                                                                                                                                                                                                         ▼
                                                                                                                                                                         ┌───────────────────────────┐
                                                                                                                                                                         │   SLOT: ts=15275000        │
                                                                                                                                                                         │   [✓] Sensor 204           │
                                                                                                                                                                         │   [✓] Sensor 180           │
                                                                                                                                                                         │   [✓] Sensor 181           │
                                                                                                                                                                         │   [✓] Sensor 182           │
                                                                                                                                                                         │   [✓] Sensor 183           │
                                                                                                                                                                         │   [✓] Sensor 184           │
                                                                                                                                                                         │   [✓] Sensor 185           │
                                                                                                                                                                         │   COMPLETE! → Emit         │
                                                                                                                                                                         └───────────────────────────┘
```

---

## Key Numbers to Remember

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Beacon Rate | 50 Hz | 20ms between beacons |
| Sample Rate | 200 Hz | 5ms between samples |
| Samples/Frame | 4 | 200Hz ÷ 50Hz |
| SYNC_RESET Duration | 200ms | 10 beacons |
| Sample Slot | 5000 µs | Node rounds to nearest sample slot |
| Boundary Tolerance | ±2500 µs | Two nodes within this choose same slot |
| Beacon Duration | 500 µs | Airtime budget for beacon |
| First Slot Gap | 500 µs | Safety gap after beacon |
| Guard Time | 2000 µs | End-of-frame buffer for retries/overflow |
| Slot Min Width | 8000 µs | Minimum per-node TX slot budget |
| ESP-NOW Latency | ~200 µs | Typical beacon delivery jitter |

---

## What Success Looks Like

```
[SYNC QUALITY] Completed: 1850, Incomplete: 5, Dropped: 0 (99.7% success)
               Sensors: 7 expected, Keyframes: 1855, Deltas: 0
               Timestamp alignment: PERFECT (all sensors aligned)

[DRIFT] Same-normalized-ts matches: 3500, max_raw_drift=800 us (0.80 ms)
        ^^^ This should be <2500µs with good sync!

[RX RATES] Samples received per sensor (5s window):
  Sensor 204: 1000 samples (200.0 Hz)  ← Target rate!
  Sensor 180: 998 samples (199.6 Hz)
  ...
```

---

## Debugging Checklist

1. **Check SYNC_RESET fired**: Look for `[SYNC] EPOCH RESET: frame=0, epoch=...`
2. **Check both nodes received it**: Look for `[SYNC] Received SYNC_RESET` on each node
3. **Check sample rates**: Should be ~180-200 Hz per sensor
4. **Check normalized drift**: Should be <2500µs
5. **Check sync quality**: Should be >95% completed
