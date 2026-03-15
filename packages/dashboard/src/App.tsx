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
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ConnectionSettingsDialog } from "./components/ConnectionSettingsDialog";
import { DevOverlay } from "./components/DevOverlay";
import { DraftChatView, type DraftSettings } from "./components/DraftChatView";
import { ErrorBoundary, type ClientErrorReport } from "./components/ErrorBoundary";
import { MobileHeader } from "./components/MobileHeader";
import { MobileSidebarDrawer } from "./components/MobileSidebarDrawer";
import { MobileTabBar, type MobileTab } from "./components/MobileTabBar";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { NodeManagementDialog } from "./components/NodeManagementDialog";
import { PairNodeDialog } from "./components/PairNodeDialog";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { StatusBar } from "./components/StatusBar";
import { useMobileBreakpoint } from "./hooks/useMobileBreakpoint";
import { getTracer, initDashboardTracing } from "./lib/tracing";
import { TransportContext } from "./lib/transportContext";
import { loadNoiseKey, hexToBytes } from "./lib/noiseKeys";
import { loadPairedNode } from "./lib/nodeRegistry";
import { createDashboardTransport, type WsTransport } from "./lib/wsTransport";
import { useConnectionStore } from "./stores/connectionStore";
import { useConnectionSettingsStore } from "./stores/connectionSettingsStore";
import { useMode } from "./hooks/useMode";
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
  const { mode } = useMode();
  const selectionSpanRef = useRef<PendingSelectionSpan | null>(null);
  const hasRestoredRef = useRef(false);
  const [isDraftActive, setIsDraftActive] = useState(false);
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [isConnectionSettingsOpen, setIsConnectionSettingsOpen] = useState(false);
  const [isPairNodeOpen, setIsPairNodeOpen] = useState(false);
  const [isNodeManagementOpen, setIsNodeManagementOpen] = useState(false);
  const [advancedDefaults, setAdvancedDefaults] = useState<DraftSettings | null>(null);
  const [serverSessionCount, setServerSessionCount] = useState<number | null>(null);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedId = useSessionStore((state) => state.selectedId);
  const selectSession = useSessionStore((state) => state.selectSession);
  const fetchSessions = useSessionStore((state) => state.fetchSessions);
  const handleSessionUpdated = useSessionStore((state) => state.handleSessionUpdated);
  const handleSessionDeleted = useSessionStore((state) => state.handleSessionDeleted);
  const nodes = useNodeStore((state) => state.nodes);
  const pairedNodes = useNodeStore((state) => state.pairedNodes);
  const selectedNodeId = useNodeStore((state) => state.selectedNodeId);
  const fetchNodes = useNodeStore((state) => state.fetchNodes);
  const fetchPairedNodes = useNodeStore((state) => state.fetchPairedNodes);
  const selectNode = useNodeStore((state) => state.selectNode);
  const updateNodeStatus = useNodeStore((state) => state.updateNodeStatus);
  const setConnectionStatus = useConnectionStore((state) => state.setStatus);
  const setProtocolMismatch = useConnectionStore((state) => state.setProtocolMismatch);
  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;
  const defaultProjectPath = selectedSession?.projectPath ?? sessions[0]?.projectPath ?? "";

  // Mobile layout state
  const { isMobile } = useMobileBreakpoint();
  const [isSidebarDrawerOpen, setIsSidebarDrawerOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("sessions");

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

  const handleMobileTabChange = useCallback((tab: MobileTab) => {
    setMobileTab(tab);
    if (tab === "settings") {
      setIsConnectionSettingsOpen(true);
    }
  }, []);

  const handleMobileSelectSession = useCallback((id: string) => {
    handleSelectSession(id);
    setIsSidebarDrawerOpen(false);
    setMobileTab("chat");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Subscribe to fleet.nodeUpdated for real-time node status
    const unsubscribeNodeUpdated = transport.subscribe("fleet.nodeUpdated", (data) => {
      const update = data as { nodeId: string; status: "online" | "offline" | "error" };
      if (update.nodeId && update.status) {
        updateNodeStatus(update.nodeId, update.status);
        // Refresh full node list on status changes
        void fetchNodes(transport);
      }
    });

    // Initial fetch: nodes first, then sessions
    void fetchNodes(transport).then(() => {
      fetchSessionsWithNodes();
    });

    // Fetch paired nodes in local mode
    if (mode === "local") {
      void fetchPairedNodes(transport);
    }

    // Periodically refresh node list (every 10s for fresher status)
    const nodeRefreshTimer = setInterval(() => {
      void fetchNodes(transport);
    }, 10_000);

    return () => {
      clearInterval(nodeRefreshTimer);
      const pendingSelection = selectionSpanRef.current;
      if (pendingSelection) {
        pendingSelection.span.setAttribute("orka.status", "cancelled");
        pendingSelection.span.setAttribute("orka.duration_ms", Math.max(0, now() - pendingSelection.startedAt));
        pendingSelection.span.end();
        selectionSpanRef.current = null;
      }

      unsubscribeNodeUpdated();
      unsubscribeDeleted();
      unsubscribeEvent();
      unsubscribeUpdated();
      unsubscribeWelcome();
      unsubscribeMismatch();
      unsubscribeState();
      transport.disconnect();
    };
  }, [transport, mode, fetchSessions, fetchNodes, fetchPairedNodes, handleSessionDeleted, handleSessionUpdated, setConnectionStatus, setProtocolMismatch, updateNodeStatus]);

  const manageNodesHandler = mode === "local" && pairedNodes.length > 0 ? () => setIsNodeManagementOpen(true) : undefined;
  const sidebarProps = {
    sessions,
    selectedId,
    isDraftActive,
    nodes,
    selectedNodeId,
    onSelectDraft: activateDraft,
    onNewSession: activateDraft,
    onSelectNode: selectNode,
    onPairNode: () => setIsPairNodeOpen(true),
    ...(manageNodesHandler ? { onManageNodes: manageNodesHandler } : {}),
  };

  const mainContent = selectedId ? (
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
  ) : null;

  const mobileMainContent = (() => {
    if (mobileTab === "sessions" || mobileTab === "settings") return null;
    if (!selectedId) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">
          Select a session from the Sessions tab
        </div>
      );
    }
    if (mobileTab === "chat") {
      return (
        <SessionView
          sessionId={selectedId}
          transport={transport}
          onSelectionLoadSettled={handleSelectionLoadSettled}
        />
      );
    }
    // diff and logs tabs reuse SessionView (it has its own tab system)
    return (
      <SessionView
        sessionId={selectedId}
        transport={transport}
        onSelectionLoadSettled={handleSelectionLoadSettled}
      />
    );
  })();

  return (
    <TransportContext.Provider value={transport}>
      {/* ── Desktop layout (lg+) ── */}
      {!isMobile && (
        <div className="flex h-screen flex-col">
          <ConnectionBanner />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar
              {...sidebarProps}
              onSelect={(id) => {
                handleSelectSession(id);
              }}
            />
            <main className="flex-1 overflow-hidden">
              {mainContent ?? (
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
          <StatusBar
            sessionCount={sessions.length}
            serverSessionCount={serverSessionCount}
            onOpenConnectionSettings={() => setIsConnectionSettingsOpen(true)}
          />
        </div>
      )}

      {/* ── Mobile layout (<lg) ── */}
      {isMobile && (
        <div className="flex h-screen flex-col">
          <ConnectionBanner />
          <MobileHeader
            title={selectedSession?.title ?? null}
            onOpenSidebar={() => setIsSidebarDrawerOpen(true)}
          />
          <div className="flex-1 overflow-y-auto pb-14">
            {mobileTab === "sessions" ? (
              <div className="flex flex-col">
                <Sidebar
                  {...sidebarProps}
                  className="flex w-full flex-col bg-zinc-950"
                  onSelect={handleMobileSelectSession}
                />
              </div>
            ) : (
              <main className="h-full overflow-hidden">
                {mobileMainContent}
              </main>
            )}
          </div>
          <MobileTabBar
            activeTab={mobileTab}
            onTabChange={handleMobileTabChange}
            hasActiveSession={!!selectedId}
          />
          <MobileSidebarDrawer
            open={isSidebarDrawerOpen}
            onClose={() => setIsSidebarDrawerOpen(false)}
          >
            <Sidebar
              {...sidebarProps}
              onSelect={(id) => {
                handleMobileSelectSession(id);
              }}
            />
          </MobileSidebarDrawer>
        </div>
      )}

      {/* ── Shared dialogs (both layouts) ── */}
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
      <ConnectionSettingsDialog
        open={isConnectionSettingsOpen}
        onClose={() => setIsConnectionSettingsOpen(false)}
      />
      <PairNodeDialog
        open={isPairNodeOpen}
        onClose={() => {
          setIsPairNodeOpen(false);
          if (mode === "local") void fetchPairedNodes(transport);
        }}
      />
      {mode === "local" && (
        <NodeManagementDialog
          open={isNodeManagementOpen}
          onClose={() => setIsNodeManagementOpen(false)}
          pairedNodes={pairedNodes}
          liveNodes={nodes}
          onRemoveNode={async (nodeId) => {
            await useNodeStore.getState().removeNode(transport, nodeId);
            void fetchNodes(transport);
          }}
          onConnectNode={async (nodeId) => {
            await useNodeStore.getState().connectNode(transport, nodeId);
            void fetchNodes(transport);
          }}
          onDisconnectNode={async (nodeId) => {
            await useNodeStore.getState().disconnectNode(transport, nodeId);
            void fetchNodes(transport);
          }}
        />
      )}
    </TransportContext.Provider>
  );
}

function createTransport(url: string, noiseConfig?: NoiseConfig): WsTransport {
  const t = createDashboardTransport(url, noiseConfig ? { noiseConfig } : undefined);
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
  const { mode } = useMode();
  const endpointUrl = useConnectionSettingsStore((s) => s.endpointUrl);
  const authToken = useConnectionSettingsStore((s) => s.authToken);
  const pairedNodeId = useConnectionSettingsStore((s) => s.pairedNodeId);

  // Compute transport URL and noise config based on mode
  const effectiveUrl = useMemo(() => {
    if (mode === "local") return DEFAULT_DAEMON_URL;
    return getEffectiveUrl(endpointUrl, authToken);
  }, [mode, endpointUrl, authToken]);

  const noiseConfig = useMemo(() => {
    if (mode === "local") return undefined;
    return resolveNoiseConfig(pairedNodeId);
  }, [mode, pairedNodeId]);

  const transportKey = `${mode}::${effectiveUrl}::${mode === "hosted" ? (pairedNodeId ?? "") : ""}`;
  const transportRef = useRef<{ key: string; transport: WsTransport } | null>(null);

  // Re-create transport when mode, URL, or paired node changes
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
