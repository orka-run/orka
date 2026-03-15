import type { SessionSummary } from "@orka/core";

export interface SessionCache {
  /** Replace all sessions for a node. Called on initial fetch. */
  setNodeSessions(nodeId: string, sessions: SessionSummary[]): void;
  /** Update a single session (from push event). */
  upsertSession(nodeId: string, session: SessionSummary): void;
  /** Remove a session (from deletion push). */
  removeSession(sessionId: string): void;
  /** Get all cached sessions across all nodes. */
  getAllSessions(): SessionSummary[];
  /** Look up which node owns a session. */
  getOwningNode(sessionId: string): string | null;
  /** Clear cache for a node (on disconnect). */
  clearNode(nodeId: string): void;
}

export function createSessionCache(): SessionCache {
  // nodeId -> (sessionId -> SessionSummary)
  const nodeMap = new Map<string, Map<string, SessionSummary>>();
  // sessionId -> nodeId (reverse lookup)
  const sessionToNode = new Map<string, string>();

  return {
    setNodeSessions(nodeId, sessions) {
      // Clear existing entries for this node
      const existing = nodeMap.get(nodeId);
      if (existing) {
        for (const sessionId of existing.keys()) {
          sessionToNode.delete(sessionId);
        }
      }

      const sessMap = new Map<string, SessionSummary>();
      for (const session of sessions) {
        sessMap.set(session.id, session);
        sessionToNode.set(session.id, nodeId);
      }
      nodeMap.set(nodeId, sessMap);
    },

    upsertSession(nodeId, session) {
      let sessMap = nodeMap.get(nodeId);
      if (!sessMap) {
        sessMap = new Map();
        nodeMap.set(nodeId, sessMap);
      }
      sessMap.set(session.id, session);
      sessionToNode.set(session.id, nodeId);
    },

    removeSession(sessionId) {
      const nodeId = sessionToNode.get(sessionId);
      if (nodeId) {
        nodeMap.get(nodeId)?.delete(sessionId);
        sessionToNode.delete(sessionId);
      }
    },

    getAllSessions() {
      const result: SessionSummary[] = [];
      for (const sessMap of nodeMap.values()) {
        for (const session of sessMap.values()) {
          result.push(session);
        }
      }
      return result;
    },

    getOwningNode(sessionId) {
      return sessionToNode.get(sessionId) ?? null;
    },

    clearNode(nodeId) {
      const sessMap = nodeMap.get(nodeId);
      if (sessMap) {
        for (const sessionId of sessMap.keys()) {
          sessionToNode.delete(sessionId);
        }
        nodeMap.delete(nodeId);
      }
    },
  };
}
