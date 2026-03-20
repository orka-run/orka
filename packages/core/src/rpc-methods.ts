/**
 * Typed RPC method map — compile-time safety for all client/server RPC calls.
 *
 * Maps every JSON-RPC method name to its wire { params, result } shape.
 * This is the single source of truth for the client↔server contract.
 *
 * Used to constrain OrkaClient.request(), WsTransport.request(),
 * RemoteNodeManager.request(), dashboard RpcClient, and daemon dispatch.
 */

import type { ChatEntry, Checkpoint, NodeInfo, SpawnRequest, StoredNode, Task, WorkspaceInfo, WorkspaceMetadata, WorkspaceSettings } from "./types";
import type { ApprovalDecision, ApprovalRequest } from "./approval";
import type { PushChannel } from "./push-protocol";
import type {
  DiffResult,
  MergeResult,
  PairWithNodeParams,
  PairWithNodeResult,
  PruneOptions,
  PruneResult,
  SessionDetailResponse,
  SessionFilters,
  SessionListResponse,
  SessionListResult,
  SessionResult,
  SpawnResult,
  StartPairingParams,
  StartPairingResult,
  TimelineParams,
  TimelineResponse,
  UsageSummary,
} from "./service";

/**
 * Maps every JSON-RPC method name to its wire params and result types.
 *
 * - params: the exact shape sent as JSON-RPC `params` on the wire
 *   (undefined means no params required)
 * - result: the JSON-RPC `result` value (void for fire-and-forget methods)
 */
export interface RpcMethodMap {
  // --- Session lifecycle ---
  spawn: { params: SpawnRequest; result: SpawnResult };
  closeSession: { params: { sessionId: string }; result: void };
  stop: { params: { sessionId: string }; result: void };
  reap: { params: undefined; result: number };

  // --- Queries ---
  getSession: { params: { id: string }; result: SessionDetailResponse | null };
  listSessions: { params: { filters?: SessionFilters } | undefined; result: SessionListResult };
  getChildSessions: { params: { sessionId: string }; result: SessionListResponse[] };
  getTask: { params: { id: string }; result: Task | null };

  // --- Session properties ---
  setKept: { params: { sessionId: string; kept: boolean }; result: void };
  getTags: { params: { sessionId: string }; result: string[] };

  // --- Session output ---
  getResult: { params: { sessionId: string }; result: SessionResult | null };
  getSessionTimeline: { params: TimelineParams; result: TimelineResponse };
  getChatMessages: { params: { sessionId: string }; result: ChatEntry[] };
  getUsage: {
    params: { sessionId?: string; since?: string; backend?: string } | undefined;
    result: UsageSummary;
  };
  captureOutput: { params: { sessionId: string }; result: string };
  getLogContent: { params: { sessionId: string }; result: string | null };
  isAlive: { params: { sessionId: string }; result: boolean };
  sendTurn: { params: { sessionId: string; text: string }; result: void };
  cancelTurn: { params: { sessionId: string }; result: void };
  cancelQueuedMessage: { params: { sessionId: string; text: string }; result: void };
  getCheckpoints: { params: { sessionId: string }; result: Checkpoint[] };
  getTurnDiff: {
    params: { sessionId: string; fromTurn: number; toTurn: number };
    result: { diff: string };
  };
  revertToCheckpoint: { params: { sessionId: string; turnSeq: number }; result: void };
  revertSession: {
    params: { sessionId: string; turnSeq: number; mode: "files" | "files_and_conversation" };
    result: void;
  };

  // --- Worktree ---
  getDiff: { params: { sessionId: string }; result: DiffResult };
  merge: { params: { sessionId: string; cleanup?: boolean | undefined }; result: MergeResult };

  // --- Pairing ---
  startPairing: { params: StartPairingParams; result: StartPairingResult };
  pairWithNode: { params: PairWithNodeParams; result: PairWithNodeResult };
  listPairedNodes: { params: undefined; result: StoredNode[] };
  removePairedNode: { params: { nodeId: string }; result: void };
  connectNode: { params: { nodeId: string }; result: void };
  disconnectNode: { params: { nodeId: string }; result: void };

  // --- Bulk operations ---
  deleteSessions: { params: { ids: string[] }; result: void };
  pruneSessions: { params: PruneOptions; result: PruneResult };

  // --- Archive ---
  archiveSession: { params: { sessionId: string }; result: void };
  unarchiveSession: { params: { sessionId: string }; result: void };

  // --- Approvals ---
  getPendingApprovals: { params: { sessionId?: string } | undefined; result: ApprovalRequest[] };
  resolveApproval: { params: { requestId: string; decision: ApprovalDecision }; result: void };
  reportEventGap: {
    params: { channel: PushChannel; expectedSeq: number; gotSeq: number };
    result: void;
  };

  // --- Backfill ---
  backfillSession: { params: { sessionId: string }; result: { eventsReplayed: number } };

  // --- Fleet ---
  listNodes: { params: undefined; result: NodeInfo[] };

  // --- Metrics & Observability ---
  getMetrics: { params: undefined; result: Record<string, unknown> | null };
  queryTraces: {
    params: {
      service?: string;
      errorsOnly?: boolean;
      namePattern?: string;
      limit?: number;
      since?: string;
    } | undefined;
    result: Array<Record<string, unknown>>;
  };

  // --- Terminal PTY ---
  terminalOpen: {
    params: { sessionId: string; opts?: { cols?: number; rows?: number } | undefined };
    result: { termId: string };
  };
  terminalWrite: { params: { termId: string; data: string }; result: void };
  terminalResize: { params: { termId: string; cols: number; rows: number }; result: void };
  terminalClose: { params: { termId: string }; result: void };
  terminalList: {
    params: { sessionId: string };
    result: Array<{ id: string; cols: number; rows: number }>;
  };

  // --- Workspaces ---
  listWorkspaces: { params: { includeArchived?: boolean } | undefined; result: WorkspaceInfo[] };
  getWorkspace: { params: { id: string }; result: WorkspaceInfo };
  createWorkspace: {
    params: {
      name: string;
      paths?: Array<{ nodeId?: string; path: string }>;
      settings?: WorkspaceSettings;
      metadata?: WorkspaceMetadata;
    };
    result: WorkspaceInfo;
  };
  updateWorkspace: {
    params: {
      id: string;
      opts: Partial<{
        name: string;
        settings: WorkspaceSettings;
        metadata: WorkspaceMetadata;
        archivedAt: string | null;
      }>;
    };
    result: void;
  };
  deleteWorkspace: { params: { id: string }; result: void };
  addWorkspacePath: { params: { workspaceId: string; path: string; nodeId?: string | undefined }; result: void };
  removeWorkspacePath: { params: { workspaceId: string; path: string; nodeId?: string | undefined }; result: void };

  // --- Dashboard-only (not in OrkaService, handled directly by rpc-handler) ---
  reportClientError: {
    params: { error?: string; stack?: string; url?: string; timestamp?: string };
    result: void;
  };
  listClientErrors: {
    params: { limit?: number } | undefined;
    result: Array<{ id: number; error: string; stack: string | null; url: string; timestamp: string }>;
  };
}

/** All valid RPC method names. */
export type RpcMethodName = keyof RpcMethodMap;

/** Extract the params type for a given RPC method. */
export type RpcParams<M extends RpcMethodName> = RpcMethodMap[M]["params"];

/** Extract the result type for a given RPC method. */
export type RpcResult<M extends RpcMethodName> = RpcMethodMap[M]["result"];
