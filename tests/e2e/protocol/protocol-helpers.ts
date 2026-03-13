/**
 * Shared helpers for protocol-level E2E tests.
 *
 * Provides in-process daemon startup with Noise encryption,
 * handshake helpers, and encrypted/plain RPC utilities.
 *
 * IMPORTANT: callers must set process.env.ORKA_HOME to an isolated
 * temp directory BEFORE importing this module (and before any daemon
 * module is loaded).
 */

import type { OrkaService } from "@orka/core";
import type { NoiseKeyInfo } from "../../../packages/core/src/crypto";
import {
  NoiseClientTransport,
  computeKeyId,
} from "../../../packages/core/src/transport/noise-transport";
import type { DataFrame } from "@orka/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaemonWithNoise = DaemonHandle;
export interface DaemonHandle {
  server: { port: number; stop(closeActiveConnections?: boolean): void };
  svc: OrkaService;
  noiseKeyInfo: NoiseKeyInfo;
  nodeId: string;
  wsUrl: string;
  httpUrl: string;
  stop(): void;
}

export interface SecureConnection {
  ws: WebSocket;
  transport: NoiseClientTransport;
}

// Re-export for test convenience
export { NoiseClientTransport, computeKeyId };

// ---------------------------------------------------------------------------
// startDaemonWithNoise
// ---------------------------------------------------------------------------

/**
 * Start an in-process daemon with Noise encryption enabled on an ephemeral port.
 *
 * The caller MUST have already set `process.env.ORKA_HOME` to an isolated temp
 * directory before calling this (and before any daemon module import).
 */
export async function startDaemonWithNoise(opts?: {
  nodeId?: string;
}): Promise<DaemonHandle> {
  // Dynamic import so ORKA_HOME is already in the env when daemon modules load.
  const { createLocalClient, startServer } = await import("@orka/daemon");
  const { ensureNoiseKeyPair } = await import(
    "../../../packages/core/src/crypto"
  );
  const { getOrkaHome } = await import("@orka/daemon");

  const nodeId = opts?.nodeId ?? "test-node";
  const svc = createLocalClient();

  const noiseKeyInfo = ensureNoiseKeyPair(getOrkaHome(), "node");

  const server = await startServer(svc, {
    port: 0,
    hostname: "127.0.0.1",
    nodeId,
    encrypt: true,
  });

  const port = server.port;
  return {
    server,
    svc,
    noiseKeyInfo,
    nodeId,
    wsUrl: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    stop() {
      try {
        server.stop(true);
      } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

export function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs);
    timer.unref?.();
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
}

/** Wait for the next message matching a predicate (with timeout). */
export function waitForMessage(
  ws: WebSocket,
  predicate: (data: unknown) => boolean,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("waitForMessage timeout"));
    }, timeoutMs);
    timer.unref?.();
    const handler = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data));
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(parsed);
        }
      } catch {}
    };
    ws.addEventListener("message", handler);
  });
}

// ---------------------------------------------------------------------------
// performNoiseHandshake
// ---------------------------------------------------------------------------

/**
 * Drive a full Noise NK handshake against a running daemon.
 * Returns an open WebSocket and the client transport in SECURE state.
 *
 * After the handshake completes, this function drains the encrypted welcome
 * push message the server sends. This keeps the recv cipher nonce in sync.
 */
