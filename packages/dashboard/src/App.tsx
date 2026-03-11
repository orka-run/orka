// UI architecture inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { StatusBar } from "./components/StatusBar";
import { useSessionStore } from "./stores/sessionStore";

export function App() {
  const { sessions, selectedId, selectSession, fetchSessions } = useSessionStore();

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 3000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          sessions={sessions}
          selectedId={selectedId}
          onSelect={selectSession}
        />
        <main className="flex-1 overflow-hidden">
          {selectedId ? (
            <SessionView sessionId={selectedId} />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-500">
              Select a session or spawn a new one
            </div>
          )}
        </main>
      </div>
      <StatusBar sessionCount={sessions.length} />
    </div>
  );
}
