import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { openTestDb, type DatabaseRepository } from "./db";

let db: DatabaseRepository;

function versioned<T extends Record<string, unknown>>(event: T): T & { v: number } {
  return {
    ...event,
    v: 1,
  };
}

beforeAll(async () => {
  db = await openTestDb();
});

afterEach(() => db.clearAllData());
afterAll(() => db.close());

function seedSession(sessionId: string, taskId = `task-${sessionId}`): void {
  db.insertTask({
    id: taskId,
    title: `Task ${sessionId}`,
    prompt: "Fix issue",
    backend: "claude-code",

    model: "claude-sonnet",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  db.insertSession({
    id: sessionId,
    taskId,
    workspaceId: `ws-${sessionId}`,
    status: "completed",
    backend: "claude-code",

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
    db.insertTask({
      id: "task-sess-custom-2",
      title: "Task custom",
      prompt: "Fix issue",
      backend: "claude-code",
  
      model: "claude-sonnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    db.insertSession({
      id: "sess-custom-2",
      taskId: "task-sess-custom-2",
      workspaceId: "ws-sess-custom-2",
      status: "completed",
      backend: "claude-code",
  
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

    const session = db.getSession("sess-custom-2");
    expect(session?.systemPrompt).toBe("Stay concise.");
    expect(session?.allowedTools).toEqual(["Bash", "Read"]);
    // env is deliberately stripped from reads — it contains secrets and must never cross the RPC wire
    expect(session?.env).toBeUndefined();
  });

  test("stores per-session usage and summarizes with filters", () => {
    db.insertTask({
      id: "task-1",
      title: "Task 1",
      prompt: "Fix issue",
      backend: "claude-code",
  
      model: "claude-sonnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.insertTask({
      id: "task-2",
      title: "Task 2",
      prompt: "Refactor module",
      backend: "codex",
  
      model: "gpt-5-codex",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    db.insertSession({
      id: "sess-1",
      taskId: "task-1",
      workspaceId: "ws-1",
      status: "completed",
      backend: "claude-code",
  
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
    db.insertSession({
      id: "sess-2",
      taskId: "task-2",
      workspaceId: "ws-2",
      status: "completed",
      backend: "codex",
  
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

    db.insertUsageRecord({
      sessionId: "sess-1",
      backend: "claude-code",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 50,
      costUsd: 1.25,
      model: "claude-sonnet",
      recordedAt: "2026-01-02T00:00:00.000Z",
    });
    db.insertUsageRecord({
      sessionId: "sess-1",
      backend: "claude-code",
      inputTokens: 9999,
      outputTokens: 9999,
      cacheReadTokens: 9999,
      costUsd: 999,
      model: "duplicate",
      recordedAt: "2026-01-03T00:00:00.000Z",
    });
    db.insertUsageRecord({
      sessionId: "sess-2",
      backend: "codex",
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 25,
      costUsd: 0.5,
      model: "gpt-5-codex",
      recordedAt: "2026-01-01T12:00:00.000Z",
    });

    const sessionUsage = db.getUsageBySession("sess-1");
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

    const total = db.getUsageSummary();
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

    const recent = db.getUsageSummary({ since: "2026-01-01T18:00:00.000Z" });
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

    const codexOnly = db.getUsageSummary({ backend: "codex" });
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

    db.insertOrchestrationEvent({
      eventId: "evt-1",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    db.insertOrchestrationEvent({
      eventId: "evt-2",
      provider: "claude-code",
      type: "turn.completed",
      sessionId: "sess-1",
      turnId: "turn-1",
      state: "completed",
      timestamp: "2026-01-01T00:01:00.000Z",
    });

    expect(db.getOrchestrationEvents("sess-1")).toEqual([
      versioned({
        type: "session.started" as const,
        sessionId: "sess-1",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      versioned({
        type: "turn.completed" as const,
        sessionId: "sess-1",
        turnId: "turn-1",
        state: "completed" as const,
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    ]);
  });

  test("migrates persisted orchestration events without a version to v1", () => {
    seedSession("sess-legacy");

    db.insertOrchestrationEvent({
      eventId: "evt-legacy",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-legacy",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(db.getOrchestrationEvents("sess-legacy")).toEqual([
      versioned({
        type: "session.started" as const,
        sessionId: "sess-legacy",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ]);
  });

  test("assigns per-session monotonic seq numbers", () => {
    seedSession("sess-1");
    seedSession("sess-2");

    // Insert 3 events for sess-1, 2 for sess-2
    db.insertOrchestrationEvent({
      eventId: "evt-a1",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    db.insertOrchestrationEvent({
      eventId: "evt-b1",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-2",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    db.insertOrchestrationEvent({
      eventId: "evt-a2",
      provider: "claude-code",
      type: "content.delta",
      sessionId: "sess-1",
      turnId: "turn-1",
      streamKind: "assistant_text",
      delta: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    db.insertOrchestrationEvent({
      eventId: "evt-a3",
      provider: "claude-code",
      type: "content.delta",
      sessionId: "sess-1",
      turnId: "turn-1",
      streamKind: "assistant_text",
      delta: " world",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    db.insertOrchestrationEvent({
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
    const s1 = db.getOrchestrationEvents("sess-1");
    expect(s1).toHaveLength(3);
    expect(s1.map((e) => e.type)).toEqual(["session.started", "content.delta", "content.delta"]);

    // sess-2 should have independent seq, 2 events
    const s2 = db.getOrchestrationEvents("sess-2");
    expect(s2).toHaveLength(2);
    expect(s2.map((e) => e.type)).toEqual(["session.started", "content.delta"]);
  });

  test("deletes persisted orchestration events when sessions are deleted", () => {
    seedSession("sess-1");

    db.insertOrchestrationEvent({
      eventId: "evt-1",
      provider: "claude-code",
      type: "session.started",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    db.deleteSessions(["sess-1"]);

    expect(db.getOrchestrationEvents("sess-1")).toEqual([]);
  });
});

describe("checkpoint helpers", () => {
  test("stores, reads, and deletes checkpoints", () => {
    seedSession("sess-checkpoints");

    db.insertCheckpoint({
      id: "chk-1",
      sessionId: "sess-checkpoints",
      turnSeq: 0,
      gitRef: "refs/orka/checkpoints/sess-checkpoints/0",
      status: "ready",
      files: [{ path: "notes.txt", additions: 3, deletions: 1 }],
      createdAt: "2026-01-01T00:03:00.000Z",
    });
    db.insertCheckpoint({
      id: "chk-2",
      sessionId: "sess-checkpoints",
      turnSeq: 1,
      gitRef: "refs/orka/checkpoints/sess-checkpoints/1",
      status: "oversized",
      files: null,
      createdAt: "2026-01-01T00:04:00.000Z",
    });

    expect(db.getCheckpoint("sess-checkpoints", 0)).toEqual({
      id: "chk-1",
      sessionId: "sess-checkpoints",
      turnSeq: 0,
      gitRef: "refs/orka/checkpoints/sess-checkpoints/0",
      status: "ready",
      files: [{ path: "notes.txt", additions: 3, deletions: 1 }],
      createdAt: "2026-01-01T00:03:00.000Z",
    });
    expect(db.getCheckpoints("sess-checkpoints").map((checkpoint) => checkpoint.turnSeq)).toEqual([0, 1]);

    db.deleteCheckpoints("sess-checkpoints", 0);
    expect(db.getCheckpoints("sess-checkpoints").map((checkpoint) => checkpoint.turnSeq)).toEqual([0]);

    db.deleteCheckpoints("sess-checkpoints");
    expect(db.getCheckpoints("sess-checkpoints")).toEqual([]);
  });
});
