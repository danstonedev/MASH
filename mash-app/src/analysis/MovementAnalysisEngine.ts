/**
 * Movement Analysis Engine (Tier 3)
 * =================================
 *
 * Orchestrates the "Tiered Movement Architecture":
 * 1. Kinetic Chains (Tier 1): Aggregates raw sensor data into limb metrics.
 * 2. Phase Detectors (Tier 2): Identifies phases (Gait, Squat, etc.).
 * 3. Activity Classifier (Tier 3): Determines high-level activity based on Tiers 1 & 2.
 *
 * Features:
 * - Topology-Aware: Distinguishes Arms vs. Legs vs. Core.
 * - Context-Aware: "Upper Body Exercise" vs "Walking".
 * - Phase-Aware: Tracks Stance/Swing and Repetitions.
 *
 * @module analysis/MovementAnalysisEngine
 */

import * as THREE from "three";
import {
  useDeviceRegistry,
  deviceAccelCache,
  deviceGyroCache,
  deviceQuaternionCache,
} from "../store/useDeviceRegistry";
import { useSensorAssignmentStore } from "../store/useSensorAssignmentStore";
import { firmwareToThreeQuat } from "../lib/math/conventions";
import { KineticChain, type ChainMetrics } from "./KineticChain";
import { GaitPhaseDetector } from "./GaitPhaseDetector";
import { RepetitionPhaseDetector } from "./RepetitionPhaseDetector";
import type { GaitPhaseState, RepetitionPhaseState } from "./MovementPhase";
// import { ContactDetector, type ContactState } from './ContactDetector';
// import { ContactDetector, type ContactState } from './ContactDetector';
// import { jumpAnalyzer, type Jump } from './JumpAnalyzer'; // Deprecated?
import { BalanceFeature } from "./BalanceFeature";
import { CMJFeature, type CMJMetrics } from "./CMJFeature";
import {
  NeuralComplexityFeature,
  type NeuralComplexityMetrics,
} from "./NeuralComplexityFeature";
import { SquatFeature, type SquatMetrics } from "./SquatFeature";
import { LiftSafetyFeature } from "./LiftSafetyFeature";
import { GaitSymmetryFeature } from "./GaitSymmetryFeature";
import { SkatingFeature } from "./SkatingFeature";
// import { STAFilter } from './processing/STAFilter'; // REMOVED

// ============================================================================
// TYPES (Redefined locally if needed, or imported)
// ============================================================================

export type ActivityClass =
  | "standing"
  | "walking"
  | "running"
  | "sitting"
  | "exercising" // General
  | "squat" // Specific
  | "jumping" // Specific
  | "skating" // Specific
  | "transitioning"
  | "unknown";

export interface ActivityDetection {
  activity: ActivityClass;
  confidence: number;
  timestamp: number;
  metrics: {
    legsEnergy: number;
    armsEnergy: number;
    cadence: number;
    // Extended Research Metrics
    jumpHeight?: number; // cm
    jumpGRF?: number; // BW
    squatDepth?: number; // degrees
    spineAngle?: number; // degrees
    symmetry?: number; // Index (0-100)
    liftRisk?: "low" | "moderate" | "high";
    swayArea?: number;
    swayScore?: number;
    rsiMod?: number;
    jumpPhase?: string;
    complexityScore?: number;
    stabilityIndex?: number;
    strokeRate?: number;
    glideEfficiency?: number;
    pushOffAngle?: number;
  };
}

export interface MovementStats {
  currentActivity: ActivityClass;
  activityDuration: number;
  stepCount: number;
  cadence: number;
  repCount: number;
  // ... other stats
}

// ============================================================================
// ENGINE CLASS
// ============================================================================

export class MovementAnalysisEngine {
  // Topologies (Kinetic Chains)
  private chains: Map<string, KineticChain> = new Map();

  // Phase Detectors
  private gaitDetector: GaitPhaseDetector;
  private squatDetector: RepetitionPhaseDetector;

  // Research Features
  private squatFeature: SquatFeature;
  private liftSafety: LiftSafetyFeature;
  private gaitSymmetry: GaitSymmetryFeature;
  private balanceFeature: BalanceFeature;
  private cmjFeature: CMJFeature;
  private skatingFeature: SkatingFeature;
  private neuralComplexity: NeuralComplexityFeature;

