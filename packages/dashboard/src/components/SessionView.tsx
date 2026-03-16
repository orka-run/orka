// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Eye, FileCode, LoaderCircle, MessageSquare, RotateCcw, ScrollText, Shield, ShieldOff, Square } from "lucide-react";
import type { SessionResult } from "@orka/core";
import { ChatView } from "./ChatView";
import { DiffPanel } from "./DiffPanel";
import { LogPanel } from "./LogPanel";
import { withDashboardSpan } from "../lib/tracing";
import { formatDateTime, formatDuration } from "../lib/sessionUi";
import { useSessionStore, type SessionSummary } from "../stores/sessionStore";
import type { WsTransport } from "../lib/wsTransport";
import type { MobileSessionTab } from "./MobileTabBar";

interface SessionViewProps {
  sessionId: string;
  transport: WsTransport;
  onSelectionLoadSettled: (sessionId: string, status: "ok" | "error", error?: unknown) => void;
  isMobile?: boolean;
  /** On mobile, the active tab is owned by App and driven via MobileTabBar */
  mobileActiveTab?: MobileSessionTab;
  onMobileTabChange?: (tab: MobileSessionTab) => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: "bg-accent/10", text: "text-accent-strong", dot: "bg-accent" },
  queued: { bg: "bg-status-warning/10", text: "text-status-warning", dot: "bg-status-warning" },
  preparing: { bg: "bg-status-warning/10", text: "text-status-warning", dot: "bg-status-warning" },
  completed: { bg: "bg-emerald-600/10", text: "text-emerald-700", dot: "bg-emerald-600" },
  failed: { bg: "bg-status-error/10", text: "text-status-error", dot: "bg-status-error" },
  cancelled: { bg: "bg-surface-alt", text: "text-ink-muted", dot: "bg-ink-muted" },
  interrupted: { bg: "bg-orange-500/10", text: "text-orange-600", dot: "bg-orange-500" },
};

