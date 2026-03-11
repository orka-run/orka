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
  SpawnRequest,
  Session,
  Task,
} from "@orka/core";
import {
  getSession,
  listSessions as dbListSessions,
  getTask,
  setSessionKept,
  getSessionTags,
  listSessionsByTag,
  deleteSessions as dbDeleteSessions,
  getOrkaHome,
} from "./db";
import { spawnSession, stopSession, reapSessions, cleanupOrphanedWorktrees } from "./orchestrator";
import { tmuxHas, tmuxCapture, tmuxSendText } from "./tmux";
import { parseSessionResult } from "./result-parser";
import {
  worktreeMerge,
  worktreeRemove,
  worktreeBranch,
  deleteBranch,
  getWorktreeDir,
} from "./worktree";
import { resolveProject } from "./projects";

class LocalClient implements OrkaService {
  async spawn(req: SpawnRequest): Promise<Session> {
    return spawnSession(req);
  }

  async stop(sessionId: string): Promise<void> {
    return stopSession(sessionId);
  }

  async reap(): Promise<number> {
    return reapSessions();
  }

  getSession(id: string): Session | null {
    return getSession(id);
  }

  listSessions(filters?: SessionFilters): Session[] {
    if (filters?.tag) {
      let sessions = listSessionsByTag(filters.tag);
      if (filters.status) {
        sessions = sessions.filter((s) => s.status === filters.status);
      }
      return sessions;
    }
    return dbListSessions(filters?.status);
  }

  getTask(id: string): Task | null {
    return getTask(id);
  }

  setKept(sessionId: string, kept: boolean): void {
    setSessionKept(sessionId, kept);
  }

  getTags(sessionId: string): string[] {
    return getSessionTags(sessionId);
  }

  getResult(sessionId: string): SessionResult | null {
    const session = getSession(sessionId);
    if (!session?.logFile) return null;
    return parseSessionResult(session.logFile);
  }

  async captureOutput(sessionId: string): Promise<string> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (await tmuxHas(session.tmuxSessionName)) {
      return tmuxCapture(session.tmuxSessionName);
    }

    // Fall back to log file
    if (session.logFile && existsSync(session.logFile)) {
      return readFileSync(session.logFile, "utf-8");
    }

    throw new Error("No output available (session ended, no log file found)");
  }

  getLogContent(sessionId: string): string | null {
    const session = getSession(sessionId);
    if (!session?.logFile || !existsSync(session.logFile)) return null;
    return readFileSync(session.logFile, "utf-8");
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const session = getSession(sessionId);
    if (!session) return false;
    return tmuxHas(session.tmuxSessionName);
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!(await tmuxHas(session.tmuxSessionName))) {
      throw new Error(`Session ${sessionId} is not running`);
    }
    await tmuxSendText(session.tmuxSessionName, text);
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

  deleteSessions(ids: string[]): void {
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
}

export function createLocalClient(): OrkaService {
  return new LocalClient();
}
