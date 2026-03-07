export interface NetworkFrameCompletenessInput {
  validCount: number;
  packetExpectedCount: number;
  syncExpectedSensors?: number;
  topologyExpectedSensors?: number;
  discoveryLocked: boolean;
}

export interface NetworkFrameCompletenessDecision {
  reject: boolean;
  authoritativeExpectedCount: number;
  packetIsIncomplete: boolean;
  networkIsIncomplete: boolean;
}

export function evaluateNetworkFrameCompleteness(
  input: NetworkFrameCompletenessInput,
): NetworkFrameCompletenessDecision {
  const syncExpectedSensors = Math.max(0, input.syncExpectedSensors ?? 0);
  const topologyExpectedSensors = Math.max(
    0,
    input.topologyExpectedSensors ?? 0,
  );
  const authoritativeExpectedCount = Math.max(
    syncExpectedSensors,
    topologyExpectedSensors,
  );

  const packetIsIncomplete = input.validCount < input.packetExpectedCount;

  // Only enforce network-wide completeness once the control plane is authoritative.
  const canEnforceNetworkCompleteness =
    input.discoveryLocked || syncExpectedSensors > 0;

  const networkIsIncomplete =
    canEnforceNetworkCompleteness &&
    authoritativeExpectedCount > 0 &&
    input.validCount < authoritativeExpectedCount;

  return {
    reject: packetIsIncomplete,
    authoritativeExpectedCount,
    packetIsIncomplete,
    networkIsIncomplete,
  };
}
