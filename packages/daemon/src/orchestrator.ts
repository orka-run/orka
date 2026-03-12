import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { $ } from "bun";
import {
  generateId,
  type Session,
  type Task,
  type SpawnRequest,
} from "@orka/core";
import { insertTask, insertSession, insertSessionTags, updateSessionStatus, getSession, getOrkaHome, listSessions, saveSessionDiff, insertUsageRecord } from "./db";
import { defaultRunner } from "./tmux";
import type { SessionRunner } from "./runner";
import { consumeProviderEvents } from "./orchestration";
import { worktreeCreate, worktreeRemove, getWorktreeDir, worktreeHasCommitsAhead, worktreeHasChanges, worktreeMerge, deleteBranch } from "./worktree";
import { buildBackendCommand, buildEnvExports, assertBackendInstalled } from "./backends";
import { getConfig } from "./config";
import { approvalManager, isProviderRuntimeEnabled, orchestrationEngine, providerService } from "./provider-runtime";
import { pushHub } from "./push";
import { getDaemonMetrics, withSpan } from "./tracing";

let _runner: SessionRunner = defaultRunner;

export function setRunner(r: SessionRunner): void {
  _runner = r;
}

export function getRunner(): SessionRunner {
  return _runner;
}

/** Parse the exit code written by the backend into the log file.
 *  Looks for a line matching `[orka] exit_code=N` in the last 20 lines.
 */
function parseExitCode(logFile: string): number | undefined {
  if (!existsSync(logFile)) return undefined;
  const lines = readFileSync(logFile, "utf8").split("\n");
  const tail = lines.slice(-20);
  for (const line of tail) {
    const match = line.match(/\[orka\] exit_code=(\d+)/);
    const exitCode = match?.[1];
    if (exitCode) return parseInt(exitCode, 10);
  }
  return undefined;
}

