import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEntry,
  Checkpoint,
  DiffResult,
  MergeResult,
  NodeInfo,
  OrchestrationEvent,
  OrkaService,
  PairWithNodeParams,
  PairWithNodeResult,
  PruneOptions,
  PruneResult,
  PushChannel,
  RpcMethodName,
  RpcParams,
  RpcResult,
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
import { parseWireEvent } from "@orka/core";
import type { NoiseKeyInfo } from "@orka/core/crypto";
import { canonicalTransportOrigin } from "@orka/core";
import { WsTransport, type RequestOptions, type WsTransportOptions } from "./ws-transport";

export interface OrkaClientOptions {
  /** WebSocket URL of the daemon or relay. */
  url: string;
  /** Noise transport key info for the server. If provided, uses Noise NK encryption. */
  noiseServerKey?: NoiseKeyInfo;
  /** Node ID for Noise transport. Required when using noiseServerKey. */
  nodeId?: string;
  /** Relay origin for Noise transport prologue binding. Defaults to "". */
  relayOrigin?: string;
  /** Additional transport configuration such as timeouts and callbacks. */
  transportOptions?: Omit<WsTransportOptions, "noiseConfig">;
}

type OrkaClientSource = WsTransport | string | OrkaClientOptions;

export class OrkaClient implements OrkaService {
  protected readonly transport: WsTransport;
  private readonly ownsTransport: boolean;

  constructor(source: OrkaClientSource) {
    if (source instanceof WsTransport) {
      this.transport = source;
      this.ownsTransport = false;
      return;
    }

    const opts = typeof source === "string" ? { url: source } : source;
    this.transport = new WsTransport(opts.url, {
      ...opts.transportOptions,
      ...(opts.noiseServerKey
        ? {
            noiseConfig: {
              nodeId: opts.nodeId ?? "",
              serverKey: opts.noiseServerKey,
              relayOrigin: canonicalTransportOrigin(opts.relayOrigin),
            },
          }
        : {}),
    });
    this.ownsTransport = true;
  }

  protected request<M extends RpcMethodName>(method: M, params?: RpcParams<M>, options?: RequestOptions): Promise<RpcResult<M>> {
    return this.transport.request(method, params, options);
  }

  close(): void {
    if (this.ownsTransport) {
      this.transport.dispose();
    }
  }

  async spawn(req: SpawnRequest, options?: RequestOptions): Promise<SpawnResult> {
    return this.request("spawn", req, options);
  }

  async closeSession(sessionId: string, options?: RequestOptions): Promise<void> {
    return this.request("closeSession", { sessionId }, options);
  }

  async stop(sessionId: string, options?: RequestOptions): Promise<void> {
    return this.request("stop", { sessionId }, options);
  }

  async reap(options?: RequestOptions): Promise<number> {
    return this.request("reap", undefined, options);
  }

  async getSession(id: string, options?: RequestOptions): Promise<SessionDetailResponse | null> {
    return this.request("getSession", { id }, options);
  }

  async listSessions(filters?: SessionFilters, options?: RequestOptions): Promise<SessionListResponse[]> {
    return this.request("listSessions", filters === undefined ? undefined : { filters }, options);
  }

  async getChildSessions(sessionId: string, options?: RequestOptions): Promise<SessionListResponse[]> {
    return this.request("getChildSessions", { sessionId }, options);
  }

  async getTask(id: string, options?: RequestOptions): Promise<Task | null> {
    return this.request("getTask", { id }, options);
  }

  async setKept(sessionId: string, kept: boolean, options?: RequestOptions): Promise<void> {
    return this.request("setKept", { sessionId, kept }, options);
  }

  async getTags(sessionId: string, options?: RequestOptions): Promise<string[]> {
    return this.request("getTags", { sessionId }, options);
  }

  async getResult(sessionId: string, options?: RequestOptions): Promise<SessionResult | null> {
    return this.request("getResult", { sessionId }, options);
  }

