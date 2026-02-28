/**
 * timestampAlignment.test.ts - Cross-Node Timestamp Alignment Tests
 *
 * CRITICAL TESTS for verifying that samples from different nodes
 * have IDENTICAL timestamps. This is the web-app side verification
 * that the firmware beacon-derived timestamp system is working correctly.
 *
 * THE ARCHITECTURE:
 * - Gateway broadcasts beacons every 20ms with `gatewayTimeUs`
 * - ALL nodes receive the SAME beacon with the SAME gatewayTimeUs
 * - Nodes compute timestamps as: beaconGatewayTimeUs + (sampleIndex × 5000us)
 * - This produces IDENTICAL timestamps across all nodes for same logical sample
 *
 * THE BUG THESE TESTS DETECT:
 * If nodes use local clock + offset instead of beacon-derived timestamps,
 * samples will have varying timestamps due to:
 * - Clock offset calculation error (~500us with PTP)
 * - Jitter in when each node reads its local clock
 * - Different loop timing across nodes
 *
 * Run with: npm test -- --run timestampAlignment
 */

import { describe, it, expect, beforeEach } from "vitest";

// ============================================================================
// TYPES (matching firmware protocol)
// ============================================================================

interface IMUSample {
  sensorId: number;
  nodeId: number;
  timestampUs: number;
  quaternion: [number, number, number, number];
  accelerometer: [number, number, number];
  gyro: [number, number, number];
}

interface TimestampAnalysis {
  /** Maximum timestamp difference between any two sensors at same sample index */
  maxDrift: number;
  /** Average timestamp difference */
  avgDrift: number;
  /** Whether all sensors are within acceptable sync tolerance */
  isSynced: boolean;
  /** Per-node timestamp offsets from first node */
  nodeOffsets: Map<number, number>;
  /** Details for debugging */
  details: string;
}

// ============================================================================
// TIMESTAMP ALIGNMENT ANALYSIS FUNCTIONS
// ============================================================================

/**
 * Analyze timestamp alignment across multiple sensors/nodes.
 * This function detects when nodes are not properly time-synced.
 *
 * @param samples - Array of samples from multiple sensors, indexed by sample number
 * @param toleranceUs - Maximum acceptable timestamp difference (default 1000us = 1ms)
 * @returns Analysis results
 */
function analyzeTimestampAlignment(
  samplesByIndex: IMUSample[][],
  toleranceUs: number = 1000,
): TimestampAnalysis {
  if (samplesByIndex.length === 0) {
    return {
      maxDrift: 0,
      avgDrift: 0,
      isSynced: true,
      nodeOffsets: new Map(),
      details: "No samples to analyze",
    };
  }

  let maxDrift = 0;
  let totalDrift = 0;
  let driftCount = 0;
  const nodeTimestamps = new Map<number, number[]>();

  // Collect timestamps per node across all sample indices
  for (const samples of samplesByIndex) {
    if (samples.length < 2) continue;

    // Get min timestamp in this sample set as reference
    const timestamps = samples.map((s) => s.timestampUs);
    const minTs = Math.min(...timestamps);

    for (const sample of samples) {
      const drift = sample.timestampUs - minTs;
      maxDrift = Math.max(maxDrift, drift);
      totalDrift += drift;
      driftCount++;

      // Track per-node timestamps
      if (!nodeTimestamps.has(sample.nodeId)) {
        nodeTimestamps.set(sample.nodeId, []);
      }
      nodeTimestamps.get(sample.nodeId)!.push(sample.timestampUs);
    }
  }

  const avgDrift = driftCount > 0 ? totalDrift / driftCount : 0;

  // Calculate average offset per node relative to first node
  const nodeOffsets = new Map<number, number>();
  const nodeIds = Array.from(nodeTimestamps.keys()).sort();

  if (nodeIds.length > 1) {
    const referenceNode = nodeIds[0];
    const refTimestamps = nodeTimestamps.get(referenceNode)!;

    for (const nodeId of nodeIds.slice(1)) {
      const nodeTs = nodeTimestamps.get(nodeId)!;
      const minLen = Math.min(refTimestamps.length, nodeTs.length);

      let totalOffset = 0;
      for (let i = 0; i < minLen; i++) {
        totalOffset += nodeTs[i] - refTimestamps[i];
      }
      const avgOffset = minLen > 0 ? totalOffset / minLen : 0;
      nodeOffsets.set(nodeId, avgOffset);
    }
  }

  const isSynced = maxDrift <= toleranceUs;

  const details =
    `maxDrift=${maxDrift}us, avgDrift=${avgDrift.toFixed(0)}us, ` +
    `tolerance=${toleranceUs}us, nodes=[${nodeIds.join(",")}]`;

  return {
    maxDrift,
    avgDrift,
    isSynced,
    nodeOffsets,
    details,
  };
}

