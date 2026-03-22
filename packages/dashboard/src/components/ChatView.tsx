// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, LoaderCircle } from "lucide-react";
import type { SessionSummary } from "../stores/sessionStore";
import { withDashboardSpan } from "../lib/tracing";
import { ChatInputComposer } from "./ChatInputComposer";
import { useInputState } from "../hooks/useInputState";
import { useChatScroll } from "../hooks/useChatScroll";
import { useChatTimeline } from "../hooks/useChatTimeline";
import { useSessionStore } from "../stores/sessionStore";
import { useRpcClient } from "../lib/transportContext";
import { useChatUiStore } from "../stores/chatUiStore";
import { useConnectionStore } from "../stores/connectionStore";
import { ChatTimelineEntry, ThinkingIndicator } from "./chat/TimelineEntry";
import { QueuedMessageBar } from "./chat/QueuedMessageBar";
import { deriveThinkingState, type ChatEntry, type UserEntry } from "./chat/eventsToEntries";
import type { QuotedText } from "./chat/MessageEntry";

const EMPTY_SET = new Set<string>();

interface ChatViewProps {
  sessionId: string;
  initialPrompt?: string;
  onSelectionLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
  isMobile?: boolean;
}

function isRunning(status: SessionSummary["status"]): boolean {
  return status === "queued" || status === "preparing" || status === "running";
}

function canCancelTurn(allowedActions: SessionSummary["allowedActions"]): boolean {
  return allowedActions.includes("cancelTurn");
}

