# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Critical:** Implemented strict Packet Ordering (Jitter Buffer) to prevent "Time Travel" visual glitches (Audit 1).
- **Critical:** Fixed "Zombie Lockout" regression where Sensor Resets (Frame 5000 -> 0) were permanently blocked by the Jitter Buffer (Audit 2).
- Validated Deep Buffer pipeline with 200Hz Stress Tests (`src/tests/virtual_stress.test.ts`).

## [1.0.0] - 2026-01-10

### Added
- TDMA protocol for synchronized multi-sensor streaming at 200Hz
- Gateway/Node firmware architecture with ESP-NOW communication
- Unified calibration system with T-pose and A-pose support
- Real-time 3D skeleton visualization with glTF model
- Session recording with IndexedDB storage
- Demo mode with pre-generated gait data
- WebR integration for statistical analysis (ICC, SEM/MDC, Bland-Altman)
- Session comparison with effect size calculations
- Export to CSV/JSON formats

### Changed
- Migrated from Madgwick to ESKF sensor fusion
- Replaced WiFi/WebSocket with ESP-NOW for lower latency
- Updated timestamp handling to microsecond precision
- Improved Hz calculation with sample counting window

### Removed
- Legacy standalone firmware (`IMUConnect/`)
- Unused analysis modules (VelocityEstimator, derived.ts)
- Deprecated validation and constraint modules
- Broken test files with outdated API usage

### Fixed
- TDMA timestamp parsing now uses firmware frame numbers
- Sample rate display accurate for batched TDMA arrivals
- Calibration tests updated to use correct T-pose orientations
- Accessibility issues in form controls and buttons
- Tailwind class deprecation warnings

## [0.1.0] - 2025-12-01

### Added
- Initial prototype with BLE connectivity
- Single-sensor motion capture
- Basic 3D visualization

---

[1.0.0]: https://github.com/danstonedev/complete-movement-analysis/releases/tag/v1.0.0
[0.1.0]: https://github.com/danstonedev/complete-movement-analysis/releases/tag/v0.1.0
