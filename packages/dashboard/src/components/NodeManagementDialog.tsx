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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-zinc-100">Manage Nodes</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
          {error && (
            <div className="mb-4 rounded-lg border border-red-800/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
          {pairedNodes.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">
              No paired nodes. Use the pair button to add remote nodes.
            </div>
          ) : (
            <ul className="space-y-3">
              {pairedNodes.map((node) => {
                const status = getStatus(node);
                const isOnline = status === "online";
                const isActing = actionInProgress === node.nodeId;

                return (
                  <li
                    key={node.nodeId}
                    className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                            status === "online"
                              ? "bg-emerald-400"
                              : status === "error"
                                ? "bg-red-400"
                                : "bg-zinc-600"
                          }`}
                        />
                        <span className="truncate text-sm font-medium text-zinc-100">
                          {node.nodeName || node.nodeId}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                        <span>{node.nodeId}</span>
                        <span className="text-zinc-700">|</span>
                        <span className="capitalize">{status}</span>
                        {node.pairedAt && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span>Paired {new Date(node.pairedAt).toLocaleDateString()}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="ml-3 flex shrink-0 items-center gap-1.5">
                      {isOnline ? (
                        <button
                          type="button"
                          disabled={isActing}
                          onClick={() =>
                            handleAction(node.nodeId, () => onDisconnectNode(node.nodeId))
                          }
                          title="Disconnect"
                          className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-amber-400 disabled:opacity-50"
                        >
                          <PowerOff className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isActing}
                          onClick={() =>
                            handleAction(node.nodeId, () => onConnectNode(node.nodeId))
                          }
                          title="Connect"
                          className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-50"
                        >
                          <Power className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isActing}
                        onClick={() =>
                          handleAction(node.nodeId, () => onRemoveNode(node.nodeId))
                        }
                        title="Remove node"
                        className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="border-t border-zinc-800 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
