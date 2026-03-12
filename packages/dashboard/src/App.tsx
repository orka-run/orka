// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import type {
  OrchestrationEvent,
  ServerWelcomeData,
  SessionDeletedData,
  SessionUpdatedData,
} from "@orka/core";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { DevOverlay } from "./components/DevOverlay";
import { DraftChatView, type DraftSettings } from "./components/DraftChatView";
import { ErrorBoundary, type ClientErrorReport } from "./components/ErrorBoundary";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { StatusBar } from "./components/StatusBar";
import { getTracer, initDashboardTracing } from "./lib/tracing";
import { TransportContext } from "./lib/transportContext";
import { WsTransport } from "./lib/wsTransport";
import { useConnectionStore } from "./stores/connectionStore";
import { useSessionStore } from "./stores/sessionStore";

initDashboardTracing();

type PendingSelectionSpan = {
  sessionId: string;
  span: Span;
  startedAt: number;
};

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function getDaemonUrl(): string {
  // Explicit override via env (dev mode)
  if (import.meta.env["VITE_DAEMON_URL"]) return import.meta.env["VITE_DAEMON_URL"] as string;
  // Both dev (vite proxy) and prod (nginx) use /ws on same origin
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

const DEFAULT_DAEMON_URL = getDaemonUrl();

interface AppShellProps {
  transport: WsTransport;
}

function AppShell({ transport }: AppShellProps) {
  const selectionSpanRef = useRef<PendingSelectionSpan | null>(null);
  const [isDraftActive, setIsDraftActive] = useState(false);
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [advancedDefaults, setAdvancedDefaults] = useState<DraftSettings | null>(null);
  const [serverSessionCount, setServerSessionCount] = useState<number | null>(null);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedId = useSessionStore((state) => state.selectedId);
  const selectSession = useSessionStore((state) => state.selectSession);
  const fetchSessions = useSessionStore((state) => state.fetchSessions);
  const handleSessionUpdated = useSessionStore((state) => state.handleSessionUpdated);
  const handleSessionDeleted = useSessionStore((state) => state.handleSessionDeleted);
  const setConnectionStatus = useConnectionStore((state) => state.setStatus);
  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;
  const defaultProjectPath = selectedSession?.projectPath ?? sessions[0]?.projectPath ?? "";

  const handleSelectSession = (id: string) => {
    const pendingSelection = selectionSpanRef.current;
    if (pendingSelection) {
      pendingSelection.span.setAttribute("orka.status", "superseded");
      pendingSelection.span.setAttribute("orka.duration_ms", Math.max(0, now() - pendingSelection.startedAt));
      pendingSelection.span.end();
    }

    selectionSpanRef.current = {
      sessionId: id,
      span: getTracer().startSpan("orka.dashboard.session.select", {
        attributes: {
          "orka.session.id": id,
        },
      }),
      startedAt: now(),
    };

    selectSession(id);
  };

  const handleSelectionLoadSettled = useEffectEvent((sessionId: string, status: "ok" | "error", error?: unknown) => {
    const pendingSelection = selectionSpanRef.current;
    if (!pendingSelection || pendingSelection.sessionId !== sessionId) {
      return;
    }

    pendingSelection.span.setAttribute("orka.status", status);
    pendingSelection.span.setAttribute("orka.duration_ms", Math.max(0, now() - pendingSelection.startedAt));

    if (error instanceof Error) {
      pendingSelection.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      pendingSelection.span.recordException(error);
    } else {
      pendingSelection.span.setStatus({ code: SpanStatusCode.OK });
    }

    pendingSelection.span.end();
    selectionSpanRef.current = null;
  });

  const activateDraft = () => {
    setIsDraftActive(true);
    selectSession(null);
  };

  const handleOpenAdvanced = (settings: DraftSettings) => {
    setAdvancedDefaults(settings);
    setIsNewSessionOpen(true);
  };

  const handleDraftSpawned = () => {
    setIsDraftActive(false);
    setAdvancedDefaults(null);
  };

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "n" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        activateDraft();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsubscribeState = transport.onStateChange((connection) => {
      setConnectionStatus(connection.state, connection.reconnectAttempts);
    });
    const unsubscribeWelcome = transport.subscribe("server.welcome", (data) => {
      setServerSessionCount((data as ServerWelcomeData).sessionCount);
    });
    const unsubscribeUpdated = transport.subscribe("orchestration.sessionUpdated", (data) => {
      const typedData = data as SessionUpdatedData;
      const known = useSessionStore
        .getState()
        .sessions
        .some((session) => session.id === typedData.sessionId);

      if (known) {
        handleSessionUpdated(typedData);
        return;
      }

      void fetchSessions(transport);
    });
    const unsubscribeEvent = transport.subscribe("orchestration.event", (data) => {
      const typedData = data as OrchestrationEvent;
      const known = useSessionStore
        .getState()
        .sessions
        .some((session) => session.id === typedData.sessionId);

      if (!known) {
        void fetchSessions(transport);
      }
    });
    const unsubscribeDeleted = transport.subscribe("orchestration.sessionDeleted", (data) => {
      handleSessionDeleted(data as SessionDeletedData);
    });

    void fetchSessions(transport);

    return () => {
      const pendingSelection = selectionSpanRef.current;
      if (pendingSelection) {
        pendingSelection.span.setAttribute("orka.status", "cancelled");
        pendingSelection.span.setAttribute("orka.duration_ms", Math.max(0, now() - pendingSelection.startedAt));
        pendingSelection.span.end();
        selectionSpanRef.current = null;
      }

      unsubscribeDeleted();
      unsubscribeEvent();
      unsubscribeUpdated();
      unsubscribeWelcome();
      unsubscribeState();
      transport.disconnect();
    };
  }, [transport, fetchSessions, handleSessionDeleted, handleSessionUpdated, setConnectionStatus]);

  return (
    <TransportContext.Provider value={transport}>
      <div className="flex h-screen flex-col">
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            sessions={sessions}
            selectedId={selectedId}
            isDraftActive={isDraftActive}
            onSelect={(id) => {
              handleSelectSession(id);
              // Keep draft in sidebar but show the selected session
            }}
            onSelectDraft={activateDraft}
            onNewSession={activateDraft}
          />
          <main className="flex-1 overflow-hidden">
            {selectedId ? (
              <SessionView
                sessionId={selectedId}
                transport={transport}
                onSelectionLoadSettled={handleSelectionLoadSettled}
              />
            ) : isDraftActive ? (
              <DraftChatView
                defaultProjectPath={defaultProjectPath}
                onSpawned={handleDraftSpawned}
                onOpenAdvanced={handleOpenAdvanced}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-zinc-500">
                Select a session or press{" "}
                <kbd className="mx-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                  Ctrl+N
                </kbd>{" "}
                to start a new chat
              </div>
            )}
          </main>
        </div>
        <NewSessionDialog
          open={isNewSessionOpen}
          transport={transport}
          defaultProjectPath={defaultProjectPath}
          onClose={() => {
            setIsNewSessionOpen(false);
            setAdvancedDefaults(null);
          }}
          onSpawned={handleDraftSpawned}
          {...(advancedDefaults ? { initialValues: advancedDefaults } : {})}
        />
        <StatusBar sessionCount={sessions.length} serverSessionCount={serverSessionCount} />
      </div>
    </TransportContext.Provider>
  );
}

export function App() {
  const transportRef = useRef<WsTransport | null>(null);
  const transport = transportRef.current ?? (transportRef.current = new WsTransport(DEFAULT_DAEMON_URL));

  const reportError = async (report: ClientErrorReport): Promise<void> => {
    await transport.request("reportClientError", report).catch(() => undefined);
  };

  return (
    <ErrorBoundary reportError={reportError}>
      <ConnectionBanner />
      <AppShell transport={transport} />
      <DevOverlay />
    </ErrorBoundary>
  );
}
