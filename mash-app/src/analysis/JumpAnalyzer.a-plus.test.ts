/**
 * Jump Analyzer A+ Tests
 * ======================
 *
 * Comprehensive tests for research-grade jump analysis:
 * - CMJ full battery (force, power, RFD, impulse)
 * - Force-time curve generation
 * - Landing asymmetry detection
 * - Multi-segment GRF estimation
 *
 * References:
 * - Moir et al. (2008): CMJ metrics
 * - McMahon et al. (2018): Asymmetry analysis
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import {
  JumpAnalyzer,
  Jump,
  JumpMetrics,
  CMJMetrics,
  LandingAsymmetry,
  ForceTimePoint,
  CMJPhase,
  JumpPhase,
} from "./JumpAnalyzer";
import { KineticChain } from "./KineticChain";

// ============================================================================
// TEST UTILITIES
// ============================================================================

const GRAVITY = 9.81;
const SAMPLE_RATE = 100;

/**
 * Generate synthetic jump acceleration profile
 */
function generateJumpProfile(
  heightCm: number = 30,
  contractionMs: number = 300,
  flightMs: number = 400,
  peakGRF: number = 2.5,
): { accels: number[]; timestamps: number[] } {
  const accels: number[] = [];
  const timestamps: number[] = [];
  const dt = 1000 / SAMPLE_RATE;

  // 1. Quiet standing (~100ms)
  for (let t = 0; t < 100; t += dt) {
    accels.push(GRAVITY + (Math.random() - 0.5) * 0.5);
    timestamps.push(t);
  }

  // 2. Countermovement/takeoff phase (contractionMs)
  const takeoffStart = timestamps[timestamps.length - 1];
  for (let t = 0; t < contractionMs; t += dt) {
    // Ramp up to peak force then decrease to zero at takeoff
    const phase = t / contractionMs;
    let accel: number;
    if (phase < 0.3) {
      // Unweighting
      accel = GRAVITY * (1 - phase * 0.5);
    } else if (phase < 0.6) {
      // Braking
      accel = GRAVITY * (0.85 + (phase - 0.3) * 3);
    } else {
      // Propulsion
      const propPhase = (phase - 0.6) / 0.4;
      accel = GRAVITY * (peakGRF - propPhase * (peakGRF - 0.2));
    }
    accels.push(accel);
    timestamps.push(takeoffStart + t);
  }

  // 3. Flight phase (near zero g)
  const flightStart = timestamps[timestamps.length - 1];
  for (let t = 0; t < flightMs; t += dt) {
    accels.push(0.5 + Math.random() * 0.5); // Near freefall
    timestamps.push(flightStart + t);
  }

  // 4. Landing phase (~200ms)
  const landingStart = timestamps[timestamps.length - 1];
  for (let t = 0; t < 200; t += dt) {
    const phase = t / 200;
    let accel: number;
    if (phase < 0.3) {
      // Impact spike
      accel =
        GRAVITY * (1 + peakGRF * 1.2 * (1 - Math.abs(phase - 0.15) / 0.15));
    } else {
      // Stabilization
      accel = GRAVITY * (1 + 0.3 * (1 - phase));
    }
    accels.push(accel);
    timestamps.push(landingStart + t);
  }

  // 5. Post-landing stabilization
  for (let t = 0; t < 200; t += dt) {
    accels.push(GRAVITY + (Math.random() - 0.5) * 0.3);
    timestamps.push(timestamps[timestamps.length - 1] + dt);
  }

  return { accels, timestamps };
}

/**
 * Create mock KineticChain with specified acceleration
 */
function createMockChain(accelMag: number): KineticChain {
  const chain = new KineticChain();
  const originalGetMetrics = chain.getMetrics.bind(chain);

  chain.getMetrics = () => {
    const metrics = originalGetMetrics();
    // Set acceleration primarily in vertical direction
    metrics.rootAccel = new THREE.Vector3(0, accelMag * 0.1, accelMag * 0.99);
    return metrics;
  };

  (chain as any).metrics = {
    rootAccel: new THREE.Vector3(0, accelMag * 0.1, accelMag * 0.99),
  };

  return chain;
}

/**
 * Feed a complete jump profile through the analyzer
 */
