// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Bot, Clock3, FileCode2, LoaderCircle, TerminalSquare, User, Wrench } from "lucide-react";
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
      type: "tool";
      timestamp: string;
      title: string;
      summary: string;
      icon: "command" | "file";
      details: string[];
      defaultOpen?: boolean;
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

/** Map an item type to an icon kind for tool entries. */
function itemIcon(itemType: string): "command" | "file" {
  if (itemType === "file_change") return "file";
  return "command";
}

/** Build a ChatEntry from a single OrchestrationEvent, returning null for events we skip. */
function eventToEntry(event: OrchestrationEvent): ChatEntry | null {
  switch (event.type) {
    case "session.created":
      return {
        id: `${event.sessionId}-created-${event.timestamp}`,
        type: "system",
        timestamp: event.timestamp,
        title: "Session created",
        body: `${event.backend} session created.`,
      };
    case "session.started":
      return {
        id: `${event.sessionId}-started-${event.timestamp}`,
        type: "system",
        timestamp: event.timestamp,
        title: "Session started",
        body: "The agent session has started.",
      };
    case "turn.started":
      return {
        id: `turn-started-${event.turnId}`,
        type: "system",
        timestamp: event.timestamp,
        title: "Turn started",
        body: `Turn ${event.turnId} began.`,
      };
    case "turn.completed": {
      const parts: string[] = [];
      if (event.cost != null) parts.push(`Cost: $${event.cost.toFixed(4)}`);
      if (event.tokens) parts.push(`Tokens: ${event.tokens.input} in / ${event.tokens.output} out`);
      if (event.stopReason) parts.push(`Stop reason: ${event.stopReason}`);
      return {
        id: `turn-completed-${event.turnId}`,
        type: "system",
        timestamp: event.timestamp,
        title: "Turn completed",
        body: parts.length > 0 ? parts.join(" · ") : "Turn finished.",
      };
    }
    case "turn.aborted":
      return {
        id: `turn-aborted-${event.turnId}`,
        type: "error",
        timestamp: event.timestamp,
        title: "Turn aborted",
        body: event.reason,
      };
    case "user.input":
      return {
        id: `user-input-${event.sessionId}-${event.timestamp}`,
        type: "user",
        timestamp: event.timestamp,
        body: event.text,
      };
    case "content.delta":
      // Deltas are accumulated externally into assistant messages — skip individual entries.
      return null;
    case "item.started":
      return {
        id: `item-started-${event.itemId}`,
        type: "tool",
        timestamp: event.timestamp,
        title: event.title ?? event.itemType,
        summary: event.detail ?? "In progress…",
        icon: itemIcon(event.itemType),
        defaultOpen: true,
        details: event.detail ? [event.detail] : [],
      };
    case "item.completed":
      return {
        id: `item-completed-${event.itemId}`,
        type: "tool",
        timestamp: event.timestamp,
        title: event.title ?? event.itemType,
        summary: event.detail ?? "Completed",
        icon: itemIcon(event.itemType),
        details: event.detail ? [event.detail] : [],
      };
    case "item.updated":
      // Skip updates — we render started + completed.
      return null;
    case "session.completed":
      return {
        id: `${event.sessionId}-completed-${event.timestamp}`,
        type: "system",
        timestamp: event.timestamp,
        title: "Session completed",
        body: event.exitCode != null ? `Exited with code ${event.exitCode}.` : "The agent finished cleanly.",
      };
    case "session.failed":
      return {
        id: `${event.sessionId}-failed-${event.timestamp}`,
        type: "error",
        timestamp: event.timestamp,
        title: "Session failed",
        body: event.error,
      };
    case "session.cancelled":
      return {
        id: `${event.sessionId}-cancelled-${event.timestamp}`,
        type: "system",
        timestamp: event.timestamp,
        title: "Session cancelled",
        body: event.reason ?? "The session was cancelled.",
      };
    case "runtime.error":
      return {
        id: `runtime-error-${event.timestamp}-${event.turnId ?? ""}`,
        type: "error",
        timestamp: event.timestamp,
        title: "Runtime error",
        body: event.error,
      };
    case "runtime.warning":
      return {
        id: `runtime-warning-${event.timestamp}`,
        type: "system",
        timestamp: event.timestamp,
        title: "Warning",
        body: event.message,
      };
    default:
      // session.state.changed, request.opened, request.resolved, tool.progress — skip
      return null;
  }
}

/**
 * Process a full list of OrchestrationEvents into ChatEntries.
 * Content deltas are accumulated into assistant message entries.
 */
function eventsToEntries(events: OrchestrationEvent[], initialPrompt?: string): ChatEntry[] {
  const entries: ChatEntry[] = [];
  let accum = "";
  let accumTurnId: string | null = null;
  let accumStart: string | null = null;

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
        if (accumTurnId !== event.turnId) {
          flushAssistant();
          accumTurnId = event.turnId;
          accumStart = event.timestamp;
        }
        accum += event.delta;
      }
      continue;
    }

    // A non-delta event: flush any accumulated assistant text first
    if (
      event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "item.started" ||
      event.type === "user.input"
    ) {
      flushAssistant();
    }

    const entry = eventToEntry(event);
    if (entry) {
      entries.push(entry);
    }
  }

  flushAssistant();
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
          className="h-full flex-1 overflow-y-auto px-4 py-4"
        >
          <div className="space-y-4">
            {entries.length === 0 ? (
              <div className="py-12 text-center text-sm text-zinc-500">No messages yet.</div>
            ) : (
              entries.map((entry) => (
                <TimelineEntry key={entry.id} entry={entry} />
              ))
            )}
            {isRunning(activeSession.status) ? (
              <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-300">
                <LoaderCircle className="h-4 w-4 animate-spin text-sky-400" />
                <div>
                  <p className="font-medium text-zinc-100">Waiting for more output</p>
                  <p className="text-zinc-500">This session is still running. New events will append here.</p>
                </div>
              </div>
            ) : null}
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
      <ChatInputComposer
        sessionId={sessionId}
        inputState={inputState}
        onSend={handleSend}
      />
    </div>
  );
}

function TimelineEntry({ entry }: { entry: ChatEntry }) {
  if (entry.type === "assistant") {
    return (
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
          <Bot className="h-4 w-4" />
        </div>
        <div className="max-w-3xl rounded-2xl rounded-tl-md border border-zinc-800 bg-zinc-900 px-4 py-3">
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
          <div className="rounded-2xl rounded-tr-md border border-sky-900 bg-zinc-900 px-4 py-3 text-right">
            <MarkdownContent content={entry.body} />
            <p className="mt-2 text-xs text-zinc-500">{formatDateTime(entry.timestamp)}</p>
          </div>
          <div className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-indigo-300">
            <User className="h-4 w-4" />
          </div>
        </div>
      </div>
    );
  }

  if (entry.type === "tool") {
    return (
      <details
        open={entry.defaultOpen}
        className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800 text-zinc-300">
              {entry.icon === "command" ? <TerminalSquare className="h-4 w-4" /> : <FileCode2 className="h-4 w-4" />}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-100">{entry.title}</p>
              <p className="truncate text-sm text-zinc-400">{entry.summary}</p>
            </div>
          </div>
          <div className="shrink-0 text-xs text-zinc-500">{formatRelativeTime(entry.timestamp)}</div>
        </summary>
        <div className="border-t border-zinc-800 px-4 py-3">
          <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-zinc-500">
            <Wrench className="h-3.5 w-3.5" />
            Tool Activity
          </div>
          <ToolCallDetails title={entry.title} details={entry.details} />
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
