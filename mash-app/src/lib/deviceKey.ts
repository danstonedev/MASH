/**
 * deviceKey.ts — Canonical device identity keying
 * ==================================================
 *
 * Device identity uses physical sensor identity from firmware:
 *   rawNodeId (MAC-derived) + localSensorIndex (0-based within node).
 *
 * Key format: "node_<rawNodeId>_s<localSensorIndex>"  e.g. "node_44_s0"
 *
 * Physical keys are STABLE across topology changes (node drops/rejoins)
 * because rawNodeId is derived from the hardware MAC address and doesn't
 * depend on registration order.
 *
 * The compact sensorId (gateway-assigned sequential) is stored separately
 * on DeviceData.packetSensorId for transport/recording purposes only.
 */

/**
 * Build the canonical device key for a sensor.
 *
 * @param rawNodeId        Physical node ID from firmware (MAC-derived).
 * @param localSensorIndex Sensor index within the node (0-based).
 * @param _compactSensorId Unused — kept for call-site compatibility during transition.
 * @returns Stable device key string.
 */
export function makeDeviceKey(
  rawNodeId: number | undefined,
  localSensorIndex: number | undefined,
  _compactSensorId?: number,
): string {
  return `node_${rawNodeId ?? 0}_s${localSensorIndex ?? 0}`;
}

/**
 * Parse a device key into its components.
 *
 * "node_44_s2" → { rawNodeId: 44, localSensorIndex: 2 }
 */
export function parsePhysicalKey(
  deviceKey: string,
): { rawNodeId: number; localSensorIndex: number } | null {
  const match = deviceKey.match(/^node_(\d+)_s(\d+)$/);
  if (!match) return null;
  return {
    rawNodeId: parseInt(match[1], 10),
    localSensorIndex: parseInt(match[2], 10),
  };
}
