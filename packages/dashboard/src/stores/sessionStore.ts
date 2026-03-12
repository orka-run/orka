import type { Session, SpawnRequest, Task } from "@orka/core";
import type { SessionDeletedData, SessionUpdatedData } from "@orka/core";
import { create } from "zustand";
import { WsTransport } from "../lib/wsTransport";

const FALLBACK_TITLE_LENGTH = 80;
const SELECTED_SESSION_KEY = "orka:selectedSession";

export interface SessionSummary {
  id: string;
  taskId: string;
  status: Session["status"];
  backend: Session["backend"];
  mode: Session["mode"];
  title: string;
  model: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  projectPath: string;
  workingDir: string;
  kept: boolean;
  autoMerge: boolean;
  prompt: string | null;
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

interface TaskDetails {
  title: string | null;
  model: string | null;
  prompt: string | null;
}

async function getTaskDetails(transport: WsTransport, taskId: string): Promise<TaskDetails> {
  try {
    const task = await transport.request<Task | null>("getTask", { id: taskId });
    return {
      title: task?.title ?? null,
      model: task?.model ?? null,
      prompt: task?.prompt ?? null,
    };
  } catch {
    return {
      title: null,
      model: null,
      prompt: null,
    };
  }
}

async function toSessionSummary(
  transport: WsTransport,
  session: Session,
  fallbackTitle?: string,
): Promise<SessionSummary> {
  const taskDetails = await getTaskDetails(transport, session.taskId);
  const title = fallbackTitle ?? taskDetails.title ?? session.id;

  return {
    id: session.id,
    taskId: session.taskId,
    status: session.status,
    backend: session.backend,
    mode: session.mode,
    title,
    model: taskDetails.model,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    exitCode: session.exitCode,
    projectPath: session.projectPath,
    workingDir: session.workingDir,
    kept: session.kept,
    autoMerge: session.autoMerge,
    prompt: taskDetails.prompt,
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

function clearSelectedStorage(): void {
  try {
    localStorage.removeItem(SELECTED_SESSION_KEY);
  } catch {
    // localStorage unavailable
  }
}

function createSessionState(set: (partial: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>)) => void): SessionState {
  return {
    sessions: [],
    selectedId: null,
    isLoading: false,
    error: null,
    selectSession: (id) => {
      set({ selectedId: id });
      try {
        if (id != null) {
          localStorage.setItem(SELECTED_SESSION_KEY, id);
        } else {
          localStorage.removeItem(SELECTED_SESSION_KEY);
        }
      } catch {
        // localStorage unavailable
      }
    },
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
        await transport.request("stop", { sessionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to stop session";
        set({ error: message });
        throw error;
      }
    },
    deleteSession: async (transport, sessionId) => {
      set({ error: null });

      try {
        await transport.request("deleteSessions", { ids: [sessionId] });
        set((state) => {
          const wasSelected = state.selectedId === sessionId;
          if (wasSelected) clearSelectedStorage();
          return {
            sessions: state.sessions.filter((session) => session.id !== sessionId),
            selectedId: wasSelected ? null : state.selectedId,
            error: null,
          };
        });
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
      set((state) => {
        const wasSelected = state.selectedId === data.sessionId;
        if (wasSelected) clearSelectedStorage();
        return {
          sessions: state.sessions.filter((session) => session.id !== data.sessionId),
          selectedId: wasSelected ? null : state.selectedId,
        };
      });
    },
  };
}

export { SELECTED_SESSION_KEY };
export const createSessionStore = () => create<SessionState>((set) => createSessionState(set));

export const useSessionStore = createSessionStore();