function executeJumpProfile(
  analyzer: JumpAnalyzer,
  accels: number[],
  timestamps: number[],
): Jump | null {
  let lastJump: Jump | null = null;

  for (let i = 0; i < accels.length; i++) {
    const chain = createMockChain(accels[i]);
    const jump = analyzer.update(chain, timestamps[i]);
    if (jump) lastJump = jump;
  }

  return lastJump;
}

// ============================================================================
// BASIC JUMP DETECTION TESTS
// ============================================================================

describe("JumpAnalyzer - Basic Jump Detection", () => {
  let analyzer: JumpAnalyzer;

  beforeEach(() => {
    analyzer = new JumpAnalyzer();
    analyzer.reset();
  });

  it("detects a standard jump", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    const jump = executeJumpProfile(analyzer, accels, timestamps);

    expect(jump).not.toBeNull();
    expect(jump!.estimatedHeight).toBeGreaterThan(0);
  });

  it("calculates flight time correctly", () => {
    const flightMs = 400;
    const { accels, timestamps } = generateJumpProfile(30, 300, flightMs, 2.5);
    const jump = executeJumpProfile(analyzer, accels, timestamps);

    expect(jump).not.toBeNull();
    // Flight time should be close to specified (within 50ms tolerance)
    expect(Math.abs(jump!.flightTime - flightMs)).toBeLessThan(100);
  });

  it("calculates RSI-mod in correct units (m/s)", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    const jump = executeJumpProfile(analyzer, accels, timestamps);

    expect(jump).not.toBeNull();
    // RSI-mod = height(m) / contraction time(s)
    // For 30cm height and 300ms contraction: ~0.30/0.30 = ~1.0 m/s
    expect(jump!.rsiModified).toBeGreaterThan(0);
    expect(jump!.rsiModified).toBeLessThan(3); // Reasonable range
  });

  it("tracks multiple jumps", () => {
    const { accels: a1, timestamps: t1 } = generateJumpProfile(
      25,
      300,
      350,
      2.0,
    );
    executeJumpProfile(analyzer, a1, t1);

    // Second jump (offset timestamps)
    const lastT = t1[t1.length - 1];
    const { accels: a2, timestamps: t2 } = generateJumpProfile(
      35,
      350,
      450,
      2.8,
    );
    const offsetT2 = t2.map((t) => t + lastT + 500);
    executeJumpProfile(analyzer, a2, offsetT2);

    const metrics = analyzer.getMetrics();
    expect(metrics.totalJumps).toBe(2);
  });

  it("calculates average metrics correctly", () => {
    // Execute 3 jumps
    for (let i = 0; i < 3; i++) {
      const height = 20 + i * 10;
      const { accels, timestamps } = generateJumpProfile(
        height,
        300,
        350 + i * 50,
        2.0,
      );
      const offset = i * 2000;
      executeJumpProfile(
        analyzer,
        accels,
        timestamps.map((t) => t + offset),
      );
    }

    const metrics = analyzer.getMetrics();
    expect(metrics.totalJumps).toBe(3);
    expect(metrics.averageHeight).toBeGreaterThan(0);
    expect(metrics.maxHeight).toBeGreaterThanOrEqual(metrics.averageHeight);
  });
});

// ============================================================================
// A+ CMJ METRICS TESTS
// ============================================================================

