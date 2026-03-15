#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BackendKind, SessionMode, OrkaService, ReasoningEffort, SpawnRequest } from "@orka/core";
import { isMethodNotFound, canonicalTransportOrigin } from "@orka/core";
import {
  ensureNoiseKeyPair,
  loadNoiseKeyPair,
  loadNoisePublicKey,
  saveNoiseServerPublicKey,
} from "@orka/core/crypto";
import { createOrkaClient, lookupKnownHost, saveKnownHost } from "@orka/client";
import { startRelay } from "@orka/relay";
import {
  createLocalClient,
  createDaemonContext,
  startServer,
  loadConfig,
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
  type PairingConfig,
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

const statusValues = ["running", "completed", "failed", "cancelled", "interrupted", "queued", "preparing"] as const;
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

// Accept new key flag — allows connecting when a known host's key has changed
const acceptNewKeyIdx = process.argv.indexOf("--accept-new-key");
const acceptNewKey = acceptNewKeyIdx !== -1;
if (acceptNewKeyIdx !== -1) {
  process.argv.splice(acceptNewKeyIdx, 1);
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

async function stopDaemon(): Promise<boolean> {
  const pidPath = join(getOrkaHome(), "daemon.pid");
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }
  }
  // Wait for daemon to stop (up to 3s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await isDaemonRunning())) return true;
  }
  return false;
}

/**
 * Node config as saved by `orka node add` in ~/.orka/nodes/<node_id>.json.
 */
interface PairedNodeConfig {
  node_id: string;
  node_name?: string;
  noise_static_pubkey: string;   // base64url
  noise_key_id: string;          // "sha256:..."
  node_paths: string[];          // e.g. ["ws://host:7394"]
  trust?: { mode?: string; paired_at?: string; pairing_export?: string };
}

/**
 * Search ~/.orka/nodes/ for a paired node config whose node_paths include a
 * URL matching the given target URL (compared via canonicalTransportOrigin).
 * Returns the first match, or null if none found.
 */
function findPairedNodeConfig(targetUrl: string): PairedNodeConfig | null {
  const orkaHome = getOrkaHome();
  const nodesDir = join(orkaHome, "nodes");
  if (!existsSync(nodesDir)) return null;

  const canonicalTarget = canonicalTransportOrigin(targetUrl);
  if (!canonicalTarget) return null;

  let files: string[];
  try {
    files = Array.from(new Bun.Glob("*.json").scanSync(nodesDir));
  } catch {
    return null;
  }

  for (const file of files) {
    try {
      const content = JSON.parse(readFileSync(join(nodesDir, file), "utf-8")) as PairedNodeConfig;
      if (!content.noise_static_pubkey || !content.node_id) continue;
      const paths: string[] = content.node_paths ?? [];
      for (const p of paths) {
        if (canonicalTransportOrigin(p) === canonicalTarget) {
          return content;
        }
      }
    } catch {
      // Skip invalid config files
    }
  }
  return null;
}

// --- Dashboard lifecycle ---

const DEFAULT_DASHBOARD_PORT = 3773;
const DEFAULT_DASHBOARD_HEALTH = `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/`;

function getDashboardDir(): string {
  // CLI entry: packages/cli/src/index.ts → repo root is ../../..
  const cliDir = join(new URL(import.meta.url).pathname, "..");
  return join(cliDir, "..", "..", "dashboard");
}

async function isDashboardRunning(): Promise<boolean> {
  try {
    const resp = await fetch(DEFAULT_DASHBOARD_HEALTH, { signal: AbortSignal.timeout(500) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function startDashboardBackground(): Promise<void> {
  const dashboardDir = getDashboardDir();
  if (!existsSync(join(dashboardDir, "package.json"))) {
    throw new Error(`Dashboard package not found at ${dashboardDir}`);
  }
  const logsDir = join(getOrkaHome(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, "dashboard.log");
  const pidPath = join(getOrkaHome(), "dashboard.pid");

  const proc = Bun.spawn(
    ["setsid", "bun", "run", "dev"],
    {
      cwd: dashboardDir,
      stdin: "ignore",
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
      env: { ...process.env },
    },
  );
  writeFileSync(pidPath, String(proc.pid));
  proc.unref();

  // Wait for dashboard to become healthy (up to 10s — vite takes longer)
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isDashboardRunning()) return;
  }
  throw new Error("Failed to start dashboard — timed out waiting for health check. Check " + logPath);
}

async function stopDashboard(): Promise<boolean> {
  const pidPath = join(getOrkaHome(), "dashboard.pid");
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await isDashboardRunning())) return true;
  }
  return false;
}

function deriveHealthUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/health";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return wsUrl.replace(/^ws/, "http").replace(/\/$/, "") + "/health";
  }
}

function hostKeyFromUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    return u.host; // includes port
  } catch {
    return wsUrl;
  }
}

