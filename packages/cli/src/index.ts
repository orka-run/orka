#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BackendKind, SessionMode, OrkaService, ReasoningEffort, SpawnRequest } from "@orka/core";
import { ensureKeyPair, loadKeyPair, loadPublicKey } from "@orka/core";
import { startRelay } from "@orka/relay";
import {
  createLocalClient,
  createRemoteClient,
  startServer,
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
  formatLog,
  formatEvent,
  parseLine,
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
  array,
  oneOf,
  type Type,
} from "cmd-ts";

void bool;

// Custom enum type that shows valid values in help text
function enumType<T extends string>(values: readonly T[]): Type<string, T> {
  return {
    ...oneOf(values),
    displayName: values.join("|"),
    description: `one of: ${values.join(", ")}`,
  };
}

const statusValues = ["running", "completed", "failed", "cancelled", "queued", "preparing"] as const;
const backendValues = ["claude-code", "codex", "shell"] as const;
const modeValues = ["interactive", "background"] as const;
const MIN_PRUNE_AGE_MS = 60 * 60 * 1000;

// Check for --remote and --token flags before command
const remoteIdx = process.argv.indexOf("--remote");
let remoteUrl = remoteIdx !== -1 ? process.argv[remoteIdx + 1] : process.env["ORKA_REMOTE"];
if (remoteIdx !== -1) {
  process.argv.splice(remoteIdx, 2);
}
const tokenIdx = process.argv.indexOf("--token");
let remoteToken = tokenIdx !== -1 ? process.argv[tokenIdx + 1] : process.env["ORKA_TOKEN"];
if (tokenIdx !== -1) {
  process.argv.splice(tokenIdx, 2);
}
// Auto-load API key: ORKA_API_KEY > ~/.orka/relay-key > --token/ORKA_TOKEN
if (!remoteToken) {
  remoteToken = process.env["ORKA_API_KEY"] ?? undefined;
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
const useEncrypt = encryptIdx !== -1 || !!process.env["ORKA_ENCRYPT"];
if (encryptIdx !== -1) {
  process.argv.splice(encryptIdx, 1);
}

// Server public key for E2E (can be set via env or fetched from /health)
const serverPubKeyIdx = process.argv.indexOf("--server-key");
let serverPublicKey = serverPubKeyIdx !== -1 ? process.argv[serverPubKeyIdx + 1] : process.env["ORKA_SERVER_KEY"];
if (serverPubKeyIdx !== -1) {
  process.argv.splice(serverPubKeyIdx, 2);
}

const DEFAULT_DAEMON_PORT = 7394;
const DEFAULT_DAEMON_HOST = "127.0.0.1";
const DEFAULT_DAEMON_URL = `ws://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`;
const DEFAULT_DAEMON_HEALTH = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}/health`;
const DEFAULT_DAEMON_TRACES = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}/v1/traces`;

function deriveTraceCollectorEndpoint(url: string): string | undefined {
  try {
    const endpoint = new URL(url);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    endpoint.pathname = "/v1/traces";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString();
  } catch {
    return undefined;
  }
}

const topLevelCommand = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const traceCollectorEndpoint = remoteUrl ? deriveTraceCollectorEndpoint(remoteUrl) : DEFAULT_DAEMON_TRACES;
initTracing(
  topLevelCommand === "serve"
    ? {}
    : {
        ...(traceCollectorEndpoint ? { otlpHttpEndpoint: traceCollectorEndpoint } : {}),
        otlpFallbackToFile: true,
      },
);

async function isDaemonRunning(): Promise<boolean> {
  try {
    const resp = await fetch(DEFAULT_DAEMON_HEALTH, { signal: AbortSignal.timeout(500) });
    const body = await resp.json() as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

async function startDaemonBackground(): Promise<void> {
  const cliPath = new URL(import.meta.url).pathname;
  const logsDir = join(getOrkaHome(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, "daemon.log");
  const pidPath = join(getOrkaHome(), "daemon.pid");

  // Use setsid to create a new session so daemon survives parent exit
  const proc = Bun.spawn(
    ["setsid", "bun", "run", cliPath, "serve"],
    {
      stdin: "ignore",
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
      env: { ...process.env },
    },
  );
  // Write PID for later management
  writeFileSync(pidPath, String(proc.pid));
  proc.unref();

  // Wait for daemon to become healthy (up to 5s)
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isDaemonRunning()) return;
  }
  throw new Error("Failed to start daemon — timed out waiting for health check. Check " + logPath);
}

async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;
  await startDaemonBackground();
}

