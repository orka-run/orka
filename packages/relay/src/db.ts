import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod/v4";
import { generateId } from "@orka/core";
import { withSpanSync } from "./tracing";

// --- Zod Row Schemas ---

const AccountStatusSchema = z.enum(["active", "suspended", "deleted"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

const TierSchema = z.enum(["free", "pro", "enterprise"]);
export type Tier = z.infer<typeof TierSchema>;

const KeyPermissionSchema = z.enum(["client", "node", "admin"]);
export type KeyPermission = z.infer<typeof KeyPermissionSchema>;

const KeyStatusSchema = z.enum(["active", "revoked"]);
export type KeyStatus = z.infer<typeof KeyStatusSchema>;

const AccountRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  status: AccountStatusSchema,
  tier: TierSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

const ApiKeyRowSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  key_hash: z.string(),
  key_prefix: z.string(),
  label: z.string(),
  permissions: KeyPermissionSchema,
  status: KeyStatusSchema,
  last_used_at: z.string().nullable(),
  created_at: z.string(),
});

const RateLimitRowSchema = z.object({
  account_id: z.string(),
  requests_per_minute: z.number(),
  requests_per_hour: z.number(),
  concurrent_connections: z.number(),
  max_message_bytes: z.number(),
  updated_at: z.string(),
});

// --- Domain Models ---

export interface Account {
  id: string;
  email: string;
  name: string;
  status: AccountStatus;
  tier: Tier;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  accountId: string;
  keyHash: string;
  keyPrefix: string;
  label: string;
  permissions: KeyPermission;
  status: KeyStatus;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface RateLimitConfig {
  accountId: string;
  requestsPerMinute: number;
  requestsPerHour: number;
  concurrentConnections: number;
  maxMessageBytes: number;
}

export interface UsageEvent {
  accountId: string;
  eventType: string;
  bytesIn: number;
  bytesOut: number;
  nodeId?: string;
  requestMethod?: string;
  timestamp: string;
}

// --- Database Factory ---

const RELAY_DIR = ".orka-relay";
const DB_FILE = "relay.db";

export function getRelayHome(): string {
  return process.env["ORKA_RELAY_DATA"] ?? join(process.env["HOME"] ?? "", RELAY_DIR);
}

/**
 * Open (or create) a relay SQLite database at the given data directory.
 * Each call returns a new, independent Database instance.
 */
export function openRelayDb(dataDir?: string): Database {
  const dir = dataDir ?? getRelayHome();
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, DB_FILE);
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// --- Migrations ---

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  // Future migrations go here
];

