# IMU Connect - Known Limitations

**Last Updated:** 2025-12-22

This document describes known limitations of the IMU Connect system. Understanding these constraints is important for research applications.

---

## Hardware Limitations

### ICM-20649 Sensor

| Parameter | Limit | Impact |
|-----------|-------|--------|
| Gyroscope FSR | ±2000 °/s | Clips during very fast movements (e.g., throwing) |
| Accelerometer FSR | ±30g | Sufficient for most biomechanics (falls, jumps) |
| No magnetometer fusion | 6-DOF only | Yaw drift accumulates over time |

**Yaw Drift Rate:** Approximately 1-5°/hour depending on sensor quality and temperature.

### USB Serial Transport

USB Serial removes the BLE bandwidth ceiling, but throughput still depends on baud rate and host-side processing. At 921600 baud, the Gateway can sustain full SyncFrame rates for multi-sensor sessions in typical workloads.

> Legacy Note: BLE bandwidth limits applied to the previous transport and are no longer the primary bottleneck in MASH.

---

## Algorithm Limitations

### Orientation Estimation

| Issue | Description | Mitigation |
|-------|-------------|------------|
| **Yaw drift** | No absolute heading reference (6-DOF) | Periodic heading tare |
| **High-g blind** | During impacts, filter relies on gyro only | Adaptive gating reduces false tilt |
| **Initial convergence** | Filter needs ~1 second to converge | Wait before recording |

### Euler Angle Decomposition

| Issue | Description | Mitigation |
|-------|-------------|------------|
| **Gimbal lock** | Near ±90° on middle Euler axis | Warning issued in UI |
| **Axis bleed** | Motion on one axis may appear on another | Use correct JCS Euler order |
| **Order dependency** | ZXY vs XYZ give different results | System uses ISB-compliant orders |

---

## Accuracy Expectations

**Important:** These are estimated values. No optical gold-standard validation has been performed yet.

| Metric | Expected Accuracy |
|--------|-------------------|
| Flexion/Extension | ±2-5° |
| Abduction/Adduction | ±3-7° |
| Internal/External Rotation | ±5-10° |
| Angular velocity | ±3% |

### Factors Affecting Accuracy

1. **Sensor mounting** - Loose sensors degrade accuracy significantly
2. **Calibration quality** - Poor T-pose leads to systematic errors
3. **Motion speed** - Very fast motion (>400°/s) may have increased error
4. **Magnetic interference** - Not applicable (6-DOF only)
5. **Temperature** - Gyro bias changes with temperature

---

## Not Yet Validated

The following have not been validated against gold-standard measurement:

- [ ] Absolute angle accuracy
- [ ] Multi-day repeatability
- [ ] Inter-subject reliability
- [ ] Clinical population (e.g., post-surgery ROM)

---

## Known Issues

### Resolved in Current Version
- ✅ Linear integration replaced with manifold integration
- ✅ Adaptive gating for impact rejection
- ✅ ISB-compliant Euler orders for all joints

### Open Issues
- ⚠️ No optical comparison study performed
- ⚠️ No formal error quantification
- ⚠️ Temporal sync assumes ≤100ms packet spread

---

## Recommendations for Research Use

1. **Always report limitations** - State that optical validation pending
2. **Use relative comparisons** - Within-subject pre/post is more reliable than absolute values
3. **Verify calibration** - Use Level 1-4 checks from calibration guide
4. **Check for drift** - Compare start and end of session in identical pose
5. **Include sensor specs** - Report ICM-20649 FSR and sample rate

---

## References

For implementation details, see:
- [conventions.ts](../src/lib/math/conventions.ts) - Coordinate frame definitions
- [so3.ts](../src/lib/math/so3.ts) - SO(3) math implementation
- [jointAngles.ts](../src/biomech/jointAngles.ts) - ISB JCS Euler orders