function buildRemoteClient(url: string): OrkaService {
  if (useEncrypt) {
    const orkaHome = getOrkaHome();
    const keyPair = ensureKeyPair(orkaHome, "client");
    let pubKey = serverPublicKey;
    if (!pubKey) {
      pubKey = loadPublicKey(orkaHome, "server") ?? undefined;
    }
    if (!pubKey) {
      console.error("error: E2E encryption requires server public key (--server-key or ORKA_SERVER_KEY)");
      console.error("  get it from: curl <daemon-url>/health | jq -r .publicKey");
      console.error("  or save it:  orka keygen save-server <pubkey>");
      process.exit(1);
    }
    return createRemoteClient({ url, keyPair, serverPublicKey: pubKey });
  }
  return createRemoteClient(url);
}

// svc is initialized lazily — all commands go through the daemon via RPC.
// Only `orka serve` uses LocalClient directly (it IS the daemon).
let _svc: OrkaService | null = null;
async function getSvc(): Promise<OrkaService> {
  if (_svc) return _svc;
  if (remoteUrl) {
    _svc = buildRemoteClient(remoteUrl);
  } else {
    await ensureDaemon();
    _svc = buildRemoteClient(DEFAULT_DAEMON_URL);
  }
  return _svc;
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
  "usage",
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

let svc: OrkaService;

// Commands that don't need the daemon (local-only operations)
const LOCAL_ONLY_COMMANDS = new Set(["serve", "project", "keygen", "relay"]);

async function runCliCommand(name: string, fn: () => Promise<void>): Promise<void> {
  await withSpan(`orka.cli.${name}`, { "orka.command": name }, async () => {
    if (!LOCAL_ONLY_COMMANDS.has(name)) {
      svc = await getSvc();
      if (name !== "wait") {
        await svc.reap();
      }
    }
    await fn();
  });
}

function createLogChunkFormatter() {
  let pending = "";

  return {
    push(chunk: string): void {
      const combined = `${pending}${chunk}`;
      const lines = combined.split(/\r?\n/);
      pending = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseLine(line);
        if (!event) continue;
        process.stdout.write(`${formatEvent(event)}\n`);
      }
    },
    flush(): void {
      if (!pending) return;
      const event = parseLine(pending);
      pending = "";
      if (event) {
        process.stdout.write(`${formatEvent(event)}\n`);
      }
    },
    reset(): void {
      pending = "";
    },
  };
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

function parseAllowedTools(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const tools = value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function parseEnvAssignments(values: string[]): Record<string, string> | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const assignment of values) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      fail(`error: invalid --env value "${assignment}" (expected KEY=VALUE)`);
    }

    const key = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      fail(`error: invalid environment variable name "${key}"`);
    }

    env[key] = value;
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