function migrate(db: Database): void {
  // Split table creation into individual statements for Bun SQLite compatibility
  const tables = [
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      tier TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'default',
      permissions TEXT NOT NULL DEFAULT 'client',
      status TEXT NOT NULL DEFAULT 'active',
      last_used_at TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id)`,
    `CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      bytes_in INTEGER NOT NULL DEFAULT 0,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      node_id TEXT,
      request_method TEXT,
      timestamp TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_account_ts ON usage_events(account_id, timestamp)`,
    `CREATE TABLE IF NOT EXISTS rate_limit_config (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      requests_per_minute INTEGER NOT NULL DEFAULT 60,
      requests_per_hour INTEGER NOT NULL DEFAULT 1000,
      concurrent_connections INTEGER NOT NULL DEFAULT 10,
      max_message_bytes INTEGER NOT NULL DEFAULT 1048576,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS node_registrations (
      node_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      registered_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (node_id, account_id)
    )`,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  ];
  for (const sql of tables) db.exec(sql);

  const check = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const insert = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");

  for (const { version, sql } of MIGRATIONS) {
    if (!check.get(version)) {
      try { db.exec(sql); } catch { /* column may already exist */ }
      insert.run(version, new Date().toISOString());
    }
  }
}

// --- Account CRUD ---

export function createAccount(db: Database, email: string, name: string): Account {
  return withSpanSync("orka.relay.db.createAccount", { "orka.account.email": email }, () => {
    const now = new Date().toISOString();
    const account: Account = {
      id: generateId("acct"),
      email,
      name,
      status: "active",
      tier: "free",
      createdAt: now,
      updatedAt: now,
    };

    db
      .prepare(
        `INSERT INTO accounts (id, email, name, status, tier, created_at, updated_at)
         VALUES ($id, $email, $name, $status, $tier, $createdAt, $updatedAt)`,
      )
      .run({
        $id: account.id,
        $email: account.email,
        $name: account.name,
        $status: account.status,
        $tier: account.tier,
        $createdAt: account.createdAt,
        $updatedAt: account.updatedAt,
      });

    // Insert default rate limits
    db
      .prepare(
        `INSERT INTO rate_limit_config (account_id, requests_per_minute, requests_per_hour, concurrent_connections, max_message_bytes, updated_at)
         VALUES (?, 60, 1000, 10, 1048576, ?)`,
      )
      .run(account.id, now);

    return account;
  });
}

export function getAccount(db: Database, id: string): Account | null {
  return withSpanSync("orka.relay.db.getAccount", { "orka.account.id": id }, () => {
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as any;
    return row ? rowToAccount(row) : null;
  });
}

export function getAccountByEmail(db: Database, email: string): Account | null {
  return withSpanSync("orka.relay.db.getAccountByEmail", { "orka.account.email": email }, () => {
    const row = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as any;
    return row ? rowToAccount(row) : null;
  });
}

export function updateAccountStatus(db: Database, id: string, status: AccountStatus): void {
  withSpanSync("orka.relay.db.updateAccountStatus", {
    "orka.account.id": id,
    "orka.account.status": status,
  }, () => {
    db
      .prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  });
}

export function updateAccountTier(db: Database, id: string, tier: Tier): void {
  db
    .prepare("UPDATE accounts SET tier = ?, updated_at = ? WHERE id = ?")
    .run(tier, new Date().toISOString(), id);
}

export function listAccounts(db: Database): Account[] {
  const rows = db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all() as any[];
  return rows.map(rowToAccount);
}

// --- API Key CRUD ---

export function insertApiKey(db: Database, record: ApiKeyRecord): void {
  withSpanSync("orka.relay.db.insertApiKey", { "orka.account.id": record.accountId }, () => {
    db
      .prepare(
        `INSERT INTO api_keys (id, account_id, key_hash, key_prefix, label, permissions, status, created_at)
         VALUES ($id, $accountId, $keyHash, $keyPrefix, $label, $permissions, $status, $createdAt)`,
      )
      .run({
        $id: record.id,
        $accountId: record.accountId,
        $keyHash: record.keyHash,
        $keyPrefix: record.keyPrefix,
        $label: record.label,
        $permissions: record.permissions,
        $status: record.status,
        $createdAt: record.createdAt,
      });
  });
}

export function getApiKeyByHash(db: Database, keyHash: string): ApiKeyRecord | null {
  return withSpanSync("orka.relay.db.getApiKey", {}, () => {
    const row = db.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'").get(keyHash) as any;
    return row ? rowToApiKey(row) : null;
  });
}

export function listApiKeys(db: Database, accountId: string): ApiKeyRecord[] {
  return withSpanSync("orka.relay.db.listApiKeys", { "orka.account.id": accountId }, () => {
    const rows = db
      .prepare("SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at DESC")
      .all(accountId) as any[];
    return rows.map(rowToApiKey);
  });
}

export function revokeApiKey(db: Database, keyId: string, accountId: string): boolean {
  return withSpanSync("orka.relay.db.revokeApiKey", { "orka.account.id": accountId, "orka.key.id": keyId }, () => {
    const result = db
      .prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ? AND account_id = ?")
      .run(keyId, accountId);
    return result.changes > 0;
  });
}

export function updateApiKeyLastUsed(db: Database, keyHash: string): void {
  db
    .prepare("UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?")
    .run(new Date().toISOString(), keyHash);
}

// --- Rate Limits ---

export function getRateLimits(db: Database, accountId: string): RateLimitConfig | null {
  const row = db.prepare("SELECT * FROM rate_limit_config WHERE account_id = ?").get(accountId) as any;
  return row ? rowToRateLimits(row) : null;
}

export function updateRateLimits(db: Database, accountId: string, limits: Partial<Omit<RateLimitConfig, "accountId">>): void {
  const sets: string[] = ["updated_at = ?"];
  const params: any[] = [new Date().toISOString()];

  if (limits.requestsPerMinute !== undefined) { sets.push("requests_per_minute = ?"); params.push(limits.requestsPerMinute); }
  if (limits.requestsPerHour !== undefined) { sets.push("requests_per_hour = ?"); params.push(limits.requestsPerHour); }
  if (limits.concurrentConnections !== undefined) { sets.push("concurrent_connections = ?"); params.push(limits.concurrentConnections); }
  if (limits.maxMessageBytes !== undefined) { sets.push("max_message_bytes = ?"); params.push(limits.maxMessageBytes); }

  params.push(accountId);
  db.prepare(`UPDATE rate_limit_config SET ${sets.join(", ")} WHERE account_id = ?`).run(...params);
}

// --- Usage Events (batch insert) ---

export function insertUsageEvents(db: Database, events: UsageEvent[]): void {
  if (events.length === 0) return;
  withSpanSync("orka.relay.db.insertUsageEvents", { "orka.event.count": events.length }, () => {
    const stmt = db.prepare(
      `INSERT INTO usage_events (account_id, event_type, bytes_in, bytes_out, node_id, request_method, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN");
    for (const e of events) {
      stmt.run(e.accountId, e.eventType, e.bytesIn, e.bytesOut, e.nodeId ?? null, e.requestMethod ?? null, e.timestamp);
    }
    db.exec("COMMIT");
  });
}

