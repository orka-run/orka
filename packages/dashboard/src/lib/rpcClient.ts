import type { WsTransport, RequestOptions } from "./wsTransport";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEntry,
  Checkpoint,
  DiffResult,
  MergeResult,
  NodeInfo,
  PairWithNodeParams,
  PairWithNodeResult,
  PruneOptions,
  PruneResult,
  PushChannel,
  SessionDetailResponse,
  SessionFilters,
  SessionListResponse,
  SessionResult,
  SpawnRequest,
  SpawnResult,
  StartPairingParams,
  StartPairingResult,
  StoredNode,
  Task,
  TimelineParams,
  TimelineResponse,
  UsageSummary,
  WorkspaceInfo,
  WorkspaceMetadata,
  WorkspaceSettings,
} from "@orka/core";

export function createRpcClient(ws: WsTransport) {
  function rpc<T>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
    return ws.request<T>(method, params, options);
  }

  return {
    // --- Session lifecycle ---
    spawn: (req: SpawnRequest, options?: RequestOptions) =>
      rpc<SpawnResult>("spawn", req, options),
    stop: (sessionId: string, options?: RequestOptions) =>
      rpc<void>("stop", { sessionId }, options),
    reap: (options?: RequestOptions) =>
      rpc<number>("reap", undefined, options),

    // --- Queries ---
    getSession: (id: string, options?: RequestOptions) =>
      rpc<SessionDetailResponse | null>("getSession", { id }, options),
    listSessions: (filters?: SessionFilters, options?: RequestOptions) =>
      rpc<SessionListResponse[]>("listSessions", filters, options),
    getChildSessions: (sessionId: string, options?: RequestOptions) =>
      rpc<SessionListResponse[]>("getChildSessions", { sessionId }, options),
    getTask: (id: string, options?: RequestOptions) =>
      rpc<Task | null>("getTask", { id }, options),

    // --- Session properties ---
    setKept: (sessionId: string, kept: boolean, options?: RequestOptions) =>
      rpc<void>("setKept", { sessionId, kept }, options),
    getTags: (sessionId: string, options?: RequestOptions) =>
      rpc<string[]>("getTags", { sessionId }, options),

    // --- Session output ---
    getResult: (sessionId: string, options?: RequestOptions) =>
      rpc<SessionResult | null>("getResult", { sessionId }, options),
    getSessionTimeline: (params: TimelineParams, options?: RequestOptions) =>
      rpc<TimelineResponse>("getSessionTimeline", params, options),
    getChatMessages: (sessionId: string, options?: RequestOptions) =>
      rpc<ChatEntry[]>("getChatMessages", { sessionId }, options),
    getUsage: (opts?: { sessionId?: string; since?: string; backend?: string }, options?: RequestOptions) =>
      rpc<UsageSummary>("getUsage", opts, options),
    captureOutput: (sessionId: string, options?: RequestOptions) =>
      rpc<string>("captureOutput", { sessionId }, options),
    getLogContent: (sessionId: string, options?: RequestOptions) =>
      rpc<string | null>("getLogContent", { sessionId }, options),
    isAlive: (sessionId: string, options?: RequestOptions) =>
      rpc<boolean>("isAlive", { sessionId }, options),
    sendTurn: (sessionId: string, text: string, options?: RequestOptions) =>
      rpc<void>("sendTurn", { sessionId, text }, options),
    closeSession: (sessionId: string, options?: RequestOptions) =>
      rpc<void>("closeSession", { sessionId }, options),
    getCheckpoints: (sessionId: string, options?: RequestOptions) =>
      rpc<Checkpoint[]>("getCheckpoints", { sessionId }, options),
    getTurnDiff: (sessionId: string, fromTurn: number, toTurn: number, options?: RequestOptions) =>
      rpc<{ diff: string }>("getTurnDiff", { sessionId, fromTurn, toTurn }, options),

    // --- Worktree ---
    getDiff: (sessionId: string, options?: RequestOptions) =>
      rpc<DiffResult>("getDiff", { sessionId }, options),
    merge: (sessionId: string, cleanup?: boolean, options?: RequestOptions) =>
      rpc<MergeResult>("merge", { sessionId, cleanup }, options),

    // --- Pairing ---
    startPairing: (params: StartPairingParams, options?: RequestOptions) =>
      rpc<StartPairingResult>("startPairing", params, options),
    pairWithNode: (params: PairWithNodeParams, options?: RequestOptions) =>
      rpc<PairWithNodeResult>("pairWithNode", params, options),
    listPairedNodes: (options?: RequestOptions) =>
      rpc<StoredNode[]>("listPairedNodes", undefined, options),
    removePairedNode: (nodeId: string, options?: RequestOptions) =>
      rpc<void>("removePairedNode", { nodeId }, options),
    connectNode: (nodeId: string, options?: RequestOptions) =>
      rpc<void>("connectNode", { nodeId }, options),
    disconnectNode: (nodeId: string, options?: RequestOptions) =>
      rpc<void>("disconnectNode", { nodeId }, options),

    // --- Bulk operations ---
    deleteSessions: (ids: string[], options?: RequestOptions) =>
      rpc<void>("deleteSessions", { ids }, options),
    pruneSessions: (opts: PruneOptions, options?: RequestOptions) =>
      rpc<PruneResult>("pruneSessions", opts, options),

    // --- Archive ---
    archiveSession: (sessionId: string, options?: RequestOptions) =>
      rpc<void>("archiveSession", { sessionId }, options),
    unarchiveSession: (sessionId: string, options?: RequestOptions) =>
      rpc<void>("unarchiveSession", { sessionId }, options),

    // --- Approvals ---
    getPendingApprovals: (sessionId?: string, options?: RequestOptions) =>
      rpc<ApprovalRequest[]>("getPendingApprovals", sessionId !== undefined ? { sessionId } : undefined, options),
    resolveApproval: (requestId: string, decision: ApprovalDecision, options?: RequestOptions) =>
      rpc<void>("resolveApproval", { requestId, decision }, options),
    reportEventGap: (channel: PushChannel, expectedSeq: number, gotSeq: number, options?: RequestOptions) =>
      rpc<void>("reportEventGap", { channel, expectedSeq, gotSeq }, options),

    // --- Backfill ---
    backfillSession: (sessionId: string, options?: RequestOptions) =>
      rpc<{ eventsReplayed: number }>("backfillSession", { sessionId }, options),

    // --- Fleet ---
    listNodes: (options?: RequestOptions) =>
      rpc<NodeInfo[]>("listNodes", undefined, options),

    // --- Metrics & Observability ---
    getMetrics: (options?: RequestOptions) =>
      rpc<Record<string, unknown> | null>("getMetrics", undefined, options),
    queryTraces: (query?: { service?: string; errorsOnly?: boolean; namePattern?: string; limit?: number; since?: string }, options?: RequestOptions) =>
      rpc<Array<Record<string, unknown>>>("queryTraces", query, options),

    // --- Terminal PTY ---
    terminalOpen: (sessionId: string, opts?: { cols?: number; rows?: number }, options?: RequestOptions) =>
      rpc<{ termId: string }>("terminalOpen", { sessionId, ...opts }, options),
    terminalWrite: (termId: string, data: string, options?: RequestOptions) =>
      rpc<void>("terminalWrite", { termId, data }, options),
    terminalResize: (termId: string, cols: number, rows: number, options?: RequestOptions) =>
      rpc<void>("terminalResize", { termId, cols, rows }, options),
    terminalClose: (termId: string, options?: RequestOptions) =>
      rpc<void>("terminalClose", { termId }, options),
    terminalList: (sessionId: string, options?: RequestOptions) =>
      rpc<Array<{ id: string; cols: number; rows: number }>>("terminalList", { sessionId }, options),

    // --- Workspaces ---
    listWorkspaces: (opts?: { includeArchived?: boolean }, options?: RequestOptions) =>
      rpc<WorkspaceInfo[]>("listWorkspaces", opts, options),
    getWorkspace: (id: string, options?: RequestOptions) =>
      rpc<WorkspaceInfo>("getWorkspace", { id }, options),
    createWorkspace: (opts: { name: string; paths?: Array<{ nodeId?: string; path: string }>; settings?: WorkspaceSettings; metadata?: WorkspaceMetadata }, options?: RequestOptions) =>
      rpc<WorkspaceInfo>("createWorkspace", opts, options),
    updateWorkspace: (id: string, opts: Partial<{ name: string; settings: WorkspaceSettings; metadata: WorkspaceMetadata; archivedAt: string | null }>, options?: RequestOptions) =>
      rpc<void>("updateWorkspace", { id, ...opts }, options),
    deleteWorkspace: (id: string, options?: RequestOptions) =>
      rpc<void>("deleteWorkspace", { id }, options),
    addWorkspacePath: (workspaceId: string, path: string, nodeId?: string, options?: RequestOptions) =>
      rpc<void>("addWorkspacePath", { workspaceId, path, nodeId }, options),
    removeWorkspacePath: (workspaceId: string, path: string, nodeId?: string, options?: RequestOptions) =>
      rpc<void>("removeWorkspacePath", { workspaceId, path, nodeId }, options),

    // --- Dashboard-specific (not in OrkaService) ---
    retrySession: (sessionId: string, options?: RequestOptions) =>
      rpc<void>("retrySession", { sessionId }, options),
    stopSession: (sessionId: string, options?: RequestOptions) =>
      rpc<void>("stop", { sessionId }, options),
    reportClientError: (report: unknown, options?: RequestOptions) =>
      rpc<void>("reportClientError", report, options),
  };
}

export type RpcClient = ReturnType<typeof createRpcClient>;