const spawnCmd = command({
  name: "spawn",
  description: "Spawn an agent session",
  examples: [
    { description: "Background task with inline prompt", command: "orka spawn -m background fix the login bug" },
    { description: "Interactive session with specific backend", command: "orka spawn -b codex 'refactor auth module'" },
    { description: "Read prompt from file, auto-merge on success", command: "orka spawn --prompt-file task.md --auto-merge" },
    { description: "Pipe prompt from stdin", command: "echo 'add tests' | orka spawn -m background" },
  ],
  args: {
    project: option({ type: optional(str), long: "project", short: "p", description: "Project directory or alias (default: current dir)" }),
    backend: option({ type: optional(enumType(backendValues)), long: "backend", short: "b", description: "Agent backend (default: claude-code)" }),
    prompt: option({ type: optional(str), long: "prompt", description: "Task prompt (or use positional args / stdin)" }),
    promptFile: option({ type: optional(str), long: "prompt-file", description: "Read prompt from a file" }),
    mode: option({ type: optional(enumType(modeValues)), long: "mode", short: "m", description: "Session mode (default: interactive)" }),
    model: option({ type: optional(str), long: "model", description: "Model for the backend (e.g. sonnet, opus, haiku)" }),
    branch: option({ type: optional(str), long: "branch", description: "Git branch name (creates worktree)" }),
    title: option({ type: optional(str), long: "title", description: "Session title for display in orka ps" }),
    systemPrompt: option({ type: optional(str), long: "system-prompt", description: "Extra instructions prepended to the agent session" }),
    allowedTools: option({ type: optional(str), long: "allowed-tools", description: "Comma-separated Claude Code allowed tools" }),
    env: multioption({ type: array(str), long: "env", description: "Environment variable to pass through (repeatable KEY=VALUE)" }),
    reasoningEffort: option({ type: optional(str), long: "reasoning-effort", description: "Reasoning effort level (low, medium, high)" }),
    autoMerge: flag({ long: "auto-merge", description: "Auto-merge worktree on successful completion" }),
    tag: multioption({ type: array(str), long: "tag", description: "Tag the session (repeatable)" }),
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

    const allowedTools = parseAllowedTools(args.allowedTools);
    const env = parseEnvAssignments(args.env);
    const spawnRequest: SpawnRequest = {
      prompt,
      projectPath: resolveProject(args.project ?? cfg.project),
      backend: (args.backend ?? cfg.backend) as BackendKind,
      mode: (args.mode ?? cfg.mode) as SessionMode,
      ...(args.title ? { title: args.title } : {}),
      ...(args.model || cfg.model ? { model: args.model || cfg.model } : {}),
      ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort as ReasoningEffort } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.autoMerge ? { autoMerge: true } : {}),
      ...(args.tag.length > 0 ? { tags: args.tag } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(env ? { env } : {}),
    };
    let session;
    try {
      session = await svc.spawn(spawnRequest);
    } catch (e: any) {
      fail(`error: ${e.message}`);
    }

    console.log(`spawned session ${session.id}`);
    console.log(`  backend:  ${session.backend}`);
    console.log(`  mode:     ${session.mode}`);
    console.log(`  workdir:  ${session.workingDir}`);
    console.log(`  log:      ${session.logFile}`);
    if (args.tag.length > 0) {
      console.log(`  tags:     ${args.tag.join(", ")}`);
    }
  }),
});

const psCmd = command({
  name: "ps",
  description: "List active sessions",
  examples: [
    { description: "Show only running sessions", command: "orka ps --status running" },
    { description: "Verbose output with cost and tokens", command: "orka ps -v" },
    { description: "Filter by project and backend", command: "orka ps --project myapp --backend codex" },
  ],
  args: {
    status: option({ type: optional(enumType(statusValues)), long: "status", description: "Filter by session status" }),
    backend: option({ type: optional(enumType(backendValues)), long: "backend", description: "Filter by agent backend" }),
    project: option({ type: optional(str), long: "project", description: "Filter by project name or path" }),
    tag: option({ type: optional(str), long: "tag", description: "Filter by tag" }),
    verbose: flag({ long: "verbose", short: "v", description: "Show cost, duration, tokens, and project" }),
  },
  handler: async (args) => runCliCommand("ps", async () => {
    let sessions = await svc.listSessions({
      ...(args.status ? { status: args.status } : {}),
      ...(args.tag ? { tag: args.tag } : {}),
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
  description: "Stream live session output (alias for logs -f)",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
      fail(`session not running: ${session.id}`);
    }

    // Stream live output
    let offset = 0;
    const formatter = createLogChunkFormatter();
    while (true) {
      try {
        const output = await svc.captureOutput(session.id);
        if (output.length < offset) {
          offset = 0;
          formatter.reset();
        }
        if (output.length > offset) {
          formatter.push(output.slice(offset));
          offset = output.length;
        }
      } catch {
        break;
      }
      if (!(await svc.isAlive(session.id))) break;
      await Bun.sleep(500);
    }
    // Final read after session ended
    try {
      const output = await svc.captureOutput(session.id);
      if (output.length > offset) {
        formatter.push(output.slice(offset));
      }
    } catch { /* ignore */ }
    formatter.flush();
  }),
});

const logsCmd = command({
  name: "logs",
  description: "View session output (formatted from stream-json)",
  examples: [
    { description: "Stream live output", command: "orka logs -f <session-id>" },
  ],
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
    follow: flag({ long: "follow", short: "f", description: "Stream live output (polls until session ends)" }),
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
        console.log(formatLog(output));
        return;
      } catch {
        fail("no logs available (session ended, no log file found)");
      }
    }

    if (await svc.isAlive(session.id)) {
      let offset = 0;
      const formatter = createLogChunkFormatter();
      while (true) {
        try {
          const output = await svc.captureOutput(session.id);
          if (output.length < offset) {
            offset = 0;
            formatter.reset();
          }
          if (output.length > offset) {
            formatter.push(output.slice(offset));
            offset = output.length;
          }
        } catch {
          break;
        }
        if (!(await svc.isAlive(session.id))) break;
        await Bun.sleep(500);
      }
      formatter.flush();
      return;
    }

    if (session.logFile && existsSync(session.logFile)) {
      const proc = Bun.spawn(["tail", "-f", session.logFile], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const formatter = createLogChunkFormatter();
      const decoder = new TextDecoder();
      if (proc.stdout) {
        const reader = proc.stdout.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            formatter.push(decoder.decode(value, { stream: true }));
          }
        }
        const tail = decoder.decode();
        if (tail) formatter.push(tail);
      }
      formatter.flush();
      await proc.exited;
      return;
    }

    fail("no logs available (session ended, no log file found)");
  }),
});