export async function performNoiseHandshake(
  wsUrl: string,
  noiseKeyInfo: NoiseKeyInfo,
  nodeId: string,
): Promise<SecureConnection> {
  const transport = new NoiseClientTransport({
    nodeId,
    expectedKeyId: computeKeyId(noiseKeyInfo.publicKey),
    remoteStaticPubkey: noiseKeyInfo.publicKey,
    relayOrigin: "",
  });

  const ws = new WebSocket(wsUrl);
  await waitForOpen(ws);

  // Collect all messages in a queue so none are lost between handler
  // registrations. We process them sequentially after the handshake.
  const messageQueue: unknown[] = [];
  const queueHandler = (event: MessageEvent) => {
    try {
      messageQueue.push(JSON.parse(String(event.data)));
    } catch {}
  };
  ws.addEventListener("message", queueHandler);

  // Send client_hello
  const clientHello = transport.getClientHello();
  ws.send(JSON.stringify(clientHello));

  // Wait for server_hello from the queue
  const serverHello = await waitForQueued(messageQueue, (m: any) => m?.t === "server_hello");

  // processMessage returns noise_1 messages to send
  const noise1Msgs = transport.processMessage(serverHello);
  for (const msg of noise1Msgs) {
    ws.send(JSON.stringify(msg));
  }

  // Wait for noise_2 from the queue
  const noise2 = await waitForQueued(messageQueue, (m: any) => m?.t === "noise_2");

  // Process noise_2 — should transition to SECURE
  transport.processMessage(noise2);

  if (!transport.isSecure) {
    ws.removeEventListener("message", queueHandler);
    throw new Error("Handshake did not reach SECURE state");
  }

  // After handshake, wait a bit for the encrypted welcome push to arrive,
  // then consume all queued data frames to keep the nonce in sync.
  await Bun.sleep(300);

  // Drain any data frames from the queue (encrypted welcome push, etc.)
  for (const msg of messageQueue) {
    const m = msg as Record<string, unknown>;
    if (m?.t === "data" && typeof m.ct === "string") {
      try {
        transport.decryptData(m as DataFrame);
      } catch {
        // Ignore decrypt errors during drain
      }
    }
  }
  messageQueue.length = 0;

  // Remove the queue handler — callers will register their own
  ws.removeEventListener("message", queueHandler);

  return { ws, transport };
}

/**
 * Wait for a message matching a predicate to appear in the queue.
 * Removes matched messages and earlier non-matching messages from the queue.
 */
function waitForQueued(
  queue: unknown[],
  predicate: (data: unknown) => boolean,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("waitForQueued timeout"));
    }, timeoutMs);
    timer.unref?.();

    const poll = setInterval(() => {
      for (let i = 0; i < queue.length; i++) {
        if (predicate(queue[i])) {
          clearTimeout(timer);
          clearInterval(poll);
          const matched = queue[i];
          // Remove this and all earlier messages from queue
          queue.splice(0, i + 1);
          resolve(matched);
          return;
        }
      }
    }, 10);
    poll.unref?.();
  });
}

// ---------------------------------------------------------------------------
// drainEncryptedMessages
// ---------------------------------------------------------------------------

/**
 * Drain any pending encrypted messages (e.g. encrypted welcome push) from a
 * WebSocket with an active Noise transport. This ensures the recv cipher nonce
 * stays in sync with the server's send cipher nonce.
 */
export function drainEncryptedMessages(
  ws: WebSocket,
  transport: NoiseClientTransport,
  waitMs = 500,
): Promise<void> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data));
        if (parsed?.t === "data" && typeof parsed.ct === "string") {
          transport.decryptData(parsed as DataFrame);
        }
      } catch {
        // Ignore non-decryptable frames
      }
    };
    ws.addEventListener("message", handler);
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve();
    }, waitMs);
    timer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/**
 * Send an encrypted JSON-RPC request and wait for the encrypted response.
 */
export function encryptedRpc(
  transport: NoiseClientTransport,
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const reqId = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rpc = { jsonrpc: "2.0", id: reqId, method, params };
  const frame = transport.encryptRpc(rpc);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`encryptedRpc ${method} timeout`));
    }, timeoutMs);
    timer.unref?.();

    const handler = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data));
        // Skip non-data frames (e.g. cleartext welcome)
        if (!parsed || parsed.t !== "data" || typeof parsed.ct !== "string") return;
        const decrypted = transport.decryptData(parsed as DataFrame);
        if (decrypted.id === reqId) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(decrypted);
        }
      } catch {
        // Ignore frames we can't decrypt (e.g. push messages)
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(frame));
  });
}

/**
 * Send a plain (unencrypted) JSON-RPC request and wait for the response.
 */
export function plainRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const reqId = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`plainRpc ${method} timeout`));
    }, timeoutMs);
    timer.unref?.();

    const handler = (event: MessageEvent) => {
      try {
        const resp = JSON.parse(String(event.data));
        if (resp.id === reqId) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(resp);
        }
      } catch {}
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }));
  });
}
