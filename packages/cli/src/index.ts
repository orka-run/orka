#!/usr/bin/env bun

import { parseArgs } from "node:util";
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
  tmuxAttach,
  tmuxCapture,
  tmuxHas,
  deleteSessions,
  getConfig,
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
  console.log("  retry   Re-run a session with the same prompt");
  console.log("  prune   Remove old completed/cancelled/failed sessions");
  console.log("");
  console.log("prune options:");
  console.log("  --age       Max age to keep (default: 24h)");
  console.log("");
  console.log("spawn options:");
  console.log("  --project, -p   Project directory (default: .)");
  console.log("  --backend, -b   Agent backend: claude-code|codex|aider|shell (default: claude-code)");
  console.log("  --prompt        Prompt/task for the agent (or use positional args)");
  console.log("  --mode, -m      Session mode: interactive|background (default: interactive)");
  console.log("  --branch        Git branch (creates worktree if specified)");
  console.log("  --title         Session title");
}

async function cmdSpawn(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      project: { type: "string", short: "p" },
      backend: { type: "string", short: "b" },
      prompt: { type: "string" },
      mode: { type: "string", short: "m" },
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

  const config = getConfig();

  const session = await spawnSession({
    prompt,
    title: args.values.title,
    projectPath: args.values.project ?? config.defaults.project ?? ".",
    backend: (args.values.backend ?? config.defaults.backend ?? "claude-code") as BackendKind,
    mode: (args.values.mode ?? config.defaults.mode ?? "interactive") as SessionMode,
    branch: args.values.branch,
  });

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
  const sessions = listSessions();

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
    padR("STATUS", 20) +  // extra for ANSI codes
    padR("BACKEND", 14) +
    padR("MODE", 14) +
    "TITLE",
  );
  console.log("-".repeat(76));

  for (const s of sessions) {
    const task = getTask(s.taskId);
    const colored = statusColor(s.status);
    // Pad based on visible length (status word), not ANSI-encoded length
    const statusPad = 20 - s.status.length + colored.length;
    console.log(
      padR(s.id, 16) +
      colored.padEnd(statusPad) +
      padR(s.backend, 14) +
      padR(s.mode, 14) +
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
    console.error("usage: orka logs <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  // Try live tmux capture first
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

  const status = await $`git -C ${session.workingDir} status`.text();
  console.log(status);

  const diff = await $`git -C ${session.workingDir} diff`.text();
  if (diff) {
    console.log(diff);
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

  const task = getTask(session.taskId);
  if (!task) {
    console.error(`task not found for session: ${session.id}`);
    process.exit(1);
  }

  const newSession = await spawnSession({
    prompt: task.prompt,
    projectPath: session.workingDir,
    backend: session.backend,
    mode: session.mode,
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

  // Delete log files
  for (const s of sessions) {
    if (s.logFile && existsSync(s.logFile)) {
      unlinkSync(s.logFile);
    }
  }

  deleteSessions(sessions.map((s) => s.id));
  console.log(`pruned ${sessions.length} session(s)`);
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

function padR(s: string, n: number): string {
  return s.padEnd(n);
}
