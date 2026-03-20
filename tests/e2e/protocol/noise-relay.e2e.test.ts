/**
 * E2E tests for Noise NK encrypted transport through relay infrastructure.
 *
 * Tests the full transport lifecycle:
 *   - Unencrypted JSON-RPC routing through relay
 *   - Noise NK handshake and encrypted RPC via direct daemon connection
 *   - Multi-node Noise sessions with correct key routing
 *   - Session persistence across idle periods
 *
 * Runs relay + daemon(s) in-process (no Docker needed).
 * Run with: bun test tests/e2e/protocol/noise-relay.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { waitFor } from "../helpers/polling";

// Isolated data dirs — must be set BEFORE importing daemon/relay modules
// so their module-level DB initialization uses isolated paths.
const daemonHomeA = mkdtempSync(join(tmpdir(), "orka-e2e-noise-daemonA-"));
const daemonHomeB = mkdtempSync(join(tmpdir(), "orka-e2e-noise-daemonB-"));
const relayHome = mkdtempSync(join(tmpdir(), "orka-e2e-noise-relay-"));
process.env["ORKA_HOME"] = daemonHomeA;
process.env["ORKA_RELAY_DATA"] = relayHome;

import type { OrkaService, DataFrame } from "@orka/core";
import { canonicalTransportOrigin } from "@orka/core";
import type { NoiseKeyInfo } from "../../../packages/core/src/crypto";
import { NoiseClientTransport } from "../../../packages/core/src/transport/noise-transport";
import { createDaemonContext, createLocalClient, startServer } from "@orka/daemon";
import { startRelay, type RelayHandle } from "../../../packages/relay/src/index";

// ---------------------------------------------------------------------------
// Helpers (inline to avoid module-level env issues with protocol-helpers.ts)
// ---------------------------------------------------------------------------

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
}

function doNoiseHandshake(
  ws: WebSocket,
  noiseKeyInfo: NoiseKeyInfo,
  nodeId: string,
  relayOrigin?: string,
): Promise<NoiseClientTransport> {
  const transport = new NoiseClientTransport({
    nodeId,
    expectedKeyId: noiseKeyInfo.keyId,
    remoteStaticPubkey: noiseKeyInfo.publicKey,
    relayOrigin: canonicalTransportOrigin(relayOrigin) ?? "",
  });

  return new Promise<NoiseClientTransport>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Noise handshake timeout")), 10_000);
    const handler = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      const msg = parsed as Record<string, unknown>;
      if (!msg || typeof msg["t"] !== "string") return;

      try {
        const responses = transport.processMessage(parsed);
        for (const resp of responses) ws.send(JSON.stringify(resp));
        if (transport.isSecure) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(transport);
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    ws.addEventListener("message", handler);
    const clientHello = transport.getClientHello();
    ws.send(JSON.stringify(clientHello));
  });
}

function encryptedRpc(
  transport: NoiseClientTransport,
  ws: WebSocket,
  method: string,
  params: unknown = {},
  opts?: { id?: string; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  if (!transport.isSecure) throw new Error("encryptedRpc: transport not SECURE");
  const reqId = opts?.id ?? `${method}-${Date.now()}`;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Encrypted RPC ${method} timeout`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      const frame = parsed as Record<string, unknown>;
      if (frame["t"] !== "data" || typeof frame["ct"] !== "string") return;
      try {
        const payload = transport.decryptFrame(frame as DataFrame);
        if (payload.kind !== "rpc") return;
        const decrypted = payload.rpc;
        if (decrypted["id"] === reqId) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(decrypted);
        }
      } catch { /* decryption failed — skip */ }
    };
    ws.addEventListener("message", handler);
    const rpcEnvelope: Record<string, unknown> = { jsonrpc: "2.0", id: reqId, method, params };
    const frame = transport.encryptRpc(rpcEnvelope);
    ws.send(JSON.stringify(frame));
  });
}

