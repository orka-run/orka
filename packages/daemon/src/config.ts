import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod/v4";
import { getOrkaHome } from "./db";

export const ConfigSchema = z.object({
  defaults: z
    .object({
      backend: z.string().default("claude-code"),
      mode: z.string().default("interactive"),
      model: z.string().default(""),
      project: z.string().default("."),
    })
    .default({}),
  limits: z
    .object({
      maxConcurrent: z.number().default(0),
    })
    .default({}),
});

export type OrkaConfig = z.infer<typeof ConfigSchema>;

let _config: OrkaConfig | null = null;

export function getConfig(): OrkaConfig {
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
    });
  } catch {
    _config = ConfigSchema.parse({});
  }

  return _config;
}

/** Minimal TOML parser — handles [section] and key = "value" */
function parseSimpleToml(raw: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      result[section] ??= {};
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*"(.+)"$/);
    if (kvMatch && section) {
      result[section]![kvMatch[1]] = kvMatch[2];
    }
  }

  return result;
}