  async getSessionTimeline(params: TimelineParams, options?: RequestOptions): Promise<TimelineResponse> {
    const raw = await this.request("getSessionTimeline", params, options);
    // Wire events need validation — cast to unknown[] for parseWireEvent
    const rawEvents = raw.events as unknown as unknown[];
    const events: OrchestrationEvent[] = [];
    for (const item of rawEvents) {
      const event = parseWireEvent(item);
      if (event) events.push(event);
    }
    return {
      events,
      total: raw.total,
    };
  }

  async getChatMessages(sessionId: string, options?: RequestOptions): Promise<ChatEntry[]> {
    return this.request("getChatMessages", { sessionId }, options);
  }

  async getUsage(
    opts?: { sessionId?: string; since?: string; backend?: string },
    options?: RequestOptions,
  ): Promise<UsageSummary> {
    return this.request("getUsage", opts, options);
  }

  async captureOutput(sessionId: string, options?: RequestOptions): Promise<string> {
    return this.request("captureOutput", { sessionId }, options);
  }

  async getLogContent(sessionId: string, options?: RequestOptions): Promise<string | null> {
    return this.request("getLogContent", { sessionId }, options);
  }

  async isAlive(sessionId: string, options?: RequestOptions): Promise<boolean> {
    return this.request("isAlive", { sessionId }, options);
  }

  async sendTurn(sessionId: string, text: string, options?: RequestOptions): Promise<void> {
    return this.request("sendTurn", { sessionId, text }, options);
  }

  async getCheckpoints(sessionId: string, options?: RequestOptions): Promise<Checkpoint[]> {
    return this.request("getCheckpoints", { sessionId }, options);
  }

  async getTurnDiff(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    options?: RequestOptions,
  ): Promise<{ diff: string }> {
    return this.request("getTurnDiff", { sessionId, fromTurn, toTurn }, options);
  }

  async revertToCheckpoint(sessionId: string, turnSeq: number, options?: RequestOptions): Promise<void> {
    return this.request("revertToCheckpoint", { sessionId, turnSeq }, options);
  }

  async revertSession(
    sessionId: string,
    turnSeq: number,
    mode: "files" | "files_and_conversation",
    options?: RequestOptions,
  ): Promise<void> {
    return this.request("revertSession", { sessionId, turnSeq, mode }, options);
  }

  async startPairing(params: StartPairingParams, options?: RequestOptions): Promise<StartPairingResult> {
    return this.request("startPairing", params, options);
  }

  async pairWithNode(params: PairWithNodeParams, options?: RequestOptions): Promise<PairWithNodeResult> {
    return this.request("pairWithNode", params, options);
  }

  async listPairedNodes(options?: RequestOptions): Promise<StoredNode[]> {
    return this.request("listPairedNodes", undefined, options);
  }

  async removePairedNode(params: { nodeId: string }, options?: RequestOptions): Promise<void> {
    return this.request("removePairedNode", params, options);
  }

  async connectNode(params: { nodeId: string }, options?: RequestOptions): Promise<void> {
    return this.request("connectNode", params, options);
  }

  async disconnectNode(params: { nodeId: string }, options?: RequestOptions): Promise<void> {
    return this.request("disconnectNode", params, options);
  }

  async getDiff(sessionId: string, options?: RequestOptions): Promise<DiffResult> {
    return this.request("getDiff", { sessionId }, options);
  }

  async merge(sessionId: string, cleanup?: boolean, options?: RequestOptions): Promise<MergeResult> {
    return this.request("merge", { sessionId, cleanup }, options);
  }

  async deleteSessions(ids: string[], options?: RequestOptions): Promise<void> {
    return this.request("deleteSessions", { ids }, options);
  }

  async pruneSessions(opts: PruneOptions, options?: RequestOptions): Promise<PruneResult> {
    return this.request("pruneSessions", opts, options);
  }

  async archiveSession(sessionId: string, options?: RequestOptions): Promise<void> {
    return this.request("archiveSession", { sessionId }, options);
  }

  async unarchiveSession(sessionId: string, options?: RequestOptions): Promise<void> {
    return this.request("unarchiveSession", { sessionId }, options);
  }

