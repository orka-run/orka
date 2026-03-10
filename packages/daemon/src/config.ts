import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getOrkaHome } from "./db";

export interface OrkaConfig {
  defaults: {
    backend?: string;
    mode?: string;
    project?: string;
  };
}

let cached: OrkaConfig | null = null;

export function getConfig(): OrkaConfig {
  if (cached) return cached;

  const configPath = join(getOrkaHome(), "config.toml");

  if (!existsSync(configPath)) {
    cached = { defaults: {} };
    return cached;
  }

  const text = readFileSync(configPath, "utf-8");
  cached = parseSimpleToml(text);
  return cached;
}

function parseSimpleToml(text: string): OrkaConfig {
  const config: OrkaConfig = { defaults: {} };
  let currentSection = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"$/);
    if (kvMatch && currentSection === "defaults") {
      const key = kvMatch[1] as keyof OrkaConfig["defaults"];
      config.defaults[key] = kvMatch[2];
    }
  }

  return config;
}