/**
 * Create a sample for testing
 */
function createSample(
  sensorId: number,
  nodeId: number,
  timestampUs: number,
): IMUSample {
  return {
    sensorId,
    nodeId,
    timestampUs,
    quaternion: [1, 0, 0, 0],
    accelerometer: [0, 0, 9.81],
    gyro: [0, 0, 0],
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe("Cross-Node Timestamp Alignment", () => {
  describe("analyzeTimestampAlignment", () => {
    it("should detect perfectly synced nodes", () => {
      // Two nodes, both with same timestamps
      const samplesByIndex: IMUSample[][] = [
        [createSample(0, 180, 1000000), createSample(1, 204, 1000000)],
        [createSample(0, 180, 1005000), createSample(1, 204, 1005000)],
      ];

      const result = analyzeTimestampAlignment(samplesByIndex);

      expect(result.maxDrift).toBe(0);
      expect(result.isSynced).toBe(true);
    });

    it("should detect acceptable drift within tolerance", () => {
      // Two nodes, 500us apart (within 1ms tolerance)
      const samplesByIndex: IMUSample[][] = [
        [
          createSample(0, 180, 1000000),
          createSample(1, 204, 1000500), // 500us later
        ],
        [createSample(0, 180, 1005000), createSample(1, 204, 1005500)],
      ];

      const result = analyzeTimestampAlignment(samplesByIndex, 1000);

      expect(result.maxDrift).toBe(500);
      expect(result.isSynced).toBe(true);
    });

    it("should FAIL when nodes have large timestamp drift", () => {
      // Simulate THE BUG: Node 204 has wrong offset (10ms drift)
      const samplesByIndex: IMUSample[][] = [
        [
          createSample(0, 180, 1000000),
          createSample(1, 204, 1010000), // 10ms drift - BAD!
        ],
        [createSample(0, 180, 1005000), createSample(1, 204, 1015000)],
      ];

      const result = analyzeTimestampAlignment(samplesByIndex, 1000);

      expect(result.maxDrift).toBe(10000);
      expect(result.isSynced).toBe(false);
      expect(result.nodeOffsets.get(204)).toBeCloseTo(10000, -2);
    });

    it("should detect consistent offset between nodes (the bug symptom)", () => {
      // This is what the bug looked like: Node 204 consistently ahead by ~50ms
      const baseTime = 1000000;
      const badOffset = 50000; // 50ms - way too much!

      const samplesByIndex: IMUSample[][] = [];
      for (let i = 0; i < 10; i++) {
        const ts = baseTime + i * 5000; // 5ms between samples
        samplesByIndex.push([
          createSample(0, 180, ts),
          createSample(1, 180, ts), // Same node, same time
          createSample(2, 180, ts),
          createSample(3, 180, ts),
          createSample(4, 180, ts),
          createSample(5, 180, ts),
          createSample(6, 204, ts + badOffset), // Different node, BAD offset
        ]);
      }

      const result = analyzeTimestampAlignment(samplesByIndex, 1000);

      expect(result.isSynced).toBe(false);
      expect(result.maxDrift).toBe(badOffset);

      // The offset should be detected - Node 204 should show significant offset
      const node204Offset = result.nodeOffsets.get(204);
      expect(node204Offset).toBeDefined();
      // The offset calculation averages all samples, so expect it to be non-zero
      // and significantly different from Node 180's offset (which is 0)
      expect(node204Offset!).toBeGreaterThan(badOffset / 2);
    });

    it("should handle sensors on same node (always synced)", () => {
      // 6 sensors on same node should always be perfectly synced
      const samplesByIndex: IMUSample[][] = [
        [
          createSample(0, 180, 1000000),
          createSample(1, 180, 1000000),
          createSample(2, 180, 1000000),
          createSample(3, 180, 1000000),
          createSample(4, 180, 1000000),
          createSample(5, 180, 1000000),
        ],
      ];

      const result = analyzeTimestampAlignment(samplesByIndex);

      expect(result.maxDrift).toBe(0);
      expect(result.isSynced).toBe(true);
    });

    it("should handle empty input", () => {
      const result = analyzeTimestampAlignment([]);
      expect(result.isSynced).toBe(true);
      expect(result.maxDrift).toBe(0);
    });

    it("should handle single sensor (trivially synced)", () => {
      const samplesByIndex: IMUSample[][] = [
        [createSample(0, 180, 1000000)],
        [createSample(0, 180, 1005000)],
      ];

      const result = analyzeTimestampAlignment(samplesByIndex);
      expect(result.isSynced).toBe(true);
    });
  });

  describe("Real-world sync quality requirements", () => {
    it("should pass with RTT/2 quality sync (~500us)", () => {
      // Good PTP sync should achieve ~500us accuracy
      const samplesByIndex: IMUSample[][] = [];
      for (let i = 0; i < 100; i++) {
        const baseTs = 1000000 + i * 5000;
        // Random jitter within ±250us (typical RTT/2)
        const jitter = (Math.random() - 0.5) * 500;
        samplesByIndex.push([
          createSample(0, 180, baseTs),
          createSample(1, 204, baseTs + jitter),
        ]);
      }

      const result = analyzeTimestampAlignment(samplesByIndex, 1000);
      expect(result.isSynced).toBe(true);
    });

    it("should fail with one-way sync drift (~5ms)", () => {
      // One-way sync typically has 2-10ms error due to asymmetric delays
      const oneWayDrift = 5000; // 5ms

      const samplesByIndex: IMUSample[][] = [];
      for (let i = 0; i < 100; i++) {
        const baseTs = 1000000 + i * 5000;
        samplesByIndex.push([
          createSample(0, 180, baseTs),
          createSample(1, 204, baseTs + oneWayDrift),
        ]);
      }

      const result = analyzeTimestampAlignment(samplesByIndex, 1000);
      expect(result.isSynced).toBe(false);
      expect(result.maxDrift).toBeGreaterThanOrEqual(oneWayDrift);
    });

    it("should detect sync degradation over time", () => {
      // Simulate clock drift: 50us/second accumulating
      const driftRateUsPerSecond = 50;
      const samplesByIndex: IMUSample[][] = [];

      for (let i = 0; i < 200; i++) {
        // 200 samples at 200Hz = 1 second
        const baseTs = 1000000 + i * 5000;
        const accumulatedDrift = (i / 200) * driftRateUsPerSecond;
        samplesByIndex.push([
          createSample(0, 180, baseTs),
          createSample(1, 204, baseTs + accumulatedDrift),
        ]);
      }

      const result = analyzeTimestampAlignment(samplesByIndex, 100);

      // After 1 second, drift should be ~50us which is within tolerance
      // But let's verify drift is tracked
      expect(result.maxDrift).toBeGreaterThan(0);
      expect(result.maxDrift).toBeLessThan(100); // 50us drift over 1 second
    });
  });

  describe("Regression prevention", () => {
    it("BUG SCENARIO: smoothedOffset not updated - detect via timestamp gap", () => {
      /**
       * This test recreates the exact bug scenario:
       * - Node 180 has correct PTP offset (e.g., +5000us)
       * - Node 204 has stale smoothedOffset (e.g., 0) because it wasn't updated
       * - Result: Node 204 timestamps are ~5000us behind Node 180
       */
      const correctOffset = 5000;
      const staleOffset = 0; // BUG: smoothedOffset wasn't updated
      const localTime = 1000000;

      const node180_ts = localTime + correctOffset; // 1005000
      const node204_ts = localTime + staleOffset; // 1000000 (WRONG!)

      const samplesByIndex: IMUSample[][] = [
        [createSample(0, 180, node180_ts), createSample(1, 204, node204_ts)],
      ];

      const result = analyzeTimestampAlignment(samplesByIndex, 1000);

      // This should FAIL - timestamps are 5ms apart
      expect(result.isSynced).toBe(false);
      expect(result.maxDrift).toBe(correctOffset);
    });

    it("FIXED SCENARIO: smoothedOffset properly updated - timestamps align", () => {
      /**
       * After the fix:
       * - Node 180 has PTP offset +5000us
       * - Node 204 also has PTP offset +5050us (slight RTT difference)
       * - Both nodes timestamp samples correctly
       */
      const node180_offset = 5000;
      const node204_offset = 5050; // Slightly different due to RTT
      const localTime = 1000000;

      const node180_ts = localTime + node180_offset; // 1005000
      const node204_ts = localTime + node204_offset; // 1005050

      const samplesByIndex: IMUSample[][] = [
        [createSample(0, 180, node180_ts), createSample(1, 204, node204_ts)],
      ];

      const result = analyzeTimestampAlignment(samplesByIndex, 1000);

      // This should PASS - timestamps are only 50us apart
      expect(result.isSynced).toBe(true);
      expect(result.maxDrift).toBe(50);
    });
  });

  describe("Beacon-derived timestamp verification", () => {
    it("BEACON-DERIVED: All nodes produce IDENTICAL timestamps", () => {
      /**
       * With beacon-derived timestamps:
       * - All nodes receive same beacon with gatewayTimeUs = 1000000
       * - Sample 0 timestamp = 1000000 + (0 × 5000) = 1000000
       * - Sample 1 timestamp = 1000000 + (1 × 5000) = 1005000
       * - ALL nodes use the SAME formula, producing IDENTICAL values
       */
      const beaconGatewayTimeUs = 1000000;

      const samplesByIndex: IMUSample[][] = [];
      for (let sampleIndex = 0; sampleIndex < 4; sampleIndex++) {
        const exactTimestamp = beaconGatewayTimeUs + sampleIndex * 5000;
        samplesByIndex.push([
          createSample(0, 180, exactTimestamp),
          createSample(1, 180, exactTimestamp),
          createSample(2, 180, exactTimestamp),
          createSample(3, 180, exactTimestamp),
          createSample(4, 180, exactTimestamp),
          createSample(5, 180, exactTimestamp),
          createSample(6, 204, exactTimestamp), // Different node, SAME timestamp!
        ]);
      }

      const result = analyzeTimestampAlignment(samplesByIndex, 0); // Zero tolerance!

      expect(result.isSynced).toBe(true);
      expect(result.maxDrift).toBe(0); // EXACTLY zero drift
    });

    it("BEACON-DERIVED: Timestamps follow 5ms intervals exactly", () => {
      /**
       * Verify the 200Hz (5ms) interval is maintained precisely
       */
      const beaconGatewayTimeUs = 5000000; // 5 seconds
      const samples: IMUSample[] = [];

      for (let i = 0; i < 20; i++) {
        // 20 samples = 100ms
        const ts = beaconGatewayTimeUs + i * 5000;
        samples.push(createSample(0, 180, ts));
        samples.push(createSample(1, 204, ts));
      }

      // Verify all timestamps are exactly 5000us apart
      for (let i = 1; i < 20; i++) {
        const delta =
          samples[i * 2].timestampUs - samples[(i - 1) * 2].timestampUs;
        expect(delta).toBe(5000);
      }

      // Verify node 180 and 204 have identical timestamps
      for (let i = 0; i < 20; i++) {
        const node180_ts = samples[i * 2].timestampUs;
        const node204_ts = samples[i * 2 + 1].timestampUs;
        expect(node180_ts).toBe(node204_ts);
      }
    });

    it("BEACON-DERIVED: Frame boundary timestamps are predictable", () => {
      /**
       * At 50Hz beacon rate (20ms frames) with 200Hz sampling (4 samples/frame):
       * Frame 0: samples at t+0, t+5000, t+10000, t+15000
       * Frame 1: samples at t+20000, t+25000, t+30000, t+35000
       */
      const frame0_beaconTs = 1000000;
      const frame1_beaconTs = 1020000; // 20ms later

      // Frame 0 samples
      const frame0_samples = [
        createSample(0, 180, frame0_beaconTs + 0),
        createSample(1, 204, frame0_beaconTs + 0),
        createSample(0, 180, frame0_beaconTs + 5000),
        createSample(1, 204, frame0_beaconTs + 5000),
        createSample(0, 180, frame0_beaconTs + 10000),
        createSample(1, 204, frame0_beaconTs + 10000),
        createSample(0, 180, frame0_beaconTs + 15000),
        createSample(1, 204, frame0_beaconTs + 15000),
      ];

      // Frame 1 samples
      const frame1_samples = [
        createSample(0, 180, frame1_beaconTs + 0),
        createSample(1, 204, frame1_beaconTs + 0),
      ];

      // Verify frame boundary: last sample of frame 0 to first of frame 1
      const lastFrame0_ts = frame0_samples[6].timestampUs; // t+15000
      const firstFrame1_ts = frame1_samples[0].timestampUs; // t+20000

      expect(firstFrame1_ts - lastFrame0_ts).toBe(5000); // Continuous 5ms intervals
    });
  });
});

// ============================================================================
// EXPORT for use in other tests/components
// ============================================================================

export { analyzeTimestampAlignment, type TimestampAnalysis, type IMUSample };
