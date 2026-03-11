#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BackendKind, SessionMode, OrkaService } from "@orka/core";
import { ensureKeyPair, loadKeyPair, loadPublicKey } from "@orka/core";
import { startRelay } from "@orka/relay";
import {
  createLocalClient,
  createRemoteClient,
  startServer,
  tmuxAttach,
  getConfig,
  getOrkaHome,
  initTracing,
  shutdownTracing,
  withSpan,
  resolveProject,
  projectNameForPath,
  addProject,
  removeProject,
  listProjects,
} from "@orka/daemon";

// Initialize OpenTelemetry tracing
initTracing();

// Check for --remote and --token flags before command
const remoteIdx = process.argv.indexOf("--remote");
let remoteUrl = remoteIdx !== -1 ? process.argv[remoteIdx + 1] : process.env.ORKA_REMOTE;
if (remoteIdx !== -1) {
  process.argv.splice(remoteIdx, 2);
}
const tokenIdx = process.argv.indexOf("--token");
let remoteToken = tokenIdx !== -1 ? process.argv[tokenIdx + 1] : process.env.ORKA_TOKEN;
if (tokenIdx !== -1) {
  process.argv.splice(tokenIdx, 2);
}
// Auto-load API key: ORKA_API_KEY > ~/.orka/relay-key > --token/ORKA_TOKEN
if (!remoteToken) {
  remoteToken = process.env.ORKA_API_KEY ?? undefined;
  if (!remoteToken) {
    const savedKeyFile = join(getOrkaHome(), "relay-key");
    if (existsSync(savedKeyFile)) {
      remoteToken = readFileSync(savedKeyFile, "utf-8").trim() || undefined;
    }
  }
}
if (remoteUrl && remoteToken) {
  const sep = remoteUrl.includes("?") ? "&" : "?";
  remoteUrl = `${remoteUrl}${sep}token=${encodeURIComponent(remoteToken)}`;
}

// E2E encryption for remote connections
const encryptIdx = process.argv.indexOf("--encrypt");
const useEncrypt = encryptIdx !== -1 || !!process.env.ORKA_ENCRYPT;
if (encryptIdx !== -1) {
  process.argv.splice(encryptIdx, 1);
}

// Server public key for E2E (can be set via env or fetched from /health)
const serverPubKeyIdx = process.argv.indexOf("--server-key");
let serverPublicKey = serverPubKeyIdx !== -1 ? process.argv[serverPubKeyIdx + 1] : process.env.ORKA_SERVER_KEY;
if (serverPubKeyIdx !== -1) {
  process.argv.splice(serverPubKeyIdx, 2);
}

let svc: OrkaService;
if (remoteUrl) {
  if (useEncrypt) {
    const orkaHome = getOrkaHome();
    const keyPair = ensureKeyPair(orkaHome, "client");

    // If server key not provided, try loading from saved keys
    if (!serverPublicKey) {
      serverPublicKey = loadPublicKey(orkaHome, "server") ?? undefined;
    }
    if (!serverPublicKey) {
      console.error("error: E2E encryption requires server public key (--server-key or ORKA_SERVER_KEY)");
      console.error("  get it from: curl <daemon-url>/health | jq -r .publicKey");
      console.error("  or save it:  orka keygen save-server <pubkey>");
      process.exit(1);
    }
    svc = createRemoteClient({ url: remoteUrl, keyPair, serverPublicKey });
  } else {
    svc = createRemoteClient(remoteUrl);
  }
} else {
  svc = createLocalClient();
}

const command = process.argv[2];

// Auto-reap dead sessions on every CLI invocation (skip for wait — it reaps in its own loop)
if (command !== "wait") {
  await svc.reap();
}

const commands: Record<string, () => Promise<void>> = {
  spawn: cmdSpawn, ps: cmdPs, attach: cmdAttach, logs: cmdLogs,
  stop: cmdStop, diff: cmdDiff, retry: cmdRetry, show: cmdShow,
  workdir: cmdWorkdir, wait: cmdWait, result: cmdResult, send: cmdSend,
  keep: cmdKeep, unkeep: cmdUnkeep, merge: cmdMerge, project: cmdProject,
  prune: cmdPrune, serve: cmdServe, relay: cmdRelay, keygen: cmdKeygen,
};

