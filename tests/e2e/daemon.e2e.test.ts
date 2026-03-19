/**
 * E2E tests for daemon session lifecycle.
 *
 * Uses TestShellAdapter for fast, deterministic tests without real AI backends.
 *
 * Run with: bun test tests/e2e/daemon.e2e.test.ts
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// Isolated ORKA_HOME — must be set BEFORE importing daemon (lazy DB init)
const testHome = mkdtempSync(join(tmpdir(), "orka-e2e-daemon-"));
process.env["ORKA_HOME"] = testHome;
// Unlimited concurrency for E2E tests
writeFileSync(join(testHome, "config.toml"), "[limits]\nmax_concurrent = 0\n");

import { createDaemonContext, createLocalClient } from "@orka/daemon";
import type { OrkaService, SessionDetailResponse } from "@orka/core";
import { registerTestAdapter } from "./helpers/test-adapter";

/** Poll until predicate is true, or timeout. */
async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 200 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Wait for a session to reach a terminal status. */
async function waitForTerminal(
  client: OrkaService,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<SessionDetailResponse> {
  const terminal = new Set(["completed", "cancelled", "failed", "stopped"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await client.getSession(sessionId);
    if (s && terminal.has(s.status)) return s;
    await Bun.sleep(200);
  }
  throw new Error(`Session ${sessionId} did not reach terminal status within ${timeoutMs}ms`);
}

describe("Daemon Session Lifecycle", () => {
  let ctx: import("@orka/daemon").DaemonContext;
  let client: OrkaService;
  let testRepo: string;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    // Create a temp git repo for projectPath
    testRepo = mkdtempSync(join(tmpdir(), "orka-e2e-repo-"));
    await $`git init ${testRepo}`.quiet();
    await $`git -C ${testRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${testRepo} config user.name "Orka Test"`.quiet();
    await $`git -C ${testRepo} commit --allow-empty -m "init"`.quiet();

    ctx = await createDaemonContext(testHome);
    registerTestAdapter(ctx);
    client = createLocalClient(ctx);
  }, 30_000);

  afterAll(async () => {
    // Stop all running sessions
    for (const id of sessionIds) {
      try { await client.stop(id); } catch { /* already stopped */ }
    }
    await Bun.sleep(500);
    ctx?.db.close();
    rmSync(testHome, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  });

  // ---- Spawn ----

  test("spawn returns a running session with correct fields", async () => {
    const result = await client.spawn({
      prompt: "echo 'hello orka'",
      backend: "claude-code",
      projectPath: testRepo,
      title: "E2E test session",
      tags: ["e2e", "test"],
    });
    sessionIds.push(result.id);

    expect(result.id).toMatch(/^sess-/);
    expect(result.status).toBe("running");
    expect(result.title).toBe("E2E test session");

    // Full session details available via getSession
    const session = await client.getSession(result.id);
    expect(session).not.toBeNull();
    expect(session!.backend).toBe("claude-code");
    expect(session!.projectPath).toBe(testRepo);
    expect(session!.startedAt).toBeTruthy();
    expect(session!.tags).toEqual(["e2e", "test"]);
  });

  // ---- Queries ----

  test("getSession returns the spawned session", async () => {
    const spawned = await client.spawn({
      prompt: "echo 'getSession-test'",
      backend: "claude-code",
      projectPath: testRepo,
      tags: ["e2e"],
    });
    sessionIds.push(spawned.id);

    const session = await client.getSession(spawned.id);

    expect(session).not.toBeNull();
    expect(session!.id).toBe(spawned.id);
    expect(session!.backend).toBe("claude-code");
    expect(session!.status).toBe("running");
    expect(session!.projectPath).toBe(testRepo);
  });

  test("listSessions returns all sessions", async () => {
    const sessions = await client.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  test("listSessions supports status filter", async () => {
    const session = await client.spawn({
      prompt: "sleep 300",
      backend: "claude-code",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    const running = await client.listSessions({ status: "running" });
    expect(running.some((s) => s.id === session.id)).toBe(true);

    await client.stop(session.id);
    // Wait for the async event consumer to update DB status
    await waitForTerminal(client, session.id);

    const cancelled = await client.listSessions({ status: "cancelled" });
    expect(cancelled.some((s) => s.id === session.id)).toBe(true);
  });

  // ---- Tags ----

  test("getTags returns session tags", async () => {
    const spawned = await client.spawn({
      prompt: "echo 'tags-test'",
      backend: "claude-code",
      projectPath: testRepo,
      tags: ["e2e", "test"],
    });
    sessionIds.push(spawned.id);

    const tags = await client.getTags(spawned.id);
    expect(tags).toHaveLength(2);
    expect(tags).toContain("e2e");
    expect(tags).toContain("test");
  });

  test("listSessions supports tag filter", async () => {
    const spawned = await client.spawn({
      prompt: "echo 'tag-filter-test'",
      backend: "claude-code",
      projectPath: testRepo,
      tags: ["e2e-filter"],
    });
    sessionIds.push(spawned.id);

    const byTag = await client.listSessions({ tag: "e2e-filter" });
    expect(byTag.length).toBeGreaterThanOrEqual(1);
    expect(byTag.some((s) => s.id === spawned.id)).toBe(true);
    expect(byTag[0]?.backend).toBe("claude-code");
  });

  // ---- Keep ----

  test("setKept marks session as kept", async () => {
    const spawned = await client.spawn({
      prompt: "echo 'kept-test'",
      backend: "claude-code",
      projectPath: testRepo,
    });
    sessionIds.push(spawned.id);

    await client.setKept(spawned.id, true);
    const updated = await client.getSession(spawned.id);
    expect(updated).not.toBeNull();
    expect(updated!.kept).toBe(true);

    await client.setKept(spawned.id, false);
    const reverted = await client.getSession(spawned.id);
    expect(reverted).not.toBeNull();
    expect(reverted!.kept).toBe(false);
  });

  // ---- Stop ----

  test("stop cancels a running session", async () => {
    const session = await client.spawn({
      prompt: "sleep 600",
      backend: "claude-code",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    expect(session.status).toBe("running");
    expect(await client.isAlive(session.id)).toBe(true);

    await client.stop(session.id);
    // Wait for the async event consumer to finalize status
    const stopped = await waitForTerminal(client, session.id);

    expect(stopped.status).toBe("cancelled");
    expect(stopped.finishedAt).toBeTruthy();
    expect(await client.isAlive(session.id)).toBe(false);
  });

  // ---- Logs ----

  test("getLogContent returns output from completed session", async () => {
    // Use exit 0 to ensure process completes (test adapter appends exec bash -i)
    const session = await client.spawn({
      prompt: "echo 'log-test-marker-42' && exit 0",
      backend: "claude-code",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    await waitForTerminal(client, session.id);

    const logContent = await client.getLogContent(session.id);
    expect(logContent).toContain("log-test-marker-42");
  });

  test("captureOutput works on running session", async () => {
    const session = await client.spawn({
      prompt: "echo 'capture-marker'; sleep 300",
      backend: "claude-code",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    // Wait for output to be captured
    await Bun.sleep(500);

    const output = await client.captureOutput(session.id);
    expect(output).toContain("capture-marker");

    await client.stop(session.id);
  });

  // ---- sendTurn ----

  test("sendTurn delivers text to running session", async () => {
    const session = await client.spawn({
      prompt: "read -p '> ' line && echo \"GOT: $line\" && exit 0",
      backend: "claude-code",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    await Bun.sleep(500);
    await client.sendTurn(session.id, "hello-from-test");

    await waitForTerminal(client, session.id);

    const log = await client.getLogContent(session.id);
    expect(log).toContain("GOT: hello-from-test");
  });

  // ---- Prune ----

  test("pruneSessions is dry-run by default and only purges when confirmed", async () => {
    const pruneRepo = mkdtempSync(join(tmpdir(), "orka-e2e-prune-repo-"));
    await $`git init ${pruneRepo}`.quiet();
    await $`git -C ${pruneRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${pruneRepo} config user.name "Orka Test"`.quiet();
    await $`git -C ${pruneRepo} commit --allow-empty -m "init"`.quiet();

    const session = await client.spawn({
      prompt: "sleep 300",
      backend: "claude-code",
      noWorktree: true,
      projectPath: pruneRepo,
    });
    sessionIds.push(session.id);
    const scriptFile = join(testHome, "provider-scripts", `${session.id}.sh`);

    // Wait for script file to be written (spawn is async)
    await waitFor(async () => existsSync(scriptFile), { timeoutMs: 5_000 });
    expect(existsSync(scriptFile)).toBe(true);

    await client.stop(session.id);
    await waitForTerminal(client, session.id);

    const dryRun = await client.pruneSessions({
      maxAgeMs: 0,
      projectPath: pruneRepo,
      purgeLogs: true,
      purgeDb: true,
    });
    expect(dryRun).toEqual({
      pruned: 1,
      orphansCleaned: 0,
      dryRun: true,
    });

    expect(await client.getSession(session.id)).not.toBeNull();
    expect(existsSync(scriptFile)).toBe(true);

    const result = await client.pruneSessions({
      maxAgeMs: 0,
      projectPath: pruneRepo,
      confirm: true,
      purgeLogs: true,
      purgeDb: true,
    });
    expect(result.pruned).toBe(1);
    expect(result.orphansCleaned).toBeGreaterThanOrEqual(0);
    expect(result.dryRun).toBe(false);
    expect(result.dbRecordsDeleted).toBe(1);

    expect(await client.getSession(session.id)).toBeNull();

    rmSync(pruneRepo, { recursive: true, force: true });
  });

  // ---- deleteSessions ----

  test("deleteSessions removes sessions from DB", async () => {
    const session = await client.spawn({
      prompt: "echo 'delete-me' && exit 0",
      backend: "claude-code",
      noWorktree: true,
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    await waitForTerminal(client, session.id);

    await client.deleteSessions([session.id]);
    const gone = await client.getSession(session.id);
    expect(gone).toBeNull();
  });
});
