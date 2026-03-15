import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, ConfigSchema } from "./config";

describe("ConfigSchema", () => {
  test("produces full defaults from empty input", () => {
    const config = ConfigSchema.parse({});
    expect(config.defaults.backend).toBe("claude-code");
    expect(config.defaults.mode).toBe("background");
    expect(config.defaults.model).toBe("");
    expect(config.defaults.project).toBe(".");
    expect(config.limits.maxConcurrent).toBe(0);
    expect(config.hooks.postWorktreeCreate).toEqual([]);
  });

  test("overrides specific defaults while keeping others", () => {
    const config = ConfigSchema.parse({
      defaults: { backend: "codex" },
    });
    expect(config.defaults.backend).toBe("codex");
    expect(config.defaults.mode).toBe("background");
  });

  test("accepts limits section", () => {
    const config = ConfigSchema.parse({ limits: { maxConcurrent: 10 } });
    expect(config.limits.maxConcurrent).toBe(10);
  });

  test("accepts hooks section", () => {
    const config = ConfigSchema.parse({
      hooks: { postWorktreeCreate: ["bun install"] },
    });
    expect(config.hooks.postWorktreeCreate).toEqual(["bun install"]);
  });
});

describe("loadConfig", () => {
  test("returns defaults when config file is missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    try {
      const config = loadConfig(tempDir);
      expect(config.defaults.backend).toBe("claude-code");
      expect(config.defaults.mode).toBe("background");
      expect(config.limits.maxConcurrent).toBe(0);
      expect(config.hooks.postWorktreeCreate).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns defaults for empty config file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    writeFileSync(join(tempDir, "config.toml"), "", "utf8");
    try {
      const config = loadConfig(tempDir);
      expect(config.defaults.backend).toBe("claude-code");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns defaults for malformed TOML", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    writeFileSync(join(tempDir, "config.toml"), "this is not [valid toml", "utf8");
    try {
      const config = loadConfig(tempDir);
      expect(config.defaults.backend).toBe("claude-code");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parses [defaults] section", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    writeFileSync(
      join(tempDir, "config.toml"),
      [
        "[defaults]",
        'backend = "codex"',
        'mode = "interactive"',
        'model = "gpt-5.4"',
        'project = "/home/user/project"',
      ].join("\n"),
      "utf8",
    );
    try {
      const config = loadConfig(tempDir);
      expect(config.defaults.backend).toBe("codex");
      expect(config.defaults.mode).toBe("interactive");
      expect(config.defaults.model).toBe("gpt-5.4");
      expect(config.defaults.project).toBe("/home/user/project");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parses [limits] section with max_concurrent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    writeFileSync(
      join(tempDir, "config.toml"),
      ["[limits]", "max_concurrent = 5"].join("\n"),
      "utf8",
    );
    try {
      const config = loadConfig(tempDir);
      expect(config.limits.maxConcurrent).toBe(5);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("ignores non-table defaults gracefully", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "orka-config-test-"));
    // A config with only a comment and empty sections
    writeFileSync(
      join(tempDir, "config.toml"),
      "# just a comment\n",
      "utf8",
    );
    try {
      const config = loadConfig(tempDir);
      expect(config.defaults.backend).toBe("claude-code");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("daemon config hooks", () => {
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
