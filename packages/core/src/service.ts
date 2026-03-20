import type { BackendKind, ChatEntry, Checkpoint, NodeInfo, PermissionMode, SessionId, SessionStatus, SpawnRequest, StoredNode, Task, WorkspaceInfo, WorkspaceMetadata, WorkspaceSettings } from "./types";
import type { ApprovalRequest, ApprovalDecision } from "./approval";
import type { OrchestrationEvent } from "./orchestration";
import type { PushChannel } from "./push-protocol";

export type SessionAction =
  | "sendTurn"
  | "cancelTurn"
  | "stop"
  | "resume"
  | "cancel"
  | "merge"
  | "retry"
  | "archive"
  | "delete";

// --- Spawn Result (minimal DTO returned by spawn) ---

export interface SpawnResult {
  id: SessionId;
  status: SessionStatus;
  title: string;
}

// --- Session Detail Response (returned by getSession) ---

/** Full detail view for a single session. No secrets or server internals. */
export interface SessionDetailResponse {
  id: SessionId;
  status: SessionStatus;
  allowedActions: SessionAction[];
  backend: BackendKind;
  title: string;
  model: string | null;
  prompt: string;
  projectPath: string;
  workingDir: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  kept: boolean;
  autoMerge: boolean;
  parentSessionId: string | null;
  systemPrompt: string | null;
  allowedTools: string[] | null;
  permissionMode: PermissionMode | null;
  archivedAt: string | null;
  tags: string[];
  /** Provider-specific session ID (e.g. Claude Code UUID). Present when session is continuable. */
  providerSessionId: string | null;
  /** True if session runs in-place (no worktree). */
  noWorktree: boolean;
  // Deliberately omitted: env, logFile, rawLogFile, workspaceId, taskId
}

// --- Session List Response (returned by listSessions, getChildSessions) ---

/** Summary view for session lists. Lightweight, no server internals. */
export interface SessionListResponse {
  id: SessionId;
  status: SessionStatus;
  allowedActions: SessionAction[];
  backend: BackendKind;
  title: string;
  model: string | null;
  prompt: string;
  projectPath: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  kept: boolean;
  autoMerge: boolean;
  parentSessionId: string | null;
  permissionMode: PermissionMode | null;
  tags: string[];
  /** True if session runs in-place (no worktree). */
  noWorktree: boolean;
  // No: workspaceId, logFile, rawLogFile, taskId, workingDir, systemPrompt, allowedTools, env
}

// --- Timeline Response (returned by getSessionTimeline) ---

export interface TimelineResponse {
  events: OrchestrationEvent[];
  total: number;
}

export interface TimelineParams {
  sessionId: string;
  offset?: number;
  limit?: number;
}

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

export interface UsageRecord {
  sessionId: string;
  backend: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  model: string | null;
  recordedAt: string;
}

export interface UsageSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  sessionCount: number;
  byBackend: Record<string, { cost: number; inputTokens: number; outputTokens: number; sessions: number }>;
}

// --- Service Types ---

export interface SessionFilters {
  status?: SessionStatus;
  tag?: string;
  includeArchived?: boolean;
}

export interface PruneOptions {
  maxAgeMs: number;
  projectPath?: string;
  confirm?: boolean;
  purgeLogs?: boolean;
  purgeDb?: boolean;
}

export interface PruneResult {
  pruned: number;
  orphansCleaned: number;
  dryRun: boolean;
  logsDeleted?: number;
  dbRecordsDeleted?: number;
}

export interface DiffResult {
  status: string;
  diff: string;
  /** git log of commits on the session branch vs parent (empty if no worktree branch) */
  commitLog?: string;
  /** git diff of all committed changes vs parent branch */
  commitDiff?: string;
}

export interface MergeResult {
  branch: string;
  commits: number;
  cleaned: boolean;
}

// --- Pairing Types ---

export interface StartPairingParams {
  /** TTL in seconds for the enrollment (default: 600 = 10 minutes). */
  ttlSec?: number;
  /** Human-readable node name for display to the pairing client. */
  nodeName?: string;
}

export interface StartPairingResult {
  /** The enrollment ID (hex string) derived from the secret. */
  enrollId: string;
  /** The formatted pairing code for the user to enter on the client side. */
  pairingCode: string;
  /** Unix timestamp (ms) when the enrollment expires. */
  expiresAt: number;
}

// --- Client-side Pairing Types ---

export interface PairWithNodeParams {
  pairingCode: string;
  relayUrl: string;
  relayToken?: string;
}

export interface PairWithNodeResult {
  nodeId: string;
  nodeName: string;
}

// --- OrkaService Interface ---

/**
 * The abstract contract between CLI and daemon.
 * Implementations: LocalClient (in-process), RemoteClient (WS JSON-RPC).
 * All methods return Promises for network transparency.
 * All methods are session-ID-centric — no file paths or implementation
 * details leak through the interface.
 */
