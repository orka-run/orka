import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type {
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
import { ApprovalManager } from "./approval-manager";

class LocalClient implements OrkaService {
  readonly approvals = new ApprovalManager();
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
    if (!session?.logFile) return null;
    const result = parseSessionResult(session.logFile, session);
    if (result) {
      insertUsageRecord({
        sessionId: session.id,
        backend: session.backend,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        costUsd: result.costUsd,
        model: result.model,
        recordedAt: session.finishedAt ?? new Date().toISOString(),
      });
    }
    return result;
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
    return getRunner().has(session.tmuxSessionName);
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
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

    if (sessions.length === 0) {
      return { pruned: 0, orphansCleaned: 0 };
    }

    // Delete log files and script files
    const scriptsDir = join(getOrkaHome(), "scripts");
    for (const s of sessions) {
      if (s.logFile && existsSync(s.logFile)) {
        unlinkSync(s.logFile);
      }
      const scriptFile = join(scriptsDir, `${s.id}.sh`);
      if (existsSync(scriptFile)) {
        unlinkSync(scriptFile);
      }
    }

    dbDeleteSessions(sessions.map((s) => s.id));
    const orphansCleaned = await cleanupOrphanedWorktrees();

    return { pruned: sessions.length, orphansCleaned };
  }

  async getPendingApprovals(sessionId?: string): Promise<ApprovalRequest[]> {
    if (sessionId) {
      return this.approvals.getPendingForSession(sessionId);
    }
    return this.approvals.getPending();
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const resolved = this.approvals.resolve(requestId, decision);
    if (!resolved) {
      throw new Error(`Approval request not found or already resolved: ${requestId}`);
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