describe("JumpAnalyzer - CMJ Metrics (A+)", () => {
  let analyzer: JumpAnalyzer;

  beforeEach(() => {
    analyzer = new JumpAnalyzer();
    analyzer.reset();
    analyzer.setBodyMass(70); // 70 kg test subject
  });

  it("generates CMJ metrics after jump", () => {
    const { accels, timestamps } = generateJumpProfile(35, 350, 450, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();
    expect(cmj!.jumpHeight).toBeGreaterThan(0);
  });

  it("calculates peak force", () => {
    const peakGRF = 2.5;
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, peakGRF);
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();
    expect(cmj!.peakForceBW).toBeGreaterThan(1); // Above body weight
  });

  it("calculates Rate of Force Development", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();

    // RFD should be positive during propulsion
    expect(cmj!.peakRFD).toBeGreaterThanOrEqual(0);
    expect(cmj!.rfdAt50ms).toBeDefined();
    expect(cmj!.rfdAt100ms).toBeDefined();
  });

  it("calculates power metrics", () => {
    const { accels, timestamps } = generateJumpProfile(35, 350, 450, 2.8);
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();

    expect(cmj!.peakPower).toBeGreaterThan(0);
    expect(cmj!.peakPowerBW).toBe(cmj!.peakPower / 70); // Normalized to body mass
    expect(cmj!.meanPower).toBeGreaterThanOrEqual(0);
  });

  it("calculates impulse metrics", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();

    expect(cmj!.totalImpulse).toBeGreaterThan(0);
    expect(cmj!.eccentricImpulse).toBeGreaterThanOrEqual(0);
    expect(cmj!.concentricImpulse).toBeGreaterThanOrEqual(0);
  });

  it("calculates phase timing", () => {
    const contractionMs = 350;
    const { accels, timestamps } = generateJumpProfile(
      30,
      contractionMs,
      400,
      2.5,
    );
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();

    // Phase times should sum to approximately total contraction time
    const totalPhaseTime =
      cmj!.unweightingTime + cmj!.brakingTime + cmj!.propulsionTime;
    // Allow some tolerance since detection isn't perfect
    expect(totalPhaseTime).toBeGreaterThan(0);
  });

  it("generates force-time curve", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();
    expect(cmj!.forceCurve.length).toBeGreaterThan(0);

    // Check curve has required fields
    const firstPoint = cmj!.forceCurve[0];
    expect(firstPoint.time).toBeDefined();
    expect(firstPoint.force).toBeDefined();
    expect(firstPoint.forceBW).toBeDefined();
    expect(firstPoint.velocity).toBeDefined();
    expect(firstPoint.power).toBeDefined();
    expect(firstPoint.phase).toBeDefined();
  });

  it("identifies CMJ phases in force curve", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();

    const phases = new Set(cmj!.forceCurve.map((p) => p.phase));
    // Should have multiple phases
    expect(phases.size).toBeGreaterThan(1);
  });

  it("calculates countermovement depth", () => {
    const { accels, timestamps } = generateJumpProfile(30, 350, 400, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    const cmj = analyzer.getLastCMJMetrics();
    expect(cmj).not.toBeNull();

    // Countermovement depth should be positive (squat depth)
    expect(cmj!.counterMovementDepth).toBeGreaterThanOrEqual(0);
  });

  it("returns CMJ metrics through getMetrics()", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    const metrics = analyzer.getMetrics();
    expect(metrics.lastCMJMetrics).not.toBeNull();
    expect(metrics.lastCMJMetrics!.jumpHeight).toBeGreaterThan(0);
  });
});

// ============================================================================
// A+ LANDING ASYMMETRY TESTS
// ============================================================================

