/**
 * nodeDisplayName.ts - Sequential node display name mapping
 *
 * Maps raw Node IDs (e.g. 43, 253) to sequential human-friendly labels
 * (Node 1, Node 2, ...) ordered by ascending raw ID value.
 */

// Singleton registry: updated once per session as nodes appear
let _knownNodeIds: number[] = [];
let _rawToFriendly: Map<number, number> = new Map();

/**
 * Register a Node ID.
 * IDs are sorted ascending and mapped to 1-based sequential numbers.
 */
export function registerNodeId(rawId: number): void {
    if (_knownNodeIds.includes(rawId)) return;

    _knownNodeIds = [..._knownNodeIds, rawId].sort((a, b) => a - b);
    _rawToFriendly = new Map();
    _knownNodeIds.forEach((id, idx) => _rawToFriendly.set(id, idx + 1));
}

/**
 * Get the friendly sequential name for a raw Node ID.
 * e.g. "Node 1", "Node 2".
 * Special handling: ID 0 is often "Gateway", but if treated as a Node, 
 * it will be "Node 1" (if lowest).
 */
export function getNodeDisplayName(rawId: number): string {
    // If ID is 0, we might want to call it "Gateway" if it's the gateway?
    // But strictly speaking, if it has sensors, it's a Node.
    // The user wants "Node 1...". 
    // If ID 0 is the Gateway, let's let it be Node 1 if it's in the list.

    const idx = _rawToFriendly.get(rawId);
    return idx !== undefined ? `Node ${idx}` : `Node ${rawId}`;
}

export function resetNodeRegistry(): void {
    _knownNodeIds = [];
    _rawToFriendly = new Map();
}
