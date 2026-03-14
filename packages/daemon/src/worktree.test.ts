import { $ } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config";
import { worktreeCreate } from "./worktree";

let testHome = "";
let repoPath = "";

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "orka-worktree-test-"));
  repoPath = await createRepo();
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe("worktreeCreate", () => {
  test("runs the configured post-create hook in the worktree", async () => {
    writeConfig([
      "[hooks]",
      `post_worktree_create = "printf 'hook ran' > hook.txt"`,
    ]);

    const config = loadConfig(testHome);
    const wtPath = await worktreeCreate(repoPath, "sess-hook", testHome, { config });

    expect(readFileSync(join(wtPath, "hook.txt"), "utf8")).toBe("hook ran");
  });

  test("runs multiple configured post-create hooks", async () => {
    writeConfig([
      "[hooks]",
      `post_worktree_create = ["printf 'first' > first.txt", "printf 'second' > second.txt"]`,
    ]);

    const config = loadConfig(testHome);
    const wtPath = await worktreeCreate(repoPath, "sess-hook-multi", testHome, { config });

    expect(readFileSync(join(wtPath, "first.txt"), "utf8")).toBe("first");
    expect(readFileSync(join(wtPath, "second.txt"), "utf8")).toBe("second");
  });

  test("warns and continues when one post-create hook fails", async () => {
    writeConfig([
      "[[hooks.post_worktree_create]]",
      `run = "printf 'first' > first.txt"`,
      "",
      "[[hooks.post_worktree_create]]",
      `run = "exit 7"`,
      "",
      "[[hooks.post_worktree_create]]",
      `run = "printf 'second' > second.txt"`,
    ]);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const config = loadConfig(testHome);
      const wtPath = await worktreeCreate(repoPath, "sess-hook-fail", testHome, { config });

      expect(existsSync(wtPath)).toBe(true);
      expect(readFileSync(join(wtPath, "first.txt"), "utf8")).toBe("first");
      expect(readFileSync(join(wtPath, "second.txt"), "utf8")).toBe("second");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("sess-hook-fail");
      expect(warnings[0]).toContain("exit code 7");
    } finally {
      console.warn = originalWarn;
    }
  });
});

function writeConfig(lines: string[]): void {
  writeFileSync(join(testHome, "config.toml"), lines.join("\n"), "utf8");
}

async function createRepo(): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), "orka-worktree-repo-"));
  await $`git init ${path}`.quiet();
  await $`git -C ${path} config user.email "orka@example.com"`.quiet();
  await $`git -C ${path} config user.name "Orka Tests"`.quiet();
  writeFileSync(join(path, "tracked.txt"), "base\n", "utf8");
  await $`git -C ${path} add tracked.txt`.quiet();
  await $`git -C ${path} commit -m "initial"`.quiet();
  return path;
}