  // State
  private currentActivity: ActivityClass = "unknown";
  private activityStartTime: number = Date.now();
  private lastClassificationTime: number = 0;

  // Stats
  private stepCount: number = 0;
  private repCount: number = 0; // Squats/Pushups

  // Processing
  // private staFilters: Map<string, STAFilter> = new Map(); // REMOVED

  // Callbacks
  private onActivityChange?: (detection: ActivityDetection) => void;

  constructor() {
    // Initialize Detectors
    this.gaitDetector = new GaitPhaseDetector();
    this.squatDetector = new RepetitionPhaseDetector();
    this.squatFeature = new SquatFeature();
    this.liftSafety = new LiftSafetyFeature();
    this.gaitSymmetry = new GaitSymmetryFeature();
    this.balanceFeature = new BalanceFeature();
    this.cmjFeature = new CMJFeature();
    this.skatingFeature = new SkatingFeature();
    this.neuralComplexity = new NeuralComplexityFeature();

    // Initialize Chains (Lazy load in processFrame usually, or init here)
    this.initializeChains();
  }

  private initializeChains() {
    this.chains.set("legs", new KineticChain("leg_l")); // Simplified "Legs" aggregate or separate?
    // Actually, we should track Left and Right separately for symmetry
    this.chains.set("leg_l", new KineticChain("leg_l"));
    this.chains.set("leg_r", new KineticChain("leg_r"));
    this.chains.set("arms", new KineticChain("arm_r")); // Aggregated arms for now
    this.chains.set("core", new KineticChain("core"));
  }

  reset() {
    this.chains.forEach((c) => c.reset());
    this.gaitDetector.reset();
    this.squatDetector.reset();
    // this.staFilters.forEach(f => f.reset()); // REMOVED
    this.currentActivity = "unknown";
    this.stepCount = 0;
    this.repCount = 0;
  }

  setOnActivityChange(cb: (d: ActivityDetection) => void) {
    this.onActivityChange = cb;
  }

