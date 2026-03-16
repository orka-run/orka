import type { Session, SessionListItem, SpawnRequest, SpawnResult } from "@orka/core";
import type { SessionDeletedData, SessionUpdatedData } from "@orka/core";
import { create } from "zustand";
import type { RequestOptions } from "../lib/wsTransport";
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
  nodeId: string | null;
}

export interface SessionState {
  sessions: SessionSummary[];
  selectedId: string | null;
  isLoading: boolean;
  error: string | null;
  selectSession: (id: string | null) => void;
  /** Fetch sessions. If nodeIds provided, fetches from each node in parallel and tags results. */
  fetchSessions: (transport: WsTransport, nodeIds?: string[]) => Promise<void>;
  spawnSession: (transport: WsTransport, request: SpawnRequest) => Promise<string>;
  stopSession: (transport: WsTransport, sessionId: string) => Promise<void>;
  deleteSession: (transport: WsTransport, sessionId: string) => Promise<void>;
  handleSessionUpdated: (data: SessionUpdatedData) => void;
  handleSessionDeleted: (data: SessionDeletedData) => void;
}

function toSessionSummary(
  session: SessionListItem,
  options?: { fallbackTitle?: string; nodeId?: string },
): SessionSummary {
  const title = options?.fallbackTitle ?? session.title ?? session.id;

  return {
    id: session.id,
    taskId: session.taskId,
    status: session.status,
    backend: session.backend,
    mode: session.mode,
    title,
    model: session.model ?? null,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    exitCode: session.exitCode,
    projectPath: session.projectPath,
    workingDir: session.workingDir,
    kept: session.kept,
    autoMerge: session.autoMerge,
    prompt: session.prompt ?? null,
    nodeId: options?.nodeId ?? null,
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
    fetchSessions: async (transport, nodeIds?) => {
      set({ isLoading: true, error: null });

      try {
        let allSummaries: SessionSummary[];

        if (nodeIds && nodeIds.length > 0) {
          // Multi-node: fetch from each node in parallel, tag with nodeId
          const results = await Promise.all(
            nodeIds.map(async (nodeId) => {
              const reqOpts: RequestOptions = { node: nodeId };
              const sessions = await transport.request<SessionListItem[]>("listSessions", undefined, reqOpts);
              return sessions.map((session) => toSessionSummary(session, { nodeId }));
            }),
          );
          allSummaries = results.flat();
        } else {
          const sessions = await transport.request<SessionListItem[]>("listSessions");
          allSummaries = sessions.map((session) => toSessionSummary(session));
        }

        set((state) => ({
          sessions: sortSessions(allSummaries),
          selectedId: state.selectedId && allSummaries.some((session) => session.id === state.selectedId)
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
        const reqOpts: RequestOptions | undefined = request.nodeId ? { node: request.nodeId } : undefined;
        const result = await transport.request<SpawnResult>("spawn", request, reqOpts);

        // Build a minimal summary from SpawnResult + request data.
        // The next fetchSessions will fill in the full SessionListItem fields.
        const summary: SessionSummary = {
          id: result.id,
          taskId: "",
          status: result.status,
          backend: request.backend,
          mode: request.mode,
          title: result.title || fallbackTitleFromRequest(request) || result.id,
          model: request.model ?? null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          exitCode: null,
          projectPath: request.projectPath,
          workingDir: "",
          kept: false,
          autoMerge: request.autoMerge ?? false,
          prompt: request.prompt,
          nodeId: request.nodeId ?? null,
        };

        set((state) => ({
          sessions: upsertSession(state.sessions, summary),
          selectedId: result.id,
          error: null,
        }));

        return result.id;
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
