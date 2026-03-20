import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEntry,
  Checkpoint,
  ConfigResponse,
  DiffResult,
  MergeResult,
  NodeInfo,
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
  SessionSummary,
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
import type { RemoteNodeManager } from "./remote-nodes";
import type { SessionCache } from "./session-cache";

/**
 * Creates an OrkaService that merges local + remote sessions.
 * Local operations go to localClient, remote operations are proxied
 * via RemoteNodeManager, and SessionCache handles routing lookups.
 */
export function createAggregatingClient(
  localClient: OrkaService,
  remoteNodes: RemoteNodeManager,
  sessionCache: SessionCache,
): OrkaService {
  // Track which node owns each terminal for write/resize/close routing
  const termToNode = new Map<string, string>();
  const pushUnsubs: (() => void)[] = [];

  // Initialize cache and push subscriptions for connected nodes
  for (const handle of remoteNodes.listHandles()) {
    initNodeCache(handle.nodeId);
    subscribeNodePush(handle.nodeId);
  }

  /** Fetch remote sessions and populate cache for a node. */
  function initNodeCache(nodeId: string): void {
    remoteNodes
      .request(nodeId, "listSessions", { filters: {} })
      .then((result) => {
        sessionCache.setNodeSessions(
          nodeId,
          result.sessions.map((s: SessionListResponse) => listResponseToSummary(s, nodeId)),
        );
      })
      .catch(() => {
        /* node may not be connected yet — cache stays empty */
      });
  }

  /** Subscribe to push events from a remote node to keep cache in sync. */
  function subscribeNodePush(nodeId: string): void {
    try {
      const unsub1 = remoteNodes.subscribePush(
        nodeId,
        "orchestration.sessionUpdated",
        (data: unknown) => {
          const d = data as Record<string, unknown> | null;
          if (!d?.["sessionId"]) return;
          sessionCache.upsertSession(nodeId, {
            id: d["sessionId"] as string,
            status: (d["status"] as SessionSummary["status"]) ?? "running",
            backend: (d["backend"] as SessionSummary["backend"]) ?? "",
            title: (d["title"] as string) ?? "",
            createdAt: (d["createdAt"] as string) ?? new Date().toISOString(),
            nodeId,
          });
        },
      );
      const unsub2 = remoteNodes.subscribePush(
        nodeId,
        "orchestration.sessionDeleted",
        (data: unknown) => {
          const d = data as Record<string, unknown> | null;
          if (d?.["sessionId"]) sessionCache.removeSession(d["sessionId"] as string);
        },
      );
      pushUnsubs.push(unsub1, unsub2);
    } catch {
      /* handle may not exist yet */
    }
  }

  function throwUnreachable(nodeId: string): never {
    const err = new Error(`Remote node ${nodeId} is unreachable`);
    (err as any).code = "NODE_UNREACHABLE";
    (err as any).nodeId = nodeId;
    throw err;
  }

  function ensureReachable(nodeId: string): void {
    const handle = remoteNodes.getHandle(nodeId);
    if (!handle || handle.status === "disconnected") {
      throwUnreachable(nodeId);
    }
  }

  /** Route a session-specific RPC to the owning node. */
  async function routeBySession<M extends RpcMethodName>(
    sessionId: string,
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> {
    const nodeId = sessionCache.getOwningNode(sessionId);
    if (!nodeId || nodeId === "local") {
      return callLocal(method, params);
    }
    ensureReachable(nodeId);
    return remoteNodes.request(nodeId, method, params);
  }

  /** Call a method on localClient by name. */
  async function callLocal<M extends RpcMethodName>(
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> {
    // Map RPC method names to localClient method calls.
    // params is cast to any because TypeScript cannot narrow M inside the switch.
    const svc = localClient as any;
    const p = params as any;
    switch (method) {
      case "getSession":
        return svc.getSession(p["id"]);
      case "getSessionTimeline":
        return svc.getSessionTimeline(p);
      case "getChatMessages":
        return svc.getChatMessages(p["sessionId"]);
      case "getResult":
        return svc.getResult(p["sessionId"]);
      case "captureOutput":
        return svc.captureOutput(p["sessionId"]);
      case "getLogContent":
        return svc.getLogContent(p["sessionId"]);
      case "getDiff":
        return svc.getDiff(p["sessionId"]);
      case "getTags":
        return svc.getTags(p["sessionId"]);
      case "stop":
        return svc.stop(p["sessionId"]);
      case "sendTurn":
        return svc.sendTurn(p["sessionId"], p["text"]);
      case "cancelQueuedMessage":
        return svc.cancelQueuedMessage(p["sessionId"], p["text"]);
      case "getCheckpoints":
        return svc.getCheckpoints(p["sessionId"]);
      case "getTurnDiff":
        return svc.getTurnDiff(p["sessionId"], p["fromTurn"], p["toTurn"]);
      case "revertToCheckpoint":
        return svc.revertToCheckpoint(p["sessionId"], p["turnSeq"]);
      case "setKept":
        return svc.setKept(p["sessionId"], p["kept"]);
      case "merge":
        return svc.merge(p["sessionId"], p["cleanup"]);
      case "isAlive":
        return svc.isAlive(p["sessionId"]);
      case "archiveSession":
        return svc.archiveSession(p["sessionId"]);
      case "unarchiveSession":
        return svc.unarchiveSession(p["sessionId"]);
      case "backfillSession":
        return svc.backfillSession(p["sessionId"]);
      case "deleteSessions":
        return svc.deleteSessions(p["ids"]);
      case "getChildSessions":
        return svc.getChildSessions(p["sessionId"]);
      case "getTask":
        return svc.getTask(p["id"]);
      case "getPendingApprovals":
        return svc.getPendingApprovals(p["sessionId"]);
      case "resolveApproval":
        return svc.resolveApproval(p["requestId"], p["decision"]);
      case "terminalOpen":
        return svc.terminalOpen(p["sessionId"], p["opts"]);
      case "terminalWrite":
        return svc.terminalWrite(p["termId"], p["data"]);
      case "terminalResize":
        return svc.terminalResize(p["termId"], p["cols"], p["rows"]);
      case "terminalClose":
        return svc.terminalClose(p["termId"]);
      case "terminalList":
        return svc.terminalList(p["sessionId"]);
      default:
        return svc[method](p);
    }
  }

  /** Convert a SessionListResponse to a SessionSummary for cache storage. */
  function listResponseToSummary(s: SessionListResponse, nodeId: string): SessionSummary {
    return {
      id: s.id,
      status: s.status,
      backend: s.backend,
      title: s.title,
      createdAt: s.createdAt,
      nodeId,
    };
  }

  /** Convert a SessionSummary to a stub SessionListResponse (for listing when full data unavailable). */
  function summaryToStubListResponse(s: SessionSummary): SessionListResponse {
    return {
      id: s.id,
      status: s.status,
      allowedActions: s.allowedActions ?? [],
      backend: s.backend,
      title: s.title,
      model: null,
      prompt: "",
      projectPath: "",
      createdAt: s.createdAt,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      kept: false,
      autoMerge: false,
      parentSessionId: null,
      permissionMode: null,
      noWorktree: false,
      tags: [],
    };
  }

  /** Get connected remote node IDs. */
  function connectedNodeIds(): string[] {
    return remoteNodes
      .listHandles()
      .filter((h) => h.status === "connected")
      .map((h) => h.nodeId);
  }

  // --- Merge usage summaries ---
  function mergeUsage(summaries: UsageSummary[]): UsageSummary {
    const merged: UsageSummary = {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      sessionCount: 0,
      byBackend: {},
    };
    for (const s of summaries) {
      merged.totalCostUsd += s.totalCostUsd;
      merged.totalInputTokens += s.totalInputTokens;
      merged.totalOutputTokens += s.totalOutputTokens;
      merged.totalCacheReadTokens += s.totalCacheReadTokens;
      merged.sessionCount += s.sessionCount;
      for (const [backend, bucket] of Object.entries(s.byBackend)) {
        const existing = merged.byBackend[backend];
        if (existing) {
          existing.cost += bucket.cost;
          existing.inputTokens += bucket.inputTokens;
          existing.outputTokens += bucket.outputTokens;
          existing.sessions += bucket.sessions;
        } else {
          merged.byBackend[backend] = { ...bucket };
        }
      }
    }
    return merged;
  }

  const svc: OrkaService = {
    // --- Merge: listSessions ---
    async listSessions(filters?: SessionFilters): Promise<SessionListResponse[]> {
      const localSessions = await localClient.listSessions(filters);

      // Get cached remote sessions and apply what filters we can
      let remoteSessions = sessionCache.getAllSessions();
      if (filters?.status) {
        remoteSessions = remoteSessions.filter((s) => s.status === filters.status);
      }

      // Merge: local sessions + stub list responses from cache
      const localIds = new Set(localSessions.map((s) => s.id));
      const remoteStubs = remoteSessions
        .filter((s) => !localIds.has(s.id))
        .map(summaryToStubListResponse);

      const merged = [...localSessions, ...remoteStubs];
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return merged;
    },

    // --- Merge: getUsage ---
    async getUsage(
      opts?: { sessionId?: string; since?: string; backend?: string },
    ): Promise<UsageSummary> {
      if (opts?.sessionId) {
        return routeBySession(opts.sessionId, "getUsage", opts);
      }

      // Aggregate local + all connected remote nodes
      const promises: Promise<UsageSummary>[] = [localClient.getUsage(opts)];
      for (const nodeId of connectedNodeIds()) {
        promises.push(
          remoteNodes.request(nodeId, "getUsage", opts ?? {}),
        );
      }

      const results = await Promise.allSettled(promises);
      const summaries = results
        .filter(
          (r): r is PromiseFulfilledResult<UsageSummary> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);

      return mergeUsage(summaries);
    },

    // --- Merge: listNodes ---
    async listNodes(): Promise<NodeInfo[]> {
      const localNodes = await localClient.listNodes();
      const remoteHandles = remoteNodes.listHandles();
      const remoteNodeInfos: NodeInfo[] = remoteHandles.map((h) => ({
        id: h.nodeId,
        status: h.status === "connected" ? ("online" as const) : ("offline" as const),
        activeRequests: 0,
        registeredAt: h.lastConnected ?? 0,
      }));
      return [...localNodes, ...remoteNodeInfos];
    },

    // --- Route by spawn param ---
    async spawn(req: SpawnRequest): Promise<SpawnResult> {
      if (req.nodeId && req.nodeId !== "local") {
        ensureReachable(req.nodeId);
        const result = await remoteNodes.request(
          req.nodeId,
          "spawn",
          req,
        );
        // Update cache with new session
        sessionCache.upsertSession(req.nodeId, {
          id: result.id,
          status: result.status,
          backend: req.backend,
          title: result.title,
          createdAt: new Date().toISOString(),
          nodeId: req.nodeId,
        });
        return result;
      }
      return localClient.spawn(req);
    },

    // --- Route to owning node ---
    async getSession(id: string): Promise<SessionDetailResponse | null> {
      return routeBySession(id, "getSession", { id });
    },

    async getSessionTimeline(params: TimelineParams): Promise<TimelineResponse> {
      return routeBySession(params.sessionId, "getSessionTimeline", { ...params });
    },

    async getChatMessages(sessionId: string): Promise<ChatEntry[]> {
      return routeBySession(sessionId, "getChatMessages", { sessionId });
    },

    async getResult(sessionId: string): Promise<SessionResult | null> {
      return routeBySession(sessionId, "getResult", { sessionId });
    },

    async captureOutput(sessionId: string): Promise<string> {
      return routeBySession(sessionId, "captureOutput", { sessionId });
    },

    async getLogContent(sessionId: string): Promise<string | null> {
      return routeBySession(sessionId, "getLogContent", { sessionId });
    },

    async getDiff(sessionId: string): Promise<DiffResult> {
      return routeBySession(sessionId, "getDiff", { sessionId });
    },

    async getTags(sessionId: string): Promise<string[]> {
      return routeBySession(sessionId, "getTags", { sessionId });
    },

    async stop(sessionId: string): Promise<void> {
      return routeBySession(sessionId, "stop", { sessionId });
    },

    async closeSession(sessionId: string): Promise<void> {
      return routeBySession(sessionId, "closeSession", { sessionId });
    },

    async cancelTurn(sessionId: string): Promise<void> {
      return routeBySession(sessionId, "cancelTurn", { sessionId });
    },

    async sendTurn(sessionId: string, text: string): Promise<void> {
      return routeBySession(sessionId, "sendTurn", { sessionId, text });
    },

    async cancelQueuedMessage(sessionId: string, text: string): Promise<void> {
      return routeBySession(sessionId, "cancelQueuedMessage", { sessionId, text });
    },

    async getCheckpoints(sessionId: string): Promise<Checkpoint[]> {
      return routeBySession(sessionId, "getCheckpoints", { sessionId });
    },

    async getTurnDiff(sessionId: string, fromTurn: number, toTurn: number): Promise<{ diff: string }> {
      return routeBySession(sessionId, "getTurnDiff", { sessionId, fromTurn, toTurn });
    },

    async revertToCheckpoint(sessionId: string, turnSeq: number): Promise<void> {
      return routeBySession(sessionId, "revertToCheckpoint", { sessionId, turnSeq });
    },

    async revertSession(sessionId: string, turnSeq: number, mode: "files" | "files_and_conversation"): Promise<void> {
      return routeBySession(sessionId, "revertSession", { sessionId, turnSeq, mode });
    },

    async setKept(sessionId: string, kept: boolean): Promise<void> {
      return routeBySession(sessionId, "setKept", { sessionId, kept });
    },

    async merge(sessionId: string, cleanup?: boolean): Promise<MergeResult> {
      return routeBySession(sessionId, "merge", { sessionId, cleanup });
    },

    async isAlive(sessionId: string): Promise<boolean> {
      return routeBySession(sessionId, "isAlive", { sessionId });
    },

    async archiveSession(sessionId: string): Promise<void> {
      return routeBySession(sessionId, "archiveSession", { sessionId });
    },

    async unarchiveSession(sessionId: string): Promise<void> {
      return routeBySession(sessionId, "unarchiveSession", { sessionId });
    },

    async backfillSession(
      sessionId: string,
    ): Promise<{ eventsReplayed: number }> {
      return routeBySession(
        sessionId,
        "backfillSession",
        { sessionId },
      );
    },

    async getChildSessions(sessionId: string): Promise<SessionListResponse[]> {
      return routeBySession(sessionId, "getChildSessions", { sessionId });
    },

    async getTask(id: string): Promise<Task | null> {
      // Tasks are local — remote nodes have their own tasks
      return localClient.getTask(id);
    },

    // --- Route each ID to owning node ---
    async deleteSessions(ids: string[]): Promise<void> {
      // Group IDs by owning node
      const nodeGroups = new Map<string, string[]>();
      for (const id of ids) {
        const nodeId = sessionCache.getOwningNode(id) ?? "local";
        let group = nodeGroups.get(nodeId);
        if (!group) {
          group = [];
          nodeGroups.set(nodeId, group);
        }
        group.push(id);
      }

      const promises: Promise<void>[] = [];
      for (const [nodeId, nodeIds] of nodeGroups) {
        if (nodeId === "local") {
          promises.push(localClient.deleteSessions(nodeIds));
        } else {
          ensureReachable(nodeId);
          promises.push(
            remoteNodes.request(nodeId, "deleteSessions", {
              ids: nodeIds,
            }),
          );
        }
      }

      await Promise.all(promises);

      // Remove from cache
      for (const id of ids) {
        sessionCache.removeSession(id);
      }
    },

    // --- Local only ---
    async reap(): Promise<number> {
      return localClient.reap();
    },

    async pruneSessions(opts: PruneOptions): Promise<PruneResult> {
      return localClient.pruneSessions(opts);
    },

    async getMetrics(): Promise<Record<string, unknown> | null> {
      return localClient.getMetrics();
    },

    async queryTraces(query?: {
      service?: string;
      errorsOnly?: boolean;
      namePattern?: string;
      limit?: number;
      since?: string;
    }): Promise<Array<Record<string, unknown>>> {
      return localClient.queryTraces(query);
    },

    async reportEventGap(
      channel: PushChannel,
      expectedSeq: number,
      gotSeq: number,
    ): Promise<void> {
      return localClient.reportEventGap(channel, expectedSeq, gotSeq);
    },

    async startPairing(
      params: StartPairingParams,
    ): Promise<StartPairingResult> {
      return localClient.startPairing(params);
    },

    async pairWithNode(params: PairWithNodeParams): Promise<PairWithNodeResult> {
      return localClient.pairWithNode(params);
    },

    async listPairedNodes(): Promise<StoredNode[]> {
      return localClient.listPairedNodes();
    },

    async removePairedNode(params: { nodeId: string }): Promise<void> {
      return localClient.removePairedNode(params);
    },

    async connectNode(params: { nodeId: string }): Promise<void> {
      return localClient.connectNode(params);
    },

    async disconnectNode(params: { nodeId: string }): Promise<void> {
      return localClient.disconnectNode(params);
    },

    // --- Approvals ---
    async getPendingApprovals(sessionId?: string): Promise<ApprovalRequest[]> {
      if (sessionId) {
        return routeBySession(
          sessionId,
          "getPendingApprovals",
          { sessionId },
        );
      }
      // No sessionId: local only
      return localClient.getPendingApprovals();
    },

    async resolveApproval(
      requestId: string,
      decision: ApprovalDecision,
    ): Promise<void> {
      // Try local first
      try {
        await localClient.resolveApproval(requestId, decision);
        return;
      } catch {
        // Not found locally — try remote nodes
      }

      for (const handle of remoteNodes.listHandles()) {
        if (handle.status !== "connected") continue;
        try {
          await remoteNodes.request(handle.nodeId, "resolveApproval", {
            requestId,
            decision,
          });
          return;
        } catch {
          // Not on this node either
        }
      }

      throw new Error(
        `Approval request not found or already resolved: ${requestId}`,
      );
    },

    // --- Terminal (route by sessionId, track termId) ---
    async terminalOpen(
      sessionId: string,
      opts?: { cols?: number; rows?: number },
    ): Promise<{ termId: string }> {
      const nodeId = sessionCache.getOwningNode(sessionId) ?? "local";
      let result: { termId: string };
      if (nodeId === "local") {
        result = await localClient.terminalOpen(sessionId, opts);
      } else {
        ensureReachable(nodeId);
        result = await remoteNodes.request(
          nodeId,
          "terminalOpen",
          { sessionId, opts },
        );
      }
      termToNode.set(result.termId, nodeId);
      return result;
    },

    async terminalWrite(termId: string, data: string): Promise<void> {
      const nodeId = termToNode.get(termId) ?? "local";
      if (nodeId === "local") {
        return localClient.terminalWrite(termId, data);
      }
      ensureReachable(nodeId);
      return remoteNodes.request(nodeId, "terminalWrite", {
        termId,
        data,
      });
    },

    async terminalResize(
      termId: string,
      cols: number,
      rows: number,
    ): Promise<void> {
      const nodeId = termToNode.get(termId) ?? "local";
      if (nodeId === "local") {
        return localClient.terminalResize(termId, cols, rows);
      }
      ensureReachable(nodeId);
      return remoteNodes.request(nodeId, "terminalResize", {
        termId,
        cols,
        rows,
      });
    },

    async terminalClose(termId: string): Promise<void> {
      const nodeId = termToNode.get(termId) ?? "local";
      termToNode.delete(termId);
      if (nodeId === "local") {
        return localClient.terminalClose(termId);
      }
      ensureReachable(nodeId);
      return remoteNodes.request(nodeId, "terminalClose", { termId });
    },

    async terminalList(
      sessionId: string,
    ): Promise<Array<{ id: string; cols: number; rows: number }>> {
      return routeBySession(
        sessionId,
        "terminalList",
        { sessionId },
      );
    },

    // --- Workspaces (local only) ---
    async listWorkspaces(opts?: { includeArchived?: boolean }): Promise<WorkspaceInfo[]> {
      return localClient.listWorkspaces(opts);
    },
    async getWorkspace(id: string): Promise<WorkspaceInfo> {
      return localClient.getWorkspace(id);
    },
    async createWorkspace(opts: { name: string; paths?: Array<{ nodeId?: string; path: string }>; settings?: WorkspaceSettings; metadata?: WorkspaceMetadata }): Promise<WorkspaceInfo> {
      return localClient.createWorkspace(opts);
    },
    async updateWorkspace(id: string, opts: Partial<{ name: string; settings: WorkspaceSettings; metadata: WorkspaceMetadata; archivedAt: string | null }>): Promise<void> {
      return localClient.updateWorkspace(id, opts);
    },
    async deleteWorkspace(id: string): Promise<void> {
      return localClient.deleteWorkspace(id);
    },
    async addWorkspacePath(workspaceId: string, path: string, nodeId?: string): Promise<void> {
      return localClient.addWorkspacePath(workspaceId, path, nodeId);
    },
    async removeWorkspacePath(workspaceId: string, path: string, nodeId?: string): Promise<void> {
      return localClient.removeWorkspacePath(workspaceId, path, nodeId);
    },

    // --- Config (local only) ---
    async getConfig(): Promise<ConfigResponse> {
      return localClient.getConfig();
    },
    async updateConfig(section: string, values: Record<string, unknown>): Promise<void> {
      return localClient.updateConfig(section, values);
    },
    async getProjectConfig(projectPath: string): Promise<ConfigResponse | null> {
      return localClient.getProjectConfig(projectPath);
    },
  };

  return svc;
}
