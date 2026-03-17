import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod/v4";
import type {
  OrchestrationEvent,
  PersistedOrchestrationEvent,
  Session,
  SessionListItem,
  SessionStatus,
  Task,
  UsageRecord,
  UsageSummary,
} from "@orka/core";
import { BackendKindSchema, SessionStatusSchema, parseWireEvent } from "@orka/core";
import { withSpanSync } from "./tracing";

const TaskRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  backend: BackendKindSchema,
  model: z.string().nullable().default(null),
  created_at: z.string(),
});

const SessionRowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  workspace_id: z.string(),
  status: SessionStatusSchema,
  backend: BackendKindSchema,
  project_path: z.string().default(""),
  working_dir: z.string(),
  log_file: z.string().default(""),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  exit_code: z.number().nullable(),
  kept: z.number().default(0),
  auto_merge: z.number().default(0),
  system_prompt: z.string().nullable().default(null),
  allowed_tools: z.string().nullable().default(null),
  env_json: z.string().nullable().default(null),
  raw_log_file: z.string().nullable().default(null),
  parent_session_id: z.string().nullable().default(null),
  archived_at: z.string().nullable().default(null),
  provider_session_id: z.string().nullable().default(null),
});

const UsageLogRowSchema = z.object({
  session_id: z.string(),
  backend: BackendKindSchema,
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_read_tokens: z.number().default(0),
  cost_usd: z.number().nullable().default(null),
  model: z.string().nullable().default(null),
  recorded_at: z.string(),
});

const OrchestrationEventRowSchema = z.object({
  payload: z.string(),
});

const ORKA_DIR = ".orka";
const DB_FILE = "orka.db";

export function getOrkaHome(): string {
  return process.env["ORKA_HOME"] ?? join(process.env["HOME"] ?? "", ORKA_DIR);
}

function getDbPath(orkaHome: string): string {
  mkdirSync(orkaHome, { recursive: true });
  return join(orkaHome, DB_FILE);
}

/**
 * Open (or create) a SQLite database at orkaHome/orka.db and run migrations.
 * Returns the raw Database instance — callers should wrap it in a DatabaseRepository.
 */
