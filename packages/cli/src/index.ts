#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BackendKind, SessionMode, OrkaService } from "@orka/core";
import { ensureKeyPair, loadKeyPair, loadPublicKey } from "@orka/core";
import { startRelay } from "@orka/relay";
import {
  createLocalClient,
  createRemoteClient,
  startServer,
  defaultRunner,
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
import {
  command,
  subcommands,
  run,
  string as str,
  boolean as bool,
  flag,
  option,
  positional,
  optional,
  restPositionals,
  multioption,
} from "cmd-ts";

void bool;

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

const TOP_LEVEL_COMMANDS = new Set([
  "spawn",
  "ps",
  "attach",
  "logs",
  "stop",
  "diff",
  "retry",
  "show",
  "workdir",
  "wait",
  "result",
  "send",
  "keep",
  "unkeep",
  "merge",
  "project",
  "prune",
  "serve",
  "relay",
  "keygen",
]);

const PROJECT_SUBCOMMANDS = new Set(["add", "remove", "rm", "list", "ls"]);
const RELAY_SUBCOMMANDS = new Set(["serve", "signup", "keys", "account", "usage"]);
const RELAY_KEYS_SUBCOMMANDS = new Set(["create", "revoke", "list"]);
const KEYGEN_SUBCOMMANDS = new Set(["client", "node", "save-server", "show", "help"]);

async function runCliCommand(name: string, fn: () => Promise<void>): Promise<void> {
  await withSpan(`orka.cli.${name}`, { "orka.command": name }, async () => {
    if (name !== "wait") {
      await svc.reap();
    }
    await fn();
  });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readPromptFromStdin(): Promise<string> {
  return await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

const spawnCmd = command({
  name: "spawn",
  description: "Spawn an agent session",
  args: {
    project: option({ type: optional(str), long: "project", short: "p" }),
    backend: option({ type: optional(str), long: "backend", short: "b" }),
    prompt: option({ type: optional(str), long: "prompt" }),
    promptFile: option({ type: optional(str), long: "prompt-file" }),
    mode: option({ type: optional(str), long: "mode", short: "m" }),
    model: option({ type: optional(str), long: "model" }),
    branch: option({ type: optional(str), long: "branch" }),
    title: option({ type: optional(str), long: "title" }),
    reasoningEffort: option({ type: optional(str), long: "reasoning-effort" }),
    autoMerge: flag({ long: "auto-merge" }),
    tag: multioption({ type: str, long: "tag" }),
    words: restPositionals({ type: str, displayName: "prompt" }),
  },
  handler: async (args) => runCliCommand("spawn", async () => {
    const cfg = getConfig().defaults;

    if (args.prompt && args.promptFile) {
      fail("error: cannot use both --prompt and --prompt-file");
    }

    let prompt: string;
    if (args.promptFile) {
      if (!existsSync(args.promptFile)) {
        fail(`error: prompt file not found: ${args.promptFile}`);
      }
      prompt = readFileSync(args.promptFile, "utf-8").trim();
    } else if (args.prompt) {
      prompt = args.prompt;
    } else if (args.words.length > 0) {
      prompt = args.words.join(" ");
    } else if (!process.stdin.isTTY) {
      prompt = await readPromptFromStdin();
    } else {
      prompt = "";
    }

    if (!prompt) {
      fail("error: prompt is required (use --prompt, --prompt-file, positional args, or pipe stdin)");
    }

    let session;
    try {
      session = await svc.spawn({
        prompt,
        title: args.title,
        projectPath: resolveProject(args.project ?? cfg.project),
        backend: (args.backend ?? cfg.backend) as BackendKind,
        mode: (args.mode ?? cfg.mode) as SessionMode,
        model: args.model || cfg.model || undefined,
        reasoningEffort: args.reasoningEffort as any || undefined,
        branch: args.branch,
        autoMerge: args.autoMerge || false,
        tags: args.tag.length > 0 ? args.tag : undefined,
      });
    } catch (e: any) {
      fail(`error: ${e.message}`);
    }

    console.log(`spawned session ${session.id}`);
    console.log(`  backend:  ${session.backend}`);
    console.log(`  mode:     ${session.mode}`);
    console.log(`  workdir:  ${session.workingDir}`);
    console.log(`  tmux:     ${session.tmuxSessionName}`);
    console.log(`  log:      ${session.logFile}`);
    if (args.tag.length > 0) {
      console.log(`  tags:     ${args.tag.join(", ")}`);
    }

    if (session.mode === "interactive") {
      console.log("");
      console.log("attaching... (detach: Ctrl-b d)");
      await defaultRunner.attach(session.tmuxSessionName);
    }
  }),
});

const psCmd = command({
  name: "ps",
  description: "List active sessions",
  args: {
    status: option({ type: optional(str), long: "status" }),
    backend: option({ type: optional(str), long: "backend" }),
    project: option({ type: optional(str), long: "project" }),
    tag: option({ type: optional(str), long: "tag" }),
    verbose: flag({ long: "verbose", short: "v" }),
  },
  handler: async (args) => runCliCommand("ps", async () => {
    let sessions = await svc.listSessions({
      status: args.status as any,
      tag: args.tag,
    });
    if (args.backend) {
      sessions = sessions.filter((s) => s.backend === args.backend);
    }
    if (args.project) {
      const proj = args.project;
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
        case "running": return c("32", status);
        case "completed": return c("2", status);
        case "failed": return c("31", status);
        case "cancelled": return c("33", status);
        case "preparing": return c("34", status);
        case "queued": return c("34", status);
        default: return status;
      }
    };

    const verbose = args.verbose ?? false;
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
  }),
});

const attachCmd = command({
  name: "attach",
  description: "Attach to a session",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("attach", async () => {
    if (!sessionId) {
      fail("usage: orka attach <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    if (!(await svc.isAlive(session.id))) {
      fail(`tmux session not running: ${session.tmuxSessionName}`);
    }

    if (remoteUrl) {
      console.log(`session ${session.id} is running remotely`);
      console.log("");
      console.log("to attach via SSH:");
      console.log(`  ssh <host> -t tmux attach -t ${session.tmuxSessionName}`);
      console.log("");
      console.log("or use 'orka logs -f' to stream output remotely:");
      console.log(`  orka --remote ${remoteUrl} logs -f ${session.id}`);
      return;
    }

    await defaultRunner.attach(session.tmuxSessionName);
  }),
});

const logsCmd = command({
  name: "logs",
  description: "View session logs",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    follow: flag({ long: "follow", short: "f" }),
  },
  handler: async ({ sessionId, follow }) => runCliCommand("logs", async () => {
    if (!sessionId) {
      fail("usage: orka logs <session-id> [--follow]");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    if (!follow) {
      try {
        const output = await svc.captureOutput(session.id);
        console.log(output);
        return;
      } catch {
        fail("no logs available (session ended, no log file found)");
      }
    }

    if (await svc.isAlive(session.id)) {
      let offset = 0;
      while (true) {
        try {
          const output = await svc.captureOutput(session.id);
          if (output.length > offset) {
            process.stdout.write(output.slice(offset));
            offset = output.length;
          }
        } catch {
          break;
        }
        if (!(await svc.isAlive(session.id))) break;
        await Bun.sleep(500);
      }
      return;
    }

    if (session.logFile && existsSync(session.logFile)) {
      const proc = Bun.spawn(["tail", "-f", session.logFile], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      return;
    }

    fail("no logs available (session ended, no log file found)");
  }),
});

const stopCmd = command({
  name: "stop",
  description: "Stop a session",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("stop", async () => {
    if (!sessionId) {
      fail("usage: orka stop <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    if (session.status !== "running" && session.status !== "preparing") {
      fail(`session ${session.id} is already ${session.status}`);
    }

    await svc.stop(session.id);
    console.log(`stopped session ${session.id}`);
  }),
});

const diffCmd = command({
  name: "diff",
  description: "Show git changes in a session worktree",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("diff", async () => {
    if (!sessionId) {
      fail("usage: orka diff <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    try {
      const { status, diff } = await svc.getDiff(session.id);
      console.log(status);
      if (diff) {
        console.log("");
        console.log(diff);
      }
    } catch (e: any) {
      fail(`error: ${e.message}`);
    }
  }),
});

const retryCmd = command({
  name: "retry",
  description: "Re-run a session with the same prompt",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("retry", async () => {
    if (!sessionId) {
      fail("usage: orka retry <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    if (session.status === "running") {
      fail(`session ${session.id} is still running — stop it first`);
    }

    const task = await svc.getTask(session.taskId);
    if (!task) {
      fail(`task not found for session: ${session.id}`);
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
      await defaultRunner.attach(newSession.tmuxSessionName);
    }
  }),
});

const showCmd = command({
  name: "show",
  description: "Show full details for a session",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("show", async () => {
    if (!sessionId) {
      fail("usage: orka show <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
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
    if (session.kept) console.log("  kept:      yes (worktree protected)");
    if (session.autoMerge) console.log("  auto-merge: yes");

    const tags = await svc.getTags(session.id);
    if (tags.length > 0) console.log(`  tags:      ${tags.join(", ")}`);

    if (task) {
      console.log("");
      console.log(`  title:     ${task.title}`);
      console.log(`  prompt:    ${task.prompt}`);
    }
  }),
});

const workdirCmd = command({
  name: "workdir",
  description: "Print session working directory",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("workdir", async () => {
    if (!sessionId) {
      fail("usage: orka workdir <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    console.log(session.workingDir);
  }),
});

const waitCmd = command({
  name: "wait",
  description: "Wait for session(s) to complete",
  args: {
    all: flag({ long: "all" }),
    project: option({ type: optional(str), long: "project" }),
    ids: restPositionals({ type: str, displayName: "session-id" }),
  },
  handler: async ({ all, project, ids }) => runCliCommand("wait", async () => {
    if (ids.length === 0 && !all) {
      fail("usage: orka wait <session-id...> | --all [--project <name>]");
    }

    const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
    let targets: string[];

    if (all) {
      let running = (await svc.listSessions()).filter((s) => !terminalStatuses.has(s.status));
      if (project) {
        const resolved = resolveProject(project);
        running = running.filter((s) =>
          s.projectPath === resolved || s.projectPath === project || projectName(s.projectPath) === project,
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
          fail(`session not found: ${id}`);
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
  }),
});

const resultCmd = command({
  name: "result",
  description: "Show final result from a background session",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    json: flag({ long: "json" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId, json }) => runCliCommand("result", async () => {
    if (!sessionId) {
      fail("usage: orka result <session-id> [--json]");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    const result = await svc.getResult(session.id);
    if (!result) {
      fail("no result found in session log (session may not be a background claude-code session)");
    }

    if (json) {
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
      console.log(
        `  cache:    ${result.cacheReadTokens.toLocaleString()} read / ${result.cacheCreateTokens.toLocaleString()} created`,
      );
    }

    console.log("");
    console.log(c("1", "Result:"));
    console.log(result.result);
  }),
});

const sendCmd = command({
  name: "send",
  description: "Send text input to a running session",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    text: restPositionals({ type: str, displayName: "text" }),
  },
  handler: async ({ sessionId, text }) => runCliCommand("send", async () => {
    if (!sessionId || text.length === 0) {
      fail("usage: orka send <session-id> <text...>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    try {
      await svc.sendInput(session.id, text.join(" "));
      console.log(`sent to ${session.id}`);
    } catch (e: any) {
      fail(`error: ${e.message}`);
    }
  }),
});

const keepCmd = command({
  name: "keep",
  description: "Protect a session's worktree from auto-cleanup",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("keep", async () => {
    if (!sessionId) {
      fail("usage: orka keep <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    await svc.setKept(session.id, true);
    console.log(`session ${session.id} marked as kept (worktree protected from cleanup)`);
  }),
});

const unkeepCmd = command({
  name: "unkeep",
  description: "Remove worktree protection",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("unkeep", async () => {
    if (!sessionId) {
      fail("usage: orka unkeep <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    await svc.setKept(session.id, false);
    console.log(`session ${session.id} unprotected (worktree may be cleaned up)`);
  }),
});

const mergeCmd = command({
  name: "merge",
  description: "Merge session worktree branch into current branch",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id" }),
    noCleanup: flag({ long: "no-cleanup" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId, noCleanup }) => runCliCommand("merge", async () => {
    if (!sessionId) {
      fail("usage: orka merge <session-id> [--no-cleanup]");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    try {
      const { branch, commits, cleaned } = await svc.merge(session.id, !noCleanup);
      console.log(`merged ${commits} commit(s) from ${branch}`);
      if (cleaned) {
        console.log(`cleaned up worktree and branch ${branch}`);
      }
    } catch (e: any) {
      fail(`error: ${e.message}`);
    }
  }),
});

const pruneCmd = command({
  name: "prune",
  description: "Remove old completed/cancelled/failed sessions",
  args: {
    age: option({ type: optional(str), long: "age" }),
    project: option({ type: optional(str), long: "project" }),
  },
  handler: async ({ age, project }) => runCliCommand("prune", async () => {
    const maxAgeMs = parseAge(age ?? "24h");
    const projectPath = project ? resolveProject(project) : undefined;

    const { pruned, orphansCleaned } = await svc.pruneSessions({ maxAgeMs, projectPath });

    if (pruned === 0) {
      console.log("nothing to prune");
    } else {
      console.log(`pruned ${pruned} session(s)`);
    }
    if (orphansCleaned > 0) {
      console.log(`cleaned ${orphansCleaned} orphaned worktree(s)`);
    }
  }),
});

const serveCmd = command({
  name: "serve",
  description: "Start daemon WS server",
  args: {
    port: option({ type: optional(str), long: "port" }),
    host: option({ type: optional(str), long: "host" }),
    relay: option({ type: optional(str), long: "relay" }),
    nodeId: option({ type: optional(str), long: "node-id" }),
    relayToken: option({ type: optional(str), long: "relay-token" }),
  },
  handler: async (args) => runCliCommand("serve", async () => {
    const port = parseInt(args.port ?? "7394", 10);
    const hostname = args.host ?? "127.0.0.1";
    const localSvc = createLocalClient();
    const server = await startServer(localSvc, {
      port,
      hostname,
      relayUrl: args.relay,
      nodeId: args.nodeId,
      relayToken: args.relayToken ?? process.env.ORKA_TOKEN,
      encrypt: useEncrypt,
    });
    console.log(`orka daemon listening on ws://${hostname}:${server.port}`);
    if (args.relay) {
      console.log(`  relay: ${args.relay}`);
    }

    await new Promise(() => {});
  }),
});

const projectAddCmd = command({
  name: "add",
  description: "Register a project alias",
  args: {
    name: positional({ type: optional(str), displayName: "name" }),
    path: positional({ type: optional(str), displayName: "path" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ name, path }) => runCliCommand("project", async () => {
    if (!name) {
      fail("usage: orka project add <name> [path]");
    }
    const entry = addProject(name, path || ".");
    console.log(`registered project ${entry.name} → ${entry.path}`);
  }),
});

const projectRemoveCmd = command({
  name: "remove",
  description: "Unregister a project alias",
  args: {
    name: positional({ type: optional(str), displayName: "name" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ name }) => runCliCommand("project", async () => {
    if (!name) {
      fail("usage: orka project remove <name>");
    }
    if (removeProject(name)) {
      console.log(`removed project ${name}`);
    } else {
      fail(`project not found: ${name}`);
    }
  }),
});

const projectRmCmd = command({
  name: "rm",
  description: "Unregister a project alias",
  args: {
    name: positional({ type: optional(str), displayName: "name" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ name }) => runCliCommand("project", async () => {
    if (!name) {
      fail("usage: orka project remove <name>");
    }
    if (removeProject(name)) {
      console.log(`removed project ${name}`);
    } else {
      fail(`project not found: ${name}`);
    }
  }),
});

const projectListCmd = command({
  name: "list",
  description: "List project aliases",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("project", async () => {
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
  }),
});

const projectLsCmd = command({
  name: "ls",
  description: "List project aliases",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("project", async () => {
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
  }),
});

const projectCmd = subcommands({
  name: "project",
  description: "Register/list/remove project aliases",
  cmds: {
    add: projectAddCmd,
    remove: projectRemoveCmd,
    rm: projectRmCmd,
    list: projectListCmd,
    ls: projectLsCmd,
  },
});

const relayServeCmd = command({
  name: "serve",
  description: "Start relay server",
  args: {
    port: option({ type: optional(str), long: "port" }),
    token: option({ type: optional(str), long: "token" }),
  },
  handler: async ({ port, token }) => runCliCommand("relay", async () => {
    const parsedPort = parseInt(port ?? "7390", 10);
    const relayToken = token ?? process.env.ORKA_TOKEN;
    const handle = startRelay({ port: parsedPort, token: relayToken });
    console.log(`orka relay listening on ws://0.0.0.0:${handle.server.port}`);
    console.log("  nodes register at:  /register?node=<id>");
    console.log("  clients connect at: /ws");

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

    await new Promise(() => {});
  }),
});

const relaySignupCmd = command({
  name: "signup",
  description: "Sign up for a relay account",
  args: {
    email: option({ type: optional(str), long: "email" }),
    name: option({ type: optional(str), long: "name" }),
  },
  handler: async ({ email, name }) => runCliCommand("relay", async () => {
    if (!email || !name) {
      fail("usage: orka relay signup --email <email> --name <name>");
    }

    const data = await relayFetch("/v1/signup", {
      method: "POST",
      body: { email, name },
      auth: false,
    });

    saveApiKey(data.apiKey);

    console.log("signup successful!");
    console.log(`  account: ${data.accountId}`);
    console.log(`  api key: ${data.apiKey}`);
    console.log("");
    console.log(`key saved to ${join(getOrkaHome(), "relay-key")}`);
    console.log("it will be used automatically for future relay commands");
  }),
});

const relayKeysCreateCmd = command({
  name: "create",
  description: "Create an API key",
  args: {
    label: option({ type: optional(str), long: "label" }),
    permissions: option({ type: optional(str), long: "permissions" }),
  },
  handler: async ({ label, permissions }) => runCliCommand("relay", async () => {
    const body: any = {};
    if (label) body.label = label;
    if (permissions) body.permissions = permissions;

    const data = await relayFetch("/v1/keys", { method: "POST", body });
    console.log("key created:");
    console.log(`  id:     ${data.keyId}`);
    console.log(`  key:    ${data.apiKey}`);
    console.log(`  prefix: ${data.prefix}`);
  }),
});

const relayKeysRevokeCmd = command({
  name: "revoke",
  description: "Revoke an API key",
  args: {
    keyId: positional({ type: optional(str), displayName: "key-id" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ keyId }) => runCliCommand("relay", async () => {
    if (!keyId) {
      fail("usage: orka relay keys revoke <key-id>");
    }
    await relayFetch(`/v1/keys/${keyId}`, { method: "DELETE" });
    console.log(`revoked key ${keyId}`);
  }),
});

const relayKeysListCmd = command({
  name: "list",
  description: "List API keys",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("relay", async () => {
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
  }),
});

const relayKeysCmd = subcommands({
  name: "keys",
  description: "Manage API keys",
  cmds: {
    create: relayKeysCreateCmd,
    revoke: relayKeysRevokeCmd,
    list: relayKeysListCmd,
  },
});

const relayAccountCmd = command({
  name: "account",
  description: "Show account info",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("relay", async () => {
    const data = await relayFetch("/v1/account");
    console.log(`account ${data.id}`);
    console.log(`  email:   ${data.email}`);
    console.log(`  name:    ${data.name}`);
    console.log(`  status:  ${data.status}`);
    console.log(`  tier:    ${data.tier}`);
    console.log(`  created: ${data.createdAt}`);
  }),
});

const relayUsageCmd = command({
  name: "usage",
  description: "Show usage statistics",
  args: {
    from: option({ type: optional(str), long: "from" }),
    to: option({ type: optional(str), long: "to" }),
    granularity: option({ type: optional(str), long: "granularity" }),
  },
  handler: async ({ from, to, granularity }) => runCliCommand("relay", async () => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("granularity", granularity ?? "hour");

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
  }),
});

const relayCmd = subcommands({
  name: "relay",
  description: "Start relay WS router / manage relay account",
  cmds: {
    serve: relayServeCmd,
    signup: relaySignupCmd,
    keys: relayKeysCmd,
    account: relayAccountCmd,
    usage: relayUsageCmd,
  },
});

const keygenClientCmd = command({
  name: "client",
  description: "Generate/show client keypair",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("keygen", async () => {
    const orkaHome = getOrkaHome();
    const kp = ensureKeyPair(orkaHome, "client");
    console.log("client keypair:");
    console.log(`  public:  ${kp.publicKey}`);
    console.log(`  stored:  ${orkaHome}/keys/client.pub, ${orkaHome}/keys/client.key`);
  }),
});

const keygenNodeCmd = command({
  name: "node",
  description: "Generate/show node keypair",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("keygen", async () => {
    const orkaHome = getOrkaHome();
    const kp = ensureKeyPair(orkaHome, "node");
    console.log("node keypair:");
    console.log(`  public:  ${kp.publicKey}`);
    console.log(`  stored:  ${orkaHome}/keys/node.pub, ${orkaHome}/keys/node.key`);
  }),
});

const keygenSaveServerCmd = command({
  name: "save-server",
  description: "Save a remote server's public key",
  args: {
    pubkey: positional({ type: optional(str), displayName: "public-key" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ pubkey }) => runCliCommand("keygen", async () => {
    if (!pubkey) {
      console.error("usage: orka keygen save-server <public-key>");
      console.error("  get it from: curl <daemon-url>/health | jq -r .publicKey");
      process.exit(1);
    }
    const orkaHome = getOrkaHome();
    const keysDir = join(orkaHome, "keys");
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, "server.pub"), pubkey, { mode: 0o644 });
    console.log(`saved server public key to ${keysDir}/server.pub`);
  }),
});

const keygenShowCmd = command({
  name: "show",
  description: "Show all stored keys",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("keygen", async () => {
    const orkaHome = getOrkaHome();
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
  }),
});

const keygenHelpCmd = command({
  name: "help",
  description: "Show keygen usage",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("keygen", async () => {
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
  }),
});

const keygenCmd = subcommands({
  name: "keygen",
  description: "Manage E2E encryption keys",
  cmds: {
    client: keygenClientCmd,
    node: keygenNodeCmd,
    "save-server": keygenSaveServerCmd,
    show: keygenShowCmd,
    help: keygenHelpCmd,
  },
});

const app = subcommands({
  name: "orka",
  description: "agent session orchestrator",
  cmds: {
    spawn: spawnCmd,
    ps: psCmd,
    attach: attachCmd,
    logs: logsCmd,
    stop: stopCmd,
    diff: diffCmd,
    retry: retryCmd,
    show: showCmd,
    workdir: workdirCmd,
    wait: waitCmd,
    result: resultCmd,
    send: sendCmd,
    keep: keepCmd,
    unkeep: unkeepCmd,
    merge: mergeCmd,
    project: projectCmd,
    prune: pruneCmd,
    serve: serveCmd,
    relay: relayCmd,
    keygen: keygenCmd,
  },
});

function normalizeArgv(argv: string[]): string[] | null {
  if (argv.length === 0) return null;

  const normalized = [...argv];
  const top = normalized[0];
  if (!top || !TOP_LEVEL_COMMANDS.has(top)) return null;

  if (top === "project") {
    const sub = normalized[1];
    if (!sub) {
      normalized.splice(1, 0, "list");
    } else if (!PROJECT_SUBCOMMANDS.has(sub)) {
      console.error("usage: orka project <add|remove|list>");
      console.error("  add <name> [path]  — register project (default path: .)");
      console.error("  remove <name>      — unregister project");
      console.error("  list               — show registered projects");
      process.exit(1);
    }
  }

  if (top === "relay") {
    const sub = normalized[1];
    if (!sub || sub.startsWith("-")) {
      normalized.splice(1, 0, "serve");
    }
    const next = normalized[1];
    if (next === "keys") {
      const keysSub = normalized[2];
      if (!keysSub) {
        normalized.splice(2, 0, "list");
      } else if (!RELAY_KEYS_SUBCOMMANDS.has(keysSub)) {
        console.error("usage: orka relay keys [list|create|revoke]");
        console.error("  list                          List API keys");
        console.error("  create [--label L] [--permissions client|node]  Create a key");
        console.error("  revoke <key-id>               Revoke a key");
        process.exit(1);
      }
    } else if (next && !RELAY_SUBCOMMANDS.has(next)) {
      normalized.splice(1, 0, "serve");
    }
  }

  if (top === "keygen") {
    const sub = normalized[1];
    if (!sub || !KEYGEN_SUBCOMMANDS.has(sub)) {
      normalized.splice(1, 0, "help");
    }
  }

  return normalized;
}

try {
  const argv = normalizeArgv(process.argv.slice(2));
  if (!argv) {
    printUsage();
  } else {
    await run(app, argv);
  }
} finally {
  await shutdownTracing();
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

// --- Relay API helpers ---

function getRelayHttpUrl(): string {
  let base = remoteUrl ?? process.env.ORKA_RELAY_URL;
  if (!base) {
    console.error("error: relay URL required (use --remote <url> or ORKA_RELAY_URL)");
    process.exit(1);
  }
  base = base.split("?")[0];
  return base.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
}

function getApiKey(): string | null {
  if (process.env.ORKA_API_KEY) return process.env.ORKA_API_KEY;
  const keyFile = join(getOrkaHome(), "relay-key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf-8").trim();
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
    if (key) headers.authorization = `Bearer ${key}`;
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
