/**
 * E2E tests for worktree management.
 *
 * Tests background session worktree creation, branch naming,
 * merge workflow, diff detection, keep/unkeep, and cleanup.
 *
 * Requires tmux + git. Skipped if tmux is not available.
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

import { createLocalClient } from "@orka/daemon";
import type { OrkaService } from "@orka/core";

let tmuxAvailable = false;
try {
  const proc = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
  tmuxAvailable = proc.exitCode === 0;
} catch {
  tmuxAvailable = false;
}

const describeE2E = tmuxAvailable ? describe : describe.skip;

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

describeE2E("Worktree Management", () => {
  let client: OrkaService;
  let testRepo: string;
  const spawnedTmuxNames: string[] = [];

  beforeAll(async () => {
    testRepo = mkdtempSync(join(tmpdir(), "orka-e2e-wt-repo-"));
    await $`git init ${testRepo}`.quiet();
    await $`git -C ${testRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${testRepo} config user.name "Orka Test"`.quiet();
    // Create an initial file and commit
    writeFileSync(join(testRepo, "README.md"), "# Test Repo\n");
    await $`git -C ${testRepo} add -A`.quiet();
    await $`git -C ${testRepo} commit -m "init"`.quiet();

    client = createLocalClient();
  }, 30_000);

  afterAll(async () => {
    for (const name of spawnedTmuxNames) {
      try { await $`tmux kill-session -t ${name}`.quiet(); } catch {}
    }
    // Clean up worktrees before removing repo
    try { await $`git -C ${testRepo} worktree prune`.quiet(); } catch {}
    rmSync(testHome, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  });

  test("background session auto-creates worktree with named branch", async () => {
    const session = await client.spawn({
      prompt: "echo 'wt-auto'",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    // Worktree path is under ORKA_HOME/worktrees/
    const wtDir = join(testHome, "worktrees");
    expect(session.workingDir).toStartWith(wtDir);
    expect(existsSync(session.workingDir)).toBe(true);

    // Branch should be orka/<session-id>
    const branch = (await $`git -C ${session.workingDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    expect(branch).toBe(`orka/${session.id}`);

    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 10_000 });
  });

  test("interactive session does NOT create a worktree", async () => {
    const session = await client.spawn({
      prompt: "echo 'no-wt'",
      backend: "shell",
      mode: "interactive",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    // Interactive sessions use the project dir directly
    expect(session.workingDir).toBe(testRepo);
    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 10_000 });
  });

  test("custom branch creates worktree on specified branch", async () => {
    const session = await client.spawn({
      prompt: "echo 'custom-branch'",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
      branch: "feat/custom-test",
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    const branch = (await $`git -C ${session.workingDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    expect(branch).toBe("feat/custom-test");

    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 10_000 });
  });

  test("getDiff detects changes in worktree", async () => {
    const session = await client.spawn({
      prompt: "echo 'diff-content' > test-file.txt",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    // Wait for command to complete (creates a file)
    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 10_000 });

    const diff = await client.getDiff(session.id);
    expect(diff.status).toContain("test-file.txt");
  });

  test("merge brings worktree commits into main repo", async () => {
    // Spawn a session that sets git config THEN creates and commits a file.
    // Git config must be set inside the prompt to avoid a race condition —
    // the shell command runs immediately, so configuring after spawn is too late.
    const session = await client.spawn({
      prompt: 'git config user.email "test@orka.dev" && git config user.name "Orka Test" && echo \'merge-test-content\' > merge-test.txt && git add merge-test.txt && git commit -m \'add merge-test\'',
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    // Wait for the session to finish
    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 10_000 });

    // Verify the commit was made in the worktree
    const wtLog = (await $`git -C ${session.workingDir} log --oneline -1`.quiet().text()).trim();
    expect(wtLog).toContain("merge-test");

    // Merge into main repo
    const result = await client.merge(session.id);
    expect(result.branch).toBe(`orka/${session.id}`);
    expect(result.commits).toBeGreaterThanOrEqual(1);
    expect(result.cleaned).toBe(true);

    // Verify the file now exists in the main repo
    expect(existsSync(join(testRepo, "merge-test.txt"))).toBe(true);
  });

  test("merge throws when no commits to merge", async () => {
    const session = await client.spawn({
      prompt: "echo 'no-commit'",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    spawnedTmuxNames.push(session.tmuxSessionName);

    await waitFor(async () => !(await client.isAlive(session.id)), { timeoutMs: 10_000 });

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
    spawnedTmuxNames.push(session.tmuxSessionName);

    // Mark as kept
    await client.setKept(session.id, true);

    // Stop the session — worktree should be preserved because of kept flag
    await client.stop(session.id);

    // Worktree should still exist
    expect(existsSync(session.workingDir)).toBe(true);
  });
});