/** Spawn a new agent session. Returns the created session. */
export async function spawnSession(req: SpawnRequest): Promise<Session> {
  return withSpan("orka.spawn", {
    "orka.backend": req.backend,
    "orka.mode": req.mode,
    "orka.project": req.projectPath,
    ...(req.model ? { "orka.model": req.model } : {}),
  }, async (span) => {
    // Verify backend CLI is installed
    assertBackendInstalled(req.backend);

    // Check concurrent session limit
    const { maxConcurrent } = getConfig().limits;
    if (maxConcurrent > 0) {
      const running = listSessions("running");
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
    const tmuxName = `orka-${sessionId}`;
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
    insertTask(task);

    // 2. Prepare workspace — auto-worktree for background sessions
    let workingDir = projectPath;
    if (req.branch) {
      workingDir = await withSpan("orka.worktree.create", {
        "orka.session.id": sessionId,
        "orka.branch": req.branch,
      }, async () => worktreeCreate(projectPath, sessionId, req.branch));
    } else if (req.mode === "background") {
      workingDir = await withSpan("orka.worktree.create", {
        "orka.session.id": sessionId,
        "orka.branch": `orka/${sessionId}`,
      }, async () => worktreeCreate(projectPath, sessionId));
    }

    span.setAttribute("orka.workdir", workingDir);

    // 3. Log file
    const logsDir = join(getOrkaHome(), "logs");
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
      tmuxSessionName: tmuxName,
      projectPath,
      workingDir,
      logFile,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      kept: false,
      autoMerge: req.autoMerge ?? false,
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
      ...(req.env ? { env: req.env } : {}),
    };
    insertSession(session);

    // 4b. Store tags
    if (req.tags && req.tags.length > 0) {
      insertSessionTags(sessionId, req.tags);
      span.setAttribute("orka.tags", req.tags.join(","));
    }

    if (isProviderRuntimeEnabled()) {
      const startedAt = new Date().toISOString();
      const handle = await providerService.startSession(req.backend, {
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

      updateSessionStatus(sessionId, "running", { startedAt });
      recordSessionStartedMetrics();

      void consumeProviderEvents(sessionId, handle, orchestrationEngine, {
        updateSessionStatus,
        saveSessionDiff,
        insertUsageRecord,
        approvalManager,
        logFile,
        pushHub,
        workingDir,
        projectPath,
        autoMerge: session.autoMerge,
        model: req.model ?? null,
        getSession,
        cleanupWorktree: async () => {
          const currentSession = getSession(sessionId);
          if (currentSession) {
            await tryCleanupWorktree(currentSession);
          }
        },
      })
        .catch((error) => {
          console.error(`provider event consumer failed for session ${sessionId}`, error);
        })
        .finally(() => {
          providerService.clearHandle(sessionId);
        });

      span.addEvent("session.started");
      return { ...session, status: "running", startedAt };
    }

    // 5. Build backend command (with log tee)
    const { command } = buildBackendCommand(req.backend, req.prompt, req.mode, {
      logFile,
      sessionId,
      ...(req.model ? { model: req.model } : {}),
      ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      projectPath,
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
    });

    // 6. Write command to script file (avoids bash -c escaping hell)
    //    Unset CLAUDECODE so nested claude-code sessions don't detect parent and refuse to start.
    const scriptsDir = join(getOrkaHome(), "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = join(scriptsDir, `${sessionId}.sh`);
    const daemonPort = process.env["ORKA_DAEMON_PORT"] ?? "7394";
    writeFileSync(scriptPath, [
      `#!/usr/bin/env bash`,
      ...buildEnvExports(req.env),
      `unset CLAUDECODE`,
      command,
      `_ORKA_EXIT=$?`,
      `curl -sf "http://127.0.0.1:${daemonPort}/session-ended?id=${sessionId}&exitCode=$_ORKA_EXIT" 2>/dev/null || true`,
      `exit $_ORKA_EXIT`,
      "",
    ].join("\n"));

    // 7. Spawn tmux session
    await _runner.spawn(tmuxName, scriptPath, workingDir);

    const startedAt = new Date().toISOString();
    updateSessionStatus(sessionId, "running", { startedAt });
    recordSessionStartedMetrics();

    span.addEvent("session.started");
    return { ...session, status: "running", startedAt };
  });
}

/** Reap sessions whose tmux has exited but DB still says "running". */
export async function reapSessions(): Promise<number> {
  const running = listSessions("running");
  if (running.length === 0) return 0;

  return withSpan("orka.reap", {
    "orka.reap.running_count": running.length,
  }, async (span) => {
    const live = await _runner.list();
    const liveNames = new Set(live.map((s) => s.name));
    let reaped = 0;

    for (const s of running) {
      if (providerService.getHandle(s.id)) {
        span.addEvent("session.reap_skipped_provider_runtime", { "orka.session.id": s.id });
        continue;
      }

      if (!liveNames.has(s.tmuxSessionName)) {
        // Grace period: don't reap sessions started less than 30s ago.
        // tmuxList() can return incomplete results if the tmux server is busy
        // during concurrent spawns, causing false reaps.
        const startedMs = s.startedAt ? new Date(s.startedAt).getTime() : 0;
        if (Date.now() - startedMs < 30_000) {
          span.addEvent("session.reap_skipped_grace", { "orka.session.id": s.id });
          continue;
        }

        // Double-check: tmuxList() may have returned stale/incomplete data.
        // Verify this specific session is truly dead before reaping.
        if (await _runner.has(s.tmuxSessionName)) {
          span.addEvent("session.reap_skipped_alive", { "orka.session.id": s.id });
          continue;
        }

        const exitCode = parseExitCode(s.logFile);
        try {
          const statusText = (await $`git -C ${s.workingDir} status`.text()).trim();
          const diffText = (await $`git -C ${s.workingDir} diff`.text()).trim();
          const extra = await captureBranchDiffForSession(s.workingDir, s.projectPath);
          saveSessionDiff(s.id, diffText, statusText, extra);
        } catch {
          // Worktree may already be gone and diff persistence is best-effort.
        }
        const finishedAt = new Date().toISOString();
        const nextStatus = exitCode !== undefined && exitCode !== 0 ? "failed" : "completed";
        updateSessionStatus(s.id, nextStatus, {
          finishedAt,
          ...(exitCode !== undefined ? { exitCode } : {}),
        });
        recordSessionTerminalMetrics(s.startedAt, finishedAt, nextStatus);
        pushHub.broadcast("orchestration.sessionUpdated", {
          sessionId: s.id,
          status: nextStatus,
        });

        // Safety: kill tmux session in case it's lingering (e.g. remain-on-exit)
        try { await _runner.kill(s.tmuxSessionName); } catch { /* already dead */ }

        span.addEvent("session.reaped", {
          "orka.session.id": s.id,
          "orka.status": nextStatus,
          "orka.exit_code": exitCode ?? -1,
        });

        // Auto-merge on success
        if (s.autoMerge && nextStatus === "completed") {
          await tryAutoMerge(s, span);
        }

        // NOTE: worktree cleanup is NOT done during reap — agents may commit to the
        // main repo while working in a worktree, leaving the worktree "clean" but
        // still needed. Worktrees are cleaned during explicit `orka prune` or `orka merge`.
        reaped++;
      }
    }

    span.setAttribute("orka.reap.reaped_count", reaped);
    return reaped;
  });
}

/** Stop a session: kill tmux, update status. */
export async function stopSession(sessionId: string): Promise<void> {
  return withSpan("orka.stop", { "orka.session.id": sessionId }, async (span) => {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const providerHandle = providerService.getHandle(sessionId);
    if (providerHandle) {
      await providerService.stopSession(sessionId);
      span.addEvent("session.stop_requested");
      return;
    }

    if (isProviderRuntimeEnabled() && session.status !== "running" && session.status !== "preparing") {
      span.addEvent("session.stop_skipped_terminal");
      return;
    }

    if (await _runner.has(session.tmuxSessionName)) {
      await _runner.kill(session.tmuxSessionName);
    }

    try {
      const statusText = (await $`git -C ${session.workingDir} status`.text()).trim();
      const diffText = (await $`git -C ${session.workingDir} diff`.text()).trim();
      const extra = await captureBranchDiffForSession(session.workingDir, session.projectPath);
      saveSessionDiff(sessionId, diffText, statusText, extra);
    } catch {
      // Worktree may already be gone and diff persistence is best-effort.
    }

    const finishedAt = new Date().toISOString();
    updateSessionStatus(sessionId, "cancelled", {
      finishedAt,
    });
    recordSessionTerminalMetrics(session.startedAt, finishedAt, "cancelled");
    pushHub.broadcast("orchestration.sessionUpdated", {
      sessionId,
      status: "cancelled",
    });

    span.addEvent("session.cancelled");
    await tryCleanupWorktree(session);
  });
}

/** Remove worktree if the session was using one.
 *  Preserves worktrees that have uncommitted changes or commits ahead of parent.
 */
/** Auto-merge worktree branch into parent repo on successful completion. */
async function tryAutoMerge(session: Session, parentSpan: any): Promise<void> {
  const wtDir = getWorktreeDir();
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

async function tryCleanupWorktree(session: Session): Promise<void> {
  const wtDir = getWorktreeDir();
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
export async function cleanupOrphanedWorktrees(): Promise<number> {
  return withSpan("orka.worktree.prune_orphans", {}, async (span) => {
    const wtDir = getWorktreeDir();
    if (!existsSync(wtDir)) return 0;

    const allSessions = listSessions();
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
