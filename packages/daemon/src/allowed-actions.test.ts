import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemonContext, type DaemonContext } from "./daemon-context";
import { createLocalClient } from "./local-client";
import { getWorktreeDir } from "./worktree";
import type { SessionStatus } from "@orka/core";

let testHome = "";
let ctx: DaemonContext;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "orka-actions-test-"));
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

function seedSession(
  sessionId: string,
  opts?: { status?: SessionStatus; noWorktree?: boolean; workingDir?: string },
): void {
  ctx.db.insertTask({
    id: `task-${sessionId}`,
    title: `Task ${sessionId}`,
    prompt: "test prompt",
    backend: "claude-code",
    model: "claude-sonnet",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  ctx.db.insertSession({
    id: sessionId,
    taskId: `task-${sessionId}`,
    workspaceId: "",
    status: (opts?.status ?? "completed") as any,
    backend: "claude-code",
    projectPath: "/tmp/project",
    workingDir: opts?.workingDir ?? "/tmp/project",
    logFile: join(testHome, "logs", `${sessionId}.log`),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:01:00.000Z",
    finishedAt: "2026-01-01T00:02:00.000Z",
    exitCode: 0,
    kept: false,
    autoMerge: false,
    ...(opts?.noWorktree != null ? { noWorktree: opts.noWorktree } : {}),
  });
}

describe("computeAllowedActions for all session statuses", () => {
  test("running session → sendTurn, cancelTurn, stop", async () => {
    seedSession("sess-running", { status: "running" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-running");
    expect(session?.allowedActions).toEqual(["sendTurn", "cancelTurn", "stop"]);
  });

  test("idle session (no worktree) → sendTurn, stop", async () => {
    seedSession("sess-idle", { status: "idle" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-idle");
    expect(session?.allowedActions).toEqual(["sendTurn", "stop"]);
  });

  test("idle session with worktree → sendTurn, stop, merge", async () => {
    // Create a real worktree directory so hasSessionWorktree returns true
    const worktreeDir = join(getWorktreeDir(testHome), "sess-idle-wt");
    mkdirSync(worktreeDir, { recursive: true });

    seedSession("sess-idle-wt", { status: "idle", workingDir: worktreeDir });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-idle-wt");
    expect(session?.allowedActions).toEqual(["sendTurn", "stop", "merge"]);
  });

  test("rate_limited session → sendTurn, stop", async () => {
    seedSession("sess-rl", { status: "rate_limited" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-rl");
    expect(session?.allowedActions).toEqual(["sendTurn", "stop"]);
  });

  test("hibernated session (no worktree) → sendTurn, archive, delete", async () => {
    seedSession("sess-hib", { status: "hibernated" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-hib");
    expect(session?.allowedActions).toEqual(["sendTurn", "archive", "delete"]);
  });

  test("completed session (no worktree) → sendTurn, archive, delete", async () => {
    seedSession("sess-comp", { status: "completed" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-comp");
    expect(session?.allowedActions).toEqual(["sendTurn", "archive", "delete"]);
  });

  test("completed session with worktree → sendTurn, merge, archive, delete", async () => {
    const worktreeDir = join(getWorktreeDir(testHome), "sess-comp-wt");
    mkdirSync(worktreeDir, { recursive: true });

    seedSession("sess-comp-wt", { status: "completed", workingDir: worktreeDir });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-comp-wt");
    expect(session?.allowedActions).toEqual(["sendTurn", "merge", "archive", "delete"]);
  });

  test("failed session → sendTurn, retry, archive, delete", async () => {
    seedSession("sess-fail", { status: "failed" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-fail");
    expect(session?.allowedActions).toEqual(["sendTurn", "retry", "archive", "delete"]);
  });

  test("cancelled session → sendTurn, retry, archive, delete", async () => {
    seedSession("sess-cancel", { status: "cancelled" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-cancel");
    expect(session?.allowedActions).toEqual(["sendTurn", "retry", "archive", "delete"]);
  });

  test("interrupted session → sendTurn, retry, archive, delete", async () => {
    seedSession("sess-int", { status: "interrupted" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-int");
    expect(session?.allowedActions).toEqual(["sendTurn", "retry", "archive", "delete"]);
  });

  test("queued session → cancel", async () => {
    seedSession("sess-queued", { status: "queued" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-queued");
    expect(session?.allowedActions).toEqual(["cancel"]);
  });

  test("preparing session → cancel", async () => {
    seedSession("sess-prep", { status: "preparing" });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-prep");
    expect(session?.allowedActions).toEqual(["cancel"]);
  });
});

describe("noWorktree suppresses merge action", () => {
  test("idle session with noWorktree=true → no merge even if worktree dir exists", async () => {
    const worktreeDir = join(getWorktreeDir(testHome), "sess-nowt");
    mkdirSync(worktreeDir, { recursive: true });

    seedSession("sess-nowt", {
      status: "idle",
      workingDir: worktreeDir,
      noWorktree: true,
    });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-nowt");
    expect(session?.allowedActions).toEqual(["sendTurn", "stop"]);
    expect(session?.allowedActions).not.toContain("merge");
  });

  test("completed session with noWorktree=true → no merge", async () => {
    const worktreeDir = join(getWorktreeDir(testHome), "sess-nowt-comp");
    mkdirSync(worktreeDir, { recursive: true });

    seedSession("sess-nowt-comp", {
      status: "completed",
      workingDir: worktreeDir,
      noWorktree: true,
    });
    const client = createLocalClient(ctx);
    const session = await client.getSession("sess-nowt-comp");
    expect(session?.allowedActions).toEqual(["sendTurn", "archive", "delete"]);
    expect(session?.allowedActions).not.toContain("merge");
  });
});
