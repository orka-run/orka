import { resolve, join } from "node:path";
import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { $ } from "bun";
import {
  generateId,
  type Session,
  type Task,
  type SpawnRequest,
} from "@orka/core";
import { consumeProviderEvents } from "./orchestration";
import { worktreeCreate, worktreeRemove, getWorktreeDir, worktreeHasCommitsAhead, worktreeHasChanges, worktreeMerge, deleteBranch } from "./worktree";
import { assertBackendInstalled } from "./backends";
import type { DaemonContext } from "./daemon-context";
import { getDaemonMetrics, withSpan } from "./tracing";

/** Spawn a new agent session. Returns the created session. */
export async function spawnSession(ctx: DaemonContext, req: SpawnRequest): Promise<Session> {
  return withSpan("orka.spawn", {
    "orka.backend": req.backend,
    "orka.mode": req.mode,
    "orka.project": req.projectPath,
    ...(req.model ? { "orka.model": req.model } : {}),
  }, async (span) => {
    // Verify backend CLI is installed
    assertBackendInstalled(req.backend);

    // Check concurrent session limit
    const { maxConcurrent } = ctx.config.limits;
    if (maxConcurrent > 0) {
      const running = ctx.db.listSessions("running");
      if (running.length >= maxConcurrent) {
        throw new Error(
          `Concurrent session limit reached (${running.length}/${maxConcurrent}). ` +
          `Stop a session or increase limits.max_concurrent in config.toml.`,
        );
      }
    }

    const projectPath = resolve(req.projectPath);
    const taskId = generateId("task");
    const sessionId = generateId("sess");
    const workspaceId = generateId("ws");
    const now = new Date().toISOString();

    span.setAttribute("orka.session.id", sessionId);
    span.setAttribute("orka.task.id", taskId);

    // 1. Create task record
    const task: Task = {
      id: taskId,
      title: req.title ?? req.prompt.slice(0, 80),
      prompt: req.prompt,
      backend: req.backend,
      mode: req.mode,
      model: req.model ?? null,
      createdAt: now,
    };
    ctx.db.insertTask(task);

    // 2. Prepare workspace — auto-worktree for background sessions
    let workingDir = projectPath;
    if (req.branch) {
      workingDir = await withSpan("orka.worktree.create", {
        "orka.session.id": sessionId,
        "orka.branch": req.branch,
      }, async () => worktreeCreate(projectPath, sessionId, ctx.orkaHome, { branch: req.branch, config: ctx.config }));
    } else if (req.mode === "background") {
      workingDir = await withSpan("orka.worktree.create", {
        "orka.session.id": sessionId,
        "orka.branch": `orka/${sessionId}`,
      }, async () => worktreeCreate(projectPath, sessionId, ctx.orkaHome, { config: ctx.config }));
    }

    span.setAttribute("orka.workdir", workingDir);

    // 3. Log file
    const logsDir = join(ctx.orkaHome, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, `${sessionId}.log`);

    // 4. Create session record
    const session: Session = {
      id: sessionId,
      taskId,
      workspaceId,
      status: "preparing",
      backend: req.backend,
      mode: req.mode,
      projectPath,
      workingDir,
      logFile,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      kept: false,
      autoMerge: req.autoMerge ?? false,
      ...(req.parentSessionId ? { parentSessionId: req.parentSessionId } : {}),
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
      ...(req.env ? { env: req.env } : {}),
    };
    ctx.db.insertSession(session);

    // 4b. Store tags
    if (req.tags && req.tags.length > 0) {
      ctx.db.insertSessionTags(sessionId, req.tags);
      span.setAttribute("orka.tags", req.tags.join(","));
    }

    // 5. Start provider runtime session
    const startedAt = new Date().toISOString();
    const handle = await ctx.providerService.startSession(req.backend, {
      threadId: sessionId,
      cwd: workingDir,
      ...(req.model ? { model: req.model } : {}),
      ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      prompt: req.prompt,
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
      ...(req.env ? { env: req.env } : {}),
      interactive: req.mode === "interactive",
    });

    const rawLogPath = join(logsDir, `${sessionId}.raw.jsonl`);
    ctx.db.updateSessionRawLogFile(sessionId, rawLogPath);

    ctx.db.updateSessionStatus(sessionId, "running", { startedAt });
    recordSessionStartedMetrics();

    void consumeProviderEvents(sessionId, handle, ctx.orchestrationEngine, {
      updateSessionStatus: (id, status, extra) => ctx.db.updateSessionStatus(id, status, extra),
      saveSessionDiff: (id, diff, status, extra) => ctx.db.saveSessionDiff(id, diff, status, extra),
      insertUsageRecord: (record) => ctx.db.insertUsageRecord(record),
      approvalManager: ctx.approvalManager,
      logFile,
      rawLogPath,
      pushHub: ctx.pushHub,
      workingDir,
      projectPath,
      autoMerge: session.autoMerge,
      model: req.model ?? null,
      orkaHome: ctx.orkaHome,
      getSession: (id) => ctx.db.getSession(id),
      cleanupWorktree: async () => {
        const currentSession = ctx.db.getSession(sessionId);
        if (currentSession) {
          await tryCleanupWorktree(ctx, currentSession);
        }
      },
    })
      .catch((error) => {
        console.error(`provider event consumer failed for session ${sessionId}`, error);
      })
      .finally(() => {
        ctx.providerService.clearHandle(sessionId);
      });

    span.addEvent("session.started");
    return { ...session, status: "running", startedAt };
  });
}

