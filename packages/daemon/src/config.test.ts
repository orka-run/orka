import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config";

describe("daemon config", () => {
  test("parses hooks.post_worktree_create as a single string for backward compatibility", () => {
    const testHome = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    mkdirSync(testHome, { recursive: true });
    writeFileSync(
      join(testHome, "config.toml"),
      [
        "[hooks]",
        'post_worktree_create = "bun install"',
      ].join("\n"),
      "utf8",
    );

    try {
      expect(loadConfig(testHome).hooks.postWorktreeCreate).toEqual(["bun install"]);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("parses hooks.post_worktree_create as a string array", () => {
    const testHome = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    mkdirSync(testHome, { recursive: true });
    writeFileSync(
      join(testHome, "config.toml"),
      [
        "[hooks]",
        'post_worktree_create = ["bun install", "cp .env.example .env"]',
      ].join("\n"),
      "utf8",
    );

    try {
      expect(loadConfig(testHome).hooks.postWorktreeCreate).toEqual([
        "bun install",
        "cp .env.example .env",
      ]);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("parses hooks.post_worktree_create as an array of tables", () => {
    const testHome = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    mkdirSync(testHome, { recursive: true });
    writeFileSync(
      join(testHome, "config.toml"),
      [
        "[[hooks.post_worktree_create]]",
        'run = "bun install"',
        "",
        "[[hooks.post_worktree_create]]",
        'run = "cp .env.example .env"',
      ].join("\n"),
      "utf8",
    );

    try {
      expect(loadConfig(testHome).hooks.postWorktreeCreate).toEqual([
        "bun install",
        "cp .env.example .env",
      ]);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
