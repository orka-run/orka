import type { Session, SessionStatus, SpawnRequest, Task } from "./types";

// --- Session Result (moved from daemon/result-parser) ---

export interface SessionResult {
  result: string;
  isError: boolean;
  durationMs: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string | null;
  numTurns: number;
}

// --- Service Types ---

export interface SessionFilters {
  status?: SessionStatus;
  tag?: string;
}

export interface PruneOptions {
  maxAgeMs: number;
  projectPath?: string;
}

export interface PruneResult {
  pruned: number;
  orphansCleaned: number;
}

export interface DiffResult {
  status: string;
  diff: string;
}

export interface MergeResult {
  branch: string;
  commits: number;
  cleaned: boolean;
}

// --- OrkaService Interface ---

/**
 * The abstract contract between CLI and daemon.
 * Implementations: LocalClient (in-process), RemoteClient (WS JSON-RPC).
 * All methods return Promises for network transparency.
 * All methods are session-ID-centric — no tmux names, file paths, or
 * implementation details leak through the interface.
 */
export interface OrkaService {
  // --- Session lifecycle ---
  spawn(req: SpawnRequest): Promise<Session>;
  stop(sessionId: string): Promise<void>;
  reap(): Promise<number>;

  // --- Queries ---
  getSession(id: string): Promise<Session | null>;
  listSessions(filters?: SessionFilters): Promise<Session[]>;
  getTask(id: string): Promise<Task | null>;

  // --- Session properties ---
  setKept(sessionId: string, kept: boolean): Promise<void>;
  getTags(sessionId: string): Promise<string[]>;

  // --- Session output ---
  getResult(sessionId: string): Promise<SessionResult | null>;
  captureOutput(sessionId: string): Promise<string>;
  getLogContent(sessionId: string): Promise<string | null>;
  isAlive(sessionId: string): Promise<boolean>;
  sendInput(sessionId: string, text: string): Promise<void>;

  // --- Worktree ---
  getDiff(sessionId: string): Promise<DiffResult>;
  merge(sessionId: string, cleanup?: boolean): Promise<MergeResult>;

  // --- Bulk operations ---
  deleteSessions(ids: string[]): Promise<void>;
  pruneSessions(opts: PruneOptions): Promise<PruneResult>;
}
