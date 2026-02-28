/*******************************************************************************
 * Quaternion.h - Quaternion Data Structure and Operations
 * 
 * Part of IMUConnectCore library - shared between Gateway and Node firmware.
 * Provides a lightweight quaternion representation for orientation data.
 *
 ******************************************************************************/

#ifndef QUATERNION_H
#define QUATERNION_H

#include <Arduino.h>
#include <math.h>

struct Quaternion {
  float w;
  float x;
  float y;
  float z;

  // Default constructor - identity quaternion (no rotation)
  Quaternion() : w(1.0f), x(0.0f), y(0.0f), z(0.0f) {}
  
  // Parameterized constructor
  Quaternion(float _w, float _x, float _y, float _z)
      : w(_w), x(_x), y(_y), z(_z) {}

  // Normalize quaternion to unit length
  void normalize() {
    float norm = sqrtf(w * w + x * x + y * y + z * z);
    if (norm > 0.0f) {
      float invNorm = 1.0f / norm;
      w *= invNorm;
      x *= invNorm;
      y *= invNorm;
      z *= invNorm;
    }
  }

  // Check if normalized (within tolerance)
  bool isNormalized(float tolerance = 0.001f) const {
    float norm = sqrtf(w * w + x * x + y * y + z * z);
    return fabsf(norm - 1.0f) < tolerance;
  }

  // Int16 helpers for BLE/ESP-NOW transmission (Scale: 16384.0f = 2^14)
  // This provides ~0.00006 resolution which is sufficient for orientation
  int16_t wInt16() const { return (int16_t)(w * 16384.0f); }
  int16_t xInt16() const { return (int16_t)(x * 16384.0f); }
  int16_t yInt16() const { return (int16_t)(y * 16384.0f); }
  int16_t zInt16() const { return (int16_t)(z * 16384.0f); }

  // Reconstruct from int16 values
  static Quaternion fromInt16(int16_t w, int16_t x, int16_t y, int16_t z) {
    return Quaternion(
      w / 16384.0f,
      x / 16384.0f,
      y / 16384.0f,
      z / 16384.0f
    );
  }

  // Quaternion multiplication (for combining rotations)
  Quaternion operator*(const Quaternion& q) const {
    return Quaternion(
      w * q.w - x * q.x - y * q.y - z * q.z,
      w * q.x + x * q.w + y * q.z - z * q.y,
      w * q.y - x * q.z + y * q.w + z * q.x,
      w * q.z + x * q.y - y * q.x + z * q.w
    );
  }

  // Conjugate (inverse for unit quaternions)
  Quaternion conjugate() const {
    return Quaternion(w, -x, -y, -z);
  }
};

#endif  // QUATERNION_H
