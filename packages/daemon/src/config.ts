import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse, type TomlTable, type TomlValue } from "smol-toml";
import { z } from "zod/v4";
import { withSpanSync } from "./tracing";

const DefaultsSchema = z.object({
  backend: z.string().default("claude-code"),
  mode: z.string().default("background"),
  model: z.string().default(""),
  project: z.string().default("."),
});

const LimitsSchema = z.object({
  maxConcurrent: z.number().default(5),
  sessionTimeoutMinutes: z.number().default(60),
});

const HookCommandSchema = z.object({
  run: z.string(),
});

const HooksSchema = z.object({
  postWorktreeCreate: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  defaults: DefaultsSchema.default(DefaultsSchema.parse({})),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
  hooks: HooksSchema.default(HooksSchema.parse({})),
});

export type OrkaConfig = z.infer<typeof ConfigSchema>;

/**
 * Load configuration from orkaHome/config.toml.
 * Returns a fresh parsed config every call — no caching.
 * Cache in DaemonContext if you need a singleton per process.
 */
export function loadConfig(orkaHome: string): OrkaConfig {
  return withSpanSync("orka.config.load", {}, () => {
    const configPath = join(orkaHome, "config.toml");
    if (!existsSync(configPath)) {
      return ConfigSchema.parse({});
    }

    try {
      const raw = readFileSync(configPath, "utf-8");
      const toml = parse(raw);
      const defaults = getTable(toml.defaults);
      const limits = getTable(toml.limits);
      const hooks = getTable(toml.hooks);

      return ConfigSchema.parse({
        defaults:
          defaults !== undefined
            ? {
                backend: getString(defaults.backend),
                mode: getString(defaults.mode),
                model: getString(defaults.model),
                project: getString(defaults.project),
              }
            : undefined,
        limits:
          limits !== undefined
            ? {
                ...(limits.max_concurrent !== undefined ? { maxConcurrent: getNumber(limits.max_concurrent) } : {}),
                ...(limits.session_timeout_minutes !== undefined ? { sessionTimeoutMinutes: getNumber(limits.session_timeout_minutes) } : {}),
              }
            : undefined,
        hooks:
          hooks?.post_worktree_create !== undefined
            ? { postWorktreeCreate: normalizeHookCommands(hooks.post_worktree_create) }
            : undefined,
      });
    } catch {
      return ConfigSchema.parse({});
    }
  });
}

function getTable(value: TomlValue | undefined): TomlTable | undefined {
  if (value === undefined || Array.isArray(value) || typeof value !== "object" || value === null) {
    return undefined;
  }

  return value;
}

function getString(value: TomlValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: TomlValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function normalizeHookCommands(value: TomlValue | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value)) {
    throw new Error("hooks.post_worktree_create must be a string or array");
  }

  if (value.every((item) => typeof item === "string")) {
    return value;
  }

  return z.array(HookCommandSchema).parse(value).map((item) => item.run);
}
