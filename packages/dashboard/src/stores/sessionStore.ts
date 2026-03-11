import { create } from "zustand";

export interface SessionSummary {
  id: string;
  status: string;
  backend: string;
  mode: string;
  title: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  projectPath: string;
}

interface SessionState {
  sessions: SessionSummary[];
  selectedId: string | null;
  selectSession: (id: string | null) => void;
  fetchSessions: () => Promise<void>;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  selectedId: null,
  selectSession: (id) => set({ selectedId: id }),
  fetchSessions: async () => {
    try {
      // TODO: Replace with WebSocket transport
      // For now, fetch via daemon HTTP or WS
      // This will be connected to the real daemon API later
    } catch {
      // Silently fail on fetch errors
    }
  },
}));
