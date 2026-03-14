/**
 * E2E tests for worktree management.
 *
 * Tests background session worktree creation, branch naming,
 * merge workflow, diff detection, keep/unkeep, and cleanup.
 *
 * Run with: bun test tests/e2e/worktree.e2e.test.ts
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// Isolated ORKA_HOME — must be set BEFORE importing daemon
const testHome = mkdtempSync(join(tmpdir(), "orka-e2e-wt-"));
process.env["ORKA_HOME"] = testHome;

import { createDaemonContext, createLocalClient } from "@orka/daemon";
import type { OrkaService, Session } from "@orka/core";

/** Wait for a session to reach a terminal status. */
async function waitForTerminal(
  client: OrkaService,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<Session> {
  const terminal = new Set(["completed", "cancelled", "failed", "stopped"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await client.getSession(sessionId);
    if (s && terminal.has(s.status)) return s;
    await Bun.sleep(200);
  }
  throw new Error(`Session ${sessionId} did not reach terminal status within ${timeoutMs}ms`);
}

describe("Worktree Management", () => {
  let client: OrkaService;
  let testRepo: string;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    testRepo = mkdtempSync(join(tmpdir(), "orka-e2e-wt-repo-"));
    await $`git init ${testRepo}`.quiet();
    await $`git -C ${testRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${testRepo} config user.name "Orka Test"`.quiet();
    // Create an initial file and commit
    writeFileSync(join(testRepo, "README.md"), "# Test Repo\n");
    await $`git -C ${testRepo} add -A`.quiet();
    await $`git -C ${testRepo} commit -m "init"`.quiet();

    const ctx = createDaemonContext(testHome);
    client = createLocalClient(ctx);
  }, 30_000);

  afterAll(async () => {
    for (const id of sessionIds) {
      try { await client.stop(id); } catch { /* already stopped */ }
    }
    try { await $`git -C ${testRepo} worktree prune`.quiet(); } catch {}
    rmSync(testHome, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  });

  test("background session auto-creates worktree with named branch", async () => {
    const session = await client.spawn({
      prompt: "echo 'wt-auto' && exit 0",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    // Worktree path is under ORKA_HOME/worktrees/
    const wtDir = join(testHome, "worktrees");
    expect(session.workingDir).toStartWith(wtDir);
    expect(existsSync(session.workingDir)).toBe(true);

    // Branch should be orka/<session-id>
    const branch = (await $`git -C ${session.workingDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    expect(branch).toBe(`orka/${session.id}`);

    await waitForTerminal(client, session.id);
  });

  test("interactive session does NOT create a worktree", async () => {
    const session = await client.spawn({
      prompt: "echo 'no-wt' && exit 0",
      backend: "shell",
      mode: "interactive",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    // Interactive sessions use the project dir directly
    expect(session.workingDir).toBe(testRepo);
    await waitForTerminal(client, session.id);
  });

  test("custom branch creates worktree on specified branch", async () => {
    const session = await client.spawn({
      prompt: "echo 'custom-branch' && exit 0",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
      branch: "feat/custom-test",
    });
    sessionIds.push(session.id);

    const branch = (await $`git -C ${session.workingDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    expect(branch).toBe("feat/custom-test");

    await waitForTerminal(client, session.id);
  });

  test("getDiff detects changes in worktree", async () => {
    // Keep the session alive so the worktree is not cleaned up before getDiff
    const session = await client.spawn({
      prompt: "echo 'diff-content' > test-file.txt && sleep 300",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    // Wait for the file to be created
    await Bun.sleep(500);

    const diff = await client.getDiff(session.id);
    expect(diff.status).toContain("test-file.txt");

    await client.stop(session.id);
  });

  test("merge brings worktree commits into main repo", async () => {
    // Keep the session alive so the worktree is not cleaned up.
    // Git config must be set inside the prompt.
    const session = await client.spawn({
      prompt: 'git config user.email "test@orka.dev" && git config user.name "Orka Test" && echo \'merge-test-content\' > merge-test.txt && git add merge-test.txt && git commit -m \'add merge-test\' && sleep 300',
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    // Wait for the commit to be made
    await Bun.sleep(1000);

    // Verify the commit was made in the worktree
    const wtLog = (await $`git -C ${session.workingDir} log --oneline -1`.quiet().text()).trim();
    expect(wtLog).toContain("merge-test");

    // Stop the session first (merge needs the worktree intact)
    // We use setKept to prevent auto-cleanup
    await client.setKept(session.id, true);
    await client.stop(session.id);
    await waitForTerminal(client, session.id);

    // Merge into main repo
    const result = await client.merge(session.id);
    expect(result.branch).toBe(`orka/${session.id}`);
    expect(result.commits).toBeGreaterThanOrEqual(1);
    expect(result.cleaned).toBe(true);

    // Verify the file now exists in the main repo
    expect(existsSync(join(testRepo, "merge-test.txt"))).toBe(true);
  });

  test("merge throws when no commits to merge", async () => {
    // Keep the session alive so worktree is not cleaned up
    const session = await client.spawn({
      prompt: "echo 'no-commit' && sleep 300",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    await Bun.sleep(500);

    // Keep to prevent auto-cleanup
    await client.setKept(session.id, true);
    await client.stop(session.id);
    await waitForTerminal(client, session.id);

    // No git commits were made in the worktree, so merge should fail
    await expect(client.merge(session.id)).rejects.toThrow("No commits to merge");
  });

  test("keep protects worktree from cleanup on stop", async () => {
    const session = await client.spawn({
      prompt: "sleep 600",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    sessionIds.push(session.id);

    // Mark as kept
    await client.setKept(session.id, true);

    // Stop the session — worktree should be preserved because of kept flag
    await client.stop(session.id);
    await waitForTerminal(client, session.id);

    // Worktree should still exist
    expect(existsSync(session.workingDir)).toBe(true);
  });
});