const ACTIVE_STATUSES = new Set(["queued", "preparing", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS["cancelled"]!;
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${colors.bg} ${colors.text}`}>
      <span className={`h-1.5 w-1.5 rounded-sm ${colors.dot}`} />
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

const TAB_ICONS: Record<string, React.ReactNode> = {
  overview: <Eye className="h-4 w-4" />,
  chat: <MessageSquare className="h-4 w-4" />,
  logs: <ScrollText className="h-4 w-4" />,
  diff: <FileCode className="h-4 w-4" />,
};

export function SessionView({
  sessionId,
  transport,
  onSelectionLoadSettled,
  isMobile = false,
  mobileActiveTab,
  onMobileTabChange: _onMobileTabChange,
}: SessionViewProps) {
  // Desktop uses its own local tab state; mobile tab is driven externally via MobileTabBar
  const [desktopTab, setDesktopTab] = useState<"overview" | "chat" | "logs" | "diff">("chat");
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const notifiedSessionRef = useRef<string | null>(null);
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const stopSession = useSessionStore((state) => state.stopSession);

  const activeTab = isMobile ? (mobileActiveTab ?? "chat") : desktopTab;

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
      <div className="flex h-full items-center justify-center text-ink-muted">
        Session metadata is unavailable.
      </div>
    );
  }

  const activeSession = session;
  const isStoppable = ACTIVE_STATUSES.has(activeSession.status);
  const isRetryable = TERMINAL_STATUSES.has(activeSession.status);
  const [isRetrying, setIsRetrying] = useState(false);

  async function handleStopSession() {
    if (!isStoppable || isStopping) return;
    setIsStopping(true);
    setStopError(null);
    try {
      await withDashboardSpan(
        "orka.dashboard.session.stop",
        { "orka.session.id": activeSession.id },
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

  async function handleRetrySession() {
    setIsRetrying(true);
    try {
      await transport.request("retrySession", { sessionId });
    } finally {
      setIsRetrying(false);
    }
  }

  // On mobile: no internal header — MobileHeader and MobileTabBar handle navigation.
  // On desktop: render full header with tab switcher.
  const header = isMobile ? null : (
    <header className="border-b border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-ink">{activeSession.title}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-muted">{sessionId}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isStoppable && (
            <button
              type="button"
              onClick={() => void handleStopSession()}
              disabled={isStopping}
              className="inline-flex items-center gap-1 rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-1 text-[11px] font-medium text-status-error transition hover:bg-status-error/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStopping ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3" />}
              Stop
            </button>
          )}
          {isRetryable && (
            <button
              type="button"
              onClick={() => void handleRetrySession()}
              disabled={isRetrying}
              className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:text-ink-secondary disabled:opacity-50"
            >
              {isRetrying ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              Retry
            </button>
          )}
          <div className="flex rounded-sm border border-border bg-surface-alt p-0.5">
            {(["overview", "chat", "logs", "diff"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setDesktopTab(tab)}
                className={`rounded-sm px-2 py-1 text-[11px] ${
                  activeTab === tab
                    ? "bg-surface-hover text-ink"
                    : "text-ink-muted transition hover:text-ink-secondary"
                }`}
              >
                {TAB_ICONS[tab]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {stopError ? <p className="mt-1 text-[11px] text-status-error">{stopError}</p> : null}
    </header>
  );

  // On mobile, show a slim action bar for stop/retry
  const mobileActionBar = isMobile && (isStoppable || isRetryable) ? (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1">
      {isStoppable && (
        <button
          type="button"
          onClick={() => void handleStopSession()}
          disabled={isStopping}
          className="flex items-center gap-1 rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-1 text-[11px] font-medium text-status-error transition active:bg-status-error/20 disabled:opacity-50"
        >
          {isStopping ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
          Stop
        </button>
      )}
      {isRetryable && (
        <button
          type="button"
          onClick={() => void handleRetrySession()}
          disabled={isRetrying}
          className="flex items-center gap-1 rounded-sm border border-border bg-surface-alt px-2 py-1 text-[11px] font-medium text-ink-secondary transition active:bg-surface-hover disabled:opacity-50"
        >
          {isRetrying ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
          Retry
        </button>
      )}
      {stopError ? <p className="text-[11px] text-status-error">{stopError}</p> : null}
    </div>
  ) : null;

  const contentPadding = isMobile ? "p-2" : "p-3";

  return (
    <div className="flex h-full flex-col">
      {header}
      {mobileActionBar}
      <div className="flex-1 overflow-hidden">
        <div className={`h-full ${contentPadding} ${activeTab === "chat" ? "" : "hidden"}`}>
          <ChatView
            sessionId={sessionId}
            {...(activeSession.prompt ? { initialPrompt: activeSession.prompt } : {})}
            onSelectionLoadSettled={reportSelectionLoad}
            isMobile={isMobile}
          />
        </div>
        {activeTab !== "chat" && (
          <div className={`h-full ${contentPadding} ${activeTab === "logs" ? "overflow-hidden" : "overflow-y-auto"}`}>
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
            ) : (
              <DiffPanel sessionId={sessionId} onSelectionLoadSettled={reportSelectionLoad} />
            )}
          </div>
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
    <div className="space-y-2">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,1fr)]">
        <section className="rounded-sm border border-border bg-surface-alt p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Overview</p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Status</dt>
              <dd className="mt-1"><StatusBadge status={session.status} /></dd>
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
                <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Exit Code</dt>
                <dd className="mt-1">
                  <span className={`inline-flex rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-medium ${
                    session.exitCode === 0
                      ? "bg-emerald-600/10 text-emerald-700"
                      : "bg-status-error/10 text-status-error"
                  }`}>
                    {session.exitCode}
                  </span>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Kept</dt>
              <dd className="mt-1 flex items-center gap-1 text-[12px] text-ink">
                {session.kept ? (
                  <><Shield className="h-3.5 w-3.5 text-status-warning" /> Protected</>
                ) : (
                  <><ShieldOff className="h-3.5 w-3.5 text-ink-muted" /> No</>
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-sm border border-border bg-surface-alt p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Paths</p>
          <dl className="mt-2 space-y-2">
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
        <section className="rounded-sm border border-border bg-surface-alt p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Usage</p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
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
        <section className="rounded-sm border border-border bg-surface-alt p-3">
          <button
            type="button"
            onClick={() => setPromptExpanded(!promptExpanded)}
            className="flex w-full items-center gap-2 text-left"
          >
            {promptExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            )}
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Prompt</p>
          </button>
          {promptExpanded && (
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface p-2 font-mono text-[11px] leading-relaxed text-ink-secondary">
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
      <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">{label}</dt>
      <dd className={`mt-1 text-[12px] text-ink ${mono ? "break-all font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
