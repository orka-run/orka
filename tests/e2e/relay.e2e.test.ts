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
  // Shared account — avoids signup rate limit (5/hour/IP)
  let sharedApiKey: string;
  let sharedAccountId: string;

  beforeAll(async () => {
    relay = await startRelayContainer();
    const signup = await relaySignup(relay.httpUrl, "shared@example.com", "Shared Account");
    sharedApiKey = signup.apiKey;
    sharedAccountId = signup.accountId;
  }, 120_000); // Container build can be slow

  afterAll(async () => {
    await relay?.stop();
  });

  // --- Health ---

  test("health endpoint returns 200", async () => {
    const res = await fetch(`${relay.httpUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
  });

  // --- Signup & Auth ---

  test("signup creates account and returns API key", () => {
    // Verified in beforeAll; check stored values
    expect(sharedAccountId).toBeTruthy();
    expect(sharedApiKey).toBeTruthy();
    expect(sharedApiKey.startsWith("ork_live_")).toBe(true);
  });

  test("duplicate signup returns 409", async () => {
    const res = await fetch(`${relay.httpUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "shared@example.com", name: "Dup" }),
    });
    expect(res.status).toBe(409);
  });

  test("unauthenticated request returns 401", async () => {
    const res = await fetch(`${relay.httpUrl}/v1/account`);
    expect(res.status).toBe(401);
  });

  test("authenticated account endpoint returns profile", async () => {
    const res = await fetch(`${relay.httpUrl}/v1/account`, {
      headers: { Authorization: `Bearer ${sharedApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.email).toBe("shared@example.com");
    expect(body.status).toBe("active");
  });

  // --- API Keys ---

  test("create and list API keys", async () => {
    const headers = { Authorization: `Bearer ${sharedApiKey}`, "Content-Type": "application/json" };

    // Create a new key
    const createRes = await fetch(`${relay.httpUrl}/v1/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "secondary" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as any;
    expect(created.apiKey.startsWith("ork_live_")).toBe(true);

    // List keys (should have at least 2)
    const listRes = await fetch(`${relay.httpUrl}/v1/keys`, { headers });
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as any;
    expect(list.keys.length).toBeGreaterThanOrEqual(2);
  });

  test("revoke API key", async () => {
    const headers = { Authorization: `Bearer ${sharedApiKey}`, "Content-Type": "application/json" };

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
  });

  // --- WebSocket ---

  test("client connects via WebSocket", async () => {
    const ws = connectClient(relay.wsUrl, sharedApiKey);
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("account isolation: client without nodes gets error", async () => {
    // Create a second account for isolation test (uses one signup slot)
    const { apiKey: keyB } = await relaySignup(relay.httpUrl, `iso-b-${Date.now()}@example.com`, "Account B");

    // Connect shared account as node
    const wsNode = new WebSocket(`${relay.wsUrl}?token=${sharedApiKey}&role=node&node_id=node-a`);
    await waitForOpen(wsNode);

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

    wsNode.close();
    wsB.close();
  });

  // --- Usage ---

  test("usage endpoint returns data", async () => {
    const res = await fetch(`${relay.httpUrl}/v1/usage`, {
      headers: { Authorization: `Bearer ${sharedApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.buckets).toBeDefined();
  });
});
