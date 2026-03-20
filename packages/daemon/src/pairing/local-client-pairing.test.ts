import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createLocalClient, type PairingConfig } from "../local-client";
import { createDaemonContext, type DaemonContext } from "../daemon-context";
import { parsePairingCode } from "@orka/core/crypto/protocol";

let testHome = "";
let ctx: DaemonContext;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "orka-pairing-test-"));
  mkdirSync(testHome, { recursive: true });
  writeFileSync(join(testHome, "config.toml"), "");
  ctx = await createDaemonContext(testHome, { inMemoryDb: true });
});

afterEach(() => ctx.db.clearAllData());

afterAll(() => {
  ctx.db.close();
  rmSync(testHome, { recursive: true, force: true });
});

function makePairingConfig(): PairingConfig {
  const transportPubkey = new Uint8Array(randomBytes(32));
  return {
    nodeId: "test-node-01",
    nodeName: "Test Node 1",
    transportPubkey,
    transportKeyId: "sha256:abc123",
    relayPaths: ["wss://relay.example.com/v1/node/test-node-01"],
    relayUrl: "ws://localhost:17390",
  };
}

describe("LocalClient startPairing", () => {
  test("returns a valid pairing code and enrollment details", async () => {
    const config = makePairingConfig();
    const client = createLocalClient(ctx, config);

    const result = await client.startPairing({});

    // Validate the pairing code can be parsed
    const parsed = parsePairingCode(result.pairingCode);
    expect(parsed.version).toBe(1);
    expect(parsed.secret).toHaveLength(10);

    // Validate enrollment ID is a hex string
    expect(result.enrollId).toMatch(/^[0-9a-f]{16}$/);

    // Validate expiration is in the future
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    // Default TTL is 600s = 10 minutes
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
  });

  test("respects custom TTL", async () => {
    const config = makePairingConfig();
    const client = createLocalClient(ctx, config);

    const result = await client.startPairing({ ttlSec: 60 });

    // Should expire in ~60 seconds
    const expectedMax = Date.now() + 60_000 + 1000;
    const expectedMin = Date.now() + 59_000;
    expect(result.expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(result.expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  test("generates unique pairing codes for each call", async () => {
    const config = makePairingConfig();
    const client = createLocalClient(ctx, config);

    const result1 = await client.startPairing({});
    const result2 = await client.startPairing({});

    expect(result1.pairingCode).not.toBe(result2.pairingCode);
    expect(result1.enrollId).not.toBe(result2.enrollId);
  });

  test("throws when pairing is not configured", async () => {
    const client = createLocalClient(ctx);

    await expect(client.startPairing({})).rejects.toThrow("Pairing is not configured");
  });

  test("pairing code format matches XXXX-XXXX-XXXX-XXXX-XXXXX", async () => {
    const config = makePairingConfig();
    const client = createLocalClient(ctx, config);

    const result = await client.startPairing({});

    // Format: 4-4-4-4-5 groups separated by dashes
    expect(result.pairingCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{5}$/);
  });
});
