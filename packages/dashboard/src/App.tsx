// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import type {
  OrchestrationEvent,
  ServerWelcomeData,
  SessionDeletedData,
  WorkspaceSettings,
} from "@orka/core";
import { parseWireEvent } from "@orka/core";
import { appendAuthToken, type NoiseConfig } from "@orka/client";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ConnectionSettingsDialog } from "./components/ConnectionSettingsDialog";
import { DevOverlay } from "./components/DevOverlay";
import { SpawnComposer } from "./components/SpawnComposer";
import { ErrorBoundary, type ClientErrorReport } from "./components/ErrorBoundary";
import { MobileHeader } from "./components/MobileHeader";
import { MobileSidebarDrawer } from "./components/MobileSidebarDrawer";
import { MobileTabBar, type MobileSessionTab } from "./components/MobileTabBar";
import { NodeManagementDialog } from "./components/NodeManagementDialog";
import { NotificationPermissionBanner, PendingApprovalBanner } from "./components/NotificationBanner";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { PairNodeDialog } from "./components/PairNodeDialog";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { SettingsView } from "./components/SettingsView";
import { StatusBar } from "./components/StatusBar";
import { WorkspaceDetailView } from "./components/WorkspaceDetailView";
import { useMobileBreakpoint } from "./hooks/useMobileBreakpoint";
import { getTracer, initDashboardTracing, startDashboardSpan, finishDashboardSpan } from "./lib/tracing";
import { TransportContext, RpcClientContext } from "./lib/transportContext";
import { RpcClient } from "./lib/rpcClient";
import { loadNoiseKey, hexToBytes } from "./lib/noiseKeys";
import { loadPairedNode } from "./lib/nodeRegistry";
import { createDashboardTransport, type WsTransport } from "./lib/wsTransport";
import { useConnectionStore } from "./stores/connectionStore";
import { useConnectionSettingsStore } from "./stores/connectionSettingsStore";
import { useMode } from "./hooks/useMode";
import { useNodeStore } from "./stores/nodeStore";
import { useNotificationStore } from "./stores/notificationStore";
import { SELECTED_SESSION_KEY, useSessionStore } from "./stores/sessionStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useTimelineCache } from "./lib/timelineCache";
import {
  captureBaseTitle,
  playNotificationSound,
  sendApprovalNotification,
  updateTitleBadge,
} from "./lib/notificationService";

initDashboardTracing();

type PendingSelectionSpan = {
  sessionId: string;
  span: Span;
  startedAt: number;
};

type ErrorThrottleEntry = {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
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

function shouldIgnoreClientError(report: ClientErrorReport): boolean {
  const haystack = `${report.error}\n${report.stack ?? ""}\n${report.url}`.toLowerCase();
  return haystack.includes("@vite/client")
    || haystack.includes("/@vite/client")
    || (haystack.includes("vite") && haystack.includes("websocket"))
    || (haystack.includes("hmr") && haystack.includes("websocket"))
    || haystack.includes("failed to execute 'send' on 'websocket'");
}

function getClientErrorKey(report: ClientErrorReport): string {
  const stackLine = report.stack?.split("\n", 1)[0] ?? "";
  return `${report.error}\n${stackLine}\n${report.url}`;
}

interface AppShellProps {
  transport: WsTransport;
  client: RpcClient;
}

function getWorkspaceProjectPath(
  workspace: { paths: Array<{ nodeId: string | null; projectPath: string }> },
  selectedNodeId: string | null,
): string | undefined {
  if (selectedNodeId) {
    const match = workspace.paths.find((p) => p.nodeId === selectedNodeId);
    if (match) return match.projectPath;
  }
  const noNode = workspace.paths.find((p) => p.nodeId === null);
  return noNode?.projectPath ?? workspace.paths[0]?.projectPath;
}

// Bypass banner removed — user explicitly chooses bypass mode, no need to nag.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function BypassBanner(_props: { sessions: Array<{ status: string; permissionMode: string | null }> }) {
  return null;
}

