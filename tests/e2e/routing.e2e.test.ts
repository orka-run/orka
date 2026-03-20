/**
 * E2E tests for relay: auth, API endpoints, rate limiting, transport enforcement.
 *
 * Tests the relay HTTP API endpoints (signup, keys, usage, admin)
 * and verifies that plain JSON-RPC is rejected (Noise transport required).
 * Runs relay + daemon in-process (no Docker needed).
 *
 * Run with: bun test tests/e2e/routing.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// Isolated data dirs — must be set BEFORE importing daemon/relay
const daemonHome = mkdtempSync(join(tmpdir(), "orka-e2e-routing-daemon-"));
const relayHome = mkdtempSync(join(tmpdir(), "orka-e2e-routing-relay-"));
process.env["ORKA_HOME"] = daemonHome;
process.env["ORKA_RELAY_DATA"] = relayHome;

import { createDaemonContext, createLocalClient, startServer } from "@orka/daemon";
import type { DaemonContext } from "@orka/daemon";
import type { OrkaService } from "@orka/core";
import { startRelay, type RelayHandle } from "../../packages/relay/src/index";
import { waitForRelayNode } from "./helpers/polling";

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
}

/** Wait for a specific message matching a predicate. */
function waitForMessage(
  ws: WebSocket,
  predicate: (data: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("waitForMessage timeout"));
    }, timeoutMs);
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

