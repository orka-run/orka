import { resolve, join } from "node:path";
import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { $ } from "bun";
import {
  generateId,
  type Session,
  type Task,
  type SpawnRequest,
  type SpawnResult,
} from "@orka/core";
import { consumeProviderEvents } from "./orchestration";
import { worktreeCreate, worktreeRemove, getWorktreeDir, worktreeHasCommitsAhead, worktreeHasChanges, worktreeMerge, deleteBranch } from "./worktree";
import { assertBackendInstalled } from "./backends";
import type { DaemonContext } from "./daemon-context";
import { getDaemonMetrics, withSpan } from "./tracing";

// --- Idle timer management ---

/** Per-session idle timers. When a session goes idle, a timer is started.
 *  When it fires, the process is killed and the session is set to "hibernated". */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearIdleTimer(sessionId: string): void {
  const timer = idleTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(sessionId);
  }
}

function startIdleTimer(ctx: DaemonContext, sessionId: string): void {
  clearIdleTimer(sessionId);

  const timeoutMinutes = ctx.config.limits.idleTimeoutMinutes ?? 10;
  if (timeoutMinutes <= 0) return; // 0 = no auto-hibernate

  const timer = setTimeout(() => {
    idleTimers.delete(sessionId);
    void hibernateSession(ctx, sessionId);
  }, timeoutMinutes * 60_000);
  timer.unref(); // Don't prevent process exit

  idleTimers.set(sessionId, timer);
}

/** Kill the process and set session to "hibernated". */
async function hibernateSession(ctx: DaemonContext, sessionId: string): Promise<void> {
  await withSpan("orka.hibernate", { "orka.session.id": sessionId }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session || session.status !== "idle") return;

    // Set status BEFORE killing process so the consumer's finalizeSession
    // sees "hibernated" and skips overwriting it.
    ctx.db.updateSessionStatus(sessionId, "hibernated");
    ctx.pushHub.broadcast("orchestration.sessionUpdated", {
      sessionId,
      status: "hibernated",
    });

    const handle = ctx.providerService.getHandle(sessionId);
    if (handle) {
      await ctx.providerService.stopSession(sessionId);
      span.addEvent("session.hibernated");
    }
  });
}

// --- Consumer callbacks factory ---

function buildConsumerCallbacks(
  ctx: DaemonContext,
  sessionId: string,
  opts: {
    logFile: string;
    rawLogPath: string;
    workingDir: string;
    projectPath: string;
    autoMerge: boolean;
    model: string | null;
  },
) {
  const permissionRules =
    ctx.config.permissions.autoApprove.length > 0 || ctx.config.permissions.alwaysDeny.length > 0
      ? { autoApprove: ctx.config.permissions.autoApprove, alwaysDeny: ctx.config.permissions.alwaysDeny }
      : undefined;

  return {
    updateSessionStatus: (id: string, status: any, extra?: any) => ctx.db.updateSessionStatus(id, status, extra),
    saveSessionDiff: (id: string, diff: string, status: string, extra?: any) => ctx.db.saveSessionDiff(id, diff, status, extra),
    insertUsageRecord: (record: any) => ctx.db.insertUsageRecord(record),
    approvalManager: ctx.approvalManager,
    logFile: opts.logFile,
    rawLogPath: opts.rawLogPath,
    pushHub: ctx.pushHub,
    workingDir: opts.workingDir,
    projectPath: opts.projectPath,
    autoMerge: opts.autoMerge,
    model: opts.model,
    orkaHome: ctx.orkaHome,
    getSession: (id: string) => ctx.db.getSession(id),
    permissionRules,
    respondToRequest: (threadId: string, requestId: string, decision: any) =>
      ctx.providerService.respondToRequest(threadId, requestId, decision),
    denyHookApprovals: (id: string) => ctx.hookApprovalBridge.denyAllForSession(id),
    cleanupWorktree: async () => {
      const currentSession = ctx.db.getSession(sessionId);
      if (currentSession) {
        await tryCleanupWorktree(ctx, currentSession);
      }
    },
    onSessionIdle: (id: string) => startIdleTimer(ctx, id),
  };
}

// --- Spawn ---

