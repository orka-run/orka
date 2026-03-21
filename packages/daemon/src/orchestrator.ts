import { join } from "node:path";
import { resolveProject } from "./projects";
import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import {
  generateId,
  type BackendKind,
  type PermissionMode,
  type ProviderApprovalDecision,
  type ProviderSessionHandle,
  type RateLimitInfo,
  type ReasoningEffort,
  type Session,
  type SessionStatus,
  type Task,
  type SpawnRequest,
  type UsageRecord,
} from "@orka/core";
import { captureCheckpoint, revertToCheckpoint, deleteCheckpointRefsAfter } from "./checkpointing";
import { consumeProviderEvents } from "./orchestration";
import { worktreeCreate, worktreeRemove, getWorktreeDir, worktreeHasCommitsAhead, worktreeHasChanges } from "./worktree";
import { assertBackendInstalled } from "./backends";
import type { DaemonContext } from "./daemon-context";
import { loadProjectConfig, mergeConfigs, resolveProjectEnv } from "./config";
import { getDaemonMetrics, withSpan } from "./tracing";

// --- Idle timer management ---

const AUTO_RESUME_PROMPT = "Please continue from where you left off after the rate limit reset.";

function clearIdleTimer(ctx: DaemonContext, sessionId: string): void {
  const timer = ctx.sessionRuntime.idleTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    ctx.sessionRuntime.idleTimers.delete(sessionId);
  }
}

function startIdleTimer(ctx: DaemonContext, sessionId: string): void {
  clearIdleTimer(ctx, sessionId);

  const timeoutMinutes = ctx.config.limits.idleTimeoutMinutes ?? 10;
  if (timeoutMinutes <= 0) return; // 0 = no auto-hibernate

  const timer = setTimeout(() => {
    ctx.sessionRuntime.idleTimers.delete(sessionId);
    void hibernateSession(ctx, sessionId);
  }, timeoutMinutes * 60_000);
  timer.unref(); // Don't prevent process exit

  ctx.sessionRuntime.idleTimers.set(sessionId, timer);
}

function clearRateLimitTimer(ctx: DaemonContext, sessionId: string): void {
  const timer = ctx.sessionRuntime.rateLimitTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    ctx.sessionRuntime.rateLimitTimers.delete(sessionId);
  }
}

function clearPendingRateLimit(ctx: DaemonContext, sessionId: string): void {
  ctx.sessionRuntime.pendingRateLimits.delete(sessionId);
}

function clearRateLimitState(ctx: DaemonContext, sessionId: string): void {
  clearRateLimitTimer(ctx, sessionId);
  clearPendingRateLimit(ctx, sessionId);
}

function rememberRateLimitEvent(ctx: DaemonContext, sessionId: string, info: RateLimitInfo): void {
  if (info.status === "rejected") {
    ctx.sessionRuntime.pendingRateLimits.set(sessionId, {
      rateLimitType: info.rateLimitType,
      resetsAt: info.resetsAt,
    });
    return;
  }

  clearPendingRateLimit(ctx, sessionId);
}

function consumePendingRateLimit(
  ctx: DaemonContext,
  sessionId: string,
): { rateLimitType: string; resetsAt: number } | null {
  const info = ctx.sessionRuntime.pendingRateLimits.get(sessionId) ?? null;
  clearPendingRateLimit(ctx, sessionId);
  return info;
}

function scheduleRateLimitResume(
  ctx: DaemonContext,
  sessionId: string,
  rateLimit: { rateLimitType: string; resetsAt: number },
): string {
  clearRateLimitTimer(ctx, sessionId);

  const scheduledResumeAt = new Date(rateLimit.resetsAt * 1000).toISOString();
  const delayMs = Math.max(0, rateLimit.resetsAt * 1000 - Date.now());
  const timer = setTimeout(() => {
    ctx.sessionRuntime.rateLimitTimers.delete(sessionId);
    void withSpan("orka.resume.rate_limit_auto", {
      "orka.session.id": sessionId,
      "orka.rate_limit.type": rateLimit.rateLimitType,
      "orka.rate_limit.resets_at": rateLimit.resetsAt,
    }, async (span) => {
      const session = ctx.db.getSession(sessionId);
      if (!session || session.status !== "rate_limited") {
        span.addEvent("auto_resume.skipped");
        return;
      }

      try {
        await resumeSession(ctx, sessionId, AUTO_RESUME_PROMPT, { emitUserInput: false });
        span.addEvent("auto_resume.completed");
      } catch (error) {
        span.recordException(error as Error);
        console.error(`auto-resume failed for session ${sessionId}`, error);

        const current = ctx.db.getSession(sessionId);
        if (current?.status === "rate_limited") {
          ctx.db.updateSessionStatus(sessionId, "hibernated");
          ctx.pushHub.broadcast("orchestration.sessionUpdated", {
            sessionId,
            status: "hibernated",
          });
        }
      }
    });
  }, delayMs);
  timer.unref();

  ctx.sessionRuntime.rateLimitTimers.set(sessionId, timer);
  return scheduledResumeAt;
}

