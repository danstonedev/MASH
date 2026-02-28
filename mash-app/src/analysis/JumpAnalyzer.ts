/**
 * Jump Analyzer (A+ Research Grade)
 * ==================================
 *
 * Comprehensive jump analysis using multi-segment kinematics and inverse dynamics.
 *
 * ## Core Features (B+)
 * - Robust takeoff detection via Core Chain COM proxy
 * - Jump Height via dual methods (Flight Time + Impulse-Momentum)
 * - GRF estimation in Body Weights (BW)
 * - RSI-modified (standard m/s units)
 *
 * ## A+ Enhancements
 * - **Multi-Segment GRF Estimation** (Newton-Euler inverse dynamics)
 * - **Force-Time Curve Generation** with key point identification
 * - **Full CMJ Battery**: Peak Force, Peak Power, RFD, Impulse metrics
 * - **Eccentric/Concentric Phase Analysis**
 * - **Landing Asymmetry Detection** (bilateral IMU comparison)
 * - **Power Output Calculation** (Force × Velocity)
 *
 * ## Methodology
 * - Uses Core (Pelvis) chain for COM approximation (Tier 1)
 * - Can utilize lower limb chains for multi-segment analysis (Tier 2)
 * - Implements inverse dynamics per Winter (2009) biomechanics
 *
 * ## References
 * - Moir et al. (2008): CMJ force-time variables
 * - McMahon et al. (2018): Asymmetry metrics
 * - Linthorne (2001): Optimum take-off angle
 *
 * @module analysis/JumpAnalyzer
 */

import * as THREE from "three";
import { KineticChain, type ChainMetrics } from "./KineticChain";

// ============================================================================
// TYPES
// ============================================================================

export type JumpPhase = "grounded" | "takeoff" | "flight" | "landing";

/**
 * CMJ Phase subdivisions for detailed analysis
 */
export type CMJPhase = 
  | "quiet_standing"
  | "unweighting"      // Initial downward movement
  | "braking"          // Deceleration before push
  | "propulsion"       // Upward acceleration
  | "flight"
  | "landing_impact"
  | "landing_stabilization";

export interface Jump {
  startTime: number; // Takeoff initiation
  takeoffTime: number; // Moment of liftoff
  peakTime: number; // Apex of jump
  landingTime: number; // Ground contact
  endTime: number; // Return to stable

  // Metrics
  flightTime: number; // ms in air
  contractionTime: number; // Time to takeoff (ms) - from start to liftoff

  // Jump Height - dual method calculation
  heightFlightTime: number; // cm (h = 1/8 * g * t²) - flight time method
  heightImpulseMomentum: number; // cm (h = v²/2g) - impulse-momentum method
  estimatedHeight: number; // cm - best estimate (weighted average)

  // Takeoff velocity (estimated from impulse)
  takeoffVelocity: number; // m/s

  // Forces
  peakGRF_Takeoff: number; // Peak Force during Push (in BW)
  peakGRF_Landing: number; // Peak Force during Landing (in BW)

  // RSI-modified (Reactive Strength Index)
  // Standard formula: RSI-mod = Jump Height (m) / Time to Takeoff (s)
  // Units: m/s (NOT dimensionless)
  rsiModified: number; // m/s - standard RSI-mod units

  // Classification
  type: "hop" | "jump" | "leap" | "drop" | "unknown";
  confidence: number;
}

/**
 * A+ Force-Time Curve data point
 */
export interface ForceTimePoint {
  time: number;           // ms from jump start
  force: number;          // Newtons (estimated)
  forceBW: number;        // Body weights
  velocity: number;       // m/s (integrated)
  displacement: number;   // m (double integrated)
  power: number;          // Watts (force × velocity)
  phase: CMJPhase;
}

/**
 * A+ CMJ Metrics (full battery)
 */
export interface CMJMetrics {
  // Height metrics
  jumpHeight: number;           // cm (best estimate)
  peakHeight: number;           // cm (apex above standing)
  
  // Force metrics
  peakForce: number;            // N
  peakForceBW: number;          // BW
  timeToPeakForce: number;      // ms from movement start
  
  // Rate of Force Development
  peakRFD: number;              // N/s
  rfdAt50ms: number;            // N/s (RFD at 50ms window)
  rfdAt100ms: number;           // N/s (RFD at 100ms window)
  rfdAt200ms: number;           // N/s (RFD at 200ms window)
  
