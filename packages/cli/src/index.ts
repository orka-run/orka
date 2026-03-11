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
  worktreeMerge,
  worktreeRemove,
  worktreeBranch,
  worktreeHasCommitsAhead,
  worktreeHasChanges,
  deleteBranch,
  getWorktreeDir,
  parseSessionResult,
  setSessionKept,
  tmuxSendText,
  initTracing,
  shutdownTracing,
  addProject,
  removeProject,
  listProjects,
  resolveProject,
  projectNameForPath,
} from "@orka/daemon";

// Initialize OpenTelemetry tracing
initTracing();

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
  case "result":
    await cmdResult();
    break;
  case "send":
    await cmdSend();
    break;
  case "keep":
    await cmdKeep();
    break;
  case "unkeep":
    await cmdUnkeep();
    break;
  case "merge":
    await cmdMerge();
    break;
  case "project":
    await cmdProject();
    break;
  case "prune":
    await cmdPrune();
    break;
  default:
    printUsage();
}

// Flush pending spans before exit
await shutdownTracing();

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
  console.log("  result  Show final result from a background session");
  console.log("  send    Send text input to a running session");
  console.log("  keep    Protect a session's worktree from auto-cleanup");
  console.log("  unkeep  Remove worktree protection");
  console.log("  merge   Merge session worktree branch into current branch");
  console.log("  project Register/list/remove project aliases");
  console.log("  retry   Re-run a session with the same prompt");
  console.log("  prune   Remove old completed/cancelled/failed sessions");
  console.log("");
  console.log("ps options:");
  console.log("  --status       Filter by status (e.g. running, completed, failed, cancelled)");
  console.log("  --backend      Filter by backend (e.g. claude-code, codex, aider, shell)");
  console.log("  --project      Filter by project (name or full path)");
  console.log("  --verbose, -v  Show cost, duration, tokens, and project column");
  console.log("");
  console.log("logs options:");
  console.log("  --follow, -f  Stream live output (polls tmux or tail -f log)");
  console.log("");
  console.log("prune options:");
  console.log("  --age       Max age to keep (default: 24h)");
  console.log("  --project   Only prune sessions for this project");
  console.log("");
  console.log("spawn options:");
  console.log("  --project, -p   Project directory (default: .)");
  console.log("  --backend, -b   Agent backend: claude-code|codex|aider|shell (default: claude-code)");
  console.log("  --prompt        Prompt/task for the agent (or use positional args or pipe stdin)");
  console.log("  --prompt-file   Read prompt from file");
  console.log("  --mode, -m      Session mode: interactive|background (default: interactive)");
  console.log("  --model         Model for claude-code backend (e.g. sonnet, opus, haiku)");
  console.log("  --branch        Git branch (creates worktree if specified)");
  console.log("  --title         Session title");
  console.log("  --auto-merge    Auto-merge worktree on successful completion");
}

