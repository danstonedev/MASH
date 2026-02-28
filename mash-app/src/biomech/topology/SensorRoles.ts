/**
 * SensorRoles.ts
 * 
 * Defines the anatomical locations for the "Ultimate" 20-Sensor Topology.
 * Based on ISB / Xsens MVN standards.
 */

export enum BodyRole {
    // --- Central Chain (6) ---
    HEAD = 'HEAD',
    NECK = 'NECK',           // C7
    SPINE_UPPER = 'SPINE_UPPER', // T2 - Upper Thoracic
    CHEST = 'CHEST',         // T7 / Sternum
    SPINE_LOW = 'SPINE_LOW', // L5 / Lumbar
    PELVIS = 'PELVIS',       // Sacrum

    // --- Left Leg (3-4) ---
    HIP_L = 'HIP_L',    // Thigh
    KNEE_L = 'KNEE_L',  // Tibia
    FOOT_L = 'FOOT_L',  // Dorsal Foot
    TOE_L = 'TOE_L',    // Optional (Toe Flexion)

    // --- Right Leg (3-4) ---
    HIP_R = 'HIP_R',
    KNEE_R = 'KNEE_R',
    FOOT_R = 'FOOT_R',
    TOE_R = 'TOE_R',

    // --- Left Arm (4) ---
    SHOULDER_L = 'SHOULDER_L', // Scapula / Clavicle
    ARM_L = 'ARM_L',           // Humerus
    FOREARM_L = 'FOREARM_L',   // Radius/Ulna
    HAND_L = 'HAND_L',

    // --- Right Arm (4) ---
    SHOULDER_R = 'SHOULDER_R',
    ARM_R = 'ARM_R',
    FOREARM_R = 'FOREARM_R',
    HAND_R = 'HAND_R',

    // --- Props / Equipment (Flexible) ---
    PROP_1 = 'PROP_1', // Hockey Stick Handle
    PROP_2 = 'PROP_2', // Hockey Stick Blade
    SKATE_L = 'SKATE_L', // Specific "Boot" sensor if distinct from Foot
    SKATE_R = 'SKATE_R'
}

export enum TopologyType {
    SINGLE_SENSOR = 'SINGLE',
    DUAL_SKATE = 'DUAL_SKATE',
    CORE = 'CORE',                 // 1 sensor (Sternum)
    SPARSE_ARM = 'SPARSE_ARM',     // 3 sensors (Sternum + Hands)
    SPARSE_LEG = 'SPARSE_LEG',     // 3 sensors
    FULL_LEG = 'FULL_LEG',         // 7 sensors (Pelvis + 2x Thigh/Tibia/Foot)
    SPARSE_BODY = 'SPARSE_BODY',   // 6 sensors (Head/Sternum/Pelvis/Hands)
    FULL_BODY = 'FULL_BODY',       // 17-20 sensors
    CUSTOM = 'CUSTOM'
}