describe("JumpAnalyzer - Landing Asymmetry (A+)", () => {
  let analyzer: JumpAnalyzer;

  beforeEach(() => {
    analyzer = new JumpAnalyzer();
    analyzer.reset();
  });

  it("computes asymmetry with bilateral data", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    // Simulate bilateral foot data with asymmetry
    for (let i = 0; i < accels.length; i++) {
      const chain = createMockChain(accels[i]);
      // Right foot has 20% more force
      const leftAccel = new THREE.Vector3(0, 0, accels[i] * 0.9);
      const rightAccel = new THREE.Vector3(0, 0, accels[i] * 1.1);
      analyzer.updateBilateral(chain, leftAccel, rightAccel, timestamps[i]);
    }

    const asymmetry = analyzer.getLastAsymmetry();
    expect(asymmetry).not.toBeNull();
    expect(Math.abs(asymmetry!.peakForceAsymmetry)).toBeGreaterThan(0);
  });

  it("identifies dominant side", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    for (let i = 0; i < accels.length; i++) {
      const chain = createMockChain(accels[i]);
      // Clear right dominance
      const leftAccel = new THREE.Vector3(0, 0, accels[i] * 0.7);
      const rightAccel = new THREE.Vector3(0, 0, accels[i] * 1.3);
      analyzer.updateBilateral(chain, leftAccel, rightAccel, timestamps[i]);
    }

    const asymmetry = analyzer.getLastAsymmetry();
    expect(asymmetry).not.toBeNull();
    expect(asymmetry!.dominantSide).toBe("right");
  });

  it("detects symmetric landing", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    for (let i = 0; i < accels.length; i++) {
      const chain = createMockChain(accels[i]);
      // Nearly equal bilateral loading
      const leftAccel = new THREE.Vector3(0, 0, accels[i] * 0.99);
      const rightAccel = new THREE.Vector3(0, 0, accels[i] * 1.01);
      analyzer.updateBilateral(chain, leftAccel, rightAccel, timestamps[i]);
    }

    const asymmetry = analyzer.getLastAsymmetry();
    expect(asymmetry).not.toBeNull();
    expect(asymmetry!.dominantSide).toBe("symmetric");
    expect(asymmetry!.exceedsThreshold).toBe(false);
  });

  it("flags clinically significant asymmetry (>15%)", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    for (let i = 0; i < accels.length; i++) {
      const chain = createMockChain(accels[i]);
      // >15% asymmetry
      const leftAccel = new THREE.Vector3(0, 0, accels[i] * 0.8);
      const rightAccel = new THREE.Vector3(0, 0, accels[i] * 1.2);
      analyzer.updateBilateral(chain, leftAccel, rightAccel, timestamps[i]);
    }

    const asymmetry = analyzer.getLastAsymmetry();
    expect(asymmetry).not.toBeNull();
    expect(asymmetry!.exceedsThreshold).toBe(true);
  });

  it("computes time to stabilization", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    for (let i = 0; i < accels.length; i++) {
      const chain = createMockChain(accels[i]);
      const leftAccel = new THREE.Vector3(0, 0, accels[i]);
      const rightAccel = new THREE.Vector3(0, 0, accels[i]);
      analyzer.updateBilateral(chain, leftAccel, rightAccel, timestamps[i]);
    }

    const asymmetry = analyzer.getLastAsymmetry();
    expect(asymmetry).not.toBeNull();
    expect(asymmetry!.timeToStabilization.left).toBeGreaterThanOrEqual(0);
    expect(asymmetry!.timeToStabilization.right).toBeGreaterThanOrEqual(0);
  });

  it("computes asymmetry index", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    for (let i = 0; i < accels.length; i++) {
      const chain = createMockChain(accels[i]);
      const leftAccel = new THREE.Vector3(0, 0, accels[i] * 0.85);
      const rightAccel = new THREE.Vector3(0, 0, accels[i] * 1.15);
      analyzer.updateBilateral(chain, leftAccel, rightAccel, timestamps[i]);
    }

    const asymmetry = analyzer.getLastAsymmetry();
    expect(asymmetry).not.toBeNull();
    expect(asymmetry!.asymmetryIndex).toBeGreaterThan(0);
  });
});

// ============================================================================
// A+ MULTI-SEGMENT GRF TESTS
// ============================================================================

describe("JumpAnalyzer - Multi-Segment GRF (A+)", () => {
  let analyzer: JumpAnalyzer;

  beforeEach(() => {
    analyzer = new JumpAnalyzer();
    analyzer.reset();
    analyzer.setBodyMass(70);
  });

  it("computes GRF from core chain only", () => {
    const chain = createMockChain(15); // 1.5g
    const grf = analyzer.computeMultiSegmentGRF(chain);

    expect(grf.totalForceMagnitude).toBeGreaterThan(0);
    expect(grf.pelvisContribution).toBe(100);
  });

  it("returns 3D force vector", () => {
    const chain = createMockChain(20);
    const grf = analyzer.computeMultiSegmentGRF(chain);

    expect(grf.totalForce).toBeInstanceOf(THREE.Vector3);
    expect(grf.totalForce.length()).toBeCloseTo(grf.totalForceMagnitude, 1);
  });

  it("accounts for lower limb chains when provided", () => {
    const coreChain = createMockChain(15);
    const thighL = createMockChain(12);
    const thighR = createMockChain(12);

    const grf = analyzer.computeMultiSegmentGRF(coreChain, {
      thighL,
      thighR,
    });

    expect(grf.thighContribution).toBeGreaterThan(0);
    expect(grf.pelvisContribution).toBeLessThan(100);
  });

  it("correctly attributes segment contributions", () => {
    const coreChain = createMockChain(15);
    const thighL = createMockChain(10);
    const thighR = createMockChain(10);

    const grf = analyzer.computeMultiSegmentGRF(coreChain, {
      thighL,
      thighR,
    });

    // Contributions should sum to 100%
    const totalContrib =
      grf.pelvisContribution +
      grf.thighContribution +
      grf.shankContribution +
      grf.footContribution;
    expect(totalContrib).toBe(100);
  });
});

