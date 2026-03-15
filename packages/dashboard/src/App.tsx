// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import type {
  OrchestrationEvent,
  ServerWelcomeData,
  SessionDeletedData,
  SessionUpdatedData,
} from "@orka/core";
import { parseWireEvent } from "@orka/core";
import { appendAuthToken, type NoiseConfig } from "@orka/client";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ConnectionSettingsDialog } from "./components/ConnectionSettingsDialog";
import { DevOverlay } from "./components/DevOverlay";
import { DraftChatView, type DraftSettings } from "./components/DraftChatView";
import { ErrorBoundary, type ClientErrorReport } from "./components/ErrorBoundary";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { PairNodeDialog } from "./components/PairNodeDialog";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { StatusBar } from "./components/StatusBar";
import { getTracer, initDashboardTracing } from "./lib/tracing";
import { TransportContext } from "./lib/transportContext";
import { loadNoiseKey, hexToBytes } from "./lib/noiseKeys";
import { loadPairedNode } from "./lib/nodeRegistry";
import { WsTransport } from "./lib/wsTransport";
import { useConnectionStore } from "./stores/connectionStore";
import { useConnectionSettingsStore } from "./stores/connectionSettingsStore";
import { useNodeStore } from "./stores/nodeStore";
import { SELECTED_SESSION_KEY, useSessionStore } from "./stores/sessionStore";

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
  if (import.meta.env["VITE_DAEMON_URL"]) return import.meta.env["VITE_DAEMON_URL"];
  // Both dev (vite proxy) and prod (nginx) use /ws on same origin
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

const DEFAULT_DAEMON_URL = getDaemonUrl();

