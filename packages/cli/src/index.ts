#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { join } from "node:path";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { $ } from "bun";
import type { BackendKind, SessionMode } from "@orka/core";
import {
  spawnSession,
  stopSession,
  reapSessions,
  listSessions,
  getSession,
  getTask,
  getConfig,
  tmuxAttach,
  tmuxCapture,
  tmuxHas,
  deleteSessions,
  getOrkaHome,
  cleanupOrphanedWorktrees,
} from "@orka/daemon";

const command = process.argv[2];

// Auto-reap dead sessions on every CLI invocation
await reapSessions();

switch (command) {
  case "spawn":
    await cmdSpawn();
    break;
  case "ps":
    await cmdPs();
    break;
  case "attach":
    await cmdAttach();
    break;
  case "logs":
    await cmdLogs();
    break;
  case "stop":
    await cmdStop();
    break;
  case "diff":
    await cmdDiff();
    break;
  case "retry":
    await cmdRetry();
    break;
  case "show":
    await cmdShow();
    break;
  case "workdir":
    await cmdWorkdir();
    break;
  case "wait":
    await cmdWait();
    break;
  case "prune":
    await cmdPrune();
    break;
  default:
    printUsage();
}

function printUsage(): void {
  console.log("orka — agent session orchestrator");
  console.log("");
  console.log("usage: orka <command>");
  console.log("");
  console.log("commands:");
  console.log("  spawn   Spawn an agent session");
  console.log("  ps      List active sessions");
  console.log("  attach  Attach to a session");
  console.log("  logs    View session logs");
  console.log("  stop    Stop a session");
  console.log("  diff    Show git changes in a session worktree");
  console.log("  show    Show full details for a session");
  console.log("  workdir Print session working directory");
  console.log("  wait    Wait for session(s) to complete");
  console.log("  retry   Re-run a session with the same prompt");
  console.log("  prune   Remove old completed/cancelled/failed sessions");
  console.log("");
  console.log("ps options:");
  console.log("  --status    Filter by status (e.g. running, completed, failed, cancelled)");
  console.log("  --backend   Filter by backend (e.g. claude-code, codex, aider, shell)");
  console.log("");
  console.log("logs options:");
  console.log("  --follow, -f  Stream live output (polls tmux or tail -f log)");
  console.log("");
  console.log("prune options:");
  console.log("  --age       Max age to keep (default: 24h)");
  console.log("");
  console.log("spawn options:");
  console.log("  --project, -p   Project directory (default: .)");
  console.log("  --backend, -b   Agent backend: claude-code|codex|aider|shell (default: claude-code)");
  console.log("  --prompt        Prompt/task for the agent (or use positional args)");
  console.log("  --mode, -m      Session mode: interactive|background (default: interactive)");
  console.log("  --model         Model for claude-code backend (e.g. sonnet, opus, haiku)");
  console.log("  --branch        Git branch (creates worktree if specified)");
  console.log("  --title         Session title");
}

async function cmdSpawn(): Promise<void> {
  const cfg = getConfig().defaults;
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      project: { type: "string", short: "p", default: cfg.project },
      backend: { type: "string", short: "b", default: cfg.backend },
      prompt: { type: "string" },
      mode: { type: "string", short: "m", default: cfg.mode },
      model: { type: "string" },
      branch: { type: "string" },
      title: { type: "string" },
    },
    allowPositionals: true,
  });

  const prompt = args.values.prompt ?? args.positionals.join(" ");

  if (!prompt) {
    console.error("error: prompt is required (use --prompt or positional args)");
    process.exit(1);
  }

  let session;
  try {
    session = await spawnSession({
      prompt,
      title: args.values.title,
      projectPath: args.values.project!,
      backend: args.values.backend as BackendKind,
      mode: args.values.mode as SessionMode,
      model: args.values.model || cfg.model || undefined,
      branch: args.values.branch,
    });
  } catch (e: any) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  console.log(`spawned session ${session.id}`);
  console.log(`  backend:  ${session.backend}`);
  console.log(`  mode:     ${session.mode}`);
  console.log(`  workdir:  ${session.workingDir}`);
  console.log(`  tmux:     ${session.tmuxSessionName}`);
  console.log(`  log:      ${session.logFile}`);

  if (session.mode === "interactive") {
    console.log("");
    console.log("attaching... (detach: Ctrl-b d)");
    await tmuxAttach(session.tmuxSessionName);
  }
}