function markSessionRateLimited(
  ctx: DaemonContext,
  sessionId: string,
  rateLimit: { rateLimitType: string; resetsAt: number },
  timestamp: string,
): void {
  ctx.db.updateSessionStatus(sessionId, "rate_limited");
  const scheduledResumeAt = scheduleRateLimitResume(ctx, sessionId, rateLimit);
  ctx.orchestrationEngine.emitDirect({
    type: "session.rate_limited",
    sessionId,
    rateLimitType: rateLimit.rateLimitType,
    resetsAt: rateLimit.resetsAt,
    scheduledResumeAt,
    timestamp,
    v: 1,
  });
  ctx.pushHub.broadcast("orchestration.sessionUpdated", {
    sessionId,
    status: "rate_limited",
  });
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

function getNextCheckpointTurnSeq(ctx: DaemonContext, sessionId: string): number {
  const current = ctx.sessionRuntime.turnCounts.get(sessionId);
  if (current !== undefined) {
    const next = current + 1;
    ctx.sessionRuntime.turnCounts.set(sessionId, next);
    return next;
  }

  const last = ctx.db.getCheckpoints(sessionId).at(-1)?.turnSeq ?? -1;
  const next = last + 1;
  ctx.sessionRuntime.turnCounts.set(sessionId, next);
  return next;
}

function queueCheckpointCapture(
  ctx: DaemonContext,
  sessionId: string,
  turnSeq: number,
  workingDir: string,
): void {
  const previous = ctx.sessionRuntime.checkpointCaptureChains.get(sessionId) ?? Promise.resolve();
  const captureTask = previous
    .catch(() => undefined)
    .then(async () => {
      const checkpoint = await captureCheckpoint(workingDir, sessionId, turnSeq);
      ctx.db.insertCheckpoint(checkpoint);
    })
    .catch((error) => {
      console.error(`checkpoint capture failed for session ${sessionId} turn ${turnSeq}`, error);
    });

  ctx.sessionRuntime.checkpointCaptureChains.set(sessionId, captureTask);
  void captureTask.finally(() => {
    if (ctx.sessionRuntime.checkpointCaptureChains.get(sessionId) === captureTask) {
      ctx.sessionRuntime.checkpointCaptureChains.delete(sessionId);
    }
  });
}

function emitUserInputEvent(
  ctx: DaemonContext,
  sessionId: string,
  text: string,
  provider: string,
  queued = false,
): void {
  const event = {
    v: 1 as const,
    type: "user.input" as const,
    sessionId,
    text,
    timestamp: new Date().toISOString(),
    ...(queued ? { queued: true } : {}),
  };

  ctx.db.insertOrchestrationEvent({
    ...event,
    provider,
    eventId: generateId("evt"),
  });
  ctx.pushHub.broadcast("orchestration.event", event);
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
    afterCompleteHook?: string;
  },
) {
  const permissionRules =
    ctx.config.permissions.autoApprove.length > 0 || ctx.config.permissions.alwaysDeny.length > 0
      ? { autoApprove: ctx.config.permissions.autoApprove, alwaysDeny: ctx.config.permissions.alwaysDeny }
      : undefined;

  return {
    updateSessionStatus: (id: string, status: SessionStatus, extra?: { startedAt?: string; finishedAt?: string; exitCode?: number }) => ctx.db.updateSessionStatus(id, status, extra),
    saveSessionDiff: (id: string, diff: string, status: string, extra?: { commitLog?: string; commitDiff?: string }) => ctx.db.saveSessionDiff(id, diff, status, extra),
    insertUsageRecord: (record: UsageRecord) => ctx.db.insertUsageRecord(record),
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
    ...(permissionRules ? { permissionRules } : {}),
    respondToRequest: (threadId: string, requestId: string, decision: ProviderApprovalDecision) =>
      ctx.providerService.respondToRequest(threadId, requestId, decision),
    denyHookApprovals: (id: string) => ctx.hookApprovalBridge.denyAllForSession(id),
    cleanupWorktree: async () => {
      const currentSession = ctx.db.getSession(sessionId);
      if (currentSession) {
        await tryCleanupWorktree(ctx, currentSession);
      }
    },
    onSessionIdle: (id: string) => startIdleTimer(ctx, id),
    onTurnCheckpoint: (id: string, turnSeq: number, workingDir: string) => {
      queueCheckpointCapture(ctx, id, turnSeq, workingDir);
    },
    getNextTurnSeq: (id: string) => getNextCheckpointTurnSeq(ctx, id),
    rememberRateLimitEvent: (id: string, info: RateLimitInfo) => rememberRateLimitEvent(ctx, id, info),
    consumePendingRateLimit: (id: string) => consumePendingRateLimit(ctx, id),
    clearPendingRateLimit: (id: string) => clearPendingRateLimit(ctx, id),
    onSessionRateLimited: (id: string, rateLimit: { rateLimitType: string; resetsAt: number }, timestamp: string) => {
      markSessionRateLimited(ctx, id, rateLimit, timestamp);
    },
    autoMergeFired: ctx.sessionRuntime.autoMergeFired,
    clearPendingMessages: (id: string) => {
      ctx.sessionRuntime.pendingMessages.delete(id);
    },
    deliverPendingMessages: async (id: string) => {
      const queuedMessages = ctx.sessionRuntime.pendingMessages.get(id);
      if (!queuedMessages || queuedMessages.length === 0) {
        return false;
      }

      const text = queuedMessages.join("\n\n");
      await ctx.providerService.sendTurn(id, { input: text });
      ctx.sessionRuntime.pendingMessages.delete(id);
      ctx.db.updateSessionStatus(id, "running");
      ctx.pushHub.broadcast("orchestration.sessionUpdated", {
        sessionId: id,
        status: "running",
      });
      return true;
    },
    ...(opts.afterCompleteHook ? {
      onAfterComplete: async () => {
        // Fire-and-forget: run after_complete hook in the session's workingDir
        Bun.spawn(["sh", "-c", opts.afterCompleteHook ?? ""], {
          cwd: opts.workingDir,
          stdout: "ignore",
          stderr: "ignore",
        });
      },
    } : {}),
  };
}