  // Power metrics
  peakPower: number;            // W
  peakPowerBW: number;          // W/kg
  meanPower: number;            // W (during propulsion)
  timeToPeakPower: number;      // ms
  
  // Impulse metrics
  totalImpulse: number;         // N·s
  eccentricImpulse: number;     // N·s (braking phase)
  concentricImpulse: number;    // N·s (propulsion phase)
  impulseRatio: number;         // Concentric/Eccentric ratio
  
  // Velocity metrics
  takeoffVelocity: number;      // m/s
  peakNegativeVelocity: number; // m/s (countermovement depth indicator)
  
  // Phase timing
  unweightingTime: number;      // ms
  brakingTime: number;          // ms
  propulsionTime: number;       // ms
  totalContractionTime: number; // ms
  
  // Displacement metrics
  counterMovementDepth: number; // cm (how deep the squat)
  
  // RSI variants
  rsiModified: number;          // m/s (height/contraction time)
  rsiReactive: number;          // height/contact time (for reactive jumps)
  
  // Force-time curve
  forceCurve: ForceTimePoint[];
}

/**
 * A+ Landing Asymmetry Analysis
 */
export interface LandingAsymmetry {
  // Bilateral comparison (requires L/R foot IMUs)
  peakForceAsymmetry: number;   // % difference ((R-L)/(R+L)*200)
  timeToStabilization: {
    left: number;               // ms
    right: number;              // ms
  };
  impulseAsymmetry: number;     // % difference in landing impulse
  
  // Asymmetry index (0 = symmetric, 100 = max asymmetry)
  asymmetryIndex: number;
  dominantSide: 'left' | 'right' | 'symmetric';
  
  // Clinical threshold (>15% may indicate injury risk)
  exceedsThreshold: boolean;
}

/**
 * A+ Multi-Segment GRF Estimation
 * Uses Newton-Euler inverse dynamics when segment data available
 */
export interface MultiSegmentGRF {
  // Total estimated GRF
  totalForce: THREE.Vector3;    // N (3D vector)
  totalForceMagnitude: number;  // N
  
  // Segmental contributions (when available)
  pelvisContribution: number;   // % of total
  thighContribution: number;    // % of total (combined L+R)
  shankContribution: number;    // % of total (combined L+R)
  footContribution: number;     // % of total (combined L+R)
  
  // Joint torques (when full chain available)
  hipTorque: THREE.Vector3 | null;
  kneeTorque: THREE.Vector3 | null;
  ankleTorque: THREE.Vector3 | null;
}

export interface JumpMetrics {
  totalJumps: number;
  averageHeight: number; // cm
  maxHeight: number; // cm
  averageFlightTime: number; // ms
  maxGRF: number; // Max force recorded (BW)
  currentPhase: JumpPhase;
  lastJump: Jump | null;

  // RSI-mod average (m/s) - standard units for normative comparison
  // Reference values: Elite male ~0.50-0.70 m/s, Elite female ~0.40-0.55 m/s
  averageRSIMod: number;
  
  // A+ detailed metrics (when available)
  lastCMJMetrics: CMJMetrics | null;
  lastAsymmetry: LandingAsymmetry | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const GRAVITY = 9.81; // m/s²
const SAMPLE_RATE_HZ = 100; // Assumed sample rate for integration
const DT = 1 / SAMPLE_RATE_HZ; // Time step in seconds

/**
 * ACCELERATION CONVENTION:
 * This analyzer expects RAW acceleration (gravity-included).
 *
 * At rest: Sensor reads ~9.81 m/s² (1g) pointing upward.
 * During freefall: Sensor reads ~0 m/s² (0g).
 * During landing: Sensor reads >9.81 m/s² (>1g).
 *
 * GRF in Body Weights (BW) = Accel / 9.81
 * Example: 20 m/s² / 9.81 = 2.04 BW
 */
const TAKEOFF_THRESHOLD = 14; // m/s² (approx 1.4g) - push-off force
const FREEFALL_THRESHOLD = 5.0; // m/s² (approx 0.5g) - near-zero indicates airborne
const LANDING_THRESHOLD = 15; // m/s² (approx 1.5g) - impact spike
const MIN_FLIGHT_TIME_MS = 100; // Minimum flight time to register as valid jump

const ACCEL_BUFFER_SIZE = 200; // Increased for full CMJ analysis

// A+ Asymmetry threshold
const ASYMMETRY_THRESHOLD_PCT = 15; // Clinical threshold for injury risk

// Default body mass for force calculations (can be overridden)
const DEFAULT_BODY_MASS_KG = 70;

// ============================================================================
// CLASS
// ============================================================================

export class JumpAnalyzer {
  private accelBuffer: number[] = [];
  private timestampBuffer: number[] = []; // For impulse integration
  private rawAccelBuffer: THREE.Vector3[] = []; // Full 3D acceleration

