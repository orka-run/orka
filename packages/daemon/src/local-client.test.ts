import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderSessionHandle } from "@orka/core";
import { createDaemonContext, type DaemonContext } from "./daemon-context";
import { createLocalClient } from "./local-client";

let testHome = "";
let ctx: DaemonContext;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "orka-local-client-test-"));
  mkdirSync(testHome, { recursive: true });
  ctx = await createDaemonContext(testHome, { inMemoryDb: true });
});

afterEach(() => {
  for (const handle of ctx.providerService.listActiveSessions()) {
    ctx.providerService.clearHandle(handle.threadId);
  }
  ctx.db.clearAllData();
});

afterAll(() => {
  ctx.db.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("LocalClient provider runtime support", () => {
  test("includes server-driven allowedActions in session responses", async () => {
    seedSession("sess-completed");
    seedSession("sess-idle", { status: "idle" });

    const handle: ProviderSessionHandle = {
      threadId: "sess-idle",
      provider: "codex",
      events: (async function* () {})(),
      meta: {},
    };
    const originalGetHandle = ctx.providerService.getHandle;
    (ctx.providerService as any).getHandle = (sessionId: string) => (sessionId === "sess-idle" ? handle : undefined);

    try {
      const client = createLocalClient(ctx);
      const completed = await client.getSession("sess-completed");
      const sessions = await client.listSessions();
      const idle = sessions.find((session) => session.id === "sess-idle");

      expect(completed?.allowedActions).toEqual(["sendTurn", "archive", "delete"]);
      expect(idle?.allowedActions).toEqual(["sendTurn", "stop"]);
    } finally {
      (ctx.providerService as any).getHandle = originalGetHandle;
    }
  });

  test("captures provider output and builds results from orchestration events", async () => {
    seedSession("sess-provider");
    seedProviderEvents("sess-provider");

    const client = createLocalClient(ctx);

    await expect(client.captureOutput("sess-provider")).resolves.toBe("Draft response.Final answer");

    const result = await client.getResult("sess-provider");
    expect(result).toEqual({
      result: "Final answer",
      isError: false,
      durationMs: 60_000,
      costUsd: 0.25,
      inputTokens: 17,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      model: "gpt-5",
      numTurns: 2,
    });

    expect(ctx.db.getUsageBySession("sess-provider")).toEqual([
      {
        sessionId: "sess-provider",
        backend: "codex",
        inputTokens: 17,
        outputTokens: 8,
        cacheReadTokens: 0,
        costUsd: 0.25,
        model: "gpt-5",
        recordedAt: "2026-01-01T00:02:00.000Z",
      },
    ]);
  });

  test("uses provider handles for liveness and idle-session input routing", async () => {
    seedSession("sess-live", { status: "idle" });

    const handle: ProviderSessionHandle = {
      threadId: "sess-live",
      provider: "codex",
      events: (async function* () {})(),
      meta: {},
    };

    const originalGetHandle = ctx.providerService.getHandle;
    const originalSendTurn = ctx.providerService.sendTurn;
    const originalBroadcast = ctx.pushHub.broadcast.bind(ctx.pushHub);
    const sendTurnCalls: Array<{ sessionId: string; input: { input: string } }> = [];
    const broadcasts: Array<{ channel: string; data: unknown }> = [];

    (ctx.providerService as any).getHandle = (sessionId: string) => (sessionId === "sess-live" ? handle : undefined);
    (ctx.providerService as any).sendTurn = async (sessionId: string, input: { input: string }) => {
      sendTurnCalls.push({ sessionId, input });
    };
    (ctx.pushHub as { broadcast: typeof ctx.pushHub.broadcast }).broadcast = ((channel: string, data: unknown) => {
      broadcasts.push({ channel, data });
    }) as typeof ctx.pushHub.broadcast;

    try {
      const client = createLocalClient(ctx);

      await expect(client.isAlive("sess-live")).resolves.toBe(true);
      await client.sendTurn("sess-live", "continue");

      expect(sendTurnCalls).toEqual([{ sessionId: "sess-live", input: { input: "continue" } }]);
      expect(ctx.db.getOrchestrationEvents("sess-live")).toContainEqual({
        v: 1,
        type: "user.input",
        sessionId: "sess-live",
        text: "continue",
        timestamp: expect.any(String),
      });
      expect(broadcasts).toHaveLength(2);
      expect(broadcasts[0]).toMatchObject({
        channel: "orchestration.sessionUpdated",
        data: {
          sessionId: "sess-live",
          status: "running",
        },
      });
      expect(broadcasts[1]).toMatchObject({
        channel: "orchestration.event",
        data: {
          v: 1,
          type: "user.input",
          sessionId: "sess-live",
          text: "continue",
        },
      });
    } finally {
      (ctx.providerService as any).getHandle = originalGetHandle;
      (ctx.providerService as any).sendTurn = originalSendTurn;
      (ctx.pushHub as { broadcast: typeof ctx.pushHub.broadcast }).broadcast = originalBroadcast;
    }
  });

  test("queues follow-up input while a session is running", async () => {
    seedSession("sess-live", { status: "running" });

    const handle: ProviderSessionHandle = {
      threadId: "sess-live",
      provider: "codex",
      events: (async function* () {})(),
      meta: {},
    };

    const originalGetHandle = ctx.providerService.getHandle;
    const originalSendTurn = ctx.providerService.sendTurn;
    const originalBroadcast = ctx.pushHub.broadcast.bind(ctx.pushHub);
    const sendTurnCalls: Array<{ sessionId: string; input: { input: string } }> = [];
    const broadcasts: Array<{ channel: string; data: unknown }> = [];

    (ctx.providerService as any).getHandle = (sessionId: string) => (sessionId === "sess-live" ? handle : undefined);
    (ctx.providerService as any).sendTurn = async (sessionId: string, input: { input: string }) => {
      sendTurnCalls.push({ sessionId, input });
    };
    (ctx.pushHub as { broadcast: typeof ctx.pushHub.broadcast }).broadcast = ((channel: string, data: unknown) => {
      broadcasts.push({ channel, data });
    }) as typeof ctx.pushHub.broadcast;

    try {
      const client = createLocalClient(ctx);

      await client.sendTurn("sess-live", "continue");

      expect(sendTurnCalls).toEqual([]);
      expect(ctx.sessionRuntime.pendingMessages.get("sess-live")).toEqual(["continue"]);
      expect(ctx.db.getOrchestrationEvents("sess-live")).toContainEqual({
        v: 1,
        type: "user.input",
        sessionId: "sess-live",
        text: "continue",
        queued: true,
        timestamp: expect.any(String),
      });
      expect(broadcasts).toEqual([
        {
          channel: "orchestration.event",
          data: {
            v: 1,
            type: "user.input",
            sessionId: "sess-live",
            text: "continue",
            queued: true,
            timestamp: expect.any(String),
          },
        },
      ]);
    } finally {
      (ctx.providerService as any).getHandle = originalGetHandle;
      (ctx.providerService as any).sendTurn = originalSendTurn;
      (ctx.pushHub as { broadcast: typeof ctx.pushHub.broadcast }).broadcast = originalBroadcast;
    }
  });
});

function seedSession(sessionId: string, overrides?: { status?: string }): void {
  ctx.db.insertTask({
    id: `task-${sessionId}`,
    title: `Task ${sessionId}`,
    prompt: "Fix the provider runtime path",
    backend: "codex",
    model: "gpt-5",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  ctx.db.insertSession({
    id: sessionId,
    taskId: `task-${sessionId}`,
    workspaceId: `ws-${sessionId}`,
    status: (overrides?.status ?? "completed") as any,
    backend: "codex",
    projectPath: "/tmp/project",
    workingDir: "/tmp/project",
    logFile: join(testHome, "logs", `${sessionId}.log`),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:01:00.000Z",
    finishedAt: "2026-01-01T00:02:00.000Z",
    exitCode: 0,
    kept: false,
    autoMerge: false,
  });
}

function seedProviderEvents(sessionId: string): void {
  ctx.db.insertOrchestrationEvent({
    eventId: `${sessionId}-turn-1-start`,
    provider: "codex",
    type: "turn.started",
    sessionId,
    turnId: "turn-1",
    timestamp: "2026-01-01T00:01:01.000Z",
  });
  ctx.db.insertOrchestrationEvent({
    eventId: `${sessionId}-turn-1-delta`,
    provider: "codex",
    type: "content.delta",
    sessionId,
    turnId: "turn-1",
    streamKind: "assistant_text",
    delta: "Draft response.",
    timestamp: "2026-01-01T00:01:10.000Z",
  });
  ctx.db.insertOrchestrationEvent({
    eventId: `${sessionId}-turn-1-complete`,
    provider: "codex",
    type: "turn.completed",
    sessionId,
    turnId: "turn-1",
    state: "completed",
    tokens: {
      input: 10,
      output: 5,
    },
    timestamp: "2026-01-01T00:01:20.000Z",
  });
  ctx.db.insertOrchestrationEvent({
    eventId: `${sessionId}-turn-2-start`,
    provider: "codex",
    type: "turn.started",
    sessionId,
    turnId: "turn-2",
    timestamp: "2026-01-01T00:01:30.000Z",
  });
  ctx.db.insertOrchestrationEvent({
    eventId: `${sessionId}-turn-2-delta-1`,
    provider: "codex",
    type: "content.delta",
    sessionId,
    turnId: "turn-2",
    streamKind: "assistant_text",
    delta: "Final ",
    timestamp: "2026-01-01T00:01:40.000Z",
  });
  ctx.db.insertOrchestrationEvent({
    eventId: `${sessionId}-turn-2-delta-2`,
    provider: "codex",
    type: "content.delta",
    sessionId,
    turnId: "turn-2",
    streamKind: "assistant_text",
    delta: "answer",
    timestamp: "2026-01-01T00:01:41.000Z",
  });
  ctx.db.insertOrchestrationEvent({
    eventId: `${sessionId}-turn-2-complete`,
    provider: "codex",
    type: "turn.completed",
    sessionId,
    turnId: "turn-2",
    state: "completed",
    cost: 0.25,
    tokens: {
      input: 7,
      output: 3,
    },
    timestamp: "2026-01-01T00:01:50.000Z",
  });
}
