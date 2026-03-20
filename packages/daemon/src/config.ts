import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse, stringify, TomlDate, type TomlTable, type TomlValue } from "smol-toml";
import { z } from "zod/v4";
import type { ConfigResponse } from "@orka/core";
import { withSpanSync } from "./tracing";

const DefaultsSchema = z.object({
  backend: z.string().default("claude-code"),
  model: z.string().default(""),
  project: z.string().default("."),
  systemPrompt: z.string().default(""),
  reasoningEffort: z.string().default(""),
  tags: z.array(z.string()).default([]),
  permissionMode: z.string().default(""),
});

const PerBackendDefaultsSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  systemPrompt: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export type PerBackendDefaults = z.infer<typeof PerBackendDefaultsSchema>;

const LimitsSchema = z.object({
  maxConcurrent: z.number().default(5),
  sessionTimeoutMinutes: z.number().default(60),
  approvalTimeoutMinutes: z.number().default(5),
  idleTimeoutMinutes: z.number().default(10),
});

const HookCommandSchema = z.object({
  run: z.string(),
});

const HooksSchema = z.object({
  postWorktreeCreate: z.array(z.string()).default([]),
  beforeSpawn: z.string().optional(),
  afterComplete: z.string().optional(),
});

const PermissionsSchema = z.object({
  mode: z.enum(["auto", "supervised", "bypass"]).default("auto"),
  autoApprove: z.array(z.string()).default([]),
  alwaysDeny: z.array(z.string()).default([]),
  approvalTimeout: z.number().default(0),
  bypassConsent: z.boolean().default(false),
});

export const ConfigSchema = z.object({
  defaults: DefaultsSchema.default(DefaultsSchema.parse({})),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
  hooks: HooksSchema.default(HooksSchema.parse({})),
  permissions: PermissionsSchema.default(PermissionsSchema.parse({})),
  backendDefaults: z.record(z.string(), PerBackendDefaultsSchema).default({}),
  env: z.record(z.string(), z.string()).default({}),
  envDynamic: z.record(z.string(), z.string()).default({}),
});

export type OrkaConfig = z.infer<typeof ConfigSchema>;

/**
 * Resolved defaults after merging user config, project config, env vars,
 * and per-backend overrides. All fields are concrete strings (no optionals).
 */
export interface ResolvedDefaults {
  backend: string;
  model: string;
  project: string;
  systemPrompt: string;
  reasoningEffort: string;
  tags: string[];
  permissionMode: string;
}

/**
 * Load configuration from orkaHome/config.toml.
 * Returns a fresh parsed config every call — no caching.
 * Cache in DaemonContext if you need a singleton per process.
 */
export function loadConfig(orkaHome: string): OrkaConfig {
  return withSpanSync("orka.config.load", {}, () => {
    return loadConfigFromFile(join(orkaHome, "config.toml"));
  });
}

/**
 * Load project-level configuration from projectPath/.orka.toml.
 * Returns null if the file doesn't exist (project config is optional).
 */
export function loadProjectConfig(projectPath: string): OrkaConfig | null {
  return withSpanSync("orka.config.load_project", { "config.project_path": projectPath }, () => {
    const configPath = join(projectPath, ".orka.toml");
    if (!existsSync(configPath)) {
      return null;
    }
    return loadConfigFromFile(configPath);
  });
}