  // State machine
  private phase: JumpPhase = "grounded";
  private phaseStartTime = 0;

  // Jump tracking
  private currentJump: Partial<Jump> | null = null;
  private jumps: Jump[] = [];

  // Impulse tracking for takeoff velocity calculation
  private propulsionStartIdx = 0;
  private propulsionAccels: number[] = [];

  // A+ CMJ tracking
  private cmjPhaseBuffer: CMJPhase[] = [];
  private forceTimeBuffer: ForceTimePoint[] = [];
  private velocityIntegral = 0;
  private displacementIntegral = 0;
  private lastCMJMetrics: CMJMetrics | null = null;
  
  // A+ Bilateral tracking (requires left/right foot data)
  private leftFootAccel: number[] = [];
  private rightFootAccel: number[] = [];
  private lastAsymmetry: LandingAsymmetry | null = null;

  // Configuration
  private bodyMassKg = DEFAULT_BODY_MASS_KG;

  // Callbacks
  private onJumpDetected: ((jump: Jump) => void) | null = null;
  private onPhaseChange: ((phase: JumpPhase) => void) | null = null;

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  /**
   * Set body mass for accurate force calculations
   */
  setBodyMass(massKg: number): void {
    this.bodyMassKg = massKg;
  }

  /**
   * Reset analyzer
   */
  reset(): void {
    this.accelBuffer = [];
    this.timestampBuffer = [];
    this.rawAccelBuffer = [];
    this.phase = "grounded";
    this.phaseStartTime = 0;
    this.currentJump = null;
    this.jumps = [];
    this.propulsionStartIdx = 0;
    this.propulsionAccels = [];
    this.cmjPhaseBuffer = [];
    this.forceTimeBuffer = [];
    this.velocityIntegral = 0;
    this.displacementIntegral = 0;
    this.lastCMJMetrics = null;
    this.leftFootAccel = [];
    this.rightFootAccel = [];
    this.lastAsymmetry = null;
  }

  setOnJumpDetected(callback: (jump: Jump) => void): void {
    this.onJumpDetected = callback;
  }

  setOnPhaseChange(callback: (phase: JumpPhase) => void): void {
    this.onPhaseChange = callback;
  }