const handler = command ? commands[command] : undefined;
if (handler) {
  await withSpan(`orka.cli.${command}`, { "orka.command": command }, handler);
} else {
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
  console.log("  serve   Start daemon WS server");
  console.log("  relay   Start relay WS router / manage relay account");
  console.log("  keygen  Manage E2E encryption keys");
  console.log("");
  console.log("ps options:");
  console.log("  --status       Filter by status (e.g. running, completed, failed, cancelled)");
  console.log("  --backend      Filter by backend (e.g. claude-code, codex, aider, shell)");
  console.log("  --project      Filter by project (name or full path)");
  console.log("  --tag          Filter by tag");
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
  console.log("  --backend, -b   Agent backend: claude-code|codex|shell (default: claude-code)");
  console.log("  --prompt        Prompt/task for the agent (or use positional args or pipe stdin)");
  console.log("  --prompt-file   Read prompt from file");
  console.log("  --mode, -m      Session mode: interactive|background (default: interactive)");
  console.log("  --model         Model for claude-code backend (e.g. sonnet, opus, haiku)");
  console.log("  --branch        Git branch (creates worktree if specified)");
  console.log("  --title         Session title");
  console.log("  --auto-merge    Auto-merge worktree on successful completion");
  console.log("  --tag           Add tag(s) to session (repeatable: --tag foo --tag bar)");
  console.log("");
  console.log("serve options:");
  console.log("  --port          Port to listen on (default: 7394)");
  console.log("  --host          Hostname to bind (default: 127.0.0.1)");
  console.log("  --relay         Connect to relay (e.g. ws://relay:7390)");
  console.log("  --node-id       Node ID for relay registration");
  console.log("  --encrypt       Enable E2E encryption (generates node keypair)");
  console.log("");
  console.log("relay options:");
  console.log("  (no subcommand) Start relay server");
  console.log("  signup          Sign up for a relay account");
  console.log("  keys            Manage API keys (list, create, revoke)");
  console.log("  account         Show account info");
  console.log("  usage           Show usage statistics");
  console.log("  --port          Port to listen on (default: 7390)");
  console.log("");
  console.log("global options:");
  console.log("  --remote <url>  Connect to remote daemon (e.g. ws://host:7394)");
  console.log("  --token <tok>   Auth token for relay/daemon connection");
  console.log("  --encrypt       Enable E2E encryption for remote connections");
  console.log("  --server-key    Server public key for E2E (or ORKA_SERVER_KEY)");
  console.log("  ORKA_REMOTE     Env var alternative to --remote");
  console.log("  ORKA_TOKEN      Env var alternative to --token");
  console.log("  ORKA_API_KEY    API key for relay (auto-loaded from ~/.orka/relay-key)");
  console.log("  ORKA_RELAY_URL  Relay HTTP URL for signup/keys/account/usage commands");
  console.log("  ORKA_ENCRYPT    Env var alternative to --encrypt");
  console.log("  ORKA_SERVER_KEY Env var alternative to --server-key");
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
      "reasoning-effort": { type: "string" },
      "auto-merge": { type: "boolean", default: false },
      tag: { type: "string", multiple: true },
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
    session = await svc.spawn({
      prompt,
      title: args.values.title,
      projectPath: resolveProject(args.values.project!),
      backend: args.values.backend as BackendKind,
      mode: args.values.mode as SessionMode,
      model: args.values.model || cfg.model || undefined,
      reasoningEffort: args.values["reasoning-effort"] as any || undefined,
      branch: args.values.branch,
      autoMerge: args.values["auto-merge"] || false,
      tags: args.values.tag as string[] | undefined,
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
  if (args.values.tag && (args.values.tag as string[]).length > 0) {
    console.log(`  tags:     ${(args.values.tag as string[]).join(", ")}`);
  }

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
      tag: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: false,
  });

  let sessions = await svc.listSessions({
    status: args.values.status as any,
    tag: args.values.tag,
  });
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
    const task = await svc.getTask(s.taskId);
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
      const result = await svc.getResult(s.id);
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

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (!(await svc.isAlive(session.id))) {
    console.error(`tmux session not running: ${session.tmuxSessionName}`);
    process.exit(1);
  }

  if (remoteUrl) {
    // Remote mode — can't attach directly, print SSH command
    console.log(`session ${session.id} is running remotely`);
    console.log("");
    console.log("to attach via SSH:");
    console.log(`  ssh <host> -t tmux attach -t ${session.tmuxSessionName}`);
    console.log("");
    console.log("or use 'orka logs -f' to stream output remotely:");
    console.log(`  orka --remote ${remoteUrl} logs -f ${session.id}`);
    return;
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

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (!follow) {
    try {
      const output = await svc.captureOutput(session.id);
      console.log(output);
      return;
    } catch {
      console.error("no logs available (session ended, no log file found)");
      process.exit(1);
    }
  }

  // --follow mode
  if (await svc.isAlive(session.id)) {
    let offset = 0;
    while (true) {
      try {
        const output = await svc.captureOutput(session.id);
        if (output.length > offset) {
          process.stdout.write(output.slice(offset));
          offset = output.length;
        }
      } catch { break; }
      if (!(await svc.isAlive(session.id))) break;
      await Bun.sleep(500);
    }
    return;
  }

  // tmux dead — stream log file with tail -f (local-only, will be WS streaming in remote mode)
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

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (session.status !== "running" && session.status !== "preparing") {
    console.error(`session ${session.id} is already ${session.status}`);
    process.exit(1);
  }

  await svc.stop(session.id);
  console.log(`stopped session ${session.id}`);
}

async function cmdDiff(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka diff <session-id>");
    process.exit(1);
  }

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  try {
    const { status, diff } = await svc.getDiff(session.id);
    console.log(status);
    if (diff) {
      console.log("");
      console.log(diff);
    }
  } catch (e: any) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

async function cmdRetry(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka retry <session-id>");
    process.exit(1);
  }

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  if (session.status === "running") {
    console.error(`session ${session.id} is still running — stop it first`);
    process.exit(1);
  }

  const task = await svc.getTask(session.taskId);
  if (!task) {
    console.error(`task not found for session: ${session.id}`);
    process.exit(1);
  }

  const oldTags = await svc.getTags(session.id);
  const newSession = await svc.spawn({
    prompt: task.prompt,
    title: task.title,
    projectPath: session.projectPath || session.workingDir,
    backend: session.backend,
    mode: session.mode,
    model: task.model || undefined,
    tags: oldTags.length > 0 ? oldTags : undefined,
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

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  const task = await svc.getTask(session.taskId);

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

  const tags = await svc.getTags(session.id);
  if (tags.length > 0) console.log(`  tags:      ${tags.join(", ")}`);

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

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  console.log(session.workingDir);
}

async function cmdWait(): Promise<void> {
  const rawArgs = process.argv.slice(3);
  const allFlag = rawArgs.includes("--all");
  const projectIdx = rawArgs.indexOf("--project");
  const projectFilter = projectIdx !== -1 ? rawArgs[projectIdx + 1] : undefined;
  const ids = rawArgs.filter((a, i) => a !== "--all" && a !== "--project" && (projectIdx === -1 || i !== projectIdx + 1));

  if (ids.length === 0 && !allFlag) {
    console.error("usage: orka wait <session-id...> | --all [--project <name>]");
    process.exit(1);
  }

  const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
  let targets: string[];

  if (allFlag) {
    let running = (await svc.listSessions()).filter((s) => !terminalStatuses.has(s.status));
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
    targets = [];
    for (const id of ids) {
      const s = await findSession(id);
      if (!s) {
        console.error(`session not found: ${id}`);
        process.exit(1);
      }
      targets.push(s.id);
    }
  }

  console.log(`waiting for ${targets.length} session(s)...`);
  const pending = new Set(targets);
  let anyFailed = false;

  while (pending.size > 0) {
    await svc.reap();
    for (const id of [...pending]) {
      const s = await svc.getSession(id);
      if (!s || terminalStatuses.has(s.status)) {
        pending.delete(id);
        const status = s?.status ?? "unknown";
        const task = s ? await svc.getTask(s.taskId) : null;
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

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  try {
    await svc.sendInput(session.id, text);
    console.log(`sent to ${session.id}`);
  } catch (e: any) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

async function cmdKeep(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka keep <session-id>");
    process.exit(1);
  }

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  await svc.setKept(session.id, true);
  console.log(`session ${session.id} marked as kept (worktree protected from cleanup)`);
}

async function cmdUnkeep(): Promise<void> {
  const sessionId = process.argv[3];
  if (!sessionId) {
    console.error("usage: orka unkeep <session-id>");
    process.exit(1);
  }

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  await svc.setKept(session.id, false);
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

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  const result = await svc.getResult(session.id);
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

  const task = await svc.getTask(session.taskId);
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

  const session = await findSession(sessionId);
  if (!session) {
    console.error(`session not found: ${sessionId}`);
    process.exit(1);
  }

  try {
    const { branch, commits, cleaned } = await svc.merge(session.id, args.values.cleanup !== false);
    console.log(`merged ${commits} commit(s) from ${branch}`);
    if (cleaned) {
      console.log(`cleaned up worktree and branch ${branch}`);
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
  const projectPath = args.values.project ? resolveProject(args.values.project) : undefined;

  const { pruned, orphansCleaned } = await svc.pruneSessions({ maxAgeMs, projectPath });

  if (pruned === 0) {
    console.log("nothing to prune");
  } else {
    console.log(`pruned ${pruned} session(s)`);
  }
  if (orphansCleaned > 0) {
    console.log(`cleaned ${orphansCleaned} orphaned worktree(s)`);
  }
}

async function cmdServe(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      port: { type: "string", default: "7394" },
      host: { type: "string", default: "127.0.0.1" },
      relay: { type: "string" },
      "node-id": { type: "string" },
      "relay-token": { type: "string" },
    },
    allowPositionals: false,
  });

  const port = parseInt(args.values.port!, 10);
  const hostname = args.values.host!;
  const localSvc = createLocalClient();
  // useEncrypt is set by global --encrypt flag parsing
  const server = await startServer(localSvc, {
    port,
    hostname,
    relayUrl: args.values.relay,
    nodeId: args.values["node-id"],
    relayToken: args.values["relay-token"] ?? process.env.ORKA_TOKEN,
    encrypt: useEncrypt,
  });
  console.log(`orka daemon listening on ws://${hostname}:${server.port}`);
  if (args.values.relay) {
    console.log(`  relay: ${args.values.relay}`);
  }

  // Keep running until killed
  await new Promise(() => {});
}

async function cmdRelay(): Promise<void> {
  const sub = process.argv[3];

  // Relay subcommands that call the relay HTTP API
  if (sub === "signup") return cmdRelaySignup();
  if (sub === "keys") return cmdRelayKeys();
  if (sub === "account") return cmdRelayAccount();
  if (sub === "usage") return cmdRelayUsage();

  // Default: start relay server
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      port: { type: "string", default: "7390" },
      token: { type: "string" },
    },
    allowPositionals: false,
  });

  const port = parseInt(args.values.port!, 10);
  const token = args.values.token ?? process.env.ORKA_TOKEN;
  const handle = startRelay({ port, token });
  console.log(`orka relay listening on ws://0.0.0.0:${handle.server.port}`);
  console.log("  nodes register at:  /register?node=<id>");
  console.log("  clients connect at: /ws");

  // Graceful shutdown on SIGTERM/SIGINT
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\nreceived ${signal}, starting graceful shutdown...`);
      await handle.shutdown();
      process.exit(0);
    });
  }

  // Keep running until killed
  await new Promise(() => {});
}

// --- Relay API helpers ---

function getRelayHttpUrl(): string {
  // Use --remote / ORKA_REMOTE, converting ws:// to http://
  let base = remoteUrl ?? process.env.ORKA_RELAY_URL;
  if (!base) {
    console.error("error: relay URL required (use --remote <url> or ORKA_RELAY_URL)");
    process.exit(1);
  }
  // Strip ?token= query params for HTTP API calls (we use Authorization header)
  base = base.split("?")[0];
  return base.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
}

function getApiKey(): string | null {
  // 1. ORKA_API_KEY env var
  if (process.env.ORKA_API_KEY) return process.env.ORKA_API_KEY;
  // 2. Saved key file
  const keyFile = join(getOrkaHome(), "relay-key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf-8").trim();
  // 3. Legacy token
  return remoteToken ?? null;
}

function saveApiKey(key: string): void {
  const keyFile = join(getOrkaHome(), "relay-key");
  mkdirSync(getOrkaHome(), { recursive: true });
  writeFileSync(keyFile, key + "\n", { mode: 0o600 });
}

async function relayFetch(path: string, opts?: { method?: string; body?: any; auth?: boolean }): Promise<any> {
  const base = getRelayHttpUrl();
  const url = `${base}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (opts?.auth !== false) {
    const key = getApiKey();
    if (key) headers["authorization"] = `Bearer ${key}`;
  }

  const fetchOpts: RequestInit = { method: opts?.method ?? "GET", headers };
  if (opts?.body) fetchOpts.body = JSON.stringify(opts.body);

  const resp = await fetch(url, fetchOpts);
  const data = await resp.json() as any;

  if (!resp.ok) {
    const msg = data?.error?.message ?? data?.error ?? `HTTP ${resp.status}`;
    console.error(`error: ${msg}`);
    process.exit(1);
  }

  return data;
}

async function cmdRelaySignup(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(4),
    options: {
      email: { type: "string" },
      name: { type: "string" },
    },
    allowPositionals: false,
  });

  if (!args.values.email || !args.values.name) {
    console.error("usage: orka relay signup --email <email> --name <name>");
    process.exit(1);
  }

  const data = await relayFetch("/v1/signup", {
    method: "POST",
    body: { email: args.values.email, name: args.values.name },
    auth: false,
  });

  // Auto-save the API key
  saveApiKey(data.apiKey);

  console.log("signup successful!");
  console.log(`  account: ${data.accountId}`);
  console.log(`  api key: ${data.apiKey}`);
  console.log("");
  console.log(`key saved to ${join(getOrkaHome(), "relay-key")}`);
  console.log("it will be used automatically for future relay commands");
}

