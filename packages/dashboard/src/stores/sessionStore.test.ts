import type { Session, SpawnRequest, Task } from "@orka/core";
import { describe, expect, test } from "bun:test";
import { createSessionStore } from "./sessionStore";
import type { SessionDeletedData, SessionUpdatedData } from "@orka/core";
import type { WsTransport } from "../lib/wsTransport";

class MockWsTransport {
  sessions: Session[] = [];
  tasks = new Map<string, Task>();
  spawnResult: Session | null = null;

  async request<T>(method: string, params?: unknown): Promise<T> {
    switch (method) {
      case "listSessions":
        return this.sessions as T;
      case "getTask": {
        const taskId = (params as { id: string }).id;
        return (this.tasks.get(taskId) ?? null) as T;
      }
      case "spawn":
        if (!this.spawnResult) {
          throw new Error("Missing spawn result");
        }
        return this.spawnResult as T;
      case "stop":
        return undefined as T;
      case "deleteSessions": {
        const ids = new Set((params as { ids: string[] }).ids);
        this.sessions = this.sessions.filter((session) => !ids.has(session.id));
        return undefined as T;
      }
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  }
}

function asTransport(transport: MockWsTransport): WsTransport {
  return transport as unknown as WsTransport;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    taskId: "task-1",
    workspaceId: "workspace-1",
    status: "queued",
    backend: "codex",
    mode: "interactive",
    tmuxSessionName: "orka-sess-1",
    projectPath: "/tmp/project",
    workingDir: "/tmp/project",
    logFile: "/tmp/project/.orka/logs/sess-1.log",
    createdAt: "2026-03-11T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    kept: false,
    autoMerge: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Dashboard task",
    prompt: "Build the dashboard session store",
    backend: "codex",
    mode: "interactive",
    model: "gpt-5",
    createdAt: "2026-03-11T09:59:00.000Z",
    ...overrides,
  };
}

describe("sessionStore", () => {
  test("fetchSessions populates store", async () => {
    const store = createSessionStore();
    const transport = new MockWsTransport();
    transport.sessions = [makeSession()];
    transport.tasks.set("task-1", makeTask({ title: "First session" }));

    await store.getState().fetchSessions(asTransport(transport));

    expect(store.getState().sessions).toEqual([
      {
        id: "sess-1",
        taskId: "task-1",
        status: "queued",
        backend: "codex",
        mode: "interactive",
        title: "First session",
        model: "gpt-5",
        createdAt: "2026-03-11T10:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        projectPath: "/tmp/project",
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
          taskId: session.taskId,
          status: session.status,
          backend: session.backend,
          mode: session.mode,
          title: "First session",
          model: "gpt-5",
          createdAt: session.createdAt,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          exitCode: session.exitCode,
          projectPath: session.projectPath,
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
          taskId: session.taskId,
          status: session.status,
          backend: session.backend,
          mode: session.mode,
          title: "First session",
          model: "gpt-5",
          createdAt: session.createdAt,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          exitCode: session.exitCode,
          projectPath: session.projectPath,
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
    const transport = new MockWsTransport();
    transport.spawnResult = makeSession({
      id: "sess-2",
      taskId: "task-2",
      createdAt: "2026-03-11T11:00:00.000Z",
    });

    const request: SpawnRequest = {
      prompt: "Ship the Zustand dashboard store",
      title: "Ship dashboard store",
      projectPath: "/tmp/project",
      backend: "codex",
      mode: "interactive",
      model: "gpt-5",
    };

    const sessionId = await store.getState().spawnSession(asTransport(transport), request);

    expect(sessionId).toBe("sess-2");
    expect(store.getState().sessions).toEqual([
      {
        id: "sess-2",
        taskId: "task-2",
        status: "queued",
        backend: "codex",
        mode: "interactive",
        title: "Ship dashboard store",
        model: null,
        createdAt: "2026-03-11T11:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        projectPath: "/tmp/project",
      },
    ]);
    expect(store.getState().selectedId).toBe("sess-2");
  });
});
