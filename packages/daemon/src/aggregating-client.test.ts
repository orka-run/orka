import { describe, it, expect, mock, beforeEach } from "bun:test";
import type {
  OrkaService,
  SessionDetailResponse,
  SessionListResponse,
  SessionSummary,
  SpawnResult,
  UsageSummary,
} from "@orka/core";
import type { RemoteNodeManager, RemoteNodeHandle } from "./remote-nodes";
import type { SessionCache } from "./session-cache";
import { createAggregatingClient } from "./aggregating-client";

// --- Helper to access mock calls without `as any` ---

/** Extract the mock calls array from a mock function. */
function mockCalls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

/** Replace the implementation of a mock function. */
function mockImpl(fn: unknown, impl: (...args: unknown[]) => unknown): void {
  (fn as { mockImplementation: (impl: (...args: unknown[]) => unknown) => void }).mockImplementation(impl);
}

// --- Mock Factories ---

function mockDetailResponse(overrides: Partial<SessionDetailResponse> = {}): SessionDetailResponse {
  return {
    id: overrides.id ?? "sess-local-1",
    status: "completed",
    allowedActions: [],
    backend: "claude-code",

    title: "test session",
    model: null,
    prompt: "",
    projectPath: "/proj",
    workingDir: "/work",
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:01Z",
    finishedAt: "2026-01-01T00:01:00Z",
    exitCode: 0,
    kept: false,
    autoMerge: false,
    parentSessionId: null,
    systemPrompt: null,
    allowedTools: null,
    permissionMode: null,
    archivedAt: null,
    providerSessionId: null,
    noWorktree: false,
    tags: [],
    ...overrides,
  };
}

function mockListResponse(overrides: Partial<SessionListResponse> = {}): SessionListResponse {
  return {
    id: overrides.id ?? "sess-local-1",
    status: "completed",
    allowedActions: [],
    backend: "claude-code",
    title: "test session",
    model: null,
    prompt: "",
    projectPath: "/proj",
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:01Z",
    finishedAt: "2026-01-01T00:01:00Z",
    exitCode: 0,
    kept: false,
    autoMerge: false,
    parentSessionId: null,
    permissionMode: null,
    noWorktree: false,
    tags: [],
    eventCount: 0,
    ...overrides,
  };
}

function mockSpawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    id: overrides.id ?? "sess-new-local",
    status: "queued",
    title: "new session",
    ...overrides,
  };
}

function mockSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: overrides.id ?? "sess-remote-1",
    status: "running",
    backend: "claude-code",
    title: "test session",
    createdAt: "2026-01-02T00:00:00Z",
    nodeId: "node-1",
    ...overrides,
  };
}