async function fetchServerKeyFromHealth(wsUrl: string): Promise<{ keyId: string; publicKeyB64: string; publicKey: Uint8Array; nodeId: string } | null> {
  try {
    const healthUrl = deriveHealthUrl(wsUrl);
    const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    const body = await resp.json() as Record<string, unknown>;
    if (typeof body["publicKey"] === "string" && typeof body["keyId"] === "string") {
      const publicKeyB64 = body["publicKey"] as string;
      const publicKey = new Uint8Array(Buffer.from(publicKeyB64, "base64url"));
      return {
        keyId: body["keyId"] as string,
        publicKeyB64,
        publicKey,
        nodeId: (body["nodeId"] as string) ?? "",
      };
    }
  } catch { /* server unreachable or no key exposed */ }
  return null;
}

async function buildRemoteClient(url: string): Promise<OrkaService> {
  if (useEncrypt) {
    const orkaHome = getOrkaHome();

    // 1. Try matching a paired node config from ~/.orka/nodes/
    const nodeConfig = findPairedNodeConfig(url);
    if (nodeConfig) {
      const publicKey = new Uint8Array(Buffer.from(nodeConfig.noise_static_pubkey, "base64url"));
      const noiseServerKey = {
        publicKey,
        privateKey: new Uint8Array(0), // public-key-only
        keyId: nodeConfig.noise_key_id,
        publicKeyB64: nodeConfig.noise_static_pubkey,
      };
      return createOrkaClient({
        url,
        noiseServerKey,
        nodeId: nodeConfig.node_id,
        relayOrigin: remoteUrl ?? "",
      });
    }

    // 2. TOFU — check known_hosts for this server
    const host = hostKeyFromUrl(url);
    const knownEntry = lookupKnownHost(orkaHome, host);

    if (knownEntry) {
      // Host is known — verify key hasn't changed by fetching from /health
      console.error(`[tofu] host key verified: ${knownEntry.keyId.slice(0, 16)}`);
      const remoteKey = await fetchServerKeyFromHealth(url);
      if (remoteKey && remoteKey.keyId !== knownEntry.keyId) {
        // Key mismatch!
        if (acceptNewKey) {
          console.error(`Warning: accepting new key for ${host}`);
          console.error(`Old key: ${knownEntry.keyId}`);
          console.error(`New key: ${remoteKey.keyId}`);
          saveKnownHost(orkaHome, host, remoteKey.keyId, remoteKey.publicKey);
          const noiseServerKey = {
            publicKey: remoteKey.publicKey,
            privateKey: new Uint8Array(0),
            keyId: remoteKey.keyId,
            publicKeyB64: remoteKey.publicKeyB64,
          };
          return createOrkaClient({
            url,
            noiseServerKey,
            nodeId: remoteKey.nodeId,
            relayOrigin: remoteUrl ?? "",
          });
        }
        console.error("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");
        console.error("@    WARNING: REMOTE HOST KEY HAS CHANGED!    @");
        console.error("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");
        console.error(`The Noise public key for ${host} has changed.`);
        console.error(`Old key: ${knownEntry.keyId}`);
        console.error(`New key: ${remoteKey.keyId}`);
        console.error("This could indicate a MITM attack or key rotation.");
        console.error("Use --accept-new-key to accept the new key.");
        process.exit(1);
      }

      // Key matches (or server unreachable — trust the pinned key)
      const noiseServerKey = {
        publicKey: knownEntry.publicKey,
        privateKey: new Uint8Array(0),
        keyId: knownEntry.keyId,
        publicKeyB64: knownEntry.publicKeyB64,
      };
      const nodeId = process.env["ORKA_NODE_ID"] ?? "";
      return createOrkaClient({
        url,
        noiseServerKey,
        nodeId,
        relayOrigin: remoteUrl ?? "",
      });
    }

    // 3. Host not in known_hosts — try TOFU (fetch key, trust on first use)
    const remoteKey = await fetchServerKeyFromHealth(url);
    if (remoteKey) {
      saveKnownHost(orkaHome, host, remoteKey.keyId, remoteKey.publicKey);
      console.error(`Trusting new host ${host}`);
      console.error(`Key fingerprint: ${remoteKey.keyId}`);
      console.error(`Key saved to ${join(orkaHome, "known_hosts")}`);
      const noiseServerKey = {
        publicKey: remoteKey.publicKey,
        privateKey: new Uint8Array(0),
        keyId: remoteKey.keyId,
        publicKeyB64: remoteKey.publicKeyB64,
      };
      return createOrkaClient({
        url,
        noiseServerKey,
        nodeId: remoteKey.nodeId,
        relayOrigin: remoteUrl ?? "",
      });
    }

    // 4. Fall back to generic saved server key from ~/.orka/keys/server.noise.pub
    const noiseServerKey = loadNoisePublicKey(orkaHome, "server");
    if (noiseServerKey) {
      const nodeId = process.env["ORKA_NODE_ID"] ?? "";
      return createOrkaClient({
        url,
        noiseServerKey,
        nodeId,
        relayOrigin: remoteUrl ?? "",
      });
    }

    // No Noise key available — fall back to plaintext
    console.error("warning: no Noise server key found, connecting without encryption");
  }
  return createOrkaClient(url);
}

