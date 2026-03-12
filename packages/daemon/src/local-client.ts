import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type {
  ChatEntry,
  OrchestrationEvent,
  OrkaService,
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
} from "@orka/core";
import {
  getSession,
  listSessions as dbListSessions,
  getTask,
  setSessionKept,
  getSessionTags,
  listSessionsByTag,
  deleteSessions as dbDeleteSessions,
  getUsageBySession,
  getUsageSummary as dbGetUsageSummary,
  getOrkaHome,
  getSessionDiff,
  getOrchestrationEvents,
  insertUsageRecord,
} from "./db";
import { spawnSession, stopSession, reapSessions, cleanupOrphanedWorktrees, getRunner } from "./orchestrator";
import { TerminalManager } from "./terminal-manager";
import { parseSessionResult } from "./result-parser";
import {
  worktreeMerge,
  worktreeRemove,
  deleteBranch,
  getWorktreeDir,
} from "./worktree";
import { approvalManager, isProviderRuntimeEnabled, providerService } from "./provider-runtime";

class LocalClient implements OrkaService {
  private terminalManager: TerminalManager | null = null;

  private getTerminalManager(): TerminalManager {
    if (!this.terminalManager) {
      this.terminalManager = new TerminalManager();
    }
    return this.terminalManager;
  }

  async spawn(req: SpawnRequest): Promise<Session> {
    return spawnSession(req);
  }

  async stop(sessionId: string): Promise<void> {
    return stopSession(sessionId);
  }

  async reap(): Promise<number> {
    return reapSessions();
  }