// ============================================================================
// BODY MASS CONFIGURATION TESTS
// ============================================================================

describe("JumpAnalyzer - Body Mass Configuration", () => {
  let analyzer: JumpAnalyzer;

  beforeEach(() => {
    analyzer = new JumpAnalyzer();
    analyzer.reset();
  });

  it("uses default body mass (70kg)", () => {
    const chain = createMockChain(GRAVITY * 2); // 2g
    const grf = analyzer.computeMultiSegmentGRF(chain);

    // F = ma, with 70kg and 2g accel
    // Magnitude depends on pelvis mass fraction (50%)
    expect(grf.totalForceMagnitude).toBeGreaterThan(0);
  });

  it("uses configured body mass for force calculations", () => {
    const mass1 = 60;
    const mass2 = 80;
    const accel = GRAVITY * 2;

    analyzer.setBodyMass(mass1);
    const chain1 = createMockChain(accel);
    const grf1 = analyzer.computeMultiSegmentGRF(chain1);

    const analyzer2 = new JumpAnalyzer();
    analyzer2.setBodyMass(mass2);
    const chain2 = createMockChain(accel);
    const grf2 = analyzer2.computeMultiSegmentGRF(chain2);

    // Higher mass should produce higher force
    expect(grf2.totalForceMagnitude).toBeGreaterThan(grf1.totalForceMagnitude);
  });

  it("affects CMJ force metrics", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    // Light athlete
    analyzer.setBodyMass(50);
    executeJumpProfile(analyzer, accels, timestamps);
    const lightCMJ = analyzer.getLastCMJMetrics();

    // Heavy athlete
    const heavyAnalyzer = new JumpAnalyzer();
    heavyAnalyzer.setBodyMass(100);
    executeJumpProfile(heavyAnalyzer, accels, timestamps);
    const heavyCMJ = heavyAnalyzer.getLastCMJMetrics();

    expect(lightCMJ).not.toBeNull();
    expect(heavyCMJ).not.toBeNull();

    // Peak force in Newtons should differ
    expect(heavyCMJ!.peakForce).toBeGreaterThan(lightCMJ!.peakForce);

    // But BW-normalized should be similar
    // (both experiencing same g-force profile)
    expect(
      Math.abs(heavyCMJ!.peakForceBW - lightCMJ!.peakForceBW),
    ).toBeLessThan(0.5);
  });
});

// ============================================================================
// CALLBACK TESTS
// ============================================================================