const stopCmd = command({
  name: "stop",
  description: "Stop a running session",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
  description: "Show git status and diff in a session's worktree",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
  description: "Re-run a session with the same prompt and spawn options",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
    const retryRequest: SpawnRequest = {
      prompt: task.prompt,
      projectPath: session.projectPath || session.workingDir,
      backend: session.backend,
      mode: session.mode,
      ...(task.title ? { title: task.title } : {}),
      ...(task.model ? { model: task.model } : {}),
      ...(oldTags.length > 0 ? { tags: oldTags } : {}),
      ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
      ...(session.allowedTools ? { allowedTools: session.allowedTools } : {}),
      ...(session.env ? { env: session.env } : {}),
    };
    const newSession = await svc.spawn(retryRequest);

    console.log(`retried session ${session.id} → ${newSession.id}`);
    console.log(`  backend:  ${newSession.backend}`);
    console.log(`  mode:     ${newSession.mode}`);
    console.log(`  workdir:  ${newSession.workingDir}`);
    console.log(`  log:      ${newSession.logFile}`);
  }),
});

const showCmd = command({
  name: "show",
  description: "Show full details for a session (status, config, prompt, tags)",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
    console.log(`  log:       ${session.logFile}`);
    console.log(`  created:   ${session.createdAt}`);
    console.log(`  started:   ${session.startedAt ?? "(not started)"}`);
    console.log(`  finished:  ${session.finishedAt ?? "(not finished)"}`);
    console.log(`  exit code: ${session.exitCode ?? "(none)"}`);
    if (session.kept) console.log("  kept:      yes (worktree protected)");
    if (session.autoMerge) console.log("  auto-merge: yes");
    if (session.allowedTools && session.allowedTools.length > 0) {
      console.log(`  tools:     ${session.allowedTools.join(", ")}`);
    }
    if (session.env && Object.keys(session.env).length > 0) {
      console.log(`  env:       ${Object.keys(session.env).join(", ")}`);
    }

    const tags = await svc.getTags(session.id);
    if (tags.length > 0) console.log(`  tags:      ${tags.join(", ")}`);

    if (task) {
      console.log("");
      console.log(`  title:     ${task.title}`);
      console.log(`  prompt:    ${task.prompt}`);
      if (session.systemPrompt) console.log(`  system:    ${session.systemPrompt}`);
    }
  }),
});

