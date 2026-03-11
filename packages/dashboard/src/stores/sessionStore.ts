import type { Session, SpawnRequest, Task } from "@orka/core";
import type { SessionDeletedData, SessionUpdatedData } from "@orka/core";
import { create } from "zustand";
import { WsTransport } from "../lib/wsTransport";

const FALLBACK_TITLE_LENGTH = 80;

export interface SessionSummary {
  id: string;
  status: Session["status"];
  backend: Session["backend"];
  mode: Session["mode"];
  title: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  projectPath: string;
}

export interface SessionState {
  sessions: SessionSummary[];
  selectedId: string | null;
  isLoading: boolean;
  error: string | null;
  selectSession: (id: string | null) => void;
  fetchSessions: (transport: WsTransport) => Promise<void>;
  spawnSession: (transport: WsTransport, request: SpawnRequest) => Promise<string>;
  stopSession: (transport: WsTransport, sessionId: string) => Promise<void>;
  deleteSession: (transport: WsTransport, sessionId: string) => Promise<void>;
  handleSessionUpdated: (data: SessionUpdatedData) => void;
  handleSessionDeleted: (data: SessionDeletedData) => void;
}

async function getTaskTitle(transport: WsTransport, taskId: string): Promise<string | null> {
  try {
    const task = await transport.request<Task | null>("getTask", { id: taskId });
    return task?.title ?? null;
  } catch {
    return null;
  }
}

async function toSessionSummary(
  transport: WsTransport,
  session: Session,
  fallbackTitle?: string,
): Promise<SessionSummary> {
  const title = fallbackTitle ?? (await getTaskTitle(transport, session.taskId)) ?? session.id;

  return {
    id: session.id,
    status: session.status,
    backend: session.backend,
    mode: session.mode,
    title,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    exitCode: session.exitCode,
    projectPath: session.projectPath,
  };
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function upsertSession(sessions: SessionSummary[], nextSession: SessionSummary): SessionSummary[] {
  const withoutCurrent = sessions.filter((session) => session.id !== nextSession.id);
  return sortSessions([nextSession, ...withoutCurrent]);
}

function fallbackTitleFromRequest(request: SpawnRequest): string | undefined {
  const trimmedTitle = request.title?.trim();
  if (trimmedTitle) {
    return trimmedTitle;
  }

  const prompt = request.prompt.trim();
  if (!prompt) {
    return undefined;
  }

  return prompt.slice(0, FALLBACK_TITLE_LENGTH);
}

function createSessionState(set: (partial: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>)) => void): SessionState {
  return {
    sessions: [],
    selectedId: null,
    isLoading: false,
    error: null,
    selectSession: (id) => set({ selectedId: id }),
    fetchSessions: async (transport) => {
      set({ isLoading: true, error: null });

      try {
        const sessions = await transport.request<Session[]>("listSessions");
        const summaries = await Promise.all(
          sessions.map((session) => toSessionSummary(transport, session)),
        );

        set((state) => ({
          sessions: sortSessions(summaries),
          selectedId: state.selectedId && summaries.some((session) => session.id === state.selectedId)
            ? state.selectedId
            : null,
          isLoading: false,
          error: null,
        }));
      } catch (error) {
        set({
          isLoading: false,
          error: error instanceof Error ? error.message : "Failed to fetch sessions",
        });
      }
    },
    spawnSession: async (transport, request) => {
      set({ error: null });

      try {
        const session = await transport.request<Session>("spawn", request);
        const summary = await toSessionSummary(
          transport,
          session,
          fallbackTitleFromRequest(request),
        );

        set((state) => ({
          sessions: upsertSession(state.sessions, summary),
          selectedId: session.id,
          error: null,
        }));

        return session.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to spawn session";
        set({ error: message });
        throw error;
      }
    },
    stopSession: async (transport, sessionId) => {
      set({ error: null });

      try {
        await transport.request<void>("stop", { sessionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to stop session";
        set({ error: message });
        throw error;
      }
    },
    deleteSession: async (transport, sessionId) => {
      set({ error: null });

      try {
        await transport.request<void>("deleteSessions", { ids: [sessionId] });
        set((state) => ({
          sessions: state.sessions.filter((session) => session.id !== sessionId),
          selectedId: state.selectedId === sessionId ? null : state.selectedId,
          error: null,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete session";
        set({ error: message });
        throw error;
      }
    },
    handleSessionUpdated: (data) => {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === data.sessionId
            ? {
                ...session,
                status: session.status === data.status ? session.status : (data.status as Session["status"]),
              }
            : session,
        ),
      }));
    },
    handleSessionDeleted: (data) => {
      set((state) => ({
        sessions: state.sessions.filter((session) => session.id !== data.sessionId),
        selectedId: state.selectedId === data.sessionId ? null : state.selectedId,
      }));
    },
  };
}

export const createSessionStore = () => create<SessionState>((set) => createSessionState(set));

export const useSessionStore = createSessionStore();
