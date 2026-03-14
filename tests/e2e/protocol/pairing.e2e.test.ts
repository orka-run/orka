/**
 * E2E tests for the full SPAKE2 pairing flow.
 *
 * Tests the complete pairing protocol:
 *   CLI (PairingClient) → relay (PairingRouter) → daemon (PairingServer)
 *
 * All components run in-process with ephemeral ports and isolated ORKA_HOME.
 *
 * Run with: bun test tests/e2e/protocol/pairing.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated data dirs — must be set BEFORE importing daemon/relay
const daemonHome = mkdtempSync(join(tmpdir(), "orka-e2e-pairing-daemon-"));
const relayHome = mkdtempSync(join(tmpdir(), "orka-e2e-pairing-relay-"));
process.env["ORKA_HOME"] = daemonHome;
process.env["ORKA_RELAY_DATA"] = relayHome;

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  PairingClient,
  type PairingClientResult,
} from "../../../packages/core/src/pairing/pairing-client";
import {
  parsePairingCode,
  generatePairingCode,
} from "../../../packages/core/src/crypto/pairing-code";
import {
  generateNoiseKeyPair,
  saveNoiseKeyPair,
  type NoiseKeyInfo,
} from "../../../packages/core/src/crypto";
import {
  NoiseClientTransport,
  computeKeyId,
} from "../../../packages/core/src/transport/noise-transport";
import { canonicalTransportOrigin } from "@orka/core";
import type { OrkaService } from "@orka/core";
import type { PairingConfig } from "@orka/daemon";
import { createDaemonContext, createLocalClient, startServer } from "@orka/daemon";
import { startRelay, type RelayHandle } from "../../../packages/relay/src/index";
import { waitForOpen } from "./protocol-helpers";

// ---------------------------------------------------------------------------
// Helper: drive the full pairing flow on the client side via WebSocket
// ---------------------------------------------------------------------------

/**
 * Run the full client-side pairing protocol over a real WebSocket connection
 * to the relay's pairing endpoint.
 *
 * Returns the PairingClientResult on success, or throws on failure.
 */
