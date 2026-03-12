import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod/v4";
import type {
  OrchestrationEvent,
  PersistedOrchestrationEvent,
  Session,
  SessionStatus,
  Task,
  UsageRecord,
  UsageSummary,
} from "@orka/core";
import { BackendKindSchema, SessionModeSchema, SessionStatusSchema } from "@orka/core";
import { withSpanSync } from "./tracing";

const TaskRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  backend: BackendKindSchema,
  mode: SessionModeSchema,
  model: z.string().nullable().default(null),
  created_at: z.string(),
});

const SessionRowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  workspace_id: z.string(),
  status: SessionStatusSchema,
  backend: BackendKindSchema,
  mode: SessionModeSchema,
  tmux_session_name: z.string(),
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

function getDbPath(): string {
  const dir = getOrkaHome();
  mkdirSync(dir, { recursive: true });
  return join(dir, DB_FILE);
}

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(getDbPath());
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA busy_timeout = 5000");
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
      tmux_session_name TEXT NOT NULL,
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

// --- Task CRUD ---

export function insertTask(task: Task): void {
  withSpanSync("orka.db.insertTask", { "orka.task.id": task.id }, () => {
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, prompt, backend, mode, model, created_at)
         VALUES ($id, $title, $prompt, $backend, $mode, $model, $createdAt)`,
      )
      .run({
        $id: task.id,
        $title: task.title,
        $prompt: task.prompt,
        $backend: task.backend,
        $mode: task.mode,
        $model: task.model,
        $createdAt: task.createdAt,
      });
  });
}

export function getTask(id: string): Task | null {
  return withSpanSync("orka.db.getTask", { "orka.task.id": id }, () => {
    const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    return row ? rowToTask(row) : null;
  });
}

// --- Session CRUD ---

export function insertSession(session: Session): void {
  withSpanSync("orka.db.insertSession", { "orka.session.id": session.id }, () => {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, task_id, workspace_id, status, backend, mode, tmux_session_name, project_path, working_dir, log_file, created_at, started_at, finished_at, exit_code, kept, auto_merge, system_prompt, allowed_tools, env_json, raw_log_file, parent_session_id)
         VALUES ($id, $taskId, $workspaceId, $status, $backend, $mode, $tmuxSessionName, $projectPath, $workingDir, $logFile, $createdAt, $startedAt, $finishedAt, $exitCode, $kept, $autoMerge, $systemPrompt, $allowedTools, $envJson, $rawLogFile, $parentSessionId)`,
      )
      .run({
        $id: session.id,
        $taskId: session.taskId,
        $workspaceId: session.workspaceId,
        $status: session.status,
        $backend: session.backend,
        $mode: session.mode,
        $tmuxSessionName: session.tmuxSessionName,
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
      });
  });
}

export function updateSessionStatus(
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

    getDb()
      .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $id`)
      .run(params);
  });
}

export function updateSessionRawLogFile(id: string, rawLogFile: string): void {
  withSpanSync("orka.db.updateSessionRawLogFile", { "orka.session.id": id }, () => {
    getDb()
      .prepare("UPDATE sessions SET raw_log_file = ? WHERE id = ?")
      .run(rawLogFile, id);
  });
}

export function setSessionKept(id: string, kept: boolean): void {
  withSpanSync("orka.db.setSessionKept", {}, () => {
    getDb()
      .prepare("UPDATE sessions SET kept = ? WHERE id = ?")
      .run(kept ? 1 : 0, id);
  });
}

export function saveSessionDiff(
  sessionId: string,
  diff: string,
  status: string,
  extra?: { commitLog?: string; commitDiff?: string },
): void {
  withSpanSync("orka.db.saveSessionDiff", { "orka.session.id": sessionId }, () => {
    getDb()
      .prepare("UPDATE sessions SET last_diff = ? WHERE id = ?")
      .run(JSON.stringify({ status, diff, ...extra }), sessionId);
  });
}

export function getSessionDiff(sessionId: string): { status: string; diff: string; commitLog?: string; commitDiff?: string } | null {
  const row = getDb()
    .prepare("SELECT last_diff FROM sessions WHERE id = ?")
    .get(sessionId) as { last_diff: string | null } | undefined;
  if (!row?.last_diff) return null;
  return JSON.parse(row.last_diff);
}

export function getSession(id: string): Session | null {
  return withSpanSync("orka.db.getSession", { "orka.session.id": id }, () => {
    const row = getDb()
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as any;
    return row ? rowToSession(row) : null;
  });
}

export function listSessions(status?: SessionStatus): Session[] {
  return withSpanSync("orka.db.listSessions", {}, () => {
    const db = getDb();
    const rows = status
      ? (db
          .prepare("SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC")
          .all(status) as any[])
      : (db
          .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
          .all() as any[]);
    return rows.map(rowToSession);
  });
}

export function findSessionByTmux(tmuxName: string): Session | null {
  const row = getDb()
    .prepare("SELECT * FROM sessions WHERE tmux_session_name = ?")
    .get(tmuxName) as any;
  return row ? rowToSession(row) : null;
}

// --- Usage ---

export function insertUsageRecord(record: UsageRecord): void {
  withSpanSync("orka.db.insertUsageRecord", {
    "orka.session.id": record.sessionId,
    "orka.backend": record.backend,
  }, () => {
    getDb()
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

export function getUsageBySession(sessionId: string): UsageRecord[] {
  return withSpanSync("orka.db.getUsageBySession", { "orka.session.id": sessionId }, () => {
    const rows = getDb()
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

export function getUsageSummary(opts: { since?: string; backend?: string } = {}): UsageSummary {
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
    const db = getDb();
    const totals = db
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

    const byBackendRows = db
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

export function insertOrchestrationEvent(event: PersistedOrchestrationEvent): void {
  withSpanSync("orka.db.insertOrchestrationEvent", {
    "orka.session.id": event.sessionId,
    "orka.provider": event.provider,
  }, () => {
    const payload = stripPersistedEventFields(event);
    getDb()
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

export function getOrchestrationEvents(sessionId: string): OrchestrationEvent[] {
  return withSpanSync("orka.db.getOrchestrationEvents", { "orka.session.id": sessionId }, () => {
    const rows = getDb()
      .prepare(
        `SELECT payload
         FROM orchestration_events
         WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all(sessionId) as unknown[];
    return rows.map(rowToOrchestrationEvent);
  });
}

