/**
 * E2E tests for relay: routing, auth, API endpoints, rate limiting.
 *
 * Tests the complete RPC path through the relay to a real daemon,
 * plus relay HTTP API endpoints (signup, keys, usage, admin).
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

/** Send JSON-RPC via WebSocket and wait for response. */
function rpc(ws: WebSocket, method: string, params: any = {}, id?: string): Promise<any> {
  const reqId = id ?? `${method}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timeout`)), 10_000);
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

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
}

describe("Full-Stack Routing", () => {
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
    relay = startRelay({ port: 0, hostname: "127.0.0.1" });
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
    ctx = createDaemonContext(daemonHome);
    svc = createLocalClient(ctx);
    daemonServer = await startServer(ctx, svc, {
      port: 0,
      hostname: "127.0.0.1",
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      nodeId: "test-daemon",
      relayToken: nodeApiKey,
    });

    // Wait for node registration to propagate
    await Bun.sleep(500);
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
    await Bun.sleep(500);
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

  // ---- RPC Routing ----

  test("listSessions routes through relay to daemon", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    const resp = await rpc(ws, "listSessions", { filters: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeInstanceOf(Array);

    ws.close();
  });

  test("reap routes through relay to daemon", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    const resp = await rpc(ws, "reap");
    expect(resp.error).toBeUndefined();
    expect(typeof resp.result).toBe("number");

    ws.close();
  });

  test("spawn routes through relay and creates a session", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    const resp = await rpc(ws, "spawn", {
      prompt: "echo 'routed-spawn'",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
      title: "E2E routing spawn",
    });

    expect(resp.error).toBeUndefined();
    expect(resp.result.id).toMatch(/^sess-/);
    expect(resp.result.status).toBe("running");

    // Verify we can read the session back through the relay
    const getResp = await rpc(ws, "getSession", { id: resp.result.id });
    expect(getResp.error).toBeUndefined();
    expect(getResp.result.id).toBe(resp.result.id);

    ws.close();
  });

  test("getTask routes through relay", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    // First list sessions to get a task ID
    const listResp = await rpc(ws, "listSessions", { filters: {} });
    expect(listResp.result.length).toBeGreaterThan(0);
    const taskId = listResp.result[0].taskId;

    const taskResp = await rpc(ws, "getTask", { id: taskId });
    expect(taskResp.error).toBeUndefined();
    expect(taskResp.result.id).toBe(taskId);
    expect(taskResp.result.backend).toBe("shell");

    ws.close();
  });

  test("stop routes through relay and cancels session", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    // Spawn a long-running session
    const spawnResp = await rpc(ws, "spawn", {
      prompt: "sleep 600",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
    });
    const sessionId = spawnResp.result.id;

    // Stop it through the relay
    const stopResp = await rpc(ws, "stop", { sessionId });
    expect(stopResp.error).toBeUndefined();

    // Wait for the async event consumer to finalize status
    const deadline = Date.now() + 5_000;
    let status = "running";
    while (Date.now() < deadline) {
      const getResp = await rpc(ws, "getSession", { id: sessionId });
      status = getResp.result.status;
      if (status === "cancelled" || status === "completed" || status === "failed") break;
      await Bun.sleep(200);
    }
    expect(status).toBe("cancelled");

    ws.close();
  });

  // ---- Account Isolation ----

  test("second account cannot see first account's sessions", async () => {
    const signup2 = await fetch(`http://127.0.0.1:${relayPort}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `iso-${Date.now()}@orka.dev`, name: "Isolated" }),
    });
    const { apiKey: key2 } = await signup2.json() as any;

    const ws2 = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${key2}&role=client`);
    await waitForOpen(ws2);

    const resp = await rpc(ws2, "listSessions", { filters: {} });
    expect(resp.error).toBeTruthy();
    expect(resp.error).not.toBeNull();
    expect(resp.error!.code).toBe(503);

    ws2.close();
  });

  // ---- Error handling ----

  test("unknown RPC method returns error", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    const resp = await rpc(ws, "nonExistentMethod", {});
    expect(resp.error).toBeTruthy();

    ws.close();
  });

  test("invalid token rejects WebSocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=ork_live_invalid&role=client`);
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
      ws.addEventListener("error", () => resolve(-1));
    });
    const code = await closed;
    expect(code).not.toBe(1000);
  });

  // ---- Multiple RPC calls on same connection ----

  test("multiple sequential RPCs on same WebSocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${clientApiKey}&role=client`);
    await waitForOpen(ws);

    for (let i = 0; i < 5; i++) {
      const resp = await rpc(ws, "listSessions", { filters: {} }, `batch-${i}`);
      expect(resp.error).toBeUndefined();
      expect(resp.id).toBe(`batch-${i}`);
    }

    ws.close();
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