function loadConfigFromFile(configPath: string): OrkaConfig {
  if (!existsSync(configPath)) {
    return ConfigSchema.parse({});
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const toml = parse(raw);
    const defaults = getTable(toml["defaults"]);
    const limits = getTable(toml["limits"]);
    const hooks = getTable(toml["hooks"]);
    const permissions = getTable(toml["permissions"]);
    const envTable = getTable(toml["env"]);

    const backendDefaults: Record<string, Record<string, unknown>> = {};
    // Parse per-backend defaults from [defaults.<backend>] subtables
    if (defaults) {
      for (const [key, value] of Object.entries(defaults)) {
        const sub = getTable(value);
        if (sub) {
          backendDefaults[key] = parsePerBackendDefaults(sub);
        }
      }
    }
    // Also parse [backends.<backend>] as an alternative syntax
    const backendsTable = getTable(toml["backends"]);
    if (backendsTable) {
      for (const [key, value] of Object.entries(backendsTable)) {
        const sub = getTable(value);
        if (sub) {
          // [backends.*] entries merge on top of [defaults.*] entries
          backendDefaults[key] = { ...backendDefaults[key], ...parsePerBackendDefaults(sub) };
        }
      }
    }

    // Parse [env] and [env.dynamic] sections
    const staticEnv: Record<string, string> = {};
    const dynamicEnv: Record<string, string> = {};
    if (envTable) {
      for (const [key, value] of Object.entries(envTable)) {
        if (key === "dynamic") {
          const dynamicTable = getTable(value);
          if (dynamicTable) {
            for (const [dk, dv] of Object.entries(dynamicTable)) {
              const sv = getString(dv);
              if (sv !== undefined) dynamicEnv[dk] = sv;
            }
          }
        } else {
          const sv = getString(value);
          if (sv !== undefined) staticEnv[key] = sv;
        }
      }
    }

    return ConfigSchema.parse({
      defaults:
        defaults !== undefined
          ? {
              backend: getString(defaults["backend"]),
              model: getString(defaults["model"]),
              project: getString(defaults["project"]),
              systemPrompt: getString(defaults["system_prompt"] ?? defaults["systemPrompt"]),
              reasoningEffort: getString(defaults["reasoning_effort"] ?? defaults["reasoningEffort"]),
              tags: getStringArray(defaults["tags"]),
              permissionMode: getString(defaults["permission_mode"] ?? defaults["permissionMode"]),
            }
          : undefined,
      limits:
        limits !== undefined
          ? {
              ...(limits["max_concurrent"] !== undefined ? { maxConcurrent: getNumber(limits["max_concurrent"]) } : {}),
              ...(limits["session_timeout_minutes"] !== undefined ? { sessionTimeoutMinutes: getNumber(limits["session_timeout_minutes"]) } : {}),
              ...(limits["approval_timeout_minutes"] !== undefined ? { approvalTimeoutMinutes: getNumber(limits["approval_timeout_minutes"]) } : {}),
              ...(limits["idle_timeout_minutes"] !== undefined ? { idleTimeoutMinutes: getNumber(limits["idle_timeout_minutes"]) } : {}),
            }
          : undefined,
      hooks:
        hooks !== undefined
          ? {
              ...(hooks["post_worktree_create"] !== undefined
                ? { postWorktreeCreate: normalizeHookCommands(hooks["post_worktree_create"]) }
                : {}),
              ...(getString(hooks["before_spawn"]) !== undefined
                ? { beforeSpawn: getString(hooks["before_spawn"]) }
                : {}),
              ...(getString(hooks["after_complete"]) !== undefined
                ? { afterComplete: getString(hooks["after_complete"]) }
                : {}),
            }
          : undefined,
      permissions:
        permissions !== undefined
          ? {
              ...(getString(permissions["mode"]) !== undefined ? { mode: getString(permissions["mode"]) } : {}),
              ...(getStringArray(permissions["auto_approve"] ?? permissions["autoApprove"]) !== undefined
                ? { autoApprove: getStringArray(permissions["auto_approve"] ?? permissions["autoApprove"]) }
                : {}),
              ...(getStringArray(permissions["always_deny"] ?? permissions["alwaysDeny"]) !== undefined
                ? { alwaysDeny: getStringArray(permissions["always_deny"] ?? permissions["alwaysDeny"]) }
                : {}),
              ...(getNumber(permissions["approval_timeout"] ?? permissions["approvalTimeout"]) !== undefined
                ? { approvalTimeout: getNumber(permissions["approval_timeout"] ?? permissions["approvalTimeout"]) }
                : {}),
              ...(getBoolean(permissions["bypass_consent"] ?? permissions["bypassConsent"]) !== undefined
                ? { bypassConsent: getBoolean(permissions["bypass_consent"] ?? permissions["bypassConsent"]) }
                : {}),
            }
          : undefined,
      backendDefaults:
        Object.keys(backendDefaults).length > 0 ? backendDefaults : undefined,
      env:
        Object.keys(staticEnv).length > 0 ? staticEnv : undefined,
      envDynamic:
        Object.keys(dynamicEnv).length > 0 ? dynamicEnv : undefined,
    });
  } catch {
    return ConfigSchema.parse({});
  }
}

function parsePerBackendDefaults(table: TomlTable): Record<string, unknown> {
  return {
    model: getString(table["model"]),
    reasoningEffort: getString(table["reasoning_effort"] ?? table["reasoningEffort"]),
    systemPrompt: getString(table["system_prompt"] ?? table["systemPrompt"]),
    tags: getStringArray(table["tags"]),
  };
}

/**
 * Merge two configs: project config values override user config values.
 * Only non-default / explicitly-set values from the higher-priority config win.
 */
