import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEntry,
  DiffResult,
  MergeResult,
  NodeInfo,
  OrchestrationEvent,
  OrkaService,
  PruneOptions,
  PruneResult,
  PushChannel,
  Session,
  SessionFilters,
  SessionResult,
  SessionSummary,
  SpawnRequest,
  StartPairingParams,
  StartPairingResult,
  Task,
  UsageSummary,
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
      .request<Session[]>(nodeId, "listSessions", { filters: {} })
      .then((sessions) => {
        sessionCache.setNodeSessions(
          nodeId,
          sessions.map((s) => toSummary(s, nodeId)),
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
          if (!d?.sessionId) return;
          sessionCache.upsertSession(nodeId, {
            id: d.sessionId as string,
            status: (d.status as SessionSummary["status"]) ?? "running",
            backend: (d.backend as SessionSummary["backend"]) ?? "",
            title: (d.title as string) ?? "",
            createdAt: (d.createdAt as string) ?? new Date().toISOString(),
            nodeId,
          });
        },
      );
      const unsub2 = remoteNodes.subscribePush(
        nodeId,
        "orchestration.sessionDeleted",
        (data: unknown) => {
          const d = data as Record<string, unknown> | null;
          if (d?.sessionId) sessionCache.removeSession(d.sessionId as string);
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
  async function routeBySession<T>(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const nodeId = sessionCache.getOwningNode(sessionId);
    if (!nodeId || nodeId === "local") {
      return callLocal<T>(method, params);
    }
    ensureReachable(nodeId);
    return remoteNodes.request<T>(nodeId, method, params);
  }

  /** Call a method on localClient by name. */
  async function callLocal<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    // Map RPC method names to localClient method calls
    const svc = localClient as any;
    switch (method) {
      case "getSession":
        return svc.getSession(params.id);
      case "getSessionTimeline":
        return svc.getSessionTimeline(params.sessionId);
      case "getChatMessages":
        return svc.getChatMessages(params.sessionId);
      case "getResult":
        return svc.getResult(params.sessionId);
      case "captureOutput":
        return svc.captureOutput(params.sessionId);
      case "getLogContent":
        return svc.getLogContent(params.sessionId);
      case "getDiff":
        return svc.getDiff(params.sessionId);
      case "getTags":
        return svc.getTags(params.sessionId);
      case "stop":
        return svc.stop(params.sessionId);
      case "sendTurn":
        return svc.sendTurn(params.sessionId, params.text);
      case "setKept":
        return svc.setKept(params.sessionId, params.kept);
      case "merge":
        return svc.merge(params.sessionId, params.cleanup);
      case "isAlive":
        return svc.isAlive(params.sessionId);
      case "archiveSession":
        return svc.archiveSession(params.sessionId);
      case "unarchiveSession":
        return svc.unarchiveSession(params.sessionId);
      case "backfillSession":
        return svc.backfillSession(params.sessionId);
      case "deleteSessions":
        return svc.deleteSessions(params.ids);
      case "getChildSessions":
        return svc.getChildSessions(params.sessionId);
      case "getTask":
        return svc.getTask(params.id);
      case "getPendingApprovals":
        return svc.getPendingApprovals(params.sessionId);
      case "resolveApproval":
        return svc.resolveApproval(params.requestId, params.decision);
      case "terminalOpen":
        return svc.terminalOpen(params.sessionId, params.opts);
      case "terminalWrite":
        return svc.terminalWrite(params.termId, params.data);
      case "terminalResize":
        return svc.terminalResize(params.termId, params.cols, params.rows);
      case "terminalClose":
        return svc.terminalClose(params.termId);
      case "terminalList":
        return svc.terminalList(params.sessionId);
      default:
        return svc[method](params);
    }
  }

  /** Convert a full Session to a SessionSummary for cache storage. */
  function toSummary(s: Session, nodeId: string): SessionSummary {
    return {
      id: s.id,
      status: s.status,
      backend: s.backend,
      title: "",
      createdAt: s.createdAt,
      nodeId,
    };
  }

  /** Convert a SessionSummary to a stub Session (for listing when full data unavailable). */
  function summaryToStubSession(s: SessionSummary): Session {
    return {
      id: s.id,
      taskId: "",
      workspaceId: "",
      status: s.status,
      backend: s.backend,
      mode: "background",
      projectPath: "",
      workingDir: "",
      logFile: "",
      createdAt: s.createdAt,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      kept: false,
      autoMerge: false,
    } as Session;
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
    async listSessions(filters?: SessionFilters): Promise<Session[]> {
      const localSessions = await localClient.listSessions(filters);

      // Get cached remote sessions and apply what filters we can
      let remoteSessions = sessionCache.getAllSessions();
      if (filters?.status) {
        remoteSessions = remoteSessions.filter((s) => s.status === filters.status);
      }

      // Merge: local sessions + stub sessions from cache
      const localIds = new Set(localSessions.map((s) => s.id));
      const remoteStubs = remoteSessions
        .filter((s) => !localIds.has(s.id))
        .map(summaryToStubSession);

      const merged = [...localSessions, ...remoteStubs];
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return merged;
    },

    // --- Merge: getUsage ---
    async getUsage(
      opts?: { sessionId?: string; since?: string; backend?: string },
    ): Promise<UsageSummary> {
      if (opts?.sessionId) {
        return routeBySession<UsageSummary>(opts.sessionId, "getUsage", opts);
      }

      // Aggregate local + all connected remote nodes
      const promises: Promise<UsageSummary>[] = [localClient.getUsage(opts)];
      for (const nodeId of connectedNodeIds()) {
        promises.push(
          remoteNodes.request<UsageSummary>(nodeId, "getUsage", opts ?? {}),
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
    async spawn(req: SpawnRequest): Promise<Session> {
      if (req.nodeId && req.nodeId !== "local") {
        ensureReachable(req.nodeId);
        const session = await remoteNodes.request<Session>(
          req.nodeId,
          "spawn",
          req,
        );
        // Update cache with new session
        sessionCache.upsertSession(req.nodeId, toSummary(session, req.nodeId));
        return session;
      }
      return localClient.spawn(req);
    },

    // --- Route to owning node ---
    async getSession(id: string): Promise<Session | null> {
      return routeBySession<Session | null>(id, "getSession", { id });
    },

    async getSessionTimeline(sessionId: string): Promise<OrchestrationEvent[]> {
      return routeBySession<OrchestrationEvent[]>(sessionId, "getSessionTimeline", { sessionId });
    },

    async getChatMessages(sessionId: string): Promise<ChatEntry[]> {
      return routeBySession<ChatEntry[]>(sessionId, "getChatMessages", { sessionId });
    },

    async getResult(sessionId: string): Promise<SessionResult | null> {
      return routeBySession<SessionResult | null>(sessionId, "getResult", { sessionId });
    },

    async captureOutput(sessionId: string): Promise<string> {
      return routeBySession<string>(sessionId, "captureOutput", { sessionId });
    },

    async getLogContent(sessionId: string): Promise<string | null> {
      return routeBySession<string | null>(sessionId, "getLogContent", { sessionId });
    },

    async getDiff(sessionId: string): Promise<DiffResult> {
      return routeBySession<DiffResult>(sessionId, "getDiff", { sessionId });
    },

    async getTags(sessionId: string): Promise<string[]> {
      return routeBySession<string[]>(sessionId, "getTags", { sessionId });
    },

    async stop(sessionId: string): Promise<void> {
      return routeBySession<void>(sessionId, "stop", { sessionId });
    },

    async sendTurn(sessionId: string, text: string): Promise<void> {
      return routeBySession<void>(sessionId, "sendTurn", { sessionId, text });
    },

    async setKept(sessionId: string, kept: boolean): Promise<void> {
      return routeBySession<void>(sessionId, "setKept", { sessionId, kept });
    },

    async merge(sessionId: string, cleanup?: boolean): Promise<MergeResult> {
      return routeBySession<MergeResult>(sessionId, "merge", { sessionId, cleanup });
    },

    async isAlive(sessionId: string): Promise<boolean> {
      return routeBySession<boolean>(sessionId, "isAlive", { sessionId });
    },

    async archiveSession(sessionId: string): Promise<void> {
      return routeBySession<void>(sessionId, "archiveSession", { sessionId });
    },

    async unarchiveSession(sessionId: string): Promise<void> {
      return routeBySession<void>(sessionId, "unarchiveSession", { sessionId });
    },

    async backfillSession(
      sessionId: string,
    ): Promise<{ eventsReplayed: number }> {
      return routeBySession<{ eventsReplayed: number }>(
        sessionId,
        "backfillSession",
        { sessionId },
      );
    },

    async getChildSessions(sessionId: string): Promise<Session[]> {
      return routeBySession<Session[]>(sessionId, "getChildSessions", { sessionId });
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
            remoteNodes.request<void>(nodeId, "deleteSessions", {
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

    // --- Approvals ---
    async getPendingApprovals(sessionId?: string): Promise<ApprovalRequest[]> {
      if (sessionId) {
        return routeBySession<ApprovalRequest[]>(
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
          await remoteNodes.request<void>(handle.nodeId, "resolveApproval", {
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
        result = await remoteNodes.request<{ termId: string }>(
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
      return remoteNodes.request<void>(nodeId, "terminalWrite", {
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
      return remoteNodes.request<void>(nodeId, "terminalResize", {
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
      return remoteNodes.request<void>(nodeId, "terminalClose", { termId });
    },

    async terminalList(
      sessionId: string,
    ): Promise<Array<{ id: string; cols: number; rows: number }>> {
      return routeBySession<Array<{ id: string; cols: number; rows: number }>>(
        sessionId,
        "terminalList",
        { sessionId },
      );
    },
  };

  return svc;
}