export interface UsageBucket {
  period: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

export function getAccountUsage(db: Database, accountId: string, from: string, to: string, granularity: "hour" | "day"): UsageBucket[] {
  return withSpanSync("orka.relay.db.queryUsage", {
    "orka.account.id": accountId,
    "orka.usage.granularity": granularity,
  }, () => {
    const fmt = granularity === "hour" ? "%Y-%m-%dT%H:00:00" : "%Y-%m-%d";
    const rows = db
      .prepare(
        `SELECT strftime('${fmt}', timestamp) as period,
                COUNT(*) as requests,
                SUM(bytes_in) as bytes_in,
                SUM(bytes_out) as bytes_out
         FROM usage_events
         WHERE account_id = ? AND timestamp >= ? AND timestamp <= ?
           AND event_type IN ('request', 'response')
         GROUP BY period
         ORDER BY period`,
      )
      .all(accountId, from, to) as any[];

    return rows.map((r) => ({
      period: r.period,
      requests: r.requests,
      bytesIn: r.bytes_in ?? 0,
      bytesOut: r.bytes_out ?? 0,
    }));
  });
}

export function deleteOldUsageEvents(db: Database, olderThan: string): number {
  return withSpanSync("orka.relay.db.deleteOldUsageEvents", {
    "orka.timestamp": olderThan,
  }, () => {
    const result = db
      .prepare("DELETE FROM usage_events WHERE timestamp < ?")
      .run(olderThan);
    return result.changes;
  });
}

export function getAccountCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'active'").get() as any;
  return row?.count ?? 0;
}

// --- Row Mappers ---

function rowToAccount(row: unknown): Account {
  const data = AccountRowSchema.parse(row);
  return {
    id: data.id,
    email: data.email,
    name: data.name,
    status: data.status,
    tier: data.tier,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

function rowToApiKey(row: unknown): ApiKeyRecord {
  const data = ApiKeyRowSchema.parse(row);
  return {
    id: data.id,
    accountId: data.account_id,
    keyHash: data.key_hash,
    keyPrefix: data.key_prefix,
    label: data.label,
    permissions: data.permissions,
    status: data.status,
    lastUsedAt: data.last_used_at,
    createdAt: data.created_at,
  };
}

function rowToRateLimits(row: unknown): RateLimitConfig {
  const data = RateLimitRowSchema.parse(row);
  return {
    accountId: data.account_id,
    requestsPerMinute: data.requests_per_minute,
    requestsPerHour: data.requests_per_hour,
    concurrentConnections: data.concurrent_connections,
    maxMessageBytes: data.max_message_bytes,
  };
}
