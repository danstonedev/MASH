/**
 * LateJoinBanner — Non-modal banner for pending nodes that arrived
 * after discovery was locked. Shows in the DevicePanel sidebar.
 *
 * - Displays each pending node with name, sensor count, and accept/reject buttons
 * - "Add All" shortcut when multiple nodes are pending
 * - Auto-stales entries older than 60s (node may have powered off)
 */

import { useCallback, useState, useEffect } from "react";
import { Plus, X, Users } from "lucide-react";
import { useDeviceStore } from "../../store/useDeviceStore";
import { cn } from "../../lib/utils";

/** Nodes older than this are considered stale and dimmed */
const STALE_THRESHOLD_MS = 60_000;

interface NodeWithStale {
  nodeId: number;
  name: string;
  sensorCount: number;
  hasMag: boolean;
  hasBaro: boolean;
  mac: string;
  receivedAt: number;
  stale: boolean;
}

export function LateJoinBanner() {
  const pendingNodes = useDeviceStore((s) => s.pendingNodes);
  const acceptNode = useDeviceStore((s) => s.acceptNode);
  const rejectNode = useDeviceStore((s) => s.rejectNode);
  const acceptAllPendingNodes = useDeviceStore((s) => s.acceptAllPendingNodes);

  // Staleness is computed in an effect to satisfy React compiler purity rules
  const [nodesWithAge, setNodesWithAge] = useState<NodeWithStale[]>([]);
  useEffect(() => {
    const compute = () => {
      const now = Date.now();
      setNodesWithAge(
        pendingNodes.map((n) => ({
          ...n,
          stale: now - n.receivedAt > STALE_THRESHOLD_MS,
        })),
      );
    };
    compute();
    if (pendingNodes.length === 0) return;
    const id = setInterval(compute, 10_000);
    return () => clearInterval(id);
  }, [pendingNodes]);

  const handleAccept = useCallback(
    (nodeId: number) => acceptNode(nodeId),
    [acceptNode],
  );

  const handleReject = useCallback(
    (nodeId: number) => rejectNode(nodeId),
    [rejectNode],
  );

  if (nodesWithAge.length === 0) return null;

  return (
    <div className="space-y-2">
      {/* Header with "Add All" when multiple */}
      {nodesWithAge.length > 1 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-medium text-text-secondary flex items-center gap-1">
            <Users className="h-3.5 w-3.5" />
            {nodesWithAge.length} nodes waiting
          </span>
          <button
            onClick={acceptAllPendingNodes}
            className="text-xs text-accent hover:text-accent/80 font-medium transition-colors"
          >
            Add All &amp; Re-sync
          </button>
        </div>
      )}

      {/* Individual node cards */}
      {nodesWithAge.map((node) => (
        <div
          key={node.nodeId}
          className={cn(
            "rounded-lg border bg-bg-surface p-3 transition-opacity",
            node.stale
              ? "border-border/50 opacity-60"
              : "border-accent/40 shadow-sm",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary truncate">
                {node.name}
              </div>
              <div className="text-[11px] text-text-secondary mt-0.5">
                {node.sensorCount} sensor{node.sensorCount !== 1 ? "s" : ""}
                {node.hasMag && " · Mag"}
                {node.hasBaro && " · Baro"}
                {node.stale && " · may be offline"}
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => handleAccept(node.nodeId)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  "bg-accent text-bg-surface hover:bg-accent/90",
                )}
                title="Accept node and re-sync"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
              <button
                onClick={() => handleReject(node.nodeId)}
                className="p-1 rounded-md hover:bg-bg-elevated text-text-secondary hover:text-text-primary transition-colors"
                title="Ignore this node"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