export function mergeConfigs(userConfig: OrkaConfig, projectConfig: OrkaConfig | null): OrkaConfig {
  if (!projectConfig) return userConfig;

  const userDefaults = userConfig.defaults;
  const projDefaults = projectConfig.defaults;
  const schemaDefaults = DefaultsSchema.parse({});

  return {
    defaults: {
      backend: pickOverride(projDefaults.backend, userDefaults.backend, schemaDefaults.backend),
      model: pickOverride(projDefaults.model, userDefaults.model, schemaDefaults.model),
      project: pickOverride(projDefaults.project, userDefaults.project, schemaDefaults.project),
      systemPrompt: pickOverride(projDefaults.systemPrompt, userDefaults.systemPrompt, schemaDefaults.systemPrompt),
      reasoningEffort: pickOverride(projDefaults.reasoningEffort, userDefaults.reasoningEffort, schemaDefaults.reasoningEffort),
      tags: mergeTags(userDefaults.tags, projDefaults.tags),
      permissionMode: pickOverride(projDefaults.permissionMode, userDefaults.permissionMode, schemaDefaults.permissionMode),
    },
    limits: (() => {
      const ld = LimitsSchema.parse({});
      return {
        maxConcurrent: projectConfig.limits.maxConcurrent !== ld.maxConcurrent
          ? projectConfig.limits.maxConcurrent
          : userConfig.limits.maxConcurrent,
        sessionTimeoutMinutes: projectConfig.limits.sessionTimeoutMinutes !== ld.sessionTimeoutMinutes
          ? projectConfig.limits.sessionTimeoutMinutes
          : userConfig.limits.sessionTimeoutMinutes,
        approvalTimeoutMinutes: projectConfig.limits.approvalTimeoutMinutes !== ld.approvalTimeoutMinutes
          ? projectConfig.limits.approvalTimeoutMinutes
          : userConfig.limits.approvalTimeoutMinutes,
        idleTimeoutMinutes: projectConfig.limits.idleTimeoutMinutes !== ld.idleTimeoutMinutes
          ? projectConfig.limits.idleTimeoutMinutes
          : userConfig.limits.idleTimeoutMinutes,
      };
    })(),
    hooks: {
      postWorktreeCreate: projectConfig.hooks.postWorktreeCreate.length > 0
        ? projectConfig.hooks.postWorktreeCreate
        : userConfig.hooks.postWorktreeCreate,
      beforeSpawn: projectConfig.hooks.beforeSpawn ?? userConfig.hooks.beforeSpawn,
      afterComplete: projectConfig.hooks.afterComplete ?? userConfig.hooks.afterComplete,
    },
    permissions: (() => {
      const pd = PermissionsSchema.parse({});
      return {
        mode: projectConfig.permissions.mode !== pd.mode
          ? projectConfig.permissions.mode
          : userConfig.permissions.mode,
        autoApprove: projectConfig.permissions.autoApprove.length > 0
          ? [...new Set([...userConfig.permissions.autoApprove, ...projectConfig.permissions.autoApprove])]
          : userConfig.permissions.autoApprove,
        alwaysDeny: projectConfig.permissions.alwaysDeny.length > 0
          ? [...new Set([...userConfig.permissions.alwaysDeny, ...projectConfig.permissions.alwaysDeny])]
          : userConfig.permissions.alwaysDeny,
        approvalTimeout: projectConfig.permissions.approvalTimeout !== pd.approvalTimeout
          ? projectConfig.permissions.approvalTimeout
          : userConfig.permissions.approvalTimeout,
        bypassConsent: userConfig.permissions.bypassConsent || projectConfig.permissions.bypassConsent,
      };
    })(),
    backendDefaults: {
      ...userConfig.backendDefaults,
      ...Object.fromEntries(
        Object.entries(projectConfig.backendDefaults).map(([key, projBd]) => {
          const userBd = userConfig.backendDefaults[key];
          if (!userBd) return [key, projBd];
          return [key, {
            model: projBd.model ?? userBd.model,
            reasoningEffort: projBd.reasoningEffort ?? userBd.reasoningEffort,
            systemPrompt: projBd.systemPrompt ?? userBd.systemPrompt,
            tags: projBd.tags ?? userBd.tags,
          }];
        }),
      ),
    },
    env: {
      ...userConfig.env,
      ...projectConfig.env,
    },
    envDynamic: {
      ...userConfig.envDynamic,
      ...projectConfig.envDynamic,
    },
  };
}

/**
 * Apply per-backend defaults on top of merged defaults for the selected backend.
 * Then apply env var overrides. Returns fully resolved defaults.
 */
