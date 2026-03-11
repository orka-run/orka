// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import type { SessionDeletedData, SessionUpdatedData } from "@orka/core";
import { useEffect, useRef, useState } from "react";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { StatusBar } from "./components/StatusBar";
import { TransportContext } from "./lib/transportContext";
import { WsTransport } from "./lib/wsTransport";
import { useConnectionStore } from "./stores/connectionStore";
import { useSessionStore } from "./stores/sessionStore";

const DEFAULT_DAEMON_URL = "ws://127.0.0.1:7394";

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
      handleSessionUpdated(data as SessionUpdatedData);
    });
    const unsubscribeDeleted = transport.subscribe("orchestration.sessionDeleted", (data) => {
      handleSessionDeleted(data as SessionDeletedData);
    });

    void fetchSessions(transport);

    return () => {
      unsubscribeDeleted();
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
