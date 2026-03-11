/**
 * E2E tests for auth and rate limiting.
 *
 * Requires Docker. Skipped if Docker is not available.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startRelayContainer,
  relaySignup,
  connectClient,
  waitForOpen,
  type RelayContainer,
} from "./containers";

let dockerAvailable = false;
try {
  const proc = Bun.spawnSync(["docker", "info"], { stdout: "pipe", stderr: "pipe" });
  dockerAvailable = proc.exitCode === 0;
} catch {
  dockerAvailable = false;
}

const describeE2E = dockerAvailable ? describe : describe.skip;

describeE2E("Auth & Rate Limiting E2E", () => {
  let relay: RelayContainer;
  let sharedApiKey: string;

  beforeAll(async () => {
    relay = await startRelayContainer();
    const { apiKey } = await relaySignup(relay.httpUrl, "auth-shared@test.com", "Auth Shared");
    sharedApiKey = apiKey;
  }, 120_000);

  afterAll(async () => {
    await relay?.stop();
  });

  // --- Auth Flow ---

  test("full auth flow: signup → authenticate", async () => {
    expect(sharedApiKey.startsWith("ork_live_")).toBe(true);

    const res = await fetch(`${relay.httpUrl}/v1/account`, {
      headers: { Authorization: `Bearer ${sharedApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.email).toBe("auth-shared@test.com");
  });

  test("invalid API key returns 401", async () => {
    const res = await fetch(`${relay.httpUrl}/v1/account`, {
      headers: { Authorization: "Bearer ork_live_invalid_key_here_xxxxx" },
    });
    expect(res.status).toBe(401);
  });

  // --- Admin Auth ---

  test("non-admin cannot access admin endpoints", async () => {
    const res = await fetch(`${relay.httpUrl}/v1/admin/accounts`, {
      headers: { Authorization: `Bearer ${sharedApiKey}` },
    });
    expect(res.status).toBe(403);
  });

  // --- WebSocket Auth ---

  test("WebSocket rejects invalid token", async () => {
    const ws = new WebSocket(`${relay.wsUrl}?token=invalid_key&role=client`);
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
      ws.addEventListener("error", () => resolve(-1));
    });
    const code = await closed;
    expect(code).not.toBe(1000);
  });

  test("WebSocket accepts valid token", async () => {
    const ws = connectClient(relay.wsUrl, sharedApiKey);
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  // --- Key Management ---

  test("create and revoke API keys", async () => {
    const headers = { Authorization: `Bearer ${sharedApiKey}`, "Content-Type": "application/json" };

    // Create a key
    const createRes = await fetch(`${relay.httpUrl}/v1/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "to-revoke" }),
    });
    expect(createRes.status).toBe(201);
    const { keyId } = await createRes.json() as any;

    // Revoke it
    const revokeRes = await fetch(`${relay.httpUrl}/v1/keys/${keyId}`, {
      method: "DELETE",
      headers,
    });
    expect(revokeRes.status).toBe(200);
  });

  test("cannot create more than max keys per account", async () => {
    // Create a fresh account to avoid interference from other tests
    const { apiKey } = await relaySignup(relay.httpUrl, `maxkeys-${Date.now()}@test.com`, "Max Keys");
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

    // Create keys up to the limit (default 10, already have 1)
    let lastStatus = 201;
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${relay.httpUrl}/v1/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ label: `key-${i}` }),
      });
      lastStatus = res.status;
      if (res.status !== 201) break;
    }
    expect(lastStatus).toBe(400);
  });

  // --- Signup Rate Limiting ---

  test("signup rate limiting by IP", async () => {
    // This test must run last — it burns through the IP rate limit
    let lastStatus = 201;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${relay.httpUrl}/v1/signup`, {
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