export function deleteOrchestrationEvents(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  withSpanSync("orka.db.deleteOrchestrationEvents", { "orka.session.count": sessionIds.length }, () => {
    const placeholders = sessionIds.map(() => "?").join(", ");
    getDb()
      .prepare(`DELETE FROM orchestration_events WHERE session_id IN (${placeholders})`)
      .run(...sessionIds);
  });
}

// --- Delete ---

export function deleteSessions(ids: string[]): void {
  if (ids.length === 0) return;
  withSpanSync("orka.db.deleteSessions", { "orka.session.count": ids.length }, () => {
    const db = getDb();
    const placeholders = ids.map(() => "?").join(", ");
    // Collect task_ids before deleting sessions
    const taskIds = db
      .prepare(`SELECT DISTINCT task_id FROM sessions WHERE id IN (${placeholders})`)
      .all(...ids) as { task_id: string }[];
    deleteOrchestrationEvents(ids);
    db.prepare(`DELETE FROM usage_log WHERE session_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM session_tags WHERE session_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
    // Delete orphaned tasks
    for (const { task_id } of taskIds) {
      const ref = db.prepare("SELECT 1 FROM sessions WHERE task_id = ? LIMIT 1").get(task_id);
      if (!ref) {
        db.prepare("DELETE FROM tasks WHERE id = ?").run(task_id);
      }
    }
  });
}

// --- Tags ---

export function insertSessionTags(sessionId: string, tags: string[]): void {
  withSpanSync("orka.db.insertSessionTags", {}, () => {
    if (tags.length === 0) return;
    const db = getDb();
    const stmt = db.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)");
    for (const tag of tags) {
      stmt.run(sessionId, tag);
    }
  });
}

export function getSessionTags(sessionId: string): string[] {
  return withSpanSync("orka.db.getSessionTags", {}, () => {
    const rows = getDb()
      .prepare("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag")
      .all(sessionId) as { tag: string }[];
    return rows.map((r) => r.tag);
  });
}

export function listSessionsByTag(tag: string): Session[] {
  return withSpanSync("orka.db.listSessionsByTag", {}, () => {
    const rows = getDb()
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

// --- Client errors ---

export interface ClientError {
  id: number;
  error: string;
  stack: string | null;
  url: string;
  timestamp: string;
  receivedAt: string;
}

export function insertClientError(report: { error: string; stack?: string; url: string; timestamp: string }): void {
  withSpanSync("orka.db.insertClientError", {}, () => {
    getDb()
      .prepare(
        `INSERT INTO client_errors (error, stack, url, timestamp, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(report.error, report.stack ?? null, report.url, report.timestamp, new Date().toISOString());
  });
}

export function listClientErrors(limit = 50): ClientError[] {
  return withSpanSync("orka.db.listClientErrors", {}, () => {
    const rows = getDb()
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

export function getChildSessions(parentId: string): Session[] {
  return withSpanSync("orka.db.getChildSessions", { "orka.session.parent_id": parentId }, () => {
    const rows = getDb()
      .prepare("SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC")
      .all(parentId) as any[];
    return rows.map(rowToSession);
  });
}

// --- Row mappers ---

function rowToTask(row: unknown): Task {
  const data = TaskRowSchema.parse(row);
  return {
    id: data.id,
    title: data.title,
    prompt: data.prompt,
    backend: data.backend,
    mode: data.mode,
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
    mode: data.mode,
    tmuxSessionName: data.tmux_session_name,
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
    ...(data.env_json ? { env: JSON.parse(data.env_json) as Record<string, string> } : {}),
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
  return JSON.parse(data.payload) as OrchestrationEvent;
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
