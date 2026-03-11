// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import type { OrchestrationEvent, SessionDeletedData, SessionUpdatedData } from "@orka/core";
import { useEffect, useRef, useState } from "react";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { StatusBar } from "./components/StatusBar";
import { TransportContext } from "./lib/transportContext";
import { WsTransport } from "./lib/wsTransport";
import { useConnectionStore } from "./stores/connectionStore";
import { useSessionStore } from "./stores/sessionStore";

function getDaemonUrl(): string {
  // Explicit override via env (dev mode)
  if (import.meta.env.VITE_DAEMON_URL) return import.meta.env.VITE_DAEMON_URL as string;
  // Both dev (vite proxy) and prod (nginx) use /ws on same origin
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

const DEFAULT_DAEMON_URL = getDaemonUrl();

export function App() {
  const transportRef = useRef<WsTransport | null>(null);
  const transport = transportRef.current ?? (transportRef.current = new WsTransport(DEFAULT_DAEMON_URL));
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedId = useSessionStore((state) => state.selectedId);
  const selectSession = useSessionStore((state) => state.selectSession);
  const fetchSessions = useSessionStore((state) => state.fetchSessions);
  const handleSessionUpdated = useSessionStore((state) => state.handleSessionUpdated);
  const handleSessionDeleted = useSessionStore((state) => state.handleSessionDeleted);
  const setConnectionStatus = useConnectionStore((state) => state.setStatus);
  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;
  const defaultProjectPath = selectedSession?.projectPath ?? sessions[0]?.projectPath ?? "";

  useEffect(() => {
    const unsubscribeState = transport.onStateChange(setConnectionStatus);
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
      unsubscribeDeleted();
      unsubscribeEvent();
      unsubscribeUpdated();
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
            onSelect={selectSession}
            onNewSession={() => setIsNewSessionOpen(true)}
          />
          <main className="flex-1 overflow-hidden">
            {selectedId ? (
              <SessionView sessionId={selectedId} transport={transport} />
            ) : (
              <div className="flex h-full items-center justify-center text-zinc-500">
                Select a session or spawn a new one
              </div>
            )}
          </main>
        </div>
        <NewSessionDialog
          open={isNewSessionOpen}
          transport={transport}
          defaultProjectPath={defaultProjectPath}
          onClose={() => setIsNewSessionOpen(false)}
        />
        <StatusBar sessionCount={sessions.length} />
      </div>
    </TransportContext.Provider>
  );
}