async function cmdSpawn(): Promise<void> {
  const cfg = getConfig().defaults;
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      project: { type: "string", short: "p", default: cfg.project },
      backend: { type: "string", short: "b", default: cfg.backend },
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      mode: { type: "string", short: "m", default: cfg.mode },
      model: { type: "string" },
      branch: { type: "string" },
      title: { type: "string" },
      "auto-merge": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (args.values.prompt && args.values["prompt-file"]) {
    console.error("error: cannot use both --prompt and --prompt-file");
    process.exit(1);
  }

  let prompt: string;
  if (args.values["prompt-file"]) {
    const filePath = args.values["prompt-file"];
    if (!existsSync(filePath)) {
      console.error(`error: prompt file not found: ${filePath}`);
      process.exit(1);
    }
    prompt = readFileSync(filePath, "utf-8").trim();
  } else if (args.values.prompt) {
    prompt = args.values.prompt;
  } else if (args.positionals.length > 0) {
    prompt = args.positionals.join(" ");
  } else if (!process.stdin.isTTY) {
    // Read from piped stdin
    prompt = await new Promise<string>((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data.trim()));
    });
  } else {
    prompt = "";
  }

  if (!prompt) {
    console.error("error: prompt is required (use --prompt, --prompt-file, positional args, or pipe stdin)");
    process.exit(1);
  }

  let session;
  try {
    session = await spawnSession({
      prompt,
      title: args.values.title,
      projectPath: resolveProject(args.values.project!),
      backend: args.values.backend as BackendKind,
      mode: args.values.mode as SessionMode,
      model: args.values.model || cfg.model || undefined,
      branch: args.values.branch,
      autoMerge: args.values["auto-merge"] || false,
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
      project: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
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
  if (args.values.project) {
    const proj = args.values.project;
    const resolved = resolveProject(proj);
    sessions = sessions.filter((s) =>
      s.projectPath === resolved || s.projectPath === proj || projectName(s.projectPath) === proj,
    );
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

  const verbose = args.values.verbose ?? false;
  const uniqueProjects = new Set(sessions.map((s) => s.projectPath));
  const multiProject = uniqueProjects.size > 1;
  const showProject = multiProject || verbose;

  const running = sessions.filter((s) => s.status === "running").length;
  console.log(c("1", `${running} running / ${sessions.length} total`));
  console.log("");

  let header =
    padR("ID", 16) +
    padR("STATUS", 20) +
    padR("AGE", 10);
  if (showProject) header += padR("PROJECT", 36);
  header += padR("BACKEND", 14);
  if (verbose) {
    header += padR("COST", 10) + padR("DURATION", 10) + padR("TOKENS", 14);
  }
  header += "TITLE";
  const lineWidth = 76 + (showProject ? 36 : 0) + (verbose ? 34 : 0);
  console.log(header);
  console.log("-".repeat(lineWidth));

  for (const s of sessions) {
    const task = getTask(s.taskId);
    const statusText = s.kept ? `${s.status} [kept]` : s.status;
    const colored = s.kept ? statusColor(s.status) + " " + c("36", "[kept]") : statusColor(s.status);
    const statusPad = 20 - statusText.length + colored.length;

    let line =
      padR(s.id, 16) +
      colored.padEnd(statusPad) +
      padR(formatAge(s.createdAt), 10);

    if (showProject) {
      const alias = projectNameForPath(s.projectPath);
      const label = alias ? `${s.projectPath} (${alias})` : s.projectPath || "-";
      line += padR(label, 36);
    }
    line += padR(s.backend, 14);

    if (verbose) {
      const result = s.logFile ? parseSessionResult(s.logFile) : null;
      const cost = result?.costUsd != null ? `$${result.costUsd.toFixed(2)}` : "-";
      const duration = result ? formatDuration(result.durationMs) : "-";
      const tokens = result ? `${shortNum(result.outputTokens)} out` : "-";
      line += padR(cost, 10) + padR(duration, 10) + padR(tokens, 14);
    }

    line += (task?.title ?? "").slice(0, verbose ? 40 : 50);
    console.log(line);
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
  if (session.kept) console.log(`  kept:      yes (worktree protected)`);
  if (session.autoMerge) console.log(`  auto-merge: yes`);

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
  const rawArgs = process.argv.slice(3);
  const allFlag = rawArgs.includes("--all");
  const projectIdx = rawArgs.indexOf("--project");
  const projectFilter = projectIdx !== -1 ? rawArgs[projectIdx + 1] : undefined;
  const ids = rawArgs.filter((a, i) => a !== "--all" && a !== "--project" && i !== projectIdx + 1);

  if (ids.length === 0 && !allFlag) {
    console.error("usage: orka wait <session-id...> | --all [--project <name>]");
    process.exit(1);
  }

  const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
  let targets: string[];

  if (allFlag) {
    let running = listSessions().filter((s) => !terminalStatuses.has(s.status));
    if (projectFilter) {
      const resolved = resolveProject(projectFilter);
      running = running.filter((s) =>
        s.projectPath === resolved || s.projectPath === projectFilter || projectName(s.projectPath) === projectFilter,
      );
    }
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

async function cmdSend(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka send <session-id> <text...>");
    process.exit(1);
  }

  const text = process.argv.slice(4).join(" ");
  if (!text) {
    console.error("usage: orka send <session-id> <text...>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (!(await tmuxHas(session.tmuxSessionName))) {
    console.error(`session ${session.id} is not running`);
    process.exit(1);
  }

  await tmuxSendText(session.tmuxSessionName, text);
  console.log(`sent to ${session.id}`);
}

async function cmdKeep(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka keep <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  setSessionKept(session.id, true);
  console.log(`session ${session.id} marked as kept (worktree protected from cleanup)`);
}

async function cmdUnkeep(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka unkeep <session-id>");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  setSessionKept(session.id, false);
  console.log(`session ${session.id} unprotected (worktree may be cleaned up)`);
}

async function cmdResult(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const sessionId = args.positionals[0];
  if (!sessionId) {
    console.error("usage: orka result <session-id> [--json]");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (!session.logFile) {
    console.error("no log file for this session");
    process.exit(1);
  }

  const result = parseSessionResult(session.logFile);
  if (!result) {
    console.error("no result found in session log (session may not be a background claude-code session)");
    process.exit(1);
  }

  if (args.values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const noColor = !!process.env["NO_COLOR"];
  const c = (code: string, text: string): string =>
    noColor ? text : `\x1b[${code}m${text}\x1b[0m`;

  const task = getTask(session.taskId);
  console.log(c("1", `session ${session.id}`));
  if (task) console.log(`  title: ${task.title.slice(0, 80)}`);

  console.log("");
  if (result.isError) {
    console.log(c("31", "STATUS: ERROR"));
  } else {
    console.log(c("32", "STATUS: SUCCESS"));
  }

  if (result.model) console.log(`  model:    ${result.model}`);
  console.log(`  turns:    ${result.numTurns}`);
  console.log(`  duration: ${formatDuration(result.durationMs)}`);
  if (result.costUsd !== null) console.log(`  cost:     $${result.costUsd.toFixed(4)}`);
  console.log(`  tokens:   ${result.inputTokens.toLocaleString()} in / ${result.outputTokens.toLocaleString()} out`);
  if (result.cacheReadTokens > 0) {
    console.log(`  cache:    ${result.cacheReadTokens.toLocaleString()} read / ${result.cacheCreateTokens.toLocaleString()} created`);
  }

  console.log("");
  console.log(c("1", "Result:"));
  console.log(result.result);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

async function cmdMerge(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      cleanup: { type: "boolean", default: true },
    },
    allowPositionals: true,
  });

  const sessionId = args.positionals[0];
  if (!sessionId) {
    console.error("usage: orka merge <session-id> [--no-cleanup]");
    process.exit(1);
  }

  const session = findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  const wtDir = getWorktreeDir();
  if (!session.workingDir.startsWith(wtDir)) {
    console.error(`session ${session.id} is not using a worktree`);
    process.exit(1);
  }

  try {
    const { branch, commits } = await worktreeMerge(session.projectPath, session.workingDir);
    console.log(`merged ${commits} commit(s) from ${branch}`);

    if (args.values.cleanup !== false) {
      try {
        await worktreeRemove(session.projectPath, session.workingDir);
        await deleteBranch(session.projectPath, branch);
        console.log(`cleaned up worktree and branch ${branch}`);
      } catch {
        console.log(`note: could not clean up worktree/branch (manual cleanup may be needed)`);
      }
    }
  } catch (e: any) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

async function cmdProject(): Promise<void> {
  const sub = process.argv[3];

  if (sub === "add") {
    const name = process.argv[4];
    const path = process.argv[5] || ".";
    if (!name) {
      console.error("usage: orka project add <name> [path]");
      process.exit(1);
    }
    const entry = addProject(name, path);
    console.log(`registered project ${entry.name} → ${entry.path}`);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const name = process.argv[4];
    if (!name) {
      console.error("usage: orka project remove <name>");
      process.exit(1);
    }
    if (removeProject(name)) {
      console.log(`removed project ${name}`);
    } else {
      console.error(`project not found: ${name}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "list" || sub === "ls" || !sub) {
    const projects = listProjects();
    if (projects.length === 0) {
      console.log("no registered projects");
      console.log("");
      console.log("register with: orka project add <name> [path]");
      return;
    }
    for (const p of projects) {
      console.log(`${p.name.padEnd(20)} ${p.path}`);
    }
    return;
  }

  console.error("usage: orka project <add|remove|list>");
  console.error("  add <name> [path]  — register project (default path: .)");
  console.error("  remove <name>      — unregister project");
  console.error("  list               — show registered projects");
  process.exit(1);
}

async function cmdPrune(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      age: { type: "string", default: "24h" },
      project: { type: "string" },
    },
    allowPositionals: false,
  });

  const maxAgeMs = parseAge(args.values.age!);
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const pruneStatuses = new Set(["completed", "cancelled", "failed"]);

  let sessions = listSessions().filter(
    (s) => pruneStatuses.has(s.status) && s.createdAt < cutoff,
  );

  if (args.values.project) {
    const resolved = resolveProject(args.values.project);
    sessions = sessions.filter((s) =>
      s.projectPath === resolved || s.projectPath === args.values.project || projectName(s.projectPath) === args.values.project,
    );
  }

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

function shortNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function projectName(path: string): string {
  if (!path) return "-";
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function padR(s: string, n: number): string {
  return s.padEnd(n);
}