export function resolveDefaults(
  config: OrkaConfig,
  backend: string,
  envOverrides?: { backend?: string; model?: string },
): ResolvedDefaults {
  const base = { ...config.defaults };
  const bd = config.backendDefaults[backend];
  if (bd) {
    if (bd.model) base.model = bd.model;
    if (bd.reasoningEffort) base.reasoningEffort = bd.reasoningEffort;
    if (bd.systemPrompt) base.systemPrompt = bd.systemPrompt;
    if (bd.tags && bd.tags.length > 0) base.tags = mergeTags(base.tags, bd.tags);
  }

  if (envOverrides?.backend) base.backend = envOverrides.backend;
  if (envOverrides?.model) base.model = envOverrides.model;

  return base;
}

function pickOverride(proj: string, user: string, schemaDefault: string): string {
  if (proj !== schemaDefault) return proj;
  return user;
}

function mergeTags(base: string[], overlay: string[]): string[] {
  if (overlay.length === 0) return base;
  if (base.length === 0) return overlay;
  return [...new Set([...base, ...overlay])];
}

function getTable(value: TomlValue | undefined): TomlTable | undefined {
  if (
    value === undefined
    || Array.isArray(value)
    || typeof value !== "object"
    || value === null
    || value instanceof TomlDate
  ) {
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

function getStringArray(value: TomlValue | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  if (value.every((item) => typeof item === "string")) return value as string[];
  return undefined;
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

/**
 * Evaluate dynamic env commands: run each shell command and capture stdout.
 * Commands that fail (non-zero exit) are silently skipped.
 */
export async function evaluateDynamicEnv(
  dynamicEnv: Record<string, string>,
  cwd: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, cmd] of Object.entries(dynamicEnv)) {
    const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      result[key] = output.trim();
    }
  }
  return result;
}

/**
 * Resolve project env: merge static env, dynamic env (evaluated), and CLI env.
 * Priority: CLI env > dynamic env > static env.
 * Returns undefined if no env vars to propagate.
 */
export async function resolveProjectEnv(
  config: OrkaConfig,
  projectPath: string,
  cliEnv?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const staticEnv = config.env;
  const dynamicEnv = Object.keys(config.envDynamic).length > 0
    ? await evaluateDynamicEnv(config.envDynamic, projectPath)
    : {};

  const merged = {
    ...staticEnv,
    ...dynamicEnv,
    ...(cliEnv ?? {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Write bypass_consent = true into the [permissions] section of config.toml.
 * Creates the file if it doesn't exist. Preserves existing content.
 */
export function writeBypassConsent(orkaHome: string): void {
  const configPath = join(orkaHome, "config.toml");
  let toml: Record<string, any> = {};

  if (existsSync(configPath)) {
    try {
      toml = parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    } catch {
      // If parse fails, start fresh
    }
  }

  if (!toml["permissions"] || typeof toml["permissions"] !== "object") {
    toml["permissions"] = {};
  }
  (toml["permissions"] as Record<string, any>)["bypass_consent"] = true;

  writeFileSync(configPath, stringify(toml as any), "utf-8");
}

/** camelCase → snake_case for TOML keys. */
function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * Update a section of ~/.orka/config.toml with the given key-value pairs.
 * Creates the file if it doesn't exist. Keys are converted to snake_case.
 */
export function updateConfigSection(
  orkaHome: string,
  section: string,
  values: Record<string, unknown>,
): void {
  const configPath = join(orkaHome, "config.toml");
  let toml: Record<string, any> = {};

  if (existsSync(configPath)) {
    try {
      toml = parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    } catch {
      // If parse fails, start fresh
    }
  }

  if (!toml[section] || typeof toml[section] !== "object") {
    toml[section] = {};
  }

  const table = toml[section] as Record<string, any>;
  for (const [key, value] of Object.entries(values)) {
    const snakeKey = toSnakeCase(key);
    if (value === undefined || value === null || value === "") {
      delete table[snakeKey];
    } else {
      table[snakeKey] = value;
    }
  }

  writeFileSync(configPath, stringify(toml as any), "utf-8");
}

/**
 * Strip env/envDynamic from OrkaConfig and return a ConfigResponse DTO.
 */
export function configToResponse(config: OrkaConfig): ConfigResponse {
  return {
    defaults: { ...config.defaults },
    limits: { ...config.limits },
    hooks: { ...config.hooks },
    permissions: { ...config.permissions },
    backendDefaults: { ...config.backendDefaults },
  };
}