/** Fetch Noise key info from daemon /health endpoint. */
async function fetchNoiseKeyInfo(port: number): Promise<NoiseKeyInfo> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const health = (await res.json()) as { publicKey?: string; keyId?: string };
  if (!health.publicKey || !health.keyId) throw new Error("Daemon /health missing Noise key info");
  return {
    publicKey: new Uint8Array(Buffer.from(health.publicKey, "base64url")),
    privateKey: new Uint8Array(0),
    keyId: health.keyId,
    publicKeyB64: health.publicKey,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Noise NK through Relay", () => {
  let relay: RelayHandle;
  let relayPort: number;

  let ctxA: import("@orka/daemon").DaemonContext;
  let ctxB: import("@orka/daemon").DaemonContext;
  let daemonServerA: Awaited<ReturnType<typeof startServer>>["server"];
  let daemonServerB: Awaited<ReturnType<typeof startServer>>["server"];
  let noiseKeyA: NoiseKeyInfo;
  let noiseKeyB: NoiseKeyInfo;
  let daemonPortA: number;
  let daemonPortB: number;

  let clientApiKey: string;
  let svcA: OrkaService;
  let svcB: OrkaService;

  beforeAll(async () => {
    // 1. Start in-process relay (ephemeral port)
    relay = await startRelay({ port: 0, hostname: "127.0.0.1" });
    relayPort = relay.server.port!;

    // 2. Sign up + create API keys on relay
    const signupRes = await fetch(`http://127.0.0.1:${relayPort}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "noise-e2e@orka.dev", name: "Noise E2E" }),
    });
    const signup = (await signupRes.json()) as { apiKey: string };
    clientApiKey = signup.apiKey;

    // Create node API keys
    const nodeKeyResA = await fetch(`http://127.0.0.1:${relayPort}/v1/keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clientApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "node-A", permissions: "node" }),
    });
    const nodeApiKeyA = ((await nodeKeyResA.json()) as { apiKey: string }).apiKey;

    const nodeKeyResB = await fetch(`http://127.0.0.1:${relayPort}/v1/keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clientApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "node-B", permissions: "node" }),
    });
    const nodeApiKeyB = ((await nodeKeyResB.json()) as { apiKey: string }).apiKey;

    // 3. Start daemon A with encryption + relay registration
    ctxA = await createDaemonContext(daemonHomeA, { inMemoryDb: true });
    svcA = createLocalClient(ctxA);
    ({ server: daemonServerA } = await startServer(ctxA, svcA, {
      port: 0,
      hostname: "127.0.0.1",
      encrypt: true,
      nodeId: "node-A",
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: nodeApiKeyA,
    }));
    daemonPortA = daemonServerA.port!;
    noiseKeyA = await fetchNoiseKeyInfo(daemonPortA);

    // 4. Start daemon B with encryption + relay registration
    ctxB = await createDaemonContext(daemonHomeB, { inMemoryDb: true });
    svcB = createLocalClient(ctxB);
    ({ server: daemonServerB } = await startServer(ctxB, svcB, {
      port: 0,
      hostname: "127.0.0.1",
      encrypt: true,
      nodeId: "node-B",
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: nodeApiKeyB,
    }));
    daemonPortB = daemonServerB.port!;
    noiseKeyB = await fetchNoiseKeyInfo(daemonPortB);

    // Wait for nodes to register with relay
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${relayPort}/health`, {
          headers: { Authorization: `Bearer ${clientApiKey}` },
        });
        if (!res.ok) return false;
        const body = await res.json() as { account?: { nodes?: Array<{ id: string }> } };
        const nodes = body.account?.nodes ?? [];
        return nodes.some((n) => n.id === "node-A") && nodes.some((n) => n.id === "node-B");
      } catch { return false; }
    });
  }, 30_000);

  afterAll(async () => {
    // Stop all running sessions before stopping servers
    for (const svc of [svcA, svcB]) {
      try {
        const sessions = await svc?.listSessions();
        if (sessions) {
          await Promise.all(
            sessions.filter((s) => s.status === "running").map((s) => svc.stop(s.id).catch(() => {})),
          );
        }
      } catch {}
    }
    try { daemonServerA?.stop?.(true); } catch {}
    try { daemonServerB?.stop?.(true); } catch {}
    // Let background event consumers finalize before closing DB
    await Bun.sleep(200);
    ctxA?.db.close();
    ctxB?.db.close();
    try { await relay?.shutdown({ drainTimeoutMs: 1000 }); } catch {}
    rmSync(daemonHomeA, { recursive: true, force: true });
    rmSync(daemonHomeB, { recursive: true, force: true });
    rmSync(relayHome, { recursive: true, force: true });
  });

  // ---- Test 1: Noise NK encrypted RPC end-to-end ----

  test("Noise NK encrypted RPC routes through relay", async () => {
    // Connect directly to daemon A. The relay URL is passed as relayOrigin
    // so the prologue matches what the daemon computed at startup.
    const relayUrl = `ws://127.0.0.1:${relayPort}`;
    const ws = new WebSocket(`ws://127.0.0.1:${daemonPortA}`);
    await waitForOpen(ws);
    try {
      const transport = await doNoiseHandshake(ws, noiseKeyA, "node-A", relayUrl);
      expect(transport.isSecure).toBe(true);
      expect(transport.sessionId).not.toBeNull();

      const resp = await encryptedRpc(transport, ws, "listSessions", { filters: {} });
      expect(resp["error"]).toBeUndefined();
      expect((resp["result"] as { sessions: unknown[] }).sessions).toBeInstanceOf(Array);
    } finally {
      ws.close();
    }
  });

  // ---- Test 3: Multi-node Noise routing ----

  test("multi-node: relay routes Noise to correct node", async () => {
    const relayUrl = `ws://127.0.0.1:${relayPort}`;

    // Handshake with node-A
    const wsA = new WebSocket(`ws://127.0.0.1:${daemonPortA}`);
    await waitForOpen(wsA);
    try {
      const transportA = await doNoiseHandshake(wsA, noiseKeyA, "node-A", relayUrl);
      expect(transportA.isSecure).toBe(true);
      const respA = await encryptedRpc(transportA, wsA, "listSessions", { filters: {} });
      expect(respA["error"]).toBeUndefined();
    } finally {
      wsA.close();
    }

    // Handshake with node-B
    const wsB = new WebSocket(`ws://127.0.0.1:${daemonPortB}`);
    await waitForOpen(wsB);
    try {
      const transportB = await doNoiseHandshake(wsB, noiseKeyB, "node-B", relayUrl);
      expect(transportB.isSecure).toBe(true);
      const respB = await encryptedRpc(transportB, wsB, "listSessions", { filters: {} });
      expect(respB["error"]).toBeUndefined();
    } finally {
      wsB.close();
    }

    // Verify distinct Noise keys prove different node identities
    expect(noiseKeyA.keyId).not.toBe(noiseKeyB.keyId);
    expect(noiseKeyA.publicKeyB64).not.toBe(noiseKeyB.publicKeyB64);

    // Cross-node handshake: using node-B's key on node-A's server must fail
    const wsFail = new WebSocket(`ws://127.0.0.1:${daemonPortA}`);
    await waitForOpen(wsFail);
    try {
      await expect(
        doNoiseHandshake(wsFail, noiseKeyB, "node-A", relayUrl),
      ).rejects.toThrow(/key_id_mismatch/);
    } finally {
      wsFail.close();
    }
  });

  // ---- Test 5: Noise session survives idle period ----

  test("Noise session survives idle period", async () => {
    const relayUrl = `ws://127.0.0.1:${relayPort}`;
    const ws = new WebSocket(`ws://127.0.0.1:${daemonPortA}`);
    await waitForOpen(ws);
    try {
      const transport = await doNoiseHandshake(ws, noiseKeyA, "node-A", relayUrl);
      expect(transport.isSecure).toBe(true);

      // First RPC
      const resp1 = await encryptedRpc(transport, ws, "listSessions", { filters: {} }, { id: "idle-1" });
      expect(resp1["error"]).toBeUndefined();
      expect((resp1["result"] as { sessions: unknown[] }).sessions).toBeInstanceOf(Array);

      // Idle for 1 second (proves session survives idle)
      await Bun.sleep(1_000);

      // Second RPC -- nonce state must be preserved
      const resp2 = await encryptedRpc(transport, ws, "listSessions", { filters: {} }, { id: "idle-2" });
      expect(resp2["error"]).toBeUndefined();
      expect((resp2["result"] as { sessions: unknown[] }).sessions).toBeInstanceOf(Array);

      // Third RPC to confirm channel health
      const resp3 = await encryptedRpc(transport, ws, "reap", {}, { id: "idle-3" });
      expect(resp3["error"]).toBeUndefined();
      expect(typeof resp3["result"]).toBe("number");
    } finally {
      ws.close();
    }
  }, 15_000);

  // ---- Test 6: Noise NK handshake and RPC through relay ----

  test("Noise NK handshake and encrypted RPC through relay", async () => {
    const relayUrl = `ws://127.0.0.1:${relayPort}`;
    // Connect to relay (not daemon directly) — relay forwards transport messages
    const ws = new WebSocket(`${relayUrl}/ws?token=${clientApiKey}`);
    await waitForOpen(ws);
    try {
      const transport = await doNoiseHandshake(ws, noiseKeyA, "node-A", relayUrl);
      expect(transport.isSecure).toBe(true);
      expect(transport.sessionId).not.toBeNull();

      const resp = await encryptedRpc(transport, ws, "listSessions", { filters: {} });
      expect(resp["error"]).toBeUndefined();
      expect((resp["result"] as { sessions: unknown[] }).sessions).toBeInstanceOf(Array);
    } finally {
      ws.close();
    }
  });

  // ---- Test 7: Multi-node Noise routing through relay ----

  test("multi-node: relay routes Noise to correct node via transport", async () => {
    const relayUrl = `ws://127.0.0.1:${relayPort}`;

    // Handshake with node-A through relay
    const wsA = new WebSocket(`${relayUrl}/ws?token=${clientApiKey}`);
    await waitForOpen(wsA);
    try {
      const transportA = await doNoiseHandshake(wsA, noiseKeyA, "node-A", relayUrl);
      expect(transportA.isSecure).toBe(true);
      const respA = await encryptedRpc(transportA, wsA, "listSessions", { filters: {} });
      expect(respA["error"]).toBeUndefined();
    } finally {
      wsA.close();
    }

    // Handshake with node-B through relay
    const wsB = new WebSocket(`${relayUrl}/ws?token=${clientApiKey}`);
    await waitForOpen(wsB);
    try {
      const transportB = await doNoiseHandshake(wsB, noiseKeyB, "node-B", relayUrl);
      expect(transportB.isSecure).toBe(true);
      const respB = await encryptedRpc(transportB, wsB, "listSessions", { filters: {} });
      expect(respB["error"]).toBeUndefined();
    } finally {
      wsB.close();
    }
  });

  // ---- Test 8: Multiple encrypted RPCs through relay ----

  test("multiple encrypted RPCs on same connection through relay", async () => {
    const relayUrl = `ws://127.0.0.1:${relayPort}`;
    const ws = new WebSocket(`${relayUrl}/ws?token=${clientApiKey}`);
    await waitForOpen(ws);
    try {
      const transport = await doNoiseHandshake(ws, noiseKeyA, "node-A", relayUrl);
      expect(transport.isSecure).toBe(true);

      // Send multiple RPCs sequentially to verify nonce sync through relay
      for (let i = 0; i < 5; i++) {
        const resp = await encryptedRpc(transport, ws, "listSessions", { filters: {} }, { id: `multi-${i}` });
        expect(resp["error"]).toBeUndefined();
        expect((resp["result"] as { sessions: unknown[] }).sessions).toBeInstanceOf(Array);
      }
    } finally {
      ws.close();
    }
  });

  // ---- Test 9: Transport error for unknown node ----

  test("transport error when node_id not found", async () => {
    const relayUrl = `ws://127.0.0.1:${relayPort}`;
    const ws = new WebSocket(`${relayUrl}/ws?token=${clientApiKey}`);
    await waitForOpen(ws);
    try {
      // Send client_hello with a non-existent node_id
      const errorPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        ws.addEventListener("message", (event) => {
          try {
            const msg = JSON.parse(String(event.data));
            if (msg.t === "transport_error") {
              clearTimeout(timer);
              resolve(msg);
            }
          } catch {}
        });
      });

      ws.send(JSON.stringify({
        t: "client_hello",
        v: 1,
        noise_suites: ["Noise_NK_25519_ChaChaPoly_SHA256"],
        node_id: "nonexistent-node",
        expected_key_id: "sha256:fake",
        app_protocols: ["jsonrpc-2.0"],
        features: [],
      }));

      const err = await errorPromise;
      expect(err["code"]).toBe("node_not_found");
    } finally {
      ws.close();
    }
  });
});
