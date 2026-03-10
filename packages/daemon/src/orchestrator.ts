import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import {
  generateId,
  type Session,
  type Task,
  type SpawnRequest,
} from "@orka/core";
import { insertTask, insertSession, updateSessionStatus, getSession, getOrkaHome, listSessions } from "./db";
import { tmuxSpawn, tmuxHas, tmuxKill, tmuxList } from "./tmux";
import { worktreeCreate, worktreeRemove, getWorktreeDir, worktreeHasCommitsAhead, worktreeHasChanges } from "./worktree";
import { buildBackendCommand } from "./backends";
import { getConfig } from "./config";

/** Parse the exit code written by the backend into the log file.
 *  Looks for a line matching `[orka] exit_code=N` in the last 20 lines.
 */
function parseExitCode(logFile: string): number | undefined {
  if (!existsSync(logFile)) return undefined;
  const lines = readFileSync(logFile, "utf8").split("\n");
  const tail = lines.slice(-20);
  for (const line of tail) {
    const match = line.match(/\[orka\] exit_code=(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  return undefined;
}

/** Spawn a new agent session. Returns the created session. */
export async function spawnSession(req: SpawnRequest): Promise<Session> {
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
    workingDir = await worktreeCreate(projectPath, sessionId, req.branch);
  } else if (req.mode === "background") {
    workingDir = await worktreeCreate(projectPath, sessionId);
  }

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
  };
  insertSession(session);

  // 5. Build backend command (with log tee)
  const { command } = buildBackendCommand(req.backend, req.prompt, req.mode, { logFile, sessionId, model: req.model });

  // 6. Write command to script file (avoids bash -c escaping hell)
  const scriptsDir = join(getOrkaHome(), "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = join(scriptsDir, `${sessionId}.sh`);
  writeFileSync(scriptPath, `#!/usr/bin/env bash\n${command}\n`);

  // 7. Spawn tmux session
  await tmuxSpawn(tmuxName, scriptPath, workingDir);
  updateSessionStatus(sessionId, "running", { startedAt: new Date().toISOString() });

  return { ...session, status: "running", startedAt: new Date().toISOString() };
}

/** Reap sessions whose tmux has exited but DB still says "running". */
export async function reapSessions(): Promise<number> {
  const running = listSessions("running");
  if (running.length === 0) return 0;

  const live = await tmuxList();
  const liveNames = new Set(live.map((s) => s.name));
  let reaped = 0;

  for (const s of running) {
    if (!liveNames.has(s.tmuxSessionName)) {
      const exitCode = parseExitCode(s.logFile);
      updateSessionStatus(s.id, "completed", {
        finishedAt: new Date().toISOString(),
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
      await tryCleanupWorktree(s);
      reaped++;
    }
  }

  return reaped;
}

/** Stop a session: kill tmux, update status. */
export async function stopSession(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  if (await tmuxHas(session.tmuxSessionName)) {
    await tmuxKill(session.tmuxSessionName);
  }

  updateSessionStatus(sessionId, "cancelled", {
    finishedAt: new Date().toISOString(),
  });

  await tryCleanupWorktree(session);
}

/** Remove worktree if the session was using one.
 *  Preserves worktrees that have uncommitted changes or commits ahead of parent.
 */
async function tryCleanupWorktree(session: Session): Promise<void> {
  const wtDir = getWorktreeDir();
  if (!session.workingDir.startsWith(wtDir)) return;
  const repoPath = session.projectPath;
  if (!repoPath) return;
  try {
    // Don't remove if there's valuable work
    if (await worktreeHasChanges(session.workingDir)) return;
    if (await worktreeHasCommitsAhead(repoPath, session.workingDir)) return;
    await worktreeRemove(repoPath, session.workingDir);
  } catch {
    // Cleanup failure should not break reap/stop
  }
}

/** Clean up orphaned worktree dirs that don't belong to any active session. */
export async function cleanupOrphanedWorktrees(): Promise<number> {
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
    } catch {
      // skip dirs that can't be removed
    }
  }

  return cleaned;
}