  async getSession(id: string): Promise<Session | null> {
    return getSession(id);
  }

  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    if (filters?.tag) {
      let sessions = listSessionsByTag(filters.tag);
      if (filters.status) {
        sessions = sessions.filter((s) => s.status === filters.status);
      }
      return sessions;
    }
    return dbListSessions(filters?.status);
  }

  async getTask(id: string): Promise<Task | null> {
    return getTask(id);
  }

  async setKept(sessionId: string, kept: boolean): Promise<void> {
    setSessionKept(sessionId, kept);
  }

  async getTags(sessionId: string): Promise<string[]> {
    return getSessionTags(sessionId);
  }

  async getResult(sessionId: string): Promise<SessionResult | null> {
    const session = getSession(sessionId);
    if (!session) return null;

    const result =
      isProviderRuntimeEnabled() ? buildProviderSessionResult(sessionId, session) : null;
    const parsedResult =
      result ?? (session.logFile ? parseSessionResult(session.logFile, session) : null);
    if (parsedResult) {
      insertUsageRecord({
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
    return getOrchestrationEvents(sessionId);
  }

  async getChatMessages(sessionId: string): Promise<ChatEntry[]> {
    const events = getOrchestrationEvents(sessionId);
    return eventsToChat(events);
  }

  async getUsage(opts?: { sessionId?: string; since?: string; backend?: string }): Promise<UsageSummary> {
    if (!opts?.sessionId) {
      return dbGetUsageSummary(opts);
    }

    const records = getUsageBySession(opts.sessionId).filter((record) => {
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
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (isProviderRuntimeEnabled()) {
      const output = getProviderOutput(getOrchestrationEvents(sessionId));
      if (output) {
        return output;
      }
    }

    const runner = getRunner();
    if (await runner.has(session.tmuxSessionName)) {
      return runner.capture(session.tmuxSessionName);
    }

    // Fall back to log file
    if (session.logFile && existsSync(session.logFile)) {
      return readFileSync(session.logFile, "utf-8");
    }

    throw new Error("No output available (session ended, no log file found)");
  }

  async getLogContent(sessionId: string): Promise<string | null> {
    const session = getSession(sessionId);
    if (!session?.logFile || !existsSync(session.logFile)) return null;
    return readFileSync(session.logFile, "utf-8");
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const session = getSession(sessionId);
    if (!session) return false;
    if (isProviderRuntimeEnabled()) {
      const handle = providerService.getHandle(sessionId);
      if (handle) return true;
    }
    return getRunner().has(session.tmuxSessionName);
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (isProviderRuntimeEnabled()) {
      const handle = providerService.getHandle(sessionId);
      if (handle) {
        await providerService.sendTurn(sessionId, { input: text });
        return;
      }
    }
    const runner = getRunner();
    if (!(await runner.has(session.tmuxSessionName))) {
      throw new Error(`Session ${sessionId} is not running`);
    }
    await runner.sendText(session.tmuxSessionName, text);
  }

  async getDiff(sessionId: string): Promise<DiffResult> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    try {
      const status = (await $`git -C ${session.workingDir} status`.text()).trim();
      const diff = (await $`git -C ${session.workingDir} diff`.text()).trim();
      const branchDiff = await captureBranchDiff(session.workingDir, session.projectPath);
      return { status, diff, ...branchDiff };
    } catch {
      const saved = getSessionDiff(sessionId);
      if (saved) return saved;
      throw new Error(`Cannot read git status in ${session.workingDir} (worktree may have been cleaned up)`);
    }
  }

  async merge(sessionId: string, cleanup = true): Promise<MergeResult> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const wtDir = getWorktreeDir();
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
    dbDeleteSessions(ids);
  }

  async pruneSessions(opts: PruneOptions): Promise<PruneResult> {
    const cutoff = new Date(Date.now() - opts.maxAgeMs).toISOString();
    const pruneStatuses = new Set(["completed", "cancelled", "failed"]);

    let sessions = dbListSessions().filter(
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
      const scriptsDir = join(getOrkaHome(), "scripts");
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
      dbDeleteSessions(sessions.map((s) => s.id));
      dbRecordsDeleted = sessions.length;
    }

    const orphansCleaned = await cleanupOrphanedWorktrees();

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
      return approvalManager.getPendingForSession(sessionId);
    }
    return approvalManager.getPending();
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const resolved = approvalManager.resolve(requestId, decision);
    if (!resolved) {
      throw new Error(`Approval request not found or already resolved: ${requestId}`);
    }

    if (isProviderRuntimeEnabled() && providerService.getHandle(resolved.threadId)) {
      await providerService.respondToRequest(
        resolved.threadId,
        requestId,
        decision === "approve" || decision === "approve_session" ? "approve" : "deny",
      );
    }
  }

  async reportEventGap(_channel: PushChannel, _expectedSeq: number, _gotSeq: number): Promise<void> {}

  async terminalOpen(sessionId: string, opts?: { cols?: number; rows?: number }): Promise<{ termId: string }> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const term = this.getTerminalManager().open(sessionId, {
      cwd: session.workingDir,
      ...(opts?.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts?.rows !== undefined ? { rows: opts.rows } : {}),
    });
    return { termId: term.id };
  }

  async terminalWrite(termId: string, data: string): Promise<void> {
    this.getTerminalManager().write(termId, data);
  }

  async terminalResize(termId: string, cols: number, rows: number): Promise<void> {
    this.getTerminalManager().resize(termId, cols, rows);
  }

  async terminalClose(termId: string): Promise<void> {
    this.getTerminalManager().close(termId);
  }

  async terminalList(sessionId: string): Promise<Array<{ id: string; cols: number; rows: number }>> {
    return this.getTerminalManager().listForSession(sessionId).map((t) => ({
      id: t.id,
      cols: t.cols,
      rows: t.rows,
    }));
  }
}

export function createLocalClient(): OrkaService {
  return new LocalClient();
}

function getProviderOutput(events: OrchestrationEvent[]): string {
  return events
    .filter((event): event is Extract<OrchestrationEvent, { type: "content.delta" }> => event.type === "content.delta")
    .map((event) => event.delta)
    .join("");
}

function buildProviderSessionResult(
  sessionId: string,
  session: { taskId: string; startedAt: string | null; finishedAt: string | null; status: string },
): SessionResult | null {
  const events = getOrchestrationEvents(sessionId);
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
    model: getTask(session.taskId)?.model ?? null,
    numTurns: turnCompleted.length,
  };
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
          body: event.exitCode != null ? `Exit code: ${String(event.exitCode)}` : undefined,
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
          body: event.reason,
        });
        break;

      case "turn.started":
        entries.push({
          kind: "system",
          timestamp: event.timestamp,
          title: "Turn started",
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
          body: parts.length > 0 ? parts.join(" · ") : undefined,
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
        const icon: ChatEntry extends infer T ? T extends { kind: "tool" } ? T["icon"] : never : never =
          event.itemType === "file_change" ? "file" : "command";
        entries.push({
          kind: "tool",
          timestamp: event.timestamp,
          title: event.title ?? event.itemType,
          summary: event.detail ?? "",
          icon,
          details: event.detail ? [event.detail] : undefined,
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
          details: event.detail ? [event.detail] : undefined,
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
