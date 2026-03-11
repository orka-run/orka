/**
 * E2E tests for the relay server.
 *
 * Requires Docker. Skipped if Docker is not available.
 * Run with: bun test tests/e2e/relay.e2e.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startRelayContainer,
  relaySignup,
  connectClient,
  waitForOpen,
  sendAndReceive,
  type RelayContainer,
} from "./containers";

// Check if Docker is available before running E2E tests
let dockerAvailable = false;
try {
  const proc = Bun.spawnSync(["docker", "info"], { stdout: "pipe", stderr: "pipe" });
  dockerAvailable = proc.exitCode === 0;
} catch {
  dockerAvailable = false;
}

const describeE2E = dockerAvailable ? describe : describe.skip;

describeE2E("Relay E2E", () => {
  let relay: RelayContainer;

  beforeAll(async () => {
    relay = await startRelayContainer();
  }, 120_000); // Container build can be slow

  afterAll(async () => {
    await relay?.stop();
  });

  // --- Signup & Auth ---

  test("health endpoint returns 200", async () => {
    const res = await fetch(`${relay.httpUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
  });

  test("signup creates account and returns API key", async () => {
    const result = await relaySignup(relay.httpUrl, "test@example.com", "Test User");
    expect(result.accountId).toBeTruthy();
    expect(result.apiKey).toBeTruthy();
    expect(result.apiKey.startsWith("ork_live_")).toBe(true);
  });

  test("duplicate signup returns 409", async () => {
    const email = `dup-${Date.now()}@example.com`;
    await relaySignup(relay.httpUrl, email, "First");
    const res = await fetch(`${relay.httpUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name: "Second" }),
    });
    expect(res.status).toBe(409);
  });

  test("unauthenticated request returns 401", async () => {
    const res = await fetch(`${relay.httpUrl}/v1/account`);
    expect(res.status).toBe(401);
  });

  test("authenticated account endpoint returns profile", async () => {
    const { apiKey } = await relaySignup(relay.httpUrl, `acct-${Date.now()}@example.com`, "Auth Test");
    const res = await fetch(`${relay.httpUrl}/v1/account`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.email).toContain("@example.com");
    expect(body.status).toBe("active");
  });

  // --- API Keys ---

  test("create and list API keys", async () => {
    const { apiKey } = await relaySignup(relay.httpUrl, `keys-${Date.now()}@example.com`, "Key Test");
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

    // Create a new key
    const createRes = await fetch(`${relay.httpUrl}/v1/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "secondary" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as any;
    expect(created.apiKey.startsWith("ork_live_")).toBe(true);

    // List keys (should have 2: initial + secondary)
    const listRes = await fetch(`${relay.httpUrl}/v1/keys`, { headers });
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as any;
    expect(list.keys.length).toBe(2);
  });

  test("revoke API key", async () => {
    const { apiKey } = await relaySignup(relay.httpUrl, `revoke-${Date.now()}@example.com`, "Revoke Test");
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

    // Create a key to revoke
    const createRes = await fetch(`${relay.httpUrl}/v1/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "to-revoke" }),
    });
    const { keyId } = await createRes.json() as any;

    // Revoke it
    const revokeRes = await fetch(`${relay.httpUrl}/v1/keys/${keyId}`, {
      method: "DELETE",
      headers,
    });
    expect(revokeRes.status).toBe(200);

    // List should show 1 key remaining with active status (the initial one)
    const listRes = await fetch(`${relay.httpUrl}/v1/keys`, { headers });
    const list = await listRes.json() as any;
    const activeKeys = list.keys.filter((k: any) => k.status === "active");
    expect(activeKeys.length).toBe(1);
  });

  // --- WebSocket ---

  test("client connects via WebSocket", async () => {
    const { apiKey } = await relaySignup(relay.httpUrl, `ws-${Date.now()}@example.com`, "WS Test");
    const ws = connectClient(relay.wsUrl, apiKey);
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("account isolation: different accounts don't see each other's nodes", async () => {
    const { apiKey: keyA } = await relaySignup(relay.httpUrl, `iso-a-${Date.now()}@example.com`, "Account A");
    const { apiKey: keyB } = await relaySignup(relay.httpUrl, `iso-b-${Date.now()}@example.com`, "Account B");

    // Connect A as node
    const wsA = new WebSocket(`${relay.wsUrl}?token=${keyA}&role=node&node_id=node-a`);
    await waitForOpen(wsA);

    // B connects as client and tries to route — should get error (no nodes for B's account)
    const wsB = connectClient(relay.wsUrl, keyB);
    await waitForOpen(wsB);

    const response = await sendAndReceive(wsB, {
      jsonrpc: "2.0",
      id: "1",
      method: "test",
      params: {},
    });

    // Should get an error because B has no nodes
    expect(response.error).toBeTruthy();

    wsA.close();
    wsB.close();
  });

  // --- Usage ---

  test("usage endpoint returns data", async () => {
    const { apiKey } = await relaySignup(relay.httpUrl, `usage-${Date.now()}@example.com`, "Usage Test");
    const res = await fetch(`${relay.httpUrl}/v1/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.buckets).toBeDefined();
  });
});
