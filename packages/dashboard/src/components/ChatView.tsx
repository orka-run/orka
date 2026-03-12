// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useEffect, useRef } from "react";
import { AlertTriangle, Bot, Clock3, FileCode2, LoaderCircle, TerminalSquare, Wrench } from "lucide-react";
import type { ChatEntry } from "@orka/core";
import type { SessionSummary } from "../stores/sessionStore";
import { useSessionStore } from "../stores/sessionStore";
import { formatDateTime, formatRelativeTime } from "../lib/sessionUi";

type UIChatEntry = ChatEntry & { id: string; defaultOpen?: boolean };

interface ChatViewProps {
  sessionId: string;
  onSelectionLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
}

export function ChatView({ sessionId, onSelectionLoadSettled }: ChatViewProps) {
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const entries = buildMockEntries(session);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, session?.status]);

  useEffect(() => {
    onSelectionLoadSettled?.("ok");
  }, [onSelectionLoadSettled, sessionId]);

  if (!session) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 text-sm text-zinc-400">
        Session data is unavailable.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/70">
      <div className="border-b border-zinc-800 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Chat Timeline</p>
        <p className="mt-1 text-sm text-zinc-400">
          Placeholder events for {session.backend} sessions until runtime streaming lands.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          {entries.map((entry) => (
            <TimelineEntry key={entry.id} entry={entry} />
          ))}
          {isRunning(session.status) ? (
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-300">
              <LoaderCircle className="h-4 w-4 animate-spin text-sky-400" />
              <div>
                <p className="font-medium text-zinc-100">Waiting for more output</p>
                <p className="text-zinc-500">This session is still running. New stream events will append here.</p>
              </div>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

function TimelineEntry({ entry }: { entry: UIChatEntry }) {
  if (entry.kind === "assistant") {
    return (
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
          <Bot className="h-4 w-4" />
        </div>
        <div className="max-w-3xl rounded-2xl rounded-tl-md border border-zinc-800 bg-zinc-900 px-4 py-3">
          <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-100">{entry.body}</p>
          <p className="mt-2 text-xs text-zinc-500">{formatDateTime(entry.timestamp)}</p>
        </div>
      </div>
    );
  }

  if (entry.kind === "tool") {
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
          <div className="space-y-2">
            {(entry.details ?? []).map((detail, index) => (
              <div key={`${entry.id}-${String(index)}`} className="rounded-lg bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-300">
                {detail}
              </div>
            ))}
          </div>
        </div>
      </details>
    );
  }

  if (entry.kind === "error") {
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

  // system entry
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
      <div>
        <p className="text-sm font-medium text-zinc-100">{entry.title}</p>
        {entry.body ? <p className="mt-1 text-sm text-zinc-400">{entry.body}</p> : null}
        <p className="mt-2 text-xs text-zinc-500">{formatDateTime(entry.timestamp)}</p>
      </div>
    </div>
  );
}

function buildMockEntries(
  session: SessionSummary | null,
): UIChatEntry[] {
  if (!session) {
    return [];
  }

  const firstTimestamp = session.startedAt ?? session.createdAt;
  const secondTimestamp = offsetTimestamp(firstTimestamp, 45);
  const thirdTimestamp = offsetTimestamp(firstTimestamp, 130);
  const entries: UIChatEntry[] = [
    {
      id: `${session.id}-started`,
      kind: "system",
      timestamp: firstTimestamp,
      title: "Session started",
      body: `${session.backend} session booted in ${session.mode} mode for ${session.projectPath}.`,
    },
    {
      id: `${session.id}-assistant-1`,
      kind: "assistant",
      timestamp: secondTimestamp,
      body: `Starting work on "${session.title}". I am collecting context, reviewing changed files, and outlining the next implementation step.`,
    },
    {
      id: `${session.id}-tool-command`,
      kind: "tool",
      timestamp: secondTimestamp,
      title: "Command execution",
      summary: "Repository inspection and dependency checks",
      icon: "command",
      defaultOpen: true,
      details: [
        "rg --files packages/dashboard/src",
        "sed -n '1,220p' packages/dashboard/src/App.tsx",
        "bun install",
      ],
    },
    {
      id: `${session.id}-tool-file`,
      kind: "tool",
      timestamp: thirdTimestamp,
      title: "File changes",
      summary: "Updated dashboard layout, session navigation, and timeline placeholders",
      icon: "file",
      details: [
        "packages/dashboard/src/components/Sidebar.tsx",
        "packages/dashboard/src/components/SessionView.tsx",
        "packages/dashboard/src/components/ChatView.tsx",
      ],
    },
  ];

  if (session.status === "failed" || session.status === "cancelled") {
    entries.push({
      id: `${session.id}-error`,
      kind: "error",
      timestamp: session.finishedAt ?? offsetTimestamp(thirdTimestamp, 90),
      title: session.status === "cancelled" ? "Session cancelled" : "Session failed",
      body: "The runtime stopped before the task completed. Full provider event streaming will replace this placeholder once available.",
    });
    return entries;
  }

  if (session.status === "completed") {
    entries.push({
      id: `${session.id}-completed`,
      kind: "system",
      timestamp: session.finishedAt ?? offsetTimestamp(thirdTimestamp, 90),
      title: "Session completed",
      body: "The agent finished cleanly. Diff output and final result are available in the adjacent tabs.",
    });
  }

  return entries;
}

function offsetTimestamp(value: string, seconds: number): string {
  const nextValue = new Date(value).getTime() + seconds * 1000;
  return new Date(Math.min(nextValue, Date.now())).toISOString();
}

function isRunning(status: SessionSummary["status"]): boolean {
  return status === "queued" || status === "preparing" || status === "running";
}
