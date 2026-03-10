import { randomBytes } from "node:crypto";
import { z } from "zod/v4";

// --- IDs ---

export type SessionId = string;
export type TaskId = string;
export type WorkspaceId = string;

export function generateId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

// --- Enums ---

export const BackendKindSchema = z.enum(["claude-code", "codex", "aider", "shell"]);
export type BackendKind = z.infer<typeof BackendKindSchema>;

export const SessionModeSchema = z.enum(["interactive", "background"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const SessionStatusSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export type WorkspaceKind = "repo" | "worktree";

// --- Core Models ---

export interface Task {
  id: TaskId;
  title: string;
  prompt: string;
  backend: BackendKind;
  mode: SessionMode;
  model: string | null;
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
  projectPath: string;
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
