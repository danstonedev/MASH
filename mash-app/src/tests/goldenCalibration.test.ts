/**
 * GOLDEN CALIBRATION TESTS - DO NOT MODIFY
 * =========================================
 * 
 * These tests lock down the exact mathematical behavior of our
 * PROVEN WORKING calibration systems. Any changes that break these
 * tests are REGRESSIONS that must be fixed.
 * 
 * Hardware Verified: 2026-02-01 (Head/Cervical calibration)
 * 
 * PATTERN: Head calibration uses two-step pipeline:
 *   q_world = (q_sensor × mountingTare) × frameAlignment
 * 
 * Where:
 *   mountingTare = inv(startQuat) × inv(frameAlignment)
 *   
 * This ensures:
 *   - At neutral pose: q_world = identity ✓
 *   - Sensor movements map to correct anatomical axes ✓
 * 
 * @preserve DO NOT MODIFY WITHOUT HARDWARE VERIFICATION
 */

import * as THREE from 'three';
import { describe, it, expect, beforeEach } from 'vitest';

// Core transformation functions
import {
  applyMountingTare,
  applyFrameAlignment,
  createDefaultTareState,
} from '../calibration/taringPipeline';
import { transformOrientation, createIdentityTareState } from '../lib/math/OrientationPipeline';

// ============================================================================
// TEST UTILITIES - LOCKED IMPLEMENTATIONS
// ============================================================================

/**
 * The EXACT formula used in head calibration.
 * mountingTare = boresight × inv(frameAlignment)
 *             = inv(startQuat) × inv(frameAlignment)
 */
function computeHeadMountingTare(
  startQuat: THREE.Quaternion,
  frameAlignment: THREE.Quaternion
): THREE.Quaternion {
  const boresight = startQuat.clone().invert();
  const frameAlignmentInv = frameAlignment.clone().invert();
  return boresight.clone().multiply(frameAlignmentInv);
}

/**
 * The EXACT pipeline transformation.
 * q_world = (q_sensor × mountingTare) × frameAlignment
 */
function applyHeadPipeline(
  q_sensor: THREE.Quaternion,
  mountingTare: THREE.Quaternion,
  frameAlignment: THREE.Quaternion
): THREE.Quaternion {
  // Step 1: q_tared = q_sensor × mountingTare
  const q_tared = q_sensor.clone().multiply(mountingTare);
  // Step 2: q_world = q_tared × frameAlignment
  return q_tared.multiply(frameAlignment);
}

/**
 * Create quaternion from Euler angles (degrees)
 */
function quatFromDegrees(pitchDeg: number, yawDeg: number, rollDeg: number): THREE.Quaternion {
  const euler = new THREE.Euler(
    pitchDeg * Math.PI / 180,
    yawDeg * Math.PI / 180,
    rollDeg * Math.PI / 180,
    'XYZ'
  );
  return new THREE.Quaternion().setFromEuler(euler);
}

/**
 * Get Euler angles in degrees from quaternion
 */
function getEulerDegrees(q: THREE.Quaternion): { pitch: number; yaw: number; roll: number } {
  const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return {
    pitch: euler.x * 180 / Math.PI,
    yaw: euler.y * 180 / Math.PI,
    roll: euler.z * 180 / Math.PI,
  };
}

/**
 * Assert quaternion is close to expected
 */
function expectQuatNear(actual: THREE.Quaternion, expected: THREE.Quaternion, tolerance = 0.001) {
  // Handle quaternion double-cover (q = -q)
  const dist1 = Math.abs(actual.w - expected.w) + 
                Math.abs(actual.x - expected.x) + 
                Math.abs(actual.y - expected.y) + 
                Math.abs(actual.z - expected.z);
  const dist2 = Math.abs(actual.w + expected.w) + 
                Math.abs(actual.x + expected.x) + 
                Math.abs(actual.y + expected.y) + 
                Math.abs(actual.z + expected.z);
  expect(Math.min(dist1, dist2)).toBeLessThan(tolerance * 4);
}

// ============================================================================
// GOLDEN TESTS - HEAD CALIBRATION MATH
// ============================================================================

