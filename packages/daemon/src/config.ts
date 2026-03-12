import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
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

const HooksSchema = z.object({
  postWorktreeCreate: z.string().default(""),
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
      const toml = parseSimpleToml(raw);
      _config = ConfigSchema.parse({
        defaults: toml.defaults,
        limits:
          toml.limits?.max_concurrent !== undefined
            ? { maxConcurrent: parseInt(toml.limits.max_concurrent, 10) || 0 }
            : undefined,
        providers:
          toml.providers?.use_runtime !== undefined
            ? { useRuntime: toml.providers.use_runtime === "true" || toml.providers.use_runtime === "1" }
            : undefined,
        hooks:
          toml.hooks?.post_worktree_create !== undefined
            ? { postWorktreeCreate: toml.hooks.post_worktree_create }
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

/** Minimal TOML parser — handles [section] and key = "value"/bare */
function parseSimpleToml(raw: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section = "";

  for (const line of raw.split("\n")) {
    const trimmed = stripInlineComment(line).trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      result[section] ??= {};
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
    if (kvMatch && section) {
      result[section]![kvMatch[1]] = kvMatch[2] ?? kvMatch[3] ?? "";
    }
  }

  return result;
}

function stripInlineComment(line: string): string {
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "#" && !inQuotes) {
      return line.slice(0, index);
    }
  }

  return line;
}