/** Spawn a new agent session. Returns the created session. */
export async function spawnSession(ctx: DaemonContext, req: SpawnRequest): Promise<Session> {
  return withSpan("orka.spawn", {
    "orka.backend": req.backend,
    "orka.project": req.projectPath,
    ...(req.model ? { "orka.model": req.model } : {}),
  }, async (span) => {
    // Verify backend CLI is installed
    assertBackendInstalled(req.backend);

    // Check concurrent session limit (only "running" counts)
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
      model: req.model ?? null,
      createdAt: now,
    };
    ctx.db.insertTask(task);

    // 2. Prepare workspace — always create worktree for isolation
    let workingDir = projectPath;
    if (req.branch) {
      workingDir = await withSpan("orka.worktree.create", {
        "orka.session.id": sessionId,
        "orka.branch": req.branch,
      }, async () => worktreeCreate(projectPath, sessionId, ctx.orkaHome, { branch: req.branch, config: ctx.config }));
    } else {
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
    // Generate a stable provider session ID for claude-code (used for --resume on continuation)
    const providerSessionId = req.backend === "claude-code" ? crypto.randomUUID() : undefined;

    const session: Session = {
      id: sessionId,
      taskId,
      workspaceId,
      status: "preparing",
      backend: req.backend,
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
      ...(providerSessionId ? { providerSessionId } : {}),
    };
    ctx.db.insertSession(session);

    // 4b. Store tags
    if (req.tags && req.tags.length > 0) {
      ctx.db.insertSessionTags(sessionId, req.tags);
      span.setAttribute("orka.tags", req.tags.join(","));
    }

    // 5. Start provider runtime session
    const supervisedEnv: Record<string, string> = {};
    if (req.permissionMode === "supervised") {
      const hasRules = ctx.config.permissions.autoApprove.length > 0 || ctx.config.permissions.alwaysDeny.length > 0;
      if (hasRules) {
        supervisedEnv["ORKA_PERMISSION_RULES"] = JSON.stringify({
          autoApprove: ctx.config.permissions.autoApprove,
          alwaysDeny: ctx.config.permissions.alwaysDeny,
        });
      }
    }

    const startedAt = new Date().toISOString();
    const handle = await ctx.providerService.startSession(req.backend, {
      threadId: sessionId,
      cwd: workingDir,
      ...(req.model ? { model: req.model } : {}),
      ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      prompt: req.prompt,
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
      env: { ...req.env, ...supervisedEnv },
      ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
      ...(providerSessionId ? { providerSessionId } : {}),
    });

    const rawLogPath = join(logsDir, `${sessionId}.raw.jsonl`);
    ctx.db.updateSessionRawLogFile(sessionId, rawLogPath);

    ctx.db.updateSessionStatus(sessionId, "running", { startedAt });
    recordSessionStartedMetrics();

    void consumeProviderEvents(sessionId, handle, ctx.orchestrationEngine,
      buildConsumerCallbacks(ctx, sessionId, {
        logFile,
        rawLogPath,
        workingDir,
        projectPath,
        autoMerge: session.autoMerge,
        model: req.model ?? null,
      }),
    )
      .catch((error) => {
        console.error(`provider event consumer failed for session ${sessionId}`, error);
      })
      .finally(() => {
        ctx.providerService.clearHandle(sessionId);
        clearIdleTimer(sessionId);
      });

    span.addEvent("session.started");
    return { ...session, status: "running", startedAt };
  });
}

// --- Resume (for hibernated/completed sessions) ---

/** Resume a hibernated or completed session with a new user message.
 *  Spawns a new process with --resume and sends the message. */
