#include "VQF.h"

VQF::VQF(float dt) : dt(dt) { reset(); }

void VQF::reset() {
  // Initialize quat to identity
  quat = Quaternion(1.0f, 0.0f, 0.0f, 0.0f);

  bias[0] = 0.0f;
  bias[1] = 0.0f;
  bias[2] = 0.0f;
  lowPassGyro[0] = 0.0f;
  lowPassGyro[1] = 0.0f;
  lowPassGyro[2] = 0.0f;
  lowPassAccel[0] = 0.0f;
  lowPassAccel[1] = 0.0f;
  lowPassAccel[2] = 0.0f;

  restDetected = false;
  motionDetected = true;
  biasClipCounter = 0;
  timeStationary = 0.0f;

  updateCoefficients(dt);
}

void VQF::setSampleFrequency(float freqHz) {
  if (freqHz > 0.0f) {
    updateCoefficients(1.0f / freqHz);
  }
}

void VQF::initFromAccel(float ax, float ay, float az) {
  float aNorm = sqrtf(ax * ax + ay * ay + az * az);
  if (aNorm < 0.1f)
    return;

  // Normalize
  ax /= aNorm;
  ay /= aNorm;
  az /= aNorm;

  // Initialize roll/pitch from gravity vector (Y-Up Convention)
  // Matches VQF.ts
  // When flat (Y up), Gravity acts down (-Y). Accelerometer measures reaction
  // (+Y). So accel should be [0, 1, 0] when flat.

  // Pitch (X-axis rotation): atan2(az, ay)
  // Roll (Z-axis rotation): atan2(-ax, sqrt(ay*ay + az*az))
  // (Note: Roll/Pitch definitions vary, but this aligns 1g on Y to identity)

  float pitch = atan2f(az, ay);
  float roll = atan2f(-ax, sqrtf(ay * ay + az * az));

  // Convert to Quaternion (Euler YXZ or ZYX? Simplified)
  float cr = cosf(roll * 0.5f);
  float sr = sinf(roll * 0.5f);
  float cp = cosf(pitch * 0.5f);
  float sp = sinf(pitch * 0.5f);
  float cy = 1.0f;
  float sy = 0.0f;

  // Assuming standard order
  quat.w = cr * cp * cy + sr * sp * sy;
  quat.x = sr * cp * cy - cr * sp * sy;
  quat.y = cr * sp * cy + sr * cp * sy;
  quat.z = cr * cp * sy - sr * sp * cy;
  quat.normalize();
}

void VQF::updateCoefficients(float newDt) {
  if (newDt <= 0.0f)
    return;
  dt = newDt;
  // k = 1 - exp(-dt / tau)
  kAcc = 1.0f - expf(-dt / config.tauAcc);
  // kMag unused for now
}

