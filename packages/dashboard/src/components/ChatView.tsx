// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useCallback, useState } from "react";
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
import { ChatTimelineEntry, ThinkingIndicator } from "./chat/TimelineEntry";
import { deriveThinkingState, type UserEntry } from "./chat/eventsToEntries";

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

function canStop(allowedActions: SessionSummary["allowedActions"]): boolean {
  return allowedActions.includes("stop");
}

export function ChatView({ sessionId, initialPrompt, onSelectionLoadSettled, isMobile = false }: ChatViewProps) {
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const client = useRpcClient();
  const expandedGroups = useChatUiStore((state) => state.sessions[sessionId]?.expandedGroups ?? EMPTY_SET);
  const { events, entries, setEntries, isLoading, error, handleApprovalResolve } = useChatTimeline({
    sessionId,
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    ...(session?.projectPath ? { projectPath: session.projectPath } : {}),
    ...(onSelectionLoadSettled ? { onSelectionLoadSettled } : {}),
  });

  const inputState = useInputState(
    events,
    session?.status ?? "queued",
    session?.allowedActions ?? [],
    session?.backend ?? "unknown",
  );
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const { autoScroll, bottomRef, scrollRef, handleScroll, scrollToBottom, newMessagesCount } = useChatScroll({
    sessionId,
    entriesLength: entries.length,
  });

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

  async function handleSend(text: string) {
    setSendError(null);

    const optimisticEntry: UserEntry = {
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


  async function handleStop() {
    setStopping(true);
    try {
      await client.stop(sessionId);
    } finally {
      setStopping(false);
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
          className={`h-full overflow-y-auto ${isMobile ? "px-1 py-1" : "px-2 py-2"}`}
        >
          {entries.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-ink-muted">No messages yet.</div>
          ) : (
            <div className="min-w-0 space-y-2">
              {entries.map((entry) => (
                <ChatTimelineEntry
                  key={entry.id}
                  entry={entry}
                  isExpanded={expandedGroups.has(entry.id)}
                  onToggleExpand={handleToggleGroup}
                  onApprovalResolve={handleApprovalResolve}
                  {...(session.projectPath ? { projectPath: session.projectPath } : {})}
                />
              ))}
            </div>
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
      <div className="border-t border-border">
        <ChatInputComposer
          sessionId={sessionId}
          inputState={inputState}
          onSend={handleSend}
          sendError={sendError}
          onClearError={() => { setSendError(null); }}
          {...(canStop(session.allowedActions) ? { onStop: () => { void handleStop(); } } : {})}
          isStopping={stopping}
        />
      </div>
    </div>
  );
}
