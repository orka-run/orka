import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfig, resetConfigCache } from "./config";

const originalOrkaHome = process.env.ORKA_HOME;

let testHome = "";

beforeEach(() => {
  resetConfigCache();
  testHome = mkdtempSync(join(tmpdir(), "orka-config-test-"));
  mkdirSync(testHome, { recursive: true });
  process.env.ORKA_HOME = testHome;
});

afterEach(() => {
  resetConfigCache();
  rmSync(testHome, { recursive: true, force: true });
  if (originalOrkaHome === undefined) {
    delete process.env.ORKA_HOME;
  } else {
    process.env.ORKA_HOME = originalOrkaHome;
  }
});

describe("daemon config", () => {
  test("parses hooks.post_worktree_create", () => {
    writeFileSync(
      join(testHome, "config.toml"),
      [
        "[hooks]",
        'post_worktree_create = "bun install"',
      ].join("\n"),
      "utf8",
    );

    expect(getConfig().hooks.postWorktreeCreate).toBe("bun install");
  });
});