async function cmdPs(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      status: { type: "string" },
      backend: { type: "string" },
    },
    allowPositionals: false,
  });

  let sessions = listSessions();
  if (args.values.status) {
    sessions = sessions.filter((s) => s.status === args.values.status);
  }
  if (args.values.backend) {
    sessions = sessions.filter((s) => s.backend === args.values.backend);
  }

  if (sessions.length === 0) {
    console.log("no sessions");
    return;
  }

  const noColor = !!process.env["NO_COLOR"];
  const c = (code: string, text: string): string =>
    noColor ? text : `\x1b[${code}m${text}\x1b[0m`;

  const statusColor = (status: string): string => {
    switch (status) {
      case "running": return c("32", status);     // green
      case "completed": return c("2", status);     // dim
      case "failed": return c("31", status);       // red
      case "cancelled": return c("33", status);    // yellow
      case "preparing": return c("34", status);    // blue
      case "queued": return c("34", status);       // blue
      default: return status;
    }
  };

  const running = sessions.filter((s) => s.status === "running").length;
  console.log(c("1", `${running} running / ${sessions.length} total`));
  console.log("");

  console.log(
    padR("ID", 16) +
    padR("STATUS", 20) +
    padR("AGE", 10) +
    padR("BACKEND", 14) +
    "TITLE",
  );
  console.log("-".repeat(76));

  for (const s of sessions) {
    const task = getTask(s.taskId);
    const colored = statusColor(s.status);
    const statusPad = 20 - s.status.length + colored.length;
    console.log(
      padR(s.id, 16) +
      colored.padEnd(statusPad) +
      padR(formatAge(s.createdAt), 10) +
      padR(s.backend, 14) +
      (task?.title ?? "").slice(0, 50),
    );
  }
}

async function cmdAttach(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka attach <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (!(await tmuxHas(session.tmuxSessionName))) {
    console.error(`tmux session not running: ${session.tmuxSessionName}`);
    process.exit(1);
  }

  await tmuxAttach(session.tmuxSessionName);
}

async function cmdLogs(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka logs <session-id> [--follow]");
    process.exit(1);
  }

  const args = parseArgs({
    args: process.argv.slice(4),
    options: {
      follow: { type: "boolean", short: "f", default: false },
    },
    allowPositionals: false,
  });

  const follow = args.values.follow ?? false;

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (!follow) {
    // One-shot: try live tmux capture first
    if (await tmuxHas(session.tmuxSessionName)) {
      const output = await tmuxCapture(session.tmuxSessionName);
      console.log(output);
      return;
    }

    // Fall back to log file
    if (session.logFile && existsSync(session.logFile)) {
      const content = readFileSync(session.logFile, "utf-8");
      console.log(content);
      return;
    }

    console.error("no logs available (session ended, no log file found)");
    process.exit(1);
  }

  // --follow mode
  if (await tmuxHas(session.tmuxSessionName)) {
    // Poll tmux pane every 500ms, printing new output as it arrives
    let offset = 0;
    while (true) {
      const output = await tmuxCapture(session.tmuxSessionName);
      if (output.length > offset) {
        process.stdout.write(output.slice(offset));
        offset = output.length;
      }
      if (!(await tmuxHas(session.tmuxSessionName))) break;
      await Bun.sleep(500);
    }
    return;
  }

  // tmux dead — stream log file with tail -f
  if (session.logFile && existsSync(session.logFile)) {
    const proc = Bun.spawn(["tail", "-f", session.logFile], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    return;
  }

  console.error("no logs available (session ended, no log file found)");
  process.exit(1);
}

async function cmdStop(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka stop <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (session.status !== "running" && session.status !== "preparing") {
    console.error(`session ${session.id} is already ${session.status}`);
    process.exit(1);
  }

  await stopSession(session.id);
  console.log(`stopped session ${session.id}`);
}

async function cmdDiff(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka diff <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  try {
    const status = await $`git -C ${session.workingDir} status`.text();
    console.log(status);

    const diff = await $`git -C ${session.workingDir} diff`.text();
    if (diff) {
      console.log(diff);
    }
  } catch {
    console.error(`error: cannot read git status in ${session.workingDir}`);
    console.error("  (worktree may have been cleaned up)");
    process.exit(1);
  }
}

async function cmdRetry(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka retry <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (session.status === "running") {
    console.error(`session ${session.id} is still running — stop it first`);
    process.exit(1);
  }

  const task = getTask(session.taskId);
  if (!task) {
    console.error(`task not found for session: ${session.id}`);
    process.exit(1);
  }

  const newSession = await spawnSession({
    prompt: task.prompt,
    title: task.title,
    projectPath: session.projectPath || session.workingDir,
    backend: session.backend,
    mode: session.mode,
    model: task.model || undefined,
  });

  console.log(`retried session ${session.id} → ${newSession.id}`);
  console.log(`  backend:  ${newSession.backend}`);
  console.log(`  mode:     ${newSession.mode}`);
  console.log(`  workdir:  ${newSession.workingDir}`);
  console.log(`  tmux:     ${newSession.tmuxSessionName}`);
  console.log(`  log:      ${newSession.logFile}`);

  if (newSession.mode === "interactive") {
    console.log("");
    console.log("attaching... (detach: Ctrl-b d)");
    await tmuxAttach(newSession.tmuxSessionName);
  }
}