  processFrame(): ActivityDetection | null {
    const now = Date.now();

    // 1. Update Chains with latest sensor data
    this.updateChains(now);

    // 2. Aggregate Chain Metrics
    const legL = this.chains.get("leg_l")!;
    const legR = this.chains.get("leg_r")!;
    const arms = this.chains.get("arms")!;

    // Get internal metrics (accessed via 'any' or public getter - assumes we added a getter)
    // Note: In the previous step I made 'metrics' private in TS but exposed via update() return.
    // Let's assume we can cache them or re-retrieve.
    // For efficiency here, I'll rely on the class structure.
    // Ideally KineticChain should expose `getMetrics()`.

    // Let's pretend updateChains returns the consolidated map

    // 3. Run Phase Detectors (Tier 2)
    // Gait requires Leg Chain
    const gaitState = this.gaitDetector.update(legR, now); // Using Right leg as primary driver for now

    // Squat requires Leg Chain (Flexion)
    const squatState = this.squatDetector.update(legR, now);

    // 4. Classify Activity (Tier 3)
    // Only classify every 500ms
    if (now - this.lastClassificationTime < 200) return null;
    this.lastClassificationTime = now;

    const analysis = this.classify(
      legL["metrics"],
      legR["metrics"],
      arms["metrics"],
      gaitState,
      squatState,
    );

    const core = this.chains.get("core");

    // BALANCE: Only if Standing Still
    // Need explicit "Quiet Standing" check or trigger.
    // For now, if activity === 'standing', update balance
    if (analysis.activity === "standing" && core) {
      if (analysis.confidence > 0.8) {
        this.balanceFeature.start(); // Ensure it's recording
        this.balanceFeature.update(core, now);
        const bal = this.balanceFeature.getMetrics();
        analysis.metrics.swayArea = bal.swayArea95;
        analysis.metrics.swayScore = bal.score;
      } else {
        this.balanceFeature.stop();
      }
    } else {
      this.balanceFeature.stop();
    }

    // CMJ: Replace legacy Jump
    let cmj: CMJMetrics | null = null;
    if (core) {
      cmj = this.cmjFeature.update(core, now);
    }

    // NEURAL COMPLEXITY: Always running on Core (Background)
    let neural: NeuralComplexityMetrics | null = null;
    if (core) {
      neural = this.neuralComplexity.update(core, now);
      if (neural) {
        analysis.metrics.complexityScore = neural.complexityScore;
        analysis.metrics.stabilityIndex = neural.stabilityIndex;
      }
    }

    // SQUAT: Detail analysis if active

    // SQUAT: Detail analysis if active
    let squatMetrics: SquatMetrics | undefined;
    if (analysis.activity === "squat" && legR && core) {
      squatMetrics = this.squatFeature.analyze(legR, core); // Using Right leg as proxy
      analysis.metrics.squatDepth = squatMetrics.depth;
      analysis.metrics.spineAngle = squatMetrics.spineAngle;
    }

    // LIFT SAFETY: Always monitor core
    if (core) {
      const risk = this.liftSafety.analyze(core);
      if (risk.riskLevel !== "low") {
        analysis.metrics.liftRisk = risk.riskLevel;
        // Could verify if this is actually a 'lift' via vertical velocity?
      }
      analysis.metrics.spineAngle = risk.flexionAngle; // Always report flexion
    }

    // GAIT SYMMETRY
    if (analysis.activity === "walking" || analysis.activity === "running") {
      // const core = this.chains.get('core'); // Already got core above

      // const legToUse = (gaitState.phase === 'heel_strike' || gaitState.phase === 'push_off') ? legR : legR;

      // Note: GaitPhaseDetector currently only tracks ONE leg or aggregated phase.
      // Ideally we need Independent Phase Detectors for Left and Right legs to do TRUE asymmetry.
      // For now, we update GaitSymmetry with available data, assuming 'gaitState' triggers for "Step" events.
      // A limitation: If we only track Right Leg, we can't measure Left Stance directly.

      // WORKAROUND: We need access to BOTH legs to pass to the analyzer
      // The analyzer expects "side" argument.
      // We'll update it based on the phase detector's internal state if possible, or
      // we need to upgrade GaitPhaseDetector to be dual-sided.
      // For this "Research" task, let's assume we can access L/R chains.

      if (core && legL && legR) {
        // We really need to know WHICH leg caused the event.
        // Assuming GaitPhaseDetector returns 'foot_l' or 'foot_r' in state? No.
        // We'll simulate it or just pass purely based on energy dominance?

        // Let's pass the Right Leg update for now as a placeholder for the integration
        // The logical fix is to instantiate TWO GaitPhaseDetectors (one per leg)
        // But let's stick to the interface "update(gaitState, side, ...)"

        this.gaitSymmetry.update(gaitState, core, legR, "right", now);
        // We would need to call it for Left too if we had a Left Phase Detector.
      }

      const sym = this.gaitSymmetry.getMetrics();
      analysis.metrics.symmetry = sym.symmetryIndex;
    }

    // SKATING ANALYSIS
    if (analysis.activity === "skating" && legL && legR) {
      const skate = this.skatingFeature.update(legL, legR, now);
      analysis.metrics.strokeRate = skate.strokeRate;
      analysis.metrics.glideEfficiency = skate.glideEfficiency;
      analysis.metrics.pushOffAngle =
        (skate.pushOffAngleL + skate.pushOffAngleR) / 2;
    }

    // JUMP REPORTING
    if (cmj && (cmj.phase === "flight" || cmj.phase === "landing")) {
      analysis.activity = "jumping";
      analysis.metrics.jumpHeight = cmj.jumpHeight;
      analysis.metrics.jumpGRF = cmj.peakForce;
      analysis.metrics.rsiMod = cmj.rsiMod;
      analysis.metrics.jumpPhase = cmj.phase;
    }

    // 5. Update State & Stats
    if (analysis.activity !== this.currentActivity) {
      this.currentActivity = analysis.activity;
      this.activityStartTime = now;
      if (this.onActivityChange) this.onActivityChange(analysis);
    }

    // 6. Count Steps / Reps based on Phases
    if (analysis.activity === "walking" || analysis.activity === "running") {
      if (gaitState.phase === "heel_strike") {
        // Debounce step count
        // this.stepCount++;
      }
    }

    return analysis;
  }