// --- Provider launch ---

interface LaunchOptions {
  sessionId: string;
  backend: BackendKind;
  cwd: string;
  prompt: string;
  permissionMode?: PermissionMode;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  resumeSessionId?: string;
  providerSessionId?: string;
  env?: Record<string, string>;
}

/** Start a provider process for a session.
 *  Passes permissionMode and permissionRules to the adapter, which handles all
 *  supervised-mode setup (hook settings, env vars) internally. */
async function launchProviderSession(
  ctx: DaemonContext,
  opts: LaunchOptions,
): Promise<ProviderSessionHandle> {
  const { permissions } = ctx.config;
  const hasRules = permissions.autoApprove.length > 0 || permissions.alwaysDeny.length > 0;

  return ctx.providerService.startSession(opts.backend, {
    threadId: opts.sessionId,
    cwd: opts.cwd,
    prompt: opts.prompt,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(hasRules ? { permissionRules: { autoApprove: permissions.autoApprove, alwaysDeny: permissions.alwaysDeny } } : {}),
    ...(opts.providerSessionId ? { providerSessionId: opts.providerSessionId } : {}),
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
  });
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

    const projectPath = resolveProject(req.projectPath);
    const taskId = generateId("task");
    const sessionId = generateId("sess");
    const now = new Date().toISOString();

    // Resolve or auto-create workspace for this project path
    let workspaceId = ctx.db.resolveWorkspaceForPath(projectPath);
    if (!workspaceId) {
      workspaceId = generateId("ws");
      const { basename } = require("node:path");
      ctx.db.insertWorkspace({ id: workspaceId, name: basename(projectPath), createdAt: now });
      ctx.db.addWorkspacePath(workspaceId, projectPath);
    }

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

    // 2. Prepare workspace — create worktree for isolation (unless --no-worktree)
    let workingDir = projectPath;
    const inPlace = req.noWorktree === true;
    if (!inPlace) {
      const branch = req.branch;
      if (branch) {
        workingDir = await withSpan("orka.worktree.create", {
          "orka.session.id": sessionId,
          "orka.branch": branch,
        }, async () =>
          worktreeCreate(projectPath, sessionId, ctx.orkaHome, {
            branch,
            config: ctx.config,
          }),
        );
      } else {
        workingDir = await withSpan("orka.worktree.create", {
          "orka.session.id": sessionId,
          "orka.branch": `orka/${sessionId}`,
        }, async () => worktreeCreate(projectPath, sessionId, ctx.orkaHome, { config: ctx.config }));
      }
    }

    span.setAttribute("orka.workdir", workingDir);

    // 2b. Load project config for env propagation and hooks
    const projectConfig = loadProjectConfig(projectPath);
    const spawnConfig = projectConfig ? mergeConfigs(ctx.config, projectConfig) : ctx.config;

    // 2c. Resolve project env (static + dynamic + CLI)
    const resolvedEnv = await resolveProjectEnv(spawnConfig, projectPath, req.env);

    // 2d. Run before_spawn hook if defined
    if (spawnConfig.hooks.beforeSpawn) {
      await withSpan("orka.hooks.before_spawn", { "orka.session.id": sessionId }, async () => {
        const proc = Bun.spawn(["sh", "-c", spawnConfig.hooks.beforeSpawn ?? ""], {
          cwd: workingDir,
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
      });
    }

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
      ...(resolvedEnv ? { env: resolvedEnv } : {}),
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
      ...(inPlace ? { noWorktree: true } : {}),
    };
    ctx.db.insertSession(session);
    clearRateLimitState(ctx, sessionId);

    // 4b. Store tags
    if (req.tags && req.tags.length > 0) {
      ctx.db.insertSessionTags(sessionId, req.tags);
      span.setAttribute("orka.tags", req.tags.join(","));
    }

    // 5. Start provider runtime session
    const startedAt = new Date().toISOString();
    const handle = await launchProviderSession(ctx, {
      sessionId,
      backend: req.backend,
      cwd: workingDir,
      prompt: req.prompt,
      ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(resolvedEnv ? { env: resolvedEnv } : {}),
    });

    const rawLogPath = join(logsDir, `${sessionId}.raw.jsonl`);
    ctx.db.updateSessionRawLogFile(sessionId, rawLogPath);

    ctx.db.updateSessionStatus(sessionId, "running", { startedAt });
    ctx.sessionRuntime.turnCounts.set(sessionId, 0);
    queueCheckpointCapture(ctx, sessionId, 0, workingDir);
    recordSessionStartedMetrics();

    // Emit user.input event for the initial prompt
    ctx.orchestrationEngine.emitDirect({
      type: "user.input",
      sessionId,
      timestamp: startedAt,
      text: req.prompt,
      v: 1,
    });

    void consumeProviderEvents(sessionId, handle, ctx.orchestrationEngine,
      buildConsumerCallbacks(ctx, sessionId, {
        logFile,
        rawLogPath,
        workingDir,
        projectPath,
        autoMerge: session.autoMerge,
        model: req.model ?? null,
        ...(spawnConfig.hooks.afterComplete ? { afterCompleteHook: spawnConfig.hooks.afterComplete } : {}),
      }),
    )
      .catch((error) => {
        console.error(`provider event consumer failed for session ${sessionId}`, error);
      })
      .finally(() => {
        ctx.providerService.clearHandle(sessionId);
        clearIdleTimer(ctx, sessionId);
      });

    span.addEvent("session.started");
    return { ...session, status: "running", startedAt, ...(resolvedEnv ? { env: resolvedEnv } : {}) };
  });
}

