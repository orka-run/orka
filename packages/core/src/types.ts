import { randomBytes } from "node:crypto";

// --- IDs ---

export type SessionId = string;
export type TaskId = string;
export type WorkspaceId = string;

export function generateId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

// --- Enums ---

export type BackendKind = "claude-code" | "codex" | "aider" | "shell";

export type SessionMode = "interactive" | "background";

export type SessionStatus =
  | "queued"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkspaceKind = "repo" | "worktree";

// --- Core Models ---

export interface Task {
  id: TaskId;
  title: string;
  prompt: string;
  backend: BackendKind;
  mode: SessionMode;
  createdAt: string; // ISO 8601
}

export interface Workspace {
  id: WorkspaceId;
  projectPath: string;
  kind: WorkspaceKind;
  gitBranch: string | null;
  worktreePath: string | null;
}

export interface Session {
  id: SessionId;
  taskId: TaskId;
  workspaceId: WorkspaceId;
  status: SessionStatus;
  backend: BackendKind;
  mode: SessionMode;
  tmuxSessionName: string;
  workingDir: string;
  logFile: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
}

// --- Spawn Request ---

export interface SpawnRequest {
  prompt: string;
  title?: string;
  projectPath: string;
  backend: BackendKind;
  mode: SessionMode;
  branch?: string;
  model?: string;
}
