// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Bot, ChevronDown, ChevronRight, Clock3, FileCode2, Globe, LoaderCircle, RotateCcw, Search, Square, TerminalSquare, User, Wrench, Eye } from "lucide-react";
import type { OrchestrationEvent } from "@orka/core";
import type { SessionSummary } from "../stores/sessionStore";
import { withDashboardSpan } from "../lib/tracing";
import { MarkdownContent } from "./MarkdownContent";
import { ToolCallDetails } from "./ToolCallDetails";
import { ApprovalCard, type ApprovalEntry } from "./ApprovalCard";
import { ChatInputComposer } from "./ChatInputComposer";
import { useInputState } from "../hooks/useInputState";
import { useSessionStore } from "../stores/sessionStore";
import { useTransport } from "../lib/transportContext";
import { formatDateTime, formatRelativeTime } from "../lib/sessionUi";

type ToolIcon = "command" | "file" | "read" | "search" | "web" | "agent";

interface ToolEntry {
  id: string;
  timestamp: string;
  title: string;
  summary: string;
  icon: ToolIcon;
  details: string[];
  args?: unknown;
  inProgress?: boolean;
}

type ChatEntry =
  | {
      id: string;
      type: "system";
      timestamp: string;
      title: string;
      body: string;
    }
  | {
      id: string;
      type: "assistant";
      timestamp: string;
      body: string;
    }
  | {
      id: string;
      type: "user";
      timestamp: string;
      body: string;
    }
  | {
      id: string;
      type: "tool-group";
      timestamp: string;
      tools: ToolEntry[];
    }
  | {
      id: string;
      type: "error";
      timestamp: string;
      title: string;
      body: string;
    }
  | ApprovalEntry;

interface ChatViewProps {
  sessionId: string;
  initialPrompt?: string;
  onSelectionLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
  isMobile?: boolean;
}

function isRunning(status: SessionSummary["status"]): boolean {
  return status === "queued" || status === "preparing" || status === "running";
}

type ThinkingState = "thinking" | "tools" | "writing" | "idle";

/**
 * Derive the agent's current activity state from the event stream.
 * Used to show an appropriate thinking/busy indicator.
 */
function deriveThinkingState(events: OrchestrationEvent[]): ThinkingState {
  // Walk backwards to find the last meaningful event
  const completedItemIds = new Set<string>();
  for (const e of events) {
    if (e.type === "item.completed") completedItemIds.add(e.itemId);
  }

  // Check for in-progress tools (item.started without item.completed)
  let hasInProgressTool = false;
  for (const e of events) {
    if (e.type === "item.started" && !completedItemIds.has(e.itemId)) {
      hasInProgressTool = true;
    }
  }
  if (hasInProgressTool) return "tools";

  // Find last meaningful event by walking backwards
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    switch (e.type) {
      case "content.delta":
        return "writing";
      case "turn.started":
        return "thinking";
      case "turn.completed":
      case "turn.aborted":
      case "session.completed":
      case "session.failed":
      case "session.cancelled":
        return "idle";
      case "item.completed":
      case "item.updated":
        // Just finished a tool, model is thinking about next step
        return "thinking";
      case "event.passthrough":
        continue;
      default:
        continue;
    }
  }

  return "idle";
}

