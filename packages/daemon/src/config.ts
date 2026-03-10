import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getOrkaHome } from "./db";

export interface OrkaConfig {
  defaults: {
    backend: string;
    mode: string;
    model: string;
    project: string;
  };
}

const DEFAULT_CONFIG: OrkaConfig = {
  defaults: {
    backend: "claude-code",
    mode: "interactive",
    model: "",
    project: ".",
  },
};

let _config: OrkaConfig | null = null;

export function getConfig(): OrkaConfig {
  if (_config) return _config;

  const configPath = join(getOrkaHome(), "config.toml");
  if (!existsSync(configPath)) {
    _config = DEFAULT_CONFIG;
    return _config;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseSimpleToml(raw);
    _config = {
      defaults: {
        backend: parsed.defaults?.backend ?? DEFAULT_CONFIG.defaults.backend,
        mode: parsed.defaults?.mode ?? DEFAULT_CONFIG.defaults.mode,
        model: parsed.defaults?.model ?? DEFAULT_CONFIG.defaults.model,
        project: parsed.defaults?.project ?? DEFAULT_CONFIG.defaults.project,
      },
    };
  } catch {
    _config = DEFAULT_CONFIG;
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