// --- Resume (for hibernated/completed sessions) ---

/** Resume a hibernated or completed session with a new user message.
 *  Spawns a new process with --resume and sends the message. */
export async function resumeSession(
  ctx: DaemonContext,
  sessionId: string,
  prompt: string,
  options: { emitUserInput?: boolean } = {},
): Promise<void> {
  await withSpan("orka.resume", { "orka.session.id": sessionId }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const emitUserInput = options.emitUserInput ?? true;

    // Recreate worktree if it was cleaned up but the branch still exists
    // In-place sessions have no worktree to recreate
    if (!session.noWorktree && !existsSync(session.workingDir)) {
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
    clearRateLimitState(ctx, sessionId);

    const startedAt = new Date().toISOString();

    // Restore env vars, model, and task from DB for the resumed process
    const sessionEnv = ctx.db.getSessionEnv(sessionId) ?? undefined;
    const task = ctx.db.getTask(session.taskId);

    // Build prompt — if no provider session ID (old sessions), prepend context
    let fullPrompt = prompt;
    if (!session.providerSessionId) {
      const originalPrompt = task?.prompt ?? "(unknown)";
      let contextBlock = `[CONTEXT: You are continuing a previous session. The original task was:\n${originalPrompt}\n\nThe agent completed that task. The worktree at ${session.workingDir} has all previous changes.`;
      if (session.rawLogFile && existsSync(session.rawLogFile)) {
        contextBlock += `\nFull transcript of previous work is at: ${session.rawLogFile} — read it if you need details.`;
      }
      contextBlock += `]\n\nNew request from user:\n`;
      fullPrompt = contextBlock + prompt;
    }

    // Read permissionMode from DB; fall back to filesystem detection for old sessions
    let permissionMode = session.permissionMode;
    if (!permissionMode) {
      const hookSettingsPath = join(session.workingDir, ".claude", "settings.json");
      if (existsSync(hookSettingsPath)) {
        permissionMode = "supervised";
      }
    }

    const handle = await launchProviderSession(ctx, {
      sessionId,
      backend: session.backend,
      cwd: session.workingDir,
      prompt: fullPrompt,
      ...(permissionMode ? { permissionMode } : {}),
      ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
      ...(session.allowedTools ? { allowedTools: session.allowedTools } : {}),
      ...(task?.model ? { model: task.model } : {}),
      ...(session.providerSessionId ? { resumeSessionId: session.providerSessionId } : {}),
      ...(sessionEnv ? { env: sessionEnv } : {}),
    });

    span.addEvent("session.resumed");

    // Emit user.input event
    if (emitUserInput) {
      ctx.orchestrationEngine.emitDirect({
        type: "user.input",
        sessionId,
        timestamp: startedAt,
        text: prompt,
        v: 1,
      });
    }

    // Reset session status to running
    ctx.db.resetSessionForContinue(sessionId, startedAt);
    ctx.pushHub.broadcast("orchestration.sessionUpdated", { sessionId, status: "running" });
    recordSessionStartedMetrics();

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
        clearIdleTimer(ctx, sessionId);
      });
  });
}