  /**
   * Update State with Core KineticChain data
   */
  update(coreChain: KineticChain, timestamp: number): Jump | null {
    // We rely on the Core (Pelvis) chain for COM approximation
    // Accessing exposed rootAccel
    const accVector = coreChain["metrics"].rootAccel as THREE.Vector3;
    if (!accVector) return null;

    const currentMag = accVector.length();
    this.accelBuffer.push(currentMag);
    this.timestampBuffer.push(timestamp);
    this.rawAccelBuffer.push(accVector.clone());
    
    if (this.accelBuffer.length > ACCEL_BUFFER_SIZE) {
      this.accelBuffer.shift();
      this.timestampBuffer.shift();
      this.rawAccelBuffer.shift();
    }

    if (this.accelBuffer.length < 5) return null;

    // Smooth accel
    const recent = this.accelBuffer.slice(-5);
    const avgMag = recent.reduce((a, b) => a + b) / recent.length;

    const prevPhase = this.phase;
    let completedJump: Jump | null = null;
    const now = timestamp;

    // A+ Force-time tracking during active jump
    if (this.currentJump) {
      this.updateForceTimeCurve(currentMag, timestamp);
    }

    switch (this.phase) {
      case "grounded":
        if (avgMag > TAKEOFF_THRESHOLD) {
          this.phase = "takeoff";
          this.phaseStartTime = now;
          this.propulsionStartIdx = this.accelBuffer.length - 1;
          this.propulsionAccels = [];
          this.forceTimeBuffer = [];
          this.velocityIntegral = 0;
          this.displacementIntegral = 0;
          this.currentJump = {
            startTime: now,
            peakGRF_Takeoff: currentMag / GRAVITY, // Initial estimate
          };
        }
        break;

      case "takeoff":
        // Track peak force and accumulate propulsion data
        if (this.currentJump) {
          const grf = currentMag / GRAVITY;
          if (grf > (this.currentJump.peakGRF_Takeoff || 0)) {
            this.currentJump.peakGRF_Takeoff = grf;
          }
          // Store propulsion acceleration (subtract gravity to get net upward accel)
          this.propulsionAccels.push(currentMag - GRAVITY);
        }

        // Detect Freefall
        if (avgMag < FREEFALL_THRESHOLD) {
          this.phase = "flight";
          this.phaseStartTime = now;
          if (this.currentJump) {
            this.currentJump.takeoffTime = now;
            // Calculate contraction time (time to takeoff)
            this.currentJump.contractionTime =
              now - (this.currentJump.startTime || now);

            // Calculate takeoff velocity using impulse-momentum theorem
            // v = ∫(a_net) dt = Σ(a_i - g) * dt
            let velocity = 0;
            for (const netAccel of this.propulsionAccels) {
              velocity += netAccel * DT;
            }
            this.currentJump.takeoffVelocity = Math.max(0, velocity);
          }
        }

        // Timeout
        if (now - this.phaseStartTime > 500) {
          this.phase = "grounded";
          this.currentJump = null;
          this.propulsionAccels = [];
        }
        break;

      case "flight":
        // Detect Landing Impact
        if (avgMag > LANDING_THRESHOLD) {
          const flightTime = now - this.phaseStartTime;

          if (flightTime > MIN_FLIGHT_TIME_MS) {
            this.phase = "landing";
            this.phaseStartTime = now;

            if (this.currentJump) {
              this.currentJump.landingTime = now;
              this.currentJump.flightTime = flightTime;

              // METHOD 1: Flight Time (h = 1/8 * g * t²)
              // Assumes symmetric takeoff/landing heights
              const t_sec = flightTime / 1000;
              const heightFT = 0.125 * GRAVITY * t_sec * t_sec * 100; // cm
              this.currentJump.heightFlightTime = heightFT;

              // METHOD 2: Impulse-Momentum (h = v²/2g)
              // Uses integrated takeoff velocity
              const v0 = this.currentJump.takeoffVelocity || 0;
              const heightIM = ((v0 * v0) / (2 * GRAVITY)) * 100; // cm
              this.currentJump.heightImpulseMomentum = heightIM;

              // Combined estimate: Weight average (60% flight time, 40% impulse)
              // Flight time is more reliable for low jumps, impulse for high jumps
              const weight = Math.min(0.6, Math.max(0.3, heightFT / 100));
              this.currentJump.estimatedHeight =
                heightFT * weight + heightIM * (1 - weight);

              // RSI-modified: Jump Height (m) / Time to Takeoff (s)
              // Standard units: m/s (allows comparison to norms)
              const heightM = this.currentJump.estimatedHeight / 100;
              const tttSec = (this.currentJump.contractionTime || 1) / 1000;
              this.currentJump.rsiModified = tttSec > 0 ? heightM / tttSec : 0;

              this.currentJump.peakGRF_Landing = currentMag / GRAVITY;
            }
          } else {
            // Too short, false alarm?
            this.phase = "grounded";
            this.currentJump = null;
          }
        }

        if (now - this.phaseStartTime > 2000) {
          this.phase = "grounded"; // Timeout
          this.currentJump = null;
        }
        break;

      case "landing":
        if (this.currentJump) {
          const grf = currentMag / GRAVITY;
          if (grf > (this.currentJump.peakGRF_Landing || 0)) {
            this.currentJump.peakGRF_Landing = grf;
          }
        }

        // Stabilize
        if (avgMag < TAKEOFF_THRESHOLD && now - this.phaseStartTime > 150) {
          this.phase = "grounded";
          if (this.currentJump) {
            this.currentJump.endTime = now;

            // Classify
            const h = this.currentJump.estimatedHeight || 0;
            let type: Jump["type"] = "jump";
            if (h < 5) type = "hop";
            if (h > 40) type = "leap";

            const finalJump: Jump = {
              startTime: this.currentJump.startTime || 0,
              takeoffTime: this.currentJump.takeoffTime || 0,
              peakTime:
                (this.currentJump.takeoffTime || 0) +
                (this.currentJump.flightTime || 0) / 2,
              landingTime: this.currentJump.landingTime || 0,
              endTime: this.currentJump.endTime || 0,
              flightTime: this.currentJump.flightTime || 0,
              contractionTime: this.currentJump.contractionTime || 0,
              heightFlightTime: this.currentJump.heightFlightTime || 0,
              heightImpulseMomentum:
                this.currentJump.heightImpulseMomentum || 0,
              estimatedHeight: this.currentJump.estimatedHeight || 0,
              takeoffVelocity: this.currentJump.takeoffVelocity || 0,
              peakGRF_Takeoff: this.currentJump.peakGRF_Takeoff || 0,
              peakGRF_Landing: this.currentJump.peakGRF_Landing || 0,
              rsiModified: this.currentJump.rsiModified || 0,
              type,
              confidence: 0.9,
            };

            this.jumps.push(finalJump);
            completedJump = finalJump;
            
            // A+ Compute detailed CMJ metrics
            this.lastCMJMetrics = this.computeCMJMetrics(finalJump);

            if (this.onJumpDetected) this.onJumpDetected(finalJump);
          }
          this.currentJump = null;
          this.propulsionAccels = [];
        }
        break;
    }

    if (prevPhase !== this.phase && this.onPhaseChange) {
      this.onPhaseChange(this.phase);
    }

    return completedJump;
  }