const workdirCmd = command({
  name: "workdir",
  description: "Print session working directory (use with: cd $(orka workdir <id>))",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
  description: "Block until session(s) complete, then show summary",
  examples: [
    { description: "Wait for specific sessions", command: "orka wait sess-abc sess-def" },
    { description: "Wait for all running sessions", command: "orka wait --all" },
    { description: "Wait for all sessions in a project", command: "orka wait --all --project myapp" },
  ],
  args: {
    all: flag({ long: "all", description: "Wait for all running sessions" }),
    verbose: flag({ long: "verbose", short: "v", description: "Show result preview for each session" }),
    project: option({ type: optional(str), long: "project", description: "Only wait for sessions in this project" }),
    ids: restPositionals({ type: str, displayName: "session-id" }),
  },
  handler: async ({ all, verbose, project, ids }) => runCliCommand("wait", async () => {
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
    let completedCount = 0;
    let failedCount = 0;
    let totalCost = 0;
    const wallStart = Date.now();

    while (pending.size > 0) {
      await svc.reap();
      for (const id of [...pending]) {
        const s = await svc.getSession(id);
        if (!s || terminalStatuses.has(s.status)) {
          pending.delete(id);
          const status = s?.status ?? "unknown";
          const task = s ? await svc.getTask(s.taskId) : null;
          const label = task?.title?.slice(0, 50) ?? id;
          const icon = status === "failed" ? "✗" : "✓";

          const result = s ? await svc.getResult(s.id) : null;
          if (result) {
            const costStr = formatCost(result.costUsd);
            const tokIn = formatTokens(result.inputTokens);
            const tokOut = formatTokens(result.outputTokens);
            const dur = formatDuration(result.durationMs);
            console.log(`  ${icon} ${id}  ${status}  ${label}`);
            console.log(`    cost: ${costStr}  tokens: ${tokIn} in / ${tokOut} out  duration: ${dur}`);

            if (verbose && result.result) {
              const lines = result.result.split("\n").slice(0, 5);
              for (const line of lines) {
                console.log(`    > ${line.slice(0, 120)}`);
              }
            }

            if (result.costUsd != null) totalCost += result.costUsd;
          } else {
            console.log(`  ${icon} ${id}  ${status}  ${label}`);
          }

          if (status === "failed") {
            anyFailed = true;
            failedCount++;
          } else {
            completedCount++;
          }
        }
      }
      if (pending.size > 0) await Bun.sleep(2000);
    }

    const wallDuration = formatDuration(Date.now() - wallStart);
    const total = completedCount + failedCount;
    const parts: string[] = [];
    if (completedCount > 0) parts.push(`${completedCount} completed`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    console.log(`all ${total} sessions finished${breakdown}  total cost: ${formatCost(totalCost)}  duration: ${wallDuration}`);
    if (anyFailed) process.exit(1);
  }),
});

const resultCmd = command({
  name: "result",
  description: "Extract final result, cost, and tokens from a background session",
  examples: [
    { description: "Show formatted result", command: "orka result <session-id>" },
    { description: "Get machine-readable JSON", command: "orka result --json <session-id>" },
  ],
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
    json: flag({ long: "json", description: "Output as JSON (for scripting)" }),
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

const usageCmd = command({
  name: "usage",
  description: "Show usage totals by session and backend",
  examples: [
    { description: "Show all recorded usage", command: "orka usage" },
    { description: "Show usage for a session", command: "orka usage --session <id>" },
    { description: "Show usage from the last 24 hours", command: "orka usage --since 24h" },
    { description: "Show usage for a backend", command: "orka usage --backend codex" },
  ],
  args: {
    session: option({ type: optional(str), long: "session", description: "Session ID or prefix" }),
    since: option({ type: optional(str), long: "since", description: "Relative duration (24h, 7d, 30m) or ISO 8601 timestamp" }),
    backend: option({ type: optional(enumType(backendValues)), long: "backend", description: "Filter by backend" }),
  },
  handler: async ({ session: sessionQuery, since, backend }) => runCliCommand("usage", async () => {
    const session = sessionQuery ? await findSession(sessionQuery) : null;
    if (sessionQuery && !session) {
      fail(`session not found: ${sessionQuery}`);
    }

    const sinceIso = since ? parseSinceFilter(since) : undefined;
    const summary = await svc.getUsage({
      ...(session?.id ? { sessionId: session.id } : {}),
      ...(sinceIso ? { since: sinceIso } : {}),
      ...(backend ? { backend } : {}),
    });

    const scope: string[] = [];
    if (session) scope.push(`session ${session.id}`);
    if (since) scope.push(sinceLabel(since));
    if (backend) scope.push(`backend ${backend}`);
    const title = scope.length > 0 ? `Usage Summary (${scope.join(", ")})` : "Usage Summary";

    console.log(title);
    console.log(`  Sessions: ${summary.sessionCount}`);
    console.log(`  Total cost: $${summary.totalCostUsd.toFixed(2)}`);
    console.log(
      `  Total tokens: ${formatTokens(summary.totalInputTokens)} in / ${formatTokens(summary.totalOutputTokens)} out (${formatTokens(summary.totalCacheReadTokens)} cached)`,
    );

    const backendEntries = Object.entries(summary.byBackend);
    if (backendEntries.length === 0) {
      return;
    }

    console.log("");
    console.log("  By backend:");
    const backendWidth = Math.max(...backendEntries.map(([name]) => name.length));
    for (const [name, stats] of backendEntries) {
      const sessionLabel = `${stats.sessions} ${stats.sessions === 1 ? "session" : "sessions"}`;
      console.log(
        `    ${padR(name, backendWidth)}  ${padR(sessionLabel, 10)}  $${stats.cost.toFixed(2)}  ${formatTokens(stats.inputTokens)} in / ${formatTokens(stats.outputTokens)} out`,
      );
    }
  }),
});

const sendCmd = command({
  name: "send",
  description: "Send text input to a running session",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
  description: "Protect a session's worktree from auto-cleanup (survives prune/reap)",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
  description: "Remove worktree protection (allows auto-cleanup)",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
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
  description: "Merge session worktree branch into current branch (auto-cleans worktree)",
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
    noCleanup: flag({ long: "no-cleanup", description: "Keep worktree and branch after merge" }),
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
  description: "Remove old completed/cancelled/failed sessions and orphaned worktrees",
  examples: [
    { description: "Preview pruning sessions older than 7 days", command: "orka prune --age 7d" },
    { description: "Prune for a specific project and execute deletion", command: "orka prune --project myapp --confirm" },
    { description: "Prune sessions and also delete logs and DB records", command: "orka prune --age 7d --confirm --purge-all" },
  ],
  args: {
    age: option({ type: optional(str), long: "age", description: "Max age to keep (e.g. 24h, 7d, 30m; default: 24h)" }),
    project: option({ type: optional(str), long: "project", description: "Only prune sessions for this project" }),
    confirm: flag({ long: "confirm", description: "Actually execute deletion instead of running a dry run" }),
    force: flag({ long: "force", description: "Allow prune ages under 1 hour" }),
    purgeLogs: flag({ long: "purge-logs", description: "Also delete log and script files for pruned sessions" }),
    purgeDb: flag({ long: "purge-db", description: "Also delete DB session records for pruned sessions" }),
    purgeAll: flag({ long: "purge-all", description: "Equivalent to --purge-logs --purge-db" }),
  },
  handler: async ({ age, project, confirm, force, purgeLogs: purgeLogsFlag, purgeDb: purgeDbFlag, purgeAll }) => runCliCommand("prune", async () => {
    const maxAgeMs = parseAge(age ?? "24h");
    if (maxAgeMs < MIN_PRUNE_AGE_MS && !force) {
      console.error("error: minimum prune age is 1 hour (use --force to override)");
      process.exit(1);
    }

    const projectPath = project ? resolveProject(project) : undefined;
    const purgeLogs = purgeAll || purgeLogsFlag;
    const purgeDb = purgeAll || purgeDbFlag;
    const result = await svc.pruneSessions({
      maxAgeMs,
      ...(projectPath ? { projectPath } : {}),
      ...(confirm ? { confirm: true } : {}),
      ...(purgeLogs ? { purgeLogs: true } : {}),
      ...(purgeDb ? { purgeDb: true } : {}),
    });
    const {
      pruned,
      orphansCleaned,
      dryRun = !confirm,
      logsDeleted = 0,
      dbRecordsDeleted = 0,
    } = result;

    if (dryRun) {
      console.log(`dry run — would prune ${pruned} session(s)`);
      console.log("use --confirm to execute, --purge-logs to also delete logs, --purge-db to also delete DB records");
    } else {
      console.log(`pruned ${pruned} session(s)`);
      if (logsDeleted > 0) {
        console.log(`deleted ${logsDeleted} log/script file(s)`);
      }
      if (dbRecordsDeleted > 0) {
        console.log(`deleted ${dbRecordsDeleted} DB record(s)`);
      }
    }
    if (orphansCleaned > 0) {
      console.log(`cleaned ${orphansCleaned} orphaned worktree(s)`);
    }
  }),
});

const serveCmd = command({
  name: "serve",
  description: "Start daemon WebSocket server for remote access",
  examples: [
    { description: "Start on default port", command: "orka serve" },
    { description: "Register with relay", command: "orka serve --relay ws://relay:7390 --node-id mynode" },
  ],
  args: {
    port: option({ type: optional(str), long: "port", description: "Port to listen on (default: 7394)" }),
    host: option({ type: optional(str), long: "host", description: "Hostname to bind (default: 127.0.0.1)" }),
    relay: option({ type: optional(str), long: "relay", description: "Relay URL to register with (e.g. ws://relay:7390)" }),
    nodeId: option({ type: optional(str), long: "node-id", description: "Node ID for relay registration" }),
    relayToken: option({ type: optional(str), long: "relay-token", description: "Auth token for relay connection" }),
  },
  handler: async (args) => {
    // serve is the daemon itself — uses LocalClient directly, no getSvc()
    await withSpan("orka.cli.serve", { "orka.command": "serve" }, async () => {
      const port = parseInt(args.port ?? "7394", 10);
      const hostname = args.host ?? "127.0.0.1";
      const localSvc = createLocalClient();
      const relayToken = args.relayToken ?? process.env["ORKA_TOKEN"];
      const serverOptions = {
        port,
        hostname,
        ...(args.relay ? { relayUrl: args.relay } : {}),
        ...(args.nodeId ? { nodeId: args.nodeId } : {}),
        ...(relayToken ? { relayToken } : {}),
        ...(useEncrypt ? { encrypt: true } : {}),
      };
      const server = await startServer(localSvc, serverOptions);
      console.log(`orka daemon listening on ws://${hostname}:${server.port}`);
      if (args.relay) {
        console.log(`  relay: ${args.relay}`);
      }

      await new Promise(() => {});
    });
  },
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
  description: "Start relay WebSocket router for multi-machine setups",
  args: {
    port: option({ type: optional(str), long: "port", description: "Port to listen on (default: 7390)" }),
    token: option({ type: optional(str), long: "token", description: "Auth token for connections" }),
  },
  handler: async ({ port, token }) => runCliCommand("relay", async () => {
    const parsedPort = parseInt(port ?? "7390", 10);
    const relayToken = token ?? process.env["ORKA_TOKEN"];
    const handle = startRelay({
      port: parsedPort,
      ...(relayToken ? { token: relayToken } : {}),
    });
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
  description: "Sign up for a relay account (saves API key automatically)",
  args: {
    email: option({ type: optional(str), long: "email", description: "Account email address" }),
    name: option({ type: optional(str), long: "name", description: "Account display name" }),
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
  description: "Create an API key for relay access",
  args: {
    label: option({ type: optional(str), long: "label", description: "Human-readable label for the key" }),
    permissions: option({ type: optional(str), long: "permissions", description: "Permission level (client or node)" }),
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
  description: "Show relay usage statistics (requests, bytes)",
  args: {
    from: option({ type: optional(str), long: "from", description: "Start date (ISO 8601)" }),
    to: option({ type: optional(str), long: "to", description: "End date (ISO 8601)" }),
    granularity: option({ type: optional(str), long: "granularity", description: "Bucket size: hour, day, month (default: hour)" }),
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
  description: "Agent session orchestrator — spawn, monitor, and manage AI coding agents",
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
    usage: usageCmd,
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
  console.log("usage: orka <command> [options]");
  console.log("");
  console.log("session lifecycle:");
  console.log("  spawn    Spawn an agent session           orka spawn -m background fix the bug");
  console.log("  ps       List sessions                    orka ps --status running -v");
  console.log("  attach   Stream live session output        orka attach <id>");
  console.log("  logs     View session output              orka logs -f <id>");
  console.log("  stop     Stop a running session           orka stop <id>");
  console.log("  wait     Block until sessions complete    orka wait --all");
  console.log("  result   Show result, cost, tokens        orka result --json <id>");
  console.log("  usage    Show aggregate usage totals      orka usage --since 24h");
  console.log("  retry    Re-run with same prompt          orka retry <id>");
  console.log("  send     Send input to session            orka send <id> hello");
  console.log("");
  console.log("worktree management:");
  console.log("  diff     Show git changes in worktree     orka diff <id>");
  console.log("  show     Full session detail view         orka show <id>");
  console.log("  workdir  Print working directory           cd $(orka workdir <id>)");
  console.log("  merge    Merge worktree into current      orka merge <id>");
  console.log("  keep     Protect worktree from cleanup    orka keep <id>");
  console.log("  unkeep   Remove worktree protection       orka unkeep <id>");
  console.log("  prune    Remove old sessions              orka prune --age 7d --confirm");
  console.log("");
  console.log("infrastructure:");
  console.log("  project  Register/list/remove aliases     orka project add myapp /path/to/repo");
  console.log("  serve    Start daemon WS server           orka serve --port 7394");
  console.log("  relay    Relay router / account mgmt      orka relay --port 7390");
  console.log("  keygen   Manage E2E encryption keys       orka keygen client");
  console.log("");
  console.log("enum values:");
  console.log(`  --status   ${statusValues.join(", ")}`);
  console.log(`  --backend  ${backendValues.join(", ")}`);
  console.log(`  --mode     ${modeValues.join(", ")}`);
  console.log("");
  console.log("global options:");
  console.log("  --remote <url>    Connect to remote daemon (ws://host:7394)");
  console.log("  --token <tok>     Auth token for relay/daemon");
  console.log("  --encrypt         Enable E2E encryption");
  console.log("  --server-key <k>  Server public key for E2E");
  console.log("");
  console.log("env vars: ORKA_REMOTE, ORKA_TOKEN, ORKA_API_KEY, ORKA_ENCRYPT, ORKA_SERVER_KEY");
  console.log("");
  console.log("run orka <command> --help for detailed options");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number | null): string {
  if (usd == null) return "n/a";
  return `$${usd.toFixed(2)}`;
}

// --- Relay API helpers ---

function getRelayHttpUrl(): string {
  let base = remoteUrl ?? process.env["ORKA_RELAY_URL"];
  if (!base) {
    console.error("error: relay URL required (use --remote <url> or ORKA_RELAY_URL)");
    process.exit(1);
    throw new Error("relay URL required");
  }
  const normalizedBase = base.split("?")[0] ?? base;
  return normalizedBase.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
}

function getApiKey(): string | null {
  if (process.env["ORKA_API_KEY"]) return process.env["ORKA_API_KEY"];
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

function parseAge(age: string): number {
  const match = age.match(/^(\d+)\s*(h|d|m)$/);
  if (!match) {
    console.error("error: invalid --age format, use e.g. 24h, 7d, 30m");
    process.exit(1);
    throw new Error("invalid age format");
  }
  const amount = match[1];
  const unit = match[2];
  if (!amount || !unit) {
    console.error("error: invalid --age format, use e.g. 24h, 7d, 30m");
    process.exit(1);
    throw new Error("invalid age format");
  }
  const value = parseInt(amount, 10);
  switch (unit) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return value * 60 * 60 * 1000;
  }
}

function parseSinceFilter(value: string): string {
  if (/^\d+\s*(h|d|m)$/.test(value)) {
    return new Date(Date.now() - parseAge(value)).toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.error("error: invalid --since format, use e.g. 24h, 7d, 30m, or ISO 8601");
    process.exit(1);
  }
  return parsed.toISOString();
}

function sinceLabel(value: string): string {
  return /^\d+\s*(h|d|m)$/.test(value) ? `last ${value}` : `since ${value}`;
}

// --- Helpers ---

async function findSession(query: string) {
  const exact = await svc.getSession(query);
  if (exact) return exact;

  const all = await svc.listSessions();
  const matches = all.filter((s) => s.id.includes(query));
  if (matches.length === 1) return matches[0] ?? null;
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