async function cmdShow(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka show <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  const task = getTask(session.taskId);

  console.log(`session ${session.id}`);
  console.log("");
  console.log(`  status:    ${session.status}`);
  console.log(`  backend:   ${session.backend}`);
  console.log(`  mode:      ${session.mode}`);
  if (task?.model) console.log(`  model:     ${task.model}`);
  console.log(`  project:   ${session.projectPath || "(unknown)"}`);
  console.log(`  workdir:   ${session.workingDir}`);
  console.log(`  tmux:      ${session.tmuxSessionName}`);
  console.log(`  log:       ${session.logFile}`);
  console.log(`  created:   ${session.createdAt}`);
  console.log(`  started:   ${session.startedAt ?? "(not started)"}`);
  console.log(`  finished:  ${session.finishedAt ?? "(not finished)"}`);
  console.log(`  exit code: ${session.exitCode ?? "(none)"}`);

  if (task) {
    console.log("");
    console.log(`  title:     ${task.title}`);
    console.log(`  prompt:    ${task.prompt}`);
  }
}

async function cmdWorkdir(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka workdir <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  // Print only the path — usable in shell: cd $(orka workdir <id>)
  console.log(session.workingDir);
}

async function cmdWait(): Promise<void> {
  const ids = process.argv.slice(3);
  const allFlag = ids.includes("--all");

  if (ids.length === 0) {
    console.error("usage: orka wait <session-id...> | --all");
    process.exit(1);
  }

  const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
  let targets: string[];

  if (allFlag) {
    const running = listSessions().filter((s) => !terminalStatuses.has(s.status));
    targets = running.map((s) => s.id);
    if (targets.length === 0) {
      console.log("no running sessions to wait for");
      return;
    }
  } else {
    targets = ids.map((id) => {
      const s = findSession(id);
      if (!s) {
        console.error(`session not found: ${id}`);
        process.exit(1);
      }
      return s.id;
    });
  }

  console.log(`waiting for ${targets.length} session(s)...`);
  const pending = new Set(targets);
  let anyFailed = false;

  while (pending.size > 0) {
    await reapSessions();
    for (const id of [...pending]) {
      const s = getSession(id);
      if (!s || terminalStatuses.has(s.status)) {
        pending.delete(id);
        const status = s?.status ?? "unknown";
        const task = s ? getTask(s.taskId) : null;
        const label = task?.title?.slice(0, 50) ?? id;
        console.log(`  ${id}  ${status}  ${label}`);
        if (status === "failed") anyFailed = true;
      }
    }
    if (pending.size > 0) await Bun.sleep(2000);
  }

  console.log("all sessions finished");
  if (anyFailed) process.exit(1);
}

async function cmdPrune(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      age: { type: "string", default: "24h" },
    },
    allowPositionals: false,
  });

  const maxAgeMs = parseAge(args.values.age!);
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const pruneStatuses = new Set(["completed", "cancelled", "failed"]);

  const sessions = listSessions().filter(
    (s) => pruneStatuses.has(s.status) && s.createdAt < cutoff,
  );

  if (sessions.length === 0) {
    console.log("nothing to prune");
    return;
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

  deleteSessions(sessions.map((s) => s.id));
  console.log(`pruned ${sessions.length} session(s)`);

  // Clean up orphaned worktree dirs
  const orphans = await cleanupOrphanedWorktrees();
  if (orphans > 0) {
    console.log(`cleaned ${orphans} orphaned worktree(s)`);
  }
}

function parseAge(age: string): number {
  const match = age.match(/^(\d+)\s*(h|d|m)$/);
  if (!match) {
    console.error("error: invalid --age format, use e.g. 24h, 7d, 30m");
    process.exit(1);
  }
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return value * 60 * 60 * 1000;
  }
}

// --- Helpers ---

function findSession(query: string) {
  const exact = getSession(query);
  if (exact) return exact;

  const all = listSessions();
  const matches = all.filter((s) => s.id.includes(query));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`ambiguous session id "${query}", matches:`);
    for (const m of matches) console.error(`  ${m.id}`);
    process.exit(1);
  }
  return null;
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function padR(s: string, n: number): string {
  return s.padEnd(n);
}
