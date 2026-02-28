# Xsens Feature Troubleshooting (Dedicated Tab)

This guide maps each implemented Xsens feature to failure symptoms, root causes, and checks.

## 1) Connect (BLE)

### What should happen
- `Connect` opens browser BLE picker filtered by `Xsens DOT` name prefix.
- After selection, status changes to `Connected`.

### Common failures
- **`Web Bluetooth unsupported in this browser`**
  - Cause: Browser/runtime does not expose `navigator.bluetooth`.
  - Fix: Use Chrome/Edge desktop over HTTPS/localhost.
- **No DOT appears in picker**
  - Cause: Sensor not advertising / low battery / already connected to another host.
  - Fix: Ensure DOT is on, not connected elsewhere, and close phone apps that may hold BLE lock.
- **Connected then instant disconnect**
  - Cause: GATT instability, power management, RF interference.
  - Fix: Keep sensor near adapter, disable aggressive BT power savings, reconnect.

## 2) Start/Stop Streaming

### What should happen
- `Start` subscribes measurement notifications and writes control command `[0x01, 0x01, mode]`.
- `Stop` writes `[0x01, 0x00, mode]` and unsubscribes notifications.

### Common failures
- **Start does nothing**
  - Cause: Missing control/measurement characteristic discovery.
  - Fix: Verify firmware/UUID compatibility and reconnect.
- **Stream starts then no samples increment**
  - Cause: Notifications not arriving for selected mode.
  - Fix: Switch mode to `Extended (Quaternion)` and retry.

## 3) Measurement Mode Selection

### What should happen
Modes supported in UI/service:
- 16 Complete (Euler)
- 2 Extended (Quaternion)
- 20 Rate quantities (with mag)
- 22 Custom mode 1
- 23 Custom mode 2
- 24 Custom mode 3

### Common failures
- **Payload preview empty `{}`**
  - Cause: Packet shorter than expected for selected mode.
  - Fix: Confirm mode/firmware pairing; try `Extended (Quaternion)` first.

## 4) Heading Reset / Revert

### What should happen
- Writes to orientation reset characteristic:
  - Reset: `[0x01, 0x00]`
  - Revert: `[0x07, 0x00]`

### Common failures
- **Heading command fails**
  - Cause: Orientation characteristic unavailable on current firmware/mode.
  - Fix: reconnect, use orientation mode, verify sensor capability.

## 5) Hardware Sync + ACK

### What should happen
- `Send Sync Command` builds sync frame to recording control char with checksum.
- `Read ACK` reads recording ACK char and displays hex.

### Critical limitation
- Browser Web Bluetooth does not expose BLE MAC addresses directly.
- Hardware sync root address is therefore user-supplied in this implementation.

### Common failures
- **Invalid MAC error**
  - Cause: Input not `AA:BB:CC:DD:EE:FF` hex format.
  - Fix: Enter full 6-byte uppercase/lowercase hex pairs.
- **ACK read unavailable**
  - Cause: Recording ACK characteristic not present for device/firmware.
  - Fix: Use latest DOT firmware and reconnect.

## 6) Raw Export (JSON/CSV)

### What should happen
- JSON exports metadata + full sample array.
- CSV exports flattened payload with dynamic payload headers.

### Common failures
- **No samples available to export**
  - Cause: Stream not started or notifications not arriving.
  - Fix: Start stream and verify sample count increments.

## 7) Validation checklist per release

1. Connect + disconnect works twice in a row.
2. Start/stop streaming in each of 6 modes.
3. At least one sample arrives and payload preview updates.
4. Heading reset/revert commands complete without error.
5. Hardware sync command rejects malformed MAC and accepts valid MAC.
6. ACK read returns hex when characteristic available.
7. JSON and CSV export produce downloadable files with sample rows.

## 8) Automated tests added

- `src/xsens/XsensDotService.test.ts`
  - Connect/disconnect snapshot
  - Start/stop command bytes
  - Heading command bytes
  - Hardware sync frame + validation
  - ACK read formatting
  - Extended quaternion payload parse
  - Safe handling of short payloads

If tests report `No test suite found`, that issue is currently global in this workspace test runner and also reproduces on existing test files; fix the runner first, then re-run Xsens tests.