// --- Revert ---

/** Revert a session to a previous checkpoint.
 *  - files mode: restore worktree files to checkpoint state, keep conversation intact
 *  - files_and_conversation mode: restore files, kill process, truncate events,
 *    generate new providerSessionId so the next resume starts a fresh conversation
 *    with history up to the reverted turn injected as context */
export async function revertSessionToTurn(
  ctx: DaemonContext,
  sessionId: string,
  turnSeq: number,
  mode: "files" | "files_and_conversation",
): Promise<void> {
  await withSpan("orka.revert", {
    "orka.session.id": sessionId,
    "orka.turn.seq": turnSeq,
    "orka.revert.mode": mode,
  }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const checkpoint = ctx.db.getCheckpoint(sessionId, turnSeq);
    if (!checkpoint) throw new Error(`Checkpoint not found for session ${sessionId} turn ${turnSeq}`);
    if (checkpoint.status !== "ready") {
      throw new Error(`Checkpoint ${turnSeq} is not revertible (status=${checkpoint.status})`);
    }

    // For files_and_conversation mode, we need to stop the process first
    if (mode === "files_and_conversation") {
      const activeStatuses = new Set(["running", "idle", "rate_limited"]);
      if (activeStatuses.has(session.status)) {
        // Stop the process
        clearIdleTimer(ctx, sessionId);
        ctx.sessionRuntime.pendingMessages.delete(sessionId);
        clearRateLimitState(ctx, sessionId);
        ctx.hookApprovalBridge.denyAllForSession(sessionId);

        const handle = ctx.providerService.getHandle(sessionId);
        if (handle) {
          await ctx.providerService.stopSession(sessionId);
        }
      }
    } else {
      // files-only: must not be running
      if (session.status === "running" || session.status === "preparing") {
        throw new Error(`Session ${sessionId} must not be running to revert files`);
      }
    }

    // 1. Restore worktree files to checkpoint state
    const gitDir = session.noWorktree ? session.workingDir : session.projectPath;
    await revertToCheckpoint(session.workingDir, checkpoint.gitRef);
    span.addEvent("files.reverted");

    // 2. Clean up checkpoint refs and DB records after the target turn
    await deleteCheckpointRefsAfter(gitDir, sessionId, turnSeq);
    ctx.db.deleteCheckpoints(sessionId, turnSeq);
    ctx.sessionRuntime.turnCounts.set(sessionId, turnSeq);

    // 3. For files_and_conversation mode: truncate events and reset conversation
    if (mode === "files_and_conversation") {
      // Delete orchestration events that happened after the checkpoint
      ctx.db.deleteOrchestrationEventsAfter(sessionId, checkpoint.createdAt);
      span.addEvent("events.truncated");

      // Generate a new provider session ID so the next --resume starts a fresh conversation
      // (the old provider session ID still has the full history in Claude's system)
      const newProviderSessionId = session.backend === "claude-code" ? crypto.randomUUID() : undefined;
      if (newProviderSessionId) {
        ctx.db.updateSessionProviderSessionId(sessionId, newProviderSessionId);
      }

      // Mark session as completed so it can be resumed with the new context
      ctx.db.updateSessionStatus(sessionId, "completed", { finishedAt: new Date().toISOString() });
      ctx.pushHub.broadcast("orchestration.sessionUpdated", { sessionId, status: "completed" });
      span.addEvent("conversation.reset");
    }

    // 4. Emit session.reverted event
    ctx.orchestrationEngine.emitDirect({
      type: "session.reverted",
      sessionId,
      turnSeq,
      mode,
      timestamp: new Date().toISOString(),
      v: 1,
    });

    span.addEvent("session.reverted");
  });
}