export function openDb(orkaHome: string): Database {
  const db = new Database(getDbPath(orkaHome));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

const MIGRATIONS = [
  { version: 1, sql: `ALTER TABLE sessions ADD COLUMN log_file TEXT NOT NULL DEFAULT ''` },
  { version: 2, sql: `ALTER TABLE sessions ADD COLUMN project_path TEXT NOT NULL DEFAULT ''` },
  { version: 3, sql: `ALTER TABLE tasks ADD COLUMN model TEXT` },
  { version: 4, sql: `ALTER TABLE sessions ADD COLUMN kept INTEGER NOT NULL DEFAULT 0` },
  { version: 5, sql: `ALTER TABLE sessions ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0` },
  { version: 6, sql: `CREATE TABLE IF NOT EXISTS session_tags (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (session_id, tag))` },
  { version: 7, sql: `CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, backend TEXT NOT NULL, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cost_usd REAL, model TEXT, recorded_at TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id))` },
  { version: 8, sql: `CREATE INDEX IF NOT EXISTS idx_usage_log_session_id ON usage_log(session_id)` },
  { version: 9, sql: `CREATE INDEX IF NOT EXISTS idx_usage_log_backend_recorded_at ON usage_log(backend, recorded_at)` },
  { version: 10, sql: `ALTER TABLE sessions ADD COLUMN last_diff TEXT` },
  { version: 11, sql: `CREATE TABLE IF NOT EXISTS orchestration_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, turn_id TEXT, item_id TEXT, request_id TEXT, provider TEXT NOT NULL, timestamp TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id))` },
  { version: 12, sql: `CREATE INDEX IF NOT EXISTS idx_orch_events_session ON orchestration_events(session_id)` },
  { version: 13, sql: `CREATE INDEX IF NOT EXISTS idx_orch_events_type ON orchestration_events(type)` },
  { version: 14, sql: `ALTER TABLE sessions ADD COLUMN system_prompt TEXT` },
  { version: 15, sql: `ALTER TABLE sessions ADD COLUMN allowed_tools TEXT` },
  { version: 16, sql: `ALTER TABLE sessions ADD COLUMN env_json TEXT` },
  { version: 17, sql: `CREATE TABLE IF NOT EXISTS client_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, error TEXT NOT NULL, stack TEXT, url TEXT NOT NULL, timestamp TEXT NOT NULL, received_at TEXT NOT NULL)` },
  { version: 18, sql: `CREATE INDEX IF NOT EXISTS idx_client_errors_timestamp ON client_errors(timestamp DESC)` },
  { version: 19, sql: `ALTER TABLE orchestration_events ADD COLUMN seq INTEGER` },
  { version: 20, sql: `UPDATE orchestration_events SET seq = (SELECT COUNT(*) FROM orchestration_events e2 WHERE e2.session_id = orchestration_events.session_id AND e2.rowid <= orchestration_events.rowid) WHERE seq IS NULL` },
  { version: 21, sql: `CREATE INDEX IF NOT EXISTS idx_orch_events_session_seq ON orchestration_events(session_id, seq)` },
  { version: 22, sql: `ALTER TABLE sessions ADD COLUMN raw_log_file TEXT` },
  { version: 23, sql: `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL` },
  { version: 24, sql: `CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)` },
  { version: 25, sql: `ALTER TABLE sessions ADD COLUMN archived_at TEXT` },
  { version: 26, sql: `ALTER TABLE sessions DROP COLUMN tmux_session_name` },
  { version: 27, sql: `CREATE INDEX IF NOT EXISTS idx_sessions_archived_at ON sessions(archived_at)` },
  { version: 28, sql: `ALTER TABLE sessions ADD COLUMN provider_session_id TEXT` },
];

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      backend TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      backend TEXT NOT NULL,
      mode TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      log_file TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

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
    );

    CREATE INDEX IF NOT EXISTS idx_usage_log_session_id ON usage_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_log_backend_recorded_at ON usage_log(backend, recorded_at);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const check = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const insert = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");

  for (const { version, sql } of MIGRATIONS) {
    if (!check.get(version)) {
      try { db.exec(sql); } catch { /* column may already exist from pre-versioned migration */ }
      insert.run(version, new Date().toISOString());
    }
  }
}

// --- Client error interface (used by DatabaseRepository and rpc-handler) ---

export interface ClientError {
  id: number;
  error: string;
  stack: string | null;
  url: string;
  timestamp: string;
  receivedAt: string;
}

// --- Repository class ---

/**
 * All database operations bundled together.
 * Construct with an open Database; then pass the repository through DaemonContext.
 */
export class DatabaseRepository {
  constructor(private readonly db: Database) {}

  close(): void {
    this.db.close();
  }

