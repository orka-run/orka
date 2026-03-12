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

export const BackendKindSchema = z.enum(["claude-code", "codex", "shell"]);
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
  kept: boolean;
  autoMerge: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
}

export interface SessionProjection {
  sessionId: string;
  status: SessionStatus;
  currentTurnId: string | null;
  totalCost: number;
  totalTokens: {
    input: number;
    output: number;
  };
  pendingRequests: Array<{ requestId: string; requestType: string }>;
  timeToFirstOutputMs: number | null;
  bootTimeMs: number | null;
  avgTurnDurationMs: number | null;
  totalActiveDurationMs: number | null;
}

// --- Chat Entries ---

export type ChatEntry =
  | { kind: "system"; timestamp: string; title: string; body?: string }
  | { kind: "assistant"; timestamp: string; body: string }
  | { kind: "tool"; timestamp: string; title: string; summary: string; icon: "command" | "file"; details?: string[] }
  | { kind: "error"; timestamp: string; title: string; body: string };

// --- Spawn Request ---

export const ReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export interface SpawnRequest {
  prompt: string;
  title?: string;
  projectPath: string;
  backend: BackendKind;
  mode: SessionMode;
  branch?: string;
  model?: string;
  /** Reasoning effort for models that support it (codex: none/minimal/low/medium/high/xhigh). */
  reasoningEffort?: ReasoningEffort;
  autoMerge?: boolean;
  tags?: string[];
  systemPrompt?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
}