function createMockLocalClient(): OrkaService {
  return {
    spawn: mock(async () => mockSpawnResult()),
    closeSession: mock(async () => {}),
    stop: mock(async () => {}),
    reap: mock(async () => 0),
    getSession: mock(async (id) =>
      id.startsWith("sess-local") ? mockDetailResponse({ id }) : null,
    ),
    listSessions: mock(async () => [
      mockListResponse({ id: "sess-local-1" }),
      mockListResponse({ id: "sess-local-2", createdAt: "2026-01-03T00:00:00Z" }),
    ]),
    getChildSessions: mock(async () => []),
    getTask: mock(async () => null),
    setKept: mock(async () => {}),
    getTags: mock(async () => ["tag1"]),
    getResult: mock(async () => null),
    getSessionTimeline: mock(async () => ({ events: [], total: 0 })),
    getChatMessages: mock(async () => []),
    getUsage: mock(async () => ({
      totalCostUsd: 1.0,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheReadTokens: 0,
      sessionCount: 2,
      byBackend: {
        claude: { cost: 1.0, inputTokens: 100, outputTokens: 50, sessions: 2 },
      },
    })),
    captureOutput: mock(async () => "output"),
    getLogContent: mock(async () => "log"),
    isAlive: mock(async () => true),
    sendTurn: mock(async () => {}),
    getCheckpoints: mock(async () => []),
    getTurnDiff: mock(async () => ({ diff: "" })),
    revertToCheckpoint: mock(async () => {}),
    getDiff: mock(async () => ({ status: "clean", diff: "" })),
    merge: mock(async () => ({ branch: "main", commits: 1, cleaned: true })),
    startPairing: mock(async () => ({
      enrollId: "e1",
      pairingCode: "code",
      expiresAt: 0,
    })),
    deleteSessions: mock(async () => {}),
    pruneSessions: mock(async () => ({
      pruned: 0,
      orphansCleaned: 0,
      dryRun: true,
    })),
    archiveSession: mock(async () => {}),
    unarchiveSession: mock(async () => {}),
    getPendingApprovals: mock(async () => []),
    resolveApproval: mock(async () => {}),
    reportEventGap: mock(async () => {}),
    backfillSession: mock(async () => ({ eventsReplayed: 0 })),
    listNodes: mock(async () => [
      { id: "local", status: "online" as const, activeRequests: 0, registeredAt: 0 },
    ]),
    getMetrics: mock(async () => null),
    queryTraces: mock(async () => []),
    terminalOpen: mock(async () => ({ termId: "term-local-1" })),
    terminalWrite: mock(async () => {}),
    terminalResize: mock(async () => {}),
    terminalClose: mock(async () => {}),
    terminalList: mock(async () => []),
    pairWithNode: mock(async () => ({
      nodeId: "node-1",
      nodeName: "Remote Node",
      relayUrl: "wss://relay.example.com",
      nodePaths: [],
      connected: false,
    })),
    listPairedNodes: mock(async () => []),
    removePairedNode: mock(async () => {}),
    connectNode: mock(async () => {}),
    disconnectNode: mock(async () => {}),
    listWorkspaces: mock(async () => []),
    getWorkspace: mock(async () => ({ id: "ws-1" } as unknown as ReturnType<OrkaService["getWorkspace"]> extends Promise<infer R> ? R : never)),
    createWorkspace: mock(async () => ({ id: "ws-1" } as unknown as ReturnType<OrkaService["createWorkspace"]> extends Promise<infer R> ? R : never)),
    updateWorkspace: mock(async () => {}),
    deleteWorkspace: mock(async () => {}),
    addWorkspacePath: mock(async () => {}),
    removeWorkspacePath: mock(async () => {}),
  } as unknown as OrkaService;
}

function createMockRemoteNodes(): RemoteNodeManager & {
  _pushHandlers: Map<string, Map<string, Array<(data: unknown) => void>>>;
} {
  const pushHandlers = new Map<
    string,
    Map<string, Array<(data: unknown) => void>>
  >();
  const requestMock = mock(async () => null);

  return {
    _pushHandlers: pushHandlers,
    connect: mock(async () => {}),
    disconnect: mock(() => {}),
    getHandle: mock((nodeId: string): RemoteNodeHandle | null => {
      if (nodeId === "node-1") {
        return {
          nodeId: "node-1",
          transport: null as unknown as RemoteNodeHandle["transport"],
          status: "connected",
          lastConnected: Date.now(),
          lastError: null,
        };
      }
      if (nodeId === "node-offline") {
        return {
          nodeId: "node-offline",
          transport: null as unknown as RemoteNodeHandle["transport"],
          status: "disconnected",
          lastConnected: null,
          lastError: "connection lost",
        };
      }
      return null;
    }),
    listHandles: mock((): RemoteNodeHandle[] => [
      {
        nodeId: "node-1",
        transport: null as unknown as RemoteNodeHandle["transport"],
        status: "connected",
        lastConnected: Date.now(),
        lastError: null,
      },
    ]),
    request: requestMock as unknown as RemoteNodeManager["request"],
    subscribePush: mock(
      (nodeId: string, channel: string, handler: (data: unknown) => void) => {
        let nodeHandlers = pushHandlers.get(nodeId);
        if (!nodeHandlers) {
          nodeHandlers = new Map();
          pushHandlers.set(nodeId, nodeHandlers);
        }
        let handlers = nodeHandlers.get(channel);
        if (!handlers) {
          handlers = [];
          nodeHandlers.set(channel, handlers);
        }
        handlers.push(handler);
        return () => {
          if (!handlers) return;
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        };
      },
    ),
    shutdown: mock(() => {}),
  };
}

