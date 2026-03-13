import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeDb,
  getSession,
  deleteSessions,
  getOrchestrationEvents,
  getUsageBySession,
  getUsageSummary,
  insertOrchestrationEvent,
  insertSession,
  insertTask,
  insertUsageRecord,
} from "./db";

const prevOrkaHome = process.env["ORKA_HOME"];
let testHome = "";

function versioned<T extends Record<string, unknown>>(event: T): T & { v: number } {
  return {
    ...event,
    v: 1,
  };
}

beforeEach(() => {
  closeDb();
  testHome = mkdtempSync(join(tmpdir(), "orka-db-test-"));
  process.env["ORKA_HOME"] = testHome;
});

afterEach(() => {
  closeDb();
  rmSync(testHome, { recursive: true, force: true });
  if (prevOrkaHome === undefined) {
    delete process.env["ORKA_HOME"];
  } else {
    process.env["ORKA_HOME"] = prevOrkaHome;
  }
});

function seedSession(sessionId: string, taskId = `task-${sessionId}`): void {
  insertTask({
    id: taskId,
    title: `Task ${sessionId}`,
    prompt: "Fix issue",
    backend: "claude-code",
    mode: "background",
    model: "claude-sonnet",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  insertSession({
    id: sessionId,
    taskId,
    workspaceId: `ws-${sessionId}`,
    status: "completed",
    backend: "claude-code",
    mode: "background",
    tmuxSessionName: `tmux-${sessionId}`,
    projectPath: "/tmp/project",
    workingDir: "/tmp/project",
    logFile: `/tmp/project/${sessionId}.log`,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:01:00.000Z",
    finishedAt: "2026-01-01T00:02:00.000Z",
    exitCode: 0,
    kept: false,
    autoMerge: false,
  });
}

describe("usage_log helpers", () => {
  test("persists session customization fields for retry", () => {
    insertTask({
      id: "task-sess-custom-2",
      title: "Task custom",
      prompt: "Fix issue",
      backend: "claude-code",
      mode: "background",
      model: "claude-sonnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    insertSession({
      id: "sess-custom-2",
      taskId: "task-sess-custom-2",
      workspaceId: "ws-sess-custom-2",
      status: "completed",
      backend: "claude-code",
      mode: "background",
      tmuxSessionName: "tmux-sess-custom-2",
      projectPath: "/tmp/project",
      workingDir: "/tmp/project",
      logFile: "/tmp/project/sess-custom-2.log",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: "2026-01-01T00:02:00.000Z",
      exitCode: 0,
      kept: false,
      autoMerge: false,
      systemPrompt: "Stay concise.",
      allowedTools: ["Bash", "Read"],
      env: { FOO: "bar" },
    });

    const session = getSession("sess-custom-2");
    expect(session?.systemPrompt).toBe("Stay concise.");
    expect(session?.allowedTools).toEqual(["Bash", "Read"]);
    expect(session?.env).toEqual({ FOO: "bar" });
  });

  test("stores per-session usage and summarizes with filters", () => {
    insertTask({
      id: "task-1",
      title: "Task 1",
      prompt: "Fix issue",
      backend: "claude-code",
      mode: "background",
      model: "claude-sonnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    insertTask({
      id: "task-2",
      title: "Task 2",
      prompt: "Refactor module",
      backend: "codex",
      mode: "background",
      model: "gpt-5-codex",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    insertSession({
      id: "sess-1",
      taskId: "task-1",
      workspaceId: "ws-1",
      status: "completed",
      backend: "claude-code",
      mode: "background",
      tmuxSessionName: "tmux-1",
      projectPath: "/tmp/project",
      workingDir: "/tmp/project",
      logFile: "/tmp/project/session-1.log",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: "2026-01-01T00:02:00.000Z",
      exitCode: 0,
      kept: false,
      autoMerge: false,
    });
    insertSession({
      id: "sess-2",
      taskId: "task-2",
      workspaceId: "ws-2",
      status: "completed",
      backend: "codex",
      mode: "background",
      tmuxSessionName: "tmux-2",
      projectPath: "/tmp/project",
      workingDir: "/tmp/project",
      logFile: "/tmp/project/session-2.log",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T01:01:00.000Z",
      finishedAt: "2026-01-01T01:02:00.000Z",
      exitCode: 0,
      kept: false,
      autoMerge: false,
    });

    insertUsageRecord({
      sessionId: "sess-1",
      backend: "claude-code",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 50,
      costUsd: 1.25,
      model: "claude-sonnet",
      recordedAt: "2026-01-02T00:00:00.000Z",
    });
    insertUsageRecord({
      sessionId: "sess-1",
      backend: "claude-code",
      inputTokens: 9999,
      outputTokens: 9999,
      cacheReadTokens: 9999,
      costUsd: 999,
      model: "duplicate",
      recordedAt: "2026-01-03T00:00:00.000Z",
    });
    insertUsageRecord({
      sessionId: "sess-2",
      backend: "codex",
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 25,
      costUsd: 0.5,
      model: "gpt-5-codex",
      recordedAt: "2026-01-01T12:00:00.000Z",
    });

    const sessionUsage = getUsageBySession("sess-1");
    expect(sessionUsage).toHaveLength(1);
    expect(sessionUsage[0]).toEqual({
      sessionId: "sess-1",
      backend: "claude-code",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 50,
      costUsd: 1.25,
      model: "claude-sonnet",
      recordedAt: "2026-01-02T00:00:00.000Z",
    });

    const total = getUsageSummary();
    expect(total).toEqual({
      totalCostUsd: 1.75,
      totalInputTokens: 2000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 75,
      sessionCount: 2,
      byBackend: {
        "claude-code": {
          cost: 1.25,
          inputTokens: 1200,
          outputTokens: 300,
          sessions: 1,
        },
        codex: {
          cost: 0.5,
          inputTokens: 800,
          outputTokens: 200,
          sessions: 1,
        },
      },
    });

    const recent = getUsageSummary({ since: "2026-01-01T18:00:00.000Z" });
    expect(recent).toEqual({
      totalCostUsd: 1.25,
      totalInputTokens: 1200,
      totalOutputTokens: 300,
      totalCacheReadTokens: 50,
      sessionCount: 1,
      byBackend: {
        "claude-code": {
          cost: 1.25,
          inputTokens: 1200,
          outputTokens: 300,
          sessions: 1,
        },
      },
    });

    const codexOnly = getUsageSummary({ backend: "codex" });
    expect(codexOnly).toEqual({
      totalCostUsd: 0.5,
      totalInputTokens: 800,
      totalOutputTokens: 200,
      totalCacheReadTokens: 25,
      sessionCount: 1,
      byBackend: {
        codex: {
          cost: 0.5,
          inputTokens: 800,
          outputTokens: 200,
          sessions: 1,
        },
      },
    });
  });
});

describe("orchestration event helpers", () => {
  test("stores orchestration events and returns them in insertion order", () => {
    seedSession("sess-1");

    insertOrchestrationEvent({
      eventId: "evt-1",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    insertOrchestrationEvent({
      eventId: "evt-2",
      provider: "claude-code",
      type: "turn.completed",
      sessionId: "sess-1",
      turnId: "turn-1",
      state: "completed",
      timestamp: "2026-01-01T00:01:00.000Z",
    });

    expect(getOrchestrationEvents("sess-1")).toEqual([
      versioned({
        type: "session.started",
        sessionId: "sess-1",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      versioned({
        type: "turn.completed",
        sessionId: "sess-1",
        turnId: "turn-1",
        state: "completed",
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    ]);
  });

  test("migrates persisted orchestration events without a version to v1", () => {
    seedSession("sess-legacy");

    insertOrchestrationEvent({
      eventId: "evt-legacy",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-legacy",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(getOrchestrationEvents("sess-legacy")).toEqual([
      versioned({
        type: "session.started",
        sessionId: "sess-legacy",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ]);
  });

  test("assigns per-session monotonic seq numbers", () => {
    seedSession("sess-1");
    seedSession("sess-2");

    // Insert 3 events for sess-1, 2 for sess-2
    insertOrchestrationEvent({
      eventId: "evt-a1",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    insertOrchestrationEvent({
      eventId: "evt-b1",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-2",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    insertOrchestrationEvent({
      eventId: "evt-a2",
      provider: "claude-code",
      type: "content.delta",
      sessionId: "sess-1",
      turnId: "turn-1",
      streamKind: "assistant_text",
      delta: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    insertOrchestrationEvent({
      eventId: "evt-a3",
      provider: "claude-code",
      type: "content.delta",
      sessionId: "sess-1",
      turnId: "turn-1",
      streamKind: "assistant_text",
      delta: " world",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    insertOrchestrationEvent({
      eventId: "evt-b2",
      provider: "claude-code",
      type: "content.delta",
      sessionId: "sess-2",
      turnId: "turn-1",
      streamKind: "assistant_text",
      delta: "hi",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    // sess-1 should have 3 events in insertion order despite same timestamp
    const s1 = getOrchestrationEvents("sess-1");
    expect(s1).toHaveLength(3);
    expect(s1.map((e) => e.type)).toEqual(["session.started", "content.delta", "content.delta"]);

    // sess-2 should have independent seq, 2 events
    const s2 = getOrchestrationEvents("sess-2");
    expect(s2).toHaveLength(2);
    expect(s2.map((e) => e.type)).toEqual(["session.started", "content.delta"]);
  });

  test("deletes persisted orchestration events when sessions are deleted", () => {
    seedSession("sess-1");

    insertOrchestrationEvent({
      eventId: "evt-1",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    deleteSessions(["sess-1"]);

    expect(getOrchestrationEvents("sess-1")).toEqual([]);
  });
});
