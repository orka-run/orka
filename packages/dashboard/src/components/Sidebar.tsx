// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useId, useState } from "react";
import { Link2, MessageSquarePlus, Plus, Search, Server, Settings2 } from "lucide-react";
import type { NodeInfo } from "@orka/core";
import type { SessionSummary } from "../stores/sessionStore";
import { formatRelativeTime } from "../lib/sessionUi";

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  isDraftActive?: boolean;
  nodes: NodeInfo[];
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onSelectDraft?: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onPairNode?: () => void;
  onManageNodes?: () => void;
}

export function Sidebar({
  sessions,
  selectedId,
  isDraftActive,
  nodes,
  selectedNodeId,
  onSelect,
  onNewSession,
  onSelectDraft,
  onSelectNode,
  onPairNode,
  onManageNodes,
}: SidebarProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const now = Date.now();
  const showNodeSelector = nodes.length > 1;

  // Filter by selected node
  const nodeFilteredSessions = selectedNodeId
    ? sessions.filter((s) => s.nodeId === selectedNodeId)
    : sessions;

  const runningCount = nodeFilteredSessions.filter((session) => isActive(session.status)).length;
  const filteredSessions = nodeFilteredSessions.filter((session) => matchesQuery(session, normalizedQuery));

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">orka</h1>
            <p className="mt-1 text-xs text-zinc-500">
              {runningCount} active / {nodeFilteredSessions.length} total
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onNewSession}
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 transition hover:bg-white"
            >
              <Plus className="h-4 w-4" />
              New Session
            </button>
            {onManageNodes && (
              <button
                type="button"
                onClick={onManageNodes}
                title="Manage Nodes"
                className="rounded-lg border border-zinc-800 p-2 text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-100"
              >
                <Settings2 className="h-4 w-4" />
              </button>
            )}
            {onPairNode && (
              <button
                type="button"
                onClick={onPairNode}
                title="Pair Node"
                className="rounded-lg border border-zinc-800 p-2 text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-100"
              >
                <Link2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        {showNodeSelector ? (
          <NodeSelector
            nodes={nodes}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
          />
        ) : null}
        <div className="relative mt-4">
          <label htmlFor={searchId} className="sr-only">
            Search sessions
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {isDraftActive ? (
          <button
            type="button"
            onClick={() => onSelectDraft?.()}
            className="mb-4 flex w-full items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-3 text-left transition"
          >
            <MessageSquarePlus className="h-4 w-4 shrink-0 text-sky-400" />
            <span className="text-sm font-medium text-sky-200">New chat</span>
          </button>
        ) : null}
        {filteredSessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/60 px-4 py-8 text-center">
            <p className="text-sm font-medium text-zinc-200">
              {sessions.length === 0 ? "No sessions yet" : "No sessions match"}
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              {sessions.length === 0
                ? "Create a new session to start streaming work here."
                : "Adjust the search input to see more sessions."}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {filteredSessions.map((session) => {
              const isSelected = selectedId === session.id;

              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                      isSelected
                        ? "border-zinc-700 bg-zinc-900 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
                        : "border-zinc-900 bg-zinc-950 hover:border-zinc-800 hover:bg-zinc-900/70"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="truncate text-sm font-medium text-zinc-100">
                          {session.title || session.id}
                        </p>
                        <span className="shrink-0 text-xs text-zinc-500">
                          {formatRelativeTime(session.createdAt, now)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-300">
                          {session.backend}
                        </span>
                        <StatusPill status={session.status} />
                        {session.nodeId && showNodeSelector ? (
                          <NodeBadge nodeId={session.nodeId} />
                        ) : null}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function NodeSelector({
  nodes,
  selectedNodeId,
  onSelectNode,
}: {
  nodes: NodeInfo[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <Server className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <div className="flex flex-1 flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onSelectNode(null)}
          className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
            selectedNodeId === null
              ? "bg-zinc-100 text-zinc-950"
              : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          All nodes
        </button>
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node.id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition ${
              selectedNodeId === node.id
                ? "bg-zinc-100 text-zinc-950"
                : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                node.status === "online" ? "bg-emerald-400" : "bg-zinc-600"
              }`}
            />
            {node.id}
          </button>
        ))}
      </div>
    </div>
  );
}

function NodeBadge({ nodeId }: { nodeId: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/50 px-1.5 py-0.5 text-[10px] text-zinc-500">
      <Server className="h-2.5 w-2.5" />
      {nodeId}
    </span>
  );
}

function isActive(status: SessionSummary["status"]): boolean {
  return status === "running" || status === "queued" || status === "preparing";
}

function matchesQuery(session: SessionSummary, query: string): boolean {
  if (!query) {
    return true;
  }

  const haystack = [session.id, session.title, session.backend, session.status, session.model ?? "", session.nodeId ?? ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

const STATUS_CONFIG: Record<
  SessionSummary["status"],
  { dotClass: string; label?: string }
> = {
  running: { dotClass: "bg-emerald-400 animate-pulse", label: "Running" },
  queued: { dotClass: "bg-sky-400 animate-pulse", label: "Queued" },
  preparing: { dotClass: "bg-sky-400 animate-pulse", label: "Preparing" },
  completed: { dotClass: "bg-zinc-500" },
  failed: { dotClass: "bg-red-400", label: "Failed" },
  cancelled: { dotClass: "bg-amber-400" },
  interrupted: { dotClass: "bg-orange-400", label: "Interrupted" },
};

function StatusPill({ status }: { status: SessionSummary["status"] }) {
  const config = STATUS_CONFIG[status] ?? { dotClass: "bg-zinc-500" };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${config.dotClass}`} />
      {config.label && (
        <span className="text-[11px] text-zinc-400">{config.label}</span>
      )}
    </span>
  );
}
