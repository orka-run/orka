/**
 * E2E tests for daemon session lifecycle.
 *
 * Requires tmux. Skipped if tmux is not available.
 * Uses shell backend for fast, deterministic tests.
 *
 * Run with: bun test tests/e2e/daemon.e2e.test.ts
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// Isolated ORKA_HOME — must be set BEFORE importing daemon (lazy DB init)
const testHome = mkdtempSync(join(tmpdir(), "orka-e2e-daemon-"));
process.env["ORKA_HOME"] = testHome;

import { createLocalClient } from "@orka/daemon";
import type { OrkaService } from "@orka/core";

// Check tmux availability
let tmuxAvailable = false;
try {
  const proc = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
  tmuxAvailable = proc.exitCode === 0;
} catch {
  tmuxAvailable = false;
}

const describeE2E = tmuxAvailable ? describe : describe.skip;

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

describeE2E("Daemon Session Lifecycle", () => {
  let client: OrkaService;
  let testRepo: string;
  const spawnedTmuxNames: string[] = [];

  beforeAll(async () => {
    // Create a temp git repo for projectPath
    testRepo = mkdtempSync(join(tmpdir(), "orka-e2e-repo-"));
    await $`git init ${testRepo}`.quiet();
    await $`git -C ${testRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${testRepo} config user.name "Orka Test"`.quiet();
    await $`git -C ${testRepo} commit --allow-empty -m "init"`.quiet();

    client = createLocalClient();
  }, 30_000);

  afterAll(async () => {
    // Kill only our test sessions
    for (const name of spawnedTmuxNames) {
      try {
        await $`tmux kill-session -t ${name}`.quiet();
      } catch { /* already dead */ }
    }
    rmSync(testHome, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  });

  // ---- Spawn ----

  test("spawn returns a running session with correct fields", async () => {
    const session = await client.spawn({
      prompt: "echo 'hello orka'",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
      title: "E2E test session",
      tags: ["e2e", "test"],
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    expect(session.id).toMatch(/^sess-/);
    expect(session.status).toBe("running");
    expect(session.backend).toBe("shell");
    expect(session.mode).toBe("background");
    expect(session.projectPath).toBe(testRepo);
    expect(session.startedAt).toBeTruthy();
    expect(session.logFile).toContain(session.id);
  });

  // ---- Queries ----

  test("getSession returns the spawned session", async () => {
    const sessions = await client.listSessions();
    const id = sessions[0]?.id;
    if (!id) {
      throw new Error("Expected at least one session");
    }
    const session = await client.getSession(id);

    expect(session).not.toBeNull();
    expect(session!.id).toBe(id);
    expect(session!.backend).toBe("shell");
  });

  test("getTask returns the linked task", async () => {
    const sessions = await client.listSessions();
    const session = sessions[0];
    if (!session) {
      throw new Error("Expected at least one session");
    }
    const task = await client.getTask(session.taskId);

    expect(task).not.toBeNull();
    expect(task!.prompt).toContain("echo");
    expect(task!.backend).toBe("shell");
  });

  test("listSessions returns all sessions", async () => {
    const sessions = await client.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  test("listSessions supports status filter", async () => {
    // Spawn a session we'll stop later
    const session = await client.spawn({
      prompt: "sleep 300",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    const running = await client.listSessions({ status: "running" });
    expect(running.some((s) => s.id === session.id)).toBe(true);

    // Stop it
    await client.stop(session.id);

    const cancelled = await client.listSessions({ status: "cancelled" });
    expect(cancelled.some((s) => s.id === session.id)).toBe(true);
  });

  // ---- Tags ----

  test("getTags returns session tags", async () => {
    const sessions = await client.listSessions();
    const tagged = sessions.find((s) => s.mode === "background");
    if (!tagged) return; // skip if no tagged session

    const tags = await client.getTags(tagged.id);
    // First spawned session had ["e2e", "test"]
    if (tags.length > 0) {
      expect(tags).toContain("e2e");
      expect(tags).toContain("test");
    }
  });

  test("listSessions supports tag filter", async () => {
    const byTag = await client.listSessions({ tag: "e2e" });
    expect(byTag.length).toBeGreaterThanOrEqual(1);
    expect(byTag[0]?.backend).toBe("shell");
  });

  // ---- Keep ----

  test("setKept marks session as kept", async () => {
    const sessions = await client.listSessions();
    const session = sessions[0];
    if (!session) {
      throw new Error("Expected at least one session");
    }

    await client.setKept(session.id, true);
    const updated = await client.getSession(session.id);
    expect(updated!.kept).toBe(true);

    await client.setKept(session.id, false);
    const reverted = await client.getSession(session.id);
    expect(reverted!.kept).toBe(false);
  });

  // ---- Stop ----

  test("stop cancels a running session", async () => {
    const session = await client.spawn({
      prompt: "sleep 600",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    expect(session.status).toBe("running");
    expect(await client.isAlive(session.id)).toBe(true);

    await client.stop(session.id);

    const stopped = await client.getSession(session.id);
    expect(stopped!.status).toBe("cancelled");
    expect(stopped!.finishedAt).toBeTruthy();
    expect(await client.isAlive(session.id)).toBe(false);
  });

  // ---- Logs ----

  test("getLogContent returns output from completed session", async () => {
    const session = await client.spawn({
      prompt: "echo 'log-test-marker-42'",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    // Wait for tmux session to die (echo finishes fast)
    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 10_000 });

    const logContent = await client.getLogContent(session.id);
    expect(logContent).toContain("log-test-marker-42");
    expect(logContent).toContain("[orka] exit_code=0");
  });

  test("captureOutput works on running session", async () => {
    const session = await client.spawn({
      prompt: "echo 'capture-marker'; sleep 300",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    // Wait a bit for output to appear in tmux
    await Bun.sleep(500);

    const output = await client.captureOutput(session.id);
    expect(output).toContain("capture-marker");

    await client.stop(session.id);
  });

  // ---- sendTurn ----

  test("sendTurn delivers text to running session", async () => {
    // Start a cat session that reads stdin
    const session = await client.spawn({
      prompt: "read -p '> ' line && echo \"GOT: $line\"",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    await Bun.sleep(500);
    await client.sendTurn(session.id, "hello-from-test");

    // Wait for session to complete
    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 5_000 });

    const log = await client.getLogContent(session.id);
    expect(log).toContain("GOT: hello-from-test");
  });

  // ---- Worktree (background sessions) ----

  test("background session creates a worktree", async () => {
    const session = await client.spawn({
      prompt: "echo 'worktree-test'",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    // Background sessions get worktrees
    const wtDir = join(testHome, "worktrees");
    expect(session.workingDir).toStartWith(wtDir);
    expect(existsSync(session.workingDir)).toBe(true);

    // Wait for completion
    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 10_000 });
  });

  test("getDiff shows git status in worktree", async () => {
    // Find a session with a worktree
    const sessions = await client.listSessions();
    const wtSession = sessions.find((s) =>
      s.workingDir.includes("worktrees") && existsSync(s.workingDir),
    );
    if (!wtSession) return; // skip if no worktree session available

    const diff = await client.getDiff(wtSession.id);
    expect(diff.status).toBeDefined();
    expect(diff.diff).toBeDefined();
  });

  // ---- Prune ----

  test("pruneSessions is dry-run by default and only purges when confirmed", async () => {
    const pruneRepo = mkdtempSync(join(tmpdir(), "orka-e2e-prune-repo-"));
    await $`git init ${pruneRepo}`.quiet();
    await $`git -C ${pruneRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${pruneRepo} config user.name "Orka Test"`.quiet();
    await $`git -C ${pruneRepo} commit --allow-empty -m "init"`.quiet();

    // Spawn and stop a session to make it prunable.
    const session = await client.spawn({
      prompt: "sleep 300",
      backend: "shell",
      mode: "interactive",
      projectPath: pruneRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);
    const scriptFile = join(testHome, "scripts", `${session.id}.sh`);

    expect(existsSync(session.logFile)).toBe(true);
    expect(existsSync(scriptFile)).toBe(true);

    await client.stop(session.id);

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
    expect(existsSync(session.logFile)).toBe(true);
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
    expect(result.logsDeleted).toBe(2);
    expect(result.dbRecordsDeleted).toBe(1);

    expect(await client.getSession(session.id)).toBeNull();
    expect(existsSync(session.logFile)).toBe(false);
    expect(existsSync(scriptFile)).toBe(false);

    rmSync(pruneRepo, { recursive: true, force: true });
  });

  // ---- deleteSessions ----

  test("deleteSessions removes sessions from DB", async () => {
    const session = await client.spawn({
      prompt: "echo 'delete-me'",
      backend: "shell",
      mode: "interactive",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 5_000 });
    try { await client.stop(session.id); } catch { /* already dead */ }

    await client.deleteSessions([session.id]);
    const gone = await client.getSession(session.id);
    expect(gone).toBeNull();
  });
});