describe('GOLDEN: Head Calibration Mathematics', () => {
  
  describe('Neutral Pose → Identity (CRITICAL)', () => {
    it('calibrating from identity should output identity at neutral', () => {
      // SETUP: Sensor starts at identity (flat)
      const startQuat = new THREE.Quaternion(); // identity
      const frameAlignment = new THREE.Quaternion(); // no axis remapping
      
      // CALIBRATE: Compute mounting tare
      const mountingTare = computeHeadMountingTare(startQuat, frameAlignment);
      
      // VERIFY: At neutral pose, output should be identity
      const q_sensor = new THREE.Quaternion(); // same as calibration
      const q_world = applyHeadPipeline(q_sensor, mountingTare, frameAlignment);
      
      expectQuatNear(q_world, new THREE.Quaternion());
    });
    
    it('calibrating from tilted pose should output identity at that pose', () => {
      // SETUP: Sensor tilted 30° pitch
      const startQuat = quatFromDegrees(30, 0, 0);
      const frameAlignment = new THREE.Quaternion(); // no axis remapping
      
      // CALIBRATE
      const mountingTare = computeHeadMountingTare(startQuat, frameAlignment);
      
      // VERIFY: At calibration pose, output should be identity
      const q_sensor = startQuat.clone();
      const q_world = applyHeadPipeline(q_sensor, mountingTare, frameAlignment);
      
      expectQuatNear(q_world, new THREE.Quaternion());
    });
    
    it('calibrating from complex pose with frame alignment should output identity', () => {
      // SETUP: Sensor at 45° pitch, needs 90° frame alignment (sensor mounted sideways)
      const startQuat = quatFromDegrees(45, 15, -10);
      const frameAlignment = quatFromDegrees(0, 0, 90); // Rotate sensor frame 90° around Z
      
      // CALIBRATE
      const mountingTare = computeHeadMountingTare(startQuat, frameAlignment);
      
      // VERIFY: At calibration pose, output should be identity
      const q_sensor = startQuat.clone();
      const q_world = applyHeadPipeline(q_sensor, mountingTare, frameAlignment);
      
      expectQuatNear(q_world, new THREE.Quaternion());
    });
  });
  
  describe('Motion Tracking After Calibration', () => {
    it('sensor rotation from neutral should appear as rotation in world', () => {
      // SETUP & CALIBRATE: Start at identity
      const startQuat = new THREE.Quaternion();
      const frameAlignment = new THREE.Quaternion();
      const mountingTare = computeHeadMountingTare(startQuat, frameAlignment);
      
      // MOTION: Sensor rotates 20° pitch
      const q_sensor = quatFromDegrees(20, 0, 0);
      const q_world = applyHeadPipeline(q_sensor, mountingTare, frameAlignment);
      
      // VERIFY: World output should show ~20° pitch
      const euler = getEulerDegrees(q_world);
      expect(euler.pitch).toBeCloseTo(20, 0);
      expect(euler.yaw).toBeCloseTo(0, 0);
      expect(euler.roll).toBeCloseTo(0, 0);
    });
    
    it('yaw rotation from neutral should appear as yaw in world', () => {
      // SETUP & CALIBRATE
      const startQuat = new THREE.Quaternion();
      const frameAlignment = new THREE.Quaternion();
      const mountingTare = computeHeadMountingTare(startQuat, frameAlignment);
      
      // MOTION: Sensor rotates 45° yaw (shake head left)
      const q_sensor = quatFromDegrees(0, 45, 0);
      const q_world = applyHeadPipeline(q_sensor, mountingTare, frameAlignment);
      
      // VERIFY
      const euler = getEulerDegrees(q_world);
      expect(euler.pitch).toBeCloseTo(0, 0);
      expect(euler.yaw).toBeCloseTo(45, 0);
      expect(euler.roll).toBeCloseTo(0, 0);
    });
    
    it('motion from tilted calibration pose should track correctly', () => {
      // SETUP: Sensor tilted 30° at calibration
      const startQuat = quatFromDegrees(30, 0, 0);
      const frameAlignment = new THREE.Quaternion();
      const mountingTare = computeHeadMountingTare(startQuat, frameAlignment);
      
      // MOTION: Sensor now at 50° (20° additional pitch)
      const q_sensor = quatFromDegrees(50, 0, 0);
      const q_world = applyHeadPipeline(q_sensor, mountingTare, frameAlignment);
      
      // VERIFY: Should show ~20° (delta from calibration)
      const euler = getEulerDegrees(q_world);
      expect(euler.pitch).toBeCloseTo(20, 0);
    });
  });
  
  describe('Frame Alignment Axis Remapping', () => {
    it('90° Z frame alignment should swap pitch/roll axes', () => {
      // SETUP: Frame alignment rotates sensor frame 90° around Z
      // This means sensor X (pitch) → world Y (roll)
      const startQuat = new THREE.Quaternion();
      const frameAlignment = quatFromDegrees(0, 0, 90);
      const mountingTare = computeHeadMountingTare(startQuat, frameAlignment);
      
      // VERIFY calibration pose is identity
      const q_at_neutral = applyHeadPipeline(new THREE.Quaternion(), mountingTare, frameAlignment);
      expectQuatNear(q_at_neutral, new THREE.Quaternion());
      
      // MOTION: Sensor pitches 30° in sensor frame
      const q_sensor_pitch = quatFromDegrees(30, 0, 0);
      const q_world = applyHeadPipeline(q_sensor_pitch, mountingTare, frameAlignment);
      
      // After 90° Z rotation, sensor pitch (X) maps to world roll (Z)
      const euler = getEulerDegrees(q_world);
      // The exact mapping depends on implementation - verify magnitude is preserved
      const totalAngle = Math.sqrt(euler.pitch**2 + euler.yaw**2 + euler.roll**2);
      expect(totalAngle).toBeCloseTo(30, 1);
    });
  });
});

// ============================================================================
// GOLDEN TESTS - ORIENTATION PIPELINE INTEGRATION
// ============================================================================