// --- Close ---

/** Explicitly close a session — marks it completed, kills process if alive. */
export async function closeSession(ctx: DaemonContext, sessionId: string): Promise<void> {
  await withSpan("orka.close", { "orka.session.id": sessionId }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    clearIdleTimer(ctx, sessionId);
    ctx.sessionRuntime.pendingMessages.delete(sessionId);
    clearRateLimitState(ctx, sessionId);

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
 *  - running: queue follow-up input until the current turn completes
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
    clearIdleTimer(ctx, sessionId);

    switch (session.status) {
      case "running":
      case "idle": {
        // Process is alive — steer mid-turn (codex) or queue (claude), or write directly when idle
        const handle = ctx.providerService.getHandle(sessionId);
        if (!handle) {
          // Process died but status wasn't updated — resume instead
          await resumeSession(ctx, sessionId, text);
          return;
        }

        if (session.status === "running") {
          // Codex supports mid-turn steering — inject immediately instead of queuing
          if (ctx.providerService.supportsSteer(sessionId)) {
            try {
              await ctx.providerService.steerTurn(sessionId, { input: text });
              emitUserInputEvent(ctx, sessionId, text, handle.provider);
              return;
            } catch {
              // steerTurn failed (e.g. no active turn) — fall through to queue
            }
          }

          // Claude Code (and steer failures): queue for delivery after turn completes
          const pending = ctx.sessionRuntime.pendingMessages.get(sessionId) ?? [];
          pending.push(text);
          ctx.sessionRuntime.pendingMessages.set(sessionId, pending);
          emitUserInputEvent(ctx, sessionId, text, handle.provider, true);
          return;
        }

        // If idle, transition back to running
        if (session.status === "idle") {
          ctx.db.updateSessionStatus(sessionId, "running");
          ctx.pushHub.broadcast("orchestration.sessionUpdated", { sessionId, status: "running" });
        }

        emitUserInputEvent(ctx, sessionId, text, handle.provider);

        await ctx.providerService.sendTurn(sessionId, { input: text });
        return;
      }

      case "rate_limited":
      case "hibernated":
      case "interrupted":
      case "completed":
      case "failed":
      case "cancelled": {
        // Process is dead — resume with --resume
        await resumeSession(ctx, sessionId, text);
        return;
      }

      default:
        throw new Error(`Cannot send turn to session in "${session.status}" state`);
    }
  });
}

