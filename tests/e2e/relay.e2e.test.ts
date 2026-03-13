/**
 * E2E tests for the relay server.
 *
 * Tests relay-specific behavior: health endpoint, account isolation,
 * usage tracking. Auth and key management tests live in auth.e2e.test.ts.
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

  beforeAll(async () => {
    relay = await startRelayContainer();
    const signup = await relaySignup(relay.httpUrl, "shared@example.com", "Shared Account");
    sharedApiKey = signup.apiKey;
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

  // --- Account Isolation ---

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
    expect(response["error"]).toBeTruthy();

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
