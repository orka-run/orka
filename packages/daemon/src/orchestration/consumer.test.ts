import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { createEvent, type ProviderRuntimeEvent, type SessionStatus, type UsageRecord } from "@orka/core";
import { ApprovalManager } from "../approval-manager";
import { closeDb } from "../db";
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

const previousOrkaHome = process.env.ORKA_HOME;
let testHome = "";
let repoPaths: string[] = [];

beforeEach(() => {
  initTracing();
  closeDb();
  testHome = mkdtempSync(join(tmpdir(), "orka-consumer-home-"));
  repoPaths = [];
  process.env.ORKA_HOME = testHome;
});

afterEach(() => {
  closeDb();
  rmSync(testHome, { recursive: true, force: true });
  for (const repoPath of repoPaths) {
    rmSync(repoPath, { recursive: true, force: true });
  }
  if (previousOrkaHome === undefined) {
    delete process.env.ORKA_HOME;
  } else {
    process.env.ORKA_HOME = previousOrkaHome;
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
        statuses.push({ sessionId, status, extra });
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
    expect(approvals.getPendingForSession("sess-1")).toEqual([
      {
        id: "req-1",
        sessionId: "sess-1",
        threadId: "thread-1",
        requestType: "command_execution_approval",
        detail: "Run tests",
        args: { command: "bun test" },
        status: "pending",
        createdAt: "2026-03-11T00:00:01.000Z",
      },
    ]);
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
        status: "completed",
        extra: { finishedAt: "2026-03-11T00:00:04.000Z" },
      },
    ]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.sessionId).toBe("sess-1");
    expect(diffs[0]?.status).toContain("Untracked files:");
    expect(diffs[0]?.diff).toBe("");
  });

  test("auto-merges completed worktree sessions when configured", async () => {
    const repoPath = await createRepo();
    const workingDir = await worktreeCreate(repoPath, "sess-merge");
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

    const consumeTask = consumeProviderEvents("sess-merge", handle, new OrchestrationEngine(), {
      updateSessionStatus: (sessionId, status, extra) => {
        statuses.push({ sessionId, status, extra });
      },
      saveSessionDiff: () => {},
      insertUsageRecord: () => {},
      approvalManager: new ApprovalManager(),
      workingDir,
      projectPath: repoPath,
      autoMerge: true,
    });

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

    expect(statuses).toEqual([
      {
        sessionId: "sess-merge",
        status: "completed",
        extra: { finishedAt: "2026-03-11T00:01:00.000Z" },
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
          statuses.push({ sessionId, status, extra });
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

  test("marks the session failed when the consumer loop throws", async () => {
    const queue = new AsyncEventQueue<ProviderRuntimeEvent>();
    const statuses: StatusUpdate[] = [];
    const broadcasts: Array<{ channel: string; data: unknown }> = [];

    const consumeTask = consumeProviderEvents(
      "sess-failed",
      {
        threadId: "thread-failed",
        provider: "shell" as const,
        events: queue,
        meta: {},
      },
      new OrchestrationEngine(),
      {
        updateSessionStatus: (sessionId, status, extra) => {
          statuses.push({ sessionId, status, extra });
        },
        saveSessionDiff: () => {},
        insertUsageRecord: () => {},
        approvalManager: new ApprovalManager(),
        pushHub: {
          broadcast(channel, data) {
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
          broadcast(channel, data) {
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
