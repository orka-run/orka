import { useEffect, useState } from "react";
import { Power, PowerOff, Trash2, X } from "lucide-react";
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
}

export function NodeManagementDialog({
  open,
  onClose,
  pairedNodes,
  liveNodes,
  onRemoveNode,
  onConnectNode,
  onDisconnectNode,
}: NodeManagementDialogProps) {
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // Build a merged view: paired nodes with live status
  const liveStatusMap = new Map(liveNodes.map((n) => [n.id, n.status]));

  function getStatus(node: PairedNodeInfo): "online" | "offline" | "error" | "unknown" {
    // Live status from listNodes takes priority
    const live = liveStatusMap.get(node.nodeId);
    if (live) return live === "online" ? "online" : "offline";
    // Then connectionStatus from push updates
    if (node.connectionStatus) return node.connectionStatus;
    return "unknown";
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
            <div className="mb-2 rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-1.5 text-[12px] text-status-error">
              {error}
            </div>
          )}
          {pairedNodes.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-ink-muted">
              No paired nodes. Use the pair button to add remote nodes.
            </div>
          ) : (
            <ul className="space-y-1">
              {pairedNodes.map((node) => {
                const status = getStatus(node);
                const isOnline = status === "online";
                const isActing = actionInProgress === node.nodeId;

                return (
                  <li
                    key={node.nodeId}
                    className="flex items-center justify-between rounded-sm border border-border bg-surface-alt px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 shrink-0 rounded-sm ${
                            status === "online"
                              ? "bg-emerald-600"
                              : status === "error"
                                ? "bg-status-error"
                                : "bg-border"
                          }`}
                        />
                        <span className="truncate text-[12px] font-medium text-ink">
                          {node.nodeName || node.nodeId}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-muted">
                        <span>{node.nodeId}</span>
                        <span className="text-border">|</span>
                        <span className="capitalize">{status}</span>
                        {node.pairedAt && (
                          <>
                            <span className="text-border">|</span>
                            <span>Paired {new Date(node.pairedAt).toLocaleDateString()}</span>
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
                      <button
                        type="button"
                        disabled={isActing}
                        onClick={() =>
                          handleAction(node.nodeId, () => onRemoveNode(node.nodeId))
                        }
                        title="Remove node"
                        className="rounded-sm p-1 text-ink-muted transition hover:bg-surface-hover hover:text-status-error disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-sm border border-border bg-surface-alt px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition hover:text-ink"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
