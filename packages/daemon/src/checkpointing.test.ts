import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCheckpoint, getCheckpointDiff, pruneCheckpoints, revertToCheckpoint } from "./checkpointing";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkpointing", () => {
  test("captures isolated-index checkpoints and diffs between turns", async () => {
    const repoDir = createTempRepo();

    const baseline = await captureCheckpoint(repoDir, "sess-1", 0);
    expect(baseline.status).toBe("ready");
    expect(baseline.files).toEqual([]);

    writeFileSync(join(repoDir, "notes.txt"), "alpha\nbeta\n", "utf8");
    writeFileSync(join(repoDir, "extra.txt"), "gamma\n", "utf8");

    const checkpoint = await captureCheckpoint(repoDir, "sess-1", 1);

    expect(checkpoint.status).toBe("ready");
    expect(checkpoint.files).toEqual([
      { path: "extra.txt", additions: 1, deletions: 0 },
      { path: "notes.txt", additions: 1, deletions: 0 },
    ]);

    const diff = await getCheckpointDiff(repoDir, baseline.gitRef, checkpoint.gitRef);
    expect(diff).toContain("diff --git");
    expect(diff).toContain("+beta");
    expect(diff).toContain("extra.txt");
  });

  test("reverts worktree state and prunes checkpoint refs", async () => {
    const repoDir = createTempRepo();

    const baseline = await captureCheckpoint(repoDir, "sess-2", 0);
    expect(baseline.status).toBe("ready");

    writeFileSync(join(repoDir, "notes.txt"), "alpha\nbeta\n", "utf8");
    writeFileSync(join(repoDir, "extra.txt"), "gamma\n", "utf8");

    const checkpoint = await captureCheckpoint(repoDir, "sess-2", 1);
    expect(checkpoint.status).toBe("ready");

    writeFileSync(join(repoDir, "notes.txt"), "drifted\n", "utf8");
    writeFileSync(join(repoDir, "temp.txt"), "junk\n", "utf8");

    await revertToCheckpoint(repoDir, baseline.gitRef);

    expect(readFileSync(join(repoDir, "notes.txt"), "utf8")).toBe("alpha\n");
    expect(existsSync(join(repoDir, "extra.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "temp.txt"))).toBe(false);

    await pruneCheckpoints(repoDir, "sess-2");
    const refs = runGit(repoDir, ["for-each-ref", "--format=%(refname)", "refs/orka/checkpoints/sess-2"]).trim();
    expect(refs).toBe("");
  });
});

function createTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "orka-checkpointing-test-"));
  tempDirs.push(repoDir);

  runGit(repoDir, ["init"]);
  runGit(repoDir, ["config", "user.name", "Orka"]);
  runGit(repoDir, ["config", "user.email", "orka@example.com"]);

  writeFileSync(join(repoDir, "notes.txt"), "alpha\n", "utf8");
  runGit(repoDir, ["add", "notes.txt"]);
  runGit(repoDir, ["commit", "-m", "initial"]);

  return repoDir;
}

function runGit(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}
