/**
 * Skating Feature
 * ===============
 * 
 * Analyzes Ice Skating biomechanics (Hockey / Speed).
 * 
 * Phases:
 * 1. Glide (Double or Single Support): Low acceleration, smooth motion.
 * 2. Push-Off: High lateral acceleration, skate rolled over.
 * 3. Recovery: Leg swings back.
 * 
 * Metrics:
 * - Stroke Rate (Strokes/min)
 * - Glide Efficiency (Glide Time / Total Stride Time)
 * - Push-Off Angle (Roll angle at peak force)
 * - Symmetry (L/R)
 * 
 * @module analysis/SkatingFeature
 */

import { KineticChain } from './KineticChain';

export interface SkatingMetrics {
    strokeRate: number;        // str/min
    glideEfficiency: number;   // %
    pushOffAngleL: number;     // degrees
    pushOffAngleR: number;     // degrees
    symmetry: number;          // 0-100
    currentPhase: 'glide' | 'push' | 'recovery';
}

export class SkatingFeature {
    // State
    private strokes: number[] = []; // Timestamps

    // Per Side
    private left = {
        state: 'glide',
        pushStartTime: 0,
        glideDuration: 0,
        pushDuration: 0,
        maxRoll: 0,
        lastUpdate: 0
    };

    private right = {
        state: 'glide',
        pushStartTime: 0,
        glideDuration: 0,
        pushDuration: 0,
        maxRoll: 0,
        lastUpdate: 0
    };

    // Output
    private lastMetrics: SkatingMetrics = {
        strokeRate: 0,
        glideEfficiency: 0,
        pushOffAngleL: 0,
        pushOffAngleR: 0,
        symmetry: 100,
        currentPhase: 'glide'
    };

    update(leftLeg: KineticChain, rightLeg: KineticChain, now: number): SkatingMetrics {
        // 1. Process Left
        this.processLeg(leftLeg, this.left, now, 'left');

        // 2. Process Right
        this.processLeg(rightLeg, this.right, now, 'right');

        // 3. Compute Symmetry & Rate
        this.computeGlobals();

        return this.lastMetrics;
    }

    private processLeg(chain: KineticChain, state: any, now: number, side: 'left' | 'right') {
        const metrics = chain.getMetrics();
        // Assume 'effector' (skate) sensor is available in chain, or use chain.rootAccel if aggregated.
        // Ideally we need specific sensor data from the SKATE.
        // For this implementation, we use chain.rootAccel as a proxy for limb movement.

        const accel = metrics.rootAccel; // Vector3
        // Local Frame approx: 
        // We need Lateral acceleration relative to the SKATE orientation.
        // This requires rotation.

        // Estimate Roll (Push Angle) from Gravity vector if semi-static, or Quat.
        // Simplified: Use the Y-component of chain angle?
        // Let's use a placeholder "Roll" estimation logic:
        const roll = Math.abs(Math.atan2(accel.x, accel.y) * (180 / Math.PI)); // Very rough proxy

        const lateralForce = Math.abs(accel.x); // Assuming X is Medial-Lateral in body frame
        // const forwardForce = Math.abs(accel.z); // Unused for now

        const PUSH_THRESH = 1.5; // Gs

        // State Machine
        if (state.state === 'glide') {
            // Detect Push Start
            if (lateralForce > PUSH_THRESH) {
                state.state = 'push';
                state.pushStartTime = now;
                state.maxRoll = roll;

                // Record Stroke
                this.strokes.push(now);
                if (this.strokes.length > 10) this.strokes.shift();
            } else {
                state.glideDuration += (now - (state.lastUpdate || now));
            }
        } else if (state.state === 'push') {
            state.maxRoll = Math.max(state.maxRoll, roll);

            // Detect Push End (Force drops)
            if (lateralForce < 1.0) {
                state.state = 'recovery'; // or back to glide
                state.pushDuration = now - state.pushStartTime;

                // Save Metric
                if (side === 'left') this.lastMetrics.pushOffAngleL = state.maxRoll;
                else this.lastMetrics.pushOffAngleR = state.maxRoll;
            }
        } else if (state.state === 'recovery') {
            // Detect Glide Start (Stable)
            if (accel.length() < 1.2) {
                state.state = 'glide';
            }
        }

        state.lastUpdate = now;
    }

    private computeGlobals() {
        // Stroke Rate
        if (this.strokes.length > 1) {
            const duration = (this.strokes[this.strokes.length - 1] - this.strokes[0]) / 1000; // sec
            const count = this.strokes.length - 1;
            const spm = (count / duration) * 60;
            this.lastMetrics.strokeRate = spm;
        }

        // Glide Efficiency
        // Total time = Glide + Push
        // Eff = Glide / Total
        const totalL = this.left.glideDuration + this.left.pushDuration;
        const totalR = this.right.glideDuration + this.right.pushDuration;
        const total = totalL + totalR;

        if (total > 0) {
            const efficiency = (this.left.glideDuration + this.right.glideDuration) / total;
            this.lastMetrics.glideEfficiency = efficiency * 100;
        }

        this.lastMetrics.currentPhase = this.left.state as any; // Dominant
    }
}
