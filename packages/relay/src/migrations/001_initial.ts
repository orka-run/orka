/**
 * Initial relay schema — complete current state.
 */
import type { Kysely } from "@orka/core/migrate";
import { sql } from "@orka/core/migrate";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      tier TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
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
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      bytes_in INTEGER NOT NULL DEFAULT 0,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      node_id TEXT,
      request_method TEXT,
      timestamp TEXT NOT NULL
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_usage_account_ts ON usage_events(account_id, timestamp)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS rate_limit_config (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      requests_per_minute INTEGER NOT NULL DEFAULT 60,
      requests_per_hour INTEGER NOT NULL DEFAULT 1000,
      concurrent_connections INTEGER NOT NULL DEFAULT 10,
      max_message_bytes INTEGER NOT NULL DEFAULT 1048576,
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS node_registrations (
      node_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      registered_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (node_id, account_id)
    )
  `.execute(db);
}
