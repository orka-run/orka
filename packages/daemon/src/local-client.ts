import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { generateId } from "@orka/core";
import type {
  ChatEntry,
  NodeInfo,
  OrchestrationEvent,
  OrkaService,
  RawProviderLine,
  SessionFilters,
  PruneOptions,
  PruneResult,
  DiffResult,
  MergeResult,
  SessionResult,
  UsageSummary,
  SpawnRequest,
  Session,
  Task,
  ApprovalRequest,
  ApprovalDecision,
  PushChannel,
  StartPairingParams,
  StartPairingResult,
} from "@orka/core";
import { generatePairingCode } from "@orka/core/crypto/protocol";
import { EnrollmentStore } from "./pairing/enrollment-store";
import type { DaemonContext } from "./daemon-context";
import { spawnSession, stopSession, reapSessions, cleanupOrphanedWorktrees } from "./orchestrator";
import { TerminalManager } from "./terminal-manager";
import { parseSessionResult } from "./result-parser";
import {
  worktreeMerge,
  worktreeRemove,
  deleteBranch,
  getWorktreeDir,
} from "./worktree";
import { queryMetricSnapshot, queryTraceLog, withSpan } from "./tracing";
import { PairingServer } from "./pairing/pairing-server";
import type { PairMessage } from "@orka/core";

export interface PairingConfig {
  /** Node ID for pairing enrollment (e.g. "fra1-gpu-01"). */
  nodeId: string;
  /** Human-readable node name (e.g. "Frankfurt GPU Node 1"). */
  nodeName: string;
  /** Raw X25519 public key for Noise transport (32 bytes). */
  transportPubkey: Uint8Array;
  /** Key ID for the transport pubkey (e.g. "sha256:..."). */
  transportKeyId: string;
  /** Relay paths the client can reach this node at. */
  relayPaths: string[];
  /** Relay WebSocket URL (e.g. "ws://relay:7390") — required for pairing WS connection. */
  relayUrl: string;
  /** API key for authenticating pairing WebSocket connections to the relay. */
  relayToken?: string;
}

interface LocalClientDeps {
  terminalManager: TerminalManager;
  enrollmentStore?: EnrollmentStore;
  pairingConfig?: PairingConfig;
}

class LocalClient implements OrkaService {
  private readonly ctx: DaemonContext;
  private readonly terminalManager: TerminalManager;
  private readonly enrollmentStore: EnrollmentStore | null;
  private readonly pairingConfig: PairingConfig | null;

  constructor(ctx: DaemonContext, deps: LocalClientDeps) {
    this.ctx = ctx;
    this.terminalManager = deps.terminalManager;
    this.enrollmentStore = deps.enrollmentStore ?? null;
    this.pairingConfig = deps.pairingConfig ?? null;
  }

  async spawn(req: SpawnRequest): Promise<Session> {
    return spawnSession(this.ctx, req);
  }

  async stop(sessionId: string): Promise<void> {
    return stopSession(this.ctx, sessionId);
  }

  async reap(): Promise<number> {
    return reapSessions();
  }

