import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod/v4";
import { getRelayHome } from "./db";

const ServerSchema = z.object({
  port: z.number().default(7390),
  hostname: z.string().default("0.0.0.0"),
});

const AuthSchema = z.object({
  signupEnabled: z.boolean().default(true),
  requireEmailVerification: z.boolean().default(false),
  adminToken: z.string().optional(),
});

const RateLimitsSchema = z.object({
  defaultRequestsPerMinute: z.number().default(60),
  defaultRequestsPerHour: z.number().default(1000),
  defaultConcurrentConnections: z.number().default(10),
  defaultMaxMessageBytes: z.number().default(1_048_576),
  globalRequestsPerSecond: z.number().default(10_000),
});

const AbuseSchema = z.object({
  maxNodesPerAccount: z.number().default(20),
  maxKeysPerAccount: z.number().default(10),
  connectionRatePerMinute: z.number().default(30),
  suspiciousPatternWindow: z.number().default(300),
});

const ObservabilitySchema = z.object({
  otlpEndpoint: z.string().optional(),
  metricsInterval: z.number().default(60),
  traceFile: z.string().optional(),
});

export const RelayConfigSchema = z.object({
  server: ServerSchema.default(ServerSchema.parse({})),
  auth: AuthSchema.default(AuthSchema.parse({})),
  rateLimits: RateLimitsSchema.default(RateLimitsSchema.parse({})),
  abuse: AbuseSchema.default(AbuseSchema.parse({})),
  observability: ObservabilitySchema.default(ObservabilitySchema.parse({})),
});

export type RelayConfig = z.infer<typeof RelayConfigSchema>;

/**
 * Load relay config from a TOML file.
 * @param dataDir  — override the data directory (default: getRelayHome())
 * @param configPath — explicit path to config file (overrides dataDir-based path)
 */
export function loadRelayConfig(dataDir?: string, configPath?: string): RelayConfig {
  const resolvedConfigPath = configPath
    ?? process.env["ORKA_RELAY_CONFIG"]
    ?? join(dataDir ?? getRelayHome(), "config.toml");

  if (!existsSync(resolvedConfigPath)) {
    return RelayConfigSchema.parse({});
  }

  try {
    const raw = readFileSync(resolvedConfigPath, "utf-8");
    const toml = parseSimpleToml(raw);
    return RelayConfigSchema.parse({
      server: parseSection(toml["server"], {
        port: "number",
        hostname: "string",
      }),
      auth: parseSection(toml["auth"], {
        signup_enabled: { key: "signupEnabled", type: "boolean" },
        require_email_verification: { key: "requireEmailVerification", type: "boolean" },
        admin_token: { key: "adminToken", type: "string" },
      }),
      rateLimits: parseSection(toml["rate_limits"], {
        default_requests_per_minute: { key: "defaultRequestsPerMinute", type: "number" },
        default_requests_per_hour: { key: "defaultRequestsPerHour", type: "number" },
        default_concurrent_connections: { key: "defaultConcurrentConnections", type: "number" },
        default_max_message_bytes: { key: "defaultMaxMessageBytes", type: "number" },
        global_requests_per_second: { key: "globalRequestsPerSecond", type: "number" },
      }),
      abuse: parseSection(toml["abuse"], {
        max_nodes_per_account: { key: "maxNodesPerAccount", type: "number" },
        max_keys_per_account: { key: "maxKeysPerAccount", type: "number" },
        connection_rate_per_minute: { key: "connectionRatePerMinute", type: "number" },
        suspicious_pattern_window: { key: "suspiciousPatternWindow", type: "number" },
      }),
      observability: parseSection(toml["observability"], {
        otlp_endpoint: { key: "otlpEndpoint", type: "string" },
        metrics_interval: { key: "metricsInterval", type: "number" },
        trace_file: { key: "traceFile", type: "string" },
      }),
    });
  } catch {
    return RelayConfigSchema.parse({});
  }
}

// --- TOML Parsing ---

type FieldSpec = "string" | "number" | "boolean" | { key: string; type: "string" | "number" | "boolean" };

function parseSection(
  section: Record<string, string> | undefined,
  fields: Record<string, FieldSpec>,
): Record<string, string | number | boolean> | undefined {
  if (!section) return undefined;

  const result: Record<string, string | number | boolean> = {};
  for (const [tomlKey, spec] of Object.entries(fields)) {
    const value = section[tomlKey];
    if (value === undefined) continue;

    const jsKey = typeof spec === "string" ? tomlKey : spec.key;
    const type = typeof spec === "string" ? spec : spec.type;

    switch (type) {
      case "number":
        result[jsKey] = parseInt(value, 10) || 0;
        break;
      case "boolean":
        result[jsKey] = value === "true" || value === "1";
        break;
      default:
        result[jsKey] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
      const matchedSection = sectionMatch[1];
      if (!matchedSection) {
        continue;
      }
      section = matchedSection;
      result[section] ??= {};
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*"(.+)"$/);
    if (kvMatch && section) {
      const key = kvMatch[1];
      const value = kvMatch[2];
      if (!key || value === undefined) {
        continue;
      }
      const sectionObj = result[section];
      if (sectionObj) {
        sectionObj[key] = value;
      }
    }
  }

  return result;
}