function createMockSessionCache(): SessionCache {
  const nodeMap = new Map<string, Map<string, SessionSummary>>();
  const sessionToNode = new Map<string, string>();

  return {
    setNodeSessions(nodeId, sessions) {
      const existing = nodeMap.get(nodeId);
      if (existing) {
        for (const id of existing.keys()) sessionToNode.delete(id);
      }
      const m = new Map<string, SessionSummary>();
      for (const s of sessions) {
        m.set(s.id, s);
        sessionToNode.set(s.id, nodeId);
      }
      nodeMap.set(nodeId, m);
    },
    upsertSession(nodeId, session) {
      let m = nodeMap.get(nodeId);
      if (!m) {
        m = new Map();
        nodeMap.set(nodeId, m);
      }
      m.set(session.id, session);
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
      for (const m of nodeMap.values()) {
        for (const s of m.values()) result.push(s);
      }
      return result;
    },
    getOwningNode(sessionId) {
      return sessionToNode.get(sessionId) ?? null;
    },
    clearNode(nodeId) {
      const m = nodeMap.get(nodeId);
      if (m) {
        for (const id of m.keys()) sessionToNode.delete(id);
        nodeMap.delete(nodeId);
      }
    },
  };
}

// --- Tests ---

describe("AggregatingClient", () => {
  let local: OrkaService;
  let remote: ReturnType<typeof createMockRemoteNodes>;
  let cache: SessionCache;
  let svc: OrkaService;

  beforeEach(() => {
    local = createMockLocalClient();
    remote = createMockRemoteNodes();
    cache = createMockSessionCache();

    // Pre-populate cache with remote sessions
    cache.setNodeSessions("node-1", [
      mockSummary({ id: "sess-remote-1", status: "running" }),
      mockSummary({
        id: "sess-remote-2",
        status: "completed",
        createdAt: "2026-01-04T00:00:00Z",
      }),
    ]);

    svc = createAggregatingClient(local, remote, cache);
  });

  describe("listSessions", () => {
    it("merges local + cached remote sessions", async () => {
      const sessions = await svc.listSessions();
      const ids = sessions.map((s) => s.id);

      expect(ids).toContain("sess-local-1");
      expect(ids).toContain("sess-local-2");
      expect(ids).toContain("sess-remote-1");
      expect(ids).toContain("sess-remote-2");
      expect(sessions.length).toBe(4);
    });

    it("sorts by createdAt desc", async () => {
      const sessions = await svc.listSessions();
      for (let i = 1; i < sessions.length; i++) {
        const prev = sessions[i - 1];
        const curr = sessions[i];
        if (!prev || !curr) throw new Error("expected session");
        expect(prev.createdAt >= curr.createdAt).toBe(true);
      }
    });

    it("filters by status", async () => {
      const sessions = await svc.listSessions({ status: "running" });
      // Local mock returns completed sessions, remote has one running
      // The local client is called with the filter, so it returns whatever
      // the mock returns. We need to check that remote sessions are filtered.
      const remoteRunning = sessions.filter((s) => s.id.startsWith("sess-remote"));
      for (const s of remoteRunning) {
        expect(s.status).toBe("running");
      }
    });
  });

  describe("getSession", () => {
    it("routes to local for local sessions", async () => {
      // Session not in cache -> falls through to local
      const result = await svc.getSession("sess-local-1");
      expect(result).not.toBeNull();
      expect(mockCalls(local.getSession).length).toBeGreaterThan(0);
    });

    it("routes to remote for remote sessions", async () => {
      const remoteSession = mockDetailResponse({ id: "sess-remote-1" });
      mockImpl(remote.request, async (_nodeId: unknown, method: unknown) => {
        if (method === "getSession") return remoteSession;
        return null;
      });

      const result = await svc.getSession("sess-remote-1");
      expect(result).toEqual(remoteSession);
      expect(mockCalls(remote.request).length).toBeGreaterThan(0);
      const lastCall = mockCalls(remote.request).at(-1);
      if (!lastCall) throw new Error("expected call");
      expect(lastCall[0]).toBe("node-1");
      expect(lastCall[1]).toBe("getSession");
    });
  });

  describe("spawn", () => {
    it("routes to remote node when nodeId specified", async () => {
      const remoteResult = mockSpawnResult({ id: "sess-spawned-remote" });
      mockImpl(remote.request, async () => remoteResult);

      const result = await svc.spawn({
        prompt: "test",
        projectPath: "/proj",
        backend: "claude-code",

        nodeId: "node-1",
      });

      expect(result.id).toBe("sess-spawned-remote");
      const lastCall = mockCalls(remote.request).at(-1);
      if (!lastCall) throw new Error("expected call");
      expect(lastCall[0]).toBe("node-1");
      expect(lastCall[1]).toBe("spawn");
    });

    it("goes to local without nodeId", async () => {
      const result = await svc.spawn({
        prompt: "test",
        projectPath: "/proj",
        backend: "claude-code",

      });

      expect(result.id).toBe("sess-new-local");
      expect(mockCalls(local.spawn).length).toBe(1);
    });

    it("goes to local when nodeId is 'local'", async () => {
      const result = await svc.spawn({
        prompt: "test",
        projectPath: "/proj",
        backend: "claude-code",

        nodeId: "local",
      });

      expect(result.id).toBe("sess-new-local");
      expect(mockCalls(local.spawn).length).toBe(1);
    });
  });

  describe("stop", () => {
    it("routes to owning node", async () => {
      mockImpl(remote.request, async () => null);

      await svc.stop("sess-remote-1");

      const lastCall = mockCalls(remote.request).at(-1);
      if (!lastCall) throw new Error("expected call");
      expect(lastCall[0]).toBe("node-1");
      expect(lastCall[1]).toBe("stop");
    });

    it("routes to local when session not in cache", async () => {
      await svc.stop("sess-local-1");
      expect(mockCalls(local.stop).length).toBe(1);
    });
  });

  describe("error handling", () => {
    it("throws NODE_UNREACHABLE for disconnected remote node", async () => {
      cache.upsertSession("node-offline", mockSummary({ id: "sess-offline-1" }));

      try {
        await svc.getSession("sess-offline-1");
        expect(true).toBe(false); // should not reach
      } catch (err: unknown) {
        const e = err as { code: string; nodeId: string };
        expect(e.code).toBe("NODE_UNREACHABLE");
        expect(e.nodeId).toBe("node-offline");
      }
    });
  });

  describe("getUsage", () => {
    it("aggregates local + remote when no sessionId", async () => {
      const remoteUsage: UsageSummary = {
        totalCostUsd: 2.0,
        totalInputTokens: 200,
        totalOutputTokens: 100,
        totalCacheReadTokens: 10,
        sessionCount: 3,
        byBackend: {
          claude: {
            cost: 2.0,
            inputTokens: 200,
            outputTokens: 100,
            sessions: 3,
          },
        },
      };
      mockImpl(remote.request, async () => remoteUsage);

      const result = await svc.getUsage();
      expect(result.totalCostUsd).toBe(3.0);
      expect(result.totalInputTokens).toBe(300);
      expect(result.sessionCount).toBe(5);
      const claudeBucket = result.byBackend["claude"];
      if (!claudeBucket) throw new Error("expected claude bucket");
      expect(claudeBucket.sessions).toBe(5);
    });

    it("routes to owning node when sessionId specified", async () => {
      const remoteUsage: UsageSummary = {
        totalCostUsd: 0.5,
        totalInputTokens: 50,
        totalOutputTokens: 25,
        totalCacheReadTokens: 0,
        sessionCount: 1,
        byBackend: {},
      };
      mockImpl(remote.request, async () => remoteUsage);

      const result = await svc.getUsage({ sessionId: "sess-remote-1" });
      expect(result.totalCostUsd).toBe(0.5);
    });
  });

  describe("listNodes", () => {
    it("merges local + remote node info", async () => {
      const nodes = await svc.listNodes();
      expect(nodes.length).toBe(2);
      expect(nodes.find((n) => n.id === "local")).toBeTruthy();
      expect(nodes.find((n) => n.id === "node-1")).toBeTruthy();
    });
  });

  describe("local-only methods", () => {
    it("reap delegates to local", async () => {
      await svc.reap();
      expect(mockCalls(local.reap).length).toBe(1);
    });

    it("pruneSessions delegates to local", async () => {
      await svc.pruneSessions({
        maxAgeMs: 86400000,
        confirm: false,
      });
      expect(mockCalls(local.pruneSessions).length).toBe(1);
    });

    it("getMetrics delegates to local", async () => {
      await svc.getMetrics();
      expect(mockCalls(local.getMetrics).length).toBe(1);
    });

    it("startPairing delegates to local", async () => {
      await svc.startPairing({});
      expect(mockCalls(local.startPairing).length).toBe(1);
    });
  });

  describe("deleteSessions", () => {
    it("routes each ID to owning node", async () => {
      mockImpl(remote.request, async () => null);

      await svc.deleteSessions(["sess-local-1", "sess-remote-1"]);

      // Local should get sess-local-1
      const localCalls = mockCalls(local.deleteSessions);
      expect(localCalls.length).toBe(1);
      const firstLocalCall = localCalls[0];
      if (!firstLocalCall) throw new Error("expected call");
      expect(firstLocalCall[0]).toEqual(["sess-local-1"]);

      // Remote should get sess-remote-1
      const remoteCalls = mockCalls(remote.request);
      const deleteCall = remoteCalls.find(
        (c: unknown[]) => c[1] === "deleteSessions",
      );
      expect(deleteCall).toBeTruthy();
      if (!deleteCall) throw new Error("expected deleteCall");
      expect((deleteCall[2] as Record<string, unknown>)["ids"]).toEqual(["sess-remote-1"]);
    });
  });

  describe("terminal routing", () => {
    it("tracks terminal node ownership", async () => {
      // Open a terminal on a remote session
      mockImpl(remote.request, async () => ({
        termId: "term-remote-1",
      }));

      const { termId } = await svc.terminalOpen("sess-remote-1");
      expect(termId).toBe("term-remote-1");

      // Write to it -- should route to the same remote node
      mockImpl(remote.request, async () => null);
      await svc.terminalWrite("term-remote-1", "hello");

      const writeCalls = mockCalls(remote.request).filter(
        (c: unknown[]) => c[1] === "terminalWrite",
      );
      expect(writeCalls.length).toBe(1);
      const firstWriteCall = writeCalls[0];
      if (!firstWriteCall) throw new Error("expected call");
      expect(firstWriteCall[0]).toBe("node-1");
    });
  });

  describe("push subscription", () => {
    it("subscribes to sessionUpdated on init", () => {
      const handlers =
        remote._pushHandlers.get("node-1")?.get("orchestration.sessionUpdated");
      if (!handlers) throw new Error("expected handlers");
      expect(handlers.length).toBeGreaterThan(0);
    });

    it("subscribes to sessionDeleted on init", () => {
      const handlers =
        remote._pushHandlers.get("node-1")?.get("orchestration.sessionDeleted");
      if (!handlers) throw new Error("expected handlers");
      expect(handlers.length).toBeGreaterThan(0);
    });

    it("updates cache on sessionUpdated push", async () => {
      const handlers =
        remote._pushHandlers
          .get("node-1")
          ?.get("orchestration.sessionUpdated");

      if (!handlers || !handlers[0]) throw new Error("expected handler");
      // Simulate push event for a new session
      handlers[0]({
        sessionId: "sess-remote-new",
        status: "running",
        backend: "claude",
        title: "new session",
        createdAt: "2026-01-05T00:00:00Z",
      });

      // Should now appear in listSessions
      const sessions = await svc.listSessions();
      expect(sessions.find((s) => s.id === "sess-remote-new")).toBeTruthy();
    });

    it("removes from cache on sessionDeleted push", async () => {
      const handlers =
        remote._pushHandlers
          .get("node-1")
          ?.get("orchestration.sessionDeleted");

      if (!handlers || !handlers[0]) throw new Error("expected handler");
      handlers[0]({ sessionId: "sess-remote-1" });

      expect(cache.getOwningNode("sess-remote-1")).toBeNull();
    });
  });
});