  async getSession(id: string): Promise<Session | null> {
    return this.ctx.db.getSession(id);
  }

  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    const includeArchived = filters?.includeArchived ?? false;
    if (filters?.tag) {
      let sessions = this.ctx.db.listSessionsByTag(filters.tag);
      if (filters.status) {
        sessions = sessions.filter((s) => s.status === filters.status);
      }
      if (!includeArchived) {
        sessions = sessions.filter((s) => !s.archivedAt);
      }
      return sessions;
    }
    return this.ctx.db.listSessions(filters?.status, includeArchived);
  }

  async getChildSessions(sessionId: string): Promise<Session[]> {
    return this.ctx.db.getChildSessions(sessionId);
  }

  async getTask(id: string): Promise<Task | null> {
    return this.ctx.db.getTask(id);
  }

  async setKept(sessionId: string, kept: boolean): Promise<void> {
    this.ctx.db.setSessionKept(sessionId, kept);
  }

  async getTags(sessionId: string): Promise<string[]> {
    return this.ctx.db.getSessionTags(sessionId);
  }

  async getResult(sessionId: string): Promise<SessionResult | null> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session) return null;

    const result = this.buildProviderSessionResult(sessionId, session);
    const parsedResult =
      result ?? (session.logFile ? parseSessionResult(session.logFile, session) : null);
    if (parsedResult) {
      this.ctx.db.insertUsageRecord({
        sessionId: session.id,
        backend: session.backend,
        inputTokens: parsedResult.inputTokens,
        outputTokens: parsedResult.outputTokens,
        cacheReadTokens: parsedResult.cacheReadTokens,
        costUsd: parsedResult.costUsd,
        model: parsedResult.model,
        recordedAt: session.finishedAt ?? new Date().toISOString(),
      });
    }
    return parsedResult;
  }

  async getSessionTimeline(sessionId: string): Promise<OrchestrationEvent[]> {
    return this.ctx.db.getOrchestrationEvents(sessionId);
  }

  async getChatMessages(sessionId: string): Promise<ChatEntry[]> {
    const events = this.ctx.db.getOrchestrationEvents(sessionId);
    return eventsToChat(events);
  }

  async getUsage(opts?: { sessionId?: string; since?: string; backend?: string }): Promise<UsageSummary> {
    if (!opts?.sessionId) {
      return this.ctx.db.getUsageSummary(opts);
    }

    const records = this.ctx.db.getUsageBySession(opts.sessionId).filter((record) => {
      if (opts.backend && record.backend !== opts.backend) {
        return false;
      }
      if (opts.since && record.recordedAt < opts.since) {
        return false;
      }
      return true;
    });

    const sessions = new Set(records.map((record) => record.sessionId));
    const byBackend: UsageSummary["byBackend"] = {};
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;

    for (const record of records) {
      totalCostUsd += record.costUsd ?? 0;
      totalInputTokens += record.inputTokens;
      totalOutputTokens += record.outputTokens;
      totalCacheReadTokens += record.cacheReadTokens;

      const bucket = byBackend[record.backend] ?? {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessions: 0,
      };
      bucket.cost += record.costUsd ?? 0;
      bucket.inputTokens += record.inputTokens;
      bucket.outputTokens += record.outputTokens;
      bucket.sessions = 1;
      byBackend[record.backend] = bucket;
    }

    return {
      totalCostUsd,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      sessionCount: sessions.size,
      byBackend,
    };
  }

  async captureOutput(sessionId: string): Promise<string> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const output = getProviderOutput(this.ctx.db.getOrchestrationEvents(sessionId));
    if (output) {
      return output;
    }

    // Fall back to log file
    if (session.logFile && existsSync(session.logFile)) {
      return readFileSync(session.logFile, "utf-8");
    }

    throw new Error("No output available (session ended, no log file found)");
  }

  async getLogContent(sessionId: string): Promise<string | null> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session?.logFile || !existsSync(session.logFile)) return null;
    return readFileSync(session.logFile, "utf-8");
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session) return false;
    return !!this.ctx.providerService.getHandle(sessionId);
  }

  async sendTurn(sessionId: string, text: string): Promise<void> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const handle = this.ctx.providerService.getHandle(sessionId);
    if (!handle) {
      throw new Error(`Session ${sessionId} is not running`);
    }

    const event: OrchestrationEvent = {
      v: 1,
      type: "user.input",
      sessionId,
      text,
      timestamp: new Date().toISOString(),
    };
    this.ctx.db.insertOrchestrationEvent({
      ...event,
      provider: handle.provider,
      eventId: generateId("evt"),
    });
    this.ctx.pushHub.broadcast("orchestration.event", event);
    await this.ctx.providerService.sendTurn(sessionId, { input: text });
  }

  async startPairing(params: StartPairingParams): Promise<StartPairingResult> {
    if (!this.enrollmentStore || !this.pairingConfig) {
      throw new Error("Pairing is not configured on this node (missing pairing config)");
    }

    const { code, parsed } = generatePairingCode();
    const ttlMs = (params.ttlSec ?? 600) * 1000;

    const enrollId = this.enrollmentStore.create({
      secret: parsed.secret,
      nodeId: this.pairingConfig.nodeId,
      nodeName: params.nodeName ?? this.pairingConfig.nodeName,
      nodeTransportStaticPubkey: this.pairingConfig.transportPubkey,
      relayPaths: this.pairingConfig.relayPaths,
      ttlMs,
    });

    // Connect to relay pairing endpoint in background
    this.connectPairingRelay(enrollId, ttlMs);

    return {
      enrollId,
      pairingCode: code,
      expiresAt: Date.now() + ttlMs,
    };
  }

  /**
   * Open a WebSocket to the relay's pairing route and drive PairingServer
   * to complete the SPAKE2 handshake with the connecting client.
   */
  private connectPairingRelay(enrollId: string, ttlMs: number): void {
    const config = this.pairingConfig!;
    const store = this.enrollmentStore!;

    void withSpan("orka.pairing.relay_connect", {
      "orka.pairing.enroll_id": enrollId,
    }, async (span) => {
      const enrollment = store.get(enrollId);
      if (!enrollment) {
        span.addEvent("pairing.enrollment_not_found");
        return;
      }

      // Build the relay pairing URL: <relayUrl>/v1/pair/<enrollId>
      const relayUrl = config.relayUrl.replace(/\/$/, "");
      // Append auth token as query parameter if available
      const tokenParam = config.relayToken ? `?token=${encodeURIComponent(config.relayToken)}` : "";
      const pairUrl = `${relayUrl}/v1/pair/${enrollId}${tokenParam}`;

      const ws = new WebSocket(pairUrl);

      // Set up TTL timeout to clean up if pairing doesn't complete
      const timeout = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, "Pairing TTL expired");
        }
        store.remove(enrollId);
      }, ttlMs);
      timeout.unref();

      const server = new PairingServer({
        enrollment,
        enrollmentStore: store,
        secret: enrollment.secret,
        relayOrigin: relayUrl,
        noiseKeyId: config.transportKeyId,
      });

      ws.onopen = () => {
        span.addEvent("pairing.relay_connected");
      };

      ws.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }

        const responses: PairMessage[] = server.processMessage(parsed);
        for (const msg of responses) {
          ws.send(JSON.stringify(msg));
        }

        if (server.isComplete) {
          span.addEvent("pairing.complete");
          clearTimeout(timeout);
          // Close the WS gracefully — pairing is done
          ws.close(1000, "Pairing complete");
        } else if (server.isErrored) {
          span.addEvent("pairing.errored");
          clearTimeout(timeout);
          ws.close(1000, "Pairing error");
          store.remove(enrollId);
        }
      };

      ws.onerror = () => {
        span.addEvent("pairing.relay_error");
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        if (!server.isComplete) {
          span.addEvent("pairing.relay_closed_before_complete");
          store.remove(enrollId);
        }
      };
    });
  }

  /** Get the enrollment store (for use by pairing server handler). */
  getEnrollmentStore(): EnrollmentStore | null {
    return this.enrollmentStore;
  }

  async getDiff(sessionId: string): Promise<DiffResult> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    try {
      const status = (await $`git -C ${session.workingDir} status`.text()).trim();
      const diff = (await $`git -C ${session.workingDir} diff`.text()).trim();
      const branchDiff = await captureBranchDiff(session.workingDir, session.projectPath);
      return { status, diff, ...branchDiff };
    } catch {
      const saved = this.ctx.db.getSessionDiff(sessionId);
      if (saved) return saved;
      throw new Error(`Cannot read git status in ${session.workingDir} (worktree may have been cleaned up)`);
    }
  }

  async merge(sessionId: string, cleanup = true): Promise<MergeResult> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const wtDir = getWorktreeDir(this.ctx.orkaHome);
    if (!session.workingDir.startsWith(wtDir)) {
      throw new Error(`Session ${sessionId} is not using a worktree`);
    }

    const { branch, commits } = await worktreeMerge(session.projectPath, session.workingDir);
    let cleaned = false;

    if (cleanup) {
      try {
        await worktreeRemove(session.projectPath, session.workingDir);
        await deleteBranch(session.projectPath, branch);
        cleaned = true;
      } catch {
        // Cleanup failure is non-fatal
      }
    }

    return { branch, commits, cleaned };
  }

  async deleteSessions(ids: string[]): Promise<void> {
    this.ctx.db.deleteSessions(ids);
  }

  async archiveSession(sessionId: string): Promise<void> {
    this.ctx.db.archiveSession(sessionId);
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    this.ctx.db.unarchiveSession(sessionId);
  }

  async pruneSessions(opts: PruneOptions): Promise<PruneResult> {
    const cutoff = new Date(Date.now() - opts.maxAgeMs).toISOString();
    const pruneStatuses = new Set(["completed", "cancelled", "failed"]);

    let sessions = this.ctx.db.listSessions().filter(
      (s) => pruneStatuses.has(s.status) && s.createdAt < cutoff,
    );

    if (opts.projectPath) {
      sessions = sessions.filter((s) => s.projectPath === opts.projectPath);
    }

    if (!opts.confirm) {
      return {
        pruned: sessions.length,
        orphansCleaned: 0,
        dryRun: true,
      };
    }

    let logsDeleted = 0;
    if (opts.purgeLogs) {
      const scriptsDir = join(this.ctx.orkaHome, "scripts");
      for (const s of sessions) {
        if (s.logFile && existsSync(s.logFile)) {
          unlinkSync(s.logFile);
          logsDeleted += 1;
        }
        const scriptFile = join(scriptsDir, `${s.id}.sh`);
        if (existsSync(scriptFile)) {
          unlinkSync(scriptFile);
          logsDeleted += 1;
        }
      }
    }

    let dbRecordsDeleted = 0;
    if (opts.purgeDb) {
      this.ctx.db.deleteSessions(sessions.map((s) => s.id));
      dbRecordsDeleted = sessions.length;
    }

    const orphansCleaned = await cleanupOrphanedWorktrees(this.ctx);

    return {
      pruned: sessions.length,
      orphansCleaned,
      dryRun: false,
      ...(opts.purgeLogs ? { logsDeleted } : {}),
      ...(opts.purgeDb ? { dbRecordsDeleted } : {}),
    };
  }

  async getPendingApprovals(sessionId?: string): Promise<ApprovalRequest[]> {
    if (sessionId) {
      return this.ctx.approvalManager.getPendingForSession(sessionId);
    }
    return this.ctx.approvalManager.getPending();
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const resolved = this.ctx.approvalManager.resolve(requestId, decision);
    if (!resolved) {
      throw new Error(`Approval request not found or already resolved: ${requestId}`);
    }

    if (this.ctx.providerService.getHandle(resolved.threadId)) {
      await this.ctx.providerService.respondToRequest(
        resolved.threadId,
        requestId,
        decision === "approve" || decision === "approve_session" ? "approve" : "deny",
      );
    }
  }

  async backfillSession(sessionId: string): Promise<{ eventsReplayed: number }> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!session.rawLogFile || !existsSync(session.rawLogFile)) {
      throw new Error(`No raw log file for session ${sessionId}`);
    }

    const adapter = this.ctx.providerAdapterRegistry.get(session.backend);
    if (!adapter?.replayRawLog) {
      throw new Error(`Backend "${session.backend}" does not support replay`);
    }

    const rawContent = readFileSync(session.rawLogFile, "utf-8");
    const lines: RawProviderLine[] = rawContent
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as RawProviderLine);

    // Delete existing orchestration events for this session
    this.ctx.db.deleteOrchestrationEvents([sessionId]);

    let eventsReplayed = 0;
    for await (const event of adapter.replayRawLog(sessionId, lines)) {
      this.ctx.orchestrationEngine.ingest(sessionId, event);
      eventsReplayed++;
    }

    return { eventsReplayed };
  }

  private buildProviderSessionResult(
    sessionId: string,
    session: { taskId: string; startedAt: string | null; finishedAt: string | null; status: string },
  ): SessionResult | null {
    const events = this.ctx.db.getOrchestrationEvents(sessionId);
    const turnCompleted = events.filter(
      (event): event is Extract<OrchestrationEvent, { type: "turn.completed" }> => event.type === "turn.completed",
    );
    const output = getProviderOutputForLastTurn(events, turnCompleted.at(-1)?.turnId);

    if (turnCompleted.length === 0 && !output) {
      return null;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | null = null;

    for (const event of turnCompleted) {
      inputTokens += event.tokens?.input ?? 0;
      outputTokens += event.tokens?.output ?? 0;
      if (event.cost !== undefined) {
        costUsd = (costUsd ?? 0) + event.cost;
      }
    }

    const hasFailedTurn = turnCompleted.some((event) => event.state === "failed");
    const hasFailedItem = events.some(
      (event) =>
        event.type === "item.completed" &&
        event.status === "failed" &&
        (turnCompleted.length === 0 || event.turnId === turnCompleted.at(-1)?.turnId),
    );
    const hasRuntimeFailure = events.some(
      (event) => event.type === "session.failed" || (event.type === "runtime.error" && event.terminal === true),
    );
    const durationMs =
      session.startedAt && session.finishedAt
        ? new Date(session.finishedAt).getTime() - new Date(session.startedAt).getTime()
        : 0;

    return {
      result: output,
      isError: session.status === "failed" || hasFailedTurn || hasFailedItem || hasRuntimeFailure,
      durationMs,
      costUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      model: this.ctx.db.getTask(session.taskId)?.model ?? null,
      numTurns: turnCompleted.length,
    };
  }

  async getMetrics(): Promise<Record<string, unknown> | null> {
    return (await queryMetricSnapshot()) as unknown as Record<string, unknown> | null;
  }

  async queryTraces(query?: {
    service?: string;
    errorsOnly?: boolean;
    namePattern?: string;
    limit?: number;
    since?: string;
  }): Promise<Array<Record<string, unknown>>> {
    return queryTraceLog(query ?? {}) as unknown as Array<Record<string, unknown>>;
  }

  async reportEventGap(_channel: PushChannel, _expectedSeq: number, _gotSeq: number): Promise<void> {}

  async terminalOpen(sessionId: string, opts?: { cols?: number; rows?: number }): Promise<{ termId: string }> {
    const session = this.ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const term = this.terminalManager.open(sessionId, {
      cwd: session.workingDir,
      ...(opts?.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts?.rows !== undefined ? { rows: opts.rows } : {}),
    });
    return { termId: term.id };
  }

  async terminalWrite(termId: string, data: string): Promise<void> {
    this.terminalManager.write(termId, data);
  }

  async terminalResize(termId: string, cols: number, rows: number): Promise<void> {
    this.terminalManager.resize(termId, cols, rows);
  }

  async terminalClose(termId: string): Promise<void> {
    this.terminalManager.close(termId);
  }

  async terminalList(sessionId: string): Promise<Array<{ id: string; cols: number; rows: number }>> {
    return this.terminalManager.listForSession(sessionId).map((t) => ({
      id: t.id,
      cols: t.cols,
      rows: t.rows,
    }));
  }

  async listNodes(): Promise<NodeInfo[]> {
    return [{
      id: "local",
      status: "online",
      activeRequests: 0,
      registeredAt: Date.now(),
    }];
  }
}

