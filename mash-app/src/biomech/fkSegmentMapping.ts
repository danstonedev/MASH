/**
 * FK Segment Mapping
 * ==================
 * 
 * Maps assignment store segment IDs (lowercase) to FK solver bone IDs (uppercase).
 */

// Assignment store uses lowercase, FK solver uses uppercase
export const SEGMENT_TO_FK_BONE: Record<string, string> = {
    // Central
    'pelvis': 'PELVIS',
    'torso': 'CHEST',
    'head': 'HEAD',

    // Left leg
    'thigh_l': 'THIGH_L',
    'tibia_l': 'TIBIA_L',
    'foot_l': 'FOOT_L',

    // Right leg
    'thigh_r': 'THIGH_R',
    'tibia_r': 'TIBIA_R',
    'foot_r': 'FOOT_R',

    // Left arm
    'upper_arm_l': 'UPPER_ARM_L',
    'forearm_l': 'FOREARM_L',
    'hand_l': 'HAND_L',

    // Right arm
    'upper_arm_r': 'UPPER_ARM_R',
    'forearm_r': 'FOREARM_R',
    'hand_r': 'HAND_R',
};

/**
 * Convert assignment store segment ID to FK solver bone ID.
 */
export function toFKBoneId(segment: string): string {
    return SEGMENT_TO_FK_BONE[segment.toLowerCase()] || segment.toUpperCase();
}

/**
 * Convert FK solver bone ID to assignment store segment ID.
 */
export function toSegmentId(fkBoneId: string): string {
    // Find the lowercase key that maps to this FK bone ID
    for (const [segment, fkId] of Object.entries(SEGMENT_TO_FK_BONE)) {
        if (fkId === fkBoneId) return segment;
    }
    return fkBoneId.toLowerCase();
}
