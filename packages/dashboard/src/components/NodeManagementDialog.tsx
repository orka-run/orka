import { useEffect, useState } from "react";
import { AlertCircle, Globe, Plus, Power, PowerOff, Trash2, X } from "lucide-react";
import type { PairedNodeInfo } from "../stores/nodeStore";
import type { NodeInfo } from "@orka/core";

interface NodeManagementDialogProps {
  open: boolean;
  onClose: () => void;
  pairedNodes: PairedNodeInfo[];
  liveNodes: NodeInfo[];
  onRemoveNode: (nodeId: string) => Promise<void>;
  onConnectNode: (nodeId: string) => Promise<void>;
  onDisconnectNode: (nodeId: string) => Promise<void>;
  onPairNode?: () => void;
}

export function NodeManagementDialog({
  open,
  onClose,
  pairedNodes,
  liveNodes,
  onRemoveNode,
  onConnectNode,
  onDisconnectNode,
  onPairNode,
}: NodeManagementDialogProps) {
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConfirmRemove(null);
    setError(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (confirmRemove) {
          setConfirmRemove(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, confirmRemove]);

  if (!open) return null;

  // Build a merged view: paired nodes with live status
  const liveStatusMap = new Map(liveNodes.map((n) => [n.id, n]));

  function getStatus(node: PairedNodeInfo): "online" | "offline" | "error" | "unknown" {
    const live = liveStatusMap.get(node.nodeId);
    if (live) return live.status === "online" ? "online" : "offline";
    if (node.connectionStatus) return node.connectionStatus;
    return "unknown";
  }

  function getLastSeen(node: PairedNodeInfo): string | null {
    const live = liveStatusMap.get(node.nodeId);
    if (live && live.status === "online") return "Now";
    // No last-seen timestamp available from current data
    return null;
  }

  async function handleAction(nodeId: string, action: () => Promise<void>) {
    setActionInProgress(nodeId);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionInProgress(null);
    }
  }

  async function handleRemove(nodeId: string) {
    if (confirmRemove !== nodeId) {
      setConfirmRemove(nodeId);
      return;
    }
    setConfirmRemove(null);
    await handleAction(nodeId, () => onRemoveNode(nodeId));
  }

  const statusColors: Record<string, string> = {
    online: "bg-emerald-600",
    error: "bg-status-error",
    offline: "bg-ink-muted",
    unknown: "bg-border",
  };

  const statusLabels: Record<string, string> = {
    online: "Online",
    error: "Error",
    offline: "Offline",
    unknown: "Unknown",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 py-8 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-sm border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-[13px] font-semibold text-ink">Manage Nodes</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border p-1 text-ink-muted transition hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-3 py-2">
          {error && (
            <div className="mb-2 flex items-start gap-2 rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-1.5 text-[12px] text-status-error">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {pairedNodes.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-ink-muted">
              No paired nodes. Add a remote node to get started.
            </div>
          ) : (
            <ul className="space-y-1">
              {pairedNodes.map((node) => {
                const status = getStatus(node);
                const isOnline = status === "online";
                const isActing = actionInProgress === node.nodeId;
                const isConfirmingRemove = confirmRemove === node.nodeId;
                const lastSeen = getLastSeen(node);

                return (
                  <li
                    key={node.nodeId}
                    className="rounded-sm border border-border bg-surface-alt px-2 py-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusColors[status] ?? "bg-border"}`}
                            title={statusLabels[status]}
                          />
                          <span className="truncate text-[12px] font-medium text-ink">
                            {node.nodeName || node.nodeId}
                          </span>
                          <span className={`text-[10px] ${status === "online" ? "text-emerald-700" : "text-ink-muted"}`}>
                            {statusLabels[status]}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4 text-[10px] text-ink-muted">
                          <span className="font-mono">{node.nodeId}</span>
                          {node.relayUrl && (
                            <>
                              <span className="text-border">|</span>
                              <span className="inline-flex items-center gap-0.5">
                                <Globe className="h-2.5 w-2.5" />
                                {node.relayUrl}
                              </span>
                            </>
                          )}
                          {node.pairedAt && (
                            <>
                              <span className="text-border">|</span>
                              <span>Paired {new Date(node.pairedAt).toLocaleDateString()}</span>
                            </>
                          )}
                          {lastSeen && lastSeen !== "Now" && (
                            <>
                              <span className="text-border">|</span>
                              <span>Last seen {lastSeen}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="ml-2 flex shrink-0 items-center gap-1">
                        {isOnline ? (
                          <button
                            type="button"
                            disabled={isActing}
                            onClick={() =>
                              handleAction(node.nodeId, () => onDisconnectNode(node.nodeId))
                            }
                            title="Disconnect"
                            className="rounded-sm p-1 text-ink-muted transition hover:bg-surface-hover hover:text-status-warning disabled:opacity-50"
                          >
                            <PowerOff className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isActing}
                            onClick={() =>
                              handleAction(node.nodeId, () => onConnectNode(node.nodeId))
                            }
                            title="Connect"
                            className="rounded-sm p-1 text-ink-muted transition hover:bg-surface-hover hover:text-emerald-700 disabled:opacity-50"
                          >
                            <Power className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {isConfirmingRemove ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={isActing}
                              onClick={() => handleRemove(node.nodeId)}
                              className="rounded-sm bg-status-error px-2 py-0.5 text-[10px] font-medium text-white transition hover:opacity-80 disabled:opacity-50"
                            >
                              Remove
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRemove(null)}
                              className="rounded-sm border border-border px-2 py-0.5 text-[10px] text-ink-muted transition hover:text-ink"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={isActing}
                            onClick={() => handleRemove(node.nodeId)}
                            title="Remove node"
                            className="rounded-sm p-1 text-ink-muted transition hover:bg-surface-hover hover:text-status-error disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          {onPairNode ? (
            <button
              type="button"
              onClick={onPairNode}
              className="inline-flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" />
              Add node
            </button>
          ) : (
            <div />
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