export function createLocalClient(ctx: DaemonContext, pairingConfig?: PairingConfig): OrkaService {
  const deps: LocalClientDeps = {
    terminalManager: new TerminalManager(),
    ...(pairingConfig ? { pairingConfig, enrollmentStore: new EnrollmentStore() } : {}),
  };
  return new LocalClient(ctx, deps);
}

function getProviderOutput(events: OrchestrationEvent[]): string {
  return events
    .filter((event): event is Extract<OrchestrationEvent, { type: "content.delta" }> => event.type === "content.delta")
    .map((event) => event.delta)
    .join("");
}

function getProviderOutputForLastTurn(events: OrchestrationEvent[], turnId?: string): string {
  return events
    .filter(
      (event): event is Extract<OrchestrationEvent, { type: "content.delta" }> =>
        event.type === "content.delta" && (!turnId || event.turnId === turnId),
    )
    .map((event) => event.delta)
    .join("");
}

export function eventsToChat(events: OrchestrationEvent[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const deltasByTurn = new Map<string, { deltas: string[]; timestamp: string }>();

  for (const event of events) {
    switch (event.type) {
      case "session.created":
        entries.push({
          kind: "system",
          timestamp: event.timestamp,
          title: "Session created",
          body: `Backend: ${event.backend}`,
        });
        break;

      case "session.started":
        entries.push({
          kind: "system",
          timestamp: event.timestamp,
          title: "Session started",
        });
        break;

      case "session.completed":
        entries.push({
          kind: "system",
          timestamp: event.timestamp,
          title: "Session completed",
          ...(event.exitCode != null ? { body: `Exit code: ${String(event.exitCode)}` } : {}),
        });
        break;

      case "session.failed":
        entries.push({
          kind: "error",
          timestamp: event.timestamp,
          title: "Session failed",
          body: event.error,
        });
        break;

      case "session.cancelled":
        entries.push({
          kind: "system",
          timestamp: event.timestamp,
          title: "Session cancelled",
          ...(event.reason ? { body: event.reason } : {}),
        });
        break;

      case "turn.started":
        entries.push({
          kind: "system",
          timestamp: event.timestamp,
          title: "Turn started",
        });
        break;

      case "user.input":
        entries.push({
          kind: "user",
          timestamp: event.timestamp,
          body: event.text,
        });
        break;

      case "turn.completed": {
        const parts: string[] = [];
        if (event.tokens) {
          parts.push(`Tokens: ${String(event.tokens.input)} in / ${String(event.tokens.output)} out`);
        }
        if (event.cost != null) {
          parts.push(`Cost: $${event.cost.toFixed(4)}`);
        }
        entries.push({
          kind: "system",
          timestamp: event.timestamp,
          title: "Turn completed",
          ...(parts.length > 0 ? { body: parts.join(" · ") } : {}),
        });
        break;
      }

      case "content.delta": {
        let bucket = deltasByTurn.get(event.turnId);
        if (!bucket) {
          bucket = { deltas: [], timestamp: event.timestamp };
          deltasByTurn.set(event.turnId, bucket);
        }
        bucket.deltas.push(event.delta);
        break;
      }

      case "item.started": {
        const icon: "command" | "file" = event.itemType === "file_change" ? "file" : "command";
        entries.push({
          kind: "tool",
          timestamp: event.timestamp,
          title: event.title ?? event.itemType,
          summary: event.detail ?? "",
          icon,
          ...(event.detail ? { details: [event.detail] } : {}),
        });
        break;
      }

      case "item.completed": {
        const icon2: "command" | "file" = event.itemType === "file_change" ? "file" : "command";
        entries.push({
          kind: "tool",
          timestamp: event.timestamp,
          title: event.title ?? `${event.itemType} completed`,
          summary: event.status ?? "done",
          icon: icon2,
          ...(event.detail ? { details: [event.detail] } : {}),
        });
        break;
      }

      case "runtime.error":
        entries.push({
          kind: "error",
          timestamp: event.timestamp,
          title: event.class ?? "Runtime error",
          body: event.error,
        });
        break;
    }
  }

  // Flush accumulated content deltas as assistant entries
  for (const [, bucket] of deltasByTurn) {
    const body = bucket.deltas.join("");
    if (body.trim()) {
      entries.push({
        kind: "assistant",
        timestamp: bucket.timestamp,
        body,
      });
    }
  }

  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return entries;
}

/** Capture committed changes on the session branch vs the parent branch. */
async function captureBranchDiff(
  workingDir: string,
  projectPath: string,
): Promise<{ commitLog?: string; commitDiff?: string }> {
  try {
    // Determine the branch of this worktree
    const branch = (await $`git -C ${workingDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    if (!branch || branch === "HEAD") return {};

    // Find the merge-base with the main repo's HEAD
    const mainHead = (await $`git -C ${projectPath} rev-parse HEAD`.quiet().text()).trim();
    const mergeBase = (await $`git -C ${workingDir} merge-base ${mainHead} HEAD`.quiet().text()).trim();
    if (!mergeBase) return {};

    const commitLog = (await $`git -C ${workingDir} log --oneline ${mergeBase}..HEAD`.quiet().text()).trim();
    if (!commitLog) return {};

    const commitDiff = (await $`git -C ${workingDir} diff ${mergeBase}..HEAD`.quiet().text()).trim();
    return { commitLog, commitDiff };
  } catch {
    return {};
  }
}
