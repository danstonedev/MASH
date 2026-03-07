/**
 * useMovementAnalysis - Bridge hook wrapping useMovementStore
 *
 * Provides live activity detection and metrics from the MovementAnalysisEngine
 * via the Zustand movement store.
 */

import { useMovementStore } from '../store/useMovementStore';
import type { ActivityDetection } from '../analysis/MovementAnalysisEngine';

interface MovementMetrics {
  strokeRate?: number;
  glideEfficiency?: number;
  squatDepth?: number;
  spineAngle?: number;
  balanceSway?: number;
  balanceScore?: number;
  swayArea?: number;
  swayScore?: number;
  jumpHeight?: number;
  rsiMod?: number;
  complexityScore?: number;
}

export function useMovementAnalysis(): {
  activity: ActivityDetection | null;
  metrics: MovementMetrics | null;
} {
  const currentActivity = useMovementStore((s) => s.currentActivity);
  const activityConfidence = useMovementStore((s) => s.activityConfidence);
  const sessionStats = useMovementStore((s) => s.sessionStats);
  const isActive = useMovementStore((s) => s.isActive);

  if (!isActive || currentActivity === 'unknown') {
    return { activity: null, metrics: null };
  }

  const activity: ActivityDetection = {
    activity: currentActivity,
    confidence: activityConfidence,
    timestamp: Date.now(),
    metrics: {
      legsEnergy: 0,
      armsEnergy: 0,
      cadence: 0,
    },
  };

  const metrics: MovementMetrics = {};

  return { activity, metrics };
}
