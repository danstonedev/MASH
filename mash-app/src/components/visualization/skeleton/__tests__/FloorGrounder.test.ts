/**
 * FloorGrounder Tests
 * ====================
 * 
 * Unit tests for the skeleton floor grounding logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { FloorGrounder } from '../FloorGrounder';

describe('FloorGrounder', () => {
    let grounder: FloorGrounder;

    beforeEach(() => {
        grounder = new FloorGrounder();
    });

    describe('computeGroundOffset', () => {
        it('returns zero offset when both feet are at Y=0', () => {
            // Create mock bones at Y=0
            const leftFoot = new THREE.Bone();
            leftFoot.position.set(0, 0, 0);
            leftFoot.updateMatrixWorld(true);

            const rightFoot = new THREE.Bone();
            rightFoot.position.set(0, 0, 0);
            rightFoot.updateMatrixWorld(true);

            const result = grounder.computeGroundOffset(leftFoot, rightFoot);

            expect(result.targetY).toBeCloseTo(0, 5);
            expect(result.stanceFoot).toBe('both');
        });

        it('computes positive Y offset when feet are below floor', () => {
            const leftFoot = new THREE.Bone();
            leftFoot.position.set(0, -0.5, 0); // 0.5 units below floor
            leftFoot.updateMatrixWorld(true);

            const rightFoot = new THREE.Bone();
            rightFoot.position.set(0, -0.3, 0);
            rightFoot.updateMatrixWorld(true);

            const result = grounder.computeGroundOffset(leftFoot, rightFoot);

            // Should raise skeleton by 0.5 to bring lowest foot to floor
            expect(result.targetY).toBeCloseTo(0.5, 5);
            expect(result.stanceFoot).toBe('left'); // Left foot is lower
        });

        it('computes negative Y offset when feet are above floor', () => {
            const leftFoot = new THREE.Bone();
            leftFoot.position.set(0, 0.2, 0);
            leftFoot.updateMatrixWorld(true);

            const rightFoot = new THREE.Bone();
            rightFoot.position.set(0, 0.3, 0);
            rightFoot.updateMatrixWorld(true);

            const result = grounder.computeGroundOffset(leftFoot, rightFoot);

            // Should lower skeleton by 0.2 to bring lowest foot to floor
            expect(result.targetY).toBeCloseTo(-0.2, 5);
        });

        it('clamps offset to maxOffset', () => {
            grounder = new FloorGrounder({ maxOffset: 1.0 });

            const leftFoot = new THREE.Bone();
            leftFoot.position.set(0, -5, 0); // Way below floor
            leftFoot.updateMatrixWorld(true);

            const rightFoot = new THREE.Bone();
            rightFoot.position.set(0, 0, 0);
            rightFoot.updateMatrixWorld(true);

            const result = grounder.computeGroundOffset(leftFoot, rightFoot);

            // Should clamp to maxOffset of 1.0
            expect(result.targetY).toBeCloseTo(1.0, 5);
        });

        it('handles null feet gracefully', () => {
            const result = grounder.computeGroundOffset(null, null);

            // With no feet, should default to zero
            expect(result.targetY).toBeCloseTo(0, 5);
            expect(result.stanceFoot).toBe('both');
        });

        it('includes debug info', () => {
            const leftFoot = new THREE.Bone();
            leftFoot.position.set(0, -0.3, 0);
            leftFoot.updateMatrixWorld(true);

            const rightFoot = new THREE.Bone();
            rightFoot.position.set(0, -0.1, 0);
            rightFoot.updateMatrixWorld(true);

            const result = grounder.computeGroundOffset(leftFoot, rightFoot);

            expect(result.debugInfo).toBeDefined();
            expect(result.debugInfo!.leftFootY).toBeCloseTo(-0.3, 5);
            expect(result.debugInfo!.rightFootY).toBeCloseTo(-0.1, 5);
            expect(result.debugInfo!.lowestY).toBeCloseTo(-0.3, 5);
        });
    });

    describe('applyToGroup', () => {
        it('smoothly interpolates position towards target', () => {
            grounder = new FloorGrounder({ lerpFactor: 0.5 });

            const group = new THREE.Group();
            group.position.set(0, 0, 0);

            const result = {
                targetY: 1.0,
                targetX: 0,
                targetZ: 0,
                stanceFoot: 'left' as const,
            };

            grounder.applyToGroup(group, result);

            // With lerpFactor 0.5, should move halfway
            expect(group.position.y).toBeCloseTo(0.5, 5);
        });

        it('applies XZ offset when centering is enabled', () => {
            grounder = new FloorGrounder({
                enableCentering: true,
                lerpFactor: 1.0, // Instant for testing
            });

            const group = new THREE.Group();
            group.position.set(1, 0, 2);

            const result = {
                targetY: 0,
                targetX: -0.5,
                targetZ: -1.0,
                stanceFoot: 'left' as const,
            };

            grounder.applyToGroup(group, result);

            expect(group.position.x).toBeCloseTo(-0.5, 5);
            expect(group.position.z).toBeCloseTo(-1.0, 5);
        });
    });

    describe('setOptions', () => {
        it('updates options at runtime', () => {
            grounder.setOptions({ maxOffset: 5.0, lerpFactor: 0.2 });

            const leftFoot = new THREE.Bone();
            leftFoot.position.set(0, -10, 0);
            leftFoot.updateMatrixWorld(true);

            const result = grounder.computeGroundOffset(leftFoot, null);

            // Should clamp to new maxOffset of 5.0
            expect(result.targetY).toBeCloseTo(5.0, 5);
        });
    });
});