function isTerminal(status: SessionSummary["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Map an item type to an icon kind for tool entries. */
function itemIcon(itemType: string): ToolIcon {
  switch (itemType) {
    case "file_change": return "file";
    case "file_read": return "read";
    case "search": return "search";
    case "web": return "web";
    case "agent": return "agent";
    case "command_execution": return "command";
    default: return "command";
  }
}

/** Render the appropriate icon element for a tool type. */
function toolIconEl(icon: ToolIcon, size: string): React.ReactElement {
  switch (icon) {
    case "command": return <TerminalSquare className={size} />;
    case "file": return <FileCode2 className={size} />;
    case "read": return <Eye className={size} />;
    case "search": return <Search className={size} />;
    case "web": return <Globe className={size} />;
    case "agent": return <Bot className={size} />;
  }
}

/** Shorten absolute paths by removing a workdir prefix. */
function shortenPath(text: string, workDir?: string): string {
  if (!workDir) return text;
  // Replace absolute workdir paths with relative ones
  const prefix = workDir.endsWith("/") ? workDir : workDir + "/";
  return text.replaceAll(prefix, "");
}

/** Build a descriptive summary line for a collapsed tool group. */
function buildToolGroupSummary(tools: ToolEntry[]): string {
  const counts: Record<string, number> = {};
  let inProgressCount = 0;
  for (const t of tools) {
    counts[t.icon] = (counts[t.icon] ?? 0) + 1;
    if (t.inProgress) inProgressCount++;
  }

  const labels: Record<string, [string, string]> = {
    file: ["edit", "edits"],
    read: ["read", "reads"],
    command: ["command", "commands"],
    search: ["search", "searches"],
    web: ["fetch", "fetches"],
    agent: ["agent", "agents"],
  };

  const parts: string[] = [];
  for (const [icon, count] of Object.entries(counts)) {
    const [singular, plural] = labels[icon] ?? ["call", "calls"];
    parts.push(`${String(count)} ${count === 1 ? singular : plural}`);
  }

  const text = parts.length > 0 ? parts.join(", ") : `${String(tools.length)} tool calls`;
  if (inProgressCount > 0) {
    return text + ` (${String(inProgressCount)} in progress)`;
  }
  return text;
}

/**
 * Process a full list of OrchestrationEvents into ChatEntries.
 *
 * - Content deltas are accumulated into assistant message entries.
 * - item.started/item.completed are deduplicated (completed wins) and grouped into tool-group entries.
 * - request.opened/request.resolved are mapped to approval entries.
 * - Noisy system events (session.created, session.started, turn.started) are hidden.
 */
function eventsToEntries(events: OrchestrationEvent[], initialPrompt?: string, workDir?: string): ChatEntry[] {
  // First pass: collect items by itemId so we can deduplicate started/completed
  const completedItemIds = new Set<string>();
  // Collect metadata from item.started for enriching item.completed (which often lacks title/detail)
  const startedMeta = new Map<string, { title?: string; detail?: string; itemType: string; args?: unknown }>();
  for (const event of events) {
    if (event.type === "item.completed") completedItemIds.add(event.itemId);
    if (event.type === "item.started") {
      startedMeta.set(event.itemId, {
        title: event.title,
        detail: event.detail,
        itemType: event.itemType,
        args: event.args,
      });
    }
  }

  // First pass: collect request resolutions so we can update approval entries
  const resolvedRequests = new Map<string, string>();
  for (const event of events) {
    if (event.type === "request.resolved") {
      resolvedRequests.set(event.requestId, event.decision);
    }
  }

  const entries: ChatEntry[] = [];
  let accum = "";
  let accumTurnId: string | null = null;
  let accumStart: string | null = null;

  // Pending tool entries to be grouped
  let pendingTools: ToolEntry[] = [];

  function flushAssistant() {
    if (accum && accumStart) {
      entries.push({
        id: `assistant-${accumTurnId ?? "unknown"}-${accumStart}`,
        type: "assistant",
        timestamp: accumStart,
        body: accum,
      });
    }
    accum = "";
    accumTurnId = null;
    accumStart = null;
  }

  function flushToolGroup() {
    if (pendingTools.length === 0) return;
    const first = pendingTools[0];
    if (!first) return;
    entries.push({
      id: `tool-group-${first.id}`,
      type: "tool-group",
      timestamp: first.timestamp,
      tools: pendingTools,
    });
    pendingTools = [];
  }

  if (initialPrompt) {
    const timestamp = events[0]?.timestamp ?? new Date().toISOString();
    entries.push({
      id: `initial-prompt-${timestamp}`,
      type: "user",
      timestamp,
      body: initialPrompt,
    });
  }

  for (const event of events) {
    if (event.type === "content.delta") {
      if (event.streamKind === "assistant_text" || event.streamKind === "reasoning_text") {
        // If we have pending tools and now get text, flush the tool group first
        if (pendingTools.length > 0) {
          flushToolGroup();
        }
        if (accumTurnId !== event.turnId) {
          flushAssistant();
          accumTurnId = event.turnId;
          accumStart = event.timestamp;
        }
        accum += event.delta;
      }
      continue;
    }

    // item.started: skip if we already have a completed event for this item
    if (event.type === "item.started") {
      if (completedItemIds.has(event.itemId)) continue;
      flushAssistant();
      const title = shortenPath(event.title ?? event.itemType, workDir);
      const detail = shortenPath(event.detail ?? "", workDir);
      // Item is in-progress only if no subsequent item.completed exists for it
      const isInProgress = !completedItemIds.has(event.itemId);
      const summary = detail && detail !== title ? detail : (isInProgress ? "In progress…" : "Completed");
      pendingTools.push({
        id: event.itemId,
        timestamp: event.timestamp,
        title,
        summary,
        icon: itemIcon(event.itemType),
        details: detail && detail !== title ? [detail] : [],
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(isInProgress ? { inProgress: true } : {}),
      });
      continue;
    }

    // item.completed: add as tool entry (replaces started), enriched with started metadata
    if (event.type === "item.completed") {
      flushAssistant();
      const meta = startedMeta.get(event.itemId);
      const itemType = event.itemType !== "unknown" ? event.itemType : (meta?.itemType ?? event.itemType);
      // Title/summary from started (human-readable), output content from completed
      const title = shortenPath(event.title ?? meta?.title ?? itemType, workDir);
      const startedDetail = meta?.detail ? shortenPath(meta.detail, workDir) : "";
      const outputDetail = event.detail ? shortenPath(event.detail, workDir) : "";
      const summary = startedDetail && startedDetail !== title ? startedDetail : "Completed";
      // details[] contains the tool output for expandable view
      const detailContent = outputDetail || (startedDetail !== title ? startedDetail : "");
      const args = meta?.args ?? event.args;
      pendingTools.push({
        id: event.itemId,
        timestamp: event.timestamp,
        title,
        summary,
        icon: itemIcon(itemType),
        details: detailContent ? [detailContent] : [],
        ...(args !== undefined ? { args } : {}),
      });
      continue;
    }

    // item.updated: skip
    if (event.type === "item.updated") continue;

    // request.opened: create approval entry
    if (event.type === "request.opened") {
      flushAssistant();
      flushToolGroup();
      const decision = resolvedRequests.get(event.requestId);
      const status: ApprovalEntry["status"] = decision === "approve" || decision === "approve_session"
        ? "approved"
        : decision === "deny" || decision === "cancel"
          ? "denied"
          : "pending";
      entries.push({
        id: `approval-${event.requestId}`,
        type: "approval",
        timestamp: event.timestamp,
        requestId: event.requestId,
        requestType: event.requestType,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        status,
      });
      continue;
    }

    // request.resolved: skip (already handled in first pass)
    if (event.type === "request.resolved") continue;

    if (event.type === "event.passthrough") {
      flushAssistant();
      flushToolGroup();
      entries.push({
        id: `passthrough-${event.sessionId}-${event.timestamp}`,
        type: "system",
        timestamp: event.timestamp,
        title: `Unrecognized event: ${event.originalType}`,
        body: typeof event.rawPayload === "object"
          ? (JSON.stringify(event.rawPayload, null, 2) ?? "")
          : String(event.rawPayload ?? ""),
      });
      continue;
    }

    // Non-tool, non-delta event: flush both accumulators
    if (
      event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "user.input"
    ) {
      flushAssistant();
      flushToolGroup();
    }

    // Skip noisy system events that don't add value in chat
    if (event.type === "session.created" || event.type === "session.started" || event.type === "turn.started") {
      continue;
    }

    // Map remaining events
    switch (event.type) {
      case "turn.completed": {
        const parts: string[] = [];
        if (event.cost != null) parts.push(`$${event.cost.toFixed(4)}`);
        if (event.tokens) parts.push(`${String(event.tokens.input)} in / ${String(event.tokens.output)} out`);
        if (parts.length > 0) {
          entries.push({
            id: `turn-completed-${event.turnId}`,
            type: "system",
            timestamp: event.timestamp,
            title: "Turn completed",
            body: parts.join(" · "),
          });
        }
        break;
      }
      case "turn.aborted":
        entries.push({
          id: `turn-aborted-${event.turnId}`,
          type: "error",
          timestamp: event.timestamp,
          title: "Turn aborted",
          body: event.reason,
        });
        break;
      case "user.input":
        entries.push({
          id: `user-input-${event.sessionId}-${event.timestamp}`,
          type: "user",
          timestamp: event.timestamp,
          body: event.text,
        });
        break;
      case "session.completed":
        flushToolGroup();
        entries.push({
          id: `${event.sessionId}-completed-${event.timestamp}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Session completed",
          body: event.exitCode != null ? `Exited with code ${String(event.exitCode)}.` : "The agent finished cleanly.",
        });
        break;
      case "session.failed":
        flushToolGroup();
        entries.push({
          id: `${event.sessionId}-failed-${event.timestamp}`,
          type: "error",
          timestamp: event.timestamp,
          title: "Session failed",
          body: event.error,
        });
        break;
      case "session.cancelled":
        flushToolGroup();
        entries.push({
          id: `${event.sessionId}-cancelled-${event.timestamp}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Session cancelled",
          body: event.reason ?? "The session was cancelled.",
        });
        break;
      case "runtime.error":
        entries.push({
          id: `runtime-error-${event.timestamp}-${event.turnId ?? ""}`,
          type: "error",
          timestamp: event.timestamp,
          title: "Runtime error",
          body: event.error,
        });
        break;
      case "runtime.warning":
        entries.push({
          id: `runtime-warning-${event.timestamp}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Warning",
          body: event.message,
        });
        break;
      default:
        break;
    }
  }

  flushAssistant();
  flushToolGroup();
  return entries;
}

export function ChatView({ sessionId, initialPrompt, onSelectionLoadSettled, isMobile = false }: ChatViewProps) {
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const transport = useTransport();

  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const handleToggleGroup = useCallback((groupId: string, isOpen: boolean) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (isOpen) {
        next.add(groupId);
      } else {
        next.delete(groupId);
      }
      return next;
    });
  }, []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Mutable refs for the push handler to accumulate deltas without re-subscribing
  const eventsRef = useRef<OrchestrationEvent[]>([]);
  // Stable refs for values used in effects without triggering re-runs
  const initialPromptRef = useRef(initialPrompt);
  initialPromptRef.current = initialPrompt;
  const onSelectionLoadSettledRef = useRef(onSelectionLoadSettled);
  onSelectionLoadSettledRef.current = onSelectionLoadSettled;

  // Fetch initial timeline — only re-runs when sessionId changes
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setEvents([]);
    setEntries([]);
    eventsRef.current = [];

    async function load() {
      try {
        const timeline = await transport.request<OrchestrationEvent[]>(
          "getSessionTimeline",
          { sessionId },
        );
        if (cancelled) return;

        const filtered = timeline.filter((e) => e.sessionId === sessionId);
        eventsRef.current = filtered;
        setEvents(filtered);
        setEntries(eventsToEntries(filtered, initialPromptRef.current, session?.workingDir));
        onSelectionLoadSettledRef.current?.("ok");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load chat timeline");
        onSelectionLoadSettledRef.current?.("error", e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [sessionId, transport]);

  // Subscribe to real-time orchestration events
  useEffect(() => {
    const unsubscribe = transport.subscribe("orchestration.event", (data) => {
      const event = data as OrchestrationEvent;
      if (event.sessionId !== sessionId) return;

      eventsRef.current = [...eventsRef.current, event];
      setEvents(eventsRef.current);
      setEntries(eventsToEntries(eventsRef.current, initialPromptRef.current, session?.workingDir));
    });

    return unsubscribe;
  }, [sessionId, transport]);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [entries.length, autoScroll]);

  // Detect manual scroll to pause auto-scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, []);

  const handleApprovalResolve = useCallback(async (requestId: string, decision: "approve" | "deny") => {
    // Optimistically update the approval entry
    setEntries((prev) =>
      prev.map((e) =>
        e.type === "approval" && e.requestId === requestId
          ? { ...e, status: decision === "approve" ? "approved" as const : "denied" as const }
          : e,
      ),
    );

    try {
      await transport.request("resolveApproval", { requestId, decision });
    } catch (err) {
      // Rollback on error
      setEntries((prev) =>
        prev.map((e) =>
          e.type === "approval" && e.requestId === requestId
            ? { ...e, status: "pending" as const }
            : e,
        ),
      );
      throw err;
    }
  }, [transport]);

  if (!session) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 text-sm text-zinc-400">
        Session data is unavailable.
      </div>
    );
  }

  const activeSession = session;
  const inputState = useInputState(events, activeSession.status, activeSession.backend);

  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function handleSend(text: string) {
    setSendError(null);

    // Optimistically add user message entry
    const optimisticEntry: ChatEntry = {
      id: `user-optimistic-${String(Date.now())}`,
      type: "user",
      timestamp: new Date().toISOString(),
      body: text,
    };
    setEntries((prev) => [...prev, optimisticEntry]);
    setAutoScroll(true);

    try {
      await withDashboardSpan(
        "orka.dashboard.chat.send_input",
        {
          "orka.session.id": sessionId,
          "orka.backend": activeSession.backend,
          "orka.input.length": text.length,
        },
        async () => {
          await transport.request("sendTurn", { sessionId, text });
        },
      );
    } catch (err) {
      // Remove the optimistic entry on failure
      setEntries((prev) => prev.filter((e) => e.id !== optimisticEntry.id));
      setSendError(err instanceof Error ? err.message : "Failed to send message");
      throw err;
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await transport.request("stopSession", { sessionId });
    } finally {
      setStopping(false);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      await transport.request("retrySession", { sessionId });
    } finally {
      setRetrying(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/50">
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading chat timeline…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-950 bg-red-950/20 p-4 text-sm text-red-200">
        <p className="font-medium">Unable to load chat timeline.</p>
        <p className="mt-1 text-red-200/80">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/70">
      {!isMobile && (
        <div className="border-b border-zinc-800 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Chat Timeline</p>
          <p className="mt-1 text-sm text-zinc-400">
            {isRunning(activeSession.status) ? "Streaming live events…" : `${String(entries.length)} events`}
          </p>
        </div>
      )}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full flex-1 overflow-y-auto overflow-x-hidden px-4 py-4"
        >
          <div className="min-w-0 space-y-4">
            {entries.length === 0 ? (
              <div className="py-12 text-center text-sm text-zinc-500">No messages yet.</div>
            ) : (
              entries.map((entry) => (
                <TimelineEntry
                  key={entry.id}
                  entry={entry}
                  isExpanded={expandedGroups.has(entry.id)}
                  onToggleExpand={handleToggleGroup}
                  onApprovalResolve={handleApprovalResolve}
                />
              ))
            )}
            {isRunning(activeSession.status) ? <ThinkingIndicator state={deriveThinkingState(events)} /> : null}
            <div ref={bottomRef} />
          </div>
        </div>

        {!autoScroll ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-4 right-6 flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/90 px-3 py-1.5 text-xs text-zinc-300 shadow-lg backdrop-blur transition hover:bg-zinc-700"
          >
            <ArrowDown className="h-3 w-3" />
            Scroll to bottom
          </button>
        ) : null}
      </div>
      <div className="border-t border-zinc-800">
        {(isRunning(activeSession.status) || isTerminal(activeSession.status)) && (
          <div className="flex items-center gap-2 px-4 py-2">
            {isRunning(activeSession.status) && (
              <button
                type="button"
                onClick={() => { void handleStop(); }}
                disabled={stopping}
                className="flex items-center gap-1.5 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-950/50 disabled:opacity-50"
              >
                {stopping ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                Stop
              </button>
            )}
            {isTerminal(activeSession.status) && (
              <button
                type="button"
                onClick={() => { void handleRetry(); }}
                disabled={retrying}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-50"
              >
                {retrying ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                Retry
              </button>
            )}
          </div>
        )}
        <ChatInputComposer
          sessionId={sessionId}
          inputState={inputState}
          onSend={handleSend}
          sendError={sendError}
          onClearError={() => { setSendError(null); }}
        />
      </div>
    </div>
  );
}

function ThinkingIndicator({ state }: { state: ThinkingState }) {
  if (state === "thinking") {
    return (
      <div className="flex items-center gap-3 px-1 py-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
          <Bot className="h-4 w-4" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
          <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse [animation-delay:0.2s]" />
          <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse [animation-delay:0.4s]" />
        </div>
      </div>
    );
  }

  if (state === "tools") {
    return (
      <div className="flex items-center gap-3 px-1 py-2 text-sm text-zinc-400">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
          <Bot className="h-4 w-4" />
        </div>
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        Running tools…
      </div>
    );
  }

  // "writing" and "idle" — no indicator needed
  return null;
}

function TimelineEntry({
  entry,
  isExpanded,
  onToggleExpand,
  onApprovalResolve,
}: {
  entry: ChatEntry;
  isExpanded?: boolean;
  onToggleExpand?: (groupId: string, isOpen: boolean) => void;
  onApprovalResolve?: (requestId: string, decision: "approve" | "deny") => Promise<void>;
}) {
  if (entry.type === "approval" && onApprovalResolve) {
    return <ApprovalCard entry={entry} onResolve={onApprovalResolve} />;
  }

  if (entry.type === "assistant") {
    return (
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 max-w-full rounded-2xl rounded-tl-md border border-zinc-800 bg-zinc-900 px-4 py-3 lg:max-w-3xl [overflow-wrap:anywhere]">
          <MarkdownContent content={entry.body} />
          <p className="mt-2 text-xs text-zinc-500">{formatDateTime(entry.timestamp)}</p>
        </div>
      </div>
    );
  }

  if (entry.type === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-full items-start gap-3 lg:max-w-3xl">
          <div className="min-w-0 rounded-2xl rounded-tr-md border border-indigo-900/50 bg-zinc-900 px-4 py-3 [overflow-wrap:anywhere]">
            <MarkdownContent content={entry.body} />
            <p className="mt-2 text-xs text-zinc-500">{formatDateTime(entry.timestamp)}</p>
          </div>
          <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/15 text-indigo-300">
            <User className="h-4 w-4" />
          </div>
        </div>
      </div>
    );
  }

  if (entry.type === "tool-group") {
    const hasInProgress = entry.tools.some((t) => t.inProgress);

    // Single tool: flat card, no collapsible wrapper
    if (entry.tools.length === 1) {
      const tool = entry.tools[0];
      if (!tool) return null;
      return (
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-zinc-400">
            {tool.inProgress ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : toolIconEl(tool.icon, "h-3.5 w-3.5")}
          </div>
          <span className="min-w-0 truncate text-sm text-zinc-300">{tool.title}</span>
        </div>
      );
    }

    // Shared inner tool list for multi-tool groups
    const toolsList = (
      <div className="border-t border-zinc-800">
        {entry.tools.map((tool) => (
          <details key={tool.id} className="overflow-hidden border-b border-zinc-800/50 last:border-b-0">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-zinc-800/80 text-zinc-400">
                {tool.inProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : toolIconEl(tool.icon, "h-3 w-3")}
              </div>
              <span className="min-w-0 truncate text-xs font-medium text-zinc-300">{tool.title}</span>
              {tool.summary !== tool.title ? (
                <span className="ml-auto max-w-[40%] shrink-0 truncate text-xs text-zinc-500">{tool.summary}</span>
              ) : null}
            </summary>
            {tool.details.length > 0 ? (
              <div className="border-t border-zinc-800/30 px-4 py-2">
                <ToolCallDetails title={tool.title} details={tool.details} args={tool.args} />
              </div>
            ) : null}
          </details>
        ))}
      </div>
    );

    // 3+ tools: collapsed by default, with chevron and smart summary
    if (entry.tools.length >= 3) {
      const isOpen = hasInProgress || (isExpanded ?? false);
      const summary = buildToolGroupSummary(entry.tools);
      return (
        <details
          open={isOpen}
          onToggle={(e) => {
            const newState = (e.currentTarget as HTMLDetailsElement).open;
            if (newState !== isOpen) onToggleExpand?.(entry.id, newState);
          }}
          className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-2.5">
            <div className="flex items-center gap-2.5">
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform" />
              )}
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-800 text-zinc-400">
                {hasInProgress ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
              </div>
              <p className="text-sm text-zinc-400">{summary}</p>
            </div>
            <div className="shrink-0 text-xs text-zinc-500">{formatRelativeTime(entry.timestamp)}</div>
          </summary>
          {toolsList}
        </details>
      );
    }

    // 2 tools: always open, simple summary
    const label = hasInProgress
      ? `Using ${String(entry.tools.length)} tools…`
      : `Used ${String(entry.tools.length)} tools`;
    return (
      <details
        open
        className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-800 text-zinc-400">
              {hasInProgress ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
            </div>
            <p className="text-sm text-zinc-400">{label}</p>
          </div>
          <div className="shrink-0 text-xs text-zinc-500">{formatRelativeTime(entry.timestamp)}</div>
        </summary>
        {toolsList}
      </details>
    );
  }

  if (entry.type === "error") {
    return (
      <div className="rounded-xl border border-red-950 bg-red-950/30 px-4 py-4">
        <div className="flex items-center gap-2 text-red-200">
          <AlertTriangle className="h-4 w-4" />
          <p className="text-sm font-medium">{entry.title}</p>
        </div>
        <p className="mt-2 text-sm text-red-100/90">{entry.body}</p>
        <p className="mt-2 text-xs text-red-200/70">{formatDateTime(entry.timestamp)}</p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
      <div>
        <p className="text-sm font-medium text-zinc-100">{entry.title}</p>
        <p className="mt-1 text-sm text-zinc-400">{entry.body}</p>
        <p className="mt-2 text-xs text-zinc-500">{formatDateTime(entry.timestamp)}</p>
      </div>
    </div>
  );
}