// svc is initialized lazily — all commands go through the daemon via RPC.
// Only `orka serve` uses LocalClient directly (it IS the daemon).
let _svc: OrkaService | null = null;
async function getSvc(): Promise<OrkaService> {
  if (_svc) return _svc;
  if (remoteUrl) {
    _svc = await buildRemoteClient(remoteUrl);
  } else {
    await ensureDaemon();
    _svc = await buildRemoteClient(DEFAULT_DAEMON_URL);
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
  "backfill",
  "usage",
  "send",
  "keep",
  "unkeep",
  "merge",
  "project",
  "traces",
  "archive",
  "unarchive",
  "restart",
  "serve",
  "relay",
  "keygen",
  "node",
  "dashboard",
]);

const PROJECT_SUBCOMMANDS = new Set(["add", "remove", "rm", "list", "ls"]);
const RELAY_SUBCOMMANDS = new Set(["serve", "signup", "keys", "account", "usage"]);
const RELAY_KEYS_SUBCOMMANDS = new Set(["create", "revoke", "list"]);
const KEYGEN_SUBCOMMANDS = new Set(["client", "node", "save-server", "show", "help"]);

let svc: OrkaService;

// Commands that don't need the daemon (local-only operations)
const LOCAL_ONLY_COMMANDS = new Set(["serve", "project", "keygen", "relay", "dashboard"]);

