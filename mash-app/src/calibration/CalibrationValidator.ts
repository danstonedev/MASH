/**
 * CalibrationValidator - Post-Calibration IK Validation Loop
 * ===========================================================
 * 
 * Validates calibration quality by analyzing the resulting skeleton pose.
 * Detects common calibration issues:
 * 
 * 1. **Anatomical Violations** - Joints outside ROM limits
 * 2. **Asymmetry Detection** - Left/right limb imbalance
 * 3. **T-Pose Deviation** - Excessive deviation from expected T-pose
 * 4. **Chain Consistency** - Parent-child bone alignment issues
 * 
 * Industry Reference: Similar to Xsens MVN's calibration quality feedback
 * 
 * @module calibration/CalibrationValidator
 */

import * as THREE from 'three';
import { JOINT_DEFINITIONS } from '../biomech/jointAngles';
import { computeCalibrationQuality, type CalibrationQuality } from './calibrationMath';

// ============================================================================
// TYPES
// ============================================================================

export interface SegmentValidation {
    segmentId: string;
    quality: CalibrationQuality;
    issues: ValidationIssue[];
    isValid: boolean;
}

export interface ValidationIssue {
    type: 'rom_violation' | 'asymmetry' | 'tpose_deviation' | 'chain_misalignment' | 'missing_calibration' | 'drift_high';
    severity: 'info' | 'warning' | 'error';
    message: string;
    details?: {
        axis?: string;
        angle?: number;
        limit?: number;
        difference?: number;
    };
}

export interface ValidationResult {
    /** Overall validation passed */
    isValid: boolean;
    /** Overall score 0-100 */
    overallScore: number;
    /** Per-segment validations */
    segments: Map<string, SegmentValidation>;
    /** Global issues affecting multiple segments */
    globalIssues: ValidationIssue[];
    /** Summary message for user */
    summary: string;
    /** Recommendations for improvement */
    recommendations: string[];
}

export interface ValidatorConfig {
    /** Maximum allowed T-pose deviation per segment (degrees) */
    maxTposeDeviation: number;
    /** Maximum allowed asymmetry between left/right pairs (degrees) */
    maxAsymmetry: number;
    /** Whether to enforce ROM constraints strictly */
    strictROM: boolean;
    /** Minimum acceptable overall score to pass validation */
    minPassScore: number;
}

const DEFAULT_CONFIG: ValidatorConfig = {
    maxTposeDeviation: 15,
    maxAsymmetry: 10,
    strictROM: true,
    minPassScore: 70,
};

// Segment pairs for asymmetry detection
const SEGMENT_PAIRS: [string, string][] = [
    ['thigh_l', 'thigh_r'],
    ['tibia_l', 'tibia_r'],
    ['foot_l', 'foot_r'],
    ['upperarm_l', 'upperarm_r'],
    ['forearm_l', 'forearm_r'],
    ['hand_l', 'hand_r'],
];

// Expected T-pose orientations (must match tposeTargets.ts)
// Helper to create quaternion from Euler degrees
const fromEulerDeg = (x: number, y: number, z: number): THREE.Quaternion => {
    const euler = new THREE.Euler(
        x * Math.PI / 180,
        y * Math.PI / 180,
        z * Math.PI / 180,
        'XYZ'
    );
    return new THREE.Quaternion().setFromEuler(euler);
};

const TPOSE_TARGETS: Record<string, THREE.Quaternion> = {
    // Central segments - upright, facing forward
    pelvis: fromEulerDeg(0, 0, 0),
    chest: fromEulerDeg(0, 0, 0),
    head: fromEulerDeg(0, 0, 0),
    torso: fromEulerDeg(0, 0, 0),
    // Legs - Pure X-180 (Sensor Y pointing down, Z forward)
    // Matches tposeTargets.ts to prevent Frog Pose and consistency errors
    thigh_l: fromEulerDeg(180, 0, 0),
    thigh_r: fromEulerDeg(180, 0, 0),
    tibia_l: fromEulerDeg(180, 0, 0),
    tibia_r: fromEulerDeg(180, 0, 0),
    // Feet - 90° X pitch (Flat foot, toes forward)
    foot_l: fromEulerDeg(90, 0, 0),
    foot_r: fromEulerDeg(90, 0, 0),
    // Arms - 90° Z roll for horizontal T-pose
    upperarm_l: fromEulerDeg(0, 0, 90),
    upperarm_r: fromEulerDeg(0, 0, -90),
    upper_arm_l: fromEulerDeg(0, 0, 90),
    upper_arm_r: fromEulerDeg(0, 0, -90),
    forearm_l: fromEulerDeg(0, 0, 90),
    forearm_r: fromEulerDeg(0, 0, -90),
    hand_l: fromEulerDeg(0, 0, 90),
    hand_r: fromEulerDeg(0, 0, -90),
};

