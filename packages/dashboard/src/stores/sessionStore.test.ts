import type { SessionListResponse, SpawnRequest, SpawnResult } from "@orka/core";
import { describe, expect, test } from "bun:test";
import { createSessionStore } from "./sessionStore";
import type { SessionDeletedData, SessionUpdatedData } from "@orka/core";
import type { RpcClient } from "../lib/rpcClient";

class MockRpcClient {
  sessions: SessionListResponse[] = [];
  spawnResult: SpawnResult | null = null;
  spawnParams: SpawnRequest | null = null;

  listSessions = () => Promise.resolve(this.sessions);

  spawn = (req: SpawnRequest) => {
    if (!this.spawnResult) return Promise.reject(new Error("Missing spawn result"));
    this.spawnParams = req;
    return Promise.resolve(this.spawnResult);
  };

  stop = async () => {};

  deleteSessions = (ids: string[]) => {
    const idSet = new Set(ids);
    this.sessions = this.sessions.filter((session) => !idSet.has(session.id));
    return Promise.resolve();
  };
}

function asClient(mock: MockRpcClient): RpcClient {
  return mock as unknown as RpcClient;
}

function makeSession(overrides: Partial<SessionListResponse> = {}): SessionListResponse {
  return {
    id: "sess-1",
    status: "queued",
    backend: "codex",
    projectPath: "/tmp/project",
    createdAt: "2026-03-11T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    kept: false,
    autoMerge: false,
    title: "Dashboard task",
    model: null,
    prompt: "Build the dashboard session store",
    parentSessionId: null,
    permissionMode: null,
    noWorktree: false,
    tags: [],
    ...overrides,
  };
}

function makeSpawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    id: "sess-1",
    status: "queued",
    title: "Dashboard task",
    ...overrides,
  };
}

describe("sessionStore", () => {
  test("fetchSessions populates store", async () => {
    const store = createSessionStore();
    const transport = new MockRpcClient();
    transport.sessions = [makeSession({ title: "First session", model: "gpt-5", prompt: "Build the dashboard session store" })];

    await store.getState().fetchSessions(asClient(transport));

    expect(store.getState().sessions).toEqual([
      {
        id: "sess-1",
        status: "queued",
        backend: "codex",
            title: "First session",
        model: "gpt-5",
        createdAt: "2026-03-11T10:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        projectPath: "/tmp/project",
        kept: false,
        autoMerge: false,
        noWorktree: false,
        prompt: "Build the dashboard session store",
        parentSessionId: null,
        permissionMode: null,
        tags: [],
        nodeId: null,
      },
    ]);
    expect(store.getState().isLoading).toBe(false);
    expect(store.getState().error).toBeNull();
  });

  test("selectSession updates selectedId", () => {
    const store = createSessionStore();

    store.getState().selectSession("sess-2");

    expect(store.getState().selectedId).toBe("sess-2");
  });

  test("handleSessionUpdated updates matching session", () => {
    const store = createSessionStore();
    const session = makeSession();
    store.setState({
      sessions: [
        {
          id: session.id,
          status: session.status,
          backend: session.backend,
          title: "First session",
          model: "gpt-5",
          createdAt: session.createdAt,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          exitCode: session.exitCode,
          projectPath: session.projectPath,
          kept: session.kept,
          autoMerge: session.autoMerge,
          noWorktree: session.noWorktree,
          prompt: null,
          parentSessionId: null,
          permissionMode: null,
          tags: [],
          nodeId: null,
        },
      ],
    });

    const update: SessionUpdatedData = { sessionId: "sess-1", status: "running" };
    store.getState().handleSessionUpdated(update);

    expect(store.getState().sessions[0]?.status).toBe("running");
  });

  test("handleSessionDeleted removes session", () => {
    const store = createSessionStore();
    const session = makeSession();
    store.setState({
      sessions: [
        {
          id: session.id,
          status: session.status,
          backend: session.backend,
          title: "First session",
          model: "gpt-5",
          createdAt: session.createdAt,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          exitCode: session.exitCode,
          projectPath: session.projectPath,
          kept: session.kept,
          autoMerge: session.autoMerge,
          noWorktree: session.noWorktree,
          prompt: null,
          parentSessionId: null,
          permissionMode: null,
          tags: [],
          nodeId: null,
        },
      ],
      selectedId: session.id,
    });

    const update: SessionDeletedData = { sessionId: "sess-1" };
    store.getState().handleSessionDeleted(update);

    expect(store.getState().sessions).toEqual([]);
    expect(store.getState().selectedId).toBeNull();
  });

  test("spawnSession adds new session", async () => {
    const store = createSessionStore();
    const transport = new MockRpcClient();
    transport.spawnResult = makeSpawnResult({
      id: "sess-2",
      status: "queued",
      title: "Ship dashboard store",
    });

    const request: SpawnRequest = {
      prompt: "Ship the Zustand dashboard store",
      title: "Ship dashboard store",
      projectPath: "/tmp/project",
      backend: "codex",
      model: "gpt-5",
      autoMerge: true,
      noWorktree: true,
      tags: ["dashboard", "polish"],
      systemPrompt: "Keep the response concise and implementation-focused.",
    };

    const sessionId = await store.getState().spawnSession(asClient(transport), request);

    expect(sessionId).toBe("sess-2");
    expect(transport.spawnParams).toEqual(request);

    const sessions = store.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("sess-2");
    expect(sessions[0].status).toBe("queued");
    expect(sessions[0].backend).toBe("codex");
    expect(sessions[0].title).toBe("Ship dashboard store");
    expect(sessions[0].model).toBe("gpt-5");
    expect(sessions[0].projectPath).toBe("/tmp/project");
    expect(sessions[0].autoMerge).toBe(true);
    expect(sessions[0].noWorktree).toBe(true);
    expect(sessions[0].nodeId).toBeNull();
    expect(store.getState().selectedId).toBe("sess-2");
  });
});
