# Xsens DOT (Movella) Integration Research + Implementation Notes

Date: 2026-02-16
Scope: Dedicated isolated `Xsens` tab for direct BLE connection, sync control, data collection, and raw export.

## 1) Sources reviewed

- Movella/Xsens product page for DOT and SDK capabilities
  - https://www.movella.com/products/wearables/movella-dot
- Xsens software documentation landing
  - https://www.xsens.com/support/software-documentation
- Archived official example server (Node + BLE)
  - https://github.com/xsens/xsens_dot_server

## 2) Confirmed capabilities from official materials

From official Xsens DOT materials and archived server:
- BLE connectivity to one or multiple DOT sensors.
- Measurement modes used by Xsens tooling:
  - `16` Complete (Euler)
  - `2` Extended (Quaternion)
  - `20` Rate quantities (with mag)
  - `22` Custom mode 1
  - `23` Custom mode 2
  - `24` Custom mode 3
- Heading reset / revert commands are supported.
- Sync workflow is supported in DOT tooling (archived server uses a recording-control command frame).
- Data logging/export patterns are CSV-like in the archived server.

## 3) BLE protocol details extracted from archived official server

From `xsens/xsens_dot_server` `bleHandler.js` and related files:

Characteristic UUIDs used by official server code:
- Control: `15172001494711e98646d663bd873d93`
- Measurement medium payload notify: `15172003494711e98646d663bd873d93`
- Orientation reset control: `15172006494711e98646d663bd873d93`
- Recording control: `15177001494711e98646d663bd873d93`
- Recording ACK: `15177002494711e98646d663bd873d93`

Control command structure observed:
- Enable streaming: `[0x01, 0x01, measuringPayloadId]`
- Disable streaming: `[0x01, 0x00, measuringPayloadId]`

Heading control observed:
- Reset heading: `[0x01, 0x00]`
- Revert heading: `[0x07, 0x00]`

Sync command frame observed (recording control char):
- MID: `0x02`
- LEN: `0x07`
- Sync command ID: `0x01`
- Root address bytes (reversed MAC order)
- Checksum: `0xFF & (-sum(bytes))`

## 4) Payload parsing model implemented

Per mode parser aligned to archived official server offsets:

- Complete (Euler) `16`
  - `timestamp` u32 LE @0
  - Euler xyz f32 @4,8,12
  - FreeAcc xyz f32 @16,20,24

- Extended (Quaternion) `2`
  - `timestamp` u32 LE @0
  - Quaternion wxyz f32 @4,8,12,16
  - FreeAcc xyz f32 @20,24,28
  - Status i16 @32
  - Clip acc i8 @34
  - Clip gyr i8 @35

- Rate quantities (with mag) `20`
  - `timestamp` u32 LE @0
  - Acc xyz f32 @4,8,12
  - Gyr xyz f32 @16,20,24
  - Mag xyz i16 @28,30,32 scaled by `2^12`

- Custom mode 1 `22`
  - Euler xyz f32 @4
  - FreeAcc xyz f32 @16
  - Gyr xyz f32 @28

- Custom mode 2 `23`
  - Euler xyz f32 @4
  - FreeAcc xyz f32 @16
  - Mag xyz i16 @28 scaled by `2^12`

- Custom mode 3 `24`
  - Quaternion wxyz f32 @4
  - Gyr xyz f32 @20

## 5) Web Bluetooth constraints (important)

A key limitation for browser-only direct BLE:
- Web Bluetooth does **not** expose BLE MAC addresses directly in normal browser contexts.
- The archived hardware sync command expects a root MAC address payload.

Result:
- This implementation supports direct BLE connect/stream/control/export now.
- Hardware sync command UI is included, but requires user-supplied root MAC.
- Software-aligned timestamp sync option is enabled to maintain practical alignment in browser-only usage.

## 6) What was implemented in this repo

Isolated feature additions (no existing flow rewrites):
- New tab: `Xsens` in left navigation rail.
- New isolated panel: `src/components/layout/panels/XsensPanel.tsx`
- New isolated service + protocol layer:
  - `src/xsens/constants.ts`
  - `src/xsens/types.ts`
  - `src/xsens/XsensDotService.ts`

Supported in panel:
- Connect / disconnect DOT over BLE
- Mode selection (6 modes)
- Start / stop stream
- Heading reset / revert
- Optional hardware sync command + ACK read
- Software sync timestamp baseline option
- Raw sample export to JSON and CSV
- Live payload preview

## 7) Next recommended hardening steps

1. Pull latest official DOT BLE spec PDF and verify service/characteristic UUIDs and offsets against current firmware.
2. Add multi-sensor management in `XsensDotService` (current implementation is single active sensor instance).
3. Add packet integrity checks and out-of-order timestamp handling for long sessions.
4. Add persistence target (Dexie/session tables) if raw streams should be stored in app DB in addition to file export.
5. Add capability probes by firmware version for optional features (sync/heading/recording ACK behavior).
