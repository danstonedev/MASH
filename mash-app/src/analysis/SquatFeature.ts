/**
 * Squat Feature Analyzer
 * ======================
 * 
 * Analyzes Squat performance using Kinetic Chain data.
 * 
 * Features:
 * - Depth Estimation: Uses Thigh Pitch angle from LegChain.
 * - Form Monitoring: Uses Spine Pitch from CoreChain (Lumbar Flexion).
 * 
 * Logic:
 * - Thigh Pitch: 90 deg (Standing), 0 deg (Parallel), < 0 (Deep)
 * - Spine Pitch: 0 deg (Vertical/Neutral) -> Forward lean increases pitch.
 * 
 * @module analysis/SquatFeature
 */

import * as THREE from 'three';
import { KineticChain } from './KineticChain';

export interface SquatMetrics {
    depth: number;          // Thigh pitch degrees
    spineAngle: number;     // Spine pitch degrees
    isGoodForm: boolean;
    feedback: string[];
}

export class SquatFeature {
    analyze(legChain: KineticChain, coreChain: KineticChain): SquatMetrics {
        const legMetrics = legChain.getMetrics();
        const coreMetrics = coreChain.getMetrics();

        // Compute Thigh Pitch (Depth)
        // KineticChain exposes rootQuat (Pelvis/Thigh orientation)
        const thighQuat = legMetrics.rootQuat;
        const thighEuler = new THREE.Euler().setFromQuaternion(thighQuat, 'XYZ');
        // Assuming calibrated neutral is 0,0,0 and flexion is positive X?
        // Actually, T-Pose standard: Y is UP. 
        // Thigh (Femur) vector roughly Y-aligned?
        // Simplified: Pitch (X-axis rotation) is usually Flexion/Extension.
        // Let's use Euler X.
        const thighPitch = THREE.MathUtils.radToDeg(thighEuler.x);

        // Compute Spine Pitch (Form)
        const spineQuat = coreMetrics.rootQuat;
        const spineEuler = new THREE.Euler().setFromQuaternion(spineQuat, 'XYZ');
        const spinePitch = THREE.MathUtils.radToDeg(spineEuler.x);

        const feedback: string[] = [];
        let isGoodForm = true;

        // Depth Logic (Subjective thresholds, assuming 0 is neutral standing)
        // Standing: ~0
        // Squatting: Pitch increases (or decreases depending on chirality).
        // Let's assume Flexion is Positive.
        // Parallel Squat ~= 90 degrees change?
        // NO, standard biomechanics:
        // Standing: Femur is Vertical.
        // Squat: Femur becomes Horizontal.
        // So Pitch change is ~90 deg.

        // Feedack
        if (spinePitch > 45) {
            feedback.push('Excessive Forward Lean');
            isGoodForm = false;
        }

        return {
            depth: thighPitch,
            spineAngle: spinePitch,
            isGoodForm,
            feedback
        };
    }
}
