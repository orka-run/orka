// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Bot, Clock3, FileCode2, LoaderCircle, RotateCcw, Square, TerminalSquare, User, Wrench } from "lucide-react";
import type { OrchestrationEvent } from "@orka/core";
import type { SessionSummary } from "../stores/sessionStore";
import { withDashboardSpan } from "../lib/tracing";
import { MarkdownContent } from "./MarkdownContent";
import { ToolCallDetails } from "./ToolCallDetails";
import { ChatInputComposer } from "./ChatInputComposer";
import { useInputState } from "../hooks/useInputState";
import { useSessionStore } from "../stores/sessionStore";
import { useTransport } from "../lib/transportContext";
import { formatDateTime, formatRelativeTime } from "../lib/sessionUi";

interface ToolEntry {
  id: string;
  timestamp: string;
  title: string;
  summary: string;
  icon: "command" | "file";
  details: string[];
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
    };

interface ChatViewProps {
  sessionId: string;
  initialPrompt?: string;
  onSelectionLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
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
    const e = events[i]!;
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
function itemIcon(itemType: string): "command" | "file" {
  if (itemType === "file_change") return "file";
  return "command";
}

/**
 * Process a full list of OrchestrationEvents into ChatEntries.
 *
 * - Content deltas are accumulated into assistant message entries.
 * - item.started/item.completed are deduplicated (completed wins) and grouped into tool-group entries.
 * - Noisy system events (session.created, session.started, turn.started) are hidden.
 */
function eventsToEntries(events: OrchestrationEvent[], initialPrompt?: string): ChatEntry[] {
  // First pass: collect items by itemId so we can deduplicate started/completed
  const completedItemIds = new Set<string>();
  for (const event of events) {
    if (event.type === "item.completed") completedItemIds.add(event.itemId);
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
        id: `assistant-${accumTurnId}-${accumStart}`,
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
    const first = pendingTools[0]!;
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
      const title = event.title ?? event.itemType;
      const detail = event.detail ?? "";
      const summary = detail && detail !== title ? detail : "In progress…";
      pendingTools.push({
        id: event.itemId,
        timestamp: event.timestamp,
        title,
        summary,
        icon: itemIcon(event.itemType),
        details: detail && detail !== title ? [detail] : [],
        inProgress: true,
      });
      continue;
    }

    // item.completed: add as tool entry (replaces started)
    if (event.type === "item.completed") {
      flushAssistant();
      const title = event.title ?? event.itemType;
      const detail = event.detail ?? "";
      // Avoid repeating the same text in title and summary
      const summary = detail && detail !== title ? detail : "Completed";
      pendingTools.push({
        id: event.itemId,
        timestamp: event.timestamp,
        title,
        summary,
        icon: itemIcon(event.itemType),
        details: detail && detail !== title ? [detail] : [],
      });
      continue;
    }

    // item.updated: skip
    if (event.type === "item.updated") continue;

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
        if (event.tokens) parts.push(`${event.tokens.input} in / ${event.tokens.output} out`);
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
          body: event.exitCode != null ? `Exited with code ${event.exitCode}.` : "The agent finished cleanly.",
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

export function ChatView({ sessionId, initialPrompt, onSelectionLoadSettled }: ChatViewProps) {
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const transport = useTransport();

  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Mutable refs for the push handler to accumulate deltas without re-subscribing
  const eventsRef = useRef<OrchestrationEvent[]>([]);

  // Fetch initial timeline
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
        setEntries(eventsToEntries(filtered, initialPrompt));
        onSelectionLoadSettled?.("ok");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load chat timeline");
        onSelectionLoadSettled?.("error", e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [initialPrompt, sessionId, transport, onSelectionLoadSettled]);

  // Subscribe to real-time orchestration events
  useEffect(() => {
    const unsubscribe = transport.subscribe("orchestration.event", (data) => {
      const event = data as OrchestrationEvent;
      if (event.sessionId !== sessionId) return;

      eventsRef.current = [...eventsRef.current, event];
      setEvents(eventsRef.current);
      setEntries(eventsToEntries(eventsRef.current, initialPrompt));
    });

    return unsubscribe;
  }, [initialPrompt, sessionId, transport]);

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

  async function handleSend(text: string) {
    await withDashboardSpan(
      "orka.dashboard.chat.send_input",
      {
        "orka.session.id": sessionId,
        "orka.backend": activeSession.backend,
        "orka.input.length": text.length,
      },
      async () => {
        setAutoScroll(true);
        await transport.request<void>("sendInput", { sessionId, text });
      },
    );
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
      <div className="border-b border-zinc-800 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Chat Timeline</p>
        <p className="mt-1 text-sm text-zinc-400">
          {isRunning(activeSession.status) ? "Streaming live events…" : `${entries.length} events`}
        </p>
      </div>
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
                <TimelineEntry key={entry.id} entry={entry} />
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
                onClick={handleStop}
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
                onClick={handleRetry}
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

function TimelineEntry({ entry }: { entry: ChatEntry }) {
  if (entry.type === "assistant") {
    return (
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 max-w-3xl rounded-2xl rounded-tl-md border border-zinc-800 bg-zinc-900 px-4 py-3 [overflow-wrap:anywhere]">
          <MarkdownContent content={entry.body} />
          <p className="mt-2 text-xs text-zinc-500">{formatDateTime(entry.timestamp)}</p>
        </div>
      </div>
    );
  }

  if (entry.type === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-3xl items-start gap-3">
          <div className="min-w-0 max-w-3xl rounded-2xl rounded-tr-md border border-indigo-900/50 bg-zinc-900 px-4 py-3 [overflow-wrap:anywhere]">
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
      const tool = entry.tools[0]!;
      return (
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-zinc-400">
            {tool.inProgress ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : tool.icon === "command" ? (
              <TerminalSquare className="h-3.5 w-3.5" />
            ) : (
              <FileCode2 className="h-3.5 w-3.5" />
            )}
          </div>
          <span className="min-w-0 truncate text-sm text-zinc-300">{tool.title}</span>
        </div>
      );
    }

    // Multiple tools: collapsible group with "Used N tools" summary
    const label = hasInProgress
      ? `Using ${entry.tools.length} tools…`
      : `Used ${entry.tools.length} tools`;
    return (
      <details
        open={hasInProgress}
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
        <div className="border-t border-zinc-800">
          {entry.tools.map((tool) => (
            <details key={tool.id} className="border-b border-zinc-800/50 last:border-b-0">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2">
                <div className="flex h-6 w-6 items-center justify-center rounded bg-zinc-800/80 text-zinc-400">
                  {tool.inProgress ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                  ) : tool.icon === "command" ? (
                    <TerminalSquare className="h-3 w-3" />
                  ) : (
                    <FileCode2 className="h-3 w-3" />
                  )}
                </div>
                <span className="min-w-0 truncate text-xs font-medium text-zinc-300">{tool.title}</span>
                <span className="ml-auto shrink-0 truncate text-xs text-zinc-500">{tool.summary}</span>
              </summary>
              {tool.details.length > 0 ? (
                <div className="border-t border-zinc-800/30 px-4 py-2">
                  <ToolCallDetails title={tool.title} details={tool.details} />
                </div>
              ) : null}
            </details>
          ))}
        </div>
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