async function cmdRelayKeys(): Promise<void> {
  const sub = process.argv[4];

  if (sub === "create") {
    const args = parseArgs({
      args: process.argv.slice(5),
      options: {
        label: { type: "string" },
        permissions: { type: "string" },
      },
      allowPositionals: false,
    });

    const body: any = {};
    if (args.values.label) body.label = args.values.label;
    if (args.values.permissions) body.permissions = args.values.permissions;

    const data = await relayFetch("/v1/keys", { method: "POST", body });
    console.log("key created:");
    console.log(`  id:     ${data.keyId}`);
    console.log(`  key:    ${data.apiKey}`);
    console.log(`  prefix: ${data.prefix}`);
    return;
  }

  if (sub === "revoke") {
    const keyId = process.argv[5];
    if (!keyId) {
      console.error("usage: orka relay keys revoke <key-id>");
      process.exit(1);
    }
    await relayFetch(`/v1/keys/${keyId}`, { method: "DELETE" });
    console.log(`revoked key ${keyId}`);
    return;
  }

  if (sub === "list" || !sub) {
    const data = await relayFetch("/v1/keys");
    if (data.keys.length === 0) {
      console.log("no API keys");
      return;
    }
    console.log(padR("ID", 20) + padR("PREFIX", 20) + padR("PERMS", 10) + padR("STATUS", 10) + padR("LABEL", 20) + "LAST USED");
    for (const k of data.keys) {
      console.log(
        padR(k.id, 20) +
        padR(k.prefix, 20) +
        padR(k.permissions, 10) +
        padR(k.status, 10) +
        padR(k.label, 20) +
        (k.lastUsedAt ?? "never"),
      );
    }
    return;
  }

  console.error("usage: orka relay keys [list|create|revoke]");
  console.error("  list                          List API keys");
  console.error("  create [--label L] [--permissions client|node]  Create a key");
  console.error("  revoke <key-id>               Revoke a key");
  process.exit(1);
}