  async getPendingApprovals(sessionId?: string, options?: RequestOptions): Promise<ApprovalRequest[]> {
    return this.request(
      "getPendingApprovals",
      sessionId === undefined ? undefined : { sessionId },
      options,
    );
  }

  async resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    options?: RequestOptions,
  ): Promise<void> {
    return this.request("resolveApproval", { requestId, decision }, options);
  }

  async reportEventGap(
    channel: PushChannel,
    expectedSeq: number,
    gotSeq: number,
    options?: RequestOptions,
  ): Promise<void> {
    return this.request("reportEventGap", { channel, expectedSeq, gotSeq }, options);
  }

  async backfillSession(
    sessionId: string,
    options?: RequestOptions,
  ): Promise<{ eventsReplayed: number }> {
    return this.request("backfillSession", { sessionId }, options);
  }

  async listNodes(options?: RequestOptions): Promise<NodeInfo[]> {
    return this.request("listNodes", undefined, options);
  }

  async getMetrics(options?: RequestOptions): Promise<Record<string, unknown> | null> {
    return this.request("getMetrics", undefined, options);
  }

  async queryTraces(
    query?: {
      service?: string;
      errorsOnly?: boolean;
      namePattern?: string;
      limit?: number;
      since?: string;
    },
    options?: RequestOptions,
  ): Promise<Array<Record<string, unknown>>> {
    return this.request("queryTraces", query, options);
  }

  async terminalOpen(
    sessionId: string,
    opts?: { cols?: number; rows?: number },
    options?: RequestOptions,
  ): Promise<{ termId: string }> {
    return this.request("terminalOpen", { sessionId, opts }, options);
  }

  async terminalWrite(termId: string, data: string, options?: RequestOptions): Promise<void> {
    return this.request("terminalWrite", { termId, data }, options);
  }

  async terminalResize(
    termId: string,
    cols: number,
    rows: number,
    options?: RequestOptions,
  ): Promise<void> {
    return this.request("terminalResize", { termId, cols, rows }, options);
  }

  async terminalClose(termId: string, options?: RequestOptions): Promise<void> {
    return this.request("terminalClose", { termId }, options);
  }

  async terminalList(
    sessionId: string,
    options?: RequestOptions,
  ): Promise<Array<{ id: string; cols: number; rows: number }>> {
    return this.request("terminalList", { sessionId }, options);
  }

  async listWorkspaces(
    opts?: { includeArchived?: boolean },
    options?: RequestOptions,
  ): Promise<WorkspaceInfo[]> {
    return this.request("listWorkspaces", opts, options);
  }

  async getWorkspace(id: string, options?: RequestOptions): Promise<WorkspaceInfo> {
    return this.request("getWorkspace", { id }, options);
  }

  async createWorkspace(
    opts: {
      name: string;
      paths?: Array<{ nodeId?: string; path: string }>;
      settings?: WorkspaceSettings;
      metadata?: WorkspaceMetadata;
    },
    options?: RequestOptions,
  ): Promise<WorkspaceInfo> {
    return this.request("createWorkspace", opts, options);
  }

  async updateWorkspace(
    id: string,
    opts: Partial<{
      name: string;
      settings: WorkspaceSettings;
      metadata: WorkspaceMetadata;
      archivedAt: string | null;
    }>,
    options?: RequestOptions,
  ): Promise<void> {
    return this.request("updateWorkspace", { id, opts }, options);
  }

  async deleteWorkspace(id: string, options?: RequestOptions): Promise<void> {
    return this.request("deleteWorkspace", { id }, options);
  }

  async addWorkspacePath(
    workspaceId: string,
    path: string,
    nodeId?: string,
    options?: RequestOptions,
  ): Promise<void> {
    return this.request("addWorkspacePath", { workspaceId, path, nodeId }, options);
  }

  async removeWorkspacePath(
    workspaceId: string,
    path: string,
    nodeId?: string,
    options?: RequestOptions,
  ): Promise<void> {
    return this.request("removeWorkspacePath", { workspaceId, path, nodeId }, options);
  }
}

export function createOrkaClient(source: OrkaClientSource): OrkaClient {
  return new OrkaClient(source);
}

export type { RequestOptions };