export interface OrkaService {
  // --- Session lifecycle ---
  spawn(req: SpawnRequest): Promise<SpawnResult>;
  /** Explicitly close a session — marks it completed, kills process if alive. */
  closeSession(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  reap(): Promise<number>;

  // --- Queries ---
  getSession(id: string): Promise<SessionDetailResponse | null>;
  listSessions(filters?: SessionFilters): Promise<SessionListResponse[]>;
  getChildSessions(sessionId: string): Promise<SessionListResponse[]>;
  getTask(id: string): Promise<Task | null>;

  // --- Session properties ---
  setKept(sessionId: string, kept: boolean): Promise<void>;
  getTags(sessionId: string): Promise<string[]>;

  // --- Session output ---
  getResult(sessionId: string): Promise<SessionResult | null>;
  getSessionTimeline(params: TimelineParams): Promise<TimelineResponse>;
  getChatMessages(sessionId: string): Promise<ChatEntry[]>;
  getUsage(opts?: { sessionId?: string; since?: string; backend?: string }): Promise<UsageSummary>;
  captureOutput(sessionId: string): Promise<string>;
  getLogContent(sessionId: string): Promise<string | null>;
  isAlive(sessionId: string): Promise<boolean>;
  sendTurn(sessionId: string, text: string): Promise<void>;
<<<<<<< HEAD
  /** Cancel the active turn for a running session. Uses turn/interrupt (Codex)
   *  or SIGINT (Claude Code). No-op if no turn is active. */
  cancelTurn(sessionId: string): Promise<void>;
=======
  /** Cancel a queued (not yet delivered) message by matching text. */
  cancelQueuedMessage(sessionId: string, text: string): Promise<void>;
>>>>>>> orka/sess-bc8c014c
  getCheckpoints(sessionId: string): Promise<Checkpoint[]>;
  getTurnDiff(sessionId: string, fromTurn: number, toTurn: number): Promise<{ diff: string }>;
  revertToCheckpoint(sessionId: string, turnSeq: number): Promise<void>;
  revertSession(sessionId: string, turnSeq: number, mode: "files" | "files_and_conversation"): Promise<void>;

  // --- Worktree ---
  getDiff(sessionId: string): Promise<DiffResult>;
  merge(sessionId: string, cleanup?: boolean): Promise<MergeResult>;

  // --- Pairing ---
  startPairing(params: StartPairingParams): Promise<StartPairingResult>;
  pairWithNode(params: PairWithNodeParams): Promise<PairWithNodeResult>;
  listPairedNodes(): Promise<StoredNode[]>;
  removePairedNode(params: { nodeId: string }): Promise<void>;
  connectNode(params: { nodeId: string }): Promise<void>;
  disconnectNode(params: { nodeId: string }): Promise<void>;

  // --- Bulk operations ---
  deleteSessions(ids: string[]): Promise<void>;
  pruneSessions(opts: PruneOptions): Promise<PruneResult>;

  // --- Archive ---
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;

  // --- Approvals ---
  getPendingApprovals(sessionId?: string): Promise<ApprovalRequest[]>;
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  reportEventGap(channel: PushChannel, expectedSeq: number, gotSeq: number): Promise<void>;

  // --- Backfill ---
  backfillSession(sessionId: string): Promise<{ eventsReplayed: number }>;

  // --- Fleet ---
  listNodes(): Promise<NodeInfo[]>;

  // --- Metrics & Observability ---
  getMetrics(): Promise<Record<string, unknown> | null>;
  queryTraces(query?: {
    service?: string;
    errorsOnly?: boolean;
    namePattern?: string;
    limit?: number;
    since?: string;
  }): Promise<Array<Record<string, unknown>>>;

  // --- Terminal PTY ---
  terminalOpen(sessionId: string, opts?: { cols?: number; rows?: number }): Promise<{ termId: string }>;
  terminalWrite(termId: string, data: string): Promise<void>;
  terminalResize(termId: string, cols: number, rows: number): Promise<void>;
  terminalClose(termId: string): Promise<void>;
  terminalList(sessionId: string): Promise<Array<{ id: string; cols: number; rows: number }>>;

  // --- Workspaces ---
  listWorkspaces(opts?: { includeArchived?: boolean }): Promise<WorkspaceInfo[]>;
  getWorkspace(id: string): Promise<WorkspaceInfo>;
  createWorkspace(opts: { name: string; paths?: Array<{ nodeId?: string; path: string }>; settings?: WorkspaceSettings; metadata?: WorkspaceMetadata }): Promise<WorkspaceInfo>;
  updateWorkspace(id: string, opts: Partial<{ name: string; settings: WorkspaceSettings; metadata: WorkspaceMetadata; archivedAt: string | null }>): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  addWorkspacePath(workspaceId: string, path: string, nodeId?: string): Promise<void>;
  removeWorkspacePath(workspaceId: string, path: string, nodeId?: string): Promise<void>;
}