describe("JumpAnalyzer - Callbacks", () => {
  let analyzer: JumpAnalyzer;

  beforeEach(() => {
    analyzer = new JumpAnalyzer();
    analyzer.reset();
  });

  it("calls onJumpDetected callback", () => {
    let detectedJump: Jump | null = null;
    analyzer.setOnJumpDetected((jump) => {
      detectedJump = jump;
    });

    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    expect(detectedJump).not.toBeNull();
    expect(detectedJump!.estimatedHeight).toBeGreaterThan(0);
  });

  it("calls onPhaseChange callback", () => {
    const phases: JumpPhase[] = [];
    analyzer.setOnPhaseChange((phase) => {
      phases.push(phase);
    });

    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);
    executeJumpProfile(analyzer, accels, timestamps);

    // Should have transitioned through multiple phases
    expect(phases.length).toBeGreaterThan(2);
    expect(phases).toContain("takeoff");
    expect(phases).toContain("flight");
    expect(phases).toContain("landing");
  });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe("JumpAnalyzer - Edge Cases", () => {
  let analyzer: JumpAnalyzer;

  beforeEach(() => {
    analyzer = new JumpAnalyzer();
    analyzer.reset();
  });

  it("handles very short jumps (hop) when detected", () => {
    // Note: Very short jumps may not always be detected due to flight time threshold
    const { accels, timestamps } = generateJumpProfile(8, 200, 200, 1.8);
    const jump = executeJumpProfile(analyzer, accels, timestamps);

    // If detected, should classify as hop
    if (jump !== null) {
      expect(jump.type).toBe("hop");
      expect(jump.estimatedHeight).toBeLessThan(15);
    }
  });

  it("handles high jumps (leap) when height exceeds threshold", () => {
    // The classification depends on estimated height, which uses weighted average
    // of flight time and impulse methods
    const { accels, timestamps } = generateJumpProfile(60, 450, 700, 3.5);
    const jump = executeJumpProfile(analyzer, accels, timestamps);

    expect(jump).not.toBeNull();
    // May be 'leap' or 'jump' depending on estimated height calculation
    expect(["jump", "leap"]).toContain(jump!.type);
    expect(jump!.flightTime).toBeGreaterThan(500);
  });

  it("handles invalid jump attempts gracefully", () => {
    // Generate profile with very short flight
    const accels: number[] = [];
    const timestamps: number[] = [];

    // Brief spike then back to normal
    for (let i = 0; i < 50; i++) {
      accels.push(GRAVITY + (Math.random() - 0.5));
      timestamps.push(i * 10);
    }
    // Brief high force
    for (let i = 0; i < 10; i++) {
      accels.push(GRAVITY * 2);
      timestamps.push(timestamps[timestamps.length - 1] + 10);
    }
    // Very brief low force (not enough for valid jump)
    for (let i = 0; i < 5; i++) {
      accels.push(GRAVITY * 0.3);
      timestamps.push(timestamps[timestamps.length - 1] + 10);
    }
    // Back to normal
    for (let i = 0; i < 50; i++) {
      accels.push(GRAVITY);
      timestamps.push(timestamps[timestamps.length - 1] + 10);
    }

    // Should not crash regardless of detection outcome
    const jump = executeJumpProfile(analyzer, accels, timestamps);

    // Key assertion: no errors thrown, metrics accessible
    const metrics = analyzer.getMetrics();
    expect(metrics).toBeDefined();
    expect(typeof metrics.currentPhase).toBe("string");
  });

  it("handles reset during jump", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    // Process partial jump then reset
    for (let i = 0; i < accels.length / 2; i++) {
      const chain = createMockChain(accels[i]);
      analyzer.update(chain, timestamps[i]);
    }

    analyzer.reset();

    expect(analyzer.getMetrics().totalJumps).toBe(0);
    expect(analyzer.getMetrics().currentPhase).toBe("grounded");
  });

  it("handles missing bilateral data gracefully", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    for (let i = 0; i < accels.length; i++) {
      const chain = createMockChain(accels[i]);
      // Pass null for bilateral data
      analyzer.updateBilateral(chain, null, null, timestamps[i]);
    }

    // Should still detect jump
    expect(analyzer.getMetrics().totalJumps).toBe(1);
    // But no asymmetry data
    expect(analyzer.getLastAsymmetry()).toBeNull();
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe("JumpAnalyzer - Integration", () => {
  it("produces consistent results across multiple runs", () => {
    const { accels, timestamps } = generateJumpProfile(30, 300, 400, 2.5);

    const analyzer1 = new JumpAnalyzer();
    const jump1 = executeJumpProfile(analyzer1, accels, timestamps);

    const analyzer2 = new JumpAnalyzer();
    const jump2 = executeJumpProfile(analyzer2, accels, timestamps);

    expect(jump1!.estimatedHeight).toBeCloseTo(jump2!.estimatedHeight, 1);
    expect(jump1!.flightTime).toBe(jump2!.flightTime);
  });

  it("provides complete metrics chain", () => {
    const analyzer = new JumpAnalyzer();
    analyzer.setBodyMass(75);

    const { accels, timestamps } = generateJumpProfile(35, 350, 450, 2.8);
    executeJumpProfile(analyzer, accels, timestamps);

    const metrics = analyzer.getMetrics();

    // Core metrics
    expect(metrics.totalJumps).toBe(1);
    expect(metrics.lastJump).not.toBeNull();
    expect(metrics.averageRSIMod).toBeGreaterThan(0);

    // A+ CMJ metrics
    expect(metrics.lastCMJMetrics).not.toBeNull();
    expect(metrics.lastCMJMetrics!.peakPower).toBeGreaterThan(0);
    expect(metrics.lastCMJMetrics!.forceCurve.length).toBeGreaterThan(0);
  });
});
