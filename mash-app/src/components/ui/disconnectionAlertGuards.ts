import { OFFLINE_THRESHOLD_MS } from "../../lib/connection/SyncedSampleStats";

export interface ConnectionIngestDiagnosticsSnapshot {
  rawImuPacketCount: number;
  acceptedImuPacketCount: number;
  lastRawImuAt: number;
  lastAcceptedImuAt: number;
  lastPacketCompletenessRejectAt: number;
  lastNetworkCompletenessRejectAt: number;
}

interface DisconnectStormGuardInput {
  now: number;
  connected: boolean;
  deviceCount: number;
  offlineCount: number;
  ingest: ConnectionIngestDiagnosticsSnapshot;
}

export function shouldSuppressDisconnectAlertForIngestStorm(
  input: DisconnectStormGuardInput,
): boolean {
  if (!input.connected || input.deviceCount < 3) {
    return false;
  }

  const widespreadOffline =
    input.offlineCount >= Math.max(3, Math.ceil(input.deviceCount * 0.6));
  const rawStillFlowing =
    input.ingest.lastRawImuAt > 0 &&
    input.now - input.ingest.lastRawImuAt <= 2000;
  const acceptedFlowStalled =
    input.ingest.lastAcceptedImuAt <= 0 ||
    input.now - input.ingest.lastAcceptedImuAt > OFFLINE_THRESHOLD_MS;
  const recentCompletenessReject =
    Math.max(
      input.ingest.lastPacketCompletenessRejectAt,
      input.ingest.lastNetworkCompletenessRejectAt,
    ) > 0 &&
    input.now -
      Math.max(
        input.ingest.lastPacketCompletenessRejectAt,
        input.ingest.lastNetworkCompletenessRejectAt,
      ) <=
      2500;
  const acceptanceGapGrowing =
    input.ingest.rawImuPacketCount >= input.ingest.acceptedImuPacketCount + 50;

  return (
    widespreadOffline &&
    rawStillFlowing &&
    acceptedFlowStalled &&
    recentCompletenessReject &&
    acceptanceGapGrowing
  );
}
