import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod/v4";
import { generateId } from "@orka/core";

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

// --- Database Singleton ---

const RELAY_DIR = ".orka-relay";
const DB_FILE = "relay.db";

export function getRelayHome(): string {
  return process.env.ORKA_RELAY_DATA ?? join(process.env.HOME!, RELAY_DIR);
}

function getDbPath(): string {
  const dir = getRelayHome();
  mkdirSync(dir, { recursive: true });
  return join(dir, DB_FILE);
}

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(getDbPath());
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// --- Migrations ---

const MIGRATIONS = [
  // Future migrations go here
];

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      tier TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'default',
      permissions TEXT NOT NULL DEFAULT 'client',
      status TEXT NOT NULL DEFAULT 'active',
      last_used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      bytes_in INTEGER NOT NULL DEFAULT 0,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      node_id TEXT,
      request_method TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_account_ts ON usage_events(account_id, timestamp);

    CREATE TABLE IF NOT EXISTS rate_limit_config (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      requests_per_minute INTEGER NOT NULL DEFAULT 60,
      requests_per_hour INTEGER NOT NULL DEFAULT 1000,
      concurrent_connections INTEGER NOT NULL DEFAULT 10,
      max_message_bytes INTEGER NOT NULL DEFAULT 1048576,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_registrations (
      node_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      registered_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (node_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

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

export function createAccount(email: string, name: string): Account {
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

  getDb()
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
  getDb()
    .prepare(
      `INSERT INTO rate_limit_config (account_id, requests_per_minute, requests_per_hour, concurrent_connections, max_message_bytes, updated_at)
       VALUES (?, 60, 1000, 10, 1048576, ?)`,
    )
    .run(account.id, now);

  return account;
}

export function getAccount(id: string): Account | null {
  const row = getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as any;
  return row ? rowToAccount(row) : null;
}

export function getAccountByEmail(email: string): Account | null {
  const row = getDb().prepare("SELECT * FROM accounts WHERE email = ?").get(email) as any;
  return row ? rowToAccount(row) : null;
}

export function updateAccountStatus(id: string, status: AccountStatus): void {
  getDb()
    .prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), id);
}

export function updateAccountTier(id: string, tier: Tier): void {
  getDb()
    .prepare("UPDATE accounts SET tier = ?, updated_at = ? WHERE id = ?")
    .run(tier, new Date().toISOString(), id);
}

export function listAccounts(): Account[] {
  const rows = getDb().prepare("SELECT * FROM accounts ORDER BY created_at DESC").all() as any[];
  return rows.map(rowToAccount);
}

// --- API Key CRUD ---

export function insertApiKey(record: ApiKeyRecord): void {
  getDb()
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
}

export function getApiKeyByHash(keyHash: string): ApiKeyRecord | null {
  const row = getDb().prepare("SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'").get(keyHash) as any;
  return row ? rowToApiKey(row) : null;
}

export function listApiKeys(accountId: string): ApiKeyRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at DESC")
    .all(accountId) as any[];
  return rows.map(rowToApiKey);
}

export function revokeApiKey(keyId: string, accountId: string): boolean {
  const result = getDb()
    .prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ? AND account_id = ?")
    .run(keyId, accountId);
  return result.changes > 0;
}

export function updateApiKeyLastUsed(keyHash: string): void {
  getDb()
    .prepare("UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?")
    .run(new Date().toISOString(), keyHash);
}

// --- Rate Limits ---

export function getRateLimits(accountId: string): RateLimitConfig | null {
  const row = getDb().prepare("SELECT * FROM rate_limit_config WHERE account_id = ?").get(accountId) as any;
  return row ? rowToRateLimits(row) : null;
}

export function updateRateLimits(accountId: string, limits: Partial<Omit<RateLimitConfig, "accountId">>): void {
  const sets: string[] = ["updated_at = ?"];
  const params: any[] = [new Date().toISOString()];

  if (limits.requestsPerMinute !== undefined) { sets.push("requests_per_minute = ?"); params.push(limits.requestsPerMinute); }
  if (limits.requestsPerHour !== undefined) { sets.push("requests_per_hour = ?"); params.push(limits.requestsPerHour); }
  if (limits.concurrentConnections !== undefined) { sets.push("concurrent_connections = ?"); params.push(limits.concurrentConnections); }
  if (limits.maxMessageBytes !== undefined) { sets.push("max_message_bytes = ?"); params.push(limits.maxMessageBytes); }

  params.push(accountId);
  getDb().prepare(`UPDATE rate_limit_config SET ${sets.join(", ")} WHERE account_id = ?`).run(...params);
}

// --- Usage Events (batch insert) ---

export function insertUsageEvents(events: UsageEvent[]): void {
  if (events.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO usage_events (account_id, event_type, bytes_in, bytes_out, node_id, request_method, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  for (const e of events) {
    stmt.run(e.accountId, e.eventType, e.bytesIn, e.bytesOut, e.nodeId ?? null, e.requestMethod ?? null, e.timestamp);
  }
  db.exec("COMMIT");
}

export interface UsageBucket {
  period: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

export function getAccountUsage(accountId: string, from: string, to: string, granularity: "hour" | "day"): UsageBucket[] {
  const fmt = granularity === "hour" ? "%Y-%m-%dT%H:00:00" : "%Y-%m-%d";
  const rows = getDb()
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
}

export function deleteOldUsageEvents(olderThan: string): number {
  const result = getDb()
    .prepare("DELETE FROM usage_events WHERE timestamp < ?")
    .run(olderThan);
  return result.changes;
}

export function getAccountCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'active'").get() as any;
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
