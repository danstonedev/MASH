/**
 * Lift Safety Analyzer
 * ====================
 * 
 * Monitors ergonomic risk during lifting activities.
 * 
 * Risk Factors (NIOSH/REBA based):
 * 1. Lumbar Flexion > 45 degrees
 * 2. Twisting (Asymmetry) > 10 degrees
 * 
 * @module analysis/LiftSafetyFeature
 */

import * as THREE from 'three';
import { KineticChain } from './KineticChain';

export interface LiftRisk {
    riskLevel: 'low' | 'moderate' | 'high';
    flexionAngle: number;
    twistAngle: number;
    feedback: string[];
}

export class LiftSafetyFeature {
    analyze(coreChain: KineticChain): LiftRisk {
        const metrics = coreChain.getMetrics();
        const quat = metrics.rootQuat;
        const euler = new THREE.Euler().setFromQuaternion(quat, 'YXZ'); // Y-rotation is Yaw (Twist), X is Pitch (Flexion)

        const flexion = Math.abs(THREE.MathUtils.radToDeg(euler.x)); // Forward lean
        const twist = Math.abs(THREE.MathUtils.radToDeg(euler.y));   // Rotation

        let riskLevel: LiftRisk['riskLevel'] = 'low';
        const feedback: string[] = [];

        if (flexion > 60) {
            riskLevel = 'high';
            feedback.push('Dangerous Flexion (>60°)');
        } else if (flexion > 40) {
            riskLevel = 'moderate';
            feedback.push('Caution: Forward Lean');
        }

        if (twist > 15) {
            if (riskLevel === 'moderate') riskLevel = 'high'; // Flexion + Twist = Bad
            else if (riskLevel === 'low') riskLevel = 'moderate';
            feedback.push('Avoid Twisting while Lifting');
        }

        return {
            riskLevel,
            flexionAngle: flexion,
            twistAngle: twist,
            feedback
        };
    }
}