async function cmdRelayAccount(): Promise<void> {
  const data = await relayFetch("/v1/account");
  console.log(`account ${data.id}`);
  console.log(`  email:   ${data.email}`);
  console.log(`  name:    ${data.name}`);
  console.log(`  status:  ${data.status}`);
  console.log(`  tier:    ${data.tier}`);
  console.log(`  created: ${data.createdAt}`);
}

async function cmdRelayUsage(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(4),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      granularity: { type: "string", default: "hour" },
    },
    allowPositionals: false,
  });

  const params = new URLSearchParams();
  if (args.values.from) params.set("from", args.values.from);
  if (args.values.to) params.set("to", args.values.to);
  if (args.values.granularity) params.set("granularity", args.values.granularity);

  const qs = params.toString() ? `?${params.toString()}` : "";
  const data = await relayFetch(`/v1/usage${qs}`);

  if (data.buckets.length === 0) {
    console.log("no usage data for this period");
    return;
  }

  console.log(padR("PERIOD", 24) + padR("REQUESTS", 12) + padR("BYTES IN", 12) + "BYTES OUT");
  for (const b of data.buckets) {
    console.log(
      padR(b.period, 24) +
      padR(String(b.requests), 12) +
      padR(String(b.bytesIn), 12) +
      String(b.bytesOut),
    );
  }
}

