// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import { useRpcClient } from "../lib/transportContext";
import { useTimelineCache } from "../lib/timelineCache";
import { useChatUiStore } from "../stores/chatUiStore";
import { formatDateTime, formatRelativeTime } from "../lib/sessionUi";
import { shortenPaths } from "../lib/pathUtils";

const EMPTY_SET = new Set<string>();

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

/** Shorten absolute paths by removing worktree and project prefixes. */
function shortenPath(text: string, projectPath?: string): string {
  return shortenPaths(text, projectPath ?? null);
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

  // If session reached terminal state, clear all inProgress flags —
  // no tool is actually running anymore even if item.completed was never emitted
  const hasTerminalEvent = events.some((e) =>
    e.type === "session.completed" || e.type === "session.failed" || e.type === "session.cancelled",
  );
  if (hasTerminalEvent) {
    for (const entry of entries) {
      if (entry.type === "tool_group") {
        for (const tool of entry.tools) {
          tool.inProgress = false;
        }
      }
    }
  }

  return entries;
}

export function ChatView({ sessionId, initialPrompt, onSelectionLoadSettled, isMobile = false }: ChatViewProps) {
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const transport = useTransport();
  const client = useRpcClient();

  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-session UI state from store (survives session switches and page reloads)
  const autoScroll = useChatUiStore((s) => s.sessions[sessionId]?.autoScroll ?? true);
  const expandedGroups = useChatUiStore((s) => s.sessions[sessionId]?.expandedGroups ?? EMPTY_SET);
  const entriesAtPauseRef = useRef(0);
  // Track scroll position in a ref to avoid store updates on every scroll event
  const scrollTopRef = useRef(0);
  // Pending scroll restoration after session switch (when autoScroll was false)
  const pendingScrollRestoreRef = useRef<number | null>(null);

  const handleToggleGroup = useCallback((groupId: string, isOpen: boolean) => {
    const current = useChatUiStore.getState().get(sessionId);
    const next = new Set(current.expandedGroups);
    if (isOpen) {
      next.add(groupId);
    } else {
      next.delete(groupId);
    }
    useChatUiStore.getState().update(sessionId, { expandedGroups: next });
  }, [sessionId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Mutable refs for the push handler to accumulate deltas without re-subscribing
  const eventsRef = useRef<OrchestrationEvent[]>([]);
  // Guard to prevent handleScroll from disabling autoScroll during programmatic scrolls
  const programmaticScrollRef = useRef(false);
  // Stable refs for values used in effects without triggering re-runs
  const initialPromptRef = useRef(initialPrompt);
  initialPromptRef.current = initialPrompt;
  const onSelectionLoadSettledRef = useRef(onSelectionLoadSettled);
  onSelectionLoadSettledRef.current = onSelectionLoadSettled;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 5,
  });

  const getCachedTimeline = useTimelineCache((s) => s.get);
  const setCachedTimeline = useTimelineCache((s) => s.set);

  // Fetch initial timeline — only re-runs when sessionId changes
  useEffect(() => {
    let cancelled = false;
    eventsRef.current = [];

    // Check prefetch cache for instant display
    const cached = getCachedTimeline(sessionId);
    if (cached) {
      const filtered = cached.filter((e) => e.sessionId === sessionId);
      eventsRef.current = filtered;
      setEvents(filtered);
      setEntries(eventsToEntries(filtered, initialPromptRef.current, session?.projectPath));
      setIsLoading(false);
      onSelectionLoadSettledRef.current?.("ok");
    } else {
      setIsLoading(true);
      setError(null);
      setEvents([]);
      setEntries([]);
    }

    // Always fetch fresh data (stale-while-revalidate for running sessions)
    async function load() {
      try {
        const response = await client.getSessionTimeline({ sessionId });
        if (cancelled) return;

        const timeline = response.events;
        const filtered = timeline.filter((e: OrchestrationEvent) => e.sessionId === sessionId);
        eventsRef.current = filtered;
        setEvents(filtered);
        setEntries(eventsToEntries(filtered, initialPromptRef.current, session?.projectPath));
        setCachedTimeline(sessionId, timeline);
        onSelectionLoadSettledRef.current?.("ok");
      } catch (e) {
        if (cancelled) return;
        // Only show error if we have no cached data
        if (!cached) {
          setError(e instanceof Error ? e.message : "Failed to load chat timeline");
          onSelectionLoadSettledRef.current?.("error", e);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [sessionId, client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to real-time orchestration events
  useEffect(() => {
    const unsubscribe = transport.subscribe("orchestration.event", (data) => {
      const event = data as OrchestrationEvent;
      if (event.sessionId !== sessionId) return;

      eventsRef.current = [...eventsRef.current, event];
      setEvents(eventsRef.current);
      setEntries(eventsToEntries(eventsRef.current, initialPromptRef.current, session?.projectPath));
    });

    return unsubscribe;
  }, [sessionId, transport]);

  // On session switch: check if scroll position needs restoring, and save outgoing session's scrollTop
  useEffect(() => {
    programmaticScrollRef.current = false;
    const state = useChatUiStore.getState().get(sessionId);
    if (!state.autoScroll) {
      pendingScrollRestoreRef.current = state.scrollTop;
    } else {
      pendingScrollRestoreRef.current = null;
    }
    return () => {
      // Save scroll position of the session we're leaving
      useChatUiStore.getState().update(sessionId, { scrollTop: scrollTopRef.current });
    };
  }, [sessionId]);

  // Restore scroll position after entries load (when autoScroll was false for this session)
  useEffect(() => {
    if (pendingScrollRestoreRef.current === null || entries.length === 0) return;
    const scrollTarget = pendingScrollRestoreRef.current;
    pendingScrollRestoreRef.current = null;

    programmaticScrollRef.current = true;
    const timer = setTimeout(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = scrollTarget;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    }, 100);

    return () => {
      clearTimeout(timer);
      programmaticScrollRef.current = false;
    };
  }, [entries.length]);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (!autoScroll || entries.length === 0) return;

    programmaticScrollRef.current = true;

    // Simple approach: just scroll the container to the bottom.
    // Virtualizer renders items based on scroll position, so this works.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;

    // Virtualizer may re-measure and adjust layout — scroll again after settle
    const timer = setTimeout(() => {
      if (el) el.scrollTop = el.scrollHeight;
      // Keep guard active a bit longer to absorb virtualizer re-measure scrolls
      setTimeout(() => { programmaticScrollRef.current = false; }, 50);
    }, 150);

    return () => {
      clearTimeout(timer);
      programmaticScrollRef.current = false;
    };
  }, [entries.length, autoScroll]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect manual scroll to pause auto-scroll
  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const currentAutoScroll = useChatUiStore.getState().get(sessionId).autoScroll;
    if (!isAtBottom && currentAutoScroll) {
      entriesAtPauseRef.current = entries.length;
    }
    if (isAtBottom !== currentAutoScroll) {
      useChatUiStore.getState().update(sessionId, { autoScroll: isAtBottom, scrollTop: el.scrollTop });
    }
  }, [sessionId, entries.length]);

  const scrollToBottom = useCallback(() => {
    useChatUiStore.getState().update(sessionId, { autoScroll: true });
    programmaticScrollRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setTimeout(() => { programmaticScrollRef.current = false; }, 500);
  }, [sessionId]);

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
      await client.resolveApproval(requestId, decision);
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
  }, [client]);

  if (!session) {
    return (
      <div className="rounded-sm border border-border bg-surface p-2 text-[12px] text-ink-muted">
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
    useChatUiStore.getState().update(sessionId, { autoScroll: true });

    try {
      await withDashboardSpan(
        "orka.dashboard.chat.send_input",
        {
          "orka.session.id": sessionId,
          "orka.backend": activeSession.backend,
          "orka.input.length": text.length,
        },
        async () => {
          await client.sendTurn(sessionId, text);
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
      await client.stopSession(sessionId);
    } finally {
      setStopping(false);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      await client.retrySession(sessionId);
    } finally {
      setRetrying(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-sm border border-border bg-surface">
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading chat timeline…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-sm border border-status-error/30 bg-status-error/10 p-2 text-[12px] text-status-error">
        <p className="font-medium">Unable to load chat timeline.</p>
        <p className="mt-1 opacity-80">{error}</p>
      </div>
    );
  }

  return (
    <div className={`flex h-full flex-col overflow-hidden ${isMobile ? "bg-surface" : "rounded-sm border border-border bg-surface"}`}>
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`h-full flex-1 overflow-y-auto overflow-x-hidden ${isMobile ? "px-1 py-1" : "px-2 py-2"}`}
        >
          {entries.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-ink-muted">No messages yet.</div>
          ) : (
            <div className="min-w-0" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const entry = entries[virtualRow.index];
                if (!entry) return null;
                return (
                  <div
                    key={entry.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className="pb-2">
                      <TimelineEntry
                        entry={entry}
                        isExpanded={expandedGroups.has(entry.id)}
                        onToggleExpand={handleToggleGroup}
                        onApprovalResolve={handleApprovalResolve}
                        projectPath={session?.projectPath}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {isRunning(activeSession.status) ? <ThinkingIndicator state={deriveThinkingState(events)} /> : null}
          <div ref={bottomRef} />
        </div>

        {!autoScroll ? (() => {
          const newCount = Math.max(0, entries.length - entriesAtPauseRef.current);
          return (
            <button
              type="button"
              onClick={scrollToBottom}
              className="absolute bottom-2 right-4 flex items-center gap-1 rounded-sm border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink-secondary backdrop-blur transition hover:bg-surface-hover"
            >
              <ArrowDown className="h-3 w-3" />
              {newCount > 0 ? `+${newCount} new` : "Bottom"}
            </button>
          );
        })() : null}
      </div>
      <div className="border-t border-border">
        <ChatInputComposer
          sessionId={sessionId}
          inputState={inputState}
          onSend={handleSend}
          sendError={sendError}
          onClearError={() => { setSendError(null); }}
          onStop={isRunning(activeSession.status) ? () => { void handleStop(); } : undefined}
          isStopping={stopping}
        />
      </div>
    </div>
  );
}

function ThinkingIndicator({ state }: { state: ThinkingState }) {
  if (state === "thinking") {
    return (
      <div className="flex items-center gap-2 px-1 py-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-sm bg-accent animate-pulse" />
          <span className="h-1.5 w-1.5 rounded-sm bg-accent animate-pulse [animation-delay:0.2s]" />
          <span className="h-1.5 w-1.5 rounded-sm bg-accent animate-pulse [animation-delay:0.4s]" />
        </div>
      </div>
    );
  }

  if (state === "tools") {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-ink-muted">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <LoaderCircle className="h-3 w-3 animate-spin" />
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
  projectPath,
}: {
  entry: ChatEntry;
  isExpanded?: boolean;
  onToggleExpand?: (groupId: string, isOpen: boolean) => void;
  onApprovalResolve?: (requestId: string, decision: "approve" | "deny") => Promise<void>;
  projectPath?: string;
}) {
  if (entry.type === "approval" && onApprovalResolve) {
    return <ApprovalCard entry={entry} onResolve={onApprovalResolve} />;
  }

  if (entry.type === "assistant") {
    return (
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 max-w-full rounded-sm rounded-tl-none border border-border bg-surface-alt px-2 py-1.5 lg:max-w-3xl [overflow-wrap:anywhere]">
          <MarkdownContent content={entry.body} />
          <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
        </div>
      </div>
    );
  }

  if (entry.type === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-full items-start gap-2 lg:max-w-3xl">
          <div className="min-w-0 rounded-sm rounded-tr-none border border-accent/20 bg-accent/5 px-2 py-1.5 [overflow-wrap:anywhere]">
            <MarkdownContent content={entry.body} />
            <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
          </div>
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
            <User className="h-3.5 w-3.5" />
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
        <div className="flex min-w-0 items-center gap-2 rounded-sm border border-border bg-surface-alt px-2 py-1">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
            {tool.inProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : toolIconEl(tool.icon, "h-3 w-3")}
          </div>
          <span className="min-w-0 truncate text-[11px] text-ink-secondary">{tool.title}</span>
        </div>
      );
    }

    // Shared inner tool list for multi-tool groups
    const toolsList = (
      <div className="border-t border-border">
        {entry.tools.map((tool) => (
          <details key={tool.id} className="overflow-hidden border-b border-border/50 last:border-b-0">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
                {tool.inProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : toolIconEl(tool.icon, "h-3 w-3")}
              </div>
              <span className="min-w-0 truncate text-[11px] font-medium text-ink-secondary">{tool.title}</span>
              {tool.summary !== tool.title ? (
                <span className="ml-auto max-w-[40%] shrink-0 truncate text-[10px] text-ink-muted">{tool.summary}</span>
              ) : null}
            </summary>
            {tool.details.length > 0 ? (
              <div className="border-t border-border/30 px-2 py-1">
                <ToolCallDetails title={tool.title} details={tool.details} args={tool.args} projectPath={projectPath} />
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
          className="overflow-hidden rounded-sm border border-border bg-surface-alt"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1">
            <div className="flex items-center gap-1.5">
              {isOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-ink-muted transition-transform" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-ink-muted transition-transform" />
              )}
              <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
                {hasInProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
              </div>
              <p className="text-[11px] text-ink-muted">{summary}</p>
            </div>
            <div className="shrink-0 text-[10px] text-ink-muted">{formatRelativeTime(entry.timestamp)}</div>
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
        className="overflow-hidden rounded-sm border border-border bg-surface-alt"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1">
          <div className="flex items-center gap-1.5">
            <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
              {hasInProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
            </div>
            <p className="text-[11px] text-ink-muted">{label}</p>
          </div>
          <div className="shrink-0 text-[10px] text-ink-muted">{formatRelativeTime(entry.timestamp)}</div>
        </summary>
        {toolsList}
      </details>
    );
  }

  if (entry.type === "error") {
    return (
      <div className="rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-2">
        <div className="flex items-center gap-1 text-status-error">
          <AlertTriangle className="h-3.5 w-3.5" />
          <p className="text-[12px] font-medium">{entry.title}</p>
        </div>
        <p className="mt-1 text-[12px] text-status-error/80">{entry.body}</p>
        <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-sm border border-border bg-surface-alt px-2 py-1.5">
      <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" />
      <div>
        <p className="text-[12px] font-medium text-ink">{entry.title}</p>
        <p className="mt-0.5 text-[11px] text-ink-muted">{entry.body}</p>
        <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
      </div>
    </div>
  );
}
