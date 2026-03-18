/**
 * Initial daemon schema — complete current state.
 * Consolidates the original CREATE TABLE statements plus all 36 historical ALTERs
 * into a single migration that represents the final schema.
 */
import type { Kysely } from "@orka/core/migrate";
import { sql } from "@orka/core/migrate";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      backend TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      backend TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      log_file TEXT NOT NULL DEFAULT '',
      project_path TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      kept INTEGER NOT NULL DEFAULT 0,
      auto_merge INTEGER NOT NULL DEFAULT 0,
      last_diff TEXT,
      system_prompt TEXT,
      allowed_tools TEXT,
      env_json TEXT,
      raw_log_file TEXT,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      archived_at TEXT,
      provider_session_id TEXT,
      permission_mode TEXT,
      no_worktree INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_archived_at ON sessions(archived_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS session_tags (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (session_id, tag)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      backend TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cost_usd REAL,
      model TEXT,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_usage_log_session_id ON usage_log(session_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_usage_log_backend_recorded_at ON usage_log(backend, recorded_at)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS orchestration_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      turn_id TEXT,
      item_id TEXT,
      request_id TEXT,
      provider TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      seq INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_orch_events_session ON orchestration_events(session_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_orch_events_type ON orchestration_events(type)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_orch_events_session_seq ON orchestration_events(session_id, seq)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS client_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error TEXT NOT NULL,
      stack TEXT,
      url TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      received_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_client_errors_timestamp ON client_errors(timestamp DESC)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT,
      settings TEXT,
      metadata TEXT
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS workspace_paths (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL DEFAULT '',
      project_path TEXT NOT NULL,
      PRIMARY KEY (workspace_id, node_id, project_path)
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_workspace_paths_path ON workspace_paths(project_path)`.execute(db);
}
