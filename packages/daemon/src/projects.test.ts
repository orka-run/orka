import { $ } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProject } from "./projects";

const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe("resolveProject", () => {
  test("returns the main repo path for linked worktrees", async () => {
    const repoPath = await createRepo();
    const worktreePath = join(mkdtempSync(join(tmpdir(), "orka-project-worktree-parent-")), "sess-test");
    cleanupPaths.add(dirname(worktreePath));
    await $`git -C ${repoPath} worktree add -b sess-test ${worktreePath}`.quiet();

    expect(resolveProject(worktreePath)).toBe(repoPath);
  });

  test("returns the resolved path for non-git directories", () => {
    const path = mkdtempSync(join(tmpdir(), "orka-project-dir-"));
    cleanupPaths.add(path);

    expect(resolveProject(path)).toBe(path);
  });
});

async function createRepo(): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), "orka-project-repo-"));
  cleanupPaths.add(path);
  await $`git init ${path}`.quiet();
  await $`git -C ${path} config user.email "orka@example.com"`.quiet();
  await $`git -C ${path} config user.name "Orka Tests"`.quiet();
  writeFileSync(join(path, "tracked.txt"), "base\n", "utf8");
  await $`git -C ${path} add tracked.txt`.quiet();
  await $`git -C ${path} commit -m "initial"`.quiet();
  return path;
}
