#ifndef VQF_H
#define VQF_H

#include "Config.h"
#include <Arduino.h>
#include <math.h>

// VQF Configuration Parameters
struct VQFConfig {
  float tauAcc;
  float tauMag;
  float restThAcc;
  float restThGyro;

  VQFConfig()
      : tauAcc(3.0f), tauMag(9.0f), restThAcc(0.02f), restThGyro(0.003f) {}
};

class VQF {
public:
  VQF(float dt = 0.01f);

  // Core Update Methods
  void update(float gx, float gy, float gz, float ax, float ay, float az,
              float dt);
  void updateMag(float mx, float my, float mz); // Placeholder/Future use

  // Compatibility Methods for SensorManager
  void reset();
  void setSampleFrequency(float freqHz); // Updates dt
  void initFromAccel(float ax, float ay, float az);

  // Getters
  Quaternion getQuaternion() const;
  void getGyroBias(float &bx, float &by, float &bz) const;
  bool getRestDetected() const;

  // Setters
  void setTauAcc(float tau);
  void setTauMag(float tau);
  void setRestZupt(float thAcc, float thGyro);

private:
  // State
  Quaternion quat; // Internal usage: [w, x, y, z] via Quaternion struct
  float bias[3];
  float lowPassGyro[3]; // Not fully needed for state but kept for parity if
                        // desired
  float lowPassAccel[3];

  // Internal counters
  bool restDetected;
  bool motionDetected;
  int biasClipCounter;
  float timeStationary;

  // Coefficients (calculated from tau)
  float kAcc;
  float kMag;
  float wBias;

  // Helper methods
  void updateCoefficients(float dt);

  // Config
  VQFConfig config;
  float dt;
};

#endif // VQF_H