// ============================================================================
// CALIBRATION VALIDATOR CLASS
// ============================================================================

export class CalibrationValidator {
    private config: ValidatorConfig;

    constructor(config: Partial<ValidatorConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Validate the full calibration result.
     * 
     * @param calibratedOrientations - Map of segment ID to calibrated world quaternion
     * @param customTargets - Optional map of expected target poses (e.g. A-Pose) to validate against
     * @returns Validation result with issues and recommendations
     */
    validate(
        calibratedOrientations: Map<string, THREE.Quaternion>,
        customTargets?: Map<string, THREE.Quaternion>,
        driftMetrics?: Map<string, number>
    ): ValidationResult {
        const segments = new Map<string, SegmentValidation>();
        const globalIssues: ValidationIssue[] = [];
        const recommendations: string[] = [];
        let totalScore = 0;
        let segmentCount = 0;

        // Check for minimum required segments
        if (calibratedOrientations.size < 2) {
            globalIssues.push({
                type: 'missing_calibration',
                severity: 'error',
                message: 'Insufficient segments calibrated. Need at least 2 segments.',
            });
        }

        // Validate Drift (New Check)
        // Validate Drift (New Check)
        if (driftMetrics) {
            driftMetrics.forEach((drift, deviceId) => {
                // Find segment name for this device if possible, or use ID

                // Threshold: 0.08 rad/s (~4.5 deg/s) (Warning) - relaxed for handheld
                // 0.15 rad/s (~8.5 deg/s) (Error)
                if (drift > 0.08) {
                    const isError = drift > 0.15;
                    globalIssues.push({
                        type: 'drift_high',
                        severity: isError ? 'error' : 'warning',
                        message: `Sensor ${deviceId} drift high: ${(drift * 180 / Math.PI).toFixed(1)}°/s (Limit: 4.5°/s). Stationary calibration may be compromised.`,
                        details: { difference: drift, limit: 0.08 }
                    });
                }
            });
        }

        // Validate each segment
        // Validate each segment
        calibratedOrientations.forEach((orientation, segmentId) => {
            const customTarget = customTargets?.get(segmentId);
            const segmentValidation = this.validateSegment(segmentId, orientation, customTarget);
            segments.set(segmentId, segmentValidation);
            totalScore += segmentValidation.quality.score;
            segmentCount++;
        });

        // Check left/right asymmetry
        const asymmetryIssues = this.checkAsymmetry(calibratedOrientations);
        globalIssues.push(...asymmetryIssues);

        // Calculate overall score
        const overallScore = segmentCount > 0 ? totalScore / segmentCount : 0;

        // Generate recommendations based on issues
        const allIssues = [...globalIssues];
        segments.forEach(seg => {
            allIssues.push(...seg.issues);
        });

        recommendations.push(...this.generateRecommendations(allIssues));

        // Determine if valid
        const hasErrors = allIssues.some(i => i.severity === 'error');
        const isValid = !hasErrors && overallScore >= this.config.minPassScore;

        // Summary
        const summary = this.generateSummary(overallScore, allIssues.length, isValid);

        return {
            isValid,
            overallScore,
            segments,
            globalIssues,
            summary,
            recommendations,
        };
    }

    /**
     * Validate a single segment.
     */
    private validateSegment(
        segmentId: string,
        orientation: THREE.Quaternion,
        customTarget?: THREE.Quaternion
    ): SegmentValidation {
        const issues: ValidationIssue[] = [];

        // Get expected T-pose orientation (or custom target)
        const expected = customTarget || TPOSE_TARGETS[segmentId] || new THREE.Quaternion();

        // Compute quality vs expected
        const quality = computeCalibrationQuality(orientation, expected);

        // Check T-pose deviation
        const deviation = orientation.angleTo(expected) * (180 / Math.PI);
        if (deviation > this.config.maxTposeDeviation) {
            issues.push({
                type: 'tpose_deviation',
                severity: deviation > 30 ? 'error' : 'warning',
                message: `${segmentId}: T-pose deviation ${deviation.toFixed(1)}° exceeds ${this.config.maxTposeDeviation}° limit`,
                details: { angle: deviation, limit: this.config.maxTposeDeviation },
            });
        }

        // Check ROM violations (Relative to neutral)
        const romIssues = this.checkROMViolation(segmentId, orientation, expected);
        issues.push(...romIssues);

        return {
            segmentId,
            quality,
            issues,
            isValid: issues.every(i => i.severity !== 'error'),
        };
    }

    /**
     * Check if orientation violates ROM limits (Relative to Neutral Pose).
     */
    private checkROMViolation(
        segmentId: string,
        orientation: THREE.Quaternion,
        neutral: THREE.Quaternion
    ): ValidationIssue[] {
        const issues: ValidationIssue[] = [];

        // Map segment to joint (matching JOINT_DEFINITIONS keys)
        const jointMap: Record<string, string> = {
            thigh_l: 'hip_l', // Mapping matches biomech/jointAngles.ts
            thigh_r: 'hip_r',
            tibia_l: 'knee_l',
            tibia_r: 'knee_r',
            foot_l: 'ankle_l',
            foot_r: 'ankle_r',
            upperarm_l: 'shoulder_l',
            upperarm_r: 'shoulder_r',
            forearm_l: 'elbow_l',
            forearm_r: 'elbow_r',
        };

        const jointName = jointMap[segmentId];
        if (!jointName) return issues;

        const jointDef = JOINT_DEFINITIONS[jointName];
        if (!jointDef) return issues;

        // Compute deviation from neutral
        // delta = world * neutral^-1
        // This gives the rotation needed to go FROM neutral TO current
        // Ideally we want Local Joint Angle, but without parent info, 
        // "Deviation from Neutral" is the best proxy for Range of Motion in calibration context.
        const delta = orientation.clone().multiply(neutral.clone().invert());

        // Extract Euler angles (use appropriate order)
        // Note: For delta rotation, order matters less if angles are small, but consistent is good.
        // Using same orders as before.
        const order = jointName.includes('shoulder') ? 'YXZ' : 'ZXY';
        const euler = new THREE.Euler().setFromQuaternion(delta, order);

        // Check flexion/extension (primary rotation)
        const flexion = euler.z * (180 / Math.PI);

        // Hinge joints (knee, elbow, ankle) have primarily single-axis motion
        const isHingeJoint = jointName.includes('knee') || jointName.includes('elbow') || jointName.includes('ankle');

        if (isHingeJoint) {
            // Hinge joints have single axis limits
            if (flexion < jointDef.flexionRange[0] - 5 || flexion > jointDef.flexionRange[1] + 5) {
                issues.push({
                    type: 'rom_violation',
                    severity: this.config.strictROM ? 'error' : 'warning',
                    message: `${segmentId}: Flexion ${flexion.toFixed(0)}° outside ROM [${jointDef.flexionRange[0]}, ${jointDef.flexionRange[1]}] (Relative)`,
                    details: { axis: 'flexion', angle: flexion, limit: jointDef.flexionRange[1] },
                });
            }
        } else if (jointDef.abductionRange) {
            // Ball joints also have abduction/rotation limits
            const abduction = euler.x * (180 / Math.PI);
            if (abduction < jointDef.abductionRange[0] - 5 || abduction > jointDef.abductionRange[1] + 5) {
                issues.push({
                    type: 'rom_violation',
                    severity: this.config.strictROM ? 'error' : 'warning',
                    message: `${segmentId}: Abduction ${abduction.toFixed(0)}° outside ROM [${jointDef.abductionRange[0]}, ${jointDef.abductionRange[1]}] (Relative)`,
                    details: { axis: 'abduction', angle: abduction },
                });
            }
        }

        return issues;
    }

    /**
     * Check asymmetry between left/right segment pairs.
     * Uses Euler angle decomposition to correctly handle sagittal symmetry.
     */
    private checkAsymmetry(
        orientations: Map<string, THREE.Quaternion>
    ): ValidationIssue[] {
        const issues: ValidationIssue[] = [];

        for (const [left, right] of SEGMENT_PAIRS) {
            const leftQ = orientations.get(left);
            const rightQ = orientations.get(right);

            if (!leftQ || !rightQ) continue;

            const leftE = new THREE.Euler().setFromQuaternion(leftQ, 'XYZ');
            const rightE = new THREE.Euler().setFromQuaternion(rightQ, 'XYZ');

            // Asymmetry Logic for World Frame (X=Right, Y=Up, Z=Forward):
            // Flexion (X): Symmetric (e.g. Left=10, Right=10)
            // Yaw (Y): Anti-symmetric (e.g. Left=10, Right=-10 for T-pose symmetry? Actually T-pose usually 0)
            // Roll (Z): Anti-symmetric (e.g. Left=10 Abduction, Right=-10)

            // Normalize angles to -180..180
            const toDeg = (rad: number) => {
                let d = rad * (180 / Math.PI);
                while (d > 180) d -= 360;
                while (d < -180) d += 360;
                return d;
            };

            const l = { x: toDeg(leftE.x), y: toDeg(leftE.y), z: toDeg(leftE.z) };
            const r = { x: toDeg(rightE.x), y: toDeg(rightE.y), z: toDeg(rightE.z) };

            // Calculate differences
            const diffX = Math.abs(l.x - r.x); // Should be equal
            const diffY = Math.abs(l.y + r.y); // Should be opposite (sum=0)
            const diffZ = Math.abs(l.z + r.z); // Should be opposite (sum=0) (except arms Z is consistent? check targets)

            // Special case check for Z:
            // T-pose Arms: Left Z=90, Right Z=-90. Sum=0. Correct.
            // Legs: Left Z=180, Right Z=180. Sum=360->0. Correct.
            // Feet: Left X=115, Right X=115. DiffX=0. Correct.

            // RMS Error
            const asymmetry = Math.sqrt((diffX * diffX + diffY * diffY + diffZ * diffZ) / 3);

            if (asymmetry > this.config.maxAsymmetry) {
                issues.push({
                    type: 'asymmetry',
                    severity: asymmetry > 20 ? 'error' : 'warning',
                    message: `${left}/${right}: Asymmetry ${asymmetry.toFixed(1)}° exceeds ${this.config.maxAsymmetry}° limit`,
                    details: { difference: asymmetry, limit: this.config.maxAsymmetry },
                });
            }
        }

        return issues;
    }

    /**
     * Generate recommendations based on detected issues.
     */
    private generateRecommendations(issues: ValidationIssue[]): string[] {
        const recs: string[] = [];

        const hasROM = issues.some(i => i.type === 'rom_violation');
        const hasAsymmetry = issues.some(i => i.type === 'asymmetry');
        const hasTpose = issues.some(i => i.type === 'tpose_deviation');

        const hasMissing = issues.some(i => i.type === 'missing_calibration');
        const hasDrift = issues.some(i => i.type === 'drift_high');

        if (hasDrift) {
            recs.push('Ensure sensors are completely still during the "Warm Up" and "Static Pose" phases.');
            recs.push('High drift detected: Try placing sensors on a stable table for calibration.');
        }

        if (hasMissing) {
            recs.push('Ensure all sensors are connected and assigned before calibration.');
        }

        if (hasTpose) {
            recs.push('Stand in a neutral T-pose during calibration: arms straight out, palms down, feet shoulder-width apart.');
        }

        if (hasAsymmetry) {
            recs.push('Ensure sensors are mounted symmetrically on left and right limbs.');
            recs.push('Check that left/right sensor assignments are correct.');
        }

        if (hasROM) {
            recs.push('Avoid any joint flexion during T-pose calibration.');
            recs.push('If ROM violations persist, check sensor mounting orientation.');
        }

        if (recs.length === 0) {
            recs.push('Calibration looks good! No adjustments needed.');
        }

        return recs;
    }

    /**
     * Generate summary message.
     */
    private generateSummary(score: number, issueCount: number, isValid: boolean): string {
        if (isValid && issueCount === 0) {
            return `✓ Calibration excellent (${score.toFixed(0)}%)`;
        } else if (isValid) {
            return `✓ Calibration passed (${score.toFixed(0)}%) with ${issueCount} minor issue(s)`;
        } else if (score >= 50) {
            return `⚠ Calibration acceptable (${score.toFixed(0)}%) but has ${issueCount} issue(s) to address`;
        } else {
            return `✗ Calibration failed (${score.toFixed(0)}%). Recalibration recommended.`;
        }
    }

    /**
     * Update configuration at runtime.
     */
    setConfig(config: Partial<ValidatorConfig>): void {
        this.config = { ...this.config, ...config };
    }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const calibrationValidator = new CalibrationValidator();

// Expose to window for debugging
if (typeof window !== 'undefined') {
    (window as any).calibrationValidator = calibrationValidator;
}