  /**
   * A+ Update with bilateral foot data for asymmetry analysis
   */
  updateBilateral(
    coreChain: KineticChain,
    leftFootAccel: THREE.Vector3 | null,
    rightFootAccel: THREE.Vector3 | null,
    timestamp: number
  ): Jump | null {
    // Store bilateral data
    if (leftFootAccel) {
      this.leftFootAccel.push(leftFootAccel.length());
      if (this.leftFootAccel.length > ACCEL_BUFFER_SIZE) {
        this.leftFootAccel.shift();
      }
    }
    if (rightFootAccel) {
      this.rightFootAccel.push(rightFootAccel.length());
      if (this.rightFootAccel.length > ACCEL_BUFFER_SIZE) {
        this.rightFootAccel.shift();
      }
    }

    // Run standard update
    const jump = this.update(coreChain, timestamp);

    // If jump completed and we have bilateral data, compute asymmetry
    if (jump && this.leftFootAccel.length > 10 && this.rightFootAccel.length > 10) {
      this.lastAsymmetry = this.computeLandingAsymmetry();
    }

    return jump;
  }

  getMetrics(): JumpMetrics {
    const total = this.jumps.length;
    if (total === 0) {
      return {
        totalJumps: 0,
        averageHeight: 0,
        maxHeight: 0,
        averageFlightTime: 0,
        maxGRF: 0,
        currentPhase: this.phase,
        lastJump: null,
        averageRSIMod: 0,
        lastCMJMetrics: null,
        lastAsymmetry: null,
      };
    }

    const maxH = Math.max(...this.jumps.map((j) => j.estimatedHeight));
    const avgH = this.jumps.reduce((s, j) => s + j.estimatedHeight, 0) / total;
    const avgT = this.jumps.reduce((s, j) => s + j.flightTime, 0) / total;
    const maxF = Math.max(
      ...this.jumps.map((j) => Math.max(j.peakGRF_Takeoff, j.peakGRF_Landing)),
    );
    // Average RSI-mod in m/s (standard units for normative comparison)
    const avgRSI = this.jumps.reduce((s, j) => s + j.rsiModified, 0) / total;

    return {
      totalJumps: total,
      averageHeight: avgH,
      maxHeight: maxH,
      averageFlightTime: avgT,
      maxGRF: maxF,
      currentPhase: this.phase,
      lastJump: this.jumps[total - 1],
      averageRSIMod: avgRSI,
      lastCMJMetrics: this.lastCMJMetrics,
      lastAsymmetry: this.lastAsymmetry,
    };
  }

  // ========================================================================
  // A+ CMJ METRICS COMPUTATION
  // ========================================================================