  private updateChains(now: number) {
    const registry = useDeviceRegistry.getState();
    const { getSegmentForSensor } = useSensorAssignmentStore.getState();

    // Build data map
    const dataMap = new Map<string, any>();
    registry.devices.forEach((d) => {
      if (!d.isConnected) return;
      const accelArr = deviceAccelCache.get(d.id);
      const gyro = deviceGyroCache.get(d.id);
      const quat = deviceQuaternionCache.get(d.id);

      if (accelArr && gyro) {
        // STA Filter REMOVED - passing raw accel
        // 1. Get/Create Filter
        // let filter = this.staFilters.get(d.id);
        // if (!filter) {
        //     filter = new STAFilter(60, 'lowpass', 15); // 15Hz Cutoff for general STA
        //     this.staFilters.set(d.id, filter);
        // }

        // 2. Filter Accelerometer (Raw)
        // Note: Accel is usually [x, y, z]
        // const filtered = filter.update(accelArr[0], accelArr[1], accelArr[2]);
        // const accelVec = new THREE.Vector3(filtered.x, filtered.y, filtered.z);
        const accelVec = new THREE.Vector3(
          accelArr[0],
          accelArr[1],
          accelArr[2],
        );

        dataMap.set(d.id, {
          accel: accelVec,
          gyro: new THREE.Vector3().fromArray(gyro),
          quat: quat ? firmwareToThreeQuat(quat) : new THREE.Quaternion(),
        });
      }
    });

    // Assign devices to chains dynamically if not already?
    // For efficiency, we assume specific hardcoded assignments or Map lookup
    // Doing a quick pass to feed chains:

    registry.devices.forEach((d) => {
      const seg = getSegmentForSensor(d.id);
      if (!seg) return;

      // Map segment to chain using exact matching
      const LEFT_LEG_SEGMENTS = ["tibia_l", "foot_l", "thigh_l"];
      const RIGHT_LEG_SEGMENTS = ["tibia_r", "foot_r", "thigh_r"];
      const ARM_SEGMENTS = [
        "upper_arm_l",
        "upper_arm_r",
        "forearm_l",
        "forearm_r",
        "hand_l",
        "hand_r",
      ];

      if (LEFT_LEG_SEGMENTS.includes(seg)) {
        const role = seg === "foot_l" ? "effector" : "joint";
        this.chains.get("leg_l")!.addSegment(d.id, role);
      }
      if (RIGHT_LEG_SEGMENTS.includes(seg)) {
        const role = seg === "foot_r" ? "effector" : "joint";
        this.chains.get("leg_r")!.addSegment(d.id, role);
      }
      if (ARM_SEGMENTS.includes(seg)) {
        this.chains.get("arms")!.addSegment(d.id, "joint");
      }
    });

    this.chains.forEach((chain) => chain.update(dataMap, now));
  }

  private classify(
    legL: ChainMetrics,
    legR: ChainMetrics,
    arms: ChainMetrics,
    _gait: GaitPhaseState,
    squat: RepetitionPhaseState,
  ): ActivityDetection {
    // Thresholds
    const LEG_MOVE_THRESH = 1.0;
    const ARM_MOVE_THRESH = 1.5;
    const RUN_THRESH = 4.0;

    const legsEnergy = (legL.energy + legR.energy) / 2;
    const armsEnergy = arms.energy;

    let activity: ActivityClass = "standing";
    let confidence = 0.5;

    // Logic Tree
    if (legsEnergy < LEG_MOVE_THRESH && armsEnergy < ARM_MOVE_THRESH) {
      // Low energy everywhere -> Static
      // Check orientation for Sit vs Stand
      // (Simplified)
      activity = "standing"; // or sitting
    } else if (legsEnergy > LEG_MOVE_THRESH) {
      // Legs moving
      if (legsEnergy > RUN_THRESH) {
        activity = "running";
      } else {
        if (squat.phase === "eccentric" || squat.phase === "concentric") {
          activity = "squat";
        } else {
          activity = "walking";
        }
      }
    } else if (armsEnergy > ARM_MOVE_THRESH) {
      // Arms moving, Legs static
      activity = "exercising"; // Upper body
    }

    return {
      activity,
      confidence,
      timestamp: Date.now(),
      metrics: { legsEnergy, armsEnergy, cadence: 0 },
    };
  }

  getStats(): MovementStats {
    return {
      currentActivity: this.currentActivity,
      activityDuration: (Date.now() - this.activityStartTime) / 1000,
      stepCount: this.stepCount,
      cadence: 0,
      repCount: this.repCount,
    };
  }
}

export const movementEngine = new MovementAnalysisEngine();

