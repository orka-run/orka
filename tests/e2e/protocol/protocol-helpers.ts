/**
 * Shared helpers for E2E protocol tests.
 *
 * Provides functions to start an in-process daemon with Noise encryption,
 * perform handshakes, send encrypted/plain RPCs, etc.
 *
 * IMPORTANT: callers must set process.env.ORKA_HOME to an isolated temp dir
 * BEFORE importing this module — daemon modules read ORKA_HOME at import time.
 */

import type { OrkaService } from "@orka/core";
import type { NoiseKeyInfo } from "../../../packages/core/src/crypto";
import {
  NoiseClientTransport,
  computeKeyId,
} from "../../../packages/core/src/transport/noise-transport";
import { canonicalTransportOrigin } from "@orka/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonWithNoise {
  server: ReturnType<typeof Bun.serve> extends infer S ? S : never;
  svc: OrkaService;
  noiseKeyInfo: NoiseKeyInfo;
  legacyKeyPair: { publicKey: string; privateKey: string };
  nodeId: string;
  port: number;
  wsUrl: string;
  httpUrl: string;
  stop: () => void;
}

// Re-export for convenience
export { NoiseClientTransport, computeKeyId };
export type { NoiseKeyInfo };

// ---------------------------------------------------------------------------
// startDaemonWithNoise
// ---------------------------------------------------------------------------

/**
 * Start an in-process daemon with Noise encryption enabled.
 * Uses the ORKA_HOME already set in process.env (caller must set it before import).
 * Returns handles to the server, service, keys, and a stop() function.
 */
export async function startDaemonWithNoise(opts?: {
  nodeId?: string;
  hostname?: string;
}): Promise<DaemonWithNoise> {
  // Dynamic imports so ORKA_HOME is set before daemon modules initialize
  const { createLocalClient, startServer } = await import("@orka/daemon");
  const { ensureNoiseKeyPair, ensureKeyPair } = await import(
    "../../../packages/core/src/crypto"
  );
  const { getOrkaHome } = await import("@orka/daemon");

  const orkaHome = getOrkaHome();
  const noiseKeyInfo = ensureNoiseKeyPair(orkaHome, "node");
  const legacyKeyPair = ensureKeyPair(orkaHome, "node");
  const nodeId = opts?.nodeId ?? "test-noise-node";
  const hostname = opts?.hostname ?? "127.0.0.1";

  const svc = createLocalClient();
  const server = await startServer(svc, {
    port: 0, // ephemeral
    hostname,
    encrypt: true,
    nodeId,
  });

  const port = server.port;
  const wsUrl = `ws://${hostname}:${port}`;
  const httpUrl = `http://${hostname}:${port}`;

  return {
    server,
    svc,
    noiseKeyInfo,
    legacyKeyPair,
    nodeId,
    port,
    wsUrl,
    httpUrl,
    stop: () => {
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

// ---------------------------------------------------------------------------
// performNoiseHandshake
// ---------------------------------------------------------------------------

/**
 * Open a WebSocket and perform a full Noise NK handshake.
 * Returns the WebSocket and a NoiseClientTransport in SECURE state.
 */
export async function performNoiseHandshake(
  wsUrl: string,
  noiseKeyInfo: NoiseKeyInfo,
  nodeId: string,
  relayOrigin?: string,
): Promise<{ ws: WebSocket; transport: NoiseClientTransport }> {
  const ws = new WebSocket(wsUrl);
  await waitForOpen(ws);

  const transport = new NoiseClientTransport({
    nodeId,
    expectedKeyId: noiseKeyInfo.keyId,
    remoteStaticPubkey: noiseKeyInfo.publicKey,
    relayOrigin: canonicalTransportOrigin(relayOrigin),
  });

  // Send client_hello
  const clientHello = transport.getClientHello();
  ws.send(JSON.stringify(clientHello));

  // Drive handshake to completion
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Noise handshake timeout")), 10_000);
    timer.unref?.();

    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data));

      // Skip non-transport messages (e.g. plaintext welcome push)
      if (!msg.t) return;

      const responses = transport.processMessage(msg);
      for (const resp of responses) {
        ws.send(JSON.stringify(resp));
      }
      if (transport.isSecure) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve();
      }
    };

    ws.addEventListener("message", handler);
  });

  return { ws, transport };
}

// ---------------------------------------------------------------------------
// encryptedRpc
// ---------------------------------------------------------------------------

/**
 * Send an encrypted JSON-RPC request through a Noise-secured transport
 * and wait for the encrypted response.
 */
export async function encryptedRpc(
  transport: NoiseClientTransport,
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  timeout = 10_000,
): Promise<Record<string, unknown>> {
  const reqId = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const rpcMsg = { jsonrpc: "2.0", id: reqId, method, params };
  const frame = transport.encryptRpc(rpcMsg);
  ws.send(JSON.stringify(frame));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`encryptedRpc ${method} timeout`)), timeout);
    timer.unref?.();

    const handler = (event: MessageEvent) => {
      const raw = JSON.parse(String(event.data));
      // Only process data frames
      if (raw.t !== "data" || typeof raw.ct !== "string") return;

      let decrypted: Record<string, unknown>;
      try {
        decrypted = transport.decryptData(raw);
      } catch {
        // Could be a push frame or other encrypted message — skip
        return;
      }

      if (decrypted.id === reqId) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(decrypted);
      }
    };

    ws.addEventListener("message", handler);
  });
}

// ---------------------------------------------------------------------------
// plainRpc
// ---------------------------------------------------------------------------

/**
 * Send a plain (unencrypted) JSON-RPC request over a WebSocket and wait for
 * the response.
 */
export async function plainRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  timeout = 10_000,
): Promise<Record<string, unknown>> {
  const reqId = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`plainRpc ${method} timeout`)), timeout);
    timer.unref?.();

    const handler = (event: MessageEvent) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (parsed.id === reqId) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(parsed);
      }
    };

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }));
  });
}