function AppShell({ transport, client }: AppShellProps) {
  const { mode } = useMode();
  const { isMobile } = useMobileBreakpoint();
  const selectionSpanRef = useRef<PendingSelectionSpan | null>(null);
  const hasRestoredRef = useRef(false);
  const [isDraftActive, setIsDraftActive] = useState(false);
  const [isConnectionSettingsOpen, setIsConnectionSettingsOpen] = useState(false);
  const [isPairNodeOpen, setIsPairNodeOpen] = useState(false);
  const [isNodeManagementOpen, setIsNodeManagementOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [mobileActiveTab, setMobileActiveTab] = useState<MobileSessionTab>("chat");
  const [isDevOverlayOpen, setIsDevOverlayOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [serverSessionCount, setServerSessionCount] = useState<number | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try { return localStorage.getItem("orka-onboarding-dismissed") === "1"; } catch { return false; }
  });
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedId = useSessionStore((state) => state.selectedId);
  const selectSession = useSessionStore((state) => state.selectSession);
  const fetchSessions = useSessionStore((state) => state.fetchSessions);
  const handleSessionDeleted = useSessionStore((state) => state.handleSessionDeleted);
  const nodes = useNodeStore((state) => state.nodes);
  const pairedNodes = useNodeStore((state) => state.pairedNodes);
  const selectedNodeId = useNodeStore((state) => state.selectedNodeId);
  const fetchNodes = useNodeStore((state) => state.fetchNodes);
  const fetchPairedNodes = useNodeStore((state) => state.fetchPairedNodes);
  const selectNode = useNodeStore((state) => state.selectNode);
  const updateNodeStatus = useNodeStore((state) => state.updateNodeStatus);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const fetchWorkspaces = useWorkspaceStore((state) => state.fetchWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const activeWorkspace = activeWorkspaceId
    ? workspaces.find((w) => w.id === activeWorkspaceId) ?? null
    : null;
  const setConnectionStatus = useConnectionStore((state) => state.setStatus);
  const setProtocolMismatch = useConnectionStore((state) => state.setProtocolMismatch);
  const prefetchTimeline = useTimelineCache((s) => s.prefetch);
  const incrementPending = useNotificationStore((s) => s.incrementPending);
  const decrementPending = useNotificationStore((s) => s.decrementPending);
  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;
  const baseProjectPath = selectedSession?.projectPath ?? sessions[0]?.projectPath ?? "";
  // Use workspace path when a workspace is active
  const defaultProjectPath = activeWorkspace
    ? getWorkspaceProjectPath(activeWorkspace, selectedNodeId) ?? baseProjectPath
    : baseProjectPath;

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
    setIsSettingsOpen(false);
    setIsMobileSidebarOpen(false);
    // When selecting a session on mobile, go to chat tab
    setMobileActiveTab("chat");
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

  const activateDraft = useCallback(() => {
    setIsDraftActive(true);
    setIsSettingsOpen(false);
    selectSession(null);
    setIsMobileSidebarOpen(false);
  }, [selectSession]);

  const handleDraftSpawned = () => {
    setIsDraftActive(false);
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

  // Detect first-run: show onboarding only once after initial load, not reactively
  const onboardingCheckedRef = useRef(false);
  useEffect(() => {
    if (onboardingDismissed || !initialLoadDone || onboardingCheckedRef.current) return;
    onboardingCheckedRef.current = true;
    const isFirstRun = sessions.length === 0 && mode === "local" && pairedNodes.length === 0;
    if (isFirstRun) setShowOnboarding(true);
  }, [initialLoadDone]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Capture base page title once, update badge on pending count changes
  const pendingCount = useNotificationStore((s) => s.pendingCount);
  useEffect(() => {
    captureBaseTitle();
  }, []);
  useEffect(() => {
    updateTitleBadge(pendingCount);
    return () => { updateTitleBadge(0); };
  }, [pendingCount]);

  // Helper: fetch sessions using current node list
  const fetchSessionsWithNodes = useEffectEvent(() => {
    const currentNodes = useNodeStore.getState().nodes;
    const nodeIds = currentNodes.length > 1 ? currentNodes.map((n) => n.id) : undefined;
    void fetchSessions(client, nodeIds);
  });

  useEffect(() => {
    transport.connect();

    let wasReconnecting = false;
    let reconnectSpan: { span: import("@opentelemetry/api").Span; startedAt: number } | null = null;
    const unsubscribeState = transport.onStateChange((connection) => {
      setConnectionStatus(connection.state, connection.reconnectAttempts);

      if (connection.state === "reconnecting" && !reconnectSpan) {
        reconnectSpan = startDashboardSpan("orka.dashboard.ws_reconnect", {
          "orka.reconnect_attempt": connection.reconnectAttempts,
        });
      }
      if (connection.state === "connected" && reconnectSpan) {
        finishDashboardSpan(reconnectSpan.span, reconnectSpan.startedAt, "ok");
        reconnectSpan = null;
      }
      if (connection.state === "disconnected" && reconnectSpan) {
        finishDashboardSpan(reconnectSpan.span, reconnectSpan.startedAt, "error");
        reconnectSpan = null;
      }

      // On reconnect: fetch snapshot in background — merge keeps existing data visible
      if (connection.state === "connected" && wasReconnecting) {
        fetchSessionsWithNodes();
      }
      wasReconnecting = connection.state === "reconnecting";
    });
    const unsubscribeMismatch = transport.onProtocolMismatch((info) => {
      setProtocolMismatch(info);
    });
    const unsubscribeWelcome = transport.subscribe("server.welcome", (data) => {
      setServerSessionCount((data as ServerWelcomeData).sessionCount);
    });
    const unsubscribeUpdated = transport.subscribe("orchestration.sessionUpdated", (_data) => {
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

      // Track approval events for notifications
      if (typedData.type === "request.opened") {
        incrementPending();

        // Play sound if enabled
        if (useNotificationStore.getState().soundEnabled) {
          playNotificationSound();
        }

        // Send browser notification if page is hidden
        const session = useSessionStore.getState().sessions.find((s) => s.id === typedData.sessionId);
        sendApprovalNotification({
          requestId: typedData.requestId,
          requestType: typedData.requestType,
          sessionId: typedData.sessionId,
          ...(typedData.detail ? { detail: typedData.detail } : {}),
          ...(session?.title ? { sessionTitle: session.title } : {}),
        });
      } else if (typedData.type === "request.resolved") {
        decrementPending();
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
        void fetchNodes(client);
      }
    });

    // Fire sessions + workspaces fetch immediately for faster first paint
    const { span: loadSpan, startedAt: loadStart } = startDashboardSpan("orka.dashboard.initial_load");
    void fetchSessions(client).then(() => {
      finishDashboardSpan(loadSpan, loadStart, "ok");
      setInitialLoadDone(true);
    }).catch((err) => {
      finishDashboardSpan(loadSpan, loadStart, "error", err);
    });
    void fetchWorkspaces(client);

    // Fetch nodes in parallel; re-fetch sessions with node IDs if multi-node
    void fetchNodes(client).then(() => {
      const currentNodes = useNodeStore.getState().nodes;
      if (currentNodes.length > 1) {
        fetchSessionsWithNodes();
      }
    });

    // Fetch paired nodes in local mode
    if (mode === "local") {
      void fetchPairedNodes(client);
    }

    // Periodically refresh node list (every 10s for fresher status)
    const nodeRefreshTimer = setInterval(() => {
      void fetchNodes(client);
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
  }, [transport, client, mode, fetchSessions, fetchNodes, fetchPairedNodes, fetchWorkspaces, handleSessionDeleted, setConnectionStatus, setProtocolMismatch, updateNodeStatus, incrementPending, decrementPending]);

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false);
    setOnboardingDismissed(true);
    try { localStorage.setItem("orka-onboarding-dismissed", "1"); } catch { /* ignore */ }
    void fetchSessions(client);
    void fetchNodes(client);
    void fetchWorkspaces(client);
    if (mode === "local") void fetchPairedNodes(client);
  }, [client, mode, fetchSessions, fetchNodes, fetchPairedNodes, fetchWorkspaces]);

  const handleOnboardingSkip = useCallback(() => {
    setShowOnboarding(false);
    setOnboardingDismissed(true);
    try { localStorage.setItem("orka-onboarding-dismissed", "1"); } catch { /* ignore */ }
  }, []);

  const handleRerunWizard = useCallback(() => {
    setOnboardingDismissed(false);
    try { localStorage.removeItem("orka-onboarding-dismissed"); } catch { /* ignore */ }
    setShowOnboarding(true);
  }, []);

  const handleCreateWorkspace = useCallback(async (name: string) => {
    const ws = await createWorkspace(client, {
      name,
      ...(defaultProjectPath ? { paths: [{ path: defaultProjectPath }] } : {}),
    });
    setActiveWorkspace(ws.id);
  }, [client, createWorkspace, setActiveWorkspace, defaultProjectPath]);

  const handleUpdateWorkspaceSettings = useCallback(async (settings: WorkspaceSettings) => {
    if (!activeWorkspaceId) return;
    await updateWorkspace(client, activeWorkspaceId, { settings });
  }, [client, activeWorkspaceId, updateWorkspace]);

  const handleArchiveWorkspace = useCallback(async () => {
    if (!activeWorkspaceId) return;
    await updateWorkspace(client, activeWorkspaceId, {
      archivedAt: activeWorkspace?.archivedAt ? null : new Date().toISOString(),
    });
  }, [client, activeWorkspaceId, activeWorkspace?.archivedAt, updateWorkspace]);

  const sidebarProps = {
    sessions,
    selectedId,
    isDraftActive,
    nodes,
    selectedNodeId,
    workspaces,
    activeWorkspaceId,
    onSelect: (id: string) => {
      handleSelectSession(id);
    },
    onHover: (id: string) => {
      prefetchTimeline(client, id);
    },
    onSelectDraft: activateDraft,
    onNewSession: activateDraft,
    onSelectNode: selectNode,
    onSelectWorkspace: setActiveWorkspace,
    onCreateWorkspace: handleCreateWorkspace,
    onPairNode: () => setIsPairNodeOpen(true),
    ...(mode === "local" && pairedNodes.length > 0
      ? { onManageNodes: () => setIsNodeManagementOpen(true) }
      : {}),
  };

  // Mobile main content: show SessionView, SpawnComposer, WorkspaceDetailView, or empty state
  const mobileMainContent = selectedId ? (
    <SessionView
      sessionId={selectedId}
      onSelectionLoadSettled={handleSelectionLoadSettled}
      isMobile
      mobileActiveTab={mobileActiveTab}
      onMobileTabChange={setMobileActiveTab}
    />
  ) : isDraftActive ? (
    <SpawnComposer
      key={activeWorkspaceId ?? "all"}
      defaultProjectPath={defaultProjectPath}
      nodes={nodes}
      activeWorkspace={activeWorkspace}
      onSpawned={handleDraftSpawned}
    />
  ) : activeWorkspace ? (
    <WorkspaceDetailView
      workspace={activeWorkspace}
      onNewSession={activateDraft}
      onUpdateSettings={handleUpdateWorkspaceSettings}
      onArchive={handleArchiveWorkspace}
    />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <div className="rounded-sm bg-surface-alt p-3">
        <svg className="h-8 w-8 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
        </svg>
      </div>
      <p className="text-[12px] text-ink-muted">Select a session to view details</p>
      <button
        type="button"
        onClick={activateDraft}
        className="rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent"
      >
        New Session
      </button>
    </div>
  );

  const handleOpenSettings = () => {
    setIsSettingsOpen(true);
    selectSession(null);
    setIsDraftActive(false);
  };

  // Desktop main content
  const desktopMainContent = isSettingsOpen ? (
    <SettingsView {...(defaultProjectPath ? { projectPath: defaultProjectPath } : {})} />
  ) : selectedId ? (
    <SessionView
      sessionId={selectedId}
      onSelectionLoadSettled={handleSelectionLoadSettled}
    />
  ) : isDraftActive ? (
    <SpawnComposer
      key={activeWorkspaceId ?? "all"}
      defaultProjectPath={defaultProjectPath}
      nodes={nodes}
      activeWorkspace={activeWorkspace}
      onSpawned={handleDraftSpawned}
    />
  ) : activeWorkspace ? (
    <WorkspaceDetailView
      workspace={activeWorkspace}
      onNewSession={activateDraft}
      onUpdateSettings={handleUpdateWorkspaceSettings}
      onArchive={handleArchiveWorkspace}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-ink-muted text-[12px]">
      Select a session or press{" "}
      <kbd className="mx-1 rounded-sm border border-border bg-surface-alt px-1.5 py-0.5 font-mono text-[11px]">
        Ctrl+N
      </kbd>{" "}
      to start a new chat
    </div>
  );

  const mobileHeaderTitle = selectedSession?.title ?? null;

  // Show onboarding wizard as full-screen replacement
  if (showOnboarding) {
    return (
      <TransportContext.Provider value={transport}>
        <RpcClientContext.Provider value={client}>
          <div className="flex h-dvh flex-col bg-surface">
            <OnboardingWizard
              onComplete={handleOnboardingComplete}
              onSkip={handleOnboardingSkip}
            />
          </div>
        </RpcClientContext.Provider>
      </TransportContext.Provider>
    );
  }

  return (
    <TransportContext.Provider value={transport}>
      <RpcClientContext.Provider value={client}>
      <div className="flex h-dvh flex-col">
        <ConnectionBanner />
        <NotificationPermissionBanner />
        <PendingApprovalBanner />
        <BypassBanner sessions={sessions} />
        {isMobile ? (
          <>
            <MobileHeader title={mobileHeaderTitle} />
            <main className="flex-1 overflow-hidden">{mobileMainContent}</main>
            <MobileTabBar
              hasSelectedSession={!!selectedId}
              activeTab={mobileActiveTab}
              onTabChange={setMobileActiveTab}
              onShowSessions={() => setIsMobileSidebarOpen(true)}
            />
            <MobileSidebarDrawer
              open={isMobileSidebarOpen}
              onClose={() => setIsMobileSidebarOpen(false)}
            >
              <Sidebar {...sidebarProps} fullWidth />
            </MobileSidebarDrawer>
          </>
        ) : (
          <>
            <div className="flex flex-1 overflow-hidden">
              <Sidebar {...sidebarProps} />
              <main className="flex-1 overflow-hidden">{desktopMainContent}</main>
            </div>
            <div className="relative">
              <DevOverlay open={isDevOverlayOpen} onClose={() => setIsDevOverlayOpen(false)} />
              <StatusBar
                sessionCount={sessions.length}
                serverSessionCount={serverSessionCount}
                onOpenConnectionSettings={() => setIsConnectionSettingsOpen(true)}
                onOpenSettings={handleOpenSettings}
                isSettingsOpen={isSettingsOpen}
                onToggleDevOverlay={() => setIsDevOverlayOpen((v) => !v)}
                isDevOverlayOpen={isDevOverlayOpen}
              />
            </div>
          </>
        )}
        <ConnectionSettingsDialog
          open={isConnectionSettingsOpen}
          onClose={() => setIsConnectionSettingsOpen(false)}
          onRerunWizard={handleRerunWizard}
        />
        <PairNodeDialog
          open={isPairNodeOpen}
          onClose={() => {
            setIsPairNodeOpen(false);
            // Refresh paired nodes after pairing dialog closes (new node may have been paired)
            if (mode === "local") void fetchPairedNodes(client);
          }}
        />
        {mode === "local" && (
          <NodeManagementDialog
            open={isNodeManagementOpen}
            onClose={() => setIsNodeManagementOpen(false)}
            pairedNodes={pairedNodes}
            liveNodes={nodes}
            onRemoveNode={async (nodeId) => {
              await useNodeStore.getState().removeNode(client, nodeId);
              void fetchNodes(client);
            }}
            onConnectNode={async (nodeId) => {
              await useNodeStore.getState().connectNode(client, nodeId);
              void fetchNodes(client);
            }}
            onDisconnectNode={async (nodeId) => {
              await useNodeStore.getState().disconnectNode(client, nodeId);
              void fetchNodes(client);
            }}
            onPairNode={() => {
              setIsNodeManagementOpen(false);
              setIsPairNodeOpen(true);
            }}
          />
        )}
      </div>
      </RpcClientContext.Provider>
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
    transportRef.current?.transport.dispose();
    transportRef.current = { key: transportKey, transport: createTransport(effectiveUrl, noiseConfig) };
  }
  const transport = transportRef.current.transport;
  const client = useMemo(() => new RpcClient(transport), [transport]);

  const reportedErrors = useRef(new Map<string, ErrorThrottleEntry>());
  const reportError = async (report: ClientErrorReport): Promise<void> => {
    if (shouldIgnoreClientError(report)) return;

    const key = getClientErrorKey(report);
    const currentTime = Date.now();

    for (const [entryKey, entry] of reportedErrors.current) {
      if (currentTime - entry.lastSeenAt > 60_000) {
        reportedErrors.current.delete(entryKey);
      }
    }

    const existing = reportedErrors.current.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = currentTime;
      if (currentTime - existing.firstSeenAt < 60_000) {
        return;
      }
      existing.firstSeenAt = currentTime;
    } else {
      reportedErrors.current.set(key, {
        count: 1,
        firstSeenAt: currentTime,
        lastSeenAt: currentTime,
      });
    }

    await client.reportClientError(report).catch(() => undefined);
  };

  return (
    <ErrorBoundary reportError={reportError}>
      <AppShell key={transportKey} transport={transport} client={client} />
    </ErrorBoundary>
  );
}