async function runClientPairing(opts: {
  relayPort: number;
  enrollId: string;
  secret: Uint8Array;
  apiKey: string;
  relayOrigin: string;
  timeoutMs?: number;
}): Promise<PairingClientResult> {
  const { relayPort, enrollId, secret, apiKey, relayOrigin, timeoutMs = 15_000 } = opts;

  const wsUrl = `ws://127.0.0.1:${relayPort}/v1/pair/${enrollId}?token=${encodeURIComponent(apiKey)}`;
  const ws = new WebSocket(wsUrl);

  try {
    await waitForOpen(ws);
  } catch (err) {
    throw new Error(`Failed to open pairing WebSocket: ${err}`);
  }

  return new Promise<PairingClientResult>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      ws.close();
      if (!settled) {
        settled = true;
        reject(new Error("Pairing timed out"));
      }
    }, timeoutMs);
    timer.unref();

    const client = new PairingClient({
      secret,
      relayOrigin,
      onSend: (msg) => ws.send(JSON.stringify(msg)),
    });

    ws.addEventListener("message", async (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      try {
        const result = await client.handleMessage(raw);
        if (result) {
          clearTimeout(timer);

          // Validate the result shape at runtime
          if (typeof result.nodeId !== "string" || !result.nodeId) {
            throw new Error("PairingClientResult: missing or invalid nodeId");
          }
          if (!(result.noiseStaticPubkey instanceof Uint8Array)) {
            throw new Error("PairingClientResult: noiseStaticPubkey is not a Uint8Array");
          }
          if (!Array.isArray(result.nodePaths)) {
            throw new Error("PairingClientResult: nodePaths is not an array");
          }

          // Send pair_done to complete the protocol
          ws.send(JSON.stringify({ t: "pair_done" }));
          // Give the server a moment to process pair_done
          await Bun.sleep(200);
          ws.close();
          if (!settled) {
            settled = true;
            resolve(result);
          }
        }
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      if (!settled && !client.completed) {
        settled = true;
        reject(client.error ?? new Error("WebSocket closed before pairing completed"));
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      ws.close();
      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket error: ${err}`));
      }
    });

    // Start the handshake
    client.start();
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("SPAKE2 Pairing Protocol E2E", () => {
  let relay: RelayHandle;
  let ctx: import("@orka/daemon").DaemonContext;
  let daemonServer: any;
  let svc: OrkaService;
  let relayPort: number;
  let daemonPort: number;
  let clientApiKey: string;
  let nodeApiKey: string;
  let noiseKeyInfo: NoiseKeyInfo;
  let relayOrigin: string;

  const NODE_ID = "test-pairing-node";
  const NODE_NAME = "test-node";

  beforeAll(async () => {
    // Generate a Noise keypair for the daemon and save it to ORKA_HOME
    // so that startServer(encrypt: true) picks up the same key via ensureNoiseKeyPair().
    noiseKeyInfo = generateNoiseKeyPair();
    saveNoiseKeyPair(daemonHome, "node", noiseKeyInfo);

    // 1. Start relay
    relay = startRelay({ port: 0, hostname: "127.0.0.1" });
    relayPort = relay.server.port;
    relayOrigin = `ws://127.0.0.1:${relayPort}`;

    // 2. Sign up and get API keys
    const signupRes = await fetch(`http://127.0.0.1:${relayPort}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `pairing-e2e-${Date.now()}@orka.dev`, name: "Pairing E2E" }),
    });
    const signup = (await signupRes.json()) as { apiKey: string };
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
    const nodeKeyData = (await nodeKeyRes.json()) as { apiKey: string };
    nodeApiKey = nodeKeyData.apiKey;

    // 3. Build PairingConfig for the daemon
    const pairingConfig: PairingConfig = {
      nodeId: NODE_ID,
      nodeName: NODE_NAME,
      transportPubkey: noiseKeyInfo.publicKey,
      transportKeyId: noiseKeyInfo.keyId,
      relayPaths: [`ws://127.0.0.1:${relayPort}`],
      relayUrl: relayOrigin,
      relayToken: nodeApiKey,
    };

    // 4. Start daemon with pairing enabled
    ctx = createDaemonContext(daemonHome);
    svc = createLocalClient(ctx, pairingConfig);
    daemonServer = await startServer(ctx, svc, {
      port: 0,
      hostname: "127.0.0.1",
      relayUrl: relayOrigin,
      nodeId: NODE_ID,
      relayToken: nodeApiKey,
      encrypt: true,
    });
    daemonPort = daemonServer.port;

    // Wait for relay registration
    await Bun.sleep(500);
  }, 30_000);

  afterAll(async () => {
    try {
      const sessions = await svc.listSessions();
      await Promise.all(
        sessions.filter((s) => s.status === "running").map((s) => svc.stop(s.id).catch(() => {})),
      );
    } catch {}
    try { daemonServer?.stop?.(true); } catch {}
    await Bun.sleep(500);
    ctx?.db.close();
    try { await relay?.shutdown({ drainTimeoutMs: 1000 }); } catch {}
    rmSync(daemonHome, { recursive: true, force: true });
    rmSync(relayHome, { recursive: true, force: true });
  });

  // ---- Test 1: Full pairing flow completes successfully ----

  test("full pairing flow completes successfully", async () => {
    // Start pairing on daemon — creates enrollment, connects to relay
    const pairingResult = await svc.startPairing({ ttlSec: 30 });

    expect(pairingResult.enrollId).toBeTruthy();
    expect(pairingResult.pairingCode).toBeTruthy();
    expect(pairingResult.expiresAt).toBeGreaterThan(Date.now());

    // Parse the pairing code on the client side
    const parsed = parsePairingCode(pairingResult.pairingCode);

    // Give the daemon time to connect to the relay pairing endpoint
    await Bun.sleep(500);

    // Run the client-side pairing
    const result = await runClientPairing({
      relayPort,
      enrollId: pairingResult.enrollId,
      secret: parsed.secret,
      apiKey: clientApiKey,
      relayOrigin,
    });

    // Verify bootstrap data matches daemon's configuration
    expect(result.nodeId).toBe(NODE_ID);
    expect(result.nodeName).toBe(NODE_NAME);
    expect(result.noiseStaticPubkey).toBeInstanceOf(Uint8Array);
    expect(result.noiseStaticPubkey.length).toBe(32);
    // The public key should match the daemon's noise key
    expect(Buffer.from(result.noiseStaticPubkey).toString("hex")).toBe(
      Buffer.from(noiseKeyInfo.publicKey).toString("hex"),
    );
    expect(result.nodePaths).toBeInstanceOf(Array);
    expect(result.nodePaths.length).toBeGreaterThan(0);
    expect(result.rpc).toContain("jsonrpc-2.0");

    // Verify the returned key can actually be used: compute a key_id from it
    // and confirm it matches the daemon's known key_id
    const derivedKeyId = computeKeyId(result.noiseStaticPubkey);
    expect(derivedKeyId).toBe(noiseKeyInfo.keyId);
    expect(derivedKeyId).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Verify the key can be used to construct a NoiseClientTransport (no throw)
    const testTransport = new NoiseClientTransport({
      nodeId: result.nodeId,
      expectedKeyId: derivedKeyId,
      remoteStaticPubkey: result.noiseStaticPubkey,
      relayOrigin: canonicalTransportOrigin(relayOrigin),
    });
    expect(testTransport.state).toBe("WS_OPEN");
    expect(testTransport.isSecure).toBe(false);
  }, 20_000);

  // ---- Test 2: Pairing bootstrap provides valid Noise key ----

  test("pairing bootstrap provides valid Noise key", async () => {
    // Complete pairing first
    const pairingResult = await svc.startPairing({ ttlSec: 30 });
    const parsed = parsePairingCode(pairingResult.pairingCode);
    await Bun.sleep(500);

    const bootstrapResult = await runClientPairing({
      relayPort,
      enrollId: pairingResult.enrollId,
      secret: parsed.secret,
      apiKey: clientApiKey,
      relayOrigin,
    });

    // Use the received noiseStaticPubkey to open a Noise NK connection to the daemon
    const expectedKeyId = computeKeyId(bootstrapResult.noiseStaticPubkey);
    const transport = new NoiseClientTransport({
      nodeId: bootstrapResult.nodeId,
      expectedKeyId,
      remoteStaticPubkey: bootstrapResult.noiseStaticPubkey,
      relayOrigin: canonicalTransportOrigin(relayOrigin),
    });

    // Connect directly to the daemon
    const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`);
    await waitForOpen(ws);

    // Run the Noise NK handshake
    const hello = transport.getClientHello();
    ws.send(JSON.stringify(hello));

    const secureResult = await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Noise handshake timed out"));
      }, 10_000);
      timer.unref();

      ws.addEventListener("message", (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        try {
          const msg = JSON.parse(raw);
          // Skip any non-transport messages (e.g. push welcome)
          if (msg.t && (msg.t === "server_hello" || msg.t === "noise_2" || msg.t === "transport_error")) {
            const responses = transport.processMessage(msg);
            for (const resp of responses) {
              ws.send(JSON.stringify(resp));
            }
            if (transport.isSecure) {
              clearTimeout(timer);
              resolve();
            }
          }
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    // Transport should be in SECURE state
    expect(transport.isSecure).toBe(true);

    // Send an encrypted RPC through the secure channel
    const rpcRequest = { jsonrpc: "2.0", id: "test-noise-rpc", method: "listSessions", params: { filters: {} } };
    const encFrame = transport.encryptRpc(rpcRequest);
    ws.send(JSON.stringify(encFrame));

    // Wait for encrypted RPC response (skip encrypted welcome push frames)
    const rpcResponse = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Encrypted RPC timed out"));
      }, 10_000);
      timer.unref();

      ws.addEventListener("message", (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        try {
          const frame = JSON.parse(raw);
          if (frame.t === "data") {
            const decrypted = transport.decryptData(frame);
            // Skip push messages (encrypted welcome, etc.), wait for the RPC response
            if ((decrypted as any).jsonrpc === "2.0") {
              clearTimeout(timer);
              resolve(decrypted);
            }
          }
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    // Verify we got a valid RPC response
    expect(rpcResponse).toBeTruthy();
    expect((rpcResponse as any).jsonrpc).toBe("2.0");
    expect((rpcResponse as any).id).toBe("test-noise-rpc");
    expect((rpcResponse as any).result).toBeInstanceOf(Array);

    ws.close();
  }, 30_000);

  // ---- Test 3: Wrong pairing code fails ----

  test("wrong pairing code fails", async () => {
    // Start pairing on daemon
    const pairingResult = await svc.startPairing({ ttlSec: 30 });
    await Bun.sleep(500);

    // Use a completely different secret (random bytes)
    const wrongSecret = new Uint8Array(10);
    crypto.getRandomValues(wrongSecret);

    // Attempt pairing with the wrong secret — should fail with SPAKE2 confirmation
    // or exchange failure (the MAC won't match because the secrets differ)
    await expect(
      runClientPairing({
        relayPort,
        enrollId: pairingResult.enrollId,
        secret: wrongSecret,
        apiKey: clientApiKey,
        relayOrigin,
      }),
    ).rejects.toThrow(/SPAKE2|confirm.*failed|protocol_error/i);
  }, 20_000);

  // ---- Test 4: Expired enrollment rejected ----

  test("expired enrollment rejected", async () => {
    // Start pairing with a very short TTL
    const pairingResult = await svc.startPairing({ ttlSec: 1 });
    const parsed = parsePairingCode(pairingResult.pairingCode);

    // Wait for the enrollment to expire
    await Bun.sleep(2500);

    // Attempt pairing — the daemon's PairingServer should reject it
    // because the enrollment is expired. The relay slot may also have timed out.
    await expect(
      runClientPairing({
        relayPort,
        enrollId: pairingResult.enrollId,
        secret: parsed.secret,
        apiKey: clientApiKey,
        relayOrigin,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/expired|timed out|not_found|closed/i);
  }, 15_000);

  // ---- Test 5: Pairing code format is valid ----

  test("pairing code format is valid and round-trips correctly", async () => {
    const pairingResult = await svc.startPairing({ ttlSec: 30 });

    // Verify pairing code matches XXXX-XXXX-XXXX-XXXX-XXXXX format
    const codeRegex = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{5}$/;
    expect(pairingResult.pairingCode).toMatch(codeRegex);

    // Verify parsePairingCode succeeds and round-trips the secret
    const parsed = parsePairingCode(pairingResult.pairingCode);
    expect(parsed.version).toBe(1);
    expect(parsed.secret).toBeInstanceOf(Uint8Array);
    expect(parsed.secret.length).toBe(10);

    // Re-parse the same code — the secret must be byte-identical
    const parsed2 = parsePairingCode(pairingResult.pairingCode);
    expect(Buffer.from(parsed2.secret).toString("hex")).toBe(
      Buffer.from(parsed.secret).toString("hex"),
    );

    // Verify the enrollId matches
    expect(pairingResult.enrollId).toBeTruthy();
    expect(typeof pairingResult.enrollId).toBe("string");
    // enrollId is 8 bytes = 16 hex characters
    expect(pairingResult.enrollId.length).toBe(16);
    expect(pairingResult.enrollId).toMatch(/^[0-9a-f]+$/);

    // Verify generatePairingCode round-trips: generate locally and parse back
    const { code: localCode, parsed: localParsed } = generatePairingCode();
    expect(localCode).toMatch(codeRegex);
    const reParsed = parsePairingCode(localCode);
    expect(reParsed.version).toBe(localParsed.version);
    expect(Buffer.from(reParsed.secret).toString("hex")).toBe(
      Buffer.from(localParsed.secret).toString("hex"),
    );

    // Verify that a corrupted code throws (flip a character)
    const chars = pairingResult.pairingCode.split("");
    const alphaIdx = chars.findIndex((c) => /[0-9A-Z]/.test(c));
    chars[alphaIdx] = chars[alphaIdx] === "0" ? "1" : "0";
    const corrupted = chars.join("");
    expect(() => parsePairingCode(corrupted)).toThrow(/checksum/i);
  }, 10_000);

  // ---- Test 6: Verify fails with wrong key ----

  test("verify fails with wrong key", async () => {
    // Complete pairing to simulate having bootstrap data
    const pairingResult = await svc.startPairing({ ttlSec: 30 });
    const parsed = parsePairingCode(pairingResult.pairingCode);
    await Bun.sleep(500);

    const bootstrapResult = await runClientPairing({
      relayPort,
      enrollId: pairingResult.enrollId,
      secret: parsed.secret,
      apiKey: clientApiKey,
      relayOrigin,
    });

    // Generate a RANDOM wrong key instead of using the real noiseStaticPubkey
    const wrongKey = generateNoiseKeyPair();

    const transport = new NoiseClientTransport({
      nodeId: bootstrapResult.nodeId,
      expectedKeyId: computeKeyId(wrongKey.publicKey),
      remoteStaticPubkey: wrongKey.publicKey,
      relayOrigin: canonicalTransportOrigin(relayOrigin),
    });

    const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`);
    await waitForOpen(ws);

    const hello = transport.getClientHello();
    ws.send(JSON.stringify(hello));

    // The handshake should fail because the server's static key doesn't match
    // what the client expects. The Noise NK pattern binds the initiator's
    // ephemeral key to the responder's static key via es DH. A key mismatch
    // causes decryption failure at the noise_2 stage.
    const handshakeResult = await new Promise<"failed" | "success">((resolve) => {
      const timer = setTimeout(() => {
        ws.close();
        resolve("failed");
      }, 5_000);
      timer.unref();

      ws.addEventListener("message", (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        try {
          const msg = JSON.parse(raw);
          if (msg.t === "transport_error") {
            clearTimeout(timer);
            ws.close();
            resolve("failed");
            return;
          }
          if (msg.t && (msg.t === "server_hello" || msg.t === "noise_2")) {
            try {
              transport.processMessage(msg);
              if (transport.isSecure) {
                clearTimeout(timer);
                ws.close();
                resolve("success");
              }
            } catch {
              // Decryption failure expected with wrong key
              clearTimeout(timer);
              ws.close();
              resolve("failed");
            }
          }
        } catch {
          // Parse error, skip
        }
      });

      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve("failed");
      });
    });

    // The handshake must fail — proving TOFU protection works
    expect(handshakeResult).toBe("failed");
  }, 20_000);
});
