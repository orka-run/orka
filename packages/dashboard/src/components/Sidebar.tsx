// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useEffect, useId, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Layers, Link2, MessageSquarePlus, Plus, Search, Server, Settings2 } from "lucide-react";
import type { NodeInfo, WorkspaceInfo } from "@orka/core";
import type { SessionSummary } from "../stores/sessionStore";
import { formatRelativeTime } from "../lib/sessionUi";

const ITEM_HEIGHT = 48;
const GAP = 4;

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  isDraftActive?: boolean;
  nodes: NodeInfo[];
  selectedNodeId: string | null;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string | null;
  fullWidth?: boolean;
  onSelect: (id: string) => void;
  onHover?: (id: string) => void;
  onNewSession: () => void;
  onSelectDraft?: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onSelectWorkspace: (id: string | null) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onPairNode?: () => void;
  onManageNodes?: () => void;
}

export function Sidebar({
  sessions,
  selectedId,
  isDraftActive,
  nodes,
  selectedNodeId,
  workspaces,
  activeWorkspaceId,
  fullWidth,
  onSelect,
  onHover,
  onNewSession,
  onSelectDraft,
  onSelectNode,
  onSelectWorkspace,
  onCreateWorkspace,
  onPairNode,
  onManageNodes,
}: SidebarProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const now = Date.now();
  const showNodeSelector = nodes.length > 1;
  const showWorkspaceSwitcher = workspaces.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Filter by selected node
  const nodeFilteredSessions = selectedNodeId
    ? sessions.filter((s) => s.nodeId === selectedNodeId)
    : sessions;

  // Filter by active workspace
  const activeWorkspace = activeWorkspaceId
    ? workspaces.find((w) => w.id === activeWorkspaceId) ?? null
    : null;

  const workspaceFilteredSessions = activeWorkspace
    ? nodeFilteredSessions.filter((s) =>
        activeWorkspace.paths.some(
          (p) => p.projectPath === s.projectPath && (!p.nodeId || p.nodeId === s.nodeId),
        ),
      )
    : nodeFilteredSessions;

  const runningCount = workspaceFilteredSessions.filter((session) => isActive(session.status)).length;
  const filteredSessions = workspaceFilteredSessions.filter((session) => matchesQuery(session, normalizedQuery));

  const virtualizer = useVirtualizer({
    count: filteredSessions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT + GAP,
    overscan: 5,
  });

  // Scroll selected session into view when selection changes
  useEffect(() => {
    if (!selectedId) return;
    const idx = filteredSessions.findIndex((s) => s.id === selectedId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className={`flex shrink-0 flex-col border-r border-border bg-surface ${fullWidth ? "w-full" : "w-80"}`}>
      <div className="border-b border-border px-2 py-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-[13px] font-semibold text-ink">orka</h1>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              {runningCount} active / {workspaceFilteredSessions.length} total
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onNewSession}
              className="inline-flex items-center gap-1 rounded-sm bg-accent-strong px-2 py-1 text-[11px] font-medium text-white transition hover:bg-accent"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
            {onManageNodes && (
              <button
                type="button"
                onClick={onManageNodes}
                title="Manage Nodes"
                className="rounded-sm border border-border p-1 text-ink-muted transition hover:border-ink-muted hover:text-ink"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            )}
            {onPairNode && (
              <button
                type="button"
                onClick={onPairNode}
                title="Pair Node"
                className="rounded-sm border border-border p-1 text-ink-muted transition hover:border-ink-muted hover:text-ink"
              >
                <Link2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {showWorkspaceSwitcher ? (
          <WorkspaceSwitcher
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={onSelectWorkspace}
            onCreateWorkspace={onCreateWorkspace}
          />
        ) : null}
        {showNodeSelector ? (
          <NodeSelector
            nodes={nodes}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
          />
        ) : null}
        <div className="relative mt-2">
          <label htmlFor={searchId} className="sr-only">
            Search sessions
          </label>
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            className="w-full rounded-sm border border-border bg-surface-alt py-1 pl-7 pr-2 text-[11px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
          />
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 py-2">
        {isDraftActive ? (
          <button
            type="button"
            onClick={() => onSelectDraft?.()}
            className="mb-2 flex w-full items-center gap-2 rounded-sm border border-accent/30 bg-accent/10 px-2 py-1 text-left transition"
          >
            <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-accent-strong" />
            <span className="text-[11px] font-medium text-accent-strong">New chat</span>
          </button>
        ) : null}
        {filteredSessions.length === 0 ? (
          <div className="rounded-sm border border-dashed border-border bg-surface-alt px-2 py-4 text-center">
            <p className="text-[11px] font-medium text-ink-secondary">
              {sessions.length === 0 ? "No sessions yet" : "No sessions match"}
            </p>
            <p className="mt-1 text-[11px] text-ink-muted">
              {sessions.length === 0
                ? "Create a new session to start streaming work here."
                : "Adjust the search input to see more sessions."}
            </p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const session = filteredSessions[virtualRow.index];
              if (!session) return null;
              const isSelected = selectedId === session.id;
              return (
                <div
                  key={session.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div style={{ height: ITEM_HEIGHT, marginBottom: GAP }}>
                    <button
                      type="button"
                      onClick={() => onSelect(session.id)}
                      onMouseEnter={() => onHover?.(session.id)}
                      className={`h-full w-full overflow-hidden rounded-sm border px-2 py-1 text-left transition ${
                        isSelected
                          ? "border-border bg-surface-alt"
                          : "border-transparent bg-surface hover:border-border hover:bg-surface-alt"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="truncate text-[11px] font-medium text-ink">
                            {session.title || session.id}
                          </p>
                          <span className="shrink-0 text-[10px] text-ink-muted">
                            {formatRelativeTime(session.createdAt, now)}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          <span className="rounded-sm border border-border bg-surface-alt px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-secondary">
                            {session.backend}
                          </span>
                          <StatusPill status={session.status} />
                          {session.permissionMode === "bypass" ? (
                            <span className="inline-flex items-center gap-0.5 text-[9px] text-red-400" title="Bypass permissions">
                              <AlertTriangle className="h-2.5 w-2.5" />
                            </span>
                          ) : null}
                          {session.nodeId && showNodeSelector ? (
                            <NodeBadge nodeId={session.nodeId} />
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
}: {
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string | null) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCreating) inputRef.current?.focus();
  }, [isCreating]);

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    await onCreateWorkspace(trimmed);
    setNewName("");
    setIsCreating(false);
  }

  return (
    <div className="mt-2 flex items-center gap-1">
      <Layers className="h-3 w-3 shrink-0 text-ink-muted" />
      <div className="flex flex-1 flex-wrap gap-1">
        <button
          type="button"
          onClick={() => onSelectWorkspace(null)}
          className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium transition ${
            activeWorkspaceId === null
              ? "bg-accent-strong text-white"
              : "bg-surface-alt text-ink-muted hover:text-ink-secondary"
          }`}
        >
          All
        </button>
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            type="button"
            onClick={() => onSelectWorkspace(ws.id)}
            className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium transition ${
              activeWorkspaceId === ws.id
                ? "bg-accent-strong text-white"
                : "bg-surface-alt text-ink-muted hover:text-ink-secondary"
            }`}
          >
            {ws.metadata?.color ? (
              <span
                className="inline-block h-1.5 w-1.5 rounded-sm"
                style={{ backgroundColor: ws.metadata.color }}
              />
            ) : null}
            {ws.name}
            {ws.activeCount > 0 ? (
              <span className="text-[9px] opacity-60">{ws.activeCount}</span>
            ) : null}
          </button>
        ))}
        {isCreating ? (
          <input
            ref={inputRef}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
              if (e.key === "Escape") {
                setIsCreating(false);
                setNewName("");
              }
            }}
            onBlur={() => {
              setIsCreating(false);
              setNewName("");
            }}
            placeholder="Name…"
            className="w-20 rounded-sm border border-accent bg-surface-alt px-1.5 py-0.5 text-[10px] text-ink outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsCreating(true)}
            className="rounded-sm px-1 py-0.5 text-ink-muted transition hover:bg-surface-alt hover:text-ink-secondary"
            title="Create workspace"
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
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
    <div className="mt-2 flex items-center gap-1">
      <Server className="h-3 w-3 shrink-0 text-ink-muted" />
      <div className="flex flex-1 flex-wrap gap-1">
        <button
          type="button"
          onClick={() => onSelectNode(null)}
          className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium transition ${
            selectedNodeId === null
              ? "bg-accent-strong text-white"
              : "bg-surface-alt text-ink-muted hover:text-ink-secondary"
          }`}
        >
          All nodes
        </button>
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node.id)}
            className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium transition ${
              selectedNodeId === node.id
                ? "bg-accent-strong text-white"
                : "bg-surface-alt text-ink-muted hover:text-ink-secondary"
            }`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-sm ${
                node.status === "online" ? "bg-emerald-600" : "bg-ink-muted"
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
    <span className="inline-flex items-center gap-0.5 rounded-sm border border-border bg-surface-alt px-1 py-0.5 text-[9px] text-ink-muted">
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
  { dotClass: string; label: string }
> = {
  running: { dotClass: "bg-status-running animate-pulse", label: "Running" },
  idle: { dotClass: "bg-accent", label: "Idle" },
  hibernated: { dotClass: "bg-ink-muted", label: "Done" },
  queued: { dotClass: "bg-accent animate-pulse", label: "Queued" },
  preparing: { dotClass: "bg-accent animate-pulse", label: "Preparing" },
  completed: { dotClass: "bg-ink-muted", label: "Done" },
  failed: { dotClass: "bg-status-error", label: "Failed" },
  cancelled: { dotClass: "bg-ink-muted", label: "Cancelled" },
  interrupted: { dotClass: "bg-status-warning", label: "Interrupted" },
};

function StatusPill({ status }: { status: SessionSummary["status"] }) {
  const config = STATUS_CONFIG[status] ?? { dotClass: "bg-ink-muted", label: status };
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-1.5 w-1.5 rounded-sm ${config.dotClass}`} />
      <span className="text-[10px] text-ink-muted">{config.label}</span>
    </span>
  );
}