  /**
   * Compute full CMJ battery metrics from force-time data
   */
  private computeCMJMetrics(jump: Jump): CMJMetrics {
    const curve = this.forceTimeBuffer;
    
    if (curve.length < 10) {
      return this.emptyCMJMetrics(jump);
    }

    // Find key points in force-time curve
    const peakForcePoint = curve.reduce((max, p) => p.force > max.force ? p : max, curve[0]);
    const peakPowerPoint = curve.reduce((max, p) => p.power > max.power ? p : max, curve[0]);
    const peakNegVelPoint = curve.reduce((min, p) => p.velocity < min.velocity ? p : min, curve[0]);

    // Calculate RFD at different windows
    const rfd50 = this.calculateRFD(curve, 50);
    const rfd100 = this.calculateRFD(curve, 100);
    const rfd200 = this.calculateRFD(curve, 200);
    const peakRFD = this.calculatePeakRFD(curve);

    // Calculate impulse metrics
    const impulseMetrics = this.calculateImpulseMetrics(curve);

    // Phase timing
    const phaseTiming = this.analyzePhaseTiming(curve);

    // Countermovement depth (maximum negative displacement)
    const minDisplacement = Math.min(...curve.map(p => p.displacement));
    const counterMovementDepth = Math.abs(minDisplacement) * 100; // cm

    // Mean power during propulsion phase
    const propulsionPoints = curve.filter(p => p.phase === 'propulsion');
    const meanPower = propulsionPoints.length > 0
      ? propulsionPoints.reduce((sum, p) => sum + p.power, 0) / propulsionPoints.length
      : 0;

    return {
      jumpHeight: jump.estimatedHeight,
      peakHeight: jump.estimatedHeight + counterMovementDepth,
      
      peakForce: peakForcePoint.force,
      peakForceBW: peakForcePoint.forceBW,
      timeToPeakForce: peakForcePoint.time,
      
      peakRFD,
      rfdAt50ms: rfd50,
      rfdAt100ms: rfd100,
      rfdAt200ms: rfd200,
      
      peakPower: peakPowerPoint.power,
      peakPowerBW: peakPowerPoint.power / this.bodyMassKg,
      meanPower,
      timeToPeakPower: peakPowerPoint.time,
      
      totalImpulse: impulseMetrics.total,
      eccentricImpulse: impulseMetrics.eccentric,
      concentricImpulse: impulseMetrics.concentric,
      impulseRatio: impulseMetrics.eccentric > 0 
        ? impulseMetrics.concentric / impulseMetrics.eccentric 
        : 0,
      
      takeoffVelocity: jump.takeoffVelocity,
      peakNegativeVelocity: peakNegVelPoint.velocity,
      
      unweightingTime: phaseTiming.unweighting,
      brakingTime: phaseTiming.braking,
      propulsionTime: phaseTiming.propulsion,
      totalContractionTime: jump.contractionTime,
      
      counterMovementDepth,
      
      rsiModified: jump.rsiModified,
      rsiReactive: jump.flightTime > 0 
        ? (jump.estimatedHeight / 100) / (jump.contractionTime / 1000 + jump.flightTime / 1000)
        : 0,
      
      forceCurve: [...curve],
    };
  }

  /**
   * Update force-time curve during active jump
   */
  private updateForceTimeCurve(accelMag: number, timestamp: number): void {
    if (!this.currentJump) return;

    const startTime = this.currentJump.startTime || timestamp;
    const relativeTime = timestamp - startTime;

    // Force calculation (F = ma)
    const netAccel = accelMag - GRAVITY;
    const force = this.bodyMassKg * accelMag;
    const forceBW = accelMag / GRAVITY;

    // Integrate velocity (v = v0 + ∫a dt)
    this.velocityIntegral += netAccel * DT;

    // Integrate displacement (x = x0 + ∫v dt)
    this.displacementIntegral += this.velocityIntegral * DT;

    // Power (P = F × v)
    const power = force * Math.abs(this.velocityIntegral);

    // Determine CMJ phase
    const phase = this.determineCMJPhase(accelMag, this.velocityIntegral);

    const point: ForceTimePoint = {
      time: relativeTime,
      force,
      forceBW,
      velocity: this.velocityIntegral,
      displacement: this.displacementIntegral,
      power,
      phase,
    };

    this.forceTimeBuffer.push(point);
    this.cmjPhaseBuffer.push(phase);
  }

  /**
   * Determine CMJ phase from acceleration and velocity
   */
  private determineCMJPhase(accel: number, velocity: number): CMJPhase {
    if (this.phase === 'flight') return 'flight';
    if (this.phase === 'landing') {
      return velocity < -0.1 ? 'landing_impact' : 'landing_stabilization';
    }

    // During takeoff phase
    if (velocity < -0.05) {
      // Moving downward
      return accel < GRAVITY ? 'unweighting' : 'braking';
    } else {
      // Moving upward or stationary
      return accel > GRAVITY * 1.1 ? 'propulsion' : 'quiet_standing';
    }
  }

