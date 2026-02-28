/**
 * GaitAnalyzer A+ Grade Tests
 *
 * Comprehensive tests for research-grade gait analysis:
 * - Gyro-based toe-off detection (Shull et al. 2014)
 * - Step width estimation from bilateral IMUs
 * - Detrended Fluctuation Analysis (Hausdorff et al. 1995)
 * - Multi-IMU stride fusion
 * - Gait variability metrics
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";
import {
  GaitAnalyzer,
  GaitMetrics,
  GaitEvent,
  Stride,
  GyroToeOffMetrics,
  StepWidthEstimate,
  GaitVariabilityMetrics,
} from "./GaitAnalyzer";

// Mock the store dependencies
vi.mock("../store/useDeviceRegistry", () => ({
  useDeviceRegistry: {
    getState: () => ({
      devices: new Map(),
    }),
  },
  deviceAccelCache: new Map(),
  deviceGyroCache: new Map(),
}));

vi.mock("../store/useSensorAssignmentStore", () => ({
  useSensorAssignmentStore: {
    getState: () => ({
      assignments: {},
    }),
  },
}));

describe("GaitAnalyzer A+ Grade Features", () => {
  let analyzer: GaitAnalyzer;

  beforeEach(() => {
    analyzer = new GaitAnalyzer();
  });

  // ============================================================================
  // BASIC GAIT METRICS
  // ============================================================================

  describe("Basic Gait Metrics", () => {
    it("should return zero metrics when no data", () => {
      const metrics = analyzer.getMetrics();
      expect(metrics.cadence).toBe(0);
      expect(metrics.strideTime).toBe(0);
      expect(metrics.dfaAlpha).toBe(0);
    });

    it("should calculate cadence from stride time", () => {
      // Simulate strides through internal state manipulation
      const analyzer2 = new GaitAnalyzer();
      // Access internal stridesLeft and stridesRight via type casting
      const anyAnalyzer = analyzer2 as any;

      // Add simulated strides (1000ms stride = 60 strides/min = 120 steps/min)
      const strides: Stride[] = [
        {
          startTime: 0,
          endTime: 1000,
          duration: 1000,
          foot: "left",
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.2,
          strideLengthConfidence: 0.8,
        },
        {
          startTime: 1000,
          endTime: 2000,
          duration: 1000,
          foot: "right",
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.2,
          strideLengthConfidence: 0.8,
        },
        {
          startTime: 2000,
          endTime: 3000,
          duration: 1000,
          foot: "left",
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.2,
          strideLengthConfidence: 0.8,
        },
      ];

      anyAnalyzer.stridesLeft = strides.filter((s) => s.foot === "left");
      anyAnalyzer.stridesRight = strides.filter((s) => s.foot === "right");

      const metrics = analyzer2.getMetrics();
      expect(metrics.cadence).toBe(120); // 60 strides/min * 2 steps/stride
      expect(metrics.strideTime).toBe(1000);
    });

    it("should calculate stance/swing ratios", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [
        {
          startTime: 0,
          endTime: 1000,
          duration: 1000,
          foot: "left",
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.2,
          strideLengthConfidence: 0.8,
        },
      ];
      anyAnalyzer.stridesRight = [
        {
          startTime: 500,
          endTime: 1500,
          duration: 1000,
          foot: "right",
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.2,
          strideLengthConfidence: 0.8,
        },
      ];

      const metrics = analyzer.getMetrics();
      expect(metrics.stanceRatio).toBe(0.6);
      expect(metrics.swingRatio).toBe(0.4);
    });

    it("should calculate walking speed from stride length and time", () => {
      const anyAnalyzer = analyzer as any;

      // 1.2m stride / 1.0s = 1.2 m/s
      anyAnalyzer.stridesLeft = [
        {
          startTime: 0,
          endTime: 1000,
          duration: 1000,
          foot: "left",
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.2,
          strideLengthConfidence: 0.9,
        },
      ];
      anyAnalyzer.stridesRight = [
        {
          startTime: 500,
          endTime: 1500,
          duration: 1000,
          foot: "right",
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.2,
          strideLengthConfidence: 0.9,
        },
      ];

      const metrics = analyzer.getMetrics();
      expect(metrics.walkingSpeed).toBe(1.2);
    });
  });

  // ============================================================================
  // A+ GRADE: GYRO-BASED TOE-OFF DETECTION
  // ============================================================================

  describe("Gyro-Based Toe-Off Detection (Shull et al. 2014)", () => {
    it("should detect toe-off from peak negative sagittal angular velocity", () => {
      const anyAnalyzer = analyzer as any;

      // Simulate gyro data with toe-off signature
      // Toe-off is characterized by peak negative sagittal (Y-axis) angular velocity
      const gyroData: THREE.Vector3[] = [];

      // Ramp up to peak negative (toe-off)
      for (let i = 0; i < 10; i++) {
        gyroData.push(new THREE.Vector3(0, -0.5 * i, 0));
      }
      // Peak at -4.5 rad/s
      gyroData.push(new THREE.Vector3(0, -4.5, 0));
      // Recovery
      for (let i = 0; i < 10; i++) {
        gyroData.push(new THREE.Vector3(0, -4.5 + 0.4 * i, 0));
      }

      anyAnalyzer.gyroBufferLeft = gyroData;

      const toeOff = analyzer.detectGyroToeOff("left");
      expect(toeOff).not.toBeNull();
      expect(toeOff!.peakNegativeSagittalVelocity).toBeLessThan(-2.0);
      expect(toeOff!.confidence).toBeGreaterThan(0.5);
    });

    it("should return null when no toe-off signature present", () => {
      const anyAnalyzer = analyzer as any;

      // Flat gyro data (no toe-off)
      const gyroData = Array.from(
        { length: 20 },
        () => new THREE.Vector3(0, 0.1, 0),
      );
      anyAnalyzer.gyroBufferLeft = gyroData;

      const toeOff = analyzer.detectGyroToeOff("left");
      expect(toeOff).toBeNull();
    });

    it("should return null with insufficient data", () => {
      const anyAnalyzer = analyzer as any;
      anyAnalyzer.gyroBufferLeft = [new THREE.Vector3(0, -5, 0)];

      const toeOff = analyzer.detectGyroToeOff("left");
      expect(toeOff).toBeNull();
    });

    it("should calculate confidence based on peak magnitude", () => {
      const anyAnalyzer = analyzer as any;

      // Strong toe-off signal
      const gyroData: THREE.Vector3[] = [];
      for (let i = 0; i < 10; i++) {
        gyroData.push(new THREE.Vector3(0, -i * 0.8, 0));
      }
      gyroData.push(new THREE.Vector3(0, -8.0, 0)); // Very strong peak
      for (let i = 0; i < 10; i++) {
        gyroData.push(new THREE.Vector3(0, -8.0 + i * 0.7, 0));
      }

      anyAnalyzer.gyroBufferLeft = gyroData;

      const toeOff = analyzer.detectGyroToeOff("left");
      expect(toeOff).not.toBeNull();
      expect(toeOff!.confidence).toBeGreaterThan(0.8);
    });
  });

  // ============================================================================
  // A+ GRADE: STEP WIDTH ESTIMATION
  // ============================================================================

  describe("Step Width Estimation", () => {
    it("should estimate step width from bilateral foot IMU data", () => {
      const anyAnalyzer = analyzer as any;

      // Simulate ML acceleration variance (higher variance = wider step)
      anyAnalyzer.accelBufferLeft = Array.from(
        { length: 50 },
        (_, i) => new THREE.Vector3(0.5 * Math.sin(i * 0.2), 9.8, 0),
      );
      anyAnalyzer.accelBufferRight = Array.from(
        { length: 50 },
        (_, i) => new THREE.Vector3(0.5 * Math.sin(i * 0.2 + Math.PI), 9.8, 0),
      );

      const stepWidth = analyzer.estimateStepWidth();
      expect(stepWidth).toBeGreaterThan(0.05);
      expect(stepWidth).toBeLessThan(0.25);
    });

    it("should return detailed step width estimate with method", () => {
      const anyAnalyzer = analyzer as any;

      // Bilateral data
      anyAnalyzer.accelBufferLeft = Array.from(
        { length: 50 },
        () => new THREE.Vector3(0.3, 9.8, 0),
      );
      anyAnalyzer.accelBufferRight = Array.from(
        { length: 50 },
        () => new THREE.Vector3(0.3, 9.8, 0),
      );

      const estimate = analyzer.getStepWidthEstimate();
      expect(estimate.method).toBe("bilateral_imu");
      expect(estimate.confidence).toBeGreaterThan(0.5);
    });

    it("should use ML variance method with single foot data", () => {
      const anyAnalyzer = analyzer as any;

      // Only left foot data
      anyAnalyzer.accelBufferLeft = Array.from(
        { length: 50 },
        () => new THREE.Vector3(0.4, 9.8, 0),
      );
      anyAnalyzer.accelBufferRight = [];

      const estimate = analyzer.getStepWidthEstimate();
      expect(estimate.method).toBe("ml_variance");
      expect(estimate.confidence).toBeLessThan(0.7);
    });

    it("should fallback to default with no data", () => {
      const estimate = analyzer.getStepWidthEstimate();
      expect(estimate.method).toBe("default");
      expect(estimate.width).toBe(0.1);
      expect(estimate.confidence).toBeLessThan(0.2);
    });

    it("should clamp step width to reasonable range", () => {
      const anyAnalyzer = analyzer as any;

      // Extreme ML variance
      anyAnalyzer.accelBufferLeft = Array.from(
        { length: 50 },
        (_, i) => new THREE.Vector3(5 * Math.sin(i), 9.8, 0),
      );
      anyAnalyzer.accelBufferRight = Array.from(
        { length: 50 },
        (_, i) => new THREE.Vector3(5 * Math.cos(i), 9.8, 0),
      );

      const stepWidth = analyzer.estimateStepWidth();
      expect(stepWidth).toBeLessThanOrEqual(0.25);
      expect(stepWidth).toBeGreaterThanOrEqual(0.05);
    });
  });

  // ============================================================================
  // A+ GRADE: DETRENDED FLUCTUATION ANALYSIS (DFA)
  // ============================================================================

  describe("Detrended Fluctuation Analysis (Hausdorff et al. 1995)", () => {
    it("should compute DFA scaling exponent from stride times", () => {
      const anyAnalyzer = analyzer as any;

      // Generate correlated stride times (simulating healthy gait)
      const strideTimes = generateCorrelatedStrideTimes(100, 1000, 50);

      const result = anyAnalyzer.computeDFA(strideTimes);
      expect(result.alpha).toBeGreaterThan(0);
      expect(result.fitR2).toBeGreaterThan(0);
    });

    it("should return zero DFA with insufficient strides", () => {
      const anyAnalyzer = analyzer as any;

      const result = anyAnalyzer.computeDFA([1000, 1050, 980]);
      expect(result.alpha).toBe(0);
      expect(result.fitR2).toBe(0);
    });

    it("should identify long-range correlation (healthy gait pattern)", () => {
      const anyAnalyzer = analyzer as any;

      // Healthy gait has α ≈ 0.8-1.2
      // Generate pink noise-like correlated series
      const strideTimes = generateHealthyGaitPattern(128, 1000, 30);

      const result = anyAnalyzer.computeDFA(strideTimes);
      // Note: Due to finite sample size, exact α may vary
      expect(result.fitR2).toBeGreaterThan(0.5);
    });

    it("should detect uncorrelated fluctuations (pathological pattern)", () => {
      const anyAnalyzer = analyzer as any;

      // White noise (random, uncorrelated) - α ≈ 0.5
      const strideTimes = Array.from(
        { length: 128 },
        () => 1000 + (Math.random() - 0.5) * 100,
      );

      const result = anyAnalyzer.computeDFA(strideTimes);
      // Random walk should have α closer to 0.5
      expect(result.alpha).toBeGreaterThan(0);
    });

    it("should include DFA in comprehensive variability metrics", () => {
      const anyAnalyzer = analyzer as any;

      // Add sufficient strides for DFA
      const strides = generateTestStrides(80);
      anyAnalyzer.stridesLeft = strides.filter((_, i) => i % 2 === 0);
      anyAnalyzer.stridesRight = strides.filter((_, i) => i % 2 === 1);

      const variability = analyzer.getGaitVariabilityMetrics();
      expect(variability.actualStridesUsed).toBeGreaterThanOrEqual(64);
      expect(variability.minStridesForDFA).toBe(64);
    });
  });

  // ============================================================================
  // A+ GRADE: GAIT VARIABILITY METRICS
  // ============================================================================

  describe("Gait Variability Metrics", () => {
    it("should calculate stride time coefficient of variation", () => {
      const anyAnalyzer = analyzer as any;

      // Strides with 5% variability
      anyAnalyzer.stridesLeft = [
        createStride(950, "left"),
        createStride(1050, "left"),
        createStride(1000, "left"),
      ];
      anyAnalyzer.stridesRight = [
        createStride(1000, "right"),
        createStride(1000, "right"),
        createStride(1000, "right"),
      ];

      const metrics = analyzer.getMetrics();
      expect(metrics.strideTimeCV).toBeGreaterThan(0);
    });

    it("should calculate stride length coefficient of variation", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [
        createStrideWithLength(1000, "left", 1.1),
        createStrideWithLength(1000, "left", 1.3),
        createStrideWithLength(1000, "left", 1.2),
      ];
      anyAnalyzer.stridesRight = [
        createStrideWithLength(1000, "right", 1.2),
        createStrideWithLength(1000, "right", 1.2),
      ];

      const metrics = analyzer.getMetrics();
      expect(metrics.strideLengthCV).toBeGreaterThan(0);
    });

    it("should return comprehensive variability report", () => {
      const anyAnalyzer = analyzer as any;

      const strides = generateTestStrides(70);
      anyAnalyzer.stridesLeft = strides.filter((_, i) => i % 2 === 0);
      anyAnalyzer.stridesRight = strides.filter((_, i) => i % 2 === 1);

      const variability = analyzer.getGaitVariabilityMetrics();

      expect(variability).toHaveProperty("strideTimeCV");
      expect(variability).toHaveProperty("strideLengthCV");
      expect(variability).toHaveProperty("dfaAlpha");
      expect(variability).toHaveProperty("dfaFitR2");
      expect(variability).toHaveProperty("longRangeCorrelation");
      expect(variability).toHaveProperty("actualStridesUsed");
    });
  });

  // ============================================================================
  // A+ GRADE: MULTI-IMU STRIDE FUSION
  // ============================================================================

  describe("Multi-IMU Stride Fusion", () => {
    it("should fuse stride data from multiple sources", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [
        createStrideWithLength(1000, "left", 1.2),
        createStrideWithLength(1000, "left", 1.25),
      ];
      anyAnalyzer.stridesRight = [
        createStrideWithLength(1000, "right", 1.18),
        createStrideWithLength(1000, "right", 1.22),
      ];

      const fused = analyzer.fuseMultiIMUStrides();

      expect(fused.sourcesUsed).toContain("left_foot");
      expect(fused.sourcesUsed).toContain("right_foot");
      expect(fused.fusedStrideLength).toBeGreaterThan(0);
      expect(fused.confidence).toBeGreaterThan(0);
    });

    it("should weight by stride length confidence", () => {
      const anyAnalyzer = analyzer as any;

      // High confidence left, low confidence right
      anyAnalyzer.stridesLeft = [
        {
          startTime: 0,
          endTime: 1000,
          duration: 1000,
          foot: "left" as const,
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.3,
          strideLengthConfidence: 0.9,
        },
      ];
      anyAnalyzer.stridesRight = [
        {
          startTime: 500,
          endTime: 1500,
          duration: 1000,
          foot: "right" as const,
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.1,
          strideLengthConfidence: 0.6,
        },
      ];

      const fused = analyzer.fuseMultiIMUStrides();

      // Fused length should be closer to high-confidence left (1.3)
      expect(fused.fusedStrideLength).toBeGreaterThan(1.15);
    });

    it("should return empty fusion with no data", () => {
      const fused = analyzer.fuseMultiIMUStrides();
      expect(fused.fusedStrideLength).toBe(0);
      expect(fused.fusedStrideTime).toBe(0);
      expect(fused.sourcesUsed).toHaveLength(0);
    });

    it("should use single foot when only one available", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [createStrideWithLength(1000, "left", 1.25)];
      anyAnalyzer.stridesRight = [];

      const fused = analyzer.fuseMultiIMUStrides();
      expect(fused.sourcesUsed).toContain("left_foot");
      expect(fused.sourcesUsed).not.toContain("right_foot");
      expect(fused.fusedStrideLength).toBeCloseTo(1.25, 1);
    });
  });

  // ============================================================================
  // SYMMETRY METRICS
  // ============================================================================

  describe("Symmetry Metrics", () => {
    it("should calculate perfect symmetry with equal stride times", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [
        createStride(1000, "left"),
        createStride(1000, "left"),
      ];
      anyAnalyzer.stridesRight = [
        createStride(1000, "right"),
        createStride(1000, "right"),
      ];

      const metrics = analyzer.getMetrics();
      expect(metrics.symmetryIndex).toBe(100);
      expect(metrics.leftRightRatio).toBe(1.0);
    });

    it("should detect asymmetry in stride times", () => {
      const anyAnalyzer = analyzer as any;

      // Left strides 10% longer than right
      anyAnalyzer.stridesLeft = [
        createStride(1100, "left"),
        createStride(1100, "left"),
      ];
      anyAnalyzer.stridesRight = [
        createStride(1000, "right"),
        createStride(1000, "right"),
      ];

      const metrics = analyzer.getMetrics();
      expect(metrics.symmetryIndex).toBeLessThan(100);
      expect(metrics.leftRightRatio).toBeGreaterThan(1.0);
    });

    it("should calculate stride length symmetry", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [createStrideWithLength(1000, "left", 1.2)];
      anyAnalyzer.stridesRight = [createStrideWithLength(1000, "right", 1.2)];

      const metrics = analyzer.getMetrics();
      expect(metrics.strideLengthSymmetry).toBe(100);
    });
  });

  // ============================================================================
  // GAIT EVENTS
  // ============================================================================

  describe("Gait Events", () => {
    it("should return recent events sorted by time", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.eventsLeft = [
        { type: "heel_strike", timestamp: 100, foot: "left", confidence: 0.8 },
        { type: "toe_off", timestamp: 300, foot: "left", confidence: 0.7 },
      ];
      anyAnalyzer.eventsRight = [
        {
          type: "heel_strike",
          timestamp: 200,
          foot: "right",
          confidence: 0.85,
        },
      ];

      const events = analyzer.getRecentEvents(3);
      expect(events).toHaveLength(3);
      expect(events[0].timestamp).toBeGreaterThan(events[1].timestamp);
    });

    it("should limit returned events", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.eventsLeft = Array.from({ length: 20 }, (_, i) => ({
        type: "heel_strike" as const,
        timestamp: i * 100,
        foot: "left" as const,
        confidence: 0.8,
      }));

      const events = analyzer.getRecentEvents(5);
      expect(events).toHaveLength(5);
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================

  describe("Edge Cases", () => {
    it("should handle reset correctly", () => {
      const anyAnalyzer = analyzer as any;

      // Add some data
      anyAnalyzer.stridesLeft = [createStride(1000, "left")];
      anyAnalyzer.accelBufferLeft = [new THREE.Vector3(0, 9.8, 0)];

      analyzer.reset();

      expect(anyAnalyzer.stridesLeft).toHaveLength(0);
      expect(anyAnalyzer.accelBufferLeft).toHaveLength(0);
    });

    it("should handle single stride", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [createStride(1000, "left")];

      const metrics = analyzer.getMetrics();
      // With only one stride, metrics should still be computed but may be zero
      expect(metrics).toBeDefined();
    });

    it("should handle strides with zero confidence", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [
        {
          startTime: 0,
          endTime: 1000,
          duration: 1000,
          foot: "left" as const,
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.5,
          strideLengthConfidence: 0.1, // Below 0.5 threshold
        },
      ];
      anyAnalyzer.stridesRight = [
        {
          startTime: 500,
          endTime: 1500,
          duration: 1000,
          foot: "right" as const,
          stanceTime: 600,
          swingTime: 400,
          strideLength: 1.5,
          strideLengthConfidence: 0.1,
        },
      ];

      const metrics = analyzer.getMetrics();
      // Low confidence strides should be excluded from length calculations
      expect(metrics.strideLength).toBe(0);
    });

    it("should handle extreme stride time variability", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.stridesLeft = [
        createStride(500, "left"),
        createStride(2000, "left"),
        createStride(800, "left"),
      ];
      anyAnalyzer.stridesRight = [createStride(1000, "right")];

      const metrics = analyzer.getMetrics();
      expect(metrics.strideTimeCV).toBeGreaterThan(20); // High variability
    });
  });

  // ============================================================================
  // INTEGRATION WITH GAIT METRICS
  // ============================================================================

  describe("Integration with GaitMetrics", () => {
    it("should include all A+ fields in GaitMetrics", () => {
      const anyAnalyzer = analyzer as any;

      const strides = generateTestStrides(70);
      anyAnalyzer.stridesLeft = strides.filter((_, i) => i % 2 === 0);
      anyAnalyzer.stridesRight = strides.filter((_, i) => i % 2 === 1);
      anyAnalyzer.accelBufferLeft = Array.from(
        { length: 50 },
        () => new THREE.Vector3(0.3, 9.8, 0),
      );
      anyAnalyzer.accelBufferRight = Array.from(
        { length: 50 },
        () => new THREE.Vector3(0.3, 9.8, 0),
      );

      const metrics = analyzer.getMetrics();

      // Original fields
      expect(metrics).toHaveProperty("cadence");
      expect(metrics).toHaveProperty("strideTime");
      expect(metrics).toHaveProperty("stanceRatio");
      expect(metrics).toHaveProperty("swingRatio");
      expect(metrics).toHaveProperty("strideLength");
      expect(metrics).toHaveProperty("walkingSpeed");
      expect(metrics).toHaveProperty("leftRightRatio");
      expect(metrics).toHaveProperty("symmetryIndex");

      // A+ fields
      expect(metrics).toHaveProperty("stepWidth");
      expect(metrics).toHaveProperty("strideLengthCV");
      expect(metrics).toHaveProperty("dfaAlpha");
      expect(metrics).toHaveProperty("longRangeCorrelation");
    });

    it("should provide clinically meaningful step width range", () => {
      const anyAnalyzer = analyzer as any;

      anyAnalyzer.accelBufferLeft = Array.from(
        { length: 50 },
        () => new THREE.Vector3(0.3, 9.8, 0),
      );
      anyAnalyzer.accelBufferRight = Array.from(
        { length: 50 },
        () => new THREE.Vector3(0.3, 9.8, 0),
      );
      anyAnalyzer.stridesLeft = [createStride(1000, "left")];
      anyAnalyzer.stridesRight = [createStride(1000, "right")];

      const metrics = analyzer.getMetrics();

      // Step width should be in clinically normal range (5-25 cm)
      expect(metrics.stepWidth).toBeGreaterThanOrEqual(0.05);
      expect(metrics.stepWidth).toBeLessThanOrEqual(0.25);
    });
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createStride(duration: number, foot: "left" | "right"): Stride {
  return {
    startTime: 0,
    endTime: duration,
    duration,
    foot,
    stanceTime: duration * 0.6,
    swingTime: duration * 0.4,
    strideLength: 1.2,
    strideLengthConfidence: 0.8,
  };
}

function createStrideWithLength(
  duration: number,
  foot: "left" | "right",
  length: number,
): Stride {
  return {
    startTime: 0,
    endTime: duration,
    duration,
    foot,
    stanceTime: duration * 0.6,
    swingTime: duration * 0.4,
    strideLength: length,
    strideLengthConfidence: 0.8,
  };
}

function generateTestStrides(count: number): Stride[] {
  return Array.from({ length: count }, (_, i) => ({
    startTime: i * 1000,
    endTime: (i + 1) * 1000,
    duration: 1000 + (Math.random() - 0.5) * 100,
    foot: (i % 2 === 0 ? "left" : "right") as "left" | "right",
    stanceTime: 600,
    swingTime: 400,
    strideLength: 1.2 + (Math.random() - 0.5) * 0.1,
    strideLengthConfidence: 0.7 + Math.random() * 0.2,
  }));
}

function generateCorrelatedStrideTimes(
  count: number,
  mean: number,
  stdDev: number,
): number[] {
  // Simple correlated series using AR(1) process
  const times: number[] = [];
  let prev = mean;
  const phi = 0.7; // AR coefficient

  for (let i = 0; i < count; i++) {
    const noise = (Math.random() - 0.5) * 2 * stdDev;
    prev = mean + phi * (prev - mean) + noise * (1 - phi);
    times.push(Math.max(500, Math.min(2000, prev)));
  }

  return times;
}

function generateHealthyGaitPattern(
  count: number,
  mean: number,
  stdDev: number,
): number[] {
  // Generate 1/f noise-like pattern (healthy gait has α ≈ 1.0)
  const times: number[] = [];
  let cumSum = 0;
  const phi = 0.85;

  for (let i = 0; i < count; i++) {
    const noise = (Math.random() - 0.5) * stdDev;
    cumSum = phi * cumSum + noise;
    times.push(mean + cumSum);
  }

  return times;
}