async function cmdKeygen(): Promise<void> {
  const sub = process.argv[3];
  const orkaHome = getOrkaHome();

  if (sub === "client") {
    const kp = ensureKeyPair(orkaHome, "client");
    console.log("client keypair:");
    console.log(`  public:  ${kp.publicKey}`);
    console.log(`  stored:  ${orkaHome}/keys/client.pub, ${orkaHome}/keys/client.key`);
    return;
  }

  if (sub === "node") {
    const kp = ensureKeyPair(orkaHome, "node");
    console.log("node keypair:");
    console.log(`  public:  ${kp.publicKey}`);
    console.log(`  stored:  ${orkaHome}/keys/node.pub, ${orkaHome}/keys/node.key`);
    return;
  }

  if (sub === "save-server") {
    const pubkey = process.argv[4];
    if (!pubkey) {
      console.error("usage: orka keygen save-server <public-key>");
      console.error("  get it from: curl <daemon-url>/health | jq -r .publicKey");
      process.exit(1);
    }
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const keysDir = join(orkaHome, "keys");
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, "server.pub"), pubkey, { mode: 0o644 });
    console.log(`saved server public key to ${keysDir}/server.pub`);
    return;
  }

  if (sub === "show") {
    const clientKp = loadKeyPair(orkaHome, "client");
    const nodeKp = loadKeyPair(orkaHome, "node");
    const serverPub = loadPublicKey(orkaHome, "server");

    if (clientKp) {
      console.log(`client public key: ${clientKp.publicKey}`);
    } else {
      console.log("client keypair:    (not generated)");
    }
    if (nodeKp) {
      console.log(`node public key:   ${nodeKp.publicKey}`);
    } else {
      console.log("node keypair:      (not generated)");
    }
    if (serverPub) {
      console.log(`server public key: ${serverPub}`);
    } else {
      console.log("server public key: (not saved)");
    }
    return;
  }

  console.log("orka keygen — manage E2E encryption keys");
  console.log("");
  console.log("subcommands:");
  console.log("  client         Generate/show client keypair (for CLI → daemon encryption)");
  console.log("  node           Generate/show node keypair (for daemon server)");
  console.log("  save-server    Save a remote server's public key");
  console.log("  show           Show all stored keys");
  console.log("");
  console.log("usage:");
  console.log("  orka keygen client                  # generate client keys");
  console.log("  orka keygen save-server <pubkey>     # save server's public key");
  console.log("  orka --remote ws://host:7394 --encrypt spawn ...  # use encryption");
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

async function findSession(query: string) {
  const exact = await svc.getSession(query);
  if (exact) return exact;

  const all = await svc.listSessions();
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