async function runCliCommand(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await withSpan(`orka.cli.${name}`, { "orka.command": name }, async () => {
      if (!LOCAL_ONLY_COMMANDS.has(name)) {
        svc = await getSvc();
        if (name !== "wait") {
          await svc.reap();
        }
      }
      await fn();
    });
  } finally {
    if (svc && typeof (svc as any).close === "function") {
      (svc as any).close();
    }
  }
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
    mode: option({ type: optional(enumType(modeValues)), long: "mode", short: "m", description: "Session mode (default: background)" }),
    model: option({ type: optional(str), long: "model", description: "Model for the backend (e.g. sonnet, opus, haiku)" }),
    branch: option({ type: optional(str), long: "branch", description: "Git branch name (creates worktree)" }),
    title: option({ type: optional(str), long: "title", description: "Session title for display in orka ps" }),
    systemPrompt: option({ type: optional(str), long: "system-prompt", description: "Extra instructions prepended to the agent session" }),
    allowedTools: option({ type: optional(str), long: "allowed-tools", description: "Comma-separated Claude Code allowed tools" }),
    env: multioption({ type: array(str), long: "env", description: "Environment variable to pass through (repeatable KEY=VALUE)" }),
    reasoningEffort: option({ type: optional(str), long: "reasoning-effort", description: "Reasoning effort level (low, medium, high)" }),
    autoMerge: flag({ long: "auto-merge", description: "Auto-merge worktree on successful completion" }),
    tag: multioption({ type: array(str), long: "tag", description: "Tag the session (repeatable)" }),
    parent: option({ type: optional(str), long: "parent", description: "Parent session ID (creates child session)" }),
    words: restPositionals({ type: str, displayName: "prompt" }),
  },
  handler: async (args) => runCliCommand("spawn", async () => {
    const cfg = loadConfig(getOrkaHome()).defaults;

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
      ...(args.parent ? { parentSessionId: args.parent } : {}),
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
    children: option({ type: optional(str), long: "children", description: "List only children of a parent session" }),
    archived: flag({ long: "archived", description: "Include archived sessions" }),
    verbose: flag({ long: "verbose", short: "v", description: "Show cost, duration, tokens, and project" }),
  },
  handler: async (args) => runCliCommand("ps", async () => {
    let sessions: Awaited<ReturnType<typeof svc.listSessions>>;
    if (args.children) {
      sessions = await svc.getChildSessions(args.children);
      if (args.status) {
        sessions = sessions.filter((s) => s.status === args.status);
      }
    } else {
      sessions = await svc.listSessions({
        ...(args.status ? { status: args.status } : {}),
        ...(args.tag ? { tag: args.tag } : {}),
        ...(args.archived ? { includeArchived: true } : {}),
      });
    }
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
        case "interrupted": return c("33", status);
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
      if (verbose && s.parentSessionId) {
        console.log(`  parent: ${s.parentSessionId}`);
      }
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
      console.warn(`warning: session ${session.id} is already ${session.status}`);
      return;
    }

    // Check for running children and stop them first
    const children = await svc.getChildSessions(session.id);
    const runningChildren = children.filter((c) => c.status === "running");
    for (const child of runningChildren) {
      await svc.stop(child.id);
      console.log(`stopped child session ${child.id}`);
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
      const result = await svc.getDiff(session.id);
      console.log(result.status);
      if (result.diff) {
        console.log("");
        console.log(result.diff);
      }
      if (result.commitLog) {
        console.log("");
        console.log("\x1b[1mCommits on branch:\x1b[0m");
        console.log(result.commitLog);
      }
      if (result.commitDiff) {
        console.log("");
        console.log("\x1b[1mCommitted changes vs parent:\x1b[0m");
        console.log(result.commitDiff);
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

    const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
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

const backfillCmd = command({
  name: "backfill",
  description: "Re-derive orchestration events from raw provider logs",
  examples: [
    { description: "Backfill a session", command: "orka backfill <session-id>" },
  ],
  args: {
    sessionId: positional({ type: optional(str), displayName: "session-id", description: "Session ID or prefix" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ sessionId }) => runCliCommand("backfill", async () => {
    if (!sessionId) {
      fail("usage: orka backfill <session-id>");
    }

    const session = await findSession(sessionId);
    if (!session) {
      fail(`session not found: ${sessionId}`);
    }

    try {
      const result = await svc.backfillSession(session.id);
      console.log(`backfilled ${result.eventsReplayed} events for session ${session.id}`);
    } catch (err) {
      if (isMethodNotFound(err)) {
        fail("This feature is not supported by the connected daemon. Please upgrade the daemon.");
      }
      throw err;
    }
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
      await svc.sendTurn(session.id, text.join(" "));
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

const tracesCmd = command({
  name: "traces",
  description: "Query and display OpenTelemetry traces from the daemon",
  examples: [
    { description: "Show recent traces", command: "orka traces" },
    { description: "Show errors only", command: "orka traces --errors" },
    { description: "Filter by span name", command: "orka traces --name rpc" },
    { description: "Traces since 1 hour ago", command: "orka traces --since 1h" },
    { description: "Show last 100 traces", command: "orka traces --limit 100" },
  ],
  args: {
    errors: flag({ type: bool, long: "errors", short: "e", description: "Show only error spans" }),
    name: option({ type: optional(str), long: "name", short: "n", description: "Filter by span name (substring match)" }),
    service: option({ type: optional(str), long: "service", short: "s", description: "Filter by service name" }),
    since: option({ type: optional(str), long: "since", description: "Only spans after this (e.g. '1h', '30m', ISO timestamp)" }),
    limit: option({ type: optional(str), long: "limit", short: "l", description: "Max results (default: 30)" }),
    json: flag({ type: bool, long: "json", description: "Output raw JSON" }),
  },
  handler: async (args) => runCliCommand("traces", async () => {
    const limit = parseInt(args.limit ?? "30", 10);
    let since: string | undefined;
    if (args.since) {
      const match = args.since.match(/^(\d+)(m|h|d)$/);
      if (match) {
        const [, num, unit] = match;
        const ms = parseInt(num!, 10) * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
        since = new Date(Date.now() - ms).toISOString();
      } else {
        since = args.since;
      }
    }

    const svc = await getSvc();
    const traces: any[] = await svc.queryTraces({
      errorsOnly: args.errors || undefined,
      namePattern: args.name,
      service: args.service,
      since,
      limit,
    });

    if (traces.length === 0) {
      console.log("no traces found");
      return;
    }

    if (args.json) {
      for (const t of traces) console.log(JSON.stringify(t));
      return;
    }

    const noColor = process.env["NO_COLOR"] === "1";
    const c = (code: string, text: string) => noColor ? text : `\x1b[${code}m${text}\x1b[0m`;

    for (const t of traces) {
      const date = new Date(t.startTime).toLocaleTimeString();
      const dur = `${Math.round(t.durationMs)}ms`;
      const isErr = t.status?.code === 2;
      const statusStr = isErr ? c("31", "ERR") : c("32", "OK ");
      const name = isErr ? c("31", t.name) : t.name;
      const method = t.attributes?.["orka.method"] ? c("36", ` ${t.attributes["orka.method"]}`) : "";
      const errMsg = isErr && t.status?.message ? c("2", ` ${t.status.message}`) : "";

      console.log(`${c("2", date)} ${statusStr} ${c("33", dur.padStart(7))} ${name}${method}${errMsg}`);

      // Show events if error
      if (isErr && t.events?.length) {
        for (const ev of t.events) {
          if (ev.name === "exception") {
            const msg = ev.attributes?.["exception.message"] ?? ev.attributes?.message ?? "";
            if (msg) console.log(`  ${c("2", "└")} ${c("31", String(msg))}`);
          }
        }
      }
    }

    console.log(c("2", `\n${traces.length} span(s)`));
  }),
});

const archiveCmd = command({
  name: "archive",
  description: "Archive completed/failed sessions (hides from ps, preserves data)",
  examples: [
    { description: "Archive a single session", command: "orka archive sess-abc123" },
    { description: "Archive multiple sessions", command: "orka archive sess-abc123 sess-def456" },
  ],
  args: {
    ids: restPositionals({ type: str, displayName: "session-id" }),
  },
  handler: async ({ ids }) => runCliCommand("archive", async () => {
    if (ids.length === 0) {
      console.error("error: provide at least one session ID");
      process.exit(1);
    }
    for (const id of ids) {
      await svc.archiveSession(id);
      console.log(`archived ${id}`);
    }
  }),
});

const unarchiveCmd = command({
  name: "unarchive",
  description: "Restore an archived session back to the session list",
  args: {
    ids: restPositionals({ type: str, displayName: "session-id" }),
  },
  handler: async ({ ids }) => runCliCommand("unarchive", async () => {
    if (ids.length === 0) {
      console.error("error: provide at least one session ID");
      process.exit(1);
    }
    for (const id of ids) {
      await svc.unarchiveSession(id);
      console.log(`unarchived ${id}`);
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

const restartCmd = command({
  name: "restart",
  description: "Restart the daemon process (applies migrations and code changes)",
  args: {},
  handler: async () => {
    const wasRunning = await isDaemonRunning();
    if (wasRunning) {
      process.stdout.write("stopping daemon... ");
      const stopped = await stopDaemon();
      if (!stopped) {
        console.error("failed to stop daemon");
        process.exit(1);
      }
      console.log("done");
    }
    process.stdout.write("starting daemon... ");
    await startDaemonBackground();
    console.log("done");
  },
});

// --- Dashboard commands ---

const dashboardStartCmd = command({
  name: "start",
  description: "Start the dashboard dev server",
  args: {},
  handler: async () => {
    if (await isDashboardRunning()) {
      console.log(`dashboard already running on port ${DEFAULT_DASHBOARD_PORT}`);
      return;
    }
    process.stdout.write("starting dashboard... ");
    await startDashboardBackground();
    console.log(`done (port ${DEFAULT_DASHBOARD_PORT})`);
  },
});

const dashboardStopCmd = command({
  name: "stop",
  description: "Stop the dashboard dev server",
  args: {},
  handler: async () => {
    if (!(await isDashboardRunning())) {
      console.log("dashboard not running");
      return;
    }
    process.stdout.write("stopping dashboard... ");
    const stopped = await stopDashboard();
    if (!stopped) {
      console.error("failed to stop dashboard");
      process.exit(1);
    }
    console.log("done");
  },
});

const dashboardRestartCmd = command({
  name: "restart",
  description: "Restart the dashboard dev server",
  args: {},
  handler: async () => {
    if (await isDashboardRunning()) {
      process.stdout.write("stopping dashboard... ");
      const stopped = await stopDashboard();
      if (!stopped) {
        console.error("failed to stop dashboard");
        process.exit(1);
      }
      console.log("done");
    }
    process.stdout.write("starting dashboard... ");
    await startDashboardBackground();
    console.log(`done (port ${DEFAULT_DASHBOARD_PORT})`);
  },
});

const dashboardStatusCmd = command({
  name: "status",
  description: "Check if the dashboard is running",
  args: {},
  handler: async () => {
    const running = await isDashboardRunning();
    if (running) {
      const pidPath = join(getOrkaHome(), "dashboard.pid");
      const pid = existsSync(pidPath) ? readFileSync(pidPath, "utf-8").trim() : "?";
      console.log(`dashboard running (pid ${pid}, port ${DEFAULT_DASHBOARD_PORT})`);
    } else {
      console.log("dashboard not running");
    }
  },
});

const dashboardCmd = subcommands({
  name: "dashboard",
  description: "Manage the dashboard dev server",
  cmds: {
    start: dashboardStartCmd,
    stop: dashboardStopCmd,
    restart: dashboardRestartCmd,
    status: dashboardStatusCmd,
  },
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
      const nodeId = args.nodeId ?? `${hostname}:${port}`;

      // Build PairingConfig when encryption and relay are both available
      let pairingConfig: PairingConfig | undefined;
      if (useEncrypt && args.relay) {
        const orkaHome = getOrkaHome();
        const noiseKey = ensureNoiseKeyPair(orkaHome, "node");
        pairingConfig = {
          nodeId,
          nodeName: nodeId,
          transportPubkey: noiseKey.publicKey,
          transportKeyId: noiseKey.keyId,
          relayPaths: [`/ws?node=${encodeURIComponent(nodeId)}`],
          relayUrl: args.relay,
        };
      }

      const ctx = createDaemonContext();
      const localSvc = createLocalClient(ctx, pairingConfig);
      const relayToken = args.relayToken ?? process.env["ORKA_TOKEN"];
      const serverOptions = {
        port,
        hostname,
        nodeId,
        ...(args.relay ? { relayUrl: args.relay } : {}),
        ...(relayToken ? { relayToken } : {}),
        ...(useEncrypt ? { encrypt: true } : {}),
      };
      const server = await startServer(ctx, localSvc, serverOptions);
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

const keygenNodeCmd = command({
  name: "node",
  description: "Generate/show node keypair (Noise transport)",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => runCliCommand("keygen", async () => {
    const orkaHome = getOrkaHome();
    const noiseKey = ensureNoiseKeyPair(orkaHome, "node");
    console.log("node keypair (Noise NK):");
    console.log(`  public:  ${noiseKey.publicKeyB64}`);
    console.log(`  key_id:  ${noiseKey.keyId}`);
    console.log(`  stored:  ${orkaHome}/keys/node.noise.pub, ${orkaHome}/keys/node.noise.key`);
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
    // Save as Noise public key (base64url raw 32-byte X25519)
    saveNoiseServerPublicKey(orkaHome, pubkey);
    console.log(`saved server Noise public key to ${keysDir}/server.noise.pub`);
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

    const noiseNode = loadNoiseKeyPair(orkaHome, "node");
    const noiseServer = loadNoisePublicKey(orkaHome, "server");

    console.log("Noise NK transport keys:");
    if (noiseNode) {
      console.log(`  node public key:   ${noiseNode.publicKeyB64}`);
      console.log(`  node key_id:       ${noiseNode.keyId}`);
    } else {
      console.log("  node keypair:      (not generated)");
    }
    if (noiseServer) {
      console.log(`  server public key: ${noiseServer.publicKeyB64}`);
      console.log(`  server key_id:     ${noiseServer.keyId}`);
    } else {
      console.log("  server public key: (not saved)");
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
    console.log("orka keygen — manage E2E encryption keys (Noise NK transport)");
    console.log("");
    console.log("subcommands:");
    console.log("  node           Generate/show node keypair (Noise NK)");
    console.log("  save-server    Save a remote server's public key");
    console.log("  show           Show all stored keys");
    console.log("");
    console.log("usage:");
    console.log("  orka keygen node                    # generate node keys");
    console.log("  orka keygen save-server <pubkey>     # save server's public key");
    console.log("  orka --remote ws://host:7394 --encrypt spawn ...  # use encryption");
    console.log("");
    console.log("The server's public key can be obtained from:");
    console.log("  curl <daemon-url>/health | jq -r .publicKey");
  }),
});

const keygenCmd = subcommands({
  name: "keygen",
  description: "Manage E2E encryption keys",
  cmds: {
    node: keygenNodeCmd,
    "save-server": keygenSaveServerCmd,
    show: keygenShowCmd,
    help: keygenHelpCmd,
  },
});

// --- Node pairing commands ---

const nodePairStartCmd = command({
  name: "start",
  description: "Start a pairing session on this node (generates pairing code for client)",
  args: {
    ttl: option({ type: optional(str), long: "ttl", description: "TTL in seconds (default: 600)" }),
    nodeName: option({ type: optional(str), long: "name", description: "Node display name for the client" }),
  },
  handler: async (args) => runCliCommand("node", async () => {
    const ttlSec = args.ttl ? parseInt(args.ttl, 10) : undefined;
    if (ttlSec !== undefined && (isNaN(ttlSec) || ttlSec <= 0)) {
      fail("error: --ttl must be a positive integer (seconds)");
    }

    let result;
    try {
      result = await svc.startPairing({
        ...(ttlSec !== undefined ? { ttlSec } : {}),
        ...(args.nodeName ? { nodeName: args.nodeName } : {}),
      });
    } catch (e: any) {
      if (isMethodNotFound(e)) {
        fail("error: pairing not supported by this daemon (upgrade daemon or configure pairing)");
      }
      fail(`error: ${e.message}`);
    }

    const expiresIn = Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000));
    console.log("pairing code generated");
    console.log("");
    console.log(`  code:       ${result.pairingCode}`);
    console.log(`  enroll id:  ${result.enrollId}`);
    console.log(`  expires in: ${expiresIn}s`);
    console.log("");
    console.log("give this code to the client operator:");
    console.log(`  orka node add ${result.pairingCode}`);
  }),
});

const nodePairCmd = subcommands({
  name: "pair",
  description: "Pairing management",
  cmds: {
    start: nodePairStartCmd,
  },
});

const nodeAddCmd = command({
  name: "add",
  description: "Pair with a remote node using a pairing code",
  args: {
    code: positional({ type: optional(str), displayName: "pairing-code", description: "Pairing code from the node operator (e.g. XXXX-XXXX-XXXX-XXXX-XXXXX)" }),
    relay: option({ type: optional(str), long: "relay", description: "Relay URL to connect through (default: from --remote or ORKA_REMOTE)" }),
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async ({ code, relay }) => {
    // node add is a local command — it connects directly to the relay WebSocket, not via daemon RPC
    try {
      await withSpan("orka.cli.node.add", { "orka.command": "node.add" }, async () => {
        if (!code) {
          fail("usage: orka node add <pairing-code>");
        }

        // Import pairing modules (lazy to avoid loading crypto unless needed)
        const { parsePairingCode, blake3Truncated, concatBytes } = await import("@orka/core/crypto/protocol");
        const { PairingClient } = await import("@orka/core/pairing");

        // Parse and validate the pairing code
        let parsed;
        try {
          parsed = parsePairingCode(code);
        } catch (e: any) {
          fail(`error: invalid pairing code: ${e.message}`);
        }

        // Derive enroll_id from the secret
        const encoder = new TextEncoder();
        const prefix = encoder.encode("orka/pair/v1/enroll-id");
        const input = concatBytes(prefix, parsed.secret);
        const enrollIdBytes = blake3Truncated(input, 8);
        const enrollId = Buffer.from(enrollIdBytes).toString("hex");

        // Determine relay URL
        const relayUrl = relay ?? remoteUrl ?? process.env["ORKA_REMOTE"];
        if (!relayUrl) {
          fail("error: relay URL required (use --relay, --remote, or ORKA_REMOTE)");
        }

        // Convert relay URL to base WS URL for pairing
        const relayBase = relayUrl.split("?")[0]?.replace(/\/ws\/?$/, "") ?? relayUrl;
        const pairUrl = `${relayBase}/v1/pair/${enrollId}`;

        console.log(`connecting to relay for pairing...`);
        console.log(`  enroll id: ${enrollId}`);

        // Open WebSocket to relay pairing endpoint
        // We keep the pairing WS open so we can send pair_done after verification
        const { result, pairingWs } = await new Promise<{
          result: {
            nodeId: string;
            nodeName: string;
            noiseStaticPubkey: Uint8Array;
            noiseKeyId: string;
            nodePaths: string[];
            bootExport: Uint8Array;
          };
          pairingWs: WebSocket;
        }>((resolve, reject) => {
          const ws = new WebSocket(pairUrl);
          let client: InstanceType<typeof PairingClient>;

          ws.onopen = () => {
            client = new PairingClient({
              secret: parsed.secret,
              relayOrigin: relayBase,
              onSend: (msg) => ws.send(JSON.stringify(msg)),
            });
            client.start();
          };

          ws.onmessage = async (event) => {
            const data = typeof event.data === "string" ? event.data : "";
            try {
              const result = await client.handleMessage(data);
              if (result) {
                // Do NOT send pair_done yet — verify node identity first
                resolve({ result, pairingWs: ws });
              }
            } catch (e: any) {
              ws.close();
              reject(e);
            }
          };

          ws.onerror = () => {
            reject(new Error(`WebSocket connection to relay failed: ${pairUrl}`));
          };

          ws.onclose = () => {
            if (client && !client.completed) {
              client.handleClose();
              reject(client.error ?? new Error("Connection closed before pairing completed"));
            }
          };

          // Timeout
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error("Pairing timed out (120s)"));
          }, 120_000);
          timer.unref();
        });

        // Verify node identity via Noise NK handshake before trusting the key
        console.log("verifying node identity...");

        const { NoiseClientTransport, computeKeyId } = await import("@orka/core/transport/noise-transport");

        const verifyNodePath = result.nodePaths[0];
        if (!verifyNodePath) {
          pairingWs.close();
          fail("error: no node paths in bootstrap data — cannot verify node identity");
        }

        const expectedKeyId = result.noiseKeyId || computeKeyId(result.noiseStaticPubkey);

        try {
          await withSpan("orka.cli.node.verify_identity", {
            "orka.node_id": result.nodeId,
            "orka.node_path": verifyNodePath,
          }, async () => {
            await new Promise<void>((resolve, reject) => {
              const verifyWs = new WebSocket(verifyNodePath);

              const transport = new NoiseClientTransport({
                nodeId: result.nodeId,
                expectedKeyId,
                remoteStaticPubkey: result.noiseStaticPubkey,
                relayOrigin: "",
              });

              const timeout = setTimeout(() => {
                verifyWs.close();
                reject(new Error("Node identity verification timed out (10s)"));
              }, 10_000);
              timeout.unref();

              verifyWs.onopen = () => {
                const clientHello = transport.getClientHello();
                verifyWs.send(JSON.stringify(clientHello));
              };

              verifyWs.onmessage = (event) => {
                const raw = typeof event.data === "string" ? event.data : "";
                let parsed: unknown;
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  return;
                }

                const msg = parsed as Record<string, unknown>;
                if (!msg || typeof msg["t"] !== "string") {
                  return;
                }

                try {
                  const responses = transport.processMessage(parsed);
                  for (const resp of responses) {
                    verifyWs.send(JSON.stringify(resp));
                  }

                  if (transport.isSecure) {
                    clearTimeout(timeout);
                    verifyWs.close();
                    resolve();
                  }
                } catch (err) {
                  clearTimeout(timeout);
                  verifyWs.close();
                  reject(err instanceof Error ? err : new Error(String(err)));
                }
              };

              verifyWs.onerror = () => {
                clearTimeout(timeout);
                reject(new Error(`Failed to connect to node at ${verifyNodePath}`));
              };

              verifyWs.onclose = () => {
                if (!transport.isSecure) {
                  clearTimeout(timeout);
                  reject(new Error("Connection closed before identity verification completed"));
                }
              };
            });
          });
        } catch (err: any) {
          // Verification failed — do NOT save trust, do NOT send pair_done
          pairingWs.close();
          fail(`error: node identity verification failed: ${err.message}\nThe node could not prove ownership of the claimed key. Trust was NOT saved.`);
        }

        // Verification succeeded — send pair_done and close pairing WS
        console.log("node identity verified");
        pairingWs.send(JSON.stringify({ t: "pair_done" }));
        pairingWs.close();

        // Save the node config to ~/.orka/nodes/<node_id>.json
        const orkaHome = getOrkaHome();
        const nodesDir = join(orkaHome, "nodes");
        mkdirSync(nodesDir, { recursive: true });

        const nodeConfig = {
          node_id: result.nodeId,
          node_name: result.nodeName,
          noise_static_pubkey: Buffer.from(result.noiseStaticPubkey).toString("base64url"),
          noise_key_id: result.noiseKeyId,
          node_paths: result.nodePaths,
          trust: {
            mode: "paired",
            paired_at: new Date().toISOString(),
            pairing_export: Buffer.from(result.bootExport).toString("base64url"),
          },
        };

        const configPath = join(nodesDir, `${result.nodeId}.json`);
        writeFileSync(configPath, JSON.stringify(nodeConfig, null, 2) + "\n", { mode: 0o600 });

        console.log("");
        console.log("pairing successful!");
        console.log(`  node id:   ${result.nodeId}`);
        console.log(`  node name: ${result.nodeName}`);
        console.log(`  key id:    ${result.noiseKeyId}`);
        console.log(`  saved to:  ${configPath}`);
      });
    } finally {
      // No svc to close for local-only commands
    }
  },
});

const nodeListCmd = command({
  name: "list",
  description: "List paired nodes",
  args: {
    rest: restPositionals({ type: str, displayName: "args" }),
  },
  handler: async () => {
    try {
      await withSpan("orka.cli.node.list", { "orka.command": "node.list" }, async () => {
        const orkaHome = getOrkaHome();
        const nodesDir = join(orkaHome, "nodes");

        if (!existsSync(nodesDir)) {
          console.log("no paired nodes");
          console.log("");
          console.log("pair with: orka node add <pairing-code>");
          return;
        }

        const files = await Array.fromAsync(new Bun.Glob("*.json").scan(nodesDir));
        if (files.length === 0) {
          console.log("no paired nodes");
          console.log("");
          console.log("pair with: orka node add <pairing-code>");
          return;
        }

        console.log(padR("NODE ID", 24) + padR("NAME", 30) + padR("PAIRED AT", 24) + "PATHS");
        console.log("-".repeat(100));

        for (const file of files.sort()) {
          try {
            const content = JSON.parse(readFileSync(join(nodesDir, file), "utf-8"));
            const pairedAt = content.trust?.paired_at ? new Date(content.trust.paired_at).toISOString().slice(0, 19) : "unknown";
            const paths = (content.node_paths ?? []).join(", ");
            console.log(
              padR(content.node_id ?? file, 24) +
              padR(content.node_name ?? "-", 30) +
              padR(pairedAt, 24) +
              paths
            );
          } catch {
            console.log(padR(file, 24) + "(invalid config)");
          }
        }
      });
    } finally {
      // No svc to close
    }
  },
});

const nodeCmd = subcommands({
  name: "node",
  description: "Manage node pairing and connections",
  cmds: {
    pair: nodePairCmd,
    add: nodeAddCmd,
    list: nodeListCmd,
  },
});

const NODE_SUBCOMMANDS = new Set(["pair", "add", "list"]);
const NODE_PAIR_SUBCOMMANDS = new Set(["start"]);
const DASHBOARD_SUBCOMMANDS = new Set(["start", "stop", "restart", "status"]);

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
    backfill: backfillCmd,
    usage: usageCmd,
    send: sendCmd,
    keep: keepCmd,
    unkeep: unkeepCmd,
    merge: mergeCmd,
    project: projectCmd,
    traces: tracesCmd,
    archive: archiveCmd,
    unarchive: unarchiveCmd,
    restart: restartCmd,
    serve: serveCmd,
    relay: relayCmd,
    keygen: keygenCmd,
    node: nodeCmd,
    dashboard: dashboardCmd,
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

  if (top === "dashboard") {
    const sub = normalized[1];
    if (!sub || !DASHBOARD_SUBCOMMANDS.has(sub)) {
      normalized.splice(1, 0, "status");
    }
  }

  if (top === "node") {
    const sub = normalized[1];
    if (!sub || !NODE_SUBCOMMANDS.has(sub)) {
      console.error("usage: orka node <pair|add|list>");
      console.error("  pair start [--ttl N] [--name S]   Start pairing on this node");
      console.error("  add <pairing-code>                Pair with a remote node");
      console.error("  list                              List paired nodes");
      process.exit(1);
    }
    if (sub === "pair") {
      const pairSub = normalized[2];
      if (!pairSub || !NODE_PAIR_SUBCOMMANDS.has(pairSub)) {
        console.error("usage: orka node pair start [--ttl N] [--name S]");
        process.exit(1);
      }
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
  console.log("  archive  Hide sessions from list          orka archive <id> [<id>...]");
  console.log("  unarchive Restore archived sessions       orka unarchive <id>");
  console.log("");
  console.log("infrastructure:");
  console.log("  project  Register/list/remove aliases     orka project add myapp /path/to/repo");
  console.log("  serve    Start daemon WS server           orka serve --port 7394");
  console.log("  relay    Relay router / account mgmt      orka relay --port 7390");
  console.log("  keygen   Manage E2E encryption keys       orka keygen client");
  console.log("  node     Manage node pairing              orka node add <code>");
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
