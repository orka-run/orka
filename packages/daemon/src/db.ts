import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod/v4";
import type { Session, Task, SessionStatus } from "@orka/core";
import { BackendKindSchema, SessionModeSchema, SessionStatusSchema } from "@orka/core";

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
});

const ORKA_DIR = ".orka";
const DB_FILE = "orka.db";

export function getOrkaHome(): string {
  return process.env.ORKA_HOME ?? join(process.env.HOME!, ORKA_DIR);
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
    _db.exec("PRAGMA foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

const MIGRATIONS = [
  { version: 1, sql: `ALTER TABLE sessions ADD COLUMN log_file TEXT NOT NULL DEFAULT ''` },
  { version: 2, sql: `ALTER TABLE sessions ADD COLUMN project_path TEXT NOT NULL DEFAULT ''` },
  { version: 3, sql: `ALTER TABLE tasks ADD COLUMN model TEXT` },
  { version: 4, sql: `ALTER TABLE sessions ADD COLUMN kept INTEGER NOT NULL DEFAULT 0` },
  { version: 5, sql: `ALTER TABLE sessions ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0` },
  { version: 6, sql: `CREATE TABLE IF NOT EXISTS session_tags (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (session_id, tag))` },
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
}

export function getTask(id: string): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  return row ? rowToTask(row) : null;
}

// --- Session CRUD ---

export function insertSession(session: Session): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, task_id, workspace_id, status, backend, mode, tmux_session_name, project_path, working_dir, log_file, created_at, started_at, finished_at, exit_code, kept, auto_merge)
       VALUES ($id, $taskId, $workspaceId, $status, $backend, $mode, $tmuxSessionName, $projectPath, $workingDir, $logFile, $createdAt, $startedAt, $finishedAt, $exitCode, $kept, $autoMerge)`,
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
    });
}

export function updateSessionStatus(
  id: string,
  status: SessionStatus,
  extra?: { startedAt?: string; finishedAt?: string; exitCode?: number },
): void {
  const sets = ["status = $status"];
  const params: Record<string, any> = { $id: id, $status: status };

  if (extra?.startedAt) {
    sets.push("started_at = $startedAt");
    params.$startedAt = extra.startedAt;
  }
  if (extra?.finishedAt) {
    sets.push("finished_at = $finishedAt");
    params.$finishedAt = extra.finishedAt;
  }
  if (extra?.exitCode !== undefined) {
    sets.push("exit_code = $exitCode");
    params.$exitCode = extra.exitCode;
  }

  getDb()
    .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $id`)
    .run(params);
}

export function setSessionKept(id: string, kept: boolean): void {
  getDb()
    .prepare("UPDATE sessions SET kept = ? WHERE id = ?")
    .run(kept ? 1 : 0, id);
}

export function getSession(id: string): Session | null {
  const row = getDb()
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as any;
  return row ? rowToSession(row) : null;
}

export function listSessions(status?: SessionStatus): Session[] {
  const db = getDb();
  const rows = status
    ? (db
        .prepare("SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC")
        .all(status) as any[])
    : (db
        .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
        .all() as any[]);
  return rows.map(rowToSession);
}

export function findSessionByTmux(tmuxName: string): Session | null {
  const row = getDb()
    .prepare("SELECT * FROM sessions WHERE tmux_session_name = ?")
    .get(tmuxName) as any;
  return row ? rowToSession(row) : null;
}

// --- Delete ---

export function deleteSessions(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => "?").join(", ");
  // Collect task_ids before deleting sessions
  const taskIds = db
    .prepare(`SELECT DISTINCT task_id FROM sessions WHERE id IN (${placeholders})`)
    .all(...ids) as { task_id: string }[];
  db.prepare(`DELETE FROM session_tags WHERE session_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
  // Delete orphaned tasks
  for (const { task_id } of taskIds) {
    const ref = db.prepare("SELECT 1 FROM sessions WHERE task_id = ? LIMIT 1").get(task_id);
    if (!ref) {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(task_id);
    }
  }
}

// --- Tags ---

export function insertSessionTags(sessionId: string, tags: string[]): void {
  if (tags.length === 0) return;
  const db = getDb();
  const stmt = db.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)");
  for (const tag of tags) {
    stmt.run(sessionId, tag);
  }
}

export function getSessionTags(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag")
    .all(sessionId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

export function listSessionsByTag(tag: string): Session[] {
  const rows = getDb()
    .prepare(
      `SELECT s.* FROM sessions s
       INNER JOIN session_tags t ON s.id = t.session_id
       WHERE t.tag = ?
       ORDER BY s.created_at DESC`,
    )
    .all(tag) as any[];
  return rows.map(rowToSession);
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
  };
}