/** Reap orphaned sessions — with provider-only runtime, sessions are managed
 *  by provider handles and reaped when the handle's event stream ends.
 *  This function is kept as a no-op entry point for CLI compatibility. */
export async function reapSessions(): Promise<number> {
  return withSpan("orka.reap", {}, async () => 0);
}

/**
 * Detect sessions left in "running" or "preparing" status from a previous daemon
 * process and mark them as cancelled. Called once on daemon startup.
 */
export function recoverStaleSessions(ctx: DaemonContext): number {
  const staleStatuses: Array<"running" | "preparing"> = ["running", "preparing"];
  let recovered = 0;
  const now = new Date().toISOString();

  for (const status of staleStatuses) {
    const sessions = ctx.db.listSessions(status);
    for (const session of sessions) {
      // If there's already a provider handle, it's a live session (shouldn't happen on startup)
      if (ctx.providerService.getHandle(session.id)) continue;

      ctx.db.updateSessionStatus(session.id, "cancelled", { finishedAt: now });
      ctx.orchestrationEngine.ingest(session.id, {
        type: "session.exited",
        threadId: session.id,
        eventId: generateId("evt"),
        createdAt: now,
        provider: session.backend,
        payload: { reason: "daemon_restart", exitKind: "error" },
      });
      recovered++;
    }
  }

  if (recovered > 0) {
    console.log(`recovered ${recovered} stale session(s) from previous daemon`);
  }

  return recovered;
}

/** Stop a session via the provider runtime. */
export async function stopSession(ctx: DaemonContext, sessionId: string): Promise<void> {
  return withSpan("orka.stop", { "orka.session.id": sessionId }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const providerHandle = ctx.providerService.getHandle(sessionId);
    if (providerHandle) {
      await ctx.providerService.stopSession(sessionId);
      span.addEvent("session.stop_requested");
      return;
    }

    if (session.status !== "running" && session.status !== "preparing") {
      span.addEvent("session.stop_skipped_terminal");
      return;
    }

    // Session has no active provider handle but DB says running — mark cancelled
    const finishedAt = new Date().toISOString();
    ctx.db.updateSessionStatus(sessionId, "cancelled", {
      finishedAt,
    });
    recordSessionTerminalMetrics(session.startedAt, finishedAt, "cancelled");
    ctx.pushHub.broadcast("orchestration.sessionUpdated", {
      sessionId,
      status: "cancelled",
    });

    span.addEvent("session.cancelled");
    await tryCleanupWorktree(ctx, session);
  });
}


/** Stop a session and all its running children (cascading stop). */
export async function stopWithChildren(ctx: DaemonContext, sessionId: string): Promise<void> {
  return withSpan("orka.stopWithChildren", { "orka.session.id": sessionId }, async () => {
    const children = ctx.db.getChildSessions(sessionId).filter(s => s.status === "running");
    await Promise.all(children.map(c => stopSession(ctx, c.id)));
    await stopSession(ctx, sessionId);
  });
}

/** Auto-merge worktree branch into parent repo on successful completion. */
async function tryAutoMerge(ctx: DaemonContext, session: Session, parentSpan: any): Promise<void> {
  const wtDir = getWorktreeDir(ctx.orkaHome);
  if (!session.workingDir.startsWith(wtDir)) return;
  if (!session.projectPath) return;

  try {
    const { branch, commits } = await worktreeMerge(session.projectPath, session.workingDir);
    parentSpan.addEvent("session.auto_merged", {
      "orka.session.id": session.id,
      "orka.branch": branch,
      "orka.commits": commits,
    });
    // Clean up worktree and branch after successful merge
    try {
      await worktreeRemove(session.projectPath, session.workingDir);
      await deleteBranch(session.projectPath, branch);
    } catch {
      // Cleanup failure is non-fatal after merge
    }
  } catch {
    // Merge failure — worktree preserved for manual resolution
    parentSpan.addEvent("session.auto_merge_failed", {
      "orka.session.id": session.id,
    });
  }
}

