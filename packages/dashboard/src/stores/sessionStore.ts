import type { Session, SessionAction, SessionListResponse, SpawnRequest } from "@orka/core";
import type { SessionDeletedData, SessionUpdatedData } from "@orka/core";
import { create } from "zustand";
import type { RpcClient } from "../lib/rpcClient";

const FALLBACK_TITLE_LENGTH = 80;
const SELECTED_SESSION_KEY = "orka:selectedSession";

export type SessionSummary = SessionListResponse & { nodeId: string | null };

export interface SessionState {
  sessions: SessionSummary[];
  selectedId: string | null;
  isLoading: boolean;
  error: string | null;
  /** Global push sequence from the last snapshot — used for reconnect dedup. */
  snapshotSequence: number;
  selectSession: (id: string | null) => void;
  /** Fetch sessions. If nodeIds provided, fetches from each node in parallel and tags results. */
  fetchSessions: (client: RpcClient, nodeIds?: string[]) => Promise<void>;
  spawnSession: (client: RpcClient, request: SpawnRequest) => Promise<string>;
  stopSession: (client: RpcClient, sessionId: string) => Promise<void>;
  deleteSession: (client: RpcClient, sessionId: string) => Promise<void>;
  handleSessionUpdated: (data: SessionUpdatedData) => void;
  handleSessionDeleted: (data: SessionDeletedData) => void;
}

function toSessionSummary(
  session: SessionListResponse,
  options?: { fallbackTitle?: string; nodeId?: string },
): SessionSummary {
  return {
    ...session,
    title: options?.fallbackTitle ?? session.title,
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

/**
 * Merge a fresh snapshot into existing sessions — upsert changed, remove deleted.
 * Avoids replacing the entire array so React can skip re-rendering unchanged items.
 */
function mergeSessions(existing: SessionSummary[], incoming: SessionSummary[]): SessionSummary[] {
  const incomingById = new Map(incoming.map((s) => [s.id, s]));
  const merged: SessionSummary[] = [];

  // Update existing sessions that are still present in the snapshot
  for (const session of existing) {
    const fresh = incomingById.get(session.id);
    if (fresh) {
      merged.push(fresh);
      incomingById.delete(session.id);
    }
    // Session not in snapshot → deleted, skip it
  }

  // Add new sessions from the snapshot that weren't in existing
  for (const session of incomingById.values()) {
    merged.push(session);
  }

  return sortSessions(merged);
}

function createSessionState(set: (partial: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>)) => void): SessionState {
  return {
    sessions: [],
    selectedId: null,
    isLoading: false,
    error: null,
    snapshotSequence: 0,
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
    fetchSessions: async (client, nodeIds?) => {
      // Only show loading spinner when there are no cached sessions (stale-while-revalidate)
      set((state) => ({ isLoading: state.sessions.length === 0, error: null }));

      try {
        let allSummaries: SessionSummary[];
        let nextSnapshotSequence = 0;

        if (nodeIds && nodeIds.length > 0) {
          // Multi-node: fetch from each node in parallel, tag with nodeId
          const results = await Promise.all(
            nodeIds.map(async (nodeId) => {
              const sessions = await client.listSessions(undefined, { node: nodeId });
              return sessions.map((session) => toSessionSummary(session, { nodeId }));
            }),
          );
          allSummaries = results.flat();
        } else {
          const snapshot = await client.listSessionsSnapshot();
          allSummaries = snapshot.sessions.map((session) => toSessionSummary(session));
          nextSnapshotSequence = snapshot.snapshotSequence;
        }

        set((state) => {
          // Merge instead of replace — keeps existing data stable while updating
          const merged = mergeSessions(state.sessions, allSummaries);
          return {
            sessions: merged,
            selectedId: state.selectedId && merged.some((session) => session.id === state.selectedId)
              ? state.selectedId
              : null,
            snapshotSequence: Math.max(state.snapshotSequence, nextSnapshotSequence),
            isLoading: false,
            error: null,
          };
        });
      } catch (error) {
        set({
          isLoading: false,
          error: error instanceof Error ? error.message : "Failed to fetch sessions",
        });
      }
    },
    spawnSession: async (client, request) => {
      set({ error: null });

      try {
        const reqOpts = request.nodeId ? { node: request.nodeId } : undefined;
        const result = await client.spawn(request, reqOpts);

        // Build a minimal summary from SpawnResult + request data.
        // The next fetchSessions will fill in the full SessionListItem fields.
        const allowedActions: SessionAction[] = ["sendTurn", "stop"];
        const summary: SessionSummary = {
          id: result.id,
          status: result.status,
          backend: request.backend,
          title: result.title || fallbackTitleFromRequest(request) || result.id,
          model: request.model ?? null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          exitCode: null,
          projectPath: request.projectPath,
          kept: false,
          autoMerge: request.autoMerge ?? false,
          noWorktree: request.noWorktree ?? false,
          prompt: request.prompt,
          parentSessionId: request.parentSessionId ?? null,
          permissionMode: request.permissionMode ?? null,
          // SpawnRequest.tags is optional — fallback to empty array for the optimistic summary
          tags: request.tags ?? [],
          eventCount: 0,
          nodeId: request.nodeId ?? null,
          allowedActions,
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
    stopSession: async (client, sessionId) => {
      set({ error: null });

      try {
        await client.stop(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to stop session";
        set({ error: message });
        throw error;
      }
    },
    deleteSession: async (client, sessionId) => {
      set({ error: null });

      try {
        await client.deleteSessions([sessionId]);
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
