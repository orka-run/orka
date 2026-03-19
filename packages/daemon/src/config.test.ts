import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadProjectConfig, mergeConfigs, resolveDefaults, ConfigSchema } from "./config";
import type { OrkaConfig } from "./config";

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orka-config-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ConfigSchema", () => {
  test("produces full defaults from empty input", () => {
    const config = ConfigSchema.parse({});
    expect(config.defaults.backend).toBe("claude-code");
    expect(config.defaults.model).toBe("");
    expect(config.defaults.project).toBe(".");
    expect(config.limits.maxConcurrent).toBe(5);
    expect(config.hooks.postWorktreeCreate).toEqual([]);
  });

  test("overrides specific defaults while keeping others", () => {
    const config = ConfigSchema.parse({
      defaults: { backend: "codex" },
    });
    expect(config.defaults.backend).toBe("codex");
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
        expect(config.limits.maxConcurrent).toBe(5);
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
        'model = "gpt-5.4"',
        'project = "/home/user/project"',
      ].join("\n"),
      "utf8",
    );
    try {
      const config = loadConfig(tempDir);
      expect(config.defaults.backend).toBe("codex");
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
    const testHome = makeTmpDir();
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
    const testHome = makeTmpDir();
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
    const testHome = makeTmpDir();
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

  test("returns defaults when config file is missing", () => {
    const testHome = makeTmpDir();
    try {
      const config = loadConfig(testHome);
      expect(config.defaults.backend).toBe("claude-code");
        expect(config.defaults.model).toBe("");
      expect(config.defaults.tags).toEqual([]);
      expect(config.backendDefaults).toEqual({});
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("parses new defaults fields (system-prompt, tags, reasoning-effort)", () => {
    const testHome = makeTmpDir();
    writeFileSync(
      join(testHome, "config.toml"),
      [
        "[defaults]",
        'backend = "codex"',
        'system_prompt = "Be concise"',
        'reasoning_effort = "high"',
        'tags = ["infra", "team-a"]',
      ].join("\n"),
      "utf8",
    );

    try {
      const config = loadConfig(testHome);
      expect(config.defaults.backend).toBe("codex");
      expect(config.defaults.systemPrompt).toBe("Be concise");
      expect(config.defaults.reasoningEffort).toBe("high");
      expect(config.defaults.tags).toEqual(["infra", "team-a"]);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("parses per-backend defaults under [defaults.<backend>]", () => {
    const testHome = makeTmpDir();
    writeFileSync(
      join(testHome, "config.toml"),
      [
        "[defaults]",
        'backend = "claude-code"',
        "",
        "[defaults.codex]",
        'model = "gpt-5.4"',
        'reasoning_effort = "high"',
        "",
        "[defaults.claude-code]",
        'model = "opus"',
      ].join("\n"),
      "utf8",
    );

    try {
      const config = loadConfig(testHome);
      expect(config.backendDefaults["codex"]).toEqual({
        model: "gpt-5.4",
        reasoningEffort: "high",
        systemPrompt: undefined,
        tags: undefined,
      });
      expect(config.backendDefaults["claude-code"]).toEqual({
        model: "opus",
        reasoningEffort: undefined,
        systemPrompt: undefined,
        tags: undefined,
      });
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("loadProjectConfig", () => {
  test("returns null when .orka.toml doesn't exist", () => {
    const testDir = makeTmpDir();
    try {
      expect(loadProjectConfig(testDir)).toBeNull();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("loads .orka.toml from project root", () => {
    const testDir = makeTmpDir();
    writeFileSync(
      join(testDir, ".orka.toml"),
      [
        "[defaults]",
        'backend = "codex"',
        'model = "gpt-5.4"',
        'tags = ["my-project"]',
        "",
        "[limits]",
        "max_concurrent = 2",
        "",
        "[hooks]",
        'post_worktree_create = "npm install"',
      ].join("\n"),
      "utf8",
    );

    try {
      const config = loadProjectConfig(testDir);
      expect(config).not.toBeNull();
      expect(config!.defaults.backend).toBe("codex");
      expect(config!.defaults.model).toBe("gpt-5.4");
      expect(config!.defaults.tags).toEqual(["my-project"]);
      expect(config!.limits.maxConcurrent).toBe(2);
      expect(config!.hooks.postWorktreeCreate).toEqual(["npm install"]);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("loads per-backend defaults from .orka.toml", () => {
    const testDir = makeTmpDir();
    writeFileSync(
      join(testDir, ".orka.toml"),
      [
        "[defaults.codex]",
        'reasoning_effort = "high"',
        'model = "gpt-5.4"',
      ].join("\n"),
      "utf8",
    );

    try {
      const config = loadProjectConfig(testDir);
      expect(config).not.toBeNull();
      expect(config!.backendDefaults["codex"]).toEqual({
        model: "gpt-5.4",
        reasoningEffort: "high",
        systemPrompt: undefined,
        tags: undefined,
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("mergeConfigs", () => {
  function emptyConfig(): OrkaConfig {
    return ConfigSchema.parse({});
  }

  test("returns user config when project config is null", () => {
    const user = emptyConfig();
    user.defaults.backend = "codex";
    expect(mergeConfigs(user, null)).toEqual(user);
  });

  test("project config overrides user config defaults", () => {
    const user = emptyConfig();
    user.defaults.backend = "claude-code";
    user.defaults.model = "gpt-4";

    const project = emptyConfig();
    project.defaults.backend = "codex";

    const merged = mergeConfigs(user, project);
    expect(merged.defaults.backend).toBe("codex");
    // model not set in project config (empty string = schema default), so user wins
    expect(merged.defaults.model).toBe("gpt-4");
  });

  test("tags are merged (union) not replaced", () => {
    const user = emptyConfig();
    user.defaults.tags = ["global-tag"];

    const project = emptyConfig();
    project.defaults.tags = ["proj-tag"];

    const merged = mergeConfigs(user, project);
    expect(merged.defaults.tags).toEqual(["global-tag", "proj-tag"]);
  });

  test("tags are deduplicated", () => {
    const user = emptyConfig();
    user.defaults.tags = ["shared", "user-only"];

    const project = emptyConfig();
    project.defaults.tags = ["shared", "proj-only"];

    const merged = mergeConfigs(user, project);
    expect(merged.defaults.tags).toEqual(["shared", "user-only", "proj-only"]);
  });

  test("project limits override user limits when non-zero", () => {
    const user = emptyConfig();
    user.limits.maxConcurrent = 10;

    const project = emptyConfig();
    project.limits.maxConcurrent = 3;

    const merged = mergeConfigs(user, project);
    expect(merged.limits.maxConcurrent).toBe(3);
  });

  test("user limits kept when project limits are schema defaults", () => {
    const user = emptyConfig();
    user.limits.maxConcurrent = 10;

    const project = emptyConfig();

    const merged = mergeConfigs(user, project);
    expect(merged.limits.maxConcurrent).toBe(10);
  });

  test("project hooks override user hooks when present", () => {
    const user = emptyConfig();
    user.hooks.postWorktreeCreate = ["bun install"];

    const project = emptyConfig();
    project.hooks.postWorktreeCreate = ["npm install"];

    const merged = mergeConfigs(user, project);
    expect(merged.hooks.postWorktreeCreate).toEqual(["npm install"]);
  });

  test("user hooks kept when project hooks are empty", () => {
    const user = emptyConfig();
    user.hooks.postWorktreeCreate = ["bun install"];

    const project = emptyConfig();

    const merged = mergeConfigs(user, project);
    expect(merged.hooks.postWorktreeCreate).toEqual(["bun install"]);
  });

  test("per-backend defaults are merged across configs", () => {
    const user = emptyConfig();
    user.backendDefaults = {
      codex: { model: "gpt-4", reasoningEffort: "medium" },
      shell: { model: "bash" },
    };

    const project = emptyConfig();
    project.backendDefaults = {
      codex: { reasoningEffort: "high" },
    };

    const merged = mergeConfigs(user, project);
    // project codex overrides user codex fields
    expect(merged.backendDefaults["codex"]?.model).toBe("gpt-4"); // kept from user
    expect(merged.backendDefaults["codex"]?.reasoningEffort).toBe("high"); // overridden by project
    // shell kept from user
    expect(merged.backendDefaults["shell"]?.model).toBe("bash");
  });
});

describe("resolveDefaults", () => {
  function emptyConfig(): OrkaConfig {
    return ConfigSchema.parse({});
  }

  test("returns base defaults when no per-backend or env overrides", () => {
    const config = emptyConfig();
    config.defaults.backend = "claude-code";
    config.defaults.model = "sonnet";

    const resolved = resolveDefaults(config, "claude-code");
    expect(resolved.backend).toBe("claude-code");
    expect(resolved.model).toBe("sonnet");
  });

  test("per-backend defaults override base defaults", () => {
    const config = emptyConfig();
    config.defaults.model = "sonnet";
    config.backendDefaults = {
      codex: { model: "gpt-5.4", reasoningEffort: "high" },
    };

    const resolved = resolveDefaults(config, "codex");
    expect(resolved.model).toBe("gpt-5.4");
    expect(resolved.reasoningEffort).toBe("high");
  });

  test("per-backend tags are merged with base tags", () => {
    const config = emptyConfig();
    config.defaults.tags = ["global"];
    config.backendDefaults = {
      codex: { tags: ["codex-default"] },
    };

    const resolved = resolveDefaults(config, "codex");
    expect(resolved.tags).toEqual(["global", "codex-default"]);
  });

  test("env overrides beat per-backend and base defaults", () => {
    const config = emptyConfig();
    config.defaults.backend = "claude-code";
    config.defaults.model = "sonnet";
    config.backendDefaults = {
      codex: { model: "gpt-5.4" },
    };

    const resolved = resolveDefaults(config, "codex", {
      model: "gpt-4o",
    });
    expect(resolved.model).toBe("gpt-4o");
  });

  test("env overrides are skipped when undefined", () => {
    const config = emptyConfig();
    config.defaults.model = "sonnet";

    const resolved = resolveDefaults(config, "claude-code", {});
    expect(resolved.model).toBe("sonnet");
  });

  test("non-matching backend falls through to base defaults", () => {
    const config = emptyConfig();
    config.defaults.model = "sonnet";
    config.backendDefaults = {
      codex: { model: "gpt-5.4" },
    };

    const resolved = resolveDefaults(config, "claude-code");
    expect(resolved.model).toBe("sonnet");
  });
});