describe("Relay Routing & Auth", () => {
  let relay: RelayHandle;
  let ctx: DaemonContext;
  let daemonServer: any;
  let svc: OrkaService;
  let testRepo: string;

  let relayPort: number;
  let clientApiKey: string;
  let nodeApiKey: string;

  beforeAll(async () => {
    // 1. Create temp git repo
    testRepo = mkdtempSync(join(tmpdir(), "orka-e2e-routing-repo-"));
    await $`git init ${testRepo}`.quiet();
    await $`git -C ${testRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${testRepo} config user.name "Orka Test"`.quiet();
    await $`git -C ${testRepo} commit --allow-empty -m "init"`.quiet();

    // 2. Start relay
    relay = await startRelay({ port: 0, hostname: "127.0.0.1" });
    const assignedRelayPort = relay.server.port;
    if (assignedRelayPort === undefined) {
      throw new Error("Relay port was not assigned");
    }
    relayPort = assignedRelayPort;

    // 3. Sign up and get keys
    const signupRes = await fetch(`http://127.0.0.1:${relayPort}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "routing-test@orka.dev", name: "Routing Test" }),
    });
    const signup = await signupRes.json() as any;
    clientApiKey = signup.apiKey;

    // Create a node key
    const nodeKeyRes = await fetch(`http://127.0.0.1:${relayPort}/v1/keys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "node", permissions: "node" }),
    });
    const nodeKeyData = await nodeKeyRes.json() as any;
    nodeApiKey = nodeKeyData.apiKey;

    // 4. Start daemon and register with relay
    ctx = await createDaemonContext(daemonHome);
    svc = createLocalClient(ctx);
    ({ server: daemonServer } = await startServer(ctx, svc, {
      port: 0,
      hostname: "127.0.0.1",
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      nodeId: "test-daemon",
      relayToken: nodeApiKey,
    }));

    // Wait for node registration to propagate
    await waitForRelayNode(relayPort, "test-daemon", clientApiKey);
  }, 30_000);

  afterAll(async () => {
    // Stop all running sessions
    try {
      const sessions = await svc?.listSessions();
      if (sessions) {
        await Promise.all(
          sessions.filter((s) => s.status === "running").map((s) => svc.stop(s.id).catch(() => {})),
        );
      }
    } catch {}
    try { daemonServer?.stop?.(true); } catch {}
    await Bun.sleep(200);
    ctx?.db.close();
    try { await relay?.shutdown({ drainTimeoutMs: 1000 }); } catch {}
    rmSync(daemonHome, { recursive: true, force: true });
    rmSync(relayHome, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  });

  // ---- Health ----

  test("relay health returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
  });

  test("daemon health returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${daemonServer.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
  });

  // ---- Transport Enforcement ----

  test("plain JSON-RPC message is rejected with transport_required", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    // Send a plain JSON-RPC message (not transport)
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: "test-1", method: "listSessions", params: {} }));

    const resp = await waitForMessage(ws, (m: any) => m?.t === "transport_error");
    expect(resp.t).toBe("transport_error");
    expect(resp.code).toBe("transport_required");

    ws.close();
  });

  test("non-JSON message is rejected with parse_error", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    ws.send("not valid json {{{");

    const resp = await waitForMessage(ws, (m: any) => m?.t === "transport_error");
    expect(resp.t).toBe("transport_error");
    expect(resp.code).toBe("parse_error");

    ws.close();
  });

  // ---- Account Isolation ----

  test("second account cannot reach first account's nodes", async () => {
    const signup2 = await fetch(`http://127.0.0.1:${relayPort}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `iso-${Date.now()}@orka.dev`, name: "Isolated" }),
    });
    const { apiKey: key2 } = await signup2.json() as any;

    const ws2 = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${key2}&role=client`);
    await waitForOpen(ws2);

    // Try client_hello with a node that belongs to account 1
    ws2.send(JSON.stringify({
      t: "client_hello",
      v: 1,
      noise_suites: ["Noise_NK_25519_ChaChaPoly_SHA256"],
      node_id: "test-daemon",
      expected_key_id: "sha256:fake",
      app_protocols: ["jsonrpc-2.0"],
      features: [],
    }));

    const resp = await waitForMessage(ws2, (m: any) => m?.t === "transport_error");
    expect(resp.code).toBe("node_not_found");

    ws2.close();
  });

  // ---- Error handling ----

  test("invalid token rejects WebSocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=ork_live_invalid&role=client`);
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
      ws.addEventListener("error", () => resolve(-1));
    });
    const code = await closed;
    expect(code).not.toBe(1000);
  });

  // ---- Auth Flow ----

  test("signup returns ork_live_ prefixed key and account is retrievable", async () => {
    expect(clientApiKey.startsWith("ork_live_")).toBe(true);

    const res = await fetch(`http://127.0.0.1:${relayPort}/v1/account`, {
      headers: { Authorization: `Bearer ${clientApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.email).toBe("routing-test@orka.dev");
  });

  test("invalid API key returns 401 on account endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/v1/account`, {
      headers: { Authorization: "Bearer ork_live_invalid_key_here_xxxxx" },
    });
    expect(res.status).toBe(401);
  });

  test("duplicate signup returns 409", async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "routing-test@orka.dev", name: "Dup" }),
    });
    expect(res.status).toBe(409);
  });

  // ---- Admin Auth ----

  test("non-admin cannot access admin endpoints", async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/v1/admin/accounts`, {
      headers: { Authorization: `Bearer ${clientApiKey}` },
    });
    expect(res.status).toBe(403);
  });

  // ---- Key Management ----

  test("create and revoke API keys", async () => {
    const headers = { Authorization: `Bearer ${clientApiKey}`, "Content-Type": "application/json" };

    // Create a key
    const createRes = await fetch(`http://127.0.0.1:${relayPort}/v1/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "to-revoke" }),
    });
    expect(createRes.status).toBe(201);
    const { keyId } = await createRes.json() as any;

    // Revoke it
    const revokeRes = await fetch(`http://127.0.0.1:${relayPort}/v1/keys/${keyId}`, {
      method: "DELETE",
      headers,
    });
    expect(revokeRes.status).toBe(200);
  });

  test("cannot create more than max keys per account", async () => {
    // Create a fresh account to avoid interference from other tests
    const signupRes = await fetch(`http://127.0.0.1:${relayPort}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `maxkeys-${Date.now()}@test.com`, name: "Max Keys" }),
    });
    const { apiKey } = await signupRes.json() as any;
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

    // Create keys up to the limit (default 10, already have 1)
    let lastStatus = 201;
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`http://127.0.0.1:${relayPort}/v1/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ label: `key-${i}` }),
      });
      lastStatus = res.status;
      if (res.status !== 201) break;
    }
    expect(lastStatus).toBe(400);
  });

  // ---- Usage ----

  test("usage endpoint returns data", async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/v1/usage`, {
      headers: { Authorization: `Bearer ${clientApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.buckets)).toBe(true);
  });

  // ---- Signup Rate Limiting ----
  // This test must run last — it burns through the IP rate limit

  test("signup rate limiting by IP", async () => {
    let lastStatus = 201;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`http://127.0.0.1:${relayPort}/v1/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `ratelimit-${i}-${Date.now()}@test.com`, name: "Rate Test" }),
      });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
