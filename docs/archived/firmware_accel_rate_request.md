# 📨 To: Firmware Developer
## Re: Accelerometer Data Update Rate in 0x03 Packets

Hi!

The **0x03 Extended Quaternion** packet format is working great - quaternion and gyro data are smooth at 120Hz. However, I'm seeing a problem with the **accelerometer** data.

### Problem
Accel values appear to "hold" for multiple consecutive packets before changing, creating a stepped/staircase appearance in the telemetry chart. Meanwhile, gyro values change every single packet.

**Console evidence:**
```
Accel: -6.63, 2.41, 7.69   ← Same value
Accel: -6.63, 2.41, 7.69   ← Same value (next packet)
Accel: -6.63, 2.41, 7.69   ← Same value (next packet)
Accel: -6.77, -3.28, -6.22 ← Finally changes
```

### Request
Can you verify that accelerometer data is being **read fresh from the IMU on every packet cycle** (not cached)?

Something like:
```cpp
// Each 120Hz cycle:
accel = imu.getAcceleration();  // Fresh read, not cached
gyro = imu.getGyroscope();       // Fresh read
sendPacket(quat, accel, gyro);
```

If the IMU hardware limits accel to a lower sample rate, please let me know and we can discuss interpolation options.

Thanks!
