// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LoaderCircle, Shield, ShieldOff, Square } from "lucide-react";
import type { SessionResult } from "@orka/core";
import { ChatView } from "./ChatView";
import { DiffPanel } from "./DiffPanel";
import { LogPanel } from "./LogPanel";
import { withDashboardSpan } from "../lib/tracing";
import { formatDateTime, formatDuration } from "../lib/sessionUi";
import { useSessionStore, type SessionSummary } from "../stores/sessionStore";
import type { WsTransport } from "../lib/wsTransport";

interface SessionViewProps {
  sessionId: string;
  transport: WsTransport;
  onSelectionLoadSettled: (sessionId: string, status: "ok" | "error", error?: unknown) => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: "bg-blue-950/60", text: "text-blue-300", dot: "bg-blue-400" },
  queued: { bg: "bg-yellow-950/60", text: "text-yellow-300", dot: "bg-yellow-400" },
  preparing: { bg: "bg-yellow-950/60", text: "text-yellow-300", dot: "bg-yellow-400" },
  completed: { bg: "bg-emerald-950/60", text: "text-emerald-300", dot: "bg-emerald-400" },
  failed: { bg: "bg-red-950/60", text: "text-red-300", dot: "bg-red-400" },
  cancelled: { bg: "bg-zinc-800/60", text: "text-zinc-400", dot: "bg-zinc-500" },
};

const ACTIVE_STATUSES = new Set(["queued", "preparing", "running"]);

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS["cancelled"]!;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${colors.bg} ${colors.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
      {status}
    </span>
  );
}

