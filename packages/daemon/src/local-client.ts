import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type {
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
      return { status, diff };
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

  async terminalOpen(sessionId: string, opts?: { cols?: number; rows?: number }): Promise<{ termId: string }> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const term = this.getTerminalManager().open(sessionId, {
      cols: opts?.cols,
      rows: opts?.rows,
      cwd: session.workingDir,
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