  /** Quick health check — runs SELECT 1 to verify DB is responsive. */
  isHealthy(): boolean {
    try {
      const row = this.db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  // --- Task CRUD ---

  insertTask(task: Task): void {
    withSpanSync("orka.db.insertTask", { "orka.task.id": task.id }, () => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, title, prompt, backend, mode, model, created_at)
           VALUES ($id, $title, $prompt, $backend, $mode, $model, $createdAt)`,
        )
        .run({
          $id: task.id,
          $title: task.title,
          $prompt: task.prompt,
          $backend: task.backend,
          $mode: "background",
          $model: task.model,
          $createdAt: task.createdAt,
        });
    });
  }

  getTask(id: string): Task | null {
    return withSpanSync("orka.db.getTask", { "orka.task.id": id }, () => {
      const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
      return row ? rowToTask(row) : null;
    });
  }

  // --- Session CRUD ---

  insertSession(session: Session): void {
    withSpanSync("orka.db.insertSession", { "orka.session.id": session.id }, () => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, task_id, workspace_id, status, backend, mode, project_path, working_dir, log_file, created_at, started_at, finished_at, exit_code, kept, auto_merge, system_prompt, allowed_tools, env_json, raw_log_file, parent_session_id, provider_session_id)
           VALUES ($id, $taskId, $workspaceId, $status, $backend, $mode, $projectPath, $workingDir, $logFile, $createdAt, $startedAt, $finishedAt, $exitCode, $kept, $autoMerge, $systemPrompt, $allowedTools, $envJson, $rawLogFile, $parentSessionId, $providerSessionId)`,
        )
        .run({
          $id: session.id,
          $taskId: session.taskId,
          $workspaceId: session.workspaceId,
          $status: session.status,
          $backend: session.backend,
          $mode: "background",
          $projectPath: session.projectPath,
          $workingDir: session.workingDir,
          $logFile: session.logFile,
          $createdAt: session.createdAt,
          $startedAt: session.startedAt,
          $finishedAt: session.finishedAt,
          $exitCode: session.exitCode,
          $kept: session.kept ? 1 : 0,
          $autoMerge: session.autoMerge ? 1 : 0,
          $systemPrompt: session.systemPrompt ?? null,
          $allowedTools: session.allowedTools ? JSON.stringify(session.allowedTools) : null,
          $envJson: session.env ? JSON.stringify(session.env) : null,
          $rawLogFile: session.rawLogFile ?? null,
          $parentSessionId: session.parentSessionId ?? null,
          $providerSessionId: session.providerSessionId ?? null,
        });
    });
  }

  updateSessionStatus(
    id: string,
    status: SessionStatus,
    extra?: { startedAt?: string; finishedAt?: string; exitCode?: number },
  ): void {
    withSpanSync("orka.db.updateSessionStatus", { "orka.session.id": id, "orka.session.status": status }, () => {
      const sets = ["status = $status"];
      const params: Record<string, any> = { $id: id, $status: status };

      if (extra?.startedAt) {
        sets.push("started_at = $startedAt");
        params["$startedAt"] = extra.startedAt;
      }
      if (extra?.finishedAt) {
        sets.push("finished_at = $finishedAt");
        params["$finishedAt"] = extra.finishedAt;
      }
      if (extra?.exitCode !== undefined) {
        sets.push("exit_code = $exitCode");
        params["$exitCode"] = extra.exitCode;
      }

      this.db
        .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $id`)
        .run(params);
    });
  }

  updateSessionRawLogFile(id: string, rawLogFile: string): void {
    withSpanSync("orka.db.updateSessionRawLogFile", { "orka.session.id": id }, () => {
      this.db
        .prepare("UPDATE sessions SET raw_log_file = ? WHERE id = ?")
        .run(rawLogFile, id);
    });
  }

  setSessionKept(id: string, kept: boolean): void {
    withSpanSync("orka.db.setSessionKept", {}, () => {
      this.db
        .prepare("UPDATE sessions SET kept = ? WHERE id = ?")
        .run(kept ? 1 : 0, id);
    });
  }

  /** Reset a completed/failed session back to running for continuation. */
  resetSessionForContinue(id: string, startedAt: string): void {
    withSpanSync("orka.db.resetSessionForContinue", { "orka.session.id": id }, () => {
      this.db
        .prepare(
          `UPDATE sessions SET status = 'running', started_at = ?, finished_at = NULL, exit_code = NULL WHERE id = ?`,
        )
        .run(startedAt, id);
    });
  }

  saveSessionDiff(
    sessionId: string,
    diff: string,
    status: string,
    extra?: { commitLog?: string; commitDiff?: string },
  ): void {
    withSpanSync("orka.db.saveSessionDiff", { "orka.session.id": sessionId }, () => {
      this.db
        .prepare("UPDATE sessions SET last_diff = ? WHERE id = ?")
        .run(JSON.stringify({ status, diff, ...extra }), sessionId);
    });
  }

  getSessionDiff(sessionId: string): { status: string; diff: string; commitLog?: string; commitDiff?: string } | null {
    const row = this.db
      .prepare("SELECT last_diff FROM sessions WHERE id = ?")
      .get(sessionId) as { last_diff: string | null } | undefined;
    if (!row?.last_diff) return null;
    return JSON.parse(row.last_diff);
  }

  getSession(id: string): Session | null {
    return withSpanSync("orka.db.getSession", { "orka.session.id": id }, () => {
      const row = this.db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(id) as any;
      return row ? rowToSession(row) : null;
    });
  }

  listSessions(status?: SessionStatus, includeArchived = false): Session[] {
    return withSpanSync("orka.db.listSessions", {}, () => {
      const archiveFilter = includeArchived ? "" : " AND archived_at IS NULL";
      const rows = status
        ? (this.db
            .prepare(`SELECT * FROM sessions WHERE status = ?${archiveFilter} ORDER BY created_at DESC`)
            .all(status) as any[])
        : (this.db
            .prepare(`SELECT * FROM sessions WHERE 1=1${archiveFilter} ORDER BY created_at DESC`)
            .all() as any[]);
      return rows.map(rowToSession);
    });
  }

  /** List sessions with task fields inlined (avoids N+1 getTask calls). */
  listSessionItems(status?: SessionStatus, includeArchived = false): SessionListItem[] {
    return withSpanSync("orka.db.listSessionItems", {}, () => {
      const archiveFilter = includeArchived ? "" : " AND s.archived_at IS NULL";
      const query = status
        ? `SELECT s.*, t.title, t.model, t.prompt FROM sessions s LEFT JOIN tasks t ON s.task_id = t.id WHERE s.status = ?${archiveFilter} ORDER BY s.created_at DESC`
        : `SELECT s.*, t.title, t.model, t.prompt FROM sessions s LEFT JOIN tasks t ON s.task_id = t.id WHERE 1=1${archiveFilter} ORDER BY s.created_at DESC`;
      const rows = status
        ? (this.db.prepare(query).all(status) as any[])
        : (this.db.prepare(query).all() as any[]);
      return rows.map(rowToSessionListItem);
    });
  }

  archiveSession(sessionId: string): void {
    withSpanSync("orka.db.archiveSession", { "orka.session.id": sessionId }, () => {
      this.db
        .prepare("UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
        .run(new Date().toISOString(), sessionId);
    });
  }

  unarchiveSession(sessionId: string): void {
    withSpanSync("orka.db.unarchiveSession", { "orka.session.id": sessionId }, () => {
      this.db
        .prepare("UPDATE sessions SET archived_at = NULL WHERE id = ?")
        .run(sessionId);
    });
  }

  archiveSessions(ids: string[]): number {
    if (ids.length === 0) return 0;
    return withSpanSync("orka.db.archiveSessions", { "orka.session.count": ids.length }, () => {
      const now = new Date().toISOString();
      const placeholders = ids.map(() => "?").join(", ");
      const result = this.db
        .prepare(`UPDATE sessions SET archived_at = ? WHERE id IN (${placeholders}) AND archived_at IS NULL`)
        .run(now, ...ids);
      return result.changes;
    });
  }

  // --- Usage ---

  insertUsageRecord(record: UsageRecord): void {
    withSpanSync("orka.db.insertUsageRecord", {
      "orka.session.id": record.sessionId,
      "orka.backend": record.backend,
    }, () => {
      this.db
        .prepare(
          `INSERT INTO usage_log (
             session_id,
             backend,
             input_tokens,
             output_tokens,
             cache_read_tokens,
             cost_usd,
             model,
             recorded_at
           )
           SELECT
             $sessionId,
             $backend,
             $inputTokens,
             $outputTokens,
             $cacheReadTokens,
             $costUsd,
             $model,
             $recordedAt
           WHERE NOT EXISTS (
             SELECT 1 FROM usage_log WHERE session_id = $sessionId
           )`,
        )
        .run({
          $sessionId: record.sessionId,
          $backend: record.backend,
          $inputTokens: record.inputTokens,
          $outputTokens: record.outputTokens,
          $cacheReadTokens: record.cacheReadTokens,
          $costUsd: record.costUsd,
          $model: record.model,
          $recordedAt: record.recordedAt,
        });
    });
  }

  getUsageBySession(sessionId: string): UsageRecord[] {
    return withSpanSync("orka.db.getUsageBySession", { "orka.session.id": sessionId }, () => {
      const rows = this.db
        .prepare(
          `SELECT session_id, backend, input_tokens, output_tokens, cache_read_tokens, cost_usd, model, recorded_at
           FROM usage_log
           WHERE session_id = ?
           ORDER BY recorded_at DESC`,
        )
        .all(sessionId) as any[];
      return rows.map(rowToUsageRecord);
    });
  }

  getUsageSummary(opts: { since?: string; backend?: string } = {}): UsageSummary {
    return withSpanSync("orka.db.getUsageSummary", {}, () => {
      const clauses: string[] = [];
      const params: any[] = [];

      if (opts.since) {
        clauses.push("recorded_at >= ?");
        params.push(opts.since);
      }
      if (opts.backend) {
        clauses.push("backend = ?");
        params.push(opts.backend);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const totals = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS total_cost_usd,
             COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
             COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
             COUNT(DISTINCT session_id) AS session_count
           FROM usage_log
           ${where}`,
        )
        .get(...params) as {
          total_cost_usd: number;
          total_input_tokens: number;
          total_output_tokens: number;
          total_cache_read_tokens: number;
          session_count: number;
        } | null;

      const byBackendRows = this.db
        .prepare(
          `SELECT
             backend,
             COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COUNT(DISTINCT session_id) AS sessions
           FROM usage_log
           ${where}
           GROUP BY backend
           ORDER BY cost DESC, backend ASC`,
        )
        .all(...params) as Array<{
          backend: string;
          cost: number;
          input_tokens: number;
          output_tokens: number;
          sessions: number;
        }>;

      return {
        totalCostUsd: totals?.total_cost_usd ?? 0,
        totalInputTokens: totals?.total_input_tokens ?? 0,
        totalOutputTokens: totals?.total_output_tokens ?? 0,
        totalCacheReadTokens: totals?.total_cache_read_tokens ?? 0,
        sessionCount: totals?.session_count ?? 0,
        byBackend: Object.fromEntries(
          byBackendRows.map((row) => [
            row.backend,
            {
              cost: row.cost,
              inputTokens: row.input_tokens,
              outputTokens: row.output_tokens,
              sessions: row.sessions,
            },
          ]),
        ),
      };
    });
  }

  // --- Orchestration events ---

  insertOrchestrationEvent(event: PersistedOrchestrationEvent): void {
    withSpanSync("orka.db.insertOrchestrationEvent", {
      "orka.session.id": event.sessionId,
      "orka.provider": event.provider,
    }, () => {
      const payload = stripPersistedEventFields(event);
      this.db
        .prepare(
          `INSERT INTO orchestration_events (
             event_id,
             session_id,
             type,
             payload,
             turn_id,
             item_id,
             request_id,
             provider,
             timestamp,
             seq
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
             (SELECT COALESCE(MAX(seq), 0) + 1 FROM orchestration_events WHERE session_id = ?))`,
        )
        .run(
          event.eventId,
          event.sessionId,
          event.type,
          JSON.stringify(payload),
          getTurnId(payload),
          getItemId(payload),
          getRequestId(payload),
          event.provider,
          event.timestamp,
          event.sessionId,
        );
    });
  }

  getOrchestrationEvents(sessionId: string, offset?: number, limit?: number): OrchestrationEvent[] {
    return withSpanSync("orka.db.getOrchestrationEvents", { "orka.session.id": sessionId }, () => {
      let sql = `SELECT payload FROM orchestration_events WHERE session_id = ? ORDER BY seq ASC`;
      const args: any[] = [sessionId];
      if (limit !== undefined) {
        sql += ` LIMIT ?`;
        args.push(limit);
        if (offset !== undefined) {
          sql += ` OFFSET ?`;
          args.push(offset);
        }
      }
      const rows = this.db.prepare(sql).all(...args) as unknown[];
      return rows.map(rowToOrchestrationEvent);
    });
  }

  getOrchestrationEventCount(sessionId: string): number {
    return withSpanSync("orka.db.getOrchestrationEventCount", { "orka.session.id": sessionId }, () => {
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM orchestration_events WHERE session_id = ?")
        .get(sessionId) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    });
  }

  deleteOrchestrationEvents(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    withSpanSync("orka.db.deleteOrchestrationEvents", { "orka.session.count": sessionIds.length }, () => {
      const placeholders = sessionIds.map(() => "?").join(", ");
      this.db
        .prepare(`DELETE FROM orchestration_events WHERE session_id IN (${placeholders})`)
        .run(...sessionIds);
    });
  }

  // --- Delete ---

  deleteSessions(ids: string[]): void {
    if (ids.length === 0) return;
    withSpanSync("orka.db.deleteSessions", { "orka.session.count": ids.length }, () => {
      const placeholders = ids.map(() => "?").join(", ");
      // Collect task_ids before deleting sessions
      const taskIds = this.db
        .prepare(`SELECT DISTINCT task_id FROM sessions WHERE id IN (${placeholders})`)
        .all(...ids) as { task_id: string }[];
      this.deleteOrchestrationEvents(ids);
      this.db.prepare(`DELETE FROM usage_log WHERE session_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM session_tags WHERE session_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
      // Delete orphaned tasks
      for (const { task_id } of taskIds) {
        const ref = this.db.prepare("SELECT 1 FROM sessions WHERE task_id = ? LIMIT 1").get(task_id);
        if (!ref) {
          this.db.prepare("DELETE FROM tasks WHERE id = ?").run(task_id);
        }
      }
    });
  }

  // --- Tags ---

  insertSessionTags(sessionId: string, tags: string[]): void {
    withSpanSync("orka.db.insertSessionTags", {}, () => {
      if (tags.length === 0) return;
      const stmt = this.db.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)");
      for (const tag of tags) {
        stmt.run(sessionId, tag);
      }
    });
  }

  getSessionTags(sessionId: string): string[] {
    return withSpanSync("orka.db.getSessionTags", {}, () => {
      const rows = this.db
        .prepare("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag")
        .all(sessionId) as { tag: string }[];
      return rows.map((r) => r.tag);
    });
  }

  /** Batch-fetch tags for multiple sessions. Returns a map of sessionId → tags[]. */
  getSessionTagsBatch(sessionIds: string[]): Map<string, string[]> {
    if (sessionIds.length === 0) return new Map();
    return withSpanSync("orka.db.getSessionTagsBatch", { "orka.session.count": sessionIds.length }, () => {
      const placeholders = sessionIds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT session_id, tag FROM session_tags WHERE session_id IN (${placeholders}) ORDER BY tag`)
        .all(...sessionIds) as { session_id: string; tag: string }[];
      const map = new Map<string, string[]>();
      for (const row of rows) {
        let tags = map.get(row.session_id);
        if (!tags) {
          tags = [];
          map.set(row.session_id, tags);
        }
        tags.push(row.tag);
      }
      return map;
    });
  }

  listSessionsByTag(tag: string): Session[] {
    return withSpanSync("orka.db.listSessionsByTag", {}, () => {
      const rows = this.db
        .prepare(
          `SELECT s.* FROM sessions s
           INNER JOIN session_tags t ON s.id = t.session_id
           WHERE t.tag = ?
           ORDER BY s.created_at DESC`,
        )
        .all(tag) as any[];
      return rows.map(rowToSession);
    });
  }

  /** List sessions by tag with task fields inlined (avoids N+1 getTask calls). */
  listSessionItemsByTag(tag: string): SessionListItem[] {
    return withSpanSync("orka.db.listSessionItemsByTag", {}, () => {
      const rows = this.db
        .prepare(
          `SELECT s.*, tk.title, tk.model, tk.prompt FROM sessions s
           INNER JOIN session_tags t ON s.id = t.session_id
           LEFT JOIN tasks tk ON s.task_id = tk.id
           WHERE t.tag = ?
           ORDER BY s.created_at DESC`,
        )
        .all(tag) as any[];
      return rows.map(rowToSessionListItem);
    });
  }

  // --- Client errors ---

  insertClientError(report: { error: string; stack?: string; url: string; timestamp: string }): void {
    withSpanSync("orka.db.insertClientError", {}, () => {
      this.db
        .prepare(
          `INSERT INTO client_errors (error, stack, url, timestamp, received_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(report.error, report.stack ?? null, report.url, report.timestamp, new Date().toISOString());
    });
  }

  listClientErrors(limit = 50): ClientError[] {
    return withSpanSync("orka.db.listClientErrors", {}, () => {
      const rows = this.db
        .prepare("SELECT id, error, stack, url, timestamp, received_at FROM client_errors ORDER BY id DESC LIMIT ?")
        .all(limit) as Array<{ id: number; error: string; stack: string | null; url: string; timestamp: string; received_at: string }>;
      return rows.map((row) => ({
        id: row.id,
        error: row.error,
        stack: row.stack,
        url: row.url,
        timestamp: row.timestamp,
        receivedAt: row.received_at,
      }));
    });
  }

  // --- Child sessions ---

  getChildSessions(parentId: string): Session[] {
    return withSpanSync("orka.db.getChildSessions", { "orka.session.parent_id": parentId }, () => {
      const rows = this.db
        .prepare("SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC")
        .all(parentId) as any[];
      return rows.map(rowToSession);
    });
  }

  /** List child sessions with task fields inlined (avoids N+1 getTask calls). */
  listChildSessionItems(parentId: string): SessionListItem[] {
    return withSpanSync("orka.db.listChildSessionItems", { "orka.session.parent_id": parentId }, () => {
      const rows = this.db
        .prepare(
          `SELECT s.*, t.title, t.model, t.prompt FROM sessions s
           LEFT JOIN tasks t ON s.task_id = t.id
           WHERE s.parent_session_id = ?
           ORDER BY s.created_at DESC`,
        )
        .all(parentId) as any[];
      return rows.map(rowToSessionListItem);
    });
  }
}

// --- Row mappers ---

function rowToTask(row: unknown): Task {
  const data = TaskRowSchema.parse(row);
  return {
    id: data.id,
    title: data.title,
    prompt: data.prompt,
    backend: data.backend,
    model: data.model,
    createdAt: data.created_at,
  };
}

function rowToSession(row: unknown): Session {
  const data = SessionRowSchema.parse(row);
  return {
    id: data.id,
    taskId: data.task_id,
    workspaceId: data.workspace_id,
    status: data.status,
    backend: data.backend,
    projectPath: data.project_path,
    workingDir: data.working_dir,
    logFile: data.log_file,
    createdAt: data.created_at,
    startedAt: data.started_at,
    finishedAt: data.finished_at,
    exitCode: data.exit_code,
    kept: data.kept === 1,
    autoMerge: data.auto_merge === 1,
    ...(data.parent_session_id ? { parentSessionId: data.parent_session_id } : {}),
    ...(data.raw_log_file ? { rawLogFile: data.raw_log_file } : {}),
    ...(data.system_prompt ? { systemPrompt: data.system_prompt } : {}),
    ...(data.allowed_tools ? { allowedTools: JSON.parse(data.allowed_tools) as string[] } : {}),
    // env is deliberately omitted — it contains secrets (API keys, tokens) and must never
    // cross the RPC wire. The env is stored in the DB for auditing but only used at spawn time.
    ...(data.archived_at ? { archivedAt: data.archived_at } : {}),
    ...(data.provider_session_id ? { providerSessionId: data.provider_session_id } : {}),
  };
}

function rowToSessionListItem(row: unknown): SessionListItem {
  const data = row as Record<string, unknown>;
  const session = rowToSession(row);
  return {
    ...session,
    title: (data["title"] as string) ?? session.id,
    model: (data["model"] as string | null) ?? null,
    prompt: (data["prompt"] as string) ?? "",
  };
}

function rowToUsageRecord(row: unknown): UsageRecord {
  const data = UsageLogRowSchema.parse(row);
  return {
    sessionId: data.session_id,
    backend: data.backend,
    inputTokens: data.input_tokens,
    outputTokens: data.output_tokens,
    cacheReadTokens: data.cache_read_tokens,
    costUsd: data.cost_usd,
    model: data.model,
    recordedAt: data.recorded_at,
  };
}

function rowToOrchestrationEvent(row: unknown): OrchestrationEvent {
  const data = OrchestrationEventRowSchema.parse(row);
  const payload = JSON.parse(data.payload) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid orchestration event payload");
  }

  // Validate and normalize via wire schema — handles unknown types, version
  // migration, and forward-compatible parsing.
  const event = parseWireEvent(payload);
  if (!event) {
    throw new Error("Invalid orchestration event payload: failed wire schema validation");
  }
  return event;
}

function stripPersistedEventFields(event: PersistedOrchestrationEvent): OrchestrationEvent {
  const { provider: _provider, eventId: _eventId, ...payload } = event;
  return payload;
}

function getTurnId(event: OrchestrationEvent): string | null {
  return "turnId" in event ? (event.turnId ?? null) : null;
}

function getItemId(event: OrchestrationEvent): string | null {
  return "itemId" in event ? (event.itemId ?? null) : null;
}

function getRequestId(event: OrchestrationEvent): string | null {
  return "requestId" in event ? (event.requestId ?? null) : null;
}