function parseHashSessionId(): string | null {
  const match = window.location.hash.match(/^#session=(.+)$/);
  return match?.[1] ?? null;
}

function getEffectiveUrl(endpointUrl: string | null, authToken: string | null): string {
  if (!endpointUrl) return DEFAULT_DAEMON_URL;
  return authToken ? appendAuthToken(endpointUrl, authToken) : endpointUrl;
}

interface AppShellProps {
  transport: WsTransport;
}

function AppShell({ transport }: AppShellProps) {
  const selectionSpanRef = useRef<PendingSelectionSpan | null>(null);
  const hasRestoredRef = useRef(false);
  const [isDraftActive, setIsDraftActive] = useState(false);
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [isConnectionSettingsOpen, setIsConnectionSettingsOpen] = useState(false);
  const [isPairNodeOpen, setIsPairNodeOpen] = useState(false);
  const [advancedDefaults, setAdvancedDefaults] = useState<DraftSettings | null>(null);
  const [serverSessionCount, setServerSessionCount] = useState<number | null>(null);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedId = useSessionStore((state) => state.selectedId);
  const selectSession = useSessionStore((state) => state.selectSession);
  const fetchSessions = useSessionStore((state) => state.fetchSessions);
  const handleSessionUpdated = useSessionStore((state) => state.handleSessionUpdated);
  const handleSessionDeleted = useSessionStore((state) => state.handleSessionDeleted);
  const nodes = useNodeStore((state) => state.nodes);
  const selectedNodeId = useNodeStore((state) => state.selectedNodeId);
  const fetchNodes = useNodeStore((state) => state.fetchNodes);
  const selectNode = useNodeStore((state) => state.selectNode);
  const setConnectionStatus = useConnectionStore((state) => state.setStatus);
  const setProtocolMismatch = useConnectionStore((state) => state.setProtocolMismatch);
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

  // Restore selection from URL hash or localStorage after initial session load
  useEffect(() => {
    if (hasRestoredRef.current || sessions.length === 0) return;
    hasRestoredRef.current = true;

    // Try URL hash first
    const hashId = parseHashSessionId();
    if (hashId && sessions.some((s) => s.id === hashId)) {
      handleSelectSession(hashId);
      return;
    }

    // Fallback to localStorage
    try {
      const stored = localStorage.getItem(SELECTED_SESSION_KEY);
      if (stored && sessions.some((s) => s.id === stored)) {
        handleSelectSession(stored);
      }
    } catch {
      // localStorage unavailable
    }
  }, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync selectedId to URL hash
  useEffect(() => {
    if (selectedId) {
      history.replaceState(null, "", `#session=${selectedId}`);
    } else {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [selectedId]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "n" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        activateDraft();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => { window.removeEventListener("keydown", handleGlobalKeyDown); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Helper: fetch sessions using current node list
  const fetchSessionsWithNodes = useEffectEvent(() => {
    const currentNodes = useNodeStore.getState().nodes;
    const nodeIds = currentNodes.length > 1 ? currentNodes.map((n) => n.id) : undefined;
    void fetchSessions(transport, nodeIds);
  });

  useEffect(() => {
    const unsubscribeState = transport.onStateChange((connection) => {
      setConnectionStatus(connection.state, connection.reconnectAttempts);
    });
    const unsubscribeMismatch = transport.onProtocolMismatch((info) => {
      setProtocolMismatch(info);
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

      fetchSessionsWithNodes();
    });
    const unsubscribeEvent = transport.subscribe("orchestration.event", (data) => {
      const typedData = data as OrchestrationEvent;
      const known = useSessionStore
        .getState()
        .sessions
        .some((session) => session.id === typedData.sessionId);

      if (!known) {
        fetchSessionsWithNodes();
      }
    });
    const unsubscribeDeleted = transport.subscribe("orchestration.sessionDeleted", (data) => {
      handleSessionDeleted(data as SessionDeletedData);
    });

    // Initial fetch: nodes first, then sessions
    void fetchNodes(transport).then(() => {
      fetchSessionsWithNodes();
    });

    // Periodically refresh node list (every 30s)
    const nodeRefreshTimer = setInterval(() => {
      void fetchNodes(transport);
    }, 30_000);

    return () => {
      clearInterval(nodeRefreshTimer);
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
      unsubscribeMismatch();
      unsubscribeState();
      transport.disconnect();
    };
  }, [transport, fetchSessions, fetchNodes, handleSessionDeleted, handleSessionUpdated, setConnectionStatus, setProtocolMismatch]);

  return (
    <TransportContext.Provider value={transport}>
      <div className="flex h-screen flex-col">
        <ConnectionBanner />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            sessions={sessions}
            selectedId={selectedId}
            isDraftActive={isDraftActive}
            nodes={nodes}
            selectedNodeId={selectedNodeId}
            onSelect={(id) => {
              handleSelectSession(id);
              // Keep draft in sidebar but show the selected session
            }}
            onSelectDraft={activateDraft}
            onNewSession={activateDraft}
            onSelectNode={selectNode}
            onPairNode={() => setIsPairNodeOpen(true)}
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
          nodes={nodes}
          onClose={() => {
            setIsNewSessionOpen(false);
            setAdvancedDefaults(null);
          }}
          onSpawned={handleDraftSpawned}
          {...(advancedDefaults ? { initialValues: advancedDefaults } : {})}
        />
        <StatusBar
          sessionCount={sessions.length}
          serverSessionCount={serverSessionCount}
          onOpenConnectionSettings={() => setIsConnectionSettingsOpen(true)}
        />
        <ConnectionSettingsDialog
          open={isConnectionSettingsOpen}
          onClose={() => setIsConnectionSettingsOpen(false)}
        />
        <PairNodeDialog
          open={isPairNodeOpen}
          onClose={() => setIsPairNodeOpen(false)}
        />
      </div>
    </TransportContext.Provider>
  );
}

function createTransport(url: string, noiseConfig?: NoiseConfig): WsTransport {
  const t = new WsTransport(url, noiseConfig ? { noiseConfig } : undefined);
  t.registerChannelTransform("orchestration.event", (data) => parseWireEvent(data));
  return t;
}

function resolveNoiseConfig(pairedNodeId: string | null): NoiseConfig | undefined {
  if (!pairedNodeId) return undefined;
  const key = loadNoiseKey(pairedNodeId);
  const node = loadPairedNode(pairedNodeId);
  if (!key || !node) return undefined;
  return {
    nodeId: pairedNodeId,
    serverKey: { publicKey: hexToBytes(key.publicKey), keyId: key.keyId },
    relayOrigin: node.relayOrigin,
  };
}

export function App() {
  const endpointUrl = useConnectionSettingsStore((s) => s.endpointUrl);
  const authToken = useConnectionSettingsStore((s) => s.authToken);
  const pairedNodeId = useConnectionSettingsStore((s) => s.pairedNodeId);
  const effectiveUrl = useMemo(() => getEffectiveUrl(endpointUrl, authToken), [endpointUrl, authToken]);
  const noiseConfig = useMemo(() => resolveNoiseConfig(pairedNodeId), [pairedNodeId]);

  const transportKey = `${effectiveUrl}::${pairedNodeId ?? ""}`;
  const transportRef = useRef<{ key: string; transport: WsTransport } | null>(null);

  // Re-create transport when effective URL or paired node changes
  if (!transportRef.current || transportRef.current.key !== transportKey) {
    transportRef.current?.transport.disconnect();
    transportRef.current = { key: transportKey, transport: createTransport(effectiveUrl, noiseConfig) };
  }
  const transport = transportRef.current.transport;

  const reportError = async (report: ClientErrorReport): Promise<void> => {
    await transport.request("reportClientError", report).catch(() => undefined);
  };

  return (
    <ErrorBoundary reportError={reportError}>
      <AppShell key={transportKey} transport={transport} />
      <DevOverlay />
    </ErrorBoundary>
  );
}