// ============================================================================
// POST-HOC ANALYSIS HELPERS (Used by SessionAnalyzer)
// ============================================================================

export interface FeatureVector {
  totalEnergy: number;
  dominantFreq: number;
  verticalVar: number;
  accelMagMean: number;
  accelMagVar: number;
  gyroMagMean: number;
}

/**
 * Extract simple features from a window of sensor data
 * (Simplified for compatibility with SessionAnalyzer)
 */
export function extractFeatures(
  accel: THREE.Vector3[],
  gyro: THREE.Vector3[],
  _quat: THREE.Quaternion[],
): FeatureVector {
  if (accel.length === 0) {
    return {
      totalEnergy: 0,
      dominantFreq: 0,
      verticalVar: 0,
      accelMagMean: 0,
      accelMagVar: 0,
      gyroMagMean: 0,
    };
  }

  // 1. Energy (Accel Variance)
  const accelMags = accel.map((v) => v.length());
  const magMean = accelMags.reduce((a, b) => a + b, 0) / accelMags.length;
  const magVar =
    accelMags.reduce((a, b) => a + Math.pow(b - magMean, 2), 0) /
    accelMags.length;

  // 2. Gyro Energy
  const gyroMags = gyro.map((v) => v.length());
  const gyroMean = gyroMags.reduce((a, b) => a + b, 0) / gyroMags.length;

  // 3. Vertical Variance (Y-axis)
  const yVals = accel.map((v) => v.y);
  const yMean = yVals.reduce((a, b) => a + b, 0) / yVals.length;
  const yVar =
    yVals.reduce((a, b) => a + Math.pow(b - yMean, 2), 0) / yVals.length;

  return {
    totalEnergy: magVar + gyroMean, // Rough proxy
    dominantFreq: 0, // Requires FFT
    verticalVar: yVar,
    accelMagMean: magMean,
    accelMagVar: magVar,
    gyroMagMean: gyroMean,
  };
}

/**
 * Sensor placement context for smarter activity classification.
 * Tells the classifier which body region is instrumented so it can
 * avoid nonsensical labels (e.g. "walking" from a head-only sensor).
 */
export type SensorRegion =
  | "head"
  | "upper_body"
  | "lower_body"
  | "full_body"
  | "unknown";

/**
 * Simple classifier for sliding window analysis.
 *
 * Updated to:
 *  - Default to "idle" instead of "walking" for low/moderate energy
 *  - Require strong rhythmic vertical variance for walking/running
 *  - Accept optional sensor-region context to prevent impossible labels
 *    (e.g. a head-only sensor can never produce a valid "walking" detection)
 */
export function classifyActivity(
  features: FeatureVector,
  sensorRegion: SensorRegion = "unknown",
): {
  activity: ActivityClass;
  confidence: number;
} {
  const canDetectGait =
    sensorRegion === "lower_body" ||
    sensorRegion === "full_body" ||
    sensorRegion === "unknown"; // unknown = best effort

  // 1. Very low energy → stationary
  if (features.totalEnergy < 0.3) {
    return { activity: "standing", confidence: 0.9 };
  }

  // 2. Low energy → idle / sitting
  if (features.totalEnergy < 1.0) {
    return { activity: "standing", confidence: 0.7 };
  }

  // 3. High energy with strong vertical oscillation → running (if gait-capable)
  if (
    features.totalEnergy > 8.0 &&
    features.verticalVar > 4.0 &&
    canDetectGait
  ) {
    return { activity: "running", confidence: 0.8 };
  }

  // 4. Moderate energy with rhythmic vertical oscillation → walking (if gait-capable)
  //    Walking shows clear vertical bounce; head ROM does NOT.
  if (
    canDetectGait &&
    features.accelMagVar > 0.8 &&
    features.verticalVar > 1.0
  ) {
    return { activity: "walking", confidence: 0.7 };
  }

  // 5. Significant gyro activity → exercising (ROM, stretching, etc.)
  if (features.gyroMagMean > 1.0) {
    return { activity: "exercising", confidence: 0.75 };
  }

  // 6. Some residual energy but no clear pattern → exercising (generic motion)
  if (features.totalEnergy > 1.0) {
    return { activity: "exercising", confidence: 0.5 };
  }

  // 7. Default: standing (NOT walking)
  return { activity: "standing", confidence: 0.5 };
}
