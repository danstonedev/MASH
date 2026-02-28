/**
 * sensorDisplayName.ts - Sequential sensor display name mapping
 *
 * Maps raw MAC-derived sensor IDs (e.g. 0, 43, 44, 253, 254) to
 * sequential human-friendly labels (Sensor 1, Sensor 2, ...) ordered
 * by ascending raw ID value.
 *
 * The raw IDs are still used internally for data matching — this is
 * purely a display-layer mapping.
 */

// Singleton registry: updated once per streaming session when sensors appear
let _knownRawIds: number[] = [];
let _rawToFriendly: Map<number, number> = new Map();

/**
 * Register a batch of raw sensor IDs (call when the sensor set is known).
 * IDs are sorted ascending and mapped to 1-based sequential numbers.
 */
export function registerSensorIds(rawIds: number[]): void {
  const sorted = [...new Set(rawIds)].sort((a, b) => a - b);

  // Avoid unnecessary recomputation
  if (
    sorted.length === _knownRawIds.length &&
    sorted.every((v, i) => v === _knownRawIds[i])
  ) {
    return;
  }

  _knownRawIds = sorted;
  _rawToFriendly = new Map();
  sorted.forEach((id, idx) => _rawToFriendly.set(id, idx + 1));
}

/**
 * Incrementally register a single raw sensor ID.
 * Re-sorts and re-indexes the full list.
 */
export function registerSensorId(rawId: number): void {
  if (_rawToFriendly.has(rawId)) return;
  registerSensorIds([..._knownRawIds, rawId]);
}

/**
 * Get the friendly sequential number for a raw sensor ID.
 * Returns the 1-based index, or the raw ID as fallback if unregistered.
 */
export function getFriendlyIndex(rawId: number): number {
  return _rawToFriendly.get(rawId) ?? rawId;
}

/**
 * Get the display label for a raw sensor ID.
 * e.g. raw 43 → "Sensor 2" (if it's the second-lowest known ID)
 */
export function getSensorDisplayName(rawId: number): string {
  const idx = _rawToFriendly.get(rawId);
  return idx !== undefined ? `Sensor ${idx}` : `Sensor ${rawId}`;
}

/**
 * Get a label that includes the node context.
 * e.g. "Node 1 / Sensor 2"
 */
export function getSensorDisplayNameWithNode(
  rawId: number,
  nodeName?: string | null,
): string {
  const sensorLabel = getSensorDisplayName(rawId);

  // FIX: valid sensors connected via Gateway shouldn't carry the "MASH Gateway" prefix
  // It confuses users who think the sensor IS the gateway.
  // We also filter "USB" for generic serial connections.
  if (
    nodeName &&
    (nodeName.includes("Gateway") || nodeName.includes("USB"))
  ) {
    return sensorLabel;
  }

  return nodeName ? `${nodeName} / ${sensorLabel}` : sensorLabel;
}

/**
 * Get all currently registered raw IDs (sorted ascending).
 */
export function getRegisteredIds(): readonly number[] {
  return _knownRawIds;
}

/**
 * Reset the registry (e.g. on disconnect / new session).
 */
export function resetSensorRegistry(): void {
  _knownRawIds = [];
  _rawToFriendly = new Map();
}