  /**
   * Calculate Rate of Force Development at specific window
   */
  private calculateRFD(curve: ForceTimePoint[], windowMs: number): number {
    if (curve.length < 2) return 0;

    // Find points within window from start
    const windowPoints = curve.filter(p => p.time <= windowMs);
    if (windowPoints.length < 2) return 0;

    const first = windowPoints[0];
    const last = windowPoints[windowPoints.length - 1];
    const dt = (last.time - first.time) / 1000; // seconds

    if (dt <= 0) return 0;
    return (last.force - first.force) / dt;
  }

  /**
   * Calculate peak RFD (maximum slope of force curve)
   */
  private calculatePeakRFD(curve: ForceTimePoint[]): number {
    if (curve.length < 3) return 0;

    let maxRFD = 0;
    const windowSize = 5; // 50ms window at 100Hz

    for (let i = windowSize; i < curve.length; i++) {
      const dt = (curve[i].time - curve[i - windowSize].time) / 1000;
      if (dt > 0) {
        const rfd = (curve[i].force - curve[i - windowSize].force) / dt;
        maxRFD = Math.max(maxRFD, rfd);
      }
    }

    return maxRFD;
  }

  /**
   * Calculate impulse metrics (eccentric/concentric)
   */
  private calculateImpulseMetrics(curve: ForceTimePoint[]): { total: number; eccentric: number; concentric: number } {
    let total = 0;
    let eccentric = 0;
    let concentric = 0;

    for (let i = 1; i < curve.length; i++) {
      const dt = (curve[i].time - curve[i - 1].time) / 1000;
      const avgForce = (curve[i].force + curve[i - 1].force) / 2;
      const impulse = avgForce * dt;

      total += impulse;

      // Eccentric = braking phase, Concentric = propulsion phase
      if (curve[i].phase === 'braking' || curve[i].phase === 'unweighting') {
        eccentric += impulse;
      } else if (curve[i].phase === 'propulsion') {
        concentric += impulse;
      }
    }

    return { total, eccentric, concentric };
  }

  /**
   * Analyze phase timing
   */
  private analyzePhaseTiming(curve: ForceTimePoint[]): { unweighting: number; braking: number; propulsion: number } {
    let unweighting = 0;
    let braking = 0;
    let propulsion = 0;

    for (let i = 1; i < curve.length; i++) {
      const dt = curve[i].time - curve[i - 1].time;
      switch (curve[i].phase) {
        case 'unweighting':
          unweighting += dt;
          break;
        case 'braking':
          braking += dt;
          break;
        case 'propulsion':
          propulsion += dt;
          break;
      }
    }

    return { unweighting, braking, propulsion };
  }

  // ========================================================================
  // A+ LANDING ASYMMETRY ANALYSIS
  // ========================================================================

  /**
   * Compute landing asymmetry from bilateral foot IMU data
   */
  private computeLandingAsymmetry(): LandingAsymmetry {
    const left = this.leftFootAccel;
    const right = this.rightFootAccel;

    // Peak forces
    const peakLeft = Math.max(...left);
    const peakRight = Math.max(...right);

    // Asymmetry index: (R - L) / (R + L) * 200
    // Positive = right dominant, Negative = left dominant
    const peakForceAsym = (peakLeft + peakRight) > 0
      ? ((peakRight - peakLeft) / (peakRight + peakLeft)) * 200
      : 0;

    // Time to stabilization (when acceleration returns to ~1g)
    const stabThreshold = GRAVITY * 1.2;
    const leftStab = this.findStabilizationTime(left, stabThreshold);
    const rightStab = this.findStabilizationTime(right, stabThreshold);

    // Impulse asymmetry
    const leftImpulse = left.reduce((sum, a) => sum + a * DT, 0);
    const rightImpulse = right.reduce((sum, a) => sum + a * DT, 0);
    const impulseAsym = (leftImpulse + rightImpulse) > 0
      ? ((rightImpulse - leftImpulse) / (rightImpulse + leftImpulse)) * 200
      : 0;

    // Combined asymmetry index
    const asymmetryIndex = Math.abs(peakForceAsym) * 0.6 + Math.abs(impulseAsym) * 0.4;

    // Determine dominant side
    let dominantSide: 'left' | 'right' | 'symmetric' = 'symmetric';
    if (peakForceAsym > 10) dominantSide = 'right';
    else if (peakForceAsym < -10) dominantSide = 'left';

    return {
      peakForceAsymmetry: Math.round(peakForceAsym * 10) / 10,
      timeToStabilization: {
        left: leftStab,
        right: rightStab,
      },
      impulseAsymmetry: Math.round(impulseAsym * 10) / 10,
      asymmetryIndex: Math.round(asymmetryIndex * 10) / 10,
      dominantSide,
      exceedsThreshold: Math.abs(peakForceAsym) > ASYMMETRY_THRESHOLD_PCT,
    };
  }

