import { $ } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "./config";
import { worktreeCreate } from "./worktree";

const originalOrkaHome = process.env.ORKA_HOME;

let testHome = "";
let repoPath = "";

beforeEach(async () => {
  resetConfigCache();
  testHome = mkdtempSync(join(tmpdir(), "orka-worktree-test-"));
  process.env.ORKA_HOME = testHome;
  repoPath = await createRepo();
});

afterEach(() => {
  resetConfigCache();
  rmSync(testHome, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  if (originalOrkaHome === undefined) {
    delete process.env.ORKA_HOME;
  } else {
    process.env.ORKA_HOME = originalOrkaHome;
  }
});

describe("worktreeCreate", () => {
  test("runs the configured post-create hook in the worktree", async () => {
    writeConfig([
      "[hooks]",
      `post_worktree_create = "printf 'hook ran' > hook.txt"`,
    ]);

    const wtPath = await worktreeCreate(repoPath, "sess-hook");

    expect(readFileSync(join(wtPath, "hook.txt"), "utf8")).toBe("hook ran");
  });

  test("warns and still returns the worktree when the hook fails", async () => {
    writeConfig([
      "[hooks]",
      `post_worktree_create = "exit 7"`,
    ]);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const wtPath = await worktreeCreate(repoPath, "sess-hook-fail");

      expect(existsSync(wtPath)).toBe(true);
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
  resetConfigCache();
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
