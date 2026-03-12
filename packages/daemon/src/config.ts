import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse, type TomlTable, type TomlValue } from "smol-toml";
import { z } from "zod/v4";
import { getOrkaHome } from "./db";
import { withSpanSync } from "./tracing";

const DefaultsSchema = z.object({
  backend: z.string().default("claude-code"),
  mode: z.string().default("interactive"),
  model: z.string().default(""),
  project: z.string().default("."),
});

const LimitsSchema = z.object({
  maxConcurrent: z.number().default(0),
});

const ProvidersSchema = z.object({
  useRuntime: z.boolean().default(true),
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
  providers: ProvidersSchema.default(ProvidersSchema.parse({})),
  hooks: HooksSchema.default(HooksSchema.parse({})),
});

export type OrkaConfig = z.infer<typeof ConfigSchema>;

let _config: OrkaConfig | null = null;

export function getConfig(): OrkaConfig {
  return withSpanSync("orka.config.load", {}, () => {
    if (_config) return _config;

    const configPath = join(getOrkaHome(), "config.toml");
    if (!existsSync(configPath)) {
      _config = ConfigSchema.parse({});
      return _config;
    }

    try {
      const raw = readFileSync(configPath, "utf-8");
      const toml = parse(raw);
      const defaults = getTable(toml.defaults);
      const limits = getTable(toml.limits);
      const providers = getTable(toml.providers);
      const hooks = getTable(toml.hooks);

      _config = ConfigSchema.parse({
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
          limits?.max_concurrent !== undefined
            ? { maxConcurrent: getNumber(limits.max_concurrent) }
            : undefined,
        providers:
          providers?.use_runtime !== undefined
            ? { useRuntime: getBoolean(providers.use_runtime) }
            : undefined,
        hooks:
          hooks?.post_worktree_create !== undefined
            ? { postWorktreeCreate: normalizeHookCommands(hooks.post_worktree_create) }
            : undefined,
      });
    } catch {
      _config = ConfigSchema.parse({});
    }

    return _config;
  });
}

export function resetConfigCache(): void {
  _config = null;
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

function getBoolean(value: TomlValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
