/**
 * RepetitionPhaseDetector
 * =======================
 * 
 * Detects phases of repetitive exercises (Squats, Lunges, Pushups).
 * Focuses on vertical displacement and direction changes.
 * 
 * Logic:
 * - Uses integrated Gyro (Orientation) + Accel or simple angular proxies.
 * - For lower body (Squat): Thigh Flexion/Extension angle is the most robust proxy.
 *   - Flexion increasing = Eccentric (Down)
 *   - Flexion decreasing = Concentric (Up)
 * 
 * @module analysis/RepetitionPhaseDetector
 */

import { KineticChain } from './KineticChain';
import type { RepetitionPhaseState, RepetitionPhaseType } from './MovementPhase';

export class RepetitionPhaseDetector {
    private currentPhase: RepetitionPhaseType = 'start';
    private lastDepth: number = 0;
    private maxDepth: number = 0; // Track deepest point of current rep

    // Config
    private startThreshold = 10; // degrees flexion
    private depthThreshold = 45; // degrees flexion considered "in rep"

    constructor() { }

    /**
     * Update phase based on chain metrics (specifically flexion angle)
     */
    update(chain: KineticChain, timestamp: number): RepetitionPhaseState {
        // Assume 'flexionAngle' in chain metrics is standardized (0 = straight/standing, 90 = seated)
        const currentFlexion = chain['metrics'].flexionAngle;
        const delta = currentFlexion - this.lastDepth;
        this.lastDepth = currentFlexion;

        let newPhase: RepetitionPhaseType = this.currentPhase;

        // 1. Standing / Start
        if (currentFlexion < this.startThreshold) {
            newPhase = 'start';
            this.maxDepth = 0;
        }
        // 2. In Repetition
        else {
            // Determine direction
            const isDescender = delta > 0.5; // Increasing flexion
            const isAscending = delta < -0.5; // Decreasing flexion

            if (isDescender) {
                newPhase = 'eccentric';
                if (currentFlexion > this.maxDepth) this.maxDepth = currentFlexion;
            } else if (isAscending) {
                newPhase = 'concentric';
            } else {
                // Velocity near zero
                if (currentFlexion > this.depthThreshold) {
                    newPhase = 'amortization'; // Holding at bottom
                } else {
                    // Holding near top or middle
                    // Keep previous phase state (hysteresis)
                }
            }
        }

        return {
            phase: newPhase,
            confidence: 0.8, // Placeholder
            depth: Math.min(1, currentFlexion / 90), // Normalized depth (0-1)
            timestamp
        };
    }

    reset() {
        this.currentPhase = 'start';
        this.lastDepth = 0;
        this.maxDepth = 0;
    }
}
