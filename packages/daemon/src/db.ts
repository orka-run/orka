import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Session, Task, SessionStatus } from "@orka/core";

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
  `);

  // Migration: add log_file if missing (for existing DBs)
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN log_file TEXT NOT NULL DEFAULT ''`);
  } catch {
    // column already exists
  }
}

// --- Task CRUD ---

export function insertTask(task: Task): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, prompt, backend, mode, created_at)
       VALUES ($id, $title, $prompt, $backend, $mode, $createdAt)`,
    )
    .run({
      $id: task.id,
      $title: task.title,
      $prompt: task.prompt,
      $backend: task.backend,
      $mode: task.mode,
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
      `INSERT INTO sessions (id, task_id, workspace_id, status, backend, mode, tmux_session_name, working_dir, log_file, created_at, started_at, finished_at, exit_code)
       VALUES ($id, $taskId, $workspaceId, $status, $backend, $mode, $tmuxSessionName, $workingDir, $logFile, $createdAt, $startedAt, $finishedAt, $exitCode)`,
    )
    .run({
      $id: session.id,
      $taskId: session.taskId,
      $workspaceId: session.workspaceId,
      $status: session.status,
      $backend: session.backend,
      $mode: session.mode,
      $tmuxSessionName: session.tmuxSessionName,
      $workingDir: session.workingDir,
      $logFile: session.logFile,
      $createdAt: session.createdAt,
      $startedAt: session.startedAt,
      $finishedAt: session.finishedAt,
      $exitCode: session.exitCode,
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
  db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
  // Delete orphaned tasks
  for (const { task_id } of taskIds) {
    const ref = db.prepare("SELECT 1 FROM sessions WHERE task_id = ? LIMIT 1").get(task_id);
    if (!ref) {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(task_id);
    }
  }
}

// --- Row mappers ---

function rowToTask(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    backend: row.backend,
    mode: row.mode,
    createdAt: row.created_at,
  };
}

function rowToSession(row: any): Session {
  return {
    id: row.id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    status: row.status,
    backend: row.backend,
    mode: row.mode,
    tmuxSessionName: row.tmux_session_name,
    workingDir: row.working_dir,
    logFile: row.log_file ?? "",
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
  };
}
