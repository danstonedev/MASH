/**
 * CMJ Feature (Counter Movement Jump)
 * ===================================
 *
 * Specialized analyzer for vertical jump performance.
 *
 * Phases:
 * 1. Unweighting: Initial dip (Force < BW).
 * 2. Braking (Eccentric): Deceleration (Force > BW, Velocity < 0).
 * 3. Propulsion (Concentric): Acceleration (Force > BW, Velocity > 0).
 * 4. Flight: Airborne (Force = 0).
 * 5. Landing: Impact.
 *
 * Metrics:
 * - RSI-mod: Flight Time / Contraction Time (Time from Unweighting to Takeoff).
 * - Jump Height: From Flight Time.
 * - Peak Power: Estimated from Impulse.
 *
 * @module analysis/CMJFeature
 */

import * as THREE from "three";
import { KineticChain } from "./KineticChain";

export type CMJPhase =
  | "static"
  | "unweighting"
  | "braking"
  | "propulsion"
  | "flight"
  | "landing";

export interface CMJMetrics {
  jumpHeight: number; // cm
  rsiMod: number; // Index
  contractionTime: number; // ms (Unweighting + Braking + Propulsion)
  flightTime: number; // ms
  peakForce: number; // BW (Body Weights)
  phase: CMJPhase;
}

export class CMJFeature {
  private state: CMJPhase = "static";

  // Timestamps
  private tUnweighting = 0;
  private tTakeoff = 0;
  private tLanding = 0;

  private flightDuration = 0;
  private contractionDuration = 0;

  /**
   * ACCELERATION CONVENTION:
   * This analyzer expects RAW acceleration (gravity-included) in m/s².
   *
   * At rest: rootAccel.y ≈ 9.81 m/s² (1g pointing up in world frame).
   * During unweighting: rootAccel.y < 9.81 (body accelerating down).
   * During propulsion: rootAccel.y > 9.81 (body accelerating up).
   * During flight: rootAccel.y ≈ 0 (freefall).
   */
  private G = 9.81;

  update(coreChain: KineticChain, timestamp: number): CMJMetrics {
    const metrics = coreChain.getMetrics();
    const accY = metrics.rootAccel.y; // Vertical (World Frame)

    // State Machine
    switch (this.state) {
      case "static":
        // Detect start of unweighting (Drop below 1G)
        // Threshold: < 0.9 G? (meaning < 8.8 m/s^2)
        if (accY < this.G * 0.9) {
          this.state = "unweighting";
          this.tUnweighting = timestamp;
        }
        break;

      case "unweighting":
        // Transition to Braking?
        // When velocity becomes negative? Hard to track vel without drift.
        // Alternative: When Force exceeds 1G again?
        // Actually, "Braking" starts when Velocity is min (max negative) and Acceleration becomes positive (Force > BW).
        if (accY > this.G) {
          this.state = "braking";
        }
        break;

      case "braking":
        // Transition to Propulsion?
        // Propulsion starts when Velocity > 0.
        // Hard to detect exactly without integral.
        // Approximation: When Accel peaks? No.
        // Usually lumped together as "Contraction phase" for RSI-mod.
        // Let's detect Takeoff instead.
        if (accY > this.G * 1.5) {
          // Significant force
          this.state = "propulsion";
        }
        break;

      case "propulsion":
        // Detect Takeoff (Force drops to 0G)
        // Threshold: < 0.2 G (Approx 2 m/s^2) - allows for drag/noise
        if (accY < 2.0) {
          this.state = "flight";
          this.tTakeoff = timestamp;
          this.contractionDuration = this.tTakeoff - this.tUnweighting;
        }
        break;

      case "flight":
        // Detect Landing (Force spikes)
        // Threshold: > 1.5 G
        if (accY > this.G * 1.5) {
          this.state = "landing";
          this.tLanding = timestamp;
          this.flightDuration = this.tLanding - this.tTakeoff;
        }
        break;

      case "landing":
        // Return to static after settling
        if (Math.abs(accY - this.G) < 1.0 && timestamp - this.tLanding > 500) {
          this.state = "static";
        }
        break;
    }

    // Calculate Metrics
    let h = 0;
    let rsi = 0;

    if (this.flightDuration > 0) {
      // H = 1/2 * g * (t_flight / 2)^2 = 1/8 * g * t^2
      const tSec = this.flightDuration / 1000;
      h = ((this.G * tSec * tSec) / 8) * 100; // cm

      if (this.contractionDuration > 0) {
        const tContractSec = this.contractionDuration / 1000;
        rsi = tSec / tContractSec; // Flight Time / Contraction Time
      }
    }

    return {
      jumpHeight: h,
      rsiMod: rsi,
      contractionTime: this.contractionDuration,
      flightTime: this.flightDuration,
      peakForce: Math.max(0, accY / this.G), // Instantaneous BW
      phase: this.state,
    };
  }
}
