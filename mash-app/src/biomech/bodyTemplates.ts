/**
 * Body Templates: Preset configurations for different use cases.
 * Users select a template to determine which segments need IMUs.
 */

import type { SegmentId } from './segmentRegistry';

export interface BodyTemplate {
    id: string;
    name: string;
    description: string;
    segments: SegmentId[];
}

export const BODY_TEMPLATES: Record<string, BodyTemplate> = {
    single: {
        id: 'single',
        name: 'Single IMU',
        description: 'Free orientation tracking (no joint angles)',
        segments: [],
    },

    lower_body: {
        id: 'lower_body',
        name: 'Lower Body',
        description: '6 sensors: Pelvis, Thighs, Tibias, Feet',
        segments: ['pelvis', 'thigh_l', 'thigh_r', 'tibia_l', 'tibia_r', 'foot_l', 'foot_r'],
    },

    lower_limb_left: {
        id: 'lower_limb_left',
        name: 'Left Leg Only',
        description: '3 sensors: Thigh, Tibia, Foot',
        segments: ['thigh_l', 'tibia_l', 'foot_l'],
    },

    lower_limb_right: {
        id: 'lower_limb_right',
        name: 'Right Leg Only',
        description: '3 sensors: Thigh, Tibia, Foot',
        segments: ['thigh_r', 'tibia_r', 'foot_r'],
    },

    full_body: {
        id: 'full_body',
        name: 'Full Body',
        description: '15 sensors: Complete motion capture',
        segments: [
            'pelvis', 'torso', 'head',
            'thigh_l', 'thigh_r', 'tibia_l', 'tibia_r', 'foot_l', 'foot_r',
            'upper_arm_l', 'upper_arm_r', 'forearm_l', 'forearm_r', 'hand_l', 'hand_r'
        ],
    },
} as const;

export type TemplateId = keyof typeof BODY_TEMPLATES;