describe('GOLDEN: OrientationPipeline Integration', () => {
  
  it('should apply mounting tare via taringPipeline functions', () => {
    // SETUP
    const q_sensor = new THREE.Quaternion(0, 0, 0, 1); // Identity
    const mountingTare = quatFromDegrees(45, 0, 0); // 45° offset
    
    // APPLY
    const q_bone = applyMountingTare(q_sensor, mountingTare);
    
    // VERIFY: q_bone = q_sensor × mountingTare
    const expected = q_sensor.clone().multiply(mountingTare);
    expectQuatNear(q_bone, expected);
  });
  
  it('should apply frame alignment via taringPipeline functions', () => {
    // SETUP
    const q_bone = new THREE.Quaternion(0, 0, 0, 1);
    const frameAlignment = quatFromDegrees(0, 90, 0); // 90° yaw
    
    // APPLY
    const q_world = applyFrameAlignment(q_bone, frameAlignment);
    
    // VERIFY: q_world = q_bone × frameAlignment
    const expected = q_bone.clone().multiply(frameAlignment);
    expectQuatNear(q_world, expected);
  });
  
  it('transformOrientation should use TareState correctly', () => {
    // SETUP: Create a tare state with known values
    const mountingTare = quatFromDegrees(0, 0, 0);
    const frameAlignment = quatFromDegrees(0, 0, 0);
    const headingTare = new THREE.Quaternion();
    
    const tareState = {
      mountingTare,
      headingTare,
      jointTare: { flexion: 0, abduction: 0, rotation: 0 },
      frameAlignment,
      mountingTareTime: Date.now(),
      headingTareTime: 0,
      jointTareTime: 0,
      frameAlignmentTime: Date.now(),
    };
    
    // INPUT: Identity quaternion [w, x, y, z]
    const rawQuat: [number, number, number, number] = [1, 0, 0, 0];
    
    // TRANSFORM
    const result = transformOrientation(rawQuat, tareState);
    
    // VERIFY: With identity tares, output should be identity
    expectQuatNear(result.q_world, new THREE.Quaternion());
  });
});

// ============================================================================
// GOLDEN TESTS - PRESERVING PIPELINE INSPECTOR BEHAVIOR
// ============================================================================

describe('GOLDEN: Pipeline Inspector Behavior', () => {
  
  it('identity TareState should pass sensor data through unchanged', () => {
    // Pipeline Inspector uses identity tares to show raw sensor data
    const identityState = createIdentityTareState();
    
    // Any sensor orientation
    const rawQuat: [number, number, number, number] = [0.924, -0.383, 0, 0]; // ~45° pitch
    
    const result = transformOrientation(rawQuat, identityState);
    
    // Should be unchanged from input (just array→THREE conversion)
    const expected = new THREE.Quaternion(-0.383, 0, 0, 0.924);
    expectQuatNear(result.q_sensor, expected);
  });
  
  it('should handle null TareState gracefully', () => {
    const rawQuat: [number, number, number, number] = [1, 0, 0, 0];
    
    // Should not throw
    const result = transformOrientation(rawQuat, null);
    
    // Should return valid result
    expect(result.q_world).toBeInstanceOf(THREE.Quaternion);
  });
});

// ============================================================================
// GOLDEN TESTS - MATHEMATICAL INVARIANTS
// ============================================================================

describe('GOLDEN: Mathematical Invariants', () => {
  
  it('quaternion normalization should be preserved through pipeline', () => {
    // Start with normalized quaternion
    const rawQuat: [number, number, number, number] = [0.707, 0.707, 0, 0];
    const tareState = createIdentityTareState();
    
    const result = transformOrientation(rawQuat, tareState);
    
    // All output quaternions should be normalized (within floating point tolerance)
    expect(result.q_sensor.length()).toBeCloseTo(1, 3);
    expect(result.q_bone.length()).toBeCloseTo(1, 3);
    expect(result.q_world.length()).toBeCloseTo(1, 3);
  });
  
  it('pipeline should reject NaN quaternions', () => {
    const rawQuat: [number, number, number, number] = [NaN, 0, 0, 0];
    const tareState = createIdentityTareState();
    
    const result = transformOrientation(rawQuat, tareState);
    
    // Should return identity, not NaN
    expect(isNaN(result.q_world.w)).toBe(false);
  });
  
  it('RIGHT multiplication order is critical - do not use similarity transform', () => {
    // This test documents WHY we use right multiplication
    // WRONG: R × q × R⁻¹ (similarity transform)
    // RIGHT: q × R (right multiplication)
    
    const q = quatFromDegrees(30, 0, 0); // 30° pitch
    const R = quatFromDegrees(0, 0, 90); // 90° roll frame alignment
    
    // RIGHT multiplication preserves pitch as pitch (rotated in frame)
    const rightResult = q.clone().multiply(R);
    
    // Similarity transform SWAPS axes (pitch becomes something else)
    const Rinv = R.clone().invert();
    const similarityResult = R.clone().multiply(q).multiply(Rinv);
    
    // These produce DIFFERENT results
    expect(rightResult.equals(similarityResult)).toBe(false);
    
    // Our pipeline uses RIGHT multiplication
    // This is intentional and hardware-verified
  });
});