export async function resumeSession(
  ctx: DaemonContext,
  sessionId: string,
  prompt: string,
): Promise<void> {
  await withSpan("orka.resume", { "orka.session.id": sessionId }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Recreate worktree if it was cleaned up but the branch still exists
    if (!existsSync(session.workingDir)) {
      Bun.spawnSync(["git", "worktree", "remove", "--force", session.workingDir], { cwd: session.projectPath });

      const branchName = `orka/${sessionId}`;
      try {
        const result = Bun.spawnSync(["git", "branch", "--list", branchName], { cwd: session.projectPath });
        const branchExists = new TextDecoder().decode(result.stdout).trim().length > 0;
        if (branchExists) {
          Bun.spawnSync(["git", "worktree", "add", session.workingDir, branchName], { cwd: session.projectPath });
          span.addEvent("worktree.recreated", { "orka.branch": branchName });
        } else {
          const freshBranch = `orka/${sessionId}-cont`;
          const addResult = Bun.spawnSync(["git", "worktree", "add", "-B", freshBranch, session.workingDir], { cwd: session.projectPath });
          if (addResult.exitCode !== 0) {
            throw new Error(`git worktree add failed: ${new TextDecoder().decode(addResult.stderr)}`);
          }
          span.addEvent("worktree.created_fresh", { "orka.branch": freshBranch });
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("no longer exist")) throw e;
        throw new Error("Failed to recreate session worktree");
      }
    }

    // Clear any stale provider handle
    ctx.providerService.clearHandle(sessionId);

    const startedAt = new Date().toISOString();
    const systemPrompt = session.systemPrompt ?? "";

    // Build prompt — if no provider session ID (old sessions), prepend context
    let fullPrompt = prompt;
    if (!session.providerSessionId) {
      const task = ctx.db.getTask(session.taskId);
      const originalPrompt = task?.prompt ?? "(unknown)";
      let contextBlock = `[CONTEXT: You are continuing a previous session. The original task was:\n${originalPrompt}\n\nThe agent completed that task. The worktree at ${session.workingDir} has all previous changes.`;
      if (session.rawLogFile && existsSync(session.rawLogFile)) {
        contextBlock += `\nFull transcript of previous work is at: ${session.rawLogFile} — read it if you need details.`;
      }
      contextBlock += `]\n\nNew request from user:\n`;
      fullPrompt = contextBlock + prompt;
    }

    const handle = await ctx.providerService.startSession(session.backend, {
      threadId: sessionId,
      cwd: session.workingDir,
      prompt: fullPrompt,
      ...(session.providerSessionId ? { resumeSessionId: session.providerSessionId } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(session.allowedTools ? { allowedTools: session.allowedTools } : {}),
    });

    span.addEvent("session.resumed");

    // Emit user.input event
    ctx.orchestrationEngine.emitDirect({
      type: "user.input",
      sessionId,
      timestamp: startedAt,
      text: prompt,
      v: 1,
    });

    // Reset session status to running
    ctx.db.resetSessionForContinue(sessionId, startedAt);
    ctx.pushHub.broadcast("orchestration.sessionUpdated", { sessionId, status: "running" });
    recordSessionStartedMetrics();

    const task = ctx.db.getTask(session.taskId);
    const rawLogPath = session.rawLogFile ?? join(ctx.orkaHome, "logs", `${sessionId}.raw.jsonl`);

    void consumeProviderEvents(sessionId, handle, ctx.orchestrationEngine,
      buildConsumerCallbacks(ctx, sessionId, {
        logFile: session.logFile,
        rawLogPath,
        workingDir: session.workingDir,
        projectPath: session.projectPath,
        autoMerge: false, // Don't auto-merge on resume — user merges explicitly
        model: task?.model ?? null,
      }),
    )
      .catch((error) => {
        console.error(`provider event consumer failed for resumed session ${sessionId}`, error);
      })
      .finally(() => {
        ctx.providerService.clearHandle(sessionId);
        clearIdleTimer(sessionId);
      });
  });
}

// --- Close ---

/** Explicitly close a session — marks it completed, kills process if alive. */
export async function closeSession(ctx: DaemonContext, sessionId: string): Promise<void> {
  await withSpan("orka.close", { "orka.session.id": sessionId }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    clearIdleTimer(sessionId);

    // Kill process if alive
    const handle = ctx.providerService.getHandle(sessionId);
    if (handle) {
      // Set status BEFORE killing so consumer doesn't overwrite
      ctx.db.updateSessionStatus(sessionId, "completed", { finishedAt: new Date().toISOString() });
      await ctx.providerService.stopSession(sessionId);
    } else {
      ctx.db.updateSessionStatus(sessionId, "completed", { finishedAt: new Date().toISOString() });
    }

    ctx.pushHub.broadcast("orchestration.sessionUpdated", {
      sessionId,
      status: "completed",
    });

    span.addEvent("session.closed");
  });
}

// --- Send Turn (unified: handles idle, hibernated, completed) ---

/** Send a turn to a session. Handles all states transparently:
 *  - idle: write to existing stdin (zero overhead)
 *  - hibernated/completed: spawn --resume process, then send */
export async function sendTurnToSession(
  ctx: DaemonContext,
  sessionId: string,
  text: string,
): Promise<void> {
  return withSpan("orka.sendTurn", { "orka.session.id": sessionId }, async () => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Cancel idle timer — user is sending input
    clearIdleTimer(sessionId);

    switch (session.status) {
      case "running":
      case "idle": {
        // Process is alive — write to stdin directly
        const handle = ctx.providerService.getHandle(sessionId);
        if (!handle) {
          // Process died but status wasn't updated — resume instead
          await resumeSession(ctx, sessionId, text);
          return;
        }

        // If idle, transition back to running
        if (session.status === "idle") {
          ctx.db.updateSessionStatus(sessionId, "running");
          ctx.pushHub.broadcast("orchestration.sessionUpdated", { sessionId, status: "running" });
        }

        // Emit user.input event
        const event = {
          v: 1 as const,
          type: "user.input" as const,
          sessionId,
          text,
          timestamp: new Date().toISOString(),
        };
        ctx.db.insertOrchestrationEvent({
          ...event,
          provider: handle.provider,
          eventId: generateId("evt"),
        });
        ctx.pushHub.broadcast("orchestration.event", event);

        await ctx.providerService.sendTurn(sessionId, { input: text });
        return;
      }

      case "hibernated":
      case "completed": {
        // Process is dead — resume with --resume
        await resumeSession(ctx, sessionId, text);
        return;
      }

      default:
        throw new Error(`Cannot send turn to session in "${session.status}" state`);
    }
  });
}