// --- Cancel Turn ---

/** Cancel the active turn for a running session. No-op if no turn is active. */
export async function cancelTurnInSession(ctx: DaemonContext, sessionId: string): Promise<void> {
  return withSpan("orka.cancelTurn", { "orka.session.id": sessionId }, async () => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const handle = ctx.providerService.getHandle(sessionId);
    if (!handle) return; // No active process — nothing to cancel

    await ctx.providerService.cancelTurn(sessionId);

    // Keep queued messages — they will be delivered when turn.aborted is
    // processed by the consumer, so the agent picks up the user's follow-up.
  });
}

// --- Cancel queued message ---

/** Remove a queued (not yet delivered) message from the pending queue by text match. */
export function cancelQueuedMessageFromSession(
  ctx: DaemonContext,
  sessionId: string,
  text: string,
): void {
  const pending = ctx.sessionRuntime.pendingMessages.get(sessionId);
  if (!pending || pending.length === 0) {
    throw new Error("No queued messages for this session");
  }

  const idx = pending.indexOf(text);
  if (idx === -1) {
    throw new Error("Queued message not found");
  }

  pending.splice(idx, 1);
  if (pending.length === 0) {
    ctx.sessionRuntime.pendingMessages.delete(sessionId);
  }

  const handle = ctx.providerService.getHandle(sessionId);
  const provider = handle?.provider ?? "unknown";

  const event = {
    v: 1 as const,
    type: "user.input_cancelled" as const,
    sessionId,
    text,
    timestamp: new Date().toISOString(),
  };

  ctx.db.insertOrchestrationEvent({
    ...event,
    provider,
    eventId: generateId("evt"),
  });
  ctx.pushHub.broadcast("orchestration.event", event);
}

// --- Stop ---

/** Stop a session via the provider runtime (sets cancelled). */
export async function stopSession(ctx: DaemonContext, sessionId: string): Promise<void> {
  return withSpan("orka.stop", { "orka.session.id": sessionId }, async (span) => {
    const session = ctx.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    clearIdleTimer(ctx, sessionId);
    ctx.sessionRuntime.pendingMessages.delete(sessionId);
    clearRateLimitState(ctx, sessionId);

    // Deny all pending hook-based approvals so the hook scripts unblock
    ctx.hookApprovalBridge.denyAllForSession(sessionId);

    const providerHandle = ctx.providerService.getHandle(sessionId);
    if (providerHandle) {
      await ctx.providerService.stopSession(sessionId);
      span.addEvent("session.stop_requested");
      return;
    }

    const activeStatuses = new Set(["running", "preparing", "idle", "rate_limited"]);
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

/** Detect sessions left in active statuses from a previous daemon and mark them.
 *  Sessions that were actively running are marked "interrupted" (not "cancelled")
 *  to distinguish daemon restarts from explicit user cancellation. */
export function recoverStaleSessions(ctx: DaemonContext): number {
  const staleStatuses: Array<"running" | "preparing" | "idle" | "rate_limited"> = ["running", "preparing", "idle", "rate_limited"];
  let recovered = 0;
  const now = new Date().toISOString();

  for (const status of staleStatuses) {
    const sessions = ctx.db.listSessions(status);
    for (const session of sessions) {
      if (ctx.providerService.getHandle(session.id)) continue;

      clearRateLimitTimer(ctx, session.id);
      clearPendingRateLimit(ctx, session.id);

      // "preparing" sessions never ran → cancelled
      // All others were active when daemon died → interrupted
      const newStatus = status === "preparing" ? "cancelled" : "interrupted";
      ctx.db.updateSessionStatus(session.id, newStatus, { finishedAt: now });

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
    const activeStatuses = new Set(["running", "preparing", "idle", "rate_limited", "hibernated", "interrupted"]);
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
