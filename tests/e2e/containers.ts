/**
 * Testcontainers helpers for E2E tests.
 *
 * Provides startRelayContainer() and startDaemonContainer() that build
 * from the project Dockerfiles, expose ephemeral ports, and return
 * connection URLs + cleanup functions.
 */

import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

/** Build a Docker image (always rebuilds to pick up source changes, fast with layer cache). */
function ensureImage(tag: string, dockerfile: string): void {
  const build = spawnSync("docker", ["build", "-f", dockerfile, "-t", tag, "."], {
    cwd: PROJECT_ROOT,
    stdio: "pipe",
  });
  const code = build.status ?? 0;
  if (code !== 0) {
    const stderr = build.stderr ? Buffer.from(build.stderr).toString() : "";
    throw new Error(`Failed to build ${tag}: ${stderr}`);
  }
}

export interface RelayContainer {
  container: StartedTestContainer;
  /** WebSocket URL, e.g. ws://localhost:55123 */
  wsUrl: string;
  /** HTTP URL, e.g. http://localhost:55123 */
  httpUrl: string;
  port: number;
  stop: () => Promise<void>;
}

export interface DaemonContainer {
  container: StartedTestContainer;
  httpUrl: string;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Start a relay container with ephemeral port mapping.
 * Optionally pass env overrides (e.g. admin token, signup toggle).
 */
export async function startRelayContainer(opts?: {
  env?: Record<string, string>;
}): Promise<RelayContainer> {
  // Build image via docker CLI (fast with layer cache, avoids testcontainers rebuild overhead)
  ensureImage("orka-relay-test", "Dockerfile.relay");

  let started = await new GenericContainer("orka-relay-test")
    .withExposedPorts(7390)
    .withEnvironment({
      ORKA_RELAY_DATA: "/data",
      ...opts?.env,
    })
    .withWaitStrategy(Wait.forLogMessage("orka relay listening"))
    .start();

  const port = started.getMappedPort(7390);
  const host = started.getHost();

  return {
    container: started,
    wsUrl: `ws://${host}:${port}`,
    httpUrl: `http://${host}:${port}`,
    port,
    stop: async () => {
      await started.stop();
    },
  };
}

/**
 * Start a daemon container connected to a relay.
 */
export async function startDaemonContainer(opts: {
  relayWsUrl: string;
  nodeId?: string;
  env?: Record<string, string>;
}): Promise<DaemonContainer> {
  ensureImage("orka-daemon-test", "Dockerfile.daemon");

  const nodeId = opts.nodeId ?? "test-node";

  let started = await new GenericContainer("orka-daemon-test")
    .withExposedPorts(7394)
    .withEnvironment({
      ORKA_HOME: "/data",
      ...opts.env,
    })
    .withCommand([
      "--port", "7394",
      "--host", "0.0.0.0",
      "--relay", opts.relayWsUrl,
      "--node-id", nodeId,
    ])
    .start();

  const port = started.getMappedPort(7394);
  const host = started.getHost();

  return {
    container: started,
    httpUrl: `http://${host}:${port}`,
    port,
    stop: async () => {
      await started.stop();
    },
  };
}

/**
 * Helper: signup to relay and get API key.
 */
export async function relaySignup(
  httpUrl: string,
  email: string,
  name: string,
): Promise<{ accountId: string; apiKey: string }> {
  const res = await fetch(`${httpUrl}/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Signup failed (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * Helper: connect to relay as WebSocket client.
 */
export function connectClient(wsUrl: string, apiKey: string): WebSocket {
  return new WebSocket(`${wsUrl}?token=${apiKey}&role=client`);
}

/**
 * Helper: wait for a WebSocket to open.
 */
export function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
}

/**
 * Helper: send a JSON message and wait for a response.
 */
export function sendAndReceive(
  ws: WebSocket,
  message: Record<string, any>,
  timeoutMs = 10000,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Response timeout")), timeoutMs);
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(String(event.data)));
      } catch {
        reject(new Error(`Invalid JSON response: ${event.data}`));
      }
    }, { once: true });
    ws.send(JSON.stringify(message));
  });
}