// --- Stop ---

/** Stop a session via the provider runtime (sets cancelled). */
export async function stopSession(ctx: DaemonContext, sessionId: string): Promise<void> {
  return withSpan("orka.stop", { "orka.session.id": sessionId }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    clearIdleTimer(sessionId);

    // Deny all pending hook-based approvals so the hook scripts unblock
    ctx.hookApprovalBridge.denyAllForSession(sessionId);

    const providerHandle = ctx.providerService.getHandle(sessionId);
    if (providerHandle) {
      await ctx.providerService.stopSession(sessionId);
      span.addEvent("session.stop_requested");
      return;
    }

    const activeStatuses = new Set(["running", "preparing", "idle"]);
    if (!activeStatuses.has(session.status)) {
      span.addEvent("session.stop_skipped_terminal");
      return;
    }

    // Session has no active provider handle but DB says running/idle — mark cancelled
    const finishedAt = new Date().toISOString();
    ctx.db.updateSessionStatus(sessionId, "cancelled", { finishedAt });
    recordSessionTerminalMetrics(session.startedAt, finishedAt, "cancelled");
    ctx.pushHub.broadcast("orchestration.sessionUpdated", {
      sessionId,
      status: "cancelled",
    });

    span.addEvent("session.cancelled");
    await tryCleanupWorktree(ctx, session);
  });
}

// --- Reap / Recover ---

/** Reap orphaned sessions — no-op with provider-only runtime. */
export async function reapSessions(): Promise<number> {
  return withSpan("orka.reap", {}, async () => 0);
}

/** Detect sessions left in active statuses from a previous daemon and mark them. */
export function recoverStaleSessions(ctx: DaemonContext): number {
  const staleStatuses: Array<"running" | "preparing" | "idle"> = ["running", "preparing", "idle"];
  let recovered = 0;
  const now = new Date().toISOString();

  for (const status of staleStatuses) {
    const sessions = ctx.db.listSessions(status);
    for (const session of sessions) {
      if (ctx.providerService.getHandle(session.id)) continue;

      // Idle sessions without a handle → hibernated (process was killed by daemon restart)
      const newStatus = status === "idle" ? "hibernated" : "cancelled";
      ctx.db.updateSessionStatus(session.id, newStatus, newStatus === "cancelled" ? { finishedAt: now } : undefined);

      if (newStatus === "cancelled") {
        ctx.orchestrationEngine.ingest(session.id, {
          type: "session.exited",
          threadId: session.id,
          eventId: generateId("evt"),
          createdAt: now,
          provider: session.backend,
          payload: { reason: "daemon_restart", exitKind: "error" },
        });
      }
      recovered++;
    }
  }

  if (recovered > 0) {
    console.log(`recovered ${recovered} stale session(s) from previous daemon`);
  }

  return recovered;
}

/** Stop a session and all its running children (cascading stop). */
export async function stopWithChildren(ctx: DaemonContext, sessionId: string): Promise<void> {
  return withSpan("orka.stopWithChildren", { "orka.session.id": sessionId }, async () => {
    const children = ctx.db.getChildSessions(sessionId).filter(s => s.status === "running");
    await Promise.all(children.map(c => stopSession(ctx, c.id)));
    await stopSession(ctx, sessionId);
  });
}

// --- Worktree helpers ---

async function tryCleanupWorktree(ctx: DaemonContext, session: Session): Promise<void> {
  const wtDir = getWorktreeDir(ctx.orkaHome);
  if (!session.workingDir.startsWith(wtDir)) return;
  const repoPath = session.projectPath;
  if (!repoPath) return;

  await withSpan("orka.worktree.cleanup", {
    "orka.session.id": session.id,
    "orka.workdir": session.workingDir,
  }, async (span) => {
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

/** Clean up orphaned worktree dirs that don't belong to any active session. */
export async function cleanupOrphanedWorktrees(ctx: DaemonContext): Promise<number> {
  return withSpan("orka.worktree.prune_orphans", {}, async (span) => {
    const wtDir = getWorktreeDir(ctx.orkaHome);
    if (!existsSync(wtDir)) return 0;

    const allSessions = ctx.db.listSessions();
    // Sessions that still need their worktrees
    const activeStatuses = new Set(["running", "preparing", "idle", "hibernated"]);
    const activeWorkdirs = new Set(
      allSessions
        .filter((s) => activeStatuses.has(s.status))
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

// --- Metrics ---

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