async function tryCleanupWorktree(ctx: DaemonContext, session: Session): Promise<void> {
  const wtDir = getWorktreeDir(ctx.orkaHome);
  if (!session.workingDir.startsWith(wtDir)) return;
  const repoPath = session.projectPath;
  if (!repoPath) return;

  await withSpan("orka.worktree.cleanup", {
    "orka.session.id": session.id,
    "orka.workdir": session.workingDir,
  }, async (span) => {
    // Don't remove if explicitly kept or has valuable work
    if (session.kept) {
      span.setAttribute("orka.worktree.skip_reason", "kept");
      return;
    }
    if (await worktreeHasChanges(session.workingDir)) {
      span.setAttribute("orka.worktree.skip_reason", "uncommitted_changes");
      return;
    }
    if (await worktreeHasCommitsAhead(repoPath, session.workingDir)) {
      span.setAttribute("orka.worktree.skip_reason", "commits_ahead");
      return;
    }
    await worktreeRemove(repoPath, session.workingDir);
    span.setAttribute("orka.worktree.removed", true);
  }).catch(() => {
    // Cleanup failure should not break reap/stop
  });
}

function recordSessionStartedMetrics(): void {
  const metrics = getDaemonMetrics();
  metrics.sessionsSpawned.add(1);
  metrics.sessionsActive.add(1);
}

function recordSessionTerminalMetrics(
  startedAt: string | null,
  finishedAt: string,
  status: "completed" | "failed" | "cancelled",
): void {
  const metrics = getDaemonMetrics();

  switch (status) {
    case "completed":
      metrics.sessionsCompleted.add(1);
      break;
    case "failed":
      metrics.sessionsFailed.add(1);
      break;
    case "cancelled":
      metrics.sessionsCancelled.add(1);
      break;
  }

  if (!startedAt) {
    return;
  }

  metrics.sessionsActive.add(-1);

  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    metrics.sessionDuration.record(durationMs);
  }
}

/** Clean up orphaned worktree dirs that don't belong to any active session. */
export async function cleanupOrphanedWorktrees(ctx: DaemonContext): Promise<number> {
  return withSpan("orka.worktree.prune_orphans", {}, async (span) => {
    const wtDir = getWorktreeDir(ctx.orkaHome);
    if (!existsSync(wtDir)) return 0;

    const allSessions = ctx.db.listSessions();
    const activeWorkdirs = new Set(
      allSessions
        .filter((s) => s.status === "running" || s.status === "preparing")
        .map((s) => s.workingDir),
    );

    const entries = readdirSync(wtDir, { withFileTypes: true });
    let cleaned = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wtPath = join(wtDir, entry.name);
      if (activeWorkdirs.has(wtPath)) continue;

      try {
        rmSync(wtPath, { recursive: true, force: true });
        cleaned++;
        span.addEvent("orphan.removed", { "orka.worktree.path": wtPath });
      } catch {
        span.addEvent("orphan.remove_failed", { "orka.worktree.path": wtPath });
      }
    }

    span.setAttribute("orka.worktree.orphans_cleaned", cleaned);
    return cleaned;
  });
}

/** Capture committed changes on session branch vs parent. Best-effort. */
async function captureBranchDiffForSession(
  workingDir: string,
  projectPath: string,
): Promise<{ commitLog?: string; commitDiff?: string }> {
  try {
    const branch = (await $`git -C ${workingDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    if (!branch || branch === "HEAD") return {};

    const mainHead = (await $`git -C ${projectPath} rev-parse HEAD`.quiet().text()).trim();
    const mergeBase = (await $`git -C ${workingDir} merge-base ${mainHead} HEAD`.quiet().text()).trim();
    if (!mergeBase) return {};

    const log = (await $`git -C ${workingDir} log --oneline ${mergeBase}..HEAD`.quiet().text()).trim();
    if (!log) return {};

    const diff = (await $`git -C ${workingDir} diff ${mergeBase}..HEAD`.quiet().text()).trim();
    return { commitLog: log, commitDiff: diff };
  } catch {
    return {};
  }
}