function formatCost(costUsd: number | null): string {
  if (costUsd == null) return "N/A";
  return `$${costUsd.toFixed(4)}`;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function SessionView({ sessionId, transport, onSelectionLoadSettled }: SessionViewProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "chat" | "logs" | "diff">("logs");
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const notifiedSessionRef = useRef<string | null>(null);
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const stopSession = useSessionStore((state) => state.stopSession);

  useEffect(() => {
    notifiedSessionRef.current = null;
    setStopError(null);
  }, [sessionId]);

  const reportSelectionLoad = useEffectEvent((status: "ok" | "error", error?: unknown) => {
    if (notifiedSessionRef.current === sessionId) {
      return;
    }

    notifiedSessionRef.current = sessionId;
    onSelectionLoadSettled(sessionId, status, error);
  });

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        Session metadata is unavailable.
      </div>
    );
  }

  const activeSession = session;
  const isStoppable = ACTIVE_STATUSES.has(activeSession.status);

  async function handleStopSession() {
    if (!isStoppable || isStopping) {
      return;
    }

    setIsStopping(true);
    setStopError(null);

    try {
      await withDashboardSpan(
        "orka.dashboard.session.stop",
        {
          "orka.session.id": activeSession.id,
        },
        async (span) => {
          span.addEvent("session.stop_clicked");
          await stopSession(transport, activeSession.id);
          span.addEvent("session.stop_confirmed");
        },
      );
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "Failed to stop session.");
    } finally {
      setIsStopping(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-lg font-semibold text-zinc-100">{activeSession.title}</p>
            <p className="mt-1 text-sm font-mono text-zinc-500">{sessionId}</p>
          </div>
          <div className="flex items-center gap-3">
            {isStoppable ? (
              <button
                type="button"
                onClick={() => void handleStopSession()}
                disabled={isStopping}
                className="inline-flex items-center gap-2 rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm font-medium text-red-200 transition hover:bg-red-950/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isStopping ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                {isStopping ? "Stopping..." : "Stop Session"}
              </button>
            ) : null}
            <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-1">
              <button
                type="button"
                onClick={() => setActiveTab("overview")}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  activeTab === "overview"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 transition hover:text-zinc-200"
                }`}
              >
                Overview
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("chat")}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  activeTab === "chat"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 transition hover:text-zinc-200"
                }`}
              >
                Chat
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("logs")}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  activeTab === "logs"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 transition hover:text-zinc-200"
                }`}
              >
                Logs
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("diff")}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  activeTab === "diff"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 transition hover:text-zinc-200"
                }`}
              >
                Diff
              </button>
            </div>
          </div>
        </div>
        {stopError ? (
          <p className="mt-3 text-sm text-red-300">{stopError}</p>
        ) : null}
      </header>
      <div className={`flex-1 p-6 ${activeTab === "logs" ? "overflow-hidden" : "overflow-y-auto"}`}>
        {activeTab === "logs" ? (
          <LogPanel
            sessionId={sessionId}
            transport={transport}
            onInitialLoadSettled={reportSelectionLoad}
          />
        ) : activeTab === "overview" ? (
          <OverviewTab
            session={session}
            transport={transport}
            onSelectionLoadSettled={reportSelectionLoad}
          />
        ) : activeTab === "chat" ? (
          <ChatView
            sessionId={sessionId}
            {...(activeSession.prompt ? { initialPrompt: activeSession.prompt } : {})}
            onSelectionLoadSettled={reportSelectionLoad}
          />
        ) : (
          <DiffPanel sessionId={sessionId} onSelectionLoadSettled={reportSelectionLoad} />
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  session,
  transport,
  onSelectionLoadSettled,
}: {
  session: SessionSummary;
  transport: WsTransport;
  onSelectionLoadSettled: (status: "ok" | "error", error?: unknown) => void;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const isFinished = session.status === "completed" || session.status === "failed" || session.status === "cancelled";

  const resultQuery = useQuery({
    queryKey: ["session-result", session.id],
    queryFn: () => transport.request<SessionResult | null>("getResult", { sessionId: session.id }),
    enabled: isFinished,
    staleTime: Infinity,
  });
  const result = resultQuery.data ?? null;

  useEffect(() => {
    if (!isFinished) {
      onSelectionLoadSettled("ok");
      return;
    }

    if (resultQuery.isSuccess) {
      onSelectionLoadSettled("ok");
    } else if (resultQuery.isError) {
      onSelectionLoadSettled("error", resultQuery.error);
    }
  }, [isFinished, onSelectionLoadSettled, resultQuery.error, resultQuery.isError, resultQuery.isSuccess]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,1fr)]">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Overview</p>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Status</dt>
              <dd className="mt-2"><StatusBadge status={session.status} /></dd>
            </div>
            <MetadataItem label="Backend" value={session.backend} />
            <MetadataItem label="Model" value={session.model ?? result?.model ?? "Default"} />
            <MetadataItem label="Mode" value={session.mode} />
            <MetadataItem label="Created" value={formatDateTime(session.createdAt)} />
            <MetadataItem
              label="Duration"
              value={formatDuration(session.startedAt, session.finishedAt, isFinished ? "N/A" : "Running...")}
            />
            {session.exitCode != null && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Exit Code</dt>
                <dd className="mt-2">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-mono font-medium ${
                    session.exitCode === 0
                      ? "bg-emerald-950/60 text-emerald-300"
                      : "bg-red-950/60 text-red-300"
                  }`}>
                    {session.exitCode}
                  </span>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Kept</dt>
              <dd className="mt-2 flex items-center gap-1.5 text-sm text-zinc-100">
                {session.kept ? (
                  <><Shield className="h-3.5 w-3.5 text-amber-400" /> Protected</>
                ) : (
                  <><ShieldOff className="h-3.5 w-3.5 text-zinc-500" /> No</>
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Paths</p>
          <dl className="mt-4 space-y-4">
            <MetadataItem label="Session ID" value={session.id} mono />
            <MetadataItem label="Task ID" value={session.taskId} mono />
            <MetadataItem label="Project Path" value={session.projectPath} mono />
            {session.workingDir !== session.projectPath && (
              <MetadataItem label="Working Directory" value={session.workingDir} mono />
            )}
          </dl>
        </section>
      </div>

      {result && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Usage</p>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetadataItem label="Cost" value={formatCost(result.costUsd)} />
            <MetadataItem label="Input Tokens" value={formatTokenCount(result.inputTokens)} />
            <MetadataItem label="Output Tokens" value={formatTokenCount(result.outputTokens)} />
            <MetadataItem label="Cache Read" value={formatTokenCount(result.cacheReadTokens)} />
            {result.numTurns > 0 && (
              <MetadataItem label="Turns" value={String(result.numTurns)} />
            )}
          </dl>
        </section>
      )}

      {session.prompt && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
          <button
            type="button"
            onClick={() => setPromptExpanded(!promptExpanded)}
            className="flex w-full items-center gap-2 text-left"
          >
            {promptExpanded ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
            )}
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Prompt</p>
          </button>
          {promptExpanded && (
            <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 font-mono text-sm leading-relaxed text-zinc-300">
              {session.prompt}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}

function MetadataItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">{label}</dt>
      <dd className={`mt-2 text-sm text-zinc-100 ${mono ? "font-mono break-all" : ""}`}>{value}</dd>
    </div>
  );
}
