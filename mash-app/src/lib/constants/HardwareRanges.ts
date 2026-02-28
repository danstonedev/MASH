/**
 * Hardware ID Range Definitions
 * Strategy 1: "Traffic Light" ID Ranges
 * 
 * Enforced Ranges:
 * 0 - 63    : Physical Sensors (IMUs)
 * 64 - 127  : Reserved / Future Use
 * 128 - 191 : Nodes (Hubs)
 * 192 - 255 : Gateways & System Messages
 */

export const HARDWARE_ID_RANGES = {
    // Firmware uses MAC-based offsets, so sensors can have IDs anywhere in 0-255 range.
    // Strategy 1 (Strict Ranges) is incompatible with current firmware.
    // We revert to full range and rely on strict packet parsing to avoid ghosts.
    SENSOR: { MIN: 0, MAX: 255 },
    RESERVED: { MIN: 255, MAX: 255 }, // 255 usually broadcast
    // Overlapping ranges unfortunately exist in current FW
    NODE: { MIN: 0, MAX: 255 },
    GATEWAY: { MIN: 0, MAX: 255 }
} as const;

/**
 * Check if an ID represents a valid Physical Sensor
 */
export function isValidSensorId(id: number): boolean {
    return id >= HARDWARE_ID_RANGES.SENSOR.MIN && id <= HARDWARE_ID_RANGES.SENSOR.MAX;
}

/**
 * Check if an ID represents a Node/Hub
 */
export function isNodeId(id: number): boolean {
    return id >= HARDWARE_ID_RANGES.NODE.MIN && id <= HARDWARE_ID_RANGES.NODE.MAX;
}