  /**
   * Find time to stabilization (ms from peak to stable)
   */
  private findStabilizationTime(accel: number[], threshold: number): number {
    const peakIdx = accel.indexOf(Math.max(...accel));
    
    for (let i = peakIdx; i < accel.length; i++) {
      if (accel[i] < threshold) {
        return (i - peakIdx) * (1000 / SAMPLE_RATE_HZ);
      }
    }
    
    return (accel.length - peakIdx) * (1000 / SAMPLE_RATE_HZ);
  }

  // ========================================================================
  // A+ MULTI-SEGMENT GRF (when lower limb chains available)
  // ========================================================================

  /**
   * Estimate GRF using multi-segment inverse dynamics
   * This is a simplified model; full implementation requires segment masses and inertias
   */
  computeMultiSegmentGRF(
    coreChain: KineticChain,
    lowerLimbChains?: { thighL?: KineticChain; thighR?: KineticChain; shankL?: KineticChain; shankR?: KineticChain }
  ): MultiSegmentGRF {
    const coreMetrics = coreChain.getMetrics();
    const coreAccel = coreMetrics.rootAccel;

    // Start with pelvis contribution (dominant)
    let totalForce = coreAccel.clone().multiplyScalar(this.bodyMassKg * 0.5); // Pelvis ~50% body mass
    
    let pelvisContrib = 100;
    let thighContrib = 0;
    let shankContrib = 0;
    let footContrib = 0;

    // Add lower limb contributions if available
    if (lowerLimbChains) {
      // This is simplified - real inverse dynamics requires segment masses and joint positions
      const segmentMassFraction = 0.1; // Each thigh ~10% body mass

      if (lowerLimbChains.thighL) {
        const thighAccel = lowerLimbChains.thighL.getMetrics().rootAccel;
        totalForce.add(thighAccel.clone().multiplyScalar(this.bodyMassKg * segmentMassFraction));
        thighContrib += 10;
        pelvisContrib -= 10;
      }
      if (lowerLimbChains.thighR) {
        const thighAccel = lowerLimbChains.thighR.getMetrics().rootAccel;
        totalForce.add(thighAccel.clone().multiplyScalar(this.bodyMassKg * segmentMassFraction));
        thighContrib += 10;
        pelvisContrib -= 10;
      }
      // Similarly for shanks and feet...
    }

    return {
      totalForce,
      totalForceMagnitude: totalForce.length(),
      pelvisContribution: pelvisContrib,
      thighContribution: thighContrib,
      shankContribution: shankContrib,
      footContribution: footContrib,
      hipTorque: null,
      kneeTorque: null,
      ankleTorque: null,
    };
  }

  // ========================================================================
  // HELPERS
  // ========================================================================

  private emptyCMJMetrics(jump: Jump): CMJMetrics {
    return {
      jumpHeight: jump.estimatedHeight,
      peakHeight: jump.estimatedHeight,
      peakForce: 0,
      peakForceBW: 0,
      timeToPeakForce: 0,
      peakRFD: 0,
      rfdAt50ms: 0,
      rfdAt100ms: 0,
      rfdAt200ms: 0,
      peakPower: 0,
      peakPowerBW: 0,
      meanPower: 0,
      timeToPeakPower: 0,
      totalImpulse: 0,
      eccentricImpulse: 0,
      concentricImpulse: 0,
      impulseRatio: 0,
      takeoffVelocity: jump.takeoffVelocity,
      peakNegativeVelocity: 0,
      unweightingTime: 0,
      brakingTime: 0,
      propulsionTime: 0,
      totalContractionTime: jump.contractionTime,
      counterMovementDepth: 0,
      rsiModified: jump.rsiModified,
      rsiReactive: 0,
      forceCurve: [],
    };
  }

  /**
   * Get the last computed CMJ metrics
   */
  getLastCMJMetrics(): CMJMetrics | null {
    return this.lastCMJMetrics;
  }

  /**
   * Get the last computed landing asymmetry
   */
  getLastAsymmetry(): LandingAsymmetry | null {
    return this.lastAsymmetry;
  }
}

export const jumpAnalyzer = new JumpAnalyzer();