void VQF::update(float gx, float gy, float gz, float ax, float ay, float az,
                 float dt) {
  if (dt > 1.0f)
    dt = 0.01f; // Safety
  if (dt > 0.0f)
    updateCoefficients(dt);

  // Check for NaN
  if (isnan(gx) || isnan(gy) || isnan(gz) || isnan(ax) || isnan(ay) ||
      isnan(az))
    return;

  // 1. Gyro Bias Correction
  float gcx = gx - bias[0];
  float gcy = gy - bias[1];
  float gcz = gz - bias[2];

  // 2. Integration (Predict)
  // q_new = q_old + 0.5 * q_old * omega * dt
  float qw = quat.w;
  float qx = quat.x;
  float qy = quat.y;
  float qz = quat.z;

  float dw = 0.5f * dt * (-qx * gcx - qy * gcy - qz * gcz);
  float dx = 0.5f * dt * (qw * gcx + qy * gcz - qz * gcy);
  float dy = 0.5f * dt * (qw * gcy - qx * gcz + qz * gcx);
  float dz = 0.5f * dt * (qw * gcz + qx * gcy - qy * gcx);

  quat.w += dw;
  quat.x += dx;
  quat.y += dy;
  quat.z += dz;

  quat.normalize();

  // 3. Accelerometer Update (Correction)
  float aNorm = sqrtf(ax * ax + ay * ay + az * az);
  if (aNorm > 0.5f && aNorm < 20.0f) { // Range 0.05g - 2.0g approx
    float axn = ax / aNorm;
    float ayn = ay / aNorm;
    float azn = az / aNorm;

    // Estimated Gravity Direction (Y-Up Convention)
    // Matches VQF.ts and Three.js
    // v = q_conj * [0, 1, 0] * q_conj_inv
    // This corresponds to the 2nd row of Rotation Matrix R(q) (Body->World)
    // R(q)_21 = 2(xy + wz)
    // R(q)_22 = 1 - 2(xx + zz)
    // R(q)_23 = 2(yz - wx)

    // Let's verify R_21 formula signs for quaternion `[w, x, y, z]`
    // R = [ ... ]
    //     [ 2(xy+wz)     1-2(xx+zz)    2(yz-wx) ]
    //     [ ... ]

    // v (Gravity in Body Frame) needs to be R^T * [0,1,0]
    // Which is the 2nd COLUMN of R^T, which is the 2nd ROW of R.
    // Yes.

    float vx = 2.0f * (quat.x * quat.y + quat.w * quat.z);
    float vy = 1.0f - 2.0f * (quat.x * quat.x + quat.z * quat.z);
    float vz = 2.0f * (quat.y * quat.z - quat.w * quat.x);

    // Error = accel x v
    float ex = ayn * vz - azn * vy;
    float ey = azn * vx - axn * vz;
    float ez = axn * vy - ayn * vx;

    // Correction
    float Gain = kAcc;
    float cx = Gain * ex * 0.5f;
    float cy = Gain * ey * 0.5f;
    float cz = Gain * ez * 0.5f;

    // Apply to quaternion
    float tq_w = quat.w - quat.x * cx - quat.y * cy - quat.z * cz;
    float tq_x = quat.x + quat.w * cx - quat.z * cy + quat.y * cz;
    float tq_y = quat.y + quat.z * cx + quat.w * cy - quat.x * cz;
    float tq_z = quat.z - quat.y * cx + quat.x * cy + quat.w * cz;

    quat.w = tq_w;
    quat.x = tq_x;
    quat.y = tq_y;
    quat.z = tq_z;
    quat.normalize();
  }

  // 4. Rest Detection (Assumes accel input is m/s^2)
  float gyroMag = sqrtf(gx * gx + gy * gy + gz * gz);
  float accelDevMs2 = fabsf(aNorm - 9.81f);

  bool checkGyro = gyroMag < config.restThGyro;
  bool checkAccel = accelDevMs2 < (config.restThAcc * 9.81f);

  if (checkGyro && checkAccel) {
    restDetected = true;
    // Bias Update
    float alpha = 0.05f;
    bias[0] = bias[0] * (1.0f - alpha) + gx * alpha;
    bias[1] = bias[1] * (1.0f - alpha) + gy * alpha;
    bias[2] = bias[2] * (1.0f - alpha) + gz * alpha;
  } else {
    restDetected = false;
  }
}

Quaternion VQF::getQuaternion() const { return quat; }

void VQF::getGyroBias(float &bx, float &by, float &bz) const {
  bx = bias[0];
  by = bias[1];
  bz = bias[2];
}

bool VQF::getRestDetected() const { return restDetected; }

// Setters
void VQF::setTauAcc(float tau) { config.tauAcc = tau; }
void VQF::setTauMag(float tau) { config.tauMag = tau; }
void VQF::setRestZupt(float thAcc, float thGyro) {
  config.restThAcc = thAcc;
  config.restThGyro = thGyro;
}

// Placeholder
void VQF::updateMag(float mx, float my, float mz) {}
