import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderSessionHandle } from "@orka/core";
import { closeDb, getOrchestrationEvents, getUsageBySession, insertOrchestrationEvent, insertSession, insertTask } from "./db";
import { createLocalClient } from "./local-client";
import { getRunner, setRunner } from "./orchestrator";
import { pushHub } from "./push";
import { resetConfigCache } from "./config";
import { providerService } from "./provider-runtime";
import type { SessionRunner } from "./runner";

const originalOrkaHome = process.env["ORKA_HOME"];

let testHome = "";
let originalRunner: SessionRunner;

beforeEach(() => {
  originalRunner = getRunner();
  closeDb();
  resetConfigCache();
  testHome = mkdtempSync(join(tmpdir(), "orka-local-client-test-"));
  mkdirSync(testHome, { recursive: true });
  writeFileSync(join(testHome, "config.toml"), "[providers]\nuse_runtime = true\n");
  process.env["ORKA_HOME"] = testHome;
});

afterEach(() => {
  setRunner(originalRunner);
  for (const handle of providerService.listActiveSessions()) {
    providerService.clearHandle(handle.threadId);
  }
  closeDb();
  resetConfigCache();
  rmSync(testHome, { recursive: true, force: true });
  if (originalOrkaHome === undefined) {
    delete process.env["ORKA_HOME"];
  } else {
    process.env["ORKA_HOME"] = originalOrkaHome;
  }
});

describe("LocalClient provider runtime support", () => {
  test("captures provider output and builds results from orchestration events", async () => {
    seedSession("sess-provider");
    seedProviderEvents("sess-provider");
    setRunner(createRunnerStub());

    const client = createLocalClient();

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

    expect(getUsageBySession("sess-provider")).toEqual([
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

  test("uses provider handles for liveness and input routing", async () => {
    seedSession("sess-live");
    const runner = createRunnerStub();
    setRunner(runner);

    const handle: ProviderSessionHandle = {
      threadId: "sess-live",
      provider: "codex",
      events: (async function* () {})(),
      meta: {},
    };

    const originalGetHandle = providerService.getHandle;
    const originalSendTurn = providerService.sendTurn;
    const originalBroadcast = pushHub.broadcast.bind(pushHub);
    const sendTurnCalls: Array<{ sessionId: string; input: { input: string } }> = [];
    const broadcasts: Array<{ channel: string; data: unknown }> = [];

    (providerService as any).getHandle = (sessionId: string) => (sessionId === "sess-live" ? handle : undefined);
    (providerService as any).sendTurn = async (sessionId: string, input: { input: string }) => {
      sendTurnCalls.push({ sessionId, input });
    };
    (pushHub as { broadcast: typeof pushHub.broadcast }).broadcast = ((channel, data) => {
      broadcasts.push({ channel, data });
    }) as typeof pushHub.broadcast;

    try {
      const client = createLocalClient();

      await expect(client.isAlive("sess-live")).resolves.toBe(true);
      await client.sendInput("sess-live", "continue");

      expect(sendTurnCalls).toEqual([{ sessionId: "sess-live", input: { input: "continue" } }]);
      expect(runner.sendTextCalls).toEqual([]);
      expect(getOrchestrationEvents("sess-live")).toContainEqual({
        type: "user.input",
        sessionId: "sess-live",
        text: "continue",
        timestamp: expect.any(String),
      });
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({
        channel: "orchestration.event",
        data: {
          type: "user.input",
          sessionId: "sess-live",
          text: "continue",
        },
      });
    } finally {
      (providerService as any).getHandle = originalGetHandle;
      (providerService as any).sendTurn = originalSendTurn;
      (pushHub as { broadcast: typeof pushHub.broadcast }).broadcast = originalBroadcast;
    }
  });
});

function seedSession(sessionId: string): void {
  insertTask({
    id: `task-${sessionId}`,
    title: `Task ${sessionId}`,
    prompt: "Fix the provider runtime path",
    backend: "codex",
    mode: "background",
    model: "gpt-5",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  insertSession({
    id: sessionId,
    taskId: `task-${sessionId}`,
    workspaceId: `ws-${sessionId}`,
    status: "completed",
    backend: "codex",
    mode: "background",
    tmuxSessionName: `tmux-${sessionId}`,
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
  insertOrchestrationEvent({
    eventId: `${sessionId}-turn-1-start`,
    provider: "codex",
    type: "turn.started",
    sessionId,
    turnId: "turn-1",
    timestamp: "2026-01-01T00:01:01.000Z",
  });
  insertOrchestrationEvent({
    eventId: `${sessionId}-turn-1-delta`,
    provider: "codex",
    type: "content.delta",
    sessionId,
    turnId: "turn-1",
    streamKind: "assistant_text",
    delta: "Draft response.",
    timestamp: "2026-01-01T00:01:10.000Z",
  });
  insertOrchestrationEvent({
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
  insertOrchestrationEvent({
    eventId: `${sessionId}-turn-2-start`,
    provider: "codex",
    type: "turn.started",
    sessionId,
    turnId: "turn-2",
    timestamp: "2026-01-01T00:01:30.000Z",
  });
  insertOrchestrationEvent({
    eventId: `${sessionId}-turn-2-delta-1`,
    provider: "codex",
    type: "content.delta",
    sessionId,
    turnId: "turn-2",
    streamKind: "assistant_text",
    delta: "Final ",
    timestamp: "2026-01-01T00:01:40.000Z",
  });
  insertOrchestrationEvent({
    eventId: `${sessionId}-turn-2-delta-2`,
    provider: "codex",
    type: "content.delta",
    sessionId,
    turnId: "turn-2",
    streamKind: "assistant_text",
    delta: "answer",
    timestamp: "2026-01-01T00:01:41.000Z",
  });
  insertOrchestrationEvent({
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

function createRunnerStub(): SessionRunner & { sendTextCalls: Array<{ sessionName: string; text: string }> } {
  const sendTextCalls: Array<{ sessionName: string; text: string }> = [];
  return {
    sendTextCalls,
    async spawn() {},
    async kill() {},
    async has() {
      return false;
    },
    async list() {
      return [];
    },
    async capture() {
      throw new Error("tmux capture should not be used");
    },
    async sendKeys() {},
    async sendText(sessionName: string, text: string) {
      sendTextCalls.push({ sessionName, text });
    },
    async attach() {},
  };
}