export function ChatView({ sessionId, initialPrompt, onSelectionLoadSettled, isMobile = false }: ChatViewProps) {
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const client = useRpcClient();
  const connectionStatus = useConnectionStore((state) => state.status);
  const expandedGroups = useChatUiStore((state) => state.sessions[sessionId]?.expandedGroups ?? EMPTY_SET);
  const collapsedGroups = useChatUiStore((state) => state.sessions[sessionId]?.collapsedGroups ?? EMPTY_SET);
  const { events, entries, setEntries, isLoading, isFetchingDelta, error, handleApprovalResolve } = useChatTimeline({
    sessionId,
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    ...(session?.projectPath ? { projectPath: session.projectPath } : {}),
    ...(onSelectionLoadSettled ? { onSelectionLoadSettled } : {}),
  });

  // Hooks must be called before early returns — fallback to [] when session is null
  const inputState = useInputState(
    events,
    session?.allowedActions ?? [],
  );
  const [cancellingTurn, setCancellingTurn] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [quotedText, setQuotedText] = useState<QuotedText | null>(null);
  // Split entries: queued messages go to the queue bar, rest to timeline
  const { timelineEntries, queuedMessages } = useMemo(() => {
    const timeline: ChatEntry[] = [];
    const queued: UserEntry[] = [];
    for (const entry of entries) {
      if (entry.type === "user" && entry.queued) {
        queued.push(entry);
      } else {
        timeline.push(entry);
      }
    }
    return { timelineEntries: timeline, queuedMessages: queued };
  }, [entries]);

  const { autoScroll, bottomRef, scrollRef, handleScroll, scrollToBottom, newMessagesCount } = useChatScroll({
    sessionId,
    entriesLength: timelineEntries.length,
    eventsLength: events.length,
  });

  const handleToggleGroup = useCallback((groupId: string, isOpen: boolean) => {
    const current = useChatUiStore.getState().get(sessionId);
    const nextExpanded = new Set(current.expandedGroups);
    const nextCollapsed = new Set(current.collapsedGroups);
    if (isOpen) {
      nextExpanded.add(groupId);
      nextCollapsed.delete(groupId);
    } else {
      nextExpanded.delete(groupId);
      nextCollapsed.add(groupId);
    }
    useChatUiStore.getState().update(sessionId, { expandedGroups: nextExpanded, collapsedGroups: nextCollapsed });
  }, [sessionId]);

  const handleQuote = useCallback((quote: QuotedText) => {
    setQuotedText(quote);
  }, []);

  const handleClearQuote = useCallback(() => {
    setQuotedText(null);
  }, []);

  async function handleSend(text: string) {
    setSendError(null);

    // Mark as queued if agent is mid-turn (inputState=busy) OR session is still running.
    // inputState can race (events arrive async) so session.status is the safer signal.
    const shouldQueue = inputState === "busy" || (session != null && isRunning(session.status) && inputState !== "waiting");
    const optimisticEntry: UserEntry = {
      id: `user-optimistic-${String(Date.now())}`,
      type: "user",
      timestamp: new Date().toISOString(),
      body: text,
      ...(shouldQueue ? { queued: true } : {}),
    };
    setEntries((prev) => [...prev, optimisticEntry]);
    if (!shouldQueue) {
      useChatUiStore.getState().update(sessionId, { autoScroll: true });
    }

    try {
      await withDashboardSpan(
        "orka.dashboard.chat.send_input",
        {
          "orka.session.id": sessionId,
          "orka.backend": session?.backend ?? "unknown",
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

  async function handleCancelQueuedMessage(text: string) {
    try {
      await client.cancelQueuedMessage(sessionId, text);
    } catch {
      // Event stream will reconcile — ignore transient errors
    }
  }

  async function handleCancelTurn() {
    setCancellingTurn(true);
    try {
      await client.cancelTurn(sessionId);
    } finally {
      setCancellingTurn(false);
    }
  }

  if (!session) {
    return (
      <div className="rounded-sm border border-border bg-surface p-2 text-[12px] text-ink-muted">
        Session data is unavailable.
      </div>
    );
  }

  if (isLoading) {
    const isConnected = connectionStatus === "connected";
    const label = isConnected
      ? "Loading timeline…"
      : connectionStatus === "reconnecting"
        ? "Reconnecting…"
        : "Connecting…";
    const eventCount = session?.eventCount;
    return (
      <div className="flex h-full items-center justify-center rounded-sm border border-border bg-surface">
        <div className="flex flex-col items-center gap-1.5 text-[12px] text-ink-muted">
          <div className="flex items-center gap-2">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {label}
          </div>
          {isConnected && eventCount != null && eventCount > 0 ? (
            <span className="text-[10px] text-ink-muted/60">{String(eventCount)} events</span>
          ) : null}
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
          className={`h-full overflow-y-auto ${isMobile ? "px-1 py-1" : "px-2 py-2"}`}
        >
          {isFetchingDelta ? (
            <div className="flex items-center justify-center gap-1.5 py-1 text-[10px] text-ink-muted">
              <LoaderCircle className="h-3 w-3 animate-spin" />
              Syncing new events…
            </div>
          ) : null}
          {timelineEntries.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-ink-muted">No messages yet.</div>
          ) : (
            <ChunkedTimeline
              entries={timelineEntries}
              expandedGroups={expandedGroups}
              collapsedGroups={collapsedGroups}
              onToggleExpand={handleToggleGroup}
              onApprovalResolve={handleApprovalResolve}
              onQuote={handleQuote}
              projectPath={session.projectPath}
            />
          )}
          {isRunning(session.status) ? <ThinkingIndicator state={deriveThinkingState(events)} /> : null}
          <div ref={bottomRef} />
        </div>

        {!autoScroll ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-2 right-4 flex items-center gap-1 rounded-sm border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink-secondary backdrop-blur transition hover:bg-surface-hover"
          >
            <ArrowDown className="h-3 w-3" />
            {newMessagesCount > 0 ? `+${newMessagesCount} new` : "Bottom"}
          </button>
        ) : null}
      </div>
      <QueuedMessageBar
        messages={queuedMessages}
        onCancel={(text) => { void handleCancelQueuedMessage(text); }}
      />
      <div className="border-t border-border">
        <ChatInputComposer
          sessionId={sessionId}
          inputState={inputState}
          onSend={handleSend}
          sendError={sendError}
          onClearError={() => { setSendError(null); }}
          {...(canCancelTurn(session.allowedActions) && inputState === "busy" ? { onCancelTurn: () => { void handleCancelTurn(); } } : {})}
          isCancellingTurn={cancellingTurn}
          quotedText={quotedText}
          onClearQuote={handleClearQuote}
        />
      </div>
    </div>
  );
}

/**
 * Renders timeline entries in chunks: last INITIAL_CHUNK immediately (user sees
 * most recent content), then progressively adds older entries via requestIdleCallback.
 * Each entry uses content-visibility:auto so browser skips layout/paint for off-screen nodes.
 */
const INITIAL_CHUNK = 40;
const CHUNK_SIZE = 60;

function ChunkedTimeline({
  entries,
  expandedGroups,
  collapsedGroups,
  onToggleExpand,
  onApprovalResolve,
  onQuote,
  projectPath,
}: {
  entries: ChatEntry[];
  expandedGroups: Set<string>;
  collapsedGroups: Set<string>;
  onToggleExpand: (id: string, isOpen: boolean) => void;
  onApprovalResolve: (requestId: string, decision: "approve" | "deny") => Promise<void>;
  onQuote: (text: QuotedText) => void;
  projectPath?: string;
}) {
  // Show tail (most recent) first, progressively reveal older entries
  const [visibleCount, setVisibleCount] = useState(Math.min(INITIAL_CHUNK, entries.length));
  const entriesRef = useRef(entries);
  const idleRef = useRef<number | null>(null);

  // Reset on session change (entries identity changes)
  if (entriesRef.current !== entries) {
    entriesRef.current = entries;
    setVisibleCount(Math.min(INITIAL_CHUNK, entries.length));
  }

  useEffect(() => {
    if (visibleCount >= entries.length) return;

    const scheduleChunk = () => {
      idleRef.current = requestIdleCallback(() => {
        setVisibleCount((prev) => {
          const next = Math.min(prev + CHUNK_SIZE, entries.length);
          if (next < entries.length) scheduleChunk();
          return next;
        });
      });
    };
    scheduleChunk();

    return () => {
      if (idleRef.current != null) cancelIdleCallback(idleRef.current);
    };
  }, [entries.length, visibleCount]);

  // Render from the start, but only visibleCount entries
  // Most recent entries are at the end — render all visible from index 0
  const startIdx = Math.max(0, entries.length - visibleCount);
  const visible = startIdx > 0 ? entries.slice(startIdx) : entries;

  return (
    <div className="min-w-0 space-y-2">
      {startIdx > 0 && (
        <div className="py-2 text-center text-[10px] text-ink-muted">
          Loading {startIdx} older messages…
        </div>
      )}
      {visible.map((entry) => (
        <div key={entry.id} style={{ contentVisibility: "auto", containIntrinsicSize: "0 80px" }}>
          <ChatTimelineEntry
            entry={entry}
            isExpanded={expandedGroups.has(entry.id)}
            isCollapsed={collapsedGroups.has(entry.id)}
            onToggleExpand={onToggleExpand}
            onApprovalResolve={onApprovalResolve}
            onQuote={onQuote}
            {...(projectPath ? { projectPath } : {})}
          />
        </div>
      ))}
    </div>
  );
}
