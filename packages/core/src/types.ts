import { z } from "zod/v4";

// --- IDs ---

export type SessionId = string;
export type TaskId = string;
export type WorkspaceId = string;

export function generateId(prefix: string): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

// --- Enums ---

export const BackendKindSchema = z.enum(["claude-code", "codex"]);
export type BackendKind = z.infer<typeof BackendKindSchema>;

export const PermissionModeSchema = z.enum(["bypass", "supervised", "auto"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const SessionStatusSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "idle",
  "hibernated",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export type WorkspaceKind = "repo" | "worktree";

// --- Core Models ---

export interface Task {
  id: TaskId;
  title: string;
  prompt: string;
  backend: BackendKind;
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

/** Normalized session entity (matches DB schema). */
export interface Session {
  id: SessionId;
  taskId: TaskId;
  workspaceId: WorkspaceId;
  status: SessionStatus;
  backend: BackendKind;
  projectPath: string;
  workingDir: string;
  logFile: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  kept: boolean;
  autoMerge: boolean;
  permissionMode?: PermissionMode;
  parentSessionId?: string;
  rawLogFile?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  archivedAt?: string;
  /** Provider-specific session ID (e.g. Claude Code UUID), used for --resume on continuation. */
  providerSessionId?: string;
}

/** Denormalized session with task fields inlined. Returned by listSessions API
 *  to avoid N+1 getTask calls. Dashboard uses this for session lists. */
export interface SessionListItem extends Session {
  title: string;
  model: string | null;
  prompt: string;
}

// --- Session Summary (for aggregation cache) ---

export interface SessionSummary {
  id: SessionId;
  status: SessionStatus;
  backend: BackendKind;
  title: string;
  createdAt: string;
  nodeId: string | null;
}

// --- Node Info ---

export interface NodeInfo {
  id: string;
  status: "online" | "offline";
  activeRequests: number;
  registeredAt: number;
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
  | { kind: "user"; timestamp: string; body: string }
  | { kind: "assistant"; timestamp: string; body: string }
  | { kind: "tool"; timestamp: string; title: string; summary: string; icon: "command" | "file"; details?: string[] }
  | { kind: "error"; timestamp: string; title: string; body: string };

// --- Spawn Request ---

export const ReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

// --- Stored Node (daemon-side node registry) ---

export interface StoredNode {
  nodeId: string;
  nodeName: string;
  relayUrl: string;
  relayToken?: string;
  nodePaths: string[];
  pairedAt: string; // ISO 8601
  noiseStaticPubkey: string; // base64url, 32 bytes
  noiseKeyId: string; // "sha256:..."
  autoConnect: boolean; // default true
}

export interface SpawnRequest {
  prompt: string;
  title?: string;
  projectPath: string;
  backend: BackendKind;
  branch?: string;
  model?: string;
  /** Reasoning effort for models that support it (codex: none/minimal/low/medium/high/xhigh). */
  reasoningEffort?: ReasoningEffort;
  autoMerge?: boolean;
  tags?: string[];
  parentSessionId?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  /** Target node ID for relay routing. Omit for least-loaded scheduling. */
  nodeId?: string;
  /** Permission mode: bypass (all tools auto-approved), supervised (dashboard approval), auto (Claude auto-approves). */
  permissionMode?: PermissionMode;
}
