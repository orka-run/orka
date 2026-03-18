import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { createEvent, type ProviderRuntimeEvent, type SessionStatus, type UsageRecord } from "@orka/core";
import { ApprovalManager } from "../approval-manager";
import { initTracing } from "../tracing";
import { worktreeCreate } from "../worktree";
import { OrchestrationEngine } from "./engine";
import { consumeProviderEvents } from "./consumer";

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  fail(error: Error): void {
    if (this.closed || this.failure) {
      return;
    }

    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  close(): void {
    if (this.closed || this.failure) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return { value: this.values.shift() as T, done: false };
        }

        if (this.failure) {
          throw this.failure;
        }

        if (this.closed) {
          return { value: undefined as T, done: true };
        }

        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

interface StatusUpdate {
  sessionId: string;
  status: SessionStatus;
  extra?: { startedAt?: string; finishedAt?: string; exitCode?: number };
}

function recordStatusUpdate(
  statuses: StatusUpdate[],
  sessionId: string,
  status: SessionStatus,
  extra?: StatusUpdate["extra"],
): void {
  statuses.push({
    sessionId,
    status,
    ...(extra ? { extra } : {}),
  });
}

let testHome = "";
let repoPaths: string[] = [];

beforeEach(() => {
  initTracing();
  testHome = mkdtempSync(join(tmpdir(), "orka-consumer-home-"));
  repoPaths = [];
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  for (const repoPath of repoPaths) {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

describe("consumeProviderEvents", () => {
  test("ingests provider events and persists approvals, usage, logs, and diff on completion", async () => {
    const repoPath = await createRepo();
    const workingDir = repoPath;
    const logFile = join(testHome, "session.log");
    writeFileSync(join(repoPath, "notes.txt"), "work in progress\n", "utf8");

    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const handle = {
      threadId: "thread-1",
      provider: "codex" as const,
      events: queue,
      meta: {},
    };
    const engine = new OrchestrationEngine();
    const approvals = new ApprovalManager();
    const statuses: StatusUpdate[] = [];
    const diffs: Array<{ sessionId: string; diff: string; status: string }> = [];
    const usageRecords: UsageRecord[] = [];

    const consumeTask = consumeProviderEvents("sess-1", handle, engine, {
      updateSessionStatus: (sessionId, status, extra) => {
        recordStatusUpdate(statuses, sessionId, status, extra);
      },
      saveSessionDiff: (sessionId, diff, status) => {
        diffs.push({ sessionId, diff, status });
      },
      insertUsageRecord: (record) => {
        usageRecords.push(record);
      },
      approvalManager: approvals,
      logFile,
      workingDir,
      projectPath: repoPath,
      autoMerge: false,
      model: "gpt-5-codex",
    });

    queue.push(createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:00:00.000Z" }));
    queue.push(
      createEvent(
        "request.opened",
        "thread-1",
        {
          requestType: "command_execution_approval",
          detail: "Run tests",
          args: { command: "bun test" },
        },
        {
          requestId: "req-1",
          createdAt: "2026-03-11T00:00:01.000Z",
        },
      ),
    );
    queue.push(
      createEvent(
        "content.delta",
        "thread-1",
        { streamKind: "assistant_text", delta: "hello " },
        {
          turnId: "turn-1",
          createdAt: "2026-03-11T00:00:02.000Z",
        },
      ),
    );
    queue.push(
      createEvent(
        "turn.completed",
        "thread-1",
        {
          state: "completed",
          totalCostUsd: 1.25,
          usage: { inputTokens: 120, outputTokens: 80 },
        },
        {
          turnId: "turn-1",
          createdAt: "2026-03-11T00:00:03.000Z",
        },
      ),
    );
    queue.push(
      createEvent(
        "session.exited",
        "thread-1",
        { exitKind: "graceful", reason: "done" },
        {
          createdAt: "2026-03-11T00:00:04.000Z",
        },
      ),
    );
    queue.close();

    await consumeTask;

    expect(engine.getSessionState("sess-1")).toMatchObject({
      status: "completed",
      totalCost: 1.25,
      totalTokens: { input: 120, output: 80 },
      pendingRequests: [{ requestId: "req-1", requestType: "command_execution_approval" }],
    });
    // Pending approvals are auto-denied on session exit
    expect(approvals.getPendingForSession("sess-1")).toEqual([]);
    const resolved = approvals.getRequest("req-1");
    expect(resolved).toBeTruthy();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.decision).toBe("deny");
    expect(usageRecords).toEqual([
      {
        sessionId: "sess-1",
        backend: "codex",
        inputTokens: 120,
        outputTokens: 80,
        cacheReadTokens: 0,
        costUsd: 1.25,
        model: "gpt-5-codex",
        recordedAt: "2026-03-11T00:00:03.000Z",
      },
    ]);
    expect(readFileSync(logFile, "utf8")).toBe("hello ");
    expect(statuses).toEqual([
      {
        sessionId: "sess-1",
        status: "idle",
      },
      {
        sessionId: "sess-1",
        status: "completed",
        extra: { finishedAt: "2026-03-11T00:00:04.000Z" },
      },
    ]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.sessionId).toBe("sess-1");
    expect(diffs[0]?.status).toContain("Untracked files:");
    expect(diffs[0]?.diff).toBe("");
  });

  test("requests a turn checkpoint without blocking idle transition", async () => {
    const repoPath = await createRepo();
    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const handle = {
      threadId: "thread-checkpoint",
      provider: "codex" as const,
      events: queue,
      meta: {},
    };
    const engine = new OrchestrationEngine();
    const approvals = new ApprovalManager();
    const statuses: StatusUpdate[] = [];
    const checkpointCalls: Array<{ sessionId: string; turnSeq: number; workingDir: string }> = [];

    const consumeTask = consumeProviderEvents("sess-checkpoint", handle, engine, {
      updateSessionStatus: (sessionId, status, extra) => {
        recordStatusUpdate(statuses, sessionId, status, extra);
      },
      saveSessionDiff: () => {},
      insertUsageRecord: () => {},
      approvalManager: approvals,
      workingDir: repoPath,
      getNextTurnSeq: () => 1,
      onTurnCheckpoint: (sessionId, turnSeq, workingDir) => {
        checkpointCalls.push({ sessionId, turnSeq, workingDir });
      },
    });

    queue.push(
      createEvent(
        "turn.completed",
        "thread-checkpoint",
        { state: "completed" },
        {
          turnId: "turn-1",
          createdAt: "2026-03-11T00:10:00.000Z",
        },
      ),
    );
    queue.push(
      createEvent(
        "session.exited",
        "thread-checkpoint",
        { exitKind: "graceful", reason: "done" },
        {
          createdAt: "2026-03-11T00:10:01.000Z",
        },
      ),
    );
    queue.close();

    await consumeTask;

    expect(checkpointCalls).toEqual([
      {
        sessionId: "sess-checkpoint",
        turnSeq: 1,
        workingDir: repoPath,
      },
    ]);
    expect(statuses[0]).toEqual({
      sessionId: "sess-checkpoint",
      status: "idle",
    });
  });

  test("delivers queued follow-up messages before auto-merge or idle timers", async () => {
    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const handle = {
      threadId: "thread-follow-up",
      provider: "codex" as const,
      events: queue,
      meta: {},
    };
    const statuses: StatusUpdate[] = [];
    const deliveredTurns: Array<{ sessionId: string; text: string }> = [];
    let idleNotifications = 0;
    const autoMergeFired = new Set<string>();

    const consumeTask = consumeProviderEvents("sess-follow-up", handle, new OrchestrationEngine(), {
      updateSessionStatus: (sessionId, status, extra) => {
        recordStatusUpdate(statuses, sessionId, status, extra);
      },
      saveSessionDiff: () => {},
      insertUsageRecord: () => {},
      approvalManager: new ApprovalManager(),
      deliverPendingMessages: async (sessionId) => {
        deliveredTurns.push({ sessionId, text: "first\n\nsecond" });
        recordStatusUpdate(statuses, sessionId, "running");
        return true;
      },
      onSessionIdle: async () => {
        idleNotifications += 1;
      },
      autoMerge: true,
      autoMergeFired,
    });

    queue.push(
      createEvent(
        "turn.completed",
        "thread-follow-up",
        { state: "completed" },
        {
          turnId: "turn-1",
          createdAt: "2026-03-11T00:10:00.000Z",
        },
      ),
    );
    queue.close();

    await consumeTask;

    expect(deliveredTurns).toEqual([
      {
        sessionId: "sess-follow-up",
        text: "first\n\nsecond",
      },
    ]);
    expect(statuses).toEqual([
      {
        sessionId: "sess-follow-up",
        status: "idle",
      },
      {
        sessionId: "sess-follow-up",
        status: "running",
      },
    ]);
    expect(idleNotifications).toBe(0);
    expect(autoMergeFired.size).toBe(0);
  });

  test("auto-merges completed worktree sessions when configured", async () => {
    const repoPath = await createRepo();
    const workingDir = await worktreeCreate(repoPath, "sess-merge", testHome);
    writeFileSync(join(workingDir, "tracked.txt"), "base\nmerged\n", "utf8");
    await $`git -C ${workingDir} add tracked.txt`.quiet();
    await $`git -C ${workingDir} commit -m "worktree change"`.quiet();

    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const handle = {
      threadId: "thread-merge",
      provider: "codex" as const,
      events: queue,
      meta: {},
    };
    const statuses: StatusUpdate[] = [];

    let currentStatus = "running";
    const consumeTask = consumeProviderEvents("sess-merge", handle, new OrchestrationEngine(), {
      updateSessionStatus: (sessionId, status, extra) => {
        currentStatus = status;
        recordStatusUpdate(statuses, sessionId, status, extra);
      },
      saveSessionDiff: () => {},
      insertUsageRecord: () => {},
      approvalManager: new ApprovalManager(),
      workingDir,
      projectPath: repoPath,
      autoMerge: true,
      orkaHome: testHome,
      getSession: () => ({ status: currentStatus } as any),
    });

    // Auto-merge fires on first turn.completed (idle transition)
    queue.push(
      createEvent(
        "turn.completed",
        "thread-merge",
        {},
        { turnId: "turn-1", createdAt: "2026-03-11T00:00:59.000Z" },
      ),
    );
    queue.push(
      createEvent(
        "session.exited",
        "thread-merge",
        { exitKind: "graceful", reason: "done" },
        { createdAt: "2026-03-11T00:01:00.000Z" },
      ),
    );
    queue.close();

    await consumeTask;

    // Flow: idle (turn completed) → completed (auto-merge succeeded) → session.exited skipped (already completed)
    expect(statuses).toEqual([
      {
        sessionId: "sess-merge",
        status: "idle",
      },
      {
        sessionId: "sess-merge",
        status: "completed",
        extra: { finishedAt: expect.any(String) },
      },
    ]);
    expect(readFileSync(join(repoPath, "tracked.txt"), "utf8")).toBe("base\nmerged\n");
    expect(existsSync(workingDir)).toBe(false);
    const branches = (await $`git -C ${repoPath} branch --list orka/sess-merge`.text()).trim();
    expect(branches).toBe("");
  });

  test("marks user-stopped sessions as cancelled", async () => {
    const repoPath = await createRepo();
    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const statuses: StatusUpdate[] = [];

    const consumeTask = consumeProviderEvents(
      "sess-cancelled",
      {
        threadId: "thread-cancelled",
        provider: "claude-code" as const,
        events: queue,
        meta: {},
      },
      new OrchestrationEngine(),
      {
        updateSessionStatus: (sessionId, status, extra) => {
          recordStatusUpdate(statuses, sessionId, status, extra);
        },
        saveSessionDiff: () => {},
        insertUsageRecord: () => {},
        approvalManager: new ApprovalManager(),
        workingDir: repoPath,
      },
    );

    queue.push(
      createEvent(
        "session.exited",
        "thread-cancelled",
        { exitKind: "graceful", reason: "stopped" },
        { createdAt: "2026-03-11T00:02:00.000Z" },
      ),
    );
    queue.close();

    await consumeTask;

    expect(statuses).toEqual([
      {
        sessionId: "sess-cancelled",
        status: "cancelled",
        extra: { finishedAt: "2026-03-11T00:02:00.000Z" },
      },
    ]);
  });

  test("transitions failed sessions to rate_limited when the provider exhausts a rate limit", async () => {
    const repoPath = await createRepo();
    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const statuses: StatusUpdate[] = [];
    const scheduled: Array<{ sessionId: string; rateLimitType: string; resetsAt: number; timestamp: string }> = [];

    const consumeTask = consumeProviderEvents(
      "sess-rate-limited",
      {
        threadId: "thread-rate-limited",
        provider: "claude-code" as const,
        events: queue,
        meta: {},
      },
      new OrchestrationEngine(),
      {
        updateSessionStatus: (sessionId, status, extra) => {
          recordStatusUpdate(statuses, sessionId, status, extra);
        },
        saveSessionDiff: () => {},
        insertUsageRecord: () => {},
        approvalManager: new ApprovalManager(),
        workingDir: repoPath,
        getSession: () => ({
          startedAt: "2026-03-11T00:00:00.000Z",
          status: "running",
        } as any),
        rememberRateLimitEvent: () => {},
        consumePendingRateLimit: () => ({
          rateLimitType: "five_hour",
          resetsAt: 1_773_990_000,
        }),
        onSessionRateLimited: (sessionId, rateLimit, timestamp) => {
          scheduled.push({ sessionId, ...rateLimit, timestamp });
          recordStatusUpdate(statuses, sessionId, "rate_limited");
        },
      },
    );

    queue.push(
      createEvent(
        "rate.limit",
        "thread-rate-limited",
        {
          rateLimitInfo: {
            status: "rejected",
            resetsAt: 1_773_990_000,
            rateLimitType: "five_hour",
            isUsingOverage: false,
          },
        },
        {
          createdAt: "2026-03-11T00:04:00.000Z",
        },
      ),
    );
    queue.push(
      createEvent(
        "session.exited",
        "thread-rate-limited",
        { exitKind: "error", reason: "rate_limit" },
        {
          createdAt: "2026-03-11T00:05:00.000Z",
        },
      ),
    );
    queue.close();

    await consumeTask;

    expect(statuses).toEqual([
      {
        sessionId: "sess-rate-limited",
        status: "rate_limited",
      },
    ]);
    expect(scheduled).toEqual([
      {
        sessionId: "sess-rate-limited",
        rateLimitType: "five_hour",
        resetsAt: 1_773_990_000,
        timestamp: "2026-03-11T00:05:00.000Z",
      },
    ]);
  });

  test("marks the session failed when the consumer loop throws", async () => {
    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const statuses: StatusUpdate[] = [];
    const broadcasts: Array<{ channel: string; data: unknown }> = [];

    const consumeTask = consumeProviderEvents(
      "sess-failed",
      {
        threadId: "thread-failed",
        provider: "claude-code" as const,
        events: queue,
        meta: {},
      },
      new OrchestrationEngine(),
      {
        updateSessionStatus: (sessionId, status, extra) => {
          recordStatusUpdate(statuses, sessionId, status, extra);
        },
        saveSessionDiff: () => {},
        insertUsageRecord: () => {},
        approvalManager: new ApprovalManager(),
        pushHub: {
          broadcast(channel: string, data: unknown) {
            broadcasts.push({ channel, data });
          },
        } as never,
      },
    );

    queue.push(createEvent("session.started", "thread-failed", {}, { createdAt: "2026-03-11T00:03:00.000Z" }));
    queue.fail(new Error("stream failed"));

    await expect(consumeTask).rejects.toThrow("stream failed");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.sessionId).toBe("sess-failed");
    expect(statuses[0]?.status).toBe("failed");
    expect(statuses[0]?.extra?.finishedAt).toEqual(expect.any(String));
    expect(broadcasts).toEqual([
      {
        channel: "orchestration.sessionUpdated",
        data: {
          sessionId: "sess-failed",
          status: "failed",
        },
      },
    ]);
  });

  test("mirrors provider content deltas onto session.logLine pushes", async () => {
    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const broadcasts: Array<{ channel: string; data: unknown }> = [];

    const consumeTask = consumeProviderEvents(
      "sess-logline",
      {
        threadId: "thread-logline",
        provider: "codex" as const,
        events: queue,
        meta: {},
      },
      new OrchestrationEngine(),
      {
        updateSessionStatus: () => {},
        saveSessionDiff: () => {},
        insertUsageRecord: () => {},
        approvalManager: new ApprovalManager(),
        pushHub: {
          broadcast(channel: string, data: unknown) {
            broadcasts.push({ channel, data });
          },
        } as never,
      },
    );

    queue.push(
      createEvent(
        "content.delta",
        "thread-logline",
        { streamKind: "assistant_text", delta: "hello from provider" },
        {
          turnId: "turn-logline",
          createdAt: "2026-03-11T00:04:00.000Z",
        },
      ),
    );
    queue.close();

    await consumeTask;

    expect(broadcasts).toContainEqual({
      channel: "session.logLine",
      data: {
        sessionId: "sess-logline",
        content: "hello from provider",
        line: "hello from provider",
      },
    });
  });
});

async function createRepo(): Promise<string> {
  const repoPath = mkdtempSync(join(tmpdir(), "orka-consumer-repo-"));
  repoPaths.push(repoPath);
  await $`git init ${repoPath}`.quiet();
  await $`git -C ${repoPath} config user.email "orka@example.com"`.quiet();
  await $`git -C ${repoPath} config user.name "Orka Tests"`.quiet();
  writeFileSync(join(repoPath, "tracked.txt"), "base\n", "utf8");
  await $`git -C ${repoPath} add tracked.txt`.quiet();
  await $`git -C ${repoPath} commit -m "initial"`.quiet();
  return repoPath;
}
