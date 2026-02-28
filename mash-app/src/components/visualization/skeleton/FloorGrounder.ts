/**
 * FloorGrounder - Skeleton Floor Contact Logic
 * =============================================
 * 
 * Extracted from SkeletonModel.tsx for testability and clarity.
 * 
 * This module handles keeping the skeleton grounded by:
 *   1. Finding the lowest foot position
 *   2. Computing Y offset to place feet on floor (Y=0)
 *   3. Smoothly interpolating position changes
 * 
 * Note: Jump detection and physics have been removed per user request.
 * 
 * @module skeleton/FloorGrounder
 */

import * as THREE from 'three';

// ============================================================================
// TYPES
// ============================================================================

export interface GroundingResult {
    /** Target Y position for the skeleton group */
    targetY: number;
    /** Target X position (for centering, if enabled) */
    targetX: number;
    /** Target Z position (for centering, if enabled) */
    targetZ: number;
    /** Which foot is the stance foot */
    stanceFoot: 'left' | 'right' | 'both';
    /** Debug info */
    debugInfo?: {
        leftFootY: number;
        rightFootY: number;
        lowestY: number;
    };
}

export interface GroundingOptions {
    /** Maximum offset to apply (prevents extreme corrections) */
    maxOffset: number;
    /** Enable foot centering (keeps stance foot at origin) */
    enableCentering: boolean;
    /** Lerp factor for smooth transitions (0-1) */
    lerpFactor: number;
}

const DEFAULT_OPTIONS: GroundingOptions = {
    maxOffset: 3.0,
    enableCentering: false, // User requested stationary model
    lerpFactor: 0.1,
};

// ============================================================================
// FLOOR GROUNDER CLASS
// ============================================================================

/**
 * Computes skeleton position to keep feet on the ground.
 * 
 * Stateless and pure - all state comes from parameters.
 */
export class FloorGrounder {
    private options: GroundingOptions;

    constructor(options: Partial<GroundingOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Compute the ground offset to place feet on the floor.
     * 
     * @param leftFoot - Left foot bone (or toe) 
     * @param rightFoot - Right foot bone (or toe)
     * @param currentPosition - Current skeleton group position
     * @returns Grounding result with target positions
     */
    computeGroundOffset(
        leftFoot: THREE.Bone | null,
        rightFoot: THREE.Bone | null,
        currentPosition: THREE.Vector3 = new THREE.Vector3()
    ): GroundingResult {
        const { maxOffset, enableCentering } = this.options;

        // Get world positions of feet
        let leftFootY = 0;
        let rightFootY = 0;
        let leftPos = new THREE.Vector3();
        let rightPos = new THREE.Vector3();

        if (leftFoot) {
            leftFoot.getWorldPosition(leftPos);
            leftFootY = leftPos.y;
        }

        if (rightFoot) {
            rightFoot.getWorldPosition(rightPos);
            rightFootY = rightPos.y;
        }

        // Find lowest foot
        const lowestY = Math.min(leftFootY, rightFootY);
        const stanceFoot: 'left' | 'right' | 'both' =
            leftFootY < rightFootY ? 'left' :
                rightFootY < leftFootY ? 'right' : 'both';

        // Compute Y offset to place lowest foot at Y=0
        let targetY = -lowestY;

        // Clamp to prevent extreme corrections
        targetY = Math.max(-maxOffset, Math.min(targetY, maxOffset));

        // Compute XZ offset for centering (if enabled)
        let targetX = 0;
        let targetZ = 0;

        if (enableCentering && leftFoot && rightFoot) {
            const stanceFootBone = stanceFoot === 'left' ? leftFoot : rightFoot;
            const footWorld = new THREE.Vector3();
            stanceFootBone.getWorldPosition(footWorld);

            // Offset to bring stance foot to origin
            targetX = currentPosition.x - footWorld.x;
            targetZ = currentPosition.z - footWorld.z;
        }

        return {
            targetY,
            targetX,
            targetZ,
            stanceFoot,
            debugInfo: {
                leftFootY,
                rightFootY,
                lowestY,
            },
        };
    }

    /**
     * Apply grounding result to skeleton group with smooth interpolation.
     * 
     * @param group - The Three.js group containing the skeleton
     * @param result - Grounding computation result
     */
    applyToGroup(
        group: THREE.Group,
        result: GroundingResult
    ): void {
        const { lerpFactor } = this.options;

        group.position.x = THREE.MathUtils.lerp(group.position.x, result.targetX, lerpFactor);
        group.position.y = THREE.MathUtils.lerp(group.position.y, result.targetY, lerpFactor);
        group.position.z = THREE.MathUtils.lerp(group.position.z, result.targetZ, lerpFactor);
    }

    /**
     * Update options at runtime.
     */
    setOptions(options: Partial<GroundingOptions>): void {
        this.options = { ...this.options, ...options };
    }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

/**
 * Default grounder instance for simple usage.
 */
export const floorGrounder = new FloorGrounder();
